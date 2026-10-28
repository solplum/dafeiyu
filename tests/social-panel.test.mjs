import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { SocialPanel } from '../packages/dsh-dafeiyu/src/social-panel.js';
import { registerConfigPanel } from '../packages/dsh-dafeiyu/src/config-panel.js';

const ID = '12345678-1234-4234-8234-123456789abc';
const ID2 = '12345678-1234-4234-8234-123456789abd';
const PRIVATE = 'PRIVATE_SERVICE_TRACE /Users/private/credential';
const request = (requestId = ID) => ({ platform: 'bilibili', requestId });
const receipt = () => ({ ok: true, bvid: 'BV1ab411c7de', title: '公开测试视频', url: 'https://www.bilibili.com/video/BV1ab411c7de', kind: 'subtitle', note: '已读取公开字幕' });

function fixture() {
  let authorized = true, busy = false, probe, calls = 0;
  const browser = { enabled: true, configured: true, status: { enabled: true, configured: true, readiness: 'not-verified', lastCheck: null, lastResult: null },
    async probe(options) { calls++; return probe ? probe(options) : receipt(); } };
  let runtime = { biliBrowser: browser };
  const panel = new SocialPanel({ getRuntime: () => runtime, getBusy: () => busy });
  return { panel, browser, options: { authorize: () => authorized },
    get calls() { return calls; }, get runtime() { return runtime; },
    setProbe(value) { probe = value; }, authorize(value) { authorized = value; }, busy(value) { busy = value; }, runtimeAs(value) { runtime = value; } };
}

test('social snapshot is passive and distinguishes component/account/publication readiness', () => {
  const f = fixture(); const snapshot = f.panel.snapshot();
  assert.equal(f.calls, 0); assert.equal(snapshot.bilibili.browse.configured, true); assert.equal(snapshot.bilibili.browse.readiness, 'not-verified');
  assert.equal(snapshot.bilibili.account.configured, false); assert.equal(snapshot.douyin.account.configured, false);
  assert.equal(snapshot.bilibili.publication.state, 'prepared-not-connected'); assert.equal(snapshot.busy, false);
  f.runtimeAs(null); assert.equal(f.panel.snapshot().bilibili.browse.configured, false); assert.equal(f.calls, 0);
});

test('social check explicitly probes once and repeated UUID only returns its original result', async () => {
  const f = fixture();
  const first = await f.panel.check(request(), f.options); const second = await f.panel.check(request(), f.options);
  assert.deepEqual(second, first); assert.equal(f.calls, 1); assert.equal(first.test.bvid, 'BV1ab411c7de'); assert.equal(first.social.busy, false);
  await f.panel.check(request(ID2), f.options); assert.equal(f.calls, 2);
});

