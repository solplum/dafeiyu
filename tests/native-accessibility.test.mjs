import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDesktopAccessibility, prepareCurrentDesktopAccessibility } from '../packages/dsh-dafeiyu/src/native-accessibility.js';

function fixture() {
  const calls = [], directories = [];
  const options = { platform: 'darwin', resolveExecutable: async (name) => { assert.equal(name, 'clang'); return '/fixture/clang'; },
    async run(binary, args, settings) {
      calls.push({ binary, args, settings }); directories.push(settings.cwd);
      if (calls.length === 1) {
        assert.equal((await fs.stat(settings.cwd)).mode & 0o777, 0o700);
        await fs.writeFile(args[args.indexOf('-o') + 1], 'OFFLINE_FIXTURE_NOT_EXECUTABLE', { mode: 0o600 });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '{"ok":true,"code":"READY"}\n', stderr: '' };
    } };
  return { calls, directories, options };
}
async function assertClean(f) { for (const directory of new Set(f.directories)) await assert.rejects(fs.stat(directory), { code: 'ENOENT' }); }

test('fixed source compilation and exact PID invocation use private temporary artifacts, bounded processes and sanitized environment', async () => {
  const f = fixture(); assert.deepEqual(await prepareDesktopAccessibility(930, f.options), { ok: true, code: 'READY' });
  assert.equal(f.calls.length, 2);
  const [compile, helper] = f.calls;
  assert.ok(compile.args.includes('-fno-modules')); assert.ok(compile.args.includes('-fno-implicit-modules'));
  assert.ok(compile.args.includes('-fno-implicit-module-maps'));
  const source = compile.args[compile.args.indexOf('ApplicationServices') + 1];
  assert.equal(source, fileURLToPath(new URL('../packages/dsh-dafeiyu/native/dsh-accessibility.m', import.meta.url)));
  assert.equal(helper.binary, path.join(compile.settings.cwd, 'dsh-accessibility')); assert.deepEqual(helper.args, ['930']);
  for (const call of f.calls) {
    assert.ok(call.settings.timeout > 0 && call.settings.timeout <= 20000); assert.equal(call.settings.maxBuffer, 4096);
    assert.equal(call.settings.env.HOME, call.settings.cwd); assert.equal(call.settings.env.TMPDIR, call.settings.cwd + path.sep);
    assert.ok(call.settings.env.CLANG_MODULE_CACHE_PATH.startsWith(call.settings.cwd + path.sep));
    assert.ok(Object.keys(call.settings.env).every((key) => ['CLANG_MODULE_CACHE_PATH', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'USER', 'LOGNAME', 'SHELL'].includes(key)));
  }
  await assertClean(f);
});

test('non-Darwin and invalid PIDs never resolve a compiler, create artifacts or invoke any command', async () => {
  let touched = false;
  const options = { platform: 'linux', run: async () => { touched = true; }, resolveExecutable: async () => { touched = true; } };
  assert.deepEqual(await prepareDesktopAccessibility(930, options), { ok: false, code: 'UNAVAILABLE' });
  for (const pid of [0, -1, 1.5, Infinity, NaN, 2147483648, '930', '930;touch /tmp/unsafe', null, undefined])
    assert.deepEqual(await prepareDesktopAccessibility(pid, { ...options, platform: 'darwin' }), { ok: false, code: 'UNAVAILABLE' });
  assert.equal(touched, false);
});

test('current-DSH product mode supplies one fixed literal and cannot select a caller-provided target', async () => {
  const f = fixture(); assert.deepEqual(await prepareCurrentDesktopAccessibility({ ...f.options, target: 'other-app', pid: 123 }), { ok: true, code: 'READY' });
  assert.deepEqual(f.calls[1].args, ['current-dsh']); await assertClean(f);
  const source = await fs.readFile(fileURLToPath(new URL('../packages/dsh-dafeiyu/native/dsh-accessibility.m', import.meta.url)), 'utf8');
  assert.match(source, /runningApplicationsWithBundleIdentifier:@"com\.deepseek\.dsh"/);
  assert.match(source, /live\.count != 1/); assert.match(source, /!candidate\.terminated/);
});

