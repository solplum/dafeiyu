import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { nativeEgoEnvelope, nativeEgoScript } from '../packages/dsh-dafeiyu/src/social/native-ego-script.mjs';
import { PassThrough } from 'node:stream';
import { NativeEgoAccountRuntime, NATIVE_EGO_CLI, verifyNativeEgoCli } from '../packages/dsh-dafeiyu/src/social/native-ego-account-runtime.mjs';
import { randomUUID } from 'node:crypto';
import { BrowserAccountDriver } from '../packages/dsh-dafeiyu/src/social/browser-account.mjs';
import { SocialAccounts } from '../packages/dsh-dafeiyu/src/social/accounts.mjs';
import { socialAccountRoute } from '../packages/dsh-dafeiyu/src/social/account-routes.mjs';
import { createSocialAccounts } from '../packages/dsh-dafeiyu/src/social/accounts-factory.mjs';
const context = { authorize: () => true };
const binding = { version: 2, spaceId: 14, spaceName: 'dafeiyu-douyin-native', pageLabel: 'p1' };
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-native-runtime-')), directory = path.join(root, 'douyin');
  fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(directory, 'native-ego.private.json'), state = path.join(directory, 'native-ego-owned.private.json');
  const write = value => { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(file, 0o600); };
  if (!options.noBinding) write(binding);
  return { root, directory, file, state, write };
}
function fakeNative(f, options = {}) {
  const events = [], pages = new Map(), children = []; let taskCalls = 0, newPages = 0, invocation;
  const add = (label, url = 'about:blank', openedBy = 'agent') => {
    const p = { label, openedBy, current: url, targetId: 'target-' + label,
      url: async () => p.current,
      cdp: async (method, args) => { events.push(['cdp', label, method, args]); },
      evaluate: async (...args) => { const [fn, arg] = args;
        if (typeof fn === 'string' && args.length !== 1) throw new TypeError('String expressions accept exactly one argument');
        events.push(['evaluate', label, args.length]);
        if (options.rejectInternalEvaluate && p.current.startsWith('chrome:')) throw Error('PRIVATE_INTERNAL_PAGE_ERROR');
        if (typeof fn === 'function') return fn(arg);
        if (fn === '(()=>2+2)()') return 4;
        return options.mediaPause === false ? false : true; },
      goto: async (url, opts) => { events.push(['goto', label, url, opts]);
        assert(fs.existsSync(f.state)); const state = JSON.parse(fs.readFileSync(f.state));
        if (label !== 'p1') assert(state.createdLabels.includes(label), 'ownership is durable before navigation');
        p.current = options.redirect || url; },
      waitForFunction: async (...args) => { events.push(['wait', label, ...args]); return true; },
      snapshot: async () => 'safe snapshot', screenshot: async () => '/fixture.png',
      click: async (...args) => events.push(['click', label, ...args]), fill: async (...args) => events.push(['fill', label, ...args]),
      waitForSelector: async (...args) => events.push(['selector', label, ...args]),
      close: async () => { events.push(['close', label]); if (!options.closeFails) pages.delete(label); else throw Error('untrusted private failure'); } };
    pages.set(label, p); return p;
  };
  add('p1', 'https://creator.douyin.com/creator-micro/home');
  const task = { spaceId: 14, name: binding.spaceName, ownership: 'agent',
    page(label) { assert(pages.has(label)); return pages.get(label); },
    tabs: async () => [...pages.values()].map(p => ({ label: p.label, page: p, targetId: p.targetId, url: p.current, openedBy: p.openedBy })),
    newPage: async () => { newPages++; const label = 'p' + (newPages + 1); events.push(['newPage', label]); return add(label, options.newPageUrl || 'about:blank'); } };
  const spawnProcess = (exe, args, opts) => {
    invocation = { exe, args, opts }; const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.signals = [];
    child.kill = signal => { child.signals.push(signal); if (options.closeOnKill) setImmediate(() => child.emit('close', null)); return true; };
    let script = ''; child.stdin.on('data', bytes => { script += bytes.toString(); });
    child.stdin.on('finish', () => setImmediate(async () => {
      if (options.hang) return;
      if (options.output) { child.stdout.write(options.output); child.emit('close', 0); return; }
      try {
        const fn = new AsyncFunction('listTaskSpaces', 'taskSpace', 'console', script);
        await fn(async () => options.missingSpace ? [] : [{ id: 14, name: options.name || binding.spaceName, ownership: options.ownership || 'agent' }],
          async id => { taskCalls++; assert.equal(id, 14); return task; },
          { log(value) { child.stderr.write('private log must not surface\n'); child.stdout.write(value + '\n'); } });
        options.beforeClose?.(); child.emit('close', 0);
      } catch { child.stderr.write('private exception'); child.emit('close', 1); }
    }));
    children.push(child); return child;
  };
  return { events, pages, add, children, spawnProcess, get invocation() { return invocation; }, get taskCalls() { return taskCalls; }, get newPages() { return newPages; } };
}
const make = (f, fake, extra = {}) => new NativeEgoAccountRuntime({ directory: f.directory, verifyCli: () => true, spawnProcess: fake.spawnProcess, ...extra });

test('missing or old v1 binding never launches native or Chrome', async t => {
  const f = fixture(t, { noBinding: true }), fake = fakeNative(f), runtime = make(f, fake);
  assert.equal(runtime.available, false); assert.equal(runtime.unavailableReason, 'native-space-required');
  await assert.rejects(runtime.run('const result={};', context), { code: 'BINDINGS_REQUIRED' });
  f.write({ version: 1, profileId: 'Default', spaceName: 'old-profile' });
  await assert.rejects(runtime.run('', context), { code: 'BINDINGS_REQUIRED' });
  assert.equal(fake.children.length, 0); assert.equal(fs.existsSync(f.state), false);
});

