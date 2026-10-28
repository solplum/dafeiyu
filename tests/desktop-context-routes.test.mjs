import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { ConfigurationPanelController, registerConfigPanel } from '../packages/dsh-dafeiyu/src/config-panel.js';

const PREFIX = '/dafeiyu-panel/api/desktop-context/';
const SECRET = 'CONTEXT_ROUTE_PRIVATE_CONFIG_AND_MESSAGE_MUST_NOT_ESCAPE';
const SESSION = '12345678-1234-4234-8234-123456789abc';
const PREVIEW = '12345678-1234-4234-8234-123456789def';
const previewBody = () => ({ sessionId: SESSION, maxTokens: 8192, expectedSeq: 7 });
const recoverBody = () => ({ sessionId: SESSION, previewId: PREVIEW, acknowledgeNoReplay: true });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };

// Mount the actual controller and registration code. Every service, transport
// and configuration snapshot is in memory; there is no model/browser/file IO.
function fixture(t) {
  let runtime, applying = false, maintenance = false, taskActive = 0, failure, gate;
  const owner = new AbortController(), entered = deferred(), routes = new Map(), effects = [], calls = [];
  let peer = { principal: { kind: 'owner' }, signal: owner.signal };
  const manager = {
    snapshot() { calls.push({ method: 'snapshot' }); return { ready: true, automaticReplay: false, sessions: [] }; },
    async preview(body, context) { return invokeManager('preview', body, context); },
    async recover(body, context) { return invokeManager('recover', body, context); },
  };
  async function invokeManager(method, body, context) {
    calls.push({ method, body, context }); entered.resolve(context);
    if (gate) await gate;
    if (failure) throw failure;
    return { ready: true, automaticReplay: false, method, previewId: PREVIEW, expectedSeq: 7 };
  }
  runtime = { desktopContext: manager, tokenAccounting: { get active() { return taskActive; } } };
  const controller = new ConfigurationPanelController({
    store: { snapshot: () => ({ revision: 'fixture-revision', effective: {}, saved: {}, validationErrors: [] }) },
    getRuntime: () => runtime, getAppliedRevision: () => 'fixture-revision', getApplying: () => applying,
    getMaintenanceBusy: () => maintenance, getRuntimeError: () => false, paths: () => ({}),
  });
  const ctx = { inject(names, callback) {
    assert.deepEqual(names, ['webServer', 'connection']);
    callback({ get(name) { return name === 'connection' ? { admit: () => ({ peer }) } : {
      register(row) { routes.set(row.path, row.handler); return () => routes.delete(row.path); },
    }; }, effect(install) { effects.push(install()); } });
    return { async dispose() { for (const cleanup of effects.splice(0)) await cleanup(); } };
  } };
  const registration = registerConfigPanel(ctx, controller); t.after(() => registration.dispose());
  function call(action, { method = action === 'status' ? 'GET' : 'POST', body, chunks, query = '' } = {}) {
    const handler = routes.get(PREFIX + action); assert.equal(typeof handler, 'function', 'route must be registered: ' + action);
    const req = Readable.from(chunks || (body === undefined ? [] : [JSON.stringify(body)]));
    req.method = method; req.url = PREFIX + action + query; req.headers = { 'content-type': 'application/json' };
    const res = new EventEmitter(); res.destroyed = false; res.writableEnded = false; res.status = null; res.writes = []; res.values = [];
    const response = deferred();
    res.writeHead = (status, headers) => { assert(!res.destroyed && !res.writableEnded, 'must not write a closed response'); res.status = status; res.writes.push({ status, headers }); };
    res.end = data => { assert(!res.destroyed && !res.writableEnded, 'must end only once'); const value = JSON.parse(String(data)); res.values.push(value); res.writableEnded = true; res.emit('finish'); res.emit('close'); response.resolve({ status: res.status, body: value, headers: res.writes.at(-1)?.headers }); };
    handler(req, res);
    return { req, res, done: response.promise };
  }
  return { call, calls, manager, owner, entered: entered.promise,
    setPeer(value) { peer = value; }, setRuntime(value) { runtime = value; },
    replaceManager(value) { runtime.desktopContext = value; }, setBusy(value) { taskActive = value ? 1 : 0; },
    applying(value) { applying = value; }, maintenance(value) { maintenance = value; },
    setGate(value) { gate = value; }, fail(error) { failure = error; },
  };
}

