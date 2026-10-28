import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { digest } from '../packages/dsh-dafeiyu/src/social/account-store.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BilibiliAccountDriver } from '../packages/dsh-dafeiyu/src/social/bilibili-account.mjs';
import { EgoAccountRuntime } from '../packages/dsh-dafeiyu/src/social/ego-account-runtime.mjs';
import { BrowserAccountDriver } from '../packages/dsh-dafeiyu/src/social/browser-account.mjs';
import { requestReceipt } from '../packages/dsh-dafeiyu/src/social/request-receipt.mjs';
const yes = () => true, context = { authorize: yes };
const wait = () => new Promise(resolve => setImmediate(resolve));
function childFixture() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; }; return child;
}
function workerFixture(t, onCall) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-bili-driver-')), child = childFixture();
  const python = path.join(dir, 'python-placeholder'); fs.writeFileSync(python, ''); let invocation;
  child.stdin.on('data', bytes => { const call = JSON.parse(bytes.toString()); onCall?.(call, child); });
  const driver = new BilibiliAccountDriver({ directory: path.join(dir, 'private'), python, stopGraceMs: 15,
    spawnWorker(...args) { invocation = args; return child; } });
  t.after(async () => { child.emit('close', 0); await driver.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, driver, child, get invocation() { return invocation; } };
}

test('Bili protocol uses a separate private directory and hides worker output; no process for status', async t => {
  const f = workerFixture(t, (call, child) => setImmediate(() => {
    child.stderr.write('PRIVATE_COOKIE_MUST_NOT_RETURN');
    child.stdout.write(JSON.stringify({ id: call.id, ok: true, sdkVersion: '17.4.2', result: { loggedIn: false } }) + '\n');
  }));
  assert.equal(f.invocation, undefined); assert.equal(f.driver.idle, true); f.driver.capabilities(); assert.equal(f.invocation, undefined);
  assert.deepEqual(await f.driver.account(context), { loggedIn: false });
  assert.equal(f.invocation[2].shell, false); assert.equal(f.invocation[2].env.TMPDIR, path.join(f.dir, 'private'));
  assert.equal(f.invocation[1][0], '-I'); assert(!JSON.stringify(f.invocation).includes('SESSDATA'));
  assert.equal(fs.statSync(path.join(f.dir, 'private')).mode & 0o777, 0o700);
});

test('Bili receipt from a mismatched SDK is rejected', async t => {
  const f = workerFixture(t, (call, child) => setImmediate(() => child.stdout.write(JSON.stringify({ id: call.id, ok: true, sdkVersion: '0.0', result: { ok: true } }) + '\n')));
  await assert.rejects(f.driver.account(context), { code: 'SDK_VERSION_MISMATCH' });
});

test('Bili cancel waits for actual close and escalates only its owned worker; unconfirmed cleanup stays busy', async t => {
  const f = workerFixture(t); const abort = new AbortController();
  const pending = f.driver.account({ authorize: yes, signal: abort.signal }); abort.abort();
  assert.equal(f.driver.idle, false); assert.deepEqual(f.child.signals, ['SIGTERM']);
  await assert.rejects(pending, { code: 'WORKER_UNKNOWN' });
  assert(f.child.signals.includes('SIGKILL')); assert.equal(f.driver.idle, false);
  await assert.rejects(f.driver.account(context), { code: 'DRIVER_UNAVAILABLE' });
  f.child.emit('close', null); assert.equal(f.driver.idle, true);
});

test('Bili malformed output stops its own worker without surfacing logs', async t => {
  const f = workerFixture(t, (_call, child) => setImmediate(() => { child.stdout.write('SECRET INVALID LINE\n'); setImmediate(() => child.emit('close', 1)); }));
  await assert.rejects(f.driver.account(context), error => error.code === 'WORKER_UNKNOWN' && !error.message.includes('SECRET'));
  assert.deepEqual(f.child.signals, ['SIGTERM']);
});

test('Bili reply and video validation stop incomplete metadata before any worker starts', async t => {
  const f = workerFixture(t);
  await assert.rejects(f.driver.preflight({ operation: 'reply', parentId: '44' }), { code: 'INVALID_TARGET' });
  await assert.rejects(f.driver.preflight({ operation: 'video', declaration: 'ai-generated' }), { code: 'VIDEO_METADATA_REQUIRED' });
  await f.driver.preflight({ operation: 'reply', rootId: '33', parentId: '44' }); assert.equal(f.invocation, undefined);
});