test('owner v2 binding invokes fixed pinned native CLI and keeps raw logs private', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
  assert.equal(runtime.available, true);
  const result = await runtime.run('const result={ok:true,url:await page.url()};', context);
  assert.equal(result.ok, true); assert.equal(fake.invocation.exe, NATIVE_EGO_CLI);
  assert.deepEqual(fake.invocation.args, ['nodejs']); assert.equal(fake.invocation.opts.shell, false);
  assert(!JSON.stringify(fake.invocation).includes('Chrome')); assert.equal(fake.taskCalls, 1);
  const state = JSON.parse(fs.readFileSync(f.state)); assert.equal(state.pending, false);
  assert.equal(state.spaceId, 14); assert.equal(runtime.children.size, 0);
  assert(!JSON.stringify(runtime.status()).includes(binding.spaceName));
  await runtime.dispose();
});

test('changed CLI hash or untrusted private file cannot start a process', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake, { verifyCli: () => false });
  assert.equal(runtime.available, false); await assert.rejects(runtime.run('', context), { code: 'DRIVER_UNAVAILABLE' });
  fs.chmodSync(f.file, 0o644); await assert.rejects(make(f, fake).run('', context), { code: 'BINDINGS_REQUIRED' });
  f.write({ ...binding, extra: true }); await assert.rejects(make(f, fake).run('', context), { code: 'BINDINGS_REQUIRED' });
  assert.equal(fake.children.length, 0);
});

test('existing space must have exact id/name and current agent ownership; never claim or create', async t => {
  for (const options of [{ ownership: 'user' }, { name: 'different-space' }]) {
    const f = fixture(t), fake = fakeNative(f, options), runtime = make(f, fake);
    await assert.rejects(runtime.run('const result={};', context), { code: 'BINDINGS_REQUIRED' });
    assert.equal(fake.taskCalls, 0); assert.equal(fake.newPages, 0);
  }
});

test('legacy facade uses managed Page references without native activation and converts wait options', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
  const result = await runtime.run(`await taskSpaces.useOrCreate('dfy-social-douyin');await browser.ensureRealTab();
await page.goto('https://creator.douyin.com/creator-micro/home',{wait:true,timeout:1234});
await page.waitForFunction('true',{timeout:456});await page.locator('#local-fixture').click();
const tabs=await browser.listTabs();await browser.switchTab(tabs[0].targetId);const result={url:await page.url()};`, context);
  assert.equal(result.url, 'https://creator.douyin.com/creator-micro/home');
  const goto = fake.events.find(x => x[0] === 'goto'); assert.deepEqual(goto[3], { timeout: 1234, waitUntil: 'domcontentloaded' });
  const wait = fake.events.find(x => x[0] === 'wait'); assert.equal(wait[3], undefined); assert.deepEqual(wait[4], { timeout: 456 });
  assert(fake.events.findIndex(x => x[0] === 'cdp') < fake.events.findIndex(x => x[0] === 'goto'));
  assert(!fake.events.some(x => x[0] === 'activate'));
});

test('new feed page is journaled before guarded navigation and stop retains logged-in p1 and user tabs', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake); fake.add('p9', 'https://www.douyin.com/user', 'unknown');
  await runtime.run(`await browser.openOrReuseTab('https://www.douyin.com/?recommend=1');const result={url:await page.url()};`, context);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).createdLabels, ['p2']);
  const result = await runtime.stop(context);
  assert.deepEqual(result, { stopped: true, browserStopped: false, spaceRetained: true });
  assert(fake.pages.has('p1')); assert(fake.pages.has('p9')); assert(!fake.pages.has('p2'));
  assert.deepEqual(fake.events.filter(x => x[0] === 'close'), [['close', 'p2']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).createdLabels, []); assert.equal(runtime.cleanupPending, false);
});

test('unmanaged feed page and non-allowlisted URL cannot be adopted or navigated', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake); fake.add('p9', 'https://www.douyin.com/?recommend=1', 'unknown');
  await assert.rejects(runtime.run(`await browser.openOrReuseTab('https://www.douyin.com/?recommend=1');const result={};`, context), { code: 'BINDINGS_REQUIRED' });
  await assert.rejects(runtime.run(`await page.goto('https://example.com/');const result={};`, context), { code: 'BINDINGS_REQUIRED' });
  assert.equal(fake.newPages, 0); assert(!fake.events.some(x => x[0] === 'goto'));
});

test('claim, handOff, uploads and unknown response APIs stay unavailable', async t => {
  for (const operation of [`await taskSpaces.claim(14)`, `await taskSpaces.handOff('dfy-social-douyin')`, `await page.locator('input').setInputFiles('/unused')`]) {
    const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
    await assert.rejects(runtime.run(operation + ';const result={};', context), { code: 'BINDINGS_REQUIRED' });
    assert.equal(fake.newPages, 0);
  }
});

test('unknown receipt survives reload and blocks replay; stop cannot declare unknown cleanup complete', async t => {
  const f = fixture(t), fake = fakeNative(f, { output: 'private malformed output' }), runtime = make(f, fake);
  await assert.rejects(runtime.run('const result={};', context), e => e.code === 'INVALID_RECEIPT' && !e.message.includes('private'));
  assert.equal(runtime.cleanupPending, true); assert.equal(JSON.parse(fs.readFileSync(f.state)).unknown, true);
  const second = fakeNative(f), reloaded = make(f, second);
  await assert.rejects(reloaded.run('const result={};', context), { code: 'CLEANUP_UNCONFIRMED' });
  assert.equal(second.children.length, 0);
  await assert.rejects(reloaded.stop(context), { code: 'CLEANUP_UNCONFIRMED' }); assert.equal(reloaded.cleanupPending, true);
});