const clean = result => assert(!JSON.stringify(result).includes(SECRET), 'private service errors must not escape');

test('desktop context status is owner-only, read-only and rejects query parameters', async t => {
  const f = fixture(t), result = await f.call('status').done;
  assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.equal(result.body.desktopContext.automaticReplay, false);
  assert.deepEqual(f.calls.map(row => row.method), ['snapshot']);
  const before = f.calls.length;
  assert.equal((await f.call('status', { query: '?sessionId=' + SESSION }).done).status, 400);
  assert.equal(f.calls.length, before);
  f.setPeer({ principal: { kind: 'guest' }, signal: new AbortController().signal });
  assert.equal((await f.call('status').done).status, 403); assert.equal(f.calls.length, before);
});

test('desktop context preview/recover carry only the exact reviewed fields without starting a model', async t => {
  const f = fixture(t);
  assert.equal((await f.call('preview', { body: previewBody() }).done).status, 200);
  assert.equal((await f.call('recover', { body: recoverBody() }).done).status, 200);
  const actions = f.calls.filter(row => row.method !== 'snapshot');
  assert.deepEqual(actions.map(row => row.method), ['preview', 'recover']);
  assert.deepEqual(actions[0].body, previewBody()); assert.deepEqual(actions[1].body, recoverBody());
  for (const row of actions) { assert.equal(row.context.authorize(), true); assert.equal(row.context.signal.aborted, false); }
});

test('desktop context methods and strict bodies reject unknown targets, replay flags and malformed CAS before dispatch', async t => {
  const f = fixture(t);
  assert.equal((await f.call('status', { method: 'POST', body: {} }).done).status, 405);
  for (const body of [{ ...previewBody(), replay: true }, { ...previewBody(), expectedSeq: -1 },
    { ...previewBody(), expectedSeq: '7' }, { ...previewBody(), maxTokens: 0 }, { ...previewBody(), sessionId: '' },
    { sessionId: SESSION, maxTokens: 8192 }]) {
    assert.equal((await f.call('preview', { body }).done).status, 400);
  }
  for (const body of [{ ...recoverBody(), replay: true }, { ...recoverBody(), acknowledgeNoReplay: false },
    { sessionId: SESSION, previewId: PREVIEW }, { ...recoverBody(), previewId: '' }]) {
    assert.equal((await f.call('recover', { body }).done).status, 400);
  }
  assert.equal(f.calls.filter(row => ['preview', 'recover'].includes(row.method)).length, 0);
});

test('slow desktop context bodies cannot migrate to a replacement runtime or manager', async t => {
  for (const replacement of ['runtime', 'manager']) {
    const f = fixture(t), bodyGate = deferred(); let replacementCalls = 0;
    const text = JSON.stringify(previewBody());
    async function* chunks() { yield text.slice(0, 20); await bodyGate.promise; yield text.slice(20); }
    const pending = f.call('preview', { chunks: chunks() }); await turn();
    const next = { preview() { replacementCalls++; }, snapshot: () => ({}) };
    if (replacement === 'runtime') f.setRuntime({ desktopContext: next }); else f.replaceManager(next);
    bodyGate.resolve(); const result = await pending.done;
    assert([403, 409].includes(result.status)); assert.equal(replacementCalls, 0);
    assert.equal(f.calls.filter(row => row.method === 'preview').length, 0); clean(result);
  }
});