test('default compiler resolution checks bounded installation metadata before invoking the clang shim', async (t) => {
  const directory = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'dafeiyu-offline-developer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const compilerDirectory = path.join(directory, 'usr/bin'); await fs.mkdir(compilerDirectory, { recursive: true });
  await fs.writeFile(path.join(compilerDirectory, 'clang'), 'FIXTURE_NOT_EXECUTED', { mode: 0o700 });
  const f = fixture(); delete f.options.resolveExecutable;
  f.options.run = async (binary, args, settings) => {
    f.calls.push({ binary, args, settings }); f.directories.push(settings.cwd);
    if (f.calls.length === 1) return { exitCode: 0, stdout: directory + '\n', stderr: '' };
    if (f.calls.length === 2) { await fs.writeFile(args[args.indexOf('-o') + 1], 'FIXTURE_NOT_EXECUTED'); return { exitCode: 0 }; }
    return { exitCode: 0, stdout: '{"ok":true,"code":"READY"}' };
  };
  assert.deepEqual(await prepareCurrentDesktopAccessibility(f.options), { ok: true, code: 'READY' });
  assert.equal(f.calls[0].binary, '/usr/bin/xcode-select'); assert.deepEqual(f.calls[0].args, ['--print-path']);
  assert.equal(f.calls[0].settings.timeout, 3000); assert.equal(f.calls[1].binary, '/usr/bin/clang');
  assert.deepEqual(f.calls[2].args, ['current-dsh']); await assertClean(f);
});

test('missing, invalid, absent-toolchain or timed-out developer metadata never invokes clang or helper', async () => {
  for (const metadata of [{ exitCode: 2, stdout: '', stderr: 'PRIVATE_INSTALL_INSTRUCTION' },
    { exitCode: 0, stdout: '/nonexistent/developer/path' }, { exitCode: 0, stdout: 'relative/path' },
    { exitCode: 0, stdout: '/usr\n/other' }, { exitCode: 0, stdout: '/usr' }, { exitCode: 0, stdout: '/usr', timedOut: true }]) {
    const f = fixture(); delete f.options.resolveExecutable;
    f.options.run = async (binary, args, settings) => { f.calls.push({ binary, args, settings }); f.directories.push(settings.cwd); return metadata; };
    const receipt = await prepareCurrentDesktopAccessibility(f.options);
    assert.deepEqual(receipt, { ok: false, code: 'UNAVAILABLE' }); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].binary, '/usr/bin/xcode-select'); assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false);
    await assertClean(f);
  }
});

test('compiler absence, failure, timeout, exception or missing output never invokes the helper and diagnostics stay private', async () => {
  for (const failure of ['resolve', 'exit', 'timeout', 'throw', 'missing']) {
    const f = fixture();
    if (failure === 'resolve') f.options.resolveExecutable = async () => { throw new Error('PRIVATE_RESOLVE'); };
    else f.options.run = async (binary, args, settings) => {
      f.calls.push({ binary, args, settings }); f.directories.push(settings.cwd);
      if (failure === 'throw') throw new Error('PRIVATE_COMPILER');
      return { exitCode: failure === 'exit' ? 1 : 0, stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_STDERR', timedOut: failure === 'timeout' };
    };
    const receipt = await prepareDesktopAccessibility(930, f.options);
    assert.deepEqual(receipt, { ok: false, code: 'UNAVAILABLE' }); assert.ok(f.calls.length <= 1);
    assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false); await assertClean(f);
  }
});

test('fixed untrusted receipts return without any authorization retry, even through execFile-style nonzero rejection', async () => {
  const f = fixture(), run = f.options.run;
  f.options.run = async (...args) => {
    if (f.calls.length === 0) return run(...args);
    f.calls.push({ binary: args[0], args: args[1], settings: args[2] });
    throw Object.assign(new Error('PRIVATE_OS_DIAGNOSTIC'), { code: 1, stdout: '{"ok":false,"code":"UNTRUSTED"}\n', stderr: 'PRIVATE' });
  };
  assert.deepEqual(await prepareDesktopAccessibility(930, f.options), { ok: false, code: 'UNTRUSTED' });
  assert.equal(f.calls.length, 2); await assertClean(f);
});

test('unknown, oversized, malformed, extra-field or timed-out helper receipts never become successful accessibility initialization', async () => {
  for (const reply of [
    { stdout: 'PRIVATE_NOT_JSON', exitCode: 0 },
    { stdout: '{"ok":true,"code":"PRIVATE_CODE"}', exitCode: 0 },
    { stdout: '{"ok":true,"code":"READY","text":"PRIVATE"}', exitCode: 0 },
    { stdout: '{"ok":true,"code":"READY"}', exitCode: 1 },
    { stdout: '{"ok":true,"code":"READY"}', exitCode: 0, timedOut: true },
    { stdout: '{"ok":true,"code":"READY"}', exitCode: 0, signal: 'SIGTERM' },
    { stdout: ' '.repeat(257), exitCode: 0 },
  ]) {
    const f = fixture(), run = f.options.run;
    f.options.run = async (...args) => f.calls.length === 0 ? run(...args) : reply;
    const receipt = await prepareDesktopAccessibility(930, f.options);
    assert.deepEqual(receipt, { ok: false, code: 'UNCONFIRMED' }); assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false);
    await assertClean(f);
  }
});