test('cancel waits for its child close and retains unknown proof without killing the app', async t => {
  const f = fixture(t), fake = fakeNative(f, { hang: true, closeOnKill: true }), runtime = make(f, fake);
  const controller = new AbortController(), pending = runtime.run('const result={};', { ...context, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: 'BROWSER_UNKNOWN' });
  assert.deepEqual(fake.children[0].signals, ['SIGTERM']); assert.equal(runtime.children.size, 0);
  assert.equal(runtime.cleanupPending, true); assert.equal(JSON.parse(fs.readFileSync(f.state)).unknown, true);
});

test('authorization and cancellation reject before any file write or process', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
  await assert.rejects(runtime.run('', { authorize: () => false }), { code: 'FORBIDDEN' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.run('', { ...context, signal: controller.signal }), { code: 'FORBIDDEN' });
  assert.equal(fake.children.length, 0); assert.equal(fs.existsSync(f.state), false);
});

test('factory has native-only backends and keeps platform identity and owner pause bytes intact', t => {
  const f = fixture(t), file = path.join(f.root, 'accounts.json');
  const state = { version: 1, accounts: { douyin: { state: 'bound', accountId: 'same-platform-account', name: 'fixture', generation: 1 },
    x: { state: 'disconnected', generation: 0, safetyPause: { reason: 'owner-paused', at: '2026-10-26T00:00:00.000Z' } } }, operations: {} };
  const before = JSON.stringify(state); fs.writeFileSync(file, before, { mode: 0o600 });
  const accounts = createSocialAccounts({ directory: f.root, egoRuntime: { chrome: '/must-not-use/chrome', entry: '/must-not-use/linux-facade' } });
  for (const key of ['douyin', 'x']) assert(accounts.drivers[key].runtime instanceof NativeEgoAccountRuntime);
  assert.equal(accounts.store.read().state.accounts.douyin.accountId, 'same-platform-account');
  assert.equal(accounts.store.read().state.accounts.x.safetyPause.reason, 'owner-paused');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});


test('oversized logs are unknown and never expose raw output', async t => {
  const f = fixture(t), fake = fakeNative(f, { output: 'x'.repeat(2 * 1024 * 1024 + 1), closeOnKill: true }), runtime = make(f, fake);
  await assert.rejects(runtime.run('const result={};', context), e => e.code === 'BROWSER_UNKNOWN' && e.message.length < 100);
  assert.equal(runtime.cleanupPending, true); assert.equal(JSON.parse(fs.readFileSync(f.state)).unknown, true);
});

test('a changed owner binding during an invocation preserves unknown cleanup', async t => {
  const f = fixture(t), fake = fakeNative(f, { beforeClose: () => f.write({ ...binding, spaceId: 15 }) }), runtime = make(f, fake);
  await assert.rejects(runtime.run('const result={ok:true};', context), { code: 'BROWSER_UNKNOWN' });
  assert.equal(runtime.cleanupPending, true); assert.equal(runtime.available, false);
});

test('media pause or confirmed close failure cannot report successful stop', async t => {
  const f = fixture(t), fake = fakeNative(f, { closeFails: true }), runtime = make(f, fake);
  await runtime.run("await browser.openOrReuseTab('https://www.douyin.com/?recommend=1');const result={};", context);
  await assert.rejects(runtime.stop(context), { code: 'BROWSER_UNKNOWN' });
  assert(fake.pages.has('p2')); assert.equal(runtime.cleanupPending, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).createdLabels, ['p2']);
});


test('native launch preserves only the two non-secret harness identity variables', async t => {
  const names = ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'PRIVATE_NATIVE_TEST_SECRET'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.CODEX_SESSION_ID = 'fixture-session-id'; process.env.CODEX_THREAD_ID = 'fixture-thread-id';
    process.env.PRIVATE_NATIVE_TEST_SECRET = 'must-not-inherit';
    const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
    await runtime.run('const result={ok:true};', context);
    assert.deepEqual(Object.keys(fake.invocation.opts.env).sort(), ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'LANG', 'PATH']);
    assert.equal(fake.invocation.opts.env.CODEX_SESSION_ID, 'fixture-session-id');
    assert.equal(fake.invocation.opts.env.CODEX_THREAD_ID, 'fixture-thread-id');
  } finally { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } }
});


test('bounded diagnostics retain only fixed stage and error type, without message or stack', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
  await assert.rejects(runtime.run("throw new TypeError('PRIVATE_CONTENT_MUST_NOT_RETURN');const result={};", context), e => e.code === 'BROWSER_UNKNOWN' && !e.message.includes('PRIVATE')
    && e.diagnostic.phase === 'script-body' && e.diagnostic.name === 'TypeError' && e.diagnostic.code === 'BROWSER_UNKNOWN');
  assert.deepEqual(runtime.lastDiagnostic, { phase: 'script-body', name: 'TypeError', code: 'BROWSER_UNKNOWN' });
  assert(!JSON.stringify(runtime.lastDiagnostic).includes('PRIVATE'));
});

test('a newly owned internal p2 is normalized before media evaluation and target navigation', async t => {
  const f = fixture(t), fake = fakeNative(f, { newPageUrl: 'chrome://newtab/', rejectInternalEvaluate: true }), runtime = make(f, fake);
  const result = await runtime.run("await browser.openOrReuseTab('https://www.douyin.com/?recommend=1');const result={url:await page.url()};", context);
  assert.equal(result.url, 'https://www.douyin.com/?recommend=1');
  const events = fake.events.filter(row => row[1] === 'p2');
  assert.deepEqual(events.filter(row => row[0] === 'goto').map(row => row[2]), ['about:blank', 'https://www.douyin.com/?recommend=1']);
  assert(events.findIndex(row => row[0] === 'goto') < events.findIndex(row => row[0] === 'evaluate'));
  const state = JSON.parse(fs.readFileSync(f.state));
  assert.deepEqual(state.createdLabels, ['p2']); assert.equal(state.pending, false); assert.equal(state.unknown, false);
});