test('concurrent checks lock same and different UUID before dispatch and expose busy', async () => {
  const f = fixture(); let release, started;
  const ready = new Promise((resolve) => { started = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  f.setProbe(async () => { started(); await gate; return receipt(); });
  const pending = f.panel.check(request(), f.options); await ready; assert.equal(f.panel.snapshot().busy, true);
  await assert.rejects(f.panel.check(request(), f.options), (error) => error.code === 'BUSY');
  await assert.rejects(f.panel.check(request(ID2), f.options), (error) => error.code === 'BUSY');
  assert.equal(f.calls, 1); release(); await pending; assert.equal(f.panel.snapshot().busy, false);
});

test('authority, application work and missing components block before probing', async () => {
  const f = fixture();
  await assert.rejects(f.panel.check(request()), (error) => error.code === 'FORBIDDEN');
  f.busy(true); await assert.rejects(f.panel.check(request(), f.options), (error) => error.code === 'BUSY');
  f.busy(false); f.browser.enabled = false; await assert.rejects(f.panel.check(request(), f.options), (error) => error.code === 'UNAVAILABLE');
  f.browser.enabled = true; f.browser.configured = false; await assert.rejects(f.panel.check(request(), f.options), (error) => error.code === 'UNAVAILABLE');
  assert.equal(f.calls, 0);
});

for (const body of [null, [], {}, { platform: 'unsupported', requestId: ID }, { platform: 'bilibili', requestId: 'bad' }, { ...request(), command: PRIVATE }]) {
  test('invalid social check schema is rejected without a probe: ' + JSON.stringify(body), async () => {
    const f = fixture(); await assert.rejects(f.panel.check(body, f.options), (error) => error.code === 'INVALID_PATCH'); assert.equal(f.calls, 0);
  });
}

test('Douyin owner-panel check uses only the injected real-agent probe and retains login limitations', async () => {
  const f = fixture(); let calls = 0;
  const runtime = { biliBrowser: f.browser, douyinBrowser: { enabled: true, configured: true, status: { readiness: 'not-verified' } } };
  f.runtimeAs(runtime);
  f.panel.probeDouyin = async (options) => { calls++; assert.equal(options.runtime, runtime); assert.equal(options.authorize(), true);
    return { ok: false, state: 'needs-login', note: '需要登录独立账号' }; };
  const result = await f.panel.check({ platform: 'douyin', requestId: ID }, f.options);
  assert.equal(result.test.ok, false); assert.equal(result.test.state, 'needs-login'); assert.equal(calls, 1); assert.equal(f.calls, 0);
  await f.panel.check({ platform: 'douyin', requestId: ID }, f.options); assert.equal(calls, 1);
  await assert.rejects(f.panel.check(request(), f.options), error => error.code === 'CONFLICT');
});

test('Douyin without a trusted owner-panel probe cannot run or fabricate an Agent', async () => {
  const f = fixture(); f.runtimeAs({ douyinBrowser: { enabled: true, configured: true } });
  await assert.rejects(f.panel.check({ platform: 'douyin', requestId: ID }, f.options), error => error.code === 'UNAVAILABLE');
  assert.equal(f.calls, 0); assert.equal(f.panel.checking, false);
});

for (const reason of ['owner revoked', 'runtime changed']) test('social check suppresses results after asynchronous ' + reason, async () => {
  const f = fixture(); let release, started, authorization;
  const ready = new Promise((resolve) => { started = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  f.setProbe(async (options) => { authorization = options.authorize; started(); await gate; return receipt(); });
  const pending = f.panel.check(request(), f.options); await ready;
  if (reason === 'owner revoked') f.authorize(false); else f.runtimeAs({ biliBrowser: f.browser });
  assert.equal(authorization(), false); release(); await assert.rejects(pending, (error) => error.code === 'FORBIDDEN');
  assert.equal(f.panel.checking, false); assert.equal(f.calls, 1);
});

test('revoked owner cannot retrieve a cached successful result', async () => {
  const f = fixture(); await f.panel.check(request(), f.options); f.authorize(false);
  await assert.rejects(f.panel.check(request(), f.options), (error) => error.code === 'FORBIDDEN'); assert.equal(f.calls, 1);
});

test('UUID case variants deduplicate instead of starting another platform probe', async () => {
  const f = fixture(); await f.panel.check(request(), f.options);
  await f.panel.check(request(ID.toUpperCase()), f.options); assert.equal(f.calls, 1);
});

test('completed UUID cannot replay an old success after runtime replacement', async () => {
  const f = fixture(); await f.panel.check(request(), f.options); f.runtimeAs({ biliBrowser: f.browser });
  await assert.rejects(f.panel.check(request(), f.options), (error) => ['CONFLICT', 'FORBIDDEN'].includes(error.code)); assert.equal(f.calls, 1);
});

test('a revoked in-flight UUID retains denial proof after authority returns', async () => {
  const f = fixture(); let release, started;
  const ready = new Promise((resolve) => { started = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  f.setProbe(async () => { started(); await gate; return receipt(); });
  const pending = f.panel.check(request(), f.options); await ready; f.authorize(false); release();
  await assert.rejects(pending, (error) => error.code === 'FORBIDDEN'); f.authorize(true);
  await assert.rejects(f.panel.check(request(), f.options), (error) => ['FORBIDDEN', 'CONFLICT'].includes(error.code)); assert.equal(f.calls, 1);
});

test('cancellation signal reaches the browser; cancelled UUID remains deduplicated and sanitized', async () => {
  const f = fixture(), controller = new AbortController(); let started;
  const ready = new Promise((resolve) => { started = resolve; });
  f.setProbe(async ({ signal }) => {
    assert.equal(signal, controller.signal); started();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(PRIVATE), { code: 'CANCELLED' })), { once: true }));
  });
  const pending = f.panel.check(request(), { ...f.options, signal: controller.signal }); await ready; controller.abort();
  const result = await pending; assert.equal(result.test.ok, false); assert.equal(result.test.code, 'CANCELLED');
  assert.equal(JSON.stringify(result).includes(PRIVATE), false); await f.panel.check(request(), f.options); assert.equal(f.calls, 1);
});

for (const code of ['TIMEOUT', 'CLEANUP_UNCONFIRMED', 'NO_RESULTS', 'NO_CONTENT', 'UNAVAILABLE', 'SECRET_CUSTOM_CODE']) {
  test('social service error ' + code + ' is bounded, sanitized and never retried automatically', async () => {
    const f = fixture(); f.setProbe(async () => { throw Object.assign(new Error(PRIVATE), { code }); });
    const result = await f.panel.check(request(), f.options);
    assert.equal(result.test.ok, false); assert.equal(result.test.code, code === 'SECRET_CUSTOM_CODE' ? 'READ_FAILED' : code);
    assert.equal(JSON.stringify(result).includes(PRIVATE), false); assert.equal(f.calls, 1);
    await f.panel.check(request(), f.options); assert.equal(f.calls, 1);
  });
}

// Register the actual native HTTP handlers with the real SocialPanel. No host,
// browser, media process, configuration file or account is touched.
function routeFixture(t) {
  const f = fixture(), routes = new Map(), effects = [];
  const peerController = new AbortController();
  let peer = { principal: { kind: 'owner' }, signal: peerController.signal };
  const connection = { admit: () => ({ peer }) };
  const controller = { social: f.panel, getRuntime: () => f.runtime };
  const ctx = { inject(_names, callback) {
    callback({ get: (name) => ({ connection, webServer: { register(definition) { routes.set(definition.path, definition.handler); return () => routes.delete(definition.path); } } })[name],
      effect(effect) { const dispose = effect(); if (typeof dispose === 'function') effects.push(dispose); } });
    return { dispose() { for (const effect of effects.splice(0).reverse()) effect(); } };
  } };
  const registration = registerConfigPanel(ctx, controller); t.after(() => registration.dispose());
  function call(endpoint, { method = 'GET', body, chunks } = {}) {
    const req = Readable.from(chunks || (body ? [JSON.stringify(body)] : [])); req.method = method; req.url = '/dafeiyu-panel/api/' + endpoint;
    req.headers = { 'content-type': 'application/json' };
    return new Promise((resolve, reject) => {
      const res = { writeHead(status) { this.status = status; }, end(value) { try { resolve({ status: this.status, body: JSON.parse(value) }); } catch (error) { reject(error); } } };
      routes.get(req.url)(req, res);
    });
  }
  return { ...f, panel: f.panel, calls: () => f.calls, call, setPeer(value) { peer = value; }, abortOwner() { peerController.abort(); } };
}

test('native social GET stays passive and owner-only; explicit duplicate POST probes only once', async (t) => {
  const f = routeFixture(t);
  const status = await f.call('social/status'); assert.equal(status.status, 200); assert.equal(f.calls(), 0);
  const first = await f.call('social/check', { method: 'POST', body: request() }); assert.equal(first.status, 200); assert.equal(first.body.test.ok, true);
  const second = await f.call('social/check', { method: 'POST', body: request() }); assert.deepEqual(second.body, first.body); assert.equal(f.calls(), 1);
  f.setPeer({ principal: { kind: 'guest' } }); assert.equal((await f.call('social/status')).status, 403); assert.equal(f.calls(), 1);
});

for (const reason of ['owner revoked', 'runtime replaced']) test('native social route rechecks ' + reason + ' after slow request body', async (t) => {
  const f = routeFixture(t);
  async function* chunks() {
    yield '{"platform":"bilibili",';
    if (reason === 'owner revoked') f.setPeer({ principal: { kind: 'guest' } }); else f.runtimeAs({ biliBrowser: f.browser });
    yield '"requestId":"' + ID + '"}';
  }
  const response = await f.call('social/check', { method: 'POST', chunks: chunks() });
  assert.equal(response.status, reason === 'owner revoked' ? 403 : 409); assert.equal(f.calls(), 0); assert.equal(response.body.test, undefined);
});

test('native social route suppresses a late result after owner revocation', async (t) => {
  const f = routeFixture(t); let release, started;
  const ready = new Promise((resolve) => { started = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  f.setProbe(async () => { started(); await gate; return receipt(); });
  const pending = f.call('social/check', { method: 'POST', body: request() }); await ready; f.setPeer({ principal: { kind: 'guest' } }); release();
  const response = await pending; assert.equal(response.status, 403); assert.equal(response.body.test, undefined); assert.equal(f.calls(), 1);
});

test('native social route forwards live owner cancellation to the active browser read', async (t) => {
  const f = routeFixture(t); let started, receivedSignal;
  const ready = new Promise((resolve) => { started = resolve; }); t.after(() => f.abortOwner());
  f.setProbe(async ({ signal }) => {
    receivedSignal = signal; started(); if (!signal) throw new Error('MISSING_OWNER_SIGNAL');
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(PRIVATE), { code: 'CANCELLED' })), { once: true }));
  });
  const pending = f.call('social/check', { method: 'POST', body: request() }); await ready; assert.ok(receivedSignal);
  f.abortOwner(); const response = await pending; assert.equal(receivedSignal.aborted, true); assert.equal(response.status, 403);
  assert.equal(response.body.test, undefined); assert.equal(f.calls(), 1); assert.equal(JSON.stringify(response).includes(PRIVATE), false);
});