test('Objective-C helper retains the exact target, permission and attribute boundaries without UI actions (static safety checks, not AX runtime proof)', async () => {
  const source = await fs.readFile(fileURLToPath(new URL('../packages/dsh-dafeiyu/native/dsh-accessibility.m', import.meta.url)), 'utf8');
  assert.match(source, /isEqualToString:@"com\.deepseek\.dsh"/); assert.match(source, /AXIsProcessTrusted\(\)/);
  assert.match(source, /CFGetTypeID\(value\) == CFBooleanGetTypeID\(\)/);
  assert.match(source, /manualSet != kAXErrorSuccess/);
  const attributes = [...source.matchAll(/CFSTR\("(AX[^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(attributes, ['AXManualAccessibility', 'AXEnhancedUserInterface']);
  assert.doesNotMatch(source, /AXIsProcessTrustedWithOptions|kAXTrustedCheckOptionPrompt|CGEvent|AXUIElementPerformAction|AXChildren|AXValue|NSWorkspace|openURL|activateWithOptions/);
  const moduleSource = await fs.readFile(fileURLToPath(new URL('../packages/dsh-dafeiyu/src/native-accessibility.js', import.meta.url)), 'utf8');
  assert.match(moduleSource, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.match(moduleSource, /detached: false/); assert.match(moduleSource, /child\?\.kill\(signal\)/);
  assert.doesNotMatch(moduleSource, /finalTimer|process\.kill\(-/);
  assert.match(moduleSource, /child\.once\('close', \(code, signal\) => finish\(code, signal\)\)/);
});

test('revoking authorization during a pending helper waits for cleanup and rejects a late READY receipt', async () => {
  const f = fixture(), run = f.options.run, controller = new AbortController();
  let authorized = true, finishHelper, enteredHelper, settled = false;
  const started = new Promise((resolve) => { enteredHelper = resolve; });
  f.options.authorize = () => authorized; f.options.signal = controller.signal;
  f.options.run = async (...args) => {
    if (f.calls.length === 0) return run(...args);
    f.calls.push({ binary: args[0], args: args[1], settings: args[2] });
    enteredHelper();
    return new Promise((resolve) => { finishHelper = resolve; });
  };
  const pending = prepareCurrentDesktopAccessibility(f.options).finally(() => { settled = true; });
  await started;
  authorized = false; controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'cancellation is not proof that the child has stopped');
  assert.equal((await fs.stat(f.calls[1].settings.cwd)).isDirectory(), true);
  finishHelper({ exitCode: 0, stdout: '{"ok":true,"code":"READY"}' });
  assert.deepEqual(await pending, { ok: false, code: 'UNCONFIRMED' });
  assert.equal(f.calls.length, 2); await assertClean(f);
});

test('authorization or cancellation before compiler resolution, after compilation or after helper execution never publishes READY', async () => {
  for (const stage of ['before', 'compile', 'helper']) {
    const f = fixture(), controller = new AbortController(); let authorized = stage !== 'before';
    const run = f.options.run;
    f.options.authorize = () => authorized; f.options.signal = controller.signal;
    f.options.run = async (...args) => {
      const output = await run(...args);
      if (stage === 'compile' && f.calls.length === 1 || stage === 'helper' && f.calls.length === 2) { authorized = false; controller.abort(); }
      return output;
    };
    assert.deepEqual(await prepareDesktopAccessibility(930, f.options), { ok: false, code: 'UNCONFIRMED' });
    assert.equal(f.calls.length, stage === 'before' ? 0 : stage === 'compile' ? 1 : 2);
    for (const call of f.calls) assert.equal(call.settings.signal, controller.signal);
    await assertClean(f);
  }
  const f = fixture(), controller = new AbortController(); controller.abort();
  assert.deepEqual(await prepareDesktopAccessibility(930, { ...f.options, signal: controller.signal }), { ok: false, code: 'UNCONFIRMED' });
  assert.equal(f.calls.length, 0);
});
