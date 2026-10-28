import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../native/dsh-accessibility.m', import.meta.url));
const result = (code) => ({ ok: code === 'READY', code });
const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;

async function resolveCompiler(name, { run, cwd, env, signal, authorize }) {
  if (name !== 'clang') throw new Error('unavailable');
  // xcode-select --print-path only reads installation metadata. Do not execute
  // the clang shim until an installed developer directory and compiler exist.
  if (!authorize()) throw new Error('unavailable');
  const metadata = await run('/usr/bin/xcode-select', ['--print-path'], { cwd, env, signal, timeout: 3000, maxBuffer: 4096 });
  if (!authorize() || !completed(metadata) || typeof metadata.stdout !== 'string' || metadata.stdout.length > 2048) throw new Error('unavailable');
  const developer = metadata.stdout.trim();
  if (!path.isAbsolute(developer) || /[\r\n\0]/.test(developer) || !(await fs.stat(developer)).isDirectory()) throw new Error('unavailable');
  let installed = false;
  for (const compiler of [path.join(developer, 'usr/bin/clang'), path.join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang')]) {
    try { if ((await fs.stat(compiler)).isFile()) { await fs.access(compiler, constants.X_OK); installed = true; break; } } catch {}
  }
  if (!installed || !authorize()) throw new Error('unavailable');
  await fs.access('/usr/bin/clang', constants.X_OK);
  return '/usr/bin/clang';
}

/** Only the owned child PID is signalled. The DSH parent process group retains
 * cancellation ownership of descendants. Termination requests are not proof of
 * cleanup: retain the promise until the actual child closes or fails to spawn. */
function boundedRun(binary, args, options) {
  return new Promise((resolve) => {
    let child, timer, forceTimer, stdout = '', stderr = '', bytes = 0, stopped = false, finished = false;
    const kill = (signal) => {
      try { child?.kill(signal); } catch {}
    };
    const finish = (exitCode, signal) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode, signal, timedOut: stopped, aborted: options.signal?.aborted === true });
    };
    const stop = () => {
      if (stopped || finished) return;
      stopped = true; kill('SIGTERM');
      forceTimer = setTimeout(() => kill('SIGKILL'), 250);
    };
    const onAbort = () => stop();
    if (options.signal?.aborted) { finish(null, 'cancelled'); return; }
    try {
      child = spawn(binary, args, { cwd: options.cwd, env: options.env, detached: false,
        stdio: ['ignore', 'pipe', 'pipe'] });
      const capture = (name) => (chunk) => {
        bytes += chunk.length;
        if (bytes > options.maxBuffer) { stop(); return; }
        if (name === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
      child.once('error', () => { if (!child.pid) finish(null, 'spawn-failed'); });
      child.once('close', (code, signal) => finish(code, signal));
      timer = setTimeout(stop, options.timeout);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) stop();
    } catch { finish(null, 'spawn-failed'); }
  });
}

const completed = (value) => value && typeof value === 'object' && !value.timedOut && !value.aborted && !value.killed && !value.signal
  && (value.exitCode === 0 || value.exitCode === undefined);
function readReceipt(value) {
  if (!value || value.timedOut || value.aborted || value.killed || value.signal || typeof value.stdout !== 'string' || value.stdout.length > 256) return result('UNCONFIRMED');
  let receipt;
  try { receipt = JSON.parse(value.stdout); } catch { return result('UNCONFIRMED'); }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).some((key) => !['ok', 'code'].includes(key))) return result('UNCONFIRMED');
  if (receipt.ok === true && receipt.code === 'READY' && completed(value)) return result('READY');
  return receipt.ok === false && ['UNAVAILABLE', 'UNTRUSTED', 'UNCONFIRMED'].includes(receipt.code) ? result(receipt.code) : result('UNCONFIRMED');
}

/** Enable Electron's accessibility tree for this exact already-running DSH app.
 * This is not a UI controller or a permission grant. TCC must already trust the
 * actual responsible application; no prompt or authorization retry is made. */
async function prepareTarget(target, { run = boundedRun, resolveExecutable = resolveCompiler,
  platform = process.platform, signal, authorize } = {}) {
  if (platform !== 'darwin' || typeof run !== 'function' || typeof resolveExecutable !== 'function') return result('UNAVAILABLE');
  if (signal !== undefined && (typeof signal?.aborted !== 'boolean' || typeof signal?.addEventListener !== 'function'
    || typeof signal?.removeEventListener !== 'function')) return result('UNAVAILABLE');
  const allowed = () => { try { return !signal?.aborted && (authorize === undefined || typeof authorize === 'function' && authorize() === true); } catch { return false; } };
  if (!allowed()) return result('UNCONFIRMED');
  let directory, outcome = result('UNAVAILABLE');
  try {
    const source = await fs.lstat(SOURCE); if (!source.isFile() || source.isSymbolicLink()) return outcome;
    directory = await fs.mkdtemp(path.join(tmpdir(), 'dafeiyu-electron-ax-')); await fs.chmod(directory, 0o700);
    const executable = path.join(directory, 'dsh-accessibility');
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: directory + path.sep,
      CLANG_MODULE_CACHE_PATH: path.join(directory, 'module-cache'), XDG_CACHE_HOME: path.join(directory, 'cache'), LANG: 'C', LC_ALL: 'C' };
    for (const key of ['USER', 'LOGNAME', 'SHELL']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
    if (!allowed()) return result('UNCONFIRMED');
    const compiler = await resolveExecutable('clang', { run, cwd: directory, env, signal, authorize: allowed });
    if (typeof compiler !== 'string' || !path.isAbsolute(compiler) || compiler.includes('\0')) return outcome;
    if (!allowed()) return result('UNCONFIRMED');
    const compiled = await run(compiler, ['-x', 'objective-c', '-fobjc-arc', '-fno-modules', '-fno-implicit-modules',
      '-fno-implicit-module-maps', '-O1', '-framework', 'AppKit', '-framework', 'ApplicationServices', SOURCE, '-o', executable],
    { cwd: directory, env, timeout: 20000, maxBuffer: 4096, signal });
    if (!allowed()) outcome = result('UNCONFIRMED');
    else if (completed(compiled)) {
      const binary = await fs.lstat(executable);
      if (binary.isFile() && !binary.isSymbolicLink()) {
        await fs.chmod(executable, 0o700);
        let reply;
        if (!allowed()) return result('UNCONFIRMED');
        try { reply = await run(executable, [target], { cwd: directory, env, timeout: 8000, maxBuffer: 4096, signal }); }
        catch (cause) { reply = { stdout: cause?.stdout, exitCode: Number.isInteger(cause?.code) ? cause.code : null,
          signal: cause?.signal, killed: cause?.killed }; }
        outcome = allowed() ? readReceipt(reply) : result('UNCONFIRMED');
      }
    }
  } catch { if (!allowed()) outcome = result('UNCONFIRMED'); /* Never expose compiler or AX diagnostics. */ }
  finally {
    if (directory) try { await fs.rm(directory, { recursive: true, force: true }); } catch { outcome = result('UNCONFIRMED'); }
  }
  return outcome;
}

export async function prepareDesktopAccessibility(pid, options = {}) {
  return validPid(pid) ? prepareTarget(String(pid), options) : result('UNAVAILABLE');
}

/** Fixed product action: the helper, not caller input, selects the sole live DSH. */
export async function prepareCurrentDesktopAccessibility(options = {}) {
  return prepareTarget('current-dsh', options);
}

export { resolveCompiler };