test('owner revocation while a desktop context body arrives prevents the action', async t => {
  const f = fixture(t), bodyGate = deferred(), text = JSON.stringify(recoverBody());
  async function* chunks() { yield text.slice(0, 20); await bodyGate.promise; yield text.slice(20); }
  const pending = f.call('recover', { chunks: chunks() }); await turn();
  f.setPeer({ principal: { kind: 'guest' }, signal: new AbortController().signal }); bodyGate.resolve();
  const result = await pending.done; assert.equal(result.status, 403);
  assert.equal(f.calls.filter(row => row.method === 'recover').length, 0); clean(result);
});

test('desktop recovery rejects busy, applying and maintenance states without mutating the manager', async t => {
  for (const state of ['busy', 'applying', 'maintenance']) {
    const f = fixture(t); if (state === 'busy') f.setBusy(true); else f[state](true);
    const result = await f.call('recover', { body: recoverBody() }).done;
    assert.equal(result.status, 409); assert.equal(result.body.code, 'BUSY');
    assert.equal(f.calls.filter(row => row.method === 'recover').length, 0);
  }
});

test('desktop context CAS conflicts and unexpected errors use safe messages', async t => {
  for (const code of ['CONFLICT', undefined]) {
    const f = fixture(t); f.fail(Object.assign(new Error(SECRET), code ? { code } : {}));
    const result = await f.call('recover', { body: recoverBody() }).done;
    assert.equal(result.status, code === 'CONFLICT' ? 409 : 503); clean(result);
    assert.equal(result.body.ok, false); if (code) assert.equal(result.body.code, code);
  }
});

test('owner revocation and runtime changes during desktop recovery suppress the delayed result', async t => {
  for (const change of ['owner', 'runtime', 'manager']) {
    const f = fixture(t), gate = deferred(); f.setGate(gate.promise);
    const pending = f.call('recover', { body: recoverBody() }), context = await f.entered;
    if (change === 'owner') f.owner.abort();
    else if (change === 'runtime') f.setRuntime({ desktopContext: f.manager });
    else f.replaceManager({ snapshot: () => ({}) });
    assert.equal(context.authorize(), false); gate.resolve(); const result = await pending.done;
    assert([403, 409].includes(result.status)); assert.equal(result.body.desktopContext, undefined); clean(result);
  }
});

test('busy, applying or maintenance changes during desktop recovery revoke its authorization and response', async t => {
  for (const state of ['busy', 'applying', 'maintenance']) {
    const f = fixture(t), gate = deferred(); f.setGate(gate.promise);
    const pending = f.call('recover', { body: recoverBody() }), context = await f.entered;
    if (state === 'busy') f.setBusy(true); else f[state](true);
    assert.equal(context.authorize(), false); gate.resolve(); const result = await pending.done;
    assert.equal(result.status, 409); assert.equal(result.body.code, 'BUSY');
    assert.equal(result.body.desktopContext, undefined); clean(result);
  }
});

test('complete desktop request-body response close and req.aborted cancel the manager without another write', async t => {
  for (const abort of ['response', 'request']) {
    const f = fixture(t), gate = deferred(); f.setGate(gate.promise);
    const pending = f.call('recover', { body: recoverBody() }), context = await f.entered;
    assert.equal(pending.req.readableEnded, true);
    if (abort === 'request') {
      pending.req.aborted = true; pending.req.emit('aborted');
      assert.equal(context.signal.aborted, true, 'request abort alone must cancel before response close');
    }
    pending.res.destroyed = true; pending.res.emit('close');
    assert.equal(context.signal.aborted, true); assert.equal(context.authorize(), false);
    gate.resolve(); await turn(); await turn();
    assert.equal(pending.res.writes.length, 0); assert.equal(pending.res.values.length, 0);
    assert.equal(pending.res.listenerCount('close'), 0); assert.equal(pending.req.listenerCount('aborted'), 0);
  }
});