test('new page normalization never adopts an unexpected existing destination', async t => {
  const f = fixture(t), fake = fakeNative(f, { newPageUrl: 'https://www.douyin.com/unexpected' }), runtime = make(f, fake);
  await assert.rejects(runtime.run("await browser.openOrReuseTab('https://www.douyin.com/?recommend=1');const result={};", context), { code: 'BINDINGS_REQUIRED' });
  assert(!fake.events.some(row => ['goto', 'evaluate', 'cdp'].includes(row[0]) && row[1] === 'p2'));
  assert.equal(fake.newPages, 1);
});

test('fixed browse timeout diagnostics survive SocialAccountError without exposing private exception data', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
  await assert.rejects(runtime.run("__dfyPhase('browse-navigation-wait');const e=new Error('PRIVATE_URL_AND_DOM');e.name='TimeoutError';e.code='PRIVATE_TOKEN';throw e;const result={};", context), e => {
    assert.deepEqual(e.diagnostic, { phase: 'browse-navigation-wait', name: 'TimeoutError', code: 'TIMEOUT' });
    assert(!JSON.stringify(e).includes('PRIVATE')); return e.code === 'BROWSER_UNKNOWN';
  });
  assert.deepEqual(runtime.status().lastDiagnostic, { phase: 'browse-navigation-wait', name: 'TimeoutError', code: 'TIMEOUT' });
  const state = JSON.parse(fs.readFileSync(f.state)); assert.equal(state.pending, true); assert.equal(state.unknown, true);
  await assert.rejects(runtime.run('const result={};', context), { code: 'DRIVER_UNAVAILABLE' });
  assert.equal(fake.children.length, 1, 'diagnostics do not release unknown occupancy or retry');
});

test('unknown diagnostic stage names and native exception codes are never projected', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
  await assert.rejects(runtime.run("__dfyPhase('PRIVATE_STAGE');const e=new Error('PRIVATE_MESSAGE');e.name='PRIVATE_NAME';e.code='PRIVATE_CODE';throw e;const result={};", context), e => {
    assert.deepEqual(e.diagnostic, { phase: 'script-body', name: 'Error', code: 'BROWSER_UNKNOWN' });
    assert(!JSON.stringify(e).includes('PRIVATE')); return e.code === 'BROWSER_UNKNOWN';
  });
});

test('a new successful native invocation clears a previous known failure diagnostic', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
  await assert.rejects(runtime.run("__dfyPhase('browse-identity-read');throw Error('BINDINGS_REQUIRED');const result={};", context), e => {
    assert.deepEqual(e.diagnostic, { phase: 'browse-identity-read', name: 'Error', code: 'BINDINGS_REQUIRED' }); return e.code === 'BINDINGS_REQUIRED';
  });
  assert.equal(runtime.status().lastDiagnostic.phase, 'browse-identity-read');
  await runtime.run('const result={ok:true};', context);
  assert.equal(runtime.status().lastDiagnostic, null);
});


