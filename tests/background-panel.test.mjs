import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PrivateConfigStore } from '../packages/dsh-dafeiyu/src/config-store.js';
import { ConfigurationPanelController, registerConfigPanel } from '../packages/dsh-dafeiyu/src/config-panel.js';

const PREFIX = '/dafeiyu-panel/api/';
const SECRET = 'BACKGROUND_PANEL_PRIVATE_FAILURE_CANARY';
const REQUEST_ID = 'a5f27f63-2cf8-4b28-b1bd-74c84d59e4ea';
const TASK_ID = 'dfy-1234567890abcdef';
const cancelBody = { taskId: TASK_ID, qq: '123', identityId: 'default' };
const owner = () => ({ principal: { kind: 'owner' }, signal: new AbortController().signal });
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-background-panel-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ownerQq: '123', onebotSelfId: '456', onebotAccessToken: SECRET }));
  const store = new PrivateConfigStore({ configFile }), calls = [], routes = new Map(), effects = [];
  const state = { applying: false, pending: 0, backgroundBusy: false, maintenance: false };
  let peer = owner();
  let runtime = { nativeOneBot: { expectedSelfId: '456', get status() { return { pending: state.pending, conversations: [] }; } },
    backgroundTasks: { get status() { return { ready: true, busy: state.backgroundBusy, active: Number(state.backgroundBusy),
      running: Number(state.backgroundBusy), queued: 0, tasks: [] }; },
    async cancel(id, scope) { calls.push({ method: 'cancel', id, scope }); return options.cancel ? options.cancel(id, scope) : { id, status: 'cancelling' }; },
    async acknowledge(id, scope) { calls.push({ method: 'acknowledge', id, scope }); return options.acknowledge ? options.acknowledge(id, scope) : { id, status: 'unknown', requiresVerification: false }; } },
    async probeBackgroundTask(body, authorization) { calls.push({ method: 'test', body: { ...body } });
      assert.equal(authorization.authorize(), true);
      return options.probe ? options.probe(body, authorization) : { id: TASK_ID, status: 'queued', executor: body.executor }; },
  };
  const controller = new ConfigurationPanelController({ store, getRuntime: () => runtime,
    getAppliedRevision: () => store.snapshot().revision, getApplying: () => state.applying,
    getRuntimeError: () => false, getMaintenanceBusy: () => state.maintenance, paths: () => ({ configFile }) });
  const connection = { admit: () => ({ peer }) };
  const fiber = { async dispose() { for (const effect of effects.splice(0).reverse()) await effect(); } };
  const webServer = { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } };
  registerConfigPanel({ inject(_names, callback) { callback({ get: (name) => ({ connection, webServer })[name],
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup); } }); return fiber; } }, controller);
  t.after(async () => { await fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { state, calls, controller, get runtime() { return runtime; }, setRuntime(next) { runtime = next; }, setPeer(next) { peer = next; },
    call(endpoint, { body, chunks, method = 'POST' } = {}) {
      const req = Readable.from(chunks || [JSON.stringify(body || {})]);
      req.method = method; req.url = PREFIX + endpoint; req.headers = { 'content-type': 'application/json' };
      return new Promise((resolve, reject) => {
        const res = { writeHead(status) { this.status = status; }, end(text) {
          try { resolve({ status: this.status, text: String(text), body: JSON.parse(text) }); } catch (error) { reject(error); }
        } };
        routes.get(PREFIX + endpoint)(req, res);
      });
    } };
}
const clean = (response) => assert.equal(response.text.includes(SECRET), false);

test('background panel endpoints require the current local owner before invoking runtime actions', async (t) => {
  const f = fixture(t);
  for (const peer of [{ principal: { kind: 'api' } }, { principal: { kind: 'anonymous' } },
    { principal: { kind: 'owner' }, signal: { aborted: true } }]) {
    f.setPeer(peer);
    for (const [endpoint, body] of [['tasks/cancel', cancelBody], ['tasks/test', { executor: 'native', requestId: REQUEST_ID }], ['tasks/acknowledge', { ...cancelBody, confirmedStopped: true }]]) {
      const response = await f.call(endpoint, { body }); assert.equal(response.status, 403); clean(response);
    }
  }
  assert.equal(f.calls.length, 0);
});

test('task cancellation is allowed while work is busy and receives the exact account identity and configured receiver', async (t) => {
  const f = fixture(t); f.state.pending = 2; f.state.backgroundBusy = true;
  assert.equal(f.controller.getState().runtime.busy, true);
  const response = await f.call('tasks/cancel', { body: cancelBody });
  assert.equal(response.status, 200); clean(response);
  assert.deepEqual(f.calls, [{ method: 'cancel', id: TASK_ID, scope: { selfId: '456', peerId: '123', identityId: 'default' } }]);
  assert.equal(response.body.task.status, 'cancelling');
  const invalid = await f.call('tasks/cancel', { body: { ...cancelBody, selfId: '999' } });
  assert.equal(invalid.status, 400); assert.equal(f.calls.length, 1); clean(invalid);
});

test('a runtime change or owner revocation while reading a task request never acts on the replacement runtime', async (t) => {
  const f = fixture(t);
  async function* replaced() { yield '{"taskId":"' + TASK_ID + '",'; f.setRuntime({ ...f.runtime }); yield '"qq":"123","identityId":"default"}'; }
  const conflict = await f.call('tasks/cancel', { chunks: replaced() });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'CONFLICT'); assert.equal(f.calls.length, 0); clean(conflict);
  async function* revoked() { yield '{"executor":"native",'; f.setPeer({ principal: { kind: 'api' } }); yield '"requestId":"' + REQUEST_ID + '"}'; }
  const denied = await f.call('tasks/test', { chunks: revoked() });
  assert.equal(denied.status, 403); assert.equal(f.calls.length, 0); clean(denied);
});

