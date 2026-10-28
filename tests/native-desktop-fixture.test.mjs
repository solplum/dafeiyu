import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDesktopFixture } from '../packages/dsh-dafeiyu/src/native-desktop-fixture.js';

function fixture({ ready = true, autoClose = true } = {}) {
  const compile = [], launches = [];
  const child = new EventEmitter(); child.pid = 43721; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.closed = false;
  child.close = () => { if (!child.closed) { child.closed = true; child.emit('close', 0, 'SIGTERM'); } };
  child.kill = (signal) => { child.kills.push(signal); if (autoClose) queueMicrotask(child.close); return true; };
  const options = { platform: 'darwin', resolveExecutable: async () => '/fixture/clang',
    async run(binary, args, settings) {
      compile.push({ binary, args, settings });
      await fs.writeFile(args[args.indexOf('-o') + 1], 'OFFLINE_NON_EXECUTABLE_FIXTURE'); return { exitCode: 0 };
    },
    spawn(binary, args, settings) {
      launches.push({ binary, args, settings });
      if (ready) queueMicrotask(() => child.stdout.write(JSON.stringify({ ready: true, pid: child.pid }) + '\n'));
      return child;
    } };
  return { options, compile, launches, child };
}
async function clean(f) { for (const call of f.compile) await assert.rejects(fs.stat(call.settings.cwd), { code: 'ENOENT' }); }
const immediate = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('private fixed-source fixture starts once, binds its real child PID, returns callback result only after actual close and cleans its directory', async () => {
  const f = fixture(); let count = 0;
  const output = await withDesktopFixture(async ({ pid, signal, isAlive }) => {
    count++; assert.equal(pid, f.child.pid); assert.equal(signal.aborted, false); assert.equal(isAlive(), true); assert.equal(f.child.kills.length, 0);
    assert.equal((await fs.stat(f.compile[0].settings.cwd)).mode & 0o777, 0o700);
    return { matched: true };
  }, f.options);
  assert.deepEqual(output, { matched: true }); assert.equal(count, 1); assert.equal(f.compile.length, 1); assert.equal(f.launches.length, 1);
  const compile = f.compile[0], launch = f.launches[0];
  assert.equal(compile.args[compile.args.indexOf('AppKit') + 1], fileURLToPath(new URL('../packages/dsh-dafeiyu/native/dsh-desktop-fixture.m', import.meta.url)));
  assert.ok(compile.args.includes('-fno-modules')); assert.ok(compile.args.includes('-fno-implicit-modules'));
  assert.ok(compile.args.includes('-fno-implicit-module-maps'));
  assert.equal(launch.binary, path.join(compile.settings.cwd, 'dsh-desktop-fixture')); assert.deepEqual(launch.args, []);
  assert.equal(launch.settings.detached, false); assert.deepEqual(launch.settings.stdio, ['ignore', 'pipe', 'pipe']);
  for (const settings of [compile.settings, launch.settings]) {
    assert.equal(settings.env.HOME, settings.cwd); assert.equal(settings.env.TMPDIR, settings.cwd + path.sep);
    assert.ok(Object.keys(settings.env).every((key) => ['CLANG_MODULE_CACHE_PATH', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'USER', 'LOGNAME', 'SHELL'].includes(key)));
  }
  assert.equal(f.child.closed, true); assert.deepEqual(f.child.kills, ['SIGTERM']); await clean(f);
});

test('malformed, oversized, duplicate or wrong-PID readiness never invokes the callback or retries the process', async () => {
  for (const text of ['PRIVATE_RAW_OUTPUT\n', 'null\n', '{"ready":false,"pid":43721}\n',
    '{"ready":true,"pid":43722}\n', '{"ready":true,"pid":43721,"extra":"private"}\n',
    '{"ready":true,"pid":43721}\n{"ready":true,"pid":43721}\n', 'x'.repeat(257)]) {
    const f = fixture({ ready: false }); let invoked = 0;
    const spawn = f.options.spawn;
    f.options.spawn = (...args) => { const child = spawn(...args); queueMicrotask(() => child.stdout.write(text)); return child; };
    await assert.rejects(withDesktopFixture(() => { invoked++; }, f.options), (error) => error.code === 'UNCONFIRMED' && !error.message.includes('PRIVATE'));
    assert.equal(invoked, 0); assert.equal(f.launches.length, 1); assert.equal(f.child.closed, true); await clean(f);
  }
});

test('readiness must arrive as a complete single line before callback dispatch', async () => {
  const f = fixture({ ready: false }), launched = deferred(); let invoked = 0;
  const spawn = f.options.spawn;
  f.options.spawn = (...args) => { const child = spawn(...args); launched.resolve(); return child; };
  const pending = withDesktopFixture(() => { invoked++; return 'done'; }, f.options);
  await launched.promise; f.child.stdout.write('{"ready":true,'); await immediate(); assert.equal(invoked, 0);
  f.child.stdout.write('"pid":43721}\n'); assert.equal(await pending, 'done'); assert.equal(invoked, 1); await clean(f);
});

