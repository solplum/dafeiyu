import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const outcome = (status, errorCode, text) => ({ executor: 'codex', status,
  ...(errorCode ? { errorCode } : {}), ...(typeof text === 'string' ? { text } : {}) });
const inside = (root, candidate) => { const rel = relative(root, candidate);
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); };
const bounded = (value, fallback, min, max) => Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
const bundled = (value) => /(?:^|[/\\])\.dsh(?:[/\\]|$)|(?:^|[/\\])dsh-subagent-codex(?:[/\\]|$)/.test(value);

// Saved native authentication and config remain with Codex. No DSH/QQ/cloud
// tokens, preload hooks or ambient provider overrides enter the worker.
function environment() {
  const env = {};
  for (const key of ['HOME', 'CODEX_HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'TERM', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  env.HOME ||= homedir(); env.NO_COLOR = '1';
  return env;
}

function failureCode(value) {
  const selected = typeof value === 'string' ? [value] : value && typeof value === 'object'
    ? [value.message, value.code, value.type, value.codexErrorInfo, value.status, value.httpStatus, value.httpStatusCode] : [];
  const hint = selected.filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v).slice(0, 2048)).join(' ');
  if (/model[_ -]?(?:not[_ -]found|unavailable|unsupported)|(?:model[^\n]{0,160}(?:not supported|not available|does not exist|not found|unavailable|unsupported))|unsupported[^\n]{0,80}model/i.test(hint)) return 'model-unavailable';
  if (/\b401\b|unauthorized|invalid[_ -]api[_ -]key|not authenticated|not logged in|(?:log ?in|sign ?in)[^\n]{0,60}(?:required|again)|authentication[^\n]{0,50}(?:failed|required)/i.test(hint)) return 'login-required';
  if (/\b403\b|access[_ -]policy|permission denied|forbidden/i.test(hint)) return 'access-policy';
  if (/\b429\b|quota|rate[_ -]?limit|usage[_ -]?limit|usageLimitExceeded|sessionBudgetExceeded/i.test(hint)) return 'quota';
  if (/\b5\d\d\b|server[_ -]?(?:error|overloaded)|service unavailable|internal[_ -]server/i.test(hint)) return 'service';
  if (/transport|connection|network|disconnected|timed? ?out|timeout|\bECONN|\bENOTFOUND|\bDNS\b|\bTLS\b/i.test(hint)) return 'transport';
  return 'execution';
}

/** System Codex CLI adapter. Uses the user's current CLI/model configuration,
 * never the DSH plugin's pinned binary and never retries dispatched work.
 * Normal jobs allow workspace writes; explicit connectivity probes are read-only.
 * JSONL contract: https://learn.chatgpt.com/docs/non-interactive-mode */