test('read-only connectivity tests accept only fixed executor and stable request ID without user prompts or working directories', async (t) => {
  const f = fixture(t);
  for (const executor of ['native', 'codex', 'zcode', 'minimax']) {
    const body = { executor, requestId: REQUEST_ID };
    const response = await f.call('tasks/test', { body });
    assert.equal(response.status, 200); clean(response);
    assert.deepEqual(f.calls.at(-1), { method: 'test', body });
  }
  const before = f.calls.length;
  for (const patch of [{ executor: 'auto' }, { requestId: 'invalid' }, { requestId: '-'.repeat(36) },
    { prompt: '读取私人文件' }, { cwd: '/private' }, { originId: '999' }]) {
    const response = await f.call('tasks/test', { body: { executor: 'native', requestId: REQUEST_ID, ...patch } });
    assert.equal(response.status, 400); clean(response);
  }
  assert.equal(f.calls.length, before);
});

test('connectivity probes are refused while foreground work, background work, maintenance or apply is busy', async (t) => {
  const f = fixture(t);
  for (const key of ['pending', 'backgroundBusy', 'maintenance', 'applying']) {
    f.state[key] = key === 'pending' ? 1 : true;
    const response = await f.call('tasks/test', { body: { executor: 'native', requestId: REQUEST_ID } });
    assert.equal(response.status, 409); assert.equal(response.body.code, 'BUSY'); clean(response);
    f.state[key] = key === 'pending' ? 0 : false;
  }
  assert.equal(f.calls.length, 0);
});

test('delayed probe and cancellation responses are suppressed after owner revocation or runtime replacement', async (t) => {
  const probeGate = deferred(), cancelGate = deferred();
  const f = fixture(t, { probe: () => probeGate.promise, cancel: () => cancelGate.promise });
  const pendingProbe = f.call('tasks/test', { body: { executor: 'native', requestId: REQUEST_ID } });
  while (!f.calls.length) await new Promise((resolve) => setImmediate(resolve));
  f.setPeer({ principal: { kind: 'api' } }); probeGate.resolve({ id: TASK_ID, text: SECRET });
  const forbidden = await pendingProbe; assert.equal(forbidden.status, 403); clean(forbidden);
  f.setPeer(owner());
  const pendingCancel = f.call('tasks/cancel', { body: cancelBody });
  while (f.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  f.setRuntime({ ...f.runtime }); cancelGate.resolve({ id: TASK_ID, text: SECRET });
  const conflict = await pendingCancel; assert.equal(conflict.status, 409); clean(conflict);
});

test('unexpected probe and cancellation failures return fixed error classes without raw exception data', async (t) => {
  const fail = () => { throw new Error(SECRET); };
  const f = fixture(t, { probe: fail, cancel: fail });
  for (const [endpoint, body] of [['tasks/cancel', cancelBody], ['tasks/test', { executor: 'native', requestId: REQUEST_ID }]]) {
    const response = await f.call(endpoint, { body });
    assert.equal(response.status, 503); assert.equal(response.body.code, 'UNAVAILABLE'); clean(response);
  }
});

test('workspace protection requires explicit stopped confirmation and can be acknowledged while queued work is busy', async (t) => {
  const f = fixture(t); f.state.backgroundBusy = true;
  for (const body of [cancelBody, { ...cancelBody, confirmedStopped: false }, { ...cancelBody, confirmedStopped: true, selfId: '999' }]) {
    assert.equal((await f.call('tasks/acknowledge', { body })).status, 400);
  }
  assert.equal(f.calls.length, 0);
  const response = await f.call('tasks/acknowledge', { body: { ...cancelBody, confirmedStopped: true } });
  assert.equal(response.status, 200); clean(response);
  assert.deepEqual(f.calls, [{ method: 'acknowledge', id: TASK_ID, scope: { selfId: '456', peerId: '123', identityId: 'default' } }]);
  assert.equal(response.body.task.status, 'unknown'); assert.equal(response.body.task.requiresVerification, false);
  f.state.applying = true;
  assert.equal((await f.call('tasks/acknowledge', { body: { ...cancelBody, confirmedStopped: true } })).status, 409);
  assert.equal(f.calls.length, 1);
});

test('workspace confirmation is tied to the admitted runtime and remains private after a late owner revocation', async (t) => {
  const gate = deferred(), f = fixture(t, { acknowledge: () => gate.promise });
  async function* changed() { yield '{"taskId":"' + TASK_ID + '",'; f.setRuntime({ ...f.runtime }); yield '"qq":"123","identityId":"default","confirmedStopped":true}'; }
  assert.equal((await f.call('tasks/acknowledge', { chunks: changed() })).status, 409);
  assert.equal(f.calls.length, 0);
  const pending = f.call('tasks/acknowledge', { body: { ...cancelBody, confirmedStopped: true } });
  while (!f.calls.length) await new Promise((resolve) => setImmediate(resolve));
  f.setPeer({ principal: { kind: 'api' } }); gate.resolve({ text: SECRET });
  const response = await pending; assert.equal(response.status, 403); clean(response);
});