function captureFixture(encoding = 'json') {
  const url = 'https://x.com/test-owned-mutation', key = '__dfy_receipt_fixture'; let calls = 0;
  class Xhr extends EventEmitter { open() {} send() { calls++; } addEventListener(name, cb) { this.once(name, cb); } }
  const original = async () => { calls++; return new Response(JSON.stringify({ id: 'receipt', author: 'own' }), { status: 200 }); };
  // A response URL is metadata from the original platform response, never a new fetch.
  const fetch = async (...args) => { const response = await original(...args); Object.defineProperty(response, 'url', { value: url }); return response; };
  const sandbox = { location: { href: 'https://x.com/home' }, XMLHttpRequest: Xhr, fetch, Request, Response, URL, URLSearchParams, FormData, TextDecoder };
  sandbox.window = sandbox; vm.createContext(sandbox);
  const capture = requestReceipt(url, key, { method: 'POST', encoding, fields: { target: ['to'], text: ['content'] } }, { target: 'exact-target', text: 'exact-content' });
  vm.runInContext(capture.install, sandbox);
  return { url, key, sandbox, capture, original: fetch, get calls() { return calls; } };
}

test('actual fetch target/content are checked before dispatch; same request cannot repeat; hooks restore', async () => {
  const f = captureFixture();
  await assert.rejects(f.sandbox.fetch(f.url, { method: 'POST', body: JSON.stringify({ to: 'wrong', content: 'exact-content' }) }), /REQUEST_DRAFT_MISMATCH/); assert.equal(f.calls, 0);
  await assert.rejects(f.sandbox.fetch('https://x.com/wrong-action', { method: 'POST', body: '{}' }), /UNREVIEWED_MUTATION_BLOCKED/); assert.equal(f.calls, 0);
  await assert.rejects(f.sandbox.fetch(f.url, { method: 'GET', body: '{}' }), /WRONG_REQUEST_METHOD/); assert.equal(f.calls, 0);
  await f.sandbox.fetch(f.url, { method: 'POST', body: JSON.stringify({ to: 'exact-target', content: 'exact-content' }) });
  await wait(); await wait();
  const receipt = vm.runInContext(f.capture.read, f.sandbox); assert.equal(receipt.done, true); assert.equal(receipt.payload.id, 'receipt'); assert.equal(f.calls, 1);
  await assert.rejects(f.sandbox.fetch(f.url, { method: 'POST', body: JSON.stringify({ to: 'exact-target', content: 'exact-content' }) }), /DUPLICATE_REQUEST_BLOCKED/); assert.equal(f.calls, 1);
  vm.runInContext(f.capture.cleanup, f.sandbox); assert.equal(f.sandbox.fetch, f.original); assert.equal(f.sandbox[f.key], undefined);
});

test('form and XHR prove exact values and refuse duplicate fields before a real send', () => {
  const f = captureFixture('form'), xhr = new f.sandbox.XMLHttpRequest(); xhr.open('POST', f.url);
  assert.throws(() => xhr.send('to=wrong&content=exact-content'), /REQUEST_DRAFT_MISMATCH/); assert.equal(f.calls, 0);
  assert.throws(() => xhr.send('to=exact-target&to=wrong&content=exact-content'), /AMBIGUOUS_REQUEST/); assert.equal(f.calls, 0);
  xhr.send('to=exact-target&content=exact-content'); assert.equal(f.calls, 1);
  vm.runInContext(f.capture.cleanup, f.sandbox);
});

test('unverified browser controls, missing request proof and browser video assets cannot send', async () => {
  let calls = 0; const runtime = { children: new Set(), run() { calls++; }, dispose() {} };
  const driver = new BrowserAccountDriver({ key: 'x', directory: '/unused', runtime, bindings: { platform: 'x', accountId: '@own', verified: true,
    writes: { message: { verified: true, url: 'https://x.com/messages', submit: '#send', submitText: '发送', text: '#text', response: { url: 'https://x.com/send', idPath: ['id'], authorPath: ['author'], okPath: ['ok'], okValue: true } } } } });
  await assert.rejects(driver.preflight({ operation: 'message', target: '@someone', text: 'test' }), { code: 'BINDINGS_REQUIRED' }); assert.equal(calls, 0);
  await assert.rejects(driver.preflight({ operation: 'video' }), { code: 'BINDINGS_REQUIRED' }); assert.equal(calls, 0);
});