// Even pure CLI arithmetic is opt-in: ordinary offline regression must not
// initialize the installed browser when a newly approved build is present.
test('pinned native embedded Node executes the exact envelope with pure local arithmetic', {
  skip: process.env.DFY_NATIVE_LOCAL_MATH !== '1' || !verifyNativeEgoCli(),
}, () => {
  const marker = '@@DFY_NATIVE_LOCAL_MATH@@';
  const script = nativeEgoEnvelope('return {value:2+2};', marker);
  assert(!script.includes('await(')); assert(!script.includes('taskSpace')); assert(!script.includes('page.'));
  const run = spawnSync(NATIVE_EGO_CLI, ['nodejs'], { input: script, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' } });
  assert.equal(run.status, 0, 'native local arithmetic process must exit successfully');
  const lines = (run.stdout + run.stderr).split(/\r?\n/).filter(line => line.startsWith(marker));
  assert.equal(lines.length, 1, 'must return exactly one native arithmetic receipt');
  assert.deepEqual(JSON.parse(lines[0].slice(marker.length)), { value: 4 });
});


test('evaluate preserves one argument for strings and two arguments for callback data', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
  const result = await runtime.run("const result={string:await page.evaluate('(()=>2+2)()'),callback:await page.evaluate(value=>value+1,3)};", context);
  assert.deepEqual(result, { string: 4, callback: 4 });
  assert.deepEqual(fake.events.filter(x=>x[0]==='evaluate').map(x=>x[2]), [1, 2]);
});

// Opt-in only: pure arithmetic on the already owner-bound p1, never DOM/account
// reads or navigation. The root performs this local compatibility check while
// coordinating its native browser; ordinary regression never touches a Page.
const nativeMathSpaceId = Number(process.env.DFY_NATIVE_MATH_SPACE_ID || 0);
test('native bound Page evaluation forwards pure math without a synthetic argument', {
  skip: !verifyNativeEgoCli() || !Number.isSafeInteger(nativeMathSpaceId) || nativeMathSpaceId < 1,
}, t => {
  const f = fixture(t), marker = '@@DFY_NATIVE_PAGE_MATH@@';
  const state = { version: 1, bindingDigest: '0'.repeat(64), spaceId: nativeMathSpaceId,
    createdLabels: [], pending: false, unknown: false, creatingPage: false };
  const script = nativeEgoScript({ binding: { ...binding, spaceId: nativeMathSpaceId }, state,
    stateFile: f.state, marker, key: 'douyin', body: "const result={value:await page.evaluate('(()=>2+2)()')};" });
  const env = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' };
  for (const name of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) if (process.env[name]) env[name] = process.env[name];
  const run = spawnSync(NATIVE_EGO_CLI, ['nodejs'], { input: script, encoding: 'utf8', timeout: 10000, env });
  assert.equal(run.status, 0, 'native pure Page arithmetic process must exit successfully');
  const lines = (run.stdout + run.stderr).split(/\r?\n/).filter(line=>line.startsWith(marker));
  assert.equal(lines.length, 1, 'must return exactly one native pure Page arithmetic receipt');
  assert.deepEqual(JSON.parse(lines[0].slice(marker.length)), { value: 4 });
});


test('the exact observed Douyin recommendation redirect may return to the driver for its explicit fallback', async t => {
  const f = fixture(t), fake = fakeNative(f, { redirect: 'https://www.douyin.com/jingxuan' }), runtime = make(f, fake);
  const result = await runtime.run("await browser.openOrReuseTab('https://www.douyin.com/?recommend=1');const result={url:await page.url()};", context);
  assert.deepEqual(result, { url: 'https://www.douyin.com/jingxuan' });
  assert.equal(fake.events.filter(x=>x[0]==='goto').length, 1);
  assert.equal(fake.events.filter(x=>x[0]==='click').length, 0, 'runtime does not invent fallback clicks');
});

test('all other redirect paths and query variants remain blocked', async t => {
  const cases = [
    ['https://www.douyin.com/?recommend=1', 'https://www.douyin.com/jingxuan?unexpected=1'],
    ['https://www.douyin.com/?recommend=1', 'https://www.douyin.com/jingxuan/'],
    ['https://www.douyin.com/?recommend=1', 'https://www.douyin.com/other'],
    ['https://www.douyin.com/?recommend=1&from_nav=1', 'https://www.douyin.com/jingxuan'],
    ['https://creator.douyin.com/creator-micro/home', 'https://www.douyin.com/jingxuan'],
    ['https://WWW.douyin.com/?recommend=1', 'https://www.douyin.com/jingxuan'],
  ];
  for (const [requested, redirect] of cases) {
    const f = fixture(t), fake = fakeNative(f, { redirect }), runtime = make(f, fake);
    await assert.rejects(runtime.run(`await page.goto(${JSON.stringify(requested)});const result={};`, context), { code: 'BINDINGS_REQUIRED' });
  }
});


const ownerRecovery = { ...context, ownerRecovery: true, executionStopped: true, resultReviewed: true };
async function makeUnknown(f, runtime) {
  await assert.rejects(runtime.run("throw new TypeError('unknown fixture');const result={};", context), { code: 'BROWSER_UNKNOWN' });
  return fs.readFileSync(f.state, 'utf8');
}
function nativeManager(f, runtime, patch = {}) {
  const state = { version: 1, accounts: { douyin: { state: 'bound', accountId: 'same-platform-account', generation: 1,
    safetyPause: { reason: 'owner-paused', at: '2026-10-26T00:00:00.000Z' }, ...patch } }, operations: {} };
  const file = path.join(f.root, 'accounts.json'); fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const manager = new SocialAccounts({ directory: f.root, drivers: { douyin: new BrowserAccountDriver({ key: 'douyin', directory: f.directory, runtime }) } });
  const body = () => ({ platform: 'douyin', revision: manager.snapshot().revision, executionStopped: true, resultReviewed: true });
  return { manager, file, body };
}

test('native owner recovery prepares metadata only, archives immutable unknown proof, then explicitly commits', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake); const before = await makeUnknown(f, runtime);
  const count = fake.events.length, prepared = await runtime.recoverExecutor(ownerRecovery);
  assert.equal(fs.readFileSync(f.state, 'utf8'), before); assert.equal(runtime.cleanupPending, true);
  assert.equal(fake.events.length, count, 'recovery never evaluates, navigates or closes any Page');
  const result = prepared.commit(); assert.equal(result.recovered, true); assert.equal(result.unknownResultRetained, true);
  const proofFile = path.join(f.directory, 'native-recovery-proofs', result.proofDigest + '.json');
  assert.equal(fs.statSync(proofFile).mode & 0o777, 0o400);
  assert.equal(JSON.parse(fs.readFileSync(proofFile)).unknownStateBytes, before);
  assert.equal(JSON.parse(fs.readFileSync(f.state)).unknown, false); assert.equal(runtime.cleanupPending, false);
});

test('owner HTTP recovery awaits native prepare and preserves platform pause, identity and unknown evidence', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake); await makeUnknown(f, runtime);
  const m = nativeManager(f, runtime), before = JSON.parse(fs.readFileSync(m.file));
  const result = await socialAccountRoute('social/recover-executor', m.manager, m.body(), context);
  assert.equal(result.ok, true); assert.equal(result.recovered, true); assert.equal(result.spaceRetained, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(m.file)), before);
  assert.equal(fs.readdirSync(path.join(f.directory, 'native-recovery-proofs')).length, 1);
});

test('store or account generation changes during native await cannot clear unknown', async t => {
  const f = fixture(t), options = {}, fake = fakeNative(f, options), runtime = make(f, fake);
  const before = await makeUnknown(f, runtime), m = nativeManager(f, runtime);
  options.beforeClose = () => { const state = JSON.parse(fs.readFileSync(m.file)); state.accounts.douyin.generation++; fs.writeFileSync(m.file, JSON.stringify(state)); };
  await assert.rejects(m.manager.recoverExecutor(m.body(), context), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(f.state, 'utf8'), before); assert.equal(runtime.cleanupPending, true);
  assert.equal(fs.existsSync(path.join(f.directory, 'native-recovery-proofs')), false);
  assert.equal(fs.existsSync(path.join(f.directory, '.recovery-lock')), false);
});

