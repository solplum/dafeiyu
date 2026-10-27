import fs from 'node:fs/promises';
import { spawn as spawnProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCompiler } from './native-accessibility.js';

const SOURCE = fileURLToPath(new URL('../native/dsh-desktop-fixture.m', import.meta.url));
const failure = (code) => Object.assign(new Error({ UNAVAILABLE: '本机桌面测试组件不可用',
  UNCONFIRMED: '本机桌面测试未确认', CANCELLED: '本机桌面测试已取消',
  DESKTOP_TARGET_UNCONFIRMED: '本机测试窗口未确认' }[code]), { code });
const completed = (value) => value && typeof value === 'object' && !value.timedOut && !value.aborted && !value.killed && !value.signal
  && (value.exitCode === 0 || value.exitCode === undefined);

function launch(binary, args, options, spawn) {
  const child = spawn(binary, args, { cwd: options.cwd, env: options.env, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false, stopping = false, forceTimer;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const settle = (code, signal) => {
    if (closed) return;
    closed = true; clearTimeout(forceTimer); finish({ exitCode: code, signal });
  };
  child.once('close', settle);
  child.once('error', () => { if (!child.pid) settle(null, 'spawn-failed'); });
  const stop = () => {
    if (closed || stopping) return;
    stopping = true;
    try { child.kill('SIGTERM'); } catch {}
    forceTimer = setTimeout(() => { if (!closed) try { child.kill('SIGKILL'); } catch {} }, 250);
  };
  return { child, done, stop, get closed() { return closed; } };
}

async function compileRun(binary, args, options) {
  if (options.signal?.aborted) return { exitCode: null, aborted: true };
  const process = launch(binary, args, options, spawnProcess);
  let stdout = '', stderr = '', bytes = 0, interrupted = false;
  const interrupt = () => { interrupted = true; process.stop(); };
  const capture = (name) => (chunk) => {
    bytes += chunk.length;
    if (bytes > options.maxBuffer) { interrupt(); return; }
    if (name === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
  };
  process.child.stdout.on('data', capture('stdout')); process.child.stderr.on('data', capture('stderr'));
  const timer = setTimeout(interrupt, options.timeout);
  options.signal?.addEventListener('abort', interrupt, { once: true });
  if (options.signal?.aborted) interrupt();
  try { return { ...await process.done, stdout, stderr, timedOut: interrupted, aborted: options.signal?.aborted === true }; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', interrupt); }
}

/** The callback must await its own cancellable Orca work. Cancelling this
 * fixture requests cleanup immediately, but never pretends the callback or
 * child has stopped before both have actually settled. */
export async function withDesktopFixture(callback, { run = compileRun, spawn = spawnProcess, resolveExecutable = resolveCompiler,
  platform = process.platform, signal, authorize } = {}) {
  if (platform !== 'darwin' || typeof callback !== 'function' || typeof run !== 'function' || typeof spawn !== 'function'
    || typeof resolveExecutable !== 'function') throw failure('UNAVAILABLE');
  if (signal !== undefined && (typeof signal?.aborted !== 'boolean' || typeof signal?.addEventListener !== 'function'
    || typeof signal?.removeEventListener !== 'function')) throw failure('UNAVAILABLE');
  const allowed = () => { try { return !signal?.aborted && (authorize === undefined || typeof authorize === 'function' && authorize() === true); } catch { return false; } };
  const check = () => { if (!allowed()) throw failure(signal?.aborted ? 'CANCELLED' : 'UNCONFIRMED'); };
  check();
  let directory, process, readyTimer, onAbort, terminalError, disposing = false;
  const fixtureController = new AbortController();
  try {
    const source = await fs.lstat(SOURCE);
    if (!source.isFile() || source.isSymbolicLink()) throw failure('UNAVAILABLE');
    directory = await fs.mkdtemp(path.join(tmpdir(), 'dafeiyu-desktop-fixture-')); await fs.chmod(directory, 0o700);
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: directory + path.sep,
      CLANG_MODULE_CACHE_PATH: path.join(directory, 'module-cache'), XDG_CACHE_HOME: path.join(directory, 'cache'), LANG: 'C', LC_ALL: 'C' };
    for (const key of ['USER', 'LOGNAME', 'SHELL']) if (typeof globalThis.process.env[key] === 'string') env[key] = globalThis.process.env[key];
    const executable = path.join(directory, 'dsh-desktop-fixture');
    check();
    let compiler;
    try { compiler = await resolveExecutable('clang', { run, cwd: directory, env, signal, authorize: allowed }); }
    catch { check(); throw failure('UNAVAILABLE'); }
    check();
    if (typeof compiler !== 'string' || !path.isAbsolute(compiler) || compiler.includes('\0')) throw failure('UNAVAILABLE');
    let compiled;
    try { compiled = await run(compiler, ['-x', 'objective-c', '-fobjc-arc', '-fno-modules', '-fno-implicit-modules',
      '-fno-implicit-module-maps', '-O1', '-framework', 'AppKit', SOURCE, '-o', executable],
    { cwd: directory, env, signal, timeout: 20000, maxBuffer: 4096 }); }
    catch { check(); throw failure('UNAVAILABLE'); }
    check();
    if (!completed(compiled)) throw failure('UNAVAILABLE');
    const binary = await fs.lstat(executable);
    if (!binary.isFile() || binary.isSymbolicLink()) throw failure('UNAVAILABLE');
    await fs.chmod(executable, 0o700); check();
    try { process = launch(executable, [], { cwd: directory, env }, spawn); }
    catch { throw failure('UNAVAILABLE'); }
    let ready = false, stdout = Buffer.alloc(0), stderrBytes = 0, resolveReady, rejectReady;
    const readiness = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const fail = (code) => {
      terminalError ??= failure(code); fixtureController.abort(); rejectReady(terminalError); process.stop();
    };
    process.child.stdout.on('data', (chunk) => {
      if (terminalError) return;
      if (ready) { if (chunk.length) fail('UNCONFIRMED'); return; }
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.length > 256) { fail('UNCONFIRMED'); return; }
      const newline = stdout.indexOf(10);
      if (newline === -1) return;
      let receipt;
      try { receipt = JSON.parse(stdout.subarray(0, newline).toString('utf8')); } catch { fail('UNCONFIRMED'); return; }
      if (newline !== stdout.length - 1 || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
        || Object.keys(receipt).length !== 2 || !Object.hasOwn(receipt, 'ready') || !Object.hasOwn(receipt, 'pid')
        || receipt.ready !== true || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 || receipt.pid !== process.child.pid) {
        fail('UNCONFIRMED'); return;
      }
      ready = true; clearTimeout(readyTimer); resolveReady();
    });
    process.child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 4096) fail('UNCONFIRMED'); });
    process.child.once('error', () => fail('UNCONFIRMED'));
    process.done.then(() => { if (!disposing) fail('UNCONFIRMED'); else fixtureController.abort(); });
    onAbort = () => fail('CANCELLED');
    signal?.addEventListener('abort', onAbort, { once: true });
    readyTimer = setTimeout(() => fail('UNCONFIRMED'), 10000);
    if (signal?.aborted) onAbort();
    await readiness; check();
    if (terminalError || process.closed) throw terminalError ?? failure('UNCONFIRMED');
    const isAlive = () => {
      if (!allowed()) { fail(signal?.aborted ? 'CANCELLED' : 'UNCONFIRMED'); return false; }
      return ready && !process.closed && !terminalError && !fixtureController.signal.aborted;
    };
    const value = await callback({ pid: process.child.pid, signal: fixtureController.signal, isAlive });
    check();
    if (terminalError || process.closed) throw terminalError ?? failure('UNCONFIRMED');
    return value;
  } catch (error) {
    if (signal?.aborted) throw failure('CANCELLED');
    if (terminalError) throw terminalError;
    if (error?.code === 'DESKTOP_TARGET_UNCONFIRMED') throw failure('DESKTOP_TARGET_UNCONFIRMED');
    if (error?.code && ['UNAVAILABLE', 'UNCONFIRMED', 'CANCELLED'].includes(error.code)) throw error;
    throw failure('UNCONFIRMED');
  } finally {
    disposing = true; fixtureController.abort();
    clearTimeout(readyTimer); signal?.removeEventListener('abort', onAbort);
    if (process) { process.stop(); await process.done; }
    if (directory) try { await fs.rm(directory, { recursive: true, force: true }); } catch { throw failure('UNCONFIRMED'); }
  }
}