test('managed Ego runner uses muted private profiles and a unique precise sentinel', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-ego-driver-')), child = childFixture(); let invocation;
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  child.stdin.on('data', bytes => { const code = bytes.toString(), match = code.match(/console\.log\("(@@DFY_SOCIAL_[a-f0-9]+@@)"/); assert(match);
    setImmediate(() => { child.stderr.write(match[1] + '{"ok":true}\n'); child.emit('close', 0); }); });
  const runtime = new EgoAccountRuntime({ directory, runtime: { entry: '/fixed/ego-browser.mjs', chrome: '/fixed/chrome' }, spawnProcess(...args) { invocation = args; return child; } });
  assert.equal(await runtime.run('const result={ok:true};', context).then(v => v.ok), true);
  assert.equal(invocation[2].env.EGO_LINUX_EXTRA_ARGS, '--mute-audio'); assert.equal(invocation[2].env.EGO_LINUX_PROFILE, path.join(directory, 'profile'));
  assert.equal(invocation[2].shell, false); assert(!JSON.stringify(invocation).includes('--no-sandbox')); assert.equal(runtime.children.size, 0); await runtime.dispose();
});

test('Ego cancellation remains unconfirmed even after the script process closes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-ego-cancel-')), child = childFixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = new EgoAccountRuntime({ directory, runtime: { entry: '/fixed/ego', chrome: '/fixed/chrome' }, spawnProcess: () => child });
  const controller = new AbortController(); const pending = runtime.run('const result={ok:true};', { authorize: yes, signal: controller.signal });
  controller.abort(); child.emit('close', null); await assert.rejects(pending, { code: 'BROWSER_UNKNOWN' });
  assert.equal(runtime.cleanupPending, true); assert.equal(runtime.children.size, 0); assert.equal(runtime.available, false); await runtime.dispose();
});

test('Ego stop exit code alone is insufficient: remember exact browser PID until it actually exits', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-ego-stop-')); let live = true, calls = 0;
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateDir = path.join(directory, 'browser-state/ego-lite-linux'); fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'browser.json'); fs.writeFileSync(stateFile, JSON.stringify({ pid: 1234567 }));
  const runtime = new EgoAccountRuntime({ directory, runtime: { entry: '/fixed/ego', chrome: '/fixed/chrome' }, stopWaitMs: 5,
    probeBrowser: async pid => { assert.equal(pid, 1234567); return live; }, findBrowsers: async () => live ? [1234567] : [],
    spawnProcess(_exe, args) { assert.equal(args[1], '--stop'); calls++; const child = childFixture(); setImmediate(() => { fs.rmSync(stateFile, { force: true }); child.emit('close', 0); }); return child; } });
  await assert.rejects(runtime.stop(context), { code: 'CLEANUP_UNCONFIRMED' }); assert.equal(runtime.cleanupPending, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'browser-cleanup.private.json'))).pid, 1234567);
  live = false; await runtime.stop(context); assert.equal(runtime.cleanupPending, false); assert.equal(calls, 2);
  assert.equal(fs.existsSync(path.join(directory, 'browser-cleanup.private.json')), false); await runtime.dispose();
});

test('Ego refuses to stop an untracked residual browser or a second profile process', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-ego-residual-')); let spawned = false;
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = new EgoAccountRuntime({ directory, runtime: { entry: '/fixed/ego', chrome: '/fixed/chrome' },
    findBrowsers: async () => [1234567], spawnProcess() { spawned = true; throw Error('must not spawn'); } });
  await assert.rejects(runtime.stop(context), { code: 'CLEANUP_UNCONFIRMED' }); assert.equal(spawned, false); assert.equal(runtime.cleanupPending, true);
});