export function createCodexCliExecutor({ command, cwdRoot = process.cwd(), spawnImpl = spawn,
  timeoutMs = 10 * 60_000, maxOutputBytes = 1024 * 1024 } = {}) {
  if (command !== undefined && (typeof command !== 'string' || !command || /[\0\r\n]/.test(command)
    || command.startsWith('-') || (command.includes('/') || command.includes('\\')) && !isAbsolute(command))) throw new TypeError('Invalid Codex command');
  if (typeof cwdRoot !== 'string' || !isAbsolute(cwdRoot) || /[\0\r\n]/.test(cwdRoot) || typeof spawnImpl !== 'function') throw new TypeError('Invalid Codex workspace');
  const rootPath = resolve(cwdRoot), duration = bounded(timeoutMs, 10 * 60_000, 1, 3600000);
  const outputLimit = bounded(maxOutputBytes, 1024 * 1024, 128, 16 * 1024 * 1024);

  async function executable() {
    const pathCandidates = (process.env.PATH || '').split(delimiter).filter((entry) => isAbsolute(entry)).map((entry) => join(entry, command || 'codex'));
    const candidates = command && isAbsolute(command) ? [command] : command ? pathCandidates
      : [...pathCandidates, '/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(homedir(), '.local', 'bin', 'codex')];
    for (const candidate of [...new Set(candidates)]) {
      if (bundled(candidate)) continue;
      try {
        const actual = await realpath(candidate);
        if (bundled(actual) || !(await stat(actual)).isFile()) continue;
        await access(actual, constants.X_OK); return actual;
      } catch { /* An absent candidate never starts a job or falls back after execution. */ }
    }
    return null;
  }
  async function workspace(cwd) {
    if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd) || /[\0\r\n]/.test(cwd))) return { errorCode: 'workspace-outside-root' };
    try {
      const root = await realpath(rootPath), directory = await realpath(cwd || root);
      if (!inside(root, directory)) return { errorCode: 'workspace-outside-root' };
      if (!(await stat(directory)).isDirectory()) return { errorCode: 'workspace-unavailable' };
      return { directory };
    } catch { return { errorCode: 'workspace-unavailable' }; }
  }

  async function launch(binary, directory, args, { signal, onProgress, version = false } = {}) {
    if (signal?.aborted) return outcome('cancelled', 'cancelled');
    return new Promise((resolveResult) => {
      let child, settled = false, stopped, bytes = 0, line = '', versionText = '', stderrHint = '';
      let finalText = '', finalAtCompletion = '', started = 0, completed = 0, failed = false, failure = 'execution';
      let timeout, killTimer, reapTimer, groupTimer, closed = false, closeValue, cleanupStarted = false;
      const decoder = new StringDecoder('utf8');
      const finish = (value) => {
        if (settled) return; settled = true;
        for (const timer of [timeout, killTimer, reapTimer, groupTimer]) clearTimeout(timer);
        signal?.removeEventListener('abort', abort); resolveResult(value);
      };
      const kill = (sig) => {
        try {
          if (spawnImpl === spawn && Number.isSafeInteger(child?.pid) && child.pid > 1 && process.platform !== 'win32') process.kill(-child.pid, sig);
          else child?.kill?.(sig);
        } catch { /* Only close/quiescence or the bounded reap deadline confirms termination. */ }
      };
      const groupGone = () => {
        if (spawnImpl !== spawn || process.platform === 'win32' || !Number.isSafeInteger(child?.pid) || child.pid <= 1) return true;
        try { process.kill(-child.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
      };
      const afterClose = () => {
        if (settled || !closed) return;
        // A successful CLI leader can leave tool grandchildren in its detached
        // group after closing its own pipes. Do not release the workspace lease
        // until that exact owned group is quiescent, regardless of exit status.
        if (!groupGone()) { terminate(); groupTimer = setTimeout(afterClose, 20); return; }
        finish(closeValue);
      };
      const terminate = () => {
        if (settled || cleanupStarted) return; cleanupStarted = true; kill('SIGTERM');
        if (settled) return;
        killTimer = setTimeout(() => kill('SIGKILL'), 1000);
        reapTimer = setTimeout(() => finish(outcome('unknown', 'termination-unconfirmed')), 2000);
      };
      const stoppedOutcome = () => stopped === 'cancelled' ? outcome('cancelled', 'cancelled')
        : outcome('unknown', stopped === 'timeout' ? 'executor-timeout' : stopped === 'output-limit' ? 'output-limit' : 'executor-interrupted');
      const stop = (reason) => {
        if (settled || stopped) return; stopped = reason;
        if (closed) closeValue = stoppedOutcome();
        terminate();
      };
      const abort = () => stop('cancelled');
      const progress = () => {
        if (settled || stopped) return;
        try { Promise.resolve(onProgress?.({ executor: 'codex', text: 'Codex 正在后台处理任务。' })).catch(() => {}); } catch {}
      };
      const consume = (text) => {
        line += text; let at;
        while ((at = line.indexOf('\n')) >= 0) {
          const entry = line.slice(0, at).trim(); line = line.slice(at + 1); if (!entry) continue;
          if (version) { versionText += entry + '\n'; continue; }
          let event; try { event = JSON.parse(entry); } catch { continue; }
          if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
          if (event.type === 'error' || event.type === 'turn.failed') {
            failed = true; const code = failureCode(event.error ?? event);
            if (failure === 'execution' || code !== 'execution') failure = code;
          }
          if (event.type === 'turn.started') { started++; progress(); }
          if (event.type === 'turn.completed') { completed++; finalAtCompletion = finalText; }
          if (event.type !== 'item.completed' || completed > 0 || started !== 1 || event.item?.type !== 'agent_message') continue;
          const item = event.item, phase = item.phase ?? event.phase ?? item.channel ?? event.channel;
          if ([item.phase, event.phase, item.channel, event.channel].includes('commentary')) continue;
          if (phase != null && !['final', 'final_answer'].includes(phase) || item.interrupted === true) continue;
          if (typeof item.text === 'string' && item.text.trim() && item.text.length <= 64000) finalText = item.text.trim();
        }
      };
      try {
        child = spawnImpl(binary, args, { cwd: directory, env: environment(), shell: false,
          detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { finish(outcome('failed', 'executor-unavailable')); return; }
      const data = (chunk, stderr = false) => {
        if (settled || stopped) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
        if (bytes > outputLimit) { stop('output-limit'); return; }
        if (stderr) stderrHint = (stderrHint + buffer.toString('utf8')).slice(-2048);
        else consume(decoder.write(buffer));
      };
      child.stdout?.on('data', (chunk) => data(chunk)); child.stderr?.on('data', (chunk) => data(chunk, true));
      child.once('error', () => {
        if (!Number.isSafeInteger(child.pid)) finish(outcome('failed', 'executor-unavailable'));
        else stop('process-error');
      });
      child.once('close', (code, exitSignal) => {
        if (settled) return; closed = true; clearTimeout(timeout);
        if (!stopped) consume(decoder.end() + '\n');
        if (stopped) closeValue = stoppedOutcome();
        else if (exitSignal) closeValue = outcome('unknown', 'executor-interrupted');
        else if (code !== 0) closeValue = outcome('failed', failed ? failure : failureCode(stderrHint));
        else if (version) {
          const match = /^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/m.exec(versionText);
          closeValue = match ? { available: true, version: match[1] } : { available: false, reason: 'invalid-version' };
        } else if (failed) closeValue = outcome('failed', failure);
        else if (started !== 1 || completed !== 1 || !finalAtCompletion) closeValue = outcome('failed', 'invalid-result');
        else closeValue = outcome('succeeded', undefined, finalAtCompletion);
        afterClose();
      });
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      if (!settled) timeout = setTimeout(() => stop('timeout'), version ? Math.min(duration, 5000) : duration);
    });
  }

  return Object.freeze({
    async available() {
      const binary = await executable(); if (!binary) return { installed: false, available: false, reason: 'executor-unavailable' };
      const located = await workspace(); if (!located.directory) return { installed: true, available: false, reason: located.errorCode };
      const result = await launch(binary, located.directory, ['--version'], { version: true });
      return { installed: true, available: result.available === true, ...(result.version ? { version: result.version } : { reason: result.reason || result.errorCode || 'executor-unavailable' }) };
    },
    async run({ id, prompt, cwd, signal, onProgress, probe = false, readOnly = false } = {}) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)
        || typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 64 * 1024 || prompt.includes('\0') || typeof readOnly !== 'boolean'
        || signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function'
          || typeof signal?.aborted !== 'boolean')) return outcome('failed', 'invalid-input');
      if (signal?.aborted) return outcome('cancelled', 'cancelled');
      const located = await workspace(cwd); if (!located.directory) return outcome('failed', located.errorCode);
      const binary = await executable(); if (!binary) return outcome('failed', 'executor-unavailable');
      if (signal?.aborted) return outcome('cancelled', 'cancelled');
      return launch(binary, located.directory, ['-a', 'never', 'exec', '--json', '-C', located.directory,
        '--skip-git-repo-check', '--sandbox', probe === true || readOnly ? 'read-only' : 'workspace-write', '--', prompt], { signal, onProgress });
    },
  });
}

export default createCodexCliExecutor;