test('owner revocation during native await leaves unknown and clears no records', async t => {
  const f = fixture(t), options = {}, fake = fakeNative(f, options), runtime = make(f, fake);
  const before = await makeUnknown(f, runtime), m = nativeManager(f, runtime); let authorized = true;
  options.beforeClose = () => { authorized = false; };
  await assert.rejects(m.manager.recoverExecutor(m.body(), { authorize: () => authorized }), { code: 'FORBIDDEN' });
  assert.equal(fs.readFileSync(f.state, 'utf8'), before); assert.equal(runtime.cleanupPending, true);
});

test('binding or native unknown state changes during metadata await refuse commit', async t => {
  for (const change of ['binding', 'state']) {
    const f = fixture(t), options = {}, fake = fakeNative(f, options), runtime = make(f, fake); await makeUnknown(f, runtime);
    options.beforeClose = () => { if(change==='binding') f.write({ ...binding, spaceId: 15 });
      else { const state=JSON.parse(fs.readFileSync(f.state)); state.pending=!state.pending; fs.writeFileSync(f.state,JSON.stringify(state)); } };
    await assert.rejects(runtime.recoverExecutor(ownerRecovery), { code: 'CONFLICT' });
    assert.equal(JSON.parse(fs.readFileSync(f.state)).unknown, true);
    assert.equal(fs.existsSync(path.join(f.directory, 'native-recovery-proofs')), false);
  }
});

test('missing explicit ACK, business unknown, active worker and creating-page proof refuse recovery', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake); await makeUnknown(f, runtime);
  const count = fake.children.length;
  await assert.rejects(runtime.recoverExecutor(context), { code: 'ACK_REQUIRED' });
  const m = nativeManager(f, runtime, { activeOperation: randomUUID() });
  assert.throws(() => m.manager.recoverExecutor(m.body(), context), { code: 'RESULT_UNKNOWN' });
  let state=JSON.parse(fs.readFileSync(f.state)); state.workerPid=process.pid; fs.writeFileSync(f.state,JSON.stringify(state));
  await assert.rejects(runtime.recoverExecutor(ownerRecovery), { code: 'BUSY' });
  state.workerPid=null;state.creatingPage=true;fs.writeFileSync(f.state,JSON.stringify(state));
  await assert.rejects(runtime.recoverExecutor(ownerRecovery), { code: 'CLEANUP_UNCONFIRMED' });
  assert.equal(fake.children.length,count);
});

test('unclosed owned feed or missing owned identity refuses recovery without closing or adopting tabs', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
  await runtime.run("await browser.openOrReuseTab('https://www.douyin.com/?recommend=1');const result={};",context);
  await makeUnknown(f,runtime);const count=fake.events.length;
  await assert.rejects(runtime.recoverExecutor(ownerRecovery), { code:'CLEANUP_UNCONFIRMED' });
  assert.equal(fake.events.length,count);assert(fake.pages.has('p2'));
  fake.pages.delete('p2');fake.pages.get('p1').openedBy='unknown';
  await assert.rejects(runtime.recoverExecutor(ownerRecovery), { code:'CLEANUP_UNCONFIRMED' });
});

test('unimplemented native owner login cannot mutate a bound account or launch a process', async t => {
  const f=fixture(t),fake=fakeNative(f),runtime=make(f,fake),m=nativeManager(f,runtime);
  const before=fs.readFileSync(m.file,'utf8');
  await assert.rejects(m.manager.startLogin({platform:'douyin',requestId:randomUUID(),revision:m.manager.snapshot().revision},context),{code:'OPERATION_UNAVAILABLE'});
  await assert.rejects(m.manager.checkLogin({platform:'douyin',sessionId:randomUUID()},context),{code:'OPERATION_UNAVAILABLE'});
  assert.equal(fs.readFileSync(m.file,'utf8'),before);assert.equal(fake.children.length,0);
  assert.equal(m.manager.snapshot().platforms.find(p=>p.platform==='douyin').loginAvailable,false);
});


test('a store transaction failure after private commit restores unknown instead of releasing occupancy', async t => {
  const f=fixture(t),fake=fakeNative(f),runtime=make(f,fake);const before=await makeUnknown(f,runtime),m=nativeManager(f,runtime);
  const transact=m.manager.store.transact.bind(m.manager.store);
  m.manager.store.transact=(change,options)=>transact(state=>{change(state);throw Object.assign(new Error('fixed fixture conflict'),{code:'CONFLICT'});},options);
  await assert.rejects(m.manager.recoverExecutor(m.body(),context),{code:'CONFLICT'});
  assert.equal(fs.readFileSync(f.state,'utf8'),before);assert.equal(runtime.cleanupPending,true);
  assert.equal(JSON.parse(fs.readFileSync(f.state)).unknown,true);
  assert.equal(fs.readdirSync(path.join(f.directory,'native-recovery-proofs')).length,1,'immutable review evidence remains');
});

test('non-native stale lease recovery remains synchronous even with no installed driver',t=>{
  const f=fixture(t),manager=new SocialAccounts({directory:f.root});
  const result=manager.recoverExecutor({platform:'x',revision:manager.snapshot().revision,executionStopped:true,resultReviewed:true},context);
  assert.equal(typeof result?.then,'undefined');assert(result.accounts);
});


test('reloaded unknown needs owner ACK and a live recovery maintenance PID cannot be replaced',async t=>{
  const f=fixture(t),fake=fakeNative(f),runtime=make(f,fake);const before=await makeUnknown(f,runtime);
  const reloaded=make(f,fakeNative(f)),m=nativeManager(f,reloaded);
  const lock=path.join(f.directory,'.recovery-lock'),bytes=JSON.stringify({token:randomUUID(),pid:process.pid});fs.writeFileSync(lock,bytes,{mode:0o600});
  await assert.rejects(m.manager.recoverExecutor(m.body(),context),{code:'BUSY'});
  assert.equal(fs.readFileSync(lock,'utf8'),bytes);assert.equal(fs.readFileSync(f.state,'utf8'),before);
  fs.unlinkSync(lock);
  const result=await m.manager.recoverExecutor(m.body(),context);
  assert.equal(result.recovered,true);assert.equal(JSON.parse(fs.readFileSync(f.state)).unknown,false);
});