test('generated browser script verifies editor/account, guards actual outgoing request, captures receipt and never repeats a claimed operation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-browser-recipe-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const endpoint = 'https://x.com/exact-send'; let calls = 0, recipient = 'recipient-1', responseReady, userOwned = true, handoffs = 0;
  const editor = { value: '' }, button = { tagName: 'BUTTON', disabled: false, innerText: 'Send' };
  const identity = { getBoundingClientRect: () => ({ width: 10, height: 10 }), getAttribute: name => name === 'href' ? '/own' : '', textContent: 'Own account' };
  const document = { querySelectorAll: selector => ({ '#editor': [editor], '#submit': [button], 'a[data-testid="AppTabBar_Profile_Link"]': [identity] })[selector] || [], addEventListener() {}, removeEventListener() {} };
  class Xhr { open() {} send() {} }
  const originalFetch = async () => { calls++; const response = new Response(JSON.stringify({ ok: true, id: 'receipt-17', author: '@own' })); Object.defineProperty(response, 'url', { value: endpoint }); return response; };
  const sandbox = { location: { href: 'https://x.com/home' }, document, fetch: originalFetch, XMLHttpRequest: Xhr, Request, Response, URL, URLSearchParams, FormData, TextDecoder }; sandbox.window = sandbox; vm.createContext(sandbox);
  const page = { url: async () => sandbox.location.href, goto: async url => { sandbox.location.href = url; },
    evaluate: async code => vm.runInContext(code, sandbox),
    waitForResponse: () => new Promise(resolve => responseReady = resolve),
    async waitForFunction(code) { for (let index = 0; index < 50; index++) { if (vm.runInContext(code, sandbox)) return true; await wait(); } throw Error('timeout'); },
    locator(selector) { return { async fill(text) { assert.equal(selector, '#editor'); editor.value = text; }, async click() {
      assert.equal(selector, '#submit'); await sandbox.fetch(endpoint, { method: 'POST', body: JSON.stringify({ to: recipient, content: editor.value }) });
      responseReady({ status: () => 200, url: () => endpoint });
    } }; } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runtime = { children: new Set(), cleanupPending: false, async run(body) {
    return new AsyncFunction('taskSpaces', 'browser', 'page', body + '\nreturn result;')({ list: async () => [{name:'dfy-social-x',id:17,ownership:userOwned?'user':'agent'}], claim: async () => {userOwned=false;}, handOff: async () => {userOwned=true;handoffs++;}, useOrCreate: async () => {if(userOwned)throw Error('HUMAN_CONTROL_ACTIVE');return {};} }, { ensureRealTab: async () => {} }, page);
  } };
  const driver = new BrowserAccountDriver({ key: 'x', directory, runtime, bindings: { platform: 'x', verified: true, accountId: '@own', writes: {
    message: { verified: true, url: 'https://x.com/messages/{target}', text: '#editor', submit: '#submit', submitText: 'Send',
      request: { method: 'POST', encoding: 'json', fields: { target: ['to'], text: ['content'] } },
      response: { url: endpoint, idPath: ['id'], okPath: ['ok'], okValue: true, authorPath: ['author'] } } } } });
  const login = await driver.checkLogin({ ...context, sessionId: randomUUID() }); assert.equal(login.accountId, '@own'); assert.equal(handoffs, 1); assert.equal(userOwned, true);
  await assert.rejects(driver.account(context), /HUMAN_CONTROL_ACTIVE/);
  await driver.account({ ...context, resume: true }); assert.equal(userOwned, false);
  const request = { operation: 'message', target: 'recipient-1', text: 'exact content' }, operationId = randomUUID();
  const envelope = { ...context, operationId, accountId: '@own', approvalDigest: 'a'.repeat(64), claimFile: path.join(directory, operationId + '.once') };
  const result = await driver.execute(request, envelope);
  assert.equal(calls, 1); assert.equal(result.id, 'receipt-17'); assert.equal(result.contentDigest, digest(request)); assert.equal(result.target, request.target);
  assert.equal(sandbox.fetch, originalFetch);
  await assert.rejects(driver.execute(request, envelope), { code: 'EEXIST' }); assert.equal(calls, 1);
  recipient = 'wrong-recipient'; const next = randomUUID();
  await assert.rejects(driver.execute(request, { ...envelope, operationId: next, claimFile: path.join(directory, next + '.once') }), /REQUEST_DRAFT_MISMATCH/);
  assert.equal(calls, 1); assert.equal(sandbox.fetch, originalFetch);
});
