import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_TIMEOUT = 10 * 60_000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const KNOWN_KINDS = new Set(['zcode', 'minimax']);

// CLI configuration is deliberately independent of the companion's configuration.
// In particular, "--permission off" in MCode disables checks, not tools.
const MINIMAX_CONFIG = {
  agents: { default: {
    persona: { enabled: false }, tools: ['read', 'grep', 'glob'], builtinTools: [], skills: [],
    features: { mavis: false, delegation: false, webSearch: false },
  } },
  memory: { enabled: false, proactive: false }, askUser: { enabled: false },
  skills: { external: { enabled: false } }, skillEvolve: { enabled: false },
  beta: {
    autoMemory: false, skillEvolve: false, skillEvolveBuiltinMr: false, skillProposal: false,
    browserBridge: false, browserUseTooling: false, browserUseAutoOpenPanel: false,
    mcodeTools: false, keepAlive: false, promptOverride: false, threadGoal: false,
  },
};

function boundedNumber(value, fallback, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

// An allowlist also excludes inherited NODE_OPTIONS, preload hooks, cloud keys,
// DSH/OneBot variables, and arbitrary provider overrides. Native CLI credentials
// remain the responsibility of the CLI; this adapter never opens them.
function childEnvironment(kind, privateDir, profileDir) {
  const result = {};
  for (const name of ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SYSTEMROOT', 'WINDIR']) {
    if (typeof process.env[name] === 'string') result[name] = process.env[name];
  }
  result.HOME ||= homedir();
  result.TMPDIR = privateDir;
  result.TMP = privateDir;
  result.TEMP = privateDir;
  result.NO_COLOR = '1';
  if (kind === 'minimax') result.MINIMAX_DATA_DIR = profileDir;
  if (kind === 'zcode') {
    result.ZCODE_STORAGE_DIR = join(privateDir, 'zcode');
    // ZCode's default sessionDbPath does not follow storage.dir automatically.
    result.ZCODE_SESSION_DB_PATH = join(privateDir, 'zcode-sessions.sqlite');
  }
  return result;
}

function sandboxQuote(value) {
  return JSON.stringify(value);
}

async function sandboxProfile(root, privateDir, profileDir, hostBlockedPaths, kind) {
  const home = homedir();
  // CLI state and credentials may be read, but no existing user files can be
  // written. Ambient project/user tool configuration and companion secrets are
  // excluded even if a CLI attempts to discover them before processing a prompt.
  const blocked = [join(home, '.dsh'), join(home, '.ssh'), join(home, '.aws'),
    join(home, '.kube'), join(home, '.codex'), join(home, '.zcode', 'cli'),
    ...['.zcode', '.minimax', '.claude', '.mcp.json', '.env', '.env.local',
      'memory', 'packages/dsh-dafeiyu/config.json', 'packages/companion/config.json',
      'packages/companion/role.md', 'packages/companion/data',
      'packages/dsh-dafeiyu/data'].map(name => join(root, name)),
    ...['plugins', 'skills', 'agents', 'memory', 'harnesses', 'subagents',
      'mcp.json', 'channel-bindings.yaml', 'channel-routes.yaml'].map(name => join(profileDir, name)),
    ...hostBlockedPaths];
  // Deny both lexical and resolved locations. In particular, a private memory
  // symlink must not become readable merely because its target sits elsewhere
  // inside the otherwise-readable workspace. realpath reads metadata only.
  const denied = [...new Set((await Promise.all(blocked.map(async path => [path, await realpath(path).catch(() => path)]))).flat())];
  const hostDenied = [...new Set((await Promise.all(hostBlockedPaths.map(async path => [path, await realpath(path).catch(() => path)]))).flat())];
  const readable = [root, privateDir, join(home, '.minimax-code'), join(home, '.local', 'share', 'fnm'),
    dirname(process.execPath), join(home, '.zcode', 'v2', 'runtime', 'provider'),
    join(home, '.zcode', 'v2', 'provider_config.json'), join(home, '.zcode', 'v2', 'credentials.json'),
    join(home, '.minimax', 'auth'), join(home, '.minimax', 'local-runtime.auth.json'), profileDir,
    ...(kind === 'minimax' ? [`${profileDir}.lock`] : [])];
  return `(version 1)\n(allow default)\n(deny file-write*)\n` +
    `(allow file-write* (subpath ${sandboxQuote(privateDir)}) (subpath ${sandboxQuote(profileDir)}) ` +
    // Native proper-lockfile locks dataDir using a sibling dataDir.lock folder.
    // Permit this exact managed lock, never the profile's parent directory.
    (kind === 'minimax' ? `(subpath ${sandboxQuote(`${profileDir}.lock`)}) ` : '') +
    // The managed MCode launcher registers its own PID even for --version.
    `(subpath ${sandboxQuote(join(home, '.minimax-code', '.mcode-active'))}) (literal "/dev/null"))\n` +
    `(deny file-read-data (subpath ${sandboxQuote(home)}) (subpath "/Users") ` +
    `(subpath "/home") (subpath "/private/tmp") (subpath "/tmp") (subpath "/private/var/folders"))\n` +
    `(allow file-read-data ${readable.map(path => `(subpath ${sandboxQuote(path)})`).join(' ')})\n` +
    `(deny file-read-data ${denied.map(path => `(subpath ${sandboxQuote(path)})`).join(' ')})\n` +
    // Fresh managed MCode profiles atomically publish and then read their
    // bundled default Agent template here. No custom Agent directory is opened.
    (kind === 'minimax' ? `(allow file-read-data (literal ${sandboxQuote(join(profileDir, 'agents'))}) ` +
      `(subpath ${sandboxQuote(join(profileDir, 'agents', '.builtin'))}))\n` : '') +
    (hostDenied.length ? `(deny file-read-data ${hostDenied.map(path => `(subpath ${sandboxQuote(path)})`).join(' ')})\n` : '') +
    // A wildcard path prevents nested .env files from bypassing the env allowlist.
    `(deny file-read-data (regex #"(^|/)\\.env(\\.[^/]*)?$") )\n`;
}

function result(kind, status, errorCode, text) {
  return { status, executor: kind, ...(errorCode ? { errorCode } : {}), ...(text ? { text } : {}) };
}

function parseFinal(kind, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (kind === 'zcode') {
    if (value.type !== 'result') return null;
    const state = value.projection?.status;
    if (state === 'error') return { status: 'failed', errorCode: 'executor-failed' };
    if (state !== 'completed' && state !== 'idle') return { status: 'failed', errorCode: 'invalid-result' };
    if (typeof value.response !== 'string' || !value.response.trim()) return { status: 'failed', errorCode: 'invalid-result' };
    return { status: 'succeeded', text: value.response.trim() };
  }
  // MCode stream-json wraps the validated ExecResult in exec.completed.
  const final = value.type === 'exec.completed' ? value.result : value;
  if (final?.type !== 'exec.result') return null;
  if (final.schemaVersion !== 1 || typeof final.runId !== 'string' ||
    typeof final.sessionId !== 'string' || typeof final.turnId !== 'string' ||
    !Number.isFinite(final.durationMs) || final.durationMs < 0) {
    return { status: 'failed', errorCode: 'invalid-result' };
  }
  if (final.status === 'cancelled') return { status: 'cancelled', errorCode: 'cancelled' };
  if (final.status === 'timeout') return { status: 'unknown', errorCode: 'executor-timeout' };
  if (final.status !== 'succeeded') return { status: 'failed', errorCode: 'executor-failed' };
  if (typeof final.output !== 'string' || !final.output.trim()) return { status: 'failed', errorCode: 'invalid-result' };
  return { status: 'succeeded', text: final.output.trim() };
}

/**
 * Optional, read-only local CLI worker. This factory never installs software,
 * imports user configuration, retries a job, or propagates companion secrets.
 * A detected binary is not proof of an authenticated provider connection.
 */
export function createExternalExecutor({ kind, command, cwdRoot = process.cwd(),
  spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT, maxOutputBytes = DEFAULT_OUTPUT_LIMIT,
  platform = process.platform, sandboxCommand = '/usr/bin/sandbox-exec',
  stopGraceMs = 2000, profileDir = join(homedir(), 'Library', 'Application Support', 'lzl-dsh', 'executors', kind),
  blockedPaths = [] } = {}) {
  if (!KNOWN_KINDS.has(kind)) throw new TypeError('Unsupported external executor');
  command ??= kind === 'zcode' ? 'zcode' : join(homedir(), '.minimax-code', 'bin', 'mcode');
  if (typeof command !== 'string' || !command || /[\0\r\n]/u.test(command) || command.startsWith('-')) {
    throw new TypeError('Invalid executor command');
  }
  const rootPath = resolve(cwdRoot);
  if (!Array.isArray(blockedPaths) || blockedPaths.length > 128 || blockedPaths.some(path =>
    typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || /[\0\r\n]/u.test(path))) {
    throw new TypeError('Invalid host-owned blocked paths');
  }
  // This capability boundary is fixed by host configuration at construction;
  // run() deliberately has no corresponding model-controlled argument.
  const hostBlockedPaths = Object.freeze([...new Set(blockedPaths.map(path => resolve(path)))]);
  const profilePath = resolve(profileDir);
  if (profilePath === homedir() || inside(profilePath, rootPath)) throw new TypeError('Invalid executor profile directory');
  const duration = boundedNumber(timeoutMs, DEFAULT_TIMEOUT, 1, 24 * 60 * 60_000);
  const outputLimit = boundedNumber(maxOutputBytes, DEFAULT_OUTPUT_LIMIT, 128, 16 * 1024 * 1024);
  const grace = boundedNumber(stopGraceMs, 2000, 1, 10_000);
  let verifiedCliVersion;

  async function authFingerprint() {
    const entries = [];
    if (kind === 'zcode') {
      const native = join(homedir(), '.zcode', 'v2');
      const record = async (path, label) => {
        try {
          const metadata = await stat(path);
          entries.push({ label, mtimeMs: metadata.mtimeMs, size: metadata.size });
        } catch { /* only metadata is inspected, never provider/credential contents */ }
      };
      await record(join(native, 'provider_config.json'), 'provider-config');
      await record(join(native, 'credentials.json'), 'credentials');
      const runtime = join(native, 'runtime', 'provider');
      await record(runtime, 'provider-runtime');
      try {
        // Deliberately non-recursive and bounded, including platform-directory
        // metadata so a native provider installation change invalidates health.
        const names = (await readdir(runtime)).filter(name => name.length <= 80).sort().slice(0, 16);
        for (const name of names) await record(join(runtime, name), `runtime:${name}`);
      } catch { /* no runtime snapshot is also a valid TTL-only fingerprint */ }
      return entries;
    }
    for (const region of ['cn', 'en']) {
      const path = join(profilePath, 'auth', 'prod', region, 'mcode-public', 'auth-state.json');
      try {
        const metadata = await stat(path);
        if (metadata.isFile()) entries.push({ region, mtimeMs: metadata.mtimeMs, size: metadata.size });
      } catch { /* absence is not authentication */ }
    }
    return entries;
  }

  async function saveHealth() {
    const authentication = await authFingerprint();
    if ((kind === 'minimax' && !authentication.length) || !verifiedCliVersion) return;
    const pending = join(profilePath, `.dafeiyu-health-${randomUUID()}.tmp`);
    try {
      await writeFile(pending, JSON.stringify({ version: 1, verifiedAt: Date.now(), cliVersion: verifiedCliVersion, authentication }), { mode: 0o600, flag: 'wx' });
      await rename(pending, join(profilePath, '.dafeiyu-health.json'));
    } finally { await rm(pending, { force: true }).catch(() => {}); }
  }

  async function health() {
    const authentication = await authFingerprint();
    if (kind === 'minimax' && !authentication.length) return { available: false, reason: 'login-required' };
    try {
      const path = join(profilePath, '.dafeiyu-health.json');
      if ((await stat(path)).size > 4096) return { available: false, reason: 'execution-unverified' };
      const marker = JSON.parse(await readFile(path, 'utf8'));
      if (marker.version === 1 && Number.isFinite(marker.verifiedAt) &&
        marker.verifiedAt <= Date.now() && marker.cliVersion === verifiedCliVersion &&
        // If native ZCode exposes no precise authentication metadata, retain a
        // short-lived successful-call proof rather than claim to know login.
        (authentication.length > 0 || Date.now() - marker.verifiedAt < 24 * 60 * 60_000) &&
        JSON.stringify(marker.authentication) === JSON.stringify(authentication)) return { available: true };
    } catch { /* no private auth-state or credential payload is opened */ }
    return { available: false, reason: 'execution-unverified' };
  }

  async function guardedRun(args, { cwd, signal, onProgress, probe = false } = {}) {
    if (signal?.aborted) return result(kind, 'cancelled', 'cancelled');
    if (platform !== 'darwin') return result(kind, 'failed', 'read-only-launcher-unavailable');
    try { await access(sandboxCommand, constants.X_OK); } catch {
      return result(kind, 'failed', 'read-only-launcher-unavailable');
    }
    let root, directory;
    try {
      root = await realpath(rootPath);
      directory = await realpath(resolve(cwd ?? root));
      if (!inside(root, directory)) return result(kind, 'failed', 'workspace-outside-root');
    } catch { return result(kind, 'failed', 'workspace-unavailable'); }
    if (signal?.aborted) return result(kind, 'cancelled', 'cancelled');
    let privateDir;
    try {
      privateDir = await realpath(await mkdtemp(join(tmpdir(), 'dafeiyu-worker-')));
      await mkdir(profilePath, { recursive: true, mode: 0o700 });
      const canonicalProfile = await realpath(profilePath);
      if (canonicalProfile !== join(await realpath(dirname(profilePath)), basename(profilePath))) {
        return result(kind, 'failed', 'profile-unavailable');
      }
      await chmod(profilePath, 0o700);
      const profile = join(privateDir, 'readonly.sb');
      await writeFile(profile, await sandboxProfile(root, privateDir, canonicalProfile, hostBlockedPaths, kind), { mode: 0o600 });
      const env = childEnvironment(kind, privateDir, profilePath);
      let workerArgs = [...args];
      if (!probe && kind === 'minimax') {
        const config = join(privateDir, 'minimax-config.json');
        await writeFile(config, JSON.stringify(MINIMAX_CONFIG), { mode: 0o600 });
        workerArgs = ['exec', '--config', config, ...args];
      }
      return await new Promise(resolveResult => {
        let child, settled = false, bytes = 0, line = '', final, finalCount = 0;
        let stopReason, timeout, killTimer, reapTimer, versionText = '', loginRequired = false;
        const decoder = new StringDecoder('utf8');
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(reapTimer);
          signal?.removeEventListener('abort', abort);
          resolveResult(value);
        };
        const kill = sig => {
          if (!child) return;
          try {
            // Only real spawned children use OS group signalling. Test doubles
            // can implement kill without targeting an unrelated operating PID.
            if (spawnImpl === spawn && Number.isSafeInteger(child.pid) && child.pid > 1) process.kill(-child.pid, sig);
            else child.kill?.(sig);
          } catch { /* close/timeout determines whether termination was confirmed */ }
        };
        const stop = reason => {
          if (settled || stopReason) return;
          stopReason = reason;
          kill('SIGTERM');
          if (settled) return;
          killTimer = setTimeout(() => kill('SIGKILL'), grace);
          reapTimer = setTimeout(() => finish(result(kind, 'unknown', 'termination-unconfirmed')), grace * 2);
        };
        const abort = () => stop('cancelled');
        const emitProgress = () => {
          if (settled || stopReason) return;
          try { Promise.resolve(onProgress?.({ executor: kind, status: 'running' })).catch(() => {}); } catch { /* progress is advisory */ }
        };
        const consume = text => {
          line += text;
          let index;
          while ((index = line.indexOf('\n')) >= 0) {
            const entry = line.slice(0, index).trim(); line = line.slice(index + 1);
            if (!entry) continue;
            if (probe) { versionText += `${entry}\n`; continue; }
            let event;
            try { event = JSON.parse(entry); } catch { continue; }
            const parsed = parseFinal(kind, event);
            if (parsed) { final = parsed; finalCount++; }
            else if (kind === 'minimax' && event?.schemaVersion === 1 && event.type === 'turn.started') emitProgress();
          }
        };
        try {
          child = spawnImpl(sandboxCommand, ['-f', profile, command, ...workerArgs], {
            cwd: directory, env, shell: false, detached: true, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch { finish(result(kind, 'failed', 'executor-unavailable')); return; }
        child.once('error', () => finish(result(kind, 'failed', 'executor-unavailable')));
        const data = (chunk, stderr) => {
          if (settled || stopReason) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > outputLimit) { stop('output-limit'); return; }
          if (!stderr) consume(decoder.write(buffer));
          else if (kind === 'minimax' && /Sign in to MiniMax to use Agent features|Run [`'"]?mcode login/iu.test(buffer.toString('utf8'))) loginRequired = true;
        };
        child.stdout?.on('data', chunk => data(chunk, false));
        // Never retain or return stderr: SDK diagnostics may contain credentials.
        child.stderr?.on('data', chunk => data(chunk, true));
        child.once('close', (code, exitSignal) => {
          if (settled) return;
          consume(`${decoder.end()}\n`);
          if (stopReason === 'cancelled') { finish(result(kind, 'cancelled', 'cancelled')); return; }
          if (stopReason) { finish(result(kind, 'unknown', stopReason === 'timeout' ? 'executor-timeout' : 'output-limit')); return; }
          if (exitSignal) { finish(result(kind, 'unknown', 'executor-interrupted')); return; }
          if (code !== 0) { finish(result(kind, 'failed', loginRequired ? 'login-required' : 'executor-failed')); return; }
          if (probe) {
            const version = versionText.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/u)?.[0];
            finish(version ? { available: true, version } : { available: false, reason: 'invalid-version' }); return;
          }
          if (finalCount !== 1 || !final) { finish(result(kind, 'failed', 'invalid-result')); return; }
          finish(result(kind, final.status, final.errorCode, final.text));
        });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        timeout = setTimeout(() => stop('timeout'), probe ? Math.min(duration, 5000) : duration);
        emitProgress();
      });
    } catch { return result(kind, 'failed', 'executor-unavailable'); }
    finally { if (privateDir) await rm(privateDir, { force: true, recursive: true }).catch(() => {}); }
  }

  return {
    async available() {
      const value = await guardedRun(['--version'], { probe: true });
      if (value.available !== true) return { ...('version' in value ? { version: value.version } : {}),
        installed: false, available: false, reason: value.reason ?? value.errorCode ?? 'executor-unavailable' };
      verifiedCliVersion = value.version;
      return { installed: true, version: value.version, ...await health() };
    },
    async run({ id, prompt, cwd, signal, onProgress } = {}) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id) ||
        typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES || prompt.includes('\0')) {
        return result(kind, 'failed', 'invalid-input');
      }
      const args = kind === 'zcode'
        ? ['--prompt', prompt, '--cwd', resolve(cwd ?? rootPath), '--mode', 'plan', '--json', '--output-format', 'stream-json', '--no-color',
          '--workflow-mode', 'disabled', '--toolsearch-mode', 'off', '--disallowed-tools',
          'Bash,Edit,Write,MultiEdit,NotebookEdit,EnterPlanMode,ExitPlanMode,Task,BrowserUse,ComputerUse']
        : ['--cwd', resolve(cwd ?? rootPath), '--permission', 'smart', '--mode', 'lightweight',
          '--max-steps', '12', '--timeout', `${duration}ms`, '--output-format', 'stream-json', '--', prompt];
      const value = await guardedRun(args, { cwd, signal, onProgress });
      if (value.status === 'succeeded') {
        if (!verifiedCliVersion) {
          const version = await guardedRun(['--version'], { probe: true });
          if (version.available) verifiedCliVersion = version.version;
        }
        await saveHealth().catch(() => {});
      } else if (value.errorCode === 'login-required') {
        await rm(join(profilePath, '.dafeiyu-health.json'), { force: true }).catch(() => {});
      }
      return value;
    },
  };
}