test('native readiness starts unverified and metadata checks never access a platform Page', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake);
  assert.equal(runtime.available, true); assert.equal(runtime.nativeReady, false);
  assert.equal(runtime.status().readiness, 'not-checked'); assert.equal(fake.children.length, 0);
  const result = await runtime.checkMetadata(context);
  assert.equal(result.ready, true); assert.equal(runtime.nativeReady, true);
  assert.equal(fake.events.length, 0, 'no evaluate, goto, click, newPage, close or media call');
  assert.equal(fs.existsSync(f.state), false, 'metadata verification never writes the owned journal');
  assert.equal(fake.taskCalls, 1); assert.equal(fake.newPages, 0);
  assert(!JSON.stringify(result).includes(binding.spaceName));
});

test('missing or changed native ownership is a failed metadata proof, never a new login or binding', async t => {
  for (const options of [{ missingSpace: true }, { ownership: 'user' }, { name: 'changed-space' }]) {
    const f = fixture(t), fake = fakeNative(f, options), runtime = make(f, fake);
    const bytes = fs.readFileSync(f.file, 'utf8');
    const result = await runtime.checkMetadata(context);
    assert.equal(result.ready, false); assert.equal(result.state, 'unconfirmed'); assert.equal(runtime.nativeReady, false);
    assert.equal(fake.taskCalls, 0); assert.equal(fake.newPages, 0); assert.equal(fake.events.length, 0);
    assert.equal(fs.readFileSync(f.file, 'utf8'), bytes); assert.equal(fs.existsSync(f.state), false);
  }
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake); fake.pages.get('p1').openedBy = 'unknown';
  assert.equal((await runtime.checkMetadata(context)).reason, 'identity-page-unavailable');
  assert.equal(fake.events.length, 0);
});

test('metadata evidence expires, rejects clock rollback and is not reused after binding, CLI or runtime changes', async t => {
  let now = 1700000000000, pin = true;
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake, { now: () => now, verifyCli: () => pin, metadataTtlMs: 1000 });
  await runtime.checkMetadata(context); now += 1000;
  assert.equal(runtime.nativeReady, false); assert.equal(runtime.status().readiness, 'expired');
  now -= 1001; assert.equal(runtime.nativeReady, false);
  now += 2; await runtime.checkMetadata(context); pin = false; assert.equal(runtime.nativeReady, false);
  pin = true; f.write({ ...binding, spaceId: 15 }); assert.equal(runtime.nativeReady, false);
  assert.equal(make(f, fake).nativeReady, false);
  assert.equal(fake.children.length, 2, 'status queries never launch another check');
});

test('metadata check rejects authority, binding, state, CLI and store changes during its await', async t => {
  for (const kind of ['owner', 'binding', 'state', 'cli', 'store']) {
    let allowed = true, pin = true, current = true;
    const f = fixture(t), options = {}, fake = fakeNative(f, options), runtime = make(f, fake, { verifyCli: () => pin });
    options.beforeClose = () => {
      if (kind === 'owner') allowed = false;
      if (kind === 'binding') f.write({ ...binding, spaceId: 15 });
      if (kind === 'state') fs.writeFileSync(f.state, '{}', { mode: 0o600 });
      if (kind === 'cli') pin = false;
      if (kind === 'store') current = false;
    };
    await assert.rejects(runtime.checkMetadata({ authorize: () => allowed, isCurrent: () => current }));
    assert.equal(runtime.nativeReady, false); assert.equal(fake.events.length, 0);
  }
});

test('metadata checking is exclusive and abort closes its own child without platform effects', async t => {
  const f = fixture(t), fake = fakeNative(f, { hang: true, closeOnKill: true }), runtime = make(f, fake);
  const controller = new AbortController(), pending = runtime.checkMetadata({ ...context, signal: controller.signal });
  await assert.rejects(runtime.checkMetadata(context), { code: 'BUSY' });
  await assert.rejects(runtime.run('const result={};', context), { code: 'DRIVER_UNAVAILABLE' });
  controller.abort(); await assert.rejects(pending);
  assert.deepEqual(fake.children[0].signals, ['SIGTERM']); assert.equal(runtime.children.size, 0);
  assert.equal(runtime.nativeReady, false); assert.equal(fake.events.length, 0); assert.equal(fs.existsSync(f.state), false);
});

test('GET account status distinguishes configuration and current metadata without launching any process', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake), m = nativeManager(f, runtime, { safetyPause: null });
  const before = fs.readFileSync(m.file, 'utf8');
  let value = await socialAccountRoute('social/accounts', m.manager, {}, context);
  let row = value.accounts.platforms.find(row => row.platform === 'douyin');
  assert.equal(row.driverConfigured, true); assert.equal(row.driverAvailable, false); assert.equal(row.browser.state, 'not-checked');
  assert.equal(fake.children.length, 0); assert.equal(fs.readFileSync(m.file, 'utf8'), before);
  value = await socialAccountRoute('social/check-browser', m.manager, { platform: 'douyin', revision: m.manager.snapshot().revision }, context);
  assert.equal(value.browser.ready, true); assert.equal(fake.children.length, 1);
  row = (await socialAccountRoute('social/accounts', m.manager, {}, context)).accounts.platforms.find(row => row.platform === 'douyin');
  assert.equal(row.driverAvailable, true); assert.equal(fake.children.length, 1);
  assert.equal(fs.readFileSync(m.file, 'utf8'), before); assert.equal(fake.events.length, 0);
  await assert.rejects(socialAccountRoute('social/check-browser', m.manager, { platform: 'x', revision: m.manager.snapshot().revision }, context), { code: 'INVALID_REQUEST' });
});