test('non-Darwin, revoked authorization and already-cancelled callers do not resolve, compile or spawn', async () => {
  for (const mode of ['platform', 'denied', 'cancelled']) {
    const f = fixture(), controller = new AbortController(); let resolved = false;
    f.options.resolveExecutable = async () => { resolved = true; return '/fixture/clang'; };
    if (mode === 'platform') f.options.platform = 'linux';
    if (mode === 'denied') f.options.authorize = () => false;
    if (mode === 'cancelled') { controller.abort(); f.options.signal = controller.signal; }
    await assert.rejects(withDesktopFixture(() => assert.fail('callback must not run'), f.options), { code: mode === 'platform' ? 'UNAVAILABLE' : mode === 'cancelled' ? 'CANCELLED' : 'UNCONFIRMED' });
    assert.equal(resolved, false); assert.equal(f.compile.length, 0); assert.equal(f.launches.length, 0);
  }
});

test('compiler failure and authorization revoked after compile never launch a window', async () => {
  for (const mode of ['resolve', 'compile', 'revoked']) {
    const f = fixture(); let authorized = true; f.options.authorize = () => authorized;
    if (mode === 'resolve') f.options.resolveExecutable = async () => { throw new Error('PRIVATE_COMPILER_PATH'); };
    if (mode === 'compile') f.options.run = async () => ({ exitCode: 1, stderr: 'PRIVATE_COMPILER_OUTPUT' });
    if (mode === 'revoked') { const run = f.options.run; f.options.run = async (...args) => { const value = await run(...args); authorized = false; return value; }; }
    await assert.rejects(withDesktopFixture(() => assert.fail('callback must not run'), f.options), (error) => error.code === (mode === 'revoked' ? 'UNCONFIRMED' : 'UNAVAILABLE') && !error.message.includes('PRIVATE'));
    assert.equal(f.launches.length, 0); await clean(f);
  }
});

test('stop escalates TERM to KILL but retains artifacts and the operation until real close', async () => {
  const f = fixture({ autoClose: false }), entered = deferred(); let settled = false;
  const pending = withDesktopFixture(() => { entered.resolve(); return 'matched'; }, f.options).finally(() => { settled = true; });
  await entered.promise; await new Promise((resolve) => setTimeout(resolve, 280));
  assert.deepEqual(f.child.kills, ['SIGTERM', 'SIGKILL']); assert.equal(settled, false);
  assert.equal((await fs.stat(f.compile[0].settings.cwd)).isDirectory(), true);
  f.child.close(); assert.equal(await pending, 'matched'); await clean(f);
});

test('cancellation closes the fixture immediately but still waits for active callback cleanup and rejects its late success', async () => {
  const f = fixture(), entered = deferred(), finish = deferred(), controller = new AbortController(); let settled = false;
  let callbackSignal, alive;
  f.options.signal = controller.signal;
  const pending = withDesktopFixture(async ({ signal, isAlive }) => { callbackSignal = signal; alive = isAlive; entered.resolve(); await finish.promise; return 'late success'; }, f.options).finally(() => { settled = true; });
  await entered.promise; controller.abort(); await immediate();
  assert.equal(f.child.closed, true); assert.equal(callbackSignal.aborted, true); assert.equal(alive(), false); assert.equal(settled, false); assert.equal(f.launches.length, 1);
  assert.equal((await fs.stat(f.compile[0].settings.cwd)).isDirectory(), true);
  finish.resolve(); await assert.rejects(pending, { code: 'CANCELLED' }); await clean(f);
});

test('observed authorization revocation or unexpected child exit aborts active Orca work with no PID fallback', async () => {
  for (const mode of ['revoked', 'exit']) {
    const f = fixture(); let authorized = true; f.options.authorize = () => authorized;
    await assert.rejects(withDesktopFixture(async ({ signal, isAlive, pid }) => {
      assert.equal(pid, f.child.pid); assert.equal(isAlive(), true);
      if (mode === 'revoked') { authorized = false; assert.equal(isAlive(), false); }
      else { f.child.close(); await immediate(); }
      assert.equal(signal.aborted, true); assert.equal(isAlive(), false);
      throw new Error('PRIVATE_ABORTED_ORCA_OUTPUT');
    }, f.options), (error) => error.code === 'UNCONFIRMED' && !error.message.includes('PRIVATE'));
    assert.equal(f.launches.length, 1); assert.equal(f.child.closed, true); await clean(f);
  }
});

test('unexpected fixture exit or callback failure cannot publish success and still cleans only after close', async () => {
  for (const mode of ['exit', 'callback']) {
    const f = fixture();
    await assert.rejects(withDesktopFixture(async () => {
      if (mode === 'callback') throw new Error('PRIVATE_CALLBACK_DIAGNOSTIC');
      f.child.close(); await immediate(); return 'invalid success';
    }, f.options), (error) => error.code === 'UNCONFIRMED' && !error.message.includes('PRIVATE'));
    assert.equal(f.child.closed, true); assert.equal(f.launches.length, 1); await clean(f);
  }
});

test('the fixed unconfirmed-target code is sanitized and published only after fixture cleanup', async () => {
  const f = fixture({ autoClose: false }), entered = deferred(); let settled = false;
  const pending = withDesktopFixture(() => {
    entered.resolve(); throw Object.assign(new Error('PRIVATE_PROVIDER_DIAGNOSTIC'), { code: 'DESKTOP_TARGET_UNCONFIRMED' });
  }, f.options).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, (error) => error.code === 'DESKTOP_TARGET_UNCONFIRMED' && error.message === '本机测试窗口未确认');
  await entered.promise; await immediate();
  assert.equal(settled, false); assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.equal((await fs.stat(f.compile[0].settings.cwd)).isDirectory(), true);
  f.child.close(); await rejected; await clean(f);
});