test('business success updates metadata evidence while failed ownership invalidates it; stop remains allowed', async t => {
  const f = fixture(t), options = {}, fake = fakeNative(f, options), runtime = make(f, fake);
  await runtime.run('const result={ok:true};', context); assert.equal(runtime.nativeReady, true);
  options.missingSpace = true;
  await assert.rejects(runtime.run('const result={ok:true};', context), { code: 'BINDINGS_REQUIRED' });
  assert.equal(runtime.nativeReady, false);
  options.missingSpace = false;
  assert.equal((await runtime.stop(context)).stopped, true); assert.equal(runtime.nativeReady, true);
});


test('browse cooldown snapshot projects the persisted read gap and hour ceiling without consuming requests', t => {
  const f = fixture(t); let now = 1700000000000;
  const manager = new SocialAccounts({ directory: f.root, now: () => now });
  const write = requestHistory => manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: 'fixture', generation: 1, requestHistory }; }, { authorize: () => true });
  const remaining = () => manager.snapshot().platforms.find(row => row.platform === 'douyin').browse.cooldownRemainingMs;
  write([]); assert.equal(remaining(), 0);
  write([{ kind: 'read', at: now - 1000 }]); const bytes = fs.readFileSync(path.join(f.root, 'accounts.json'), 'utf8');
  assert.equal(remaining(), 14000); assert.equal(fs.readFileSync(path.join(f.root, 'accounts.json'), 'utf8'), bytes);
  now += 14000; assert.equal(remaining(), 0);
  const start = now;
  write(Array.from({ length: 60 }, (_, index) => ({ kind: 'read', at: start - 1800000 + index * 15000 })));
  assert.equal(remaining(), 1800000); now += 1800000; assert.equal(remaining(), 0);
  write([{ kind: 'read', at: now + 60001 }]); assert.equal(remaining(), null);
});


test('browse status is a pure local projection and durable owned pages prevent a reloaded driver claiming stopped', async t => {
  const f = fixture(t), fake = fakeNative(f), runtime = make(f, fake), manager = nativeManager(f, runtime, { safetyPause: null });
  const status = () => manager.manager.snapshot().platforms.find(row => row.platform === 'douyin').browse.state;
  assert.equal(status(), 'stopped'); assert.equal(fake.children.length, 0); assert.equal(fs.existsSync(f.state), false);
  await runtime.run("await browser.openOrReuseTab('https://www.douyin.com/?recommend=1');const result={ok:true};", context);
  assert.equal(status(), 'active');
  const fresh = make(f, fake), freshDriver = new BrowserAccountDriver({ key: 'douyin', directory: f.directory, runtime: fresh });
  assert.equal(freshDriver.browseState, 'stopped', 'ephemeral driver starts with no observation');
  assert.equal(freshDriver.browseStatus().state, 'active', 'persistent page journal prevents takeover across reload');
  const count = fake.children.length, bytes = fs.readFileSync(f.state, 'utf8');
  assert.equal(freshDriver.browseStatus().state, 'active'); assert.equal(fake.children.length, count); assert.equal(fs.readFileSync(f.state, 'utf8'), bytes);
  await fresh.stop(context); assert.equal(freshDriver.browseStatus().state, 'stopped');
  await assert.rejects(fresh.run("throw new TypeError('fixture');const result={};", context));
  assert.equal(freshDriver.browseStatus().state, 'unknown');
});


test('autonomous browse expectations and dispatch callback are checked inside the account lock before pacing or driver access', async t => {
  const f = fixture(t); let calls = 0, dispatches = 0, state = 'stopped', now = 1700000000000;
  const driver = { browseStatus: () => ({ state }), async browse(input) { calls++; state = input.action === 'stop' ? 'stopped' : 'active'; return { ok: true, accountId: 'same-account', state, current: null }; } };
  const manager = new SocialAccounts({ directory: f.root, drivers: { douyin: driver }, now: () => now });
  manager.store.transact(store => { store.accounts.douyin = { state: 'bound', accountId: 'same-account', generation: 3 }; }, context);
  const own = { ...context, autonomousExpectation: { accountId: 'same-account', generation: 3, initiallyStopped: true }, onBrowseDispatch() { dispatches++; } };
  const before = fs.readFileSync(path.join(f.root, 'accounts.json'), 'utf8');
  for (const patch of [{ accountId: 'other' }, { generation: 2 }]) {
    await assert.rejects(manager.browse('douyin', { action: 'open' }, { ...own, autonomousExpectation: { ...own.autonomousExpectation, ...patch } }), { code: 'AUTONOMY_PRECONDITION' });
  }
  state = 'active'; await assert.rejects(manager.browse('douyin', { action: 'open' }, own), { code: 'AUTONOMY_PRECONDITION' });
  assert.equal(dispatches, 0); assert.equal(calls, 0); assert.equal(fs.readFileSync(path.join(f.root, 'accounts.json'), 'utf8'), before);
  state = 'stopped'; await manager.browse('douyin', { action: 'open' }, own); assert.equal(calls, 1); assert.equal(dispatches, 1);
  await assert.rejects(manager.browse('douyin', { action: 'current' }, { ...own, autonomousExpectation: { ...own.autonomousExpectation, initiallyStopped: false } }), { code: 'COOLDOWN' });
  assert.equal(calls, 1); assert.equal(dispatches, 1);
  await assert.rejects(manager.browse('douyin', { action: 'stop' }, { ...own, autonomousExpectation: { ...own.autonomousExpectation, generation: 2 } }), { code: 'AUTONOMY_PRECONDITION' });
  assert.equal(calls, 1);
  await manager.browse('douyin', { action: 'stop' }, own); assert.equal(calls, 2); assert.equal(dispatches, 1);
});
