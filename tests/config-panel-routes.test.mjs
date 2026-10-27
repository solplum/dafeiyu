import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PrivateConfigStore } from '../packages/dsh-dafeiyu/src/config-store.js';
import { RuntimeDiagnostics } from '../packages/dsh-dafeiyu/src/runtime-diagnostics.js';
import { PanelLibrary } from '../packages/dsh-dafeiyu/src/panel-library.js';
import { MemeManager } from '../packages/dsh-dafeiyu/src/meme-manager.js';
import { ConfigurationPanelController, registerConfigPanel, ownerRequestRejection } from '../packages/dsh-dafeiyu/src/config-panel.js';
import { CapabilityRegistry } from '../packages/dsh-dafeiyu/src/capabilities.js';

import { SOCIAL_ACCOUNT_ROUTES } from '../packages/dsh-dafeiyu/src/social/account-routes.mjs';

const SECRET = 'ROUTE_PRIVATE_TOKEN_DO_NOT_RETURN';
const PREFIX = '/dafeiyu-panel/api/';
const ENDPOINTS = [...Object.keys(SOCIAL_ACCOUNT_ROUTES), 'state', 'life', 'life/action', 'tokens/status', 'tokens/config', 'tokens/bonus', 'tokens/acknowledge', 'config', 'apply', 'napcat/status', 'napcat/qrcode', 'memes', 'meme-image', 'persona',
  'meme-detail', 'meme-metadata', 'memes/import',
  'model/status', 'model/config', 'model/probe', 'model/test', 'model/selection', 'model/rebind', 'speech/prepare', 'speech/selection', 'speech/test',
  'dependencies', 'dependencies/check', 'dependencies/action',
  'voice/status', 'voice/config', 'voice/check', 'voice/test', 'social/status', 'social/check', 'phone/check', 'phone/connect'];
ENDPOINTS.splice(9, 0, 'conversations/stop', 'conversations/recover', 'tasks/cancel', 'tasks/test', 'tasks/acknowledge', 'memory', 'memory/correct', 'memory/forget', 'memory/restore', 'memory/delete', 'memory/resume-delete');
ENDPOINTS.splice(9, 0, 'capabilities', 'capabilities/check', 'capabilities/probe');
ENDPOINTS.splice(9, 0, 'desktop-context/status', 'desktop-context/preview', 'desktop-context/recover');
const ownerPeer = () => ({ principal: { kind: 'owner' }, signal: new AbortController().signal });

function invoke(handler, { method = 'GET', body, chunks, contentType = 'application/json', request, url, binary = false } = {}) {
  const req = request || Readable.from(chunks || (body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]));
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': contentType };
  let settled = false;
  const done = new Promise((resolve, reject) => {
    const res = { status: undefined, headers: undefined,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(value = '') {
        settled = true;
        try { resolve({ status: this.status, headers: this.headers, text: String(value), body: binary ? value : JSON.parse(String(value)) }); }
        catch (error) { reject(error); }
      } };
    try { handler(req, res); } catch (error) { reject(error); }
  });
  return { done, req, get settled() { return settled; } };
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-panel-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ownerQq: '123', onebotSelfId: '456', onebotWs: 'ws://127.0.0.1:3001',
    onebotAccessToken: SECRET, unknownPrivateField: SECRET, ...options.config }));
  const store = new PrivateConfigStore({ configFile });
  const state = { applying: false, maintenance: false, pending: 0, applyCalls: 0, stateReads: 0, runtimeError: false,
    appliedRevision: store.snapshot().revision, generation: 1 };
  let runtime = { nativeOneBot: { get status() { return { pending: state.pending, conversations: state.conversations || [] }; },
      stopConversation: options.stopConversation, recoverConversation: options.recoverConversation },
    phoneTools: { enabled: false, device: 'fixture-device' },
    nativeTools: { getPersonalQQStatus: () => ({ configured: true, enabled: false, connected: false,
      loginVerified: false, online: null, identityConflict: false, sessionCreated: false, engine: 'native' }) } };
  const controller = new ConfigurationPanelController({ store, getRuntime: () => runtime, napcat: options.napcat, library: options.library,
    model: options.model, dependencies: options.dependencies, voice: options.voice, diagnostics: options.diagnostics, memory: options.memory,
    getAppliedRevision: () => state.appliedRevision, getApplying: () => state.applying, getMaintenanceBusy: () => state.maintenance,
    getRuntimeError: () => state.runtimeError, paths: () => ({ configFile, memoryProjectRoot: root }),
    apply: options.noApply ? undefined : async () => {
      state.applyCalls++; state.applying = true;
      try { await options.apply?.(); state.appliedRevision = store.snapshot().revision; state.generation++; }
      finally { state.applying = false; }
    },
  });
  const originalGetState = controller.getState.bind(controller);
  controller.getState = () => { state.stateReads++; return originalGetState(); };
  let peer = ownerPeer();
  const connection = { admit: () => ({ peer }) };
  const routes = new Map(), captured = [], cleanup = [], effects = [];
  let disposed = false, registrationError;
  const webServer = { register(definition) {
    assert.equal(definition.kind, 'exact');
    assert.equal(typeof definition.handler, 'function');
    if (options.failAfter === captured.length) throw new Error('fixture route registration failed');
    routes.set(definition.path, definition.handler); captured.push(definition);
    return () => { cleanup.push(definition.path); routes.delete(definition.path); };
  } };
  const fiber = { async dispose() {
    if (disposed) return;
    disposed = true;
    for (const effect of effects.splice(0).reverse()) await effect();
  } };
  const ctx = { inject(names, callback) {
    assert.deepEqual(names, ['webServer', 'connection']);
    callback({ get: (name) => ({ connection, webServer })[name],
      effect(effect) { const dispose = effect(); if (typeof dispose === 'function') effects.push(dispose); } });
    return fiber;
  } };
  let registration;
  try { registration = registerConfigPanel(ctx, controller); } catch (error) { registrationError = error; }
  t.after(() => fiber.dispose());
  return { root, configFile, store, state, controller, connection, routes, captured, cleanup, registration, registrationError,
    get runtime() { return runtime; }, setRuntime(next) { runtime = next; },
    setPeer(value) { peer = value; },
    call(endpoint, options) {
      const handler = routes.get(PREFIX + endpoint);
      assert.equal(typeof handler, 'function', `${endpoint} should be registered using webServer.register`);
      return invoke(handler, options);
    } };
}

function clean(response) { assert.equal(response.text.includes(SECRET), false); }

test('capability routes only observe on GET, explicitly probe once, and lock apply/save during actual work', async (t) => {
  const f=fixture(t);let calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const registry=new CapabilityRegistry({getRuntime:()=>f.runtime,probes:{computer:async()=>{calls++;await gate;return {ok:true,evidence:{kind:'readback',matched:true},raw:SECRET};}}});
  f.controller.capabilities=registry;t.after(()=>{release();registry.dispose();});
  const first=await f.call('capabilities').done;assert.equal(first.status,200);assert.equal(calls,0);clean(first);
  const invalid=await f.call('capabilities/check',{method:'POST',body:{command:SECRET}}).done;assert.equal(invalid.status,400);assert.equal(calls,0);
  const pending=f.call('capabilities/probe',{method:'POST',body:{id:'computer',requestId:'12345678-1234-4234-8234-123456789abc'}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(f.controller.getState().runtime.busy,true);
  await assert.rejects(f.controller.apply(),{code:'BUSY'});
  assert.throws(()=>f.controller.save({patch:{},revision:f.store.snapshot().revision}),{code:'BUSY'});
  release();const result=await pending.done;assert.equal(result.status,200);assert.equal(result.body.capabilities.items.find(v=>v.id==='computer').state,'verified');clean(result);
  await f.call('capabilities/probe',{method:'POST',body:{id:'computer',requestId:'12345678-1234-4234-8234-123456789abc'}}).done;
  assert.equal(calls,1);
});

test('slow capability requests bind to their original runtime before body parsing',async(t)=>{
  const f=fixture(t);let calls=0,release;
  f.controller.capabilities=new CapabilityRegistry({getRuntime:()=>f.runtime,probes:{computer:async()=>{calls++;return {ok:true,evidence:{kind:'readback',matched:true}};}}});
  t.after(()=>f.controller.capabilities.dispose());
  const gate=new Promise(resolve=>{release=resolve;});
  const req=Readable.from((async function*(){await gate;yield JSON.stringify({id:'computer',requestId:'12345678-1234-4234-8234-123456789abd'});})());
  const pending=f.call('capabilities/probe',{method:'POST',request:req});
  f.setRuntime({...f.runtime});release();assert.equal((await pending.done).status,409);assert.equal(calls,0);
});

test('revoking owner during a capability probe suppresses its state and result',async(t)=>{
  const f=fixture(t);let release,started;
  const start=new Promise(resolve=>{started=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  f.controller.capabilities=new CapabilityRegistry({getRuntime:()=>f.runtime,probes:{computer:async()=>{started();await gate;return {ok:true,evidence:{kind:'readback',matched:true},raw:SECRET};}}});
  t.after(()=>{release();f.controller.capabilities.dispose();});
  const pending=f.call('capabilities/probe',{method:'POST',body:{id:'computer',requestId:'12345678-1234-4234-8234-123456789abe'}});
  await start;f.setPeer({principal:{kind:'guest'}});release();const response=await pending.done;
  assert.equal(response.status,403);assert.equal(response.body.capabilities,undefined);clean(response);
});

test('conversation status and control responses expose only safe metadata; target controls work while another identity is busy', async (t) => {
  const calls = [], f = fixture(t, { stopConversation: async (body) => { calls.push(body); return { stopped: true, rawError: SECRET }; },
    recoverConversation: async (body) => { calls.push(body); return { recovered: true, content: SECRET }; } });
  f.state.pending = 2;
  f.state.conversations = [{ qq: '123', identityId: 'default', identityName: '默认身份', state: 'blocked', queued: 1,
    running: false, failureType: 'delivery_unknown', failedAt: '2026-10-23T09:00:00Z', canStop: true,
    canRecover: true, requiresUncertainAcknowledgement: true, rawError: SECRET, text: SECRET }];
  const state = await f.call('state').done; clean(state);
  assert.equal(state.body.runtime.companion.conversations[0].failureType, 'delivery_unknown');
  assert.equal(Object.hasOwn(state.body.runtime.companion.conversations[0], 'rawError'), false);
  const stopped = await f.call('conversations/stop', { method: 'POST', body: { qq: '123', identityId: 'default' } }).done;
  assert.equal(stopped.status, 200); clean(stopped); assert.equal(stopped.body.result.stopped, true);
  const recovered = await f.call('conversations/recover', { method: 'POST', body: { qq: '123', identityId: 'default', acknowledgeUncertain: true } }).done;
  assert.equal(recovered.status, 200); clean(recovered); assert.equal(recovered.body.result.recovered, true);
  assert.deepEqual(calls, [{ qq: '123', identityId: 'default' }, { qq: '123', identityId: 'default', acknowledgeUncertain: true }]);
  for (const body of [{ qq: '123', identityId: 'default', text: SECRET }, { qq: '../123', identityId: 'default' },
    { qq: '123', identityId: 'default', acknowledgeUncertain: 'true' }]) {
    const response = await f.call('conversations/recover', { method: 'POST', body }).done;
    assert.equal(response.status, 400); clean(response);
  }
  assert.equal(calls.length, 2); assert.equal(f.state.applyCalls, 0);
});

test('conversation errors and revoked or changed instances never leak raw failures or operate on a newly applied bridge', async (t) => {
  let calls = 0;
  const f = fixture(t, { recoverConversation: async () => { calls++; throw Object.assign(new Error(SECRET), { code: 'UNCERTAIN_ACK_REQUIRED' }); } });
  const failed = await f.call('conversations/recover', { method: 'POST', body: { qq: '123', identityId: 'default' } }).done;
  assert.equal(failed.status, 409); assert.equal(failed.body.code, 'UNCERTAIN_ACK_REQUIRED'); clean(failed);
  async function* revoked() { yield '{"qq":"123",'; f.setPeer({ principal: { kind: 'api' } }); yield '"identityId":"default"}'; }
  const denied = await f.call('conversations/recover', { method: 'POST', chunks: revoked() }).done;
  assert.equal(denied.status, 403); assert.equal(calls, 1);
  f.setPeer(ownerPeer());
  async function* switched() { yield '{"qq":"123",'; f.setRuntime({ ...f.runtime, nativeOneBot: {} }); yield '"identityId":"default"}'; }
  const stale = await f.call('conversations/recover', { method: 'POST', chunks: switched() }).done;
  assert.equal(stale.status, 409); assert.equal(calls, 1); clean(stale);
  const busy = fixture(t); busy.runtime.phoneTools.active = 1;
  assert.equal(busy.controller.getState().runtime.busy, true, 'desktop phone work also prevents applying/reloading');
});

test('context metadata and explicit fresh-session owner requests retain fixed safe shapes without applying or changing configuration', async t => {
  const calls = [], f = fixture(t, { recoverConversation: async body => { calls.push(body); return { recovered: true, freshSession: body.freshSession === true, rawError: SECRET }; } });
  f.state.conversations = ['context_required', 'context_compaction_failed', 'context_guard_unavailable'].map((failureType, at) => ({
    qq: '123', identityId: 'context-' + at, identityName: '上下文测试', state: 'blocked', queued: 0, running: false,
    canStop: false, canRecover: true, requiresUncertainAcknowledgement: false, failureType, failedAt: '2026-10-26T03:00:00Z', controlVersion: '0:1', text: SECRET, rawError: SECRET }));
  f.setRuntime({ ...f.runtime, contextGuard: { snapshot: () => ({ enabled: true, strategy: 'conservative-host-request', warningRatio: 0.75, protectionRatio: 0.9, usageMeasurement: false, automaticReplay: false }) } });
  const before = fs.readFileSync(f.configFile), state = await f.call('state').done; clean(state);
  assert.deepEqual(state.body.runtime.companion.conversations.map(row => row.failureType), f.state.conversations.map(row => row.failureType));
  assert.ok(state.body.runtime.companion.conversations.every(row => row.controlVersion === '0:1'));
  assert.deepEqual(state.body.runtime.contextProtection, { enabled: true, strategy: 'conservative-host-request', warningRatio: 0.75, protectionRatio: 0.9, usageMeasurement: false, automaticReplay: false });
  const body = { qq: '123', identityId: 'context-0', acknowledgeUncertain: false, freshSession: true, controlVersion: '0:1' };
  const response = await f.call('conversations/recover', { method: 'POST', body }).done;
  assert.equal(response.status, 200); clean(response); assert.equal(response.body.result.freshSession, true);
  assert.ok(response.body.result.message.includes('下一条新消息将使用新会话'));
  const ordinary = await f.call('conversations/recover', { method: 'POST', body: { ...body, freshSession: false } }).done;
  assert.equal(ordinary.status, 200); assert.equal(ordinary.body.result.freshSession, false);
  for (const freshSession of [null, 'true', 1, {}, []]) {
    const invalid = await f.call('conversations/recover', { method: 'POST', body: { ...body, freshSession } }).done;
    assert.equal(invalid.status, 400); clean(invalid);
  }
  for (const patch of [{ text: SECRET }, { seed: [] }, { resetAll: true }]) {
    const invalid = await f.call('conversations/recover', { method: 'POST', body: { ...body, ...patch } }).done;
    assert.equal(invalid.status, 400); clean(invalid);
  }
  for (const controlVersion of [null, 1, 'stale', '0:1:2']) {
    const invalid = await f.call('conversations/recover', { method: 'POST', body: { ...body, controlVersion } }).done;
    assert.equal(invalid.status, 400); clean(invalid);
  }
  const stop = await f.call('conversations/stop', { method: 'POST', body }).done; assert.equal(stop.status, 400);
  assert.deepEqual(calls, [body, { ...body, freshSession: false }]); assert.equal(f.state.applyCalls, 0);
  assert.deepEqual(fs.readFileSync(f.configFile), before);
});

test('a stale context control version maps to safe conflict without issuing a replacement recovery', async t => {
  const calls = [], accepted = [], f = fixture(t, { recoverConversation: async body => {
    calls.push(body);
    if (body.controlVersion !== '0:2') throw Object.assign(new Error(SECRET), { code: 'CONFLICT' });
    accepted.push(body); return { recovered: true, freshSession: true };
  } });
  const body = { qq: '123', identityId: 'default', acknowledgeUncertain: true, freshSession: true };
  const stale = await f.call('conversations/recover', { method: 'POST', body: { ...body, controlVersion: '0:1' } }).done;
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'CONFLICT'); clean(stale);
  assert.equal(calls.length, 1); assert.equal(accepted.length, 0);
  const current = await f.call('conversations/recover', { method: 'POST', body: { ...body, controlVersion: '0:2' } }).done;
  assert.equal(current.status, 200); assert.equal(current.body.result.freshSession, true); clean(current);
  assert.equal(calls.length, 2); assert.equal(accepted.length, 1); assert.equal(f.state.applyCalls, 0);
});

test('context recovery requirements map to a sanitized 409 while reload and maintenance prevent either recovery mode', async t => {
  let calls = 0;
  const f = fixture(t, { recoverConversation: async () => { calls++; throw Object.assign(new Error(SECRET), { code: 'CONTEXT_RECOVERY_REQUIRED' }); } });
  const body = { qq: '123', identityId: 'default' };
  const response = await f.call('conversations/recover', { method: 'POST', body }).done;
  assert.equal(response.status, 409); assert.equal(response.body.code, 'CONTEXT_RECOVERY_REQUIRED'); clean(response);
  assert.ok(response.body.error.includes('上下文仍需处理')); assert.ok(response.body.error.includes('原请求不会自动重跑'));
  for (const gate of ['applying', 'maintenance']) for (const freshSession of [false, true]) {
    f.state[gate] = true;
    const blocked = await f.call('conversations/recover', { method: 'POST', body: { ...body, freshSession } }).done;
    assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'BUSY'); clean(blocked); f.state[gate] = false;
  }
  assert.equal(calls, 1); assert.equal(f.state.applyCalls, 0);
});

test('fresh-session slow bodies and delayed replies retain owner and exact runtime boundaries without automatically trying again', async t => {
  for (const mode of ['body-owner', 'body-instance', 'result-owner', 'result-instance']) {
    let calls = 0, release; const gate = new Promise(resolve => { release = resolve; });
    const f = fixture(t, { recoverConversation: async () => { calls++; await gate; return { recovered: true, freshSession: true, rawError: SECRET }; } });
    const body = { qq: '123', identityId: 'default', freshSession: true };
    const revoke = () => mode.endsWith('owner') ? f.setPeer({ principal: { kind: 'api' } }) : f.setRuntime({ ...f.runtime, nativeOneBot: {} });
    let pending;
    if (mode.startsWith('body')) {
      async function* chunks() { yield '{"qq":"123",'; revoke(); yield '"identityId":"default","freshSession":true}'; }
      pending = f.call('conversations/recover', { method: 'POST', chunks: chunks() });
    } else { pending = f.call('conversations/recover', { method: 'POST', body }); await new Promise(resolve => setImmediate(resolve)); revoke(); }
    release(); const result = await pending.done;
    assert.equal(result.status, mode.endsWith('owner') ? 403 : 409, mode); clean(result);
    assert.equal(calls, mode.startsWith('body') ? 0 : 1, mode);
    assert.equal(result.body.result, undefined); assert.equal(f.state.applyCalls, 0);
  }
});

test('memory owner routes enforce bounded filters, CAS bodies, busy and runtime gates without exposing unexpected failures', async (t) => {
  const calls = [], revision = 'a'.repeat(64);
  const memory = Object.fromEntries(['snapshot', 'correct', 'forget', 'restore'].map((method) => [method, async (body, options) => {
    assert.equal(options.authorize(), true); calls.push({ method, body });
    return method === 'snapshot' ? { revision, items: [], total: 0, offset: body.offset || 0, limit: body.limit || 50 }
      : { saved: true, revision, record: { id: body.id, summary: '合成记忆', status: method === 'forget' ? 'forgotten' : 'active' } };
  }]));
  const f = fixture(t, { memory });
  const read = await f.call('memory', { url: PREFIX + 'memory?query=tea&kind=fact&scope=account&status=active&offset=0&limit=50' }).done;
  assert.equal(read.status, 200); clean(read); assert.equal(calls[0].body.limit, 50);
  for (const suffix of ['?query=a&query=b', '?path=/private', '?limit=-1', '?offset=1e2']) {
    const result = await f.call('memory', { url: PREFIX + 'memory' + suffix }).done; assert.equal(result.status, 400); clean(result);
  }
  const body = { id: 'fact-fixture', revision, summary: '新摘要', detail: '本人更正的具体内容', sourceType: 'user_explicit', confirmed: true };
  for (const endpoint of ['memory/correct', 'memory/forget', 'memory/restore']) {
    const result = await f.call(endpoint, { method: 'POST', body: endpoint.endsWith('correct') ? body : { id: body.id, revision } }).done;
    assert.equal(result.status, 200); clean(result);
  }
  for (const patch of [{ revision: 'bad' }, { sourceType: 'inference', confirmed: true }, { path: SECRET }, { detail: '' }]) {
    const response = await f.call('memory/correct', { method: 'POST', body: { ...body, ...patch } }).done;
    assert.equal(response.status, 400); clean(response);
  }
  f.state.pending = 1;
  const busy = await f.call('memory/forget', { method: 'POST', body: { id: body.id, revision } }).done;
  assert.equal(busy.status, 409); assert.equal(busy.body.code, 'BUSY'); f.state.pending = 0;
  memory.correct = () => { throw Object.assign(new Error(SECRET), { code: 'SAVE_UNCERTAIN' }); };
  const unknown = await f.call('memory/correct', { method: 'POST', body }).done; clean(unknown);
  assert.equal(unknown.body.code, 'SAVE_UNCERTAIN'); assert.equal(f.state.applyCalls, 0);
  async function* stale() { yield '{"id":"fact-fixture",'; f.setRuntime({ ...f.runtime }); yield '"revision":"' + revision + '"}'; }
  const changed = await f.call('memory/forget', { method: 'POST', chunks: stale() }).done;
  assert.equal(changed.status, 409); assert.equal(changed.body.code, 'CONFLICT');
  assert.equal(calls.filter((call) => call.method === 'forget').length, 1);
});

test('private memory read responses and delayed mutations are suppressed after owner revocation', async (t) => {
  let release, invoked = 0;
  const wait = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { memory: { snapshot: async () => { invoked++; await wait; return { revision: 'a'.repeat(64), items: [{ detail: SECRET }] }; } } });
  const read = f.call('memory'); await new Promise((resolve) => setImmediate(resolve));
  f.setPeer({ principal: { kind: 'api' } }); release(); const result = await read.done;
  assert.equal(invoked, 1); assert.equal(result.status, 403); clean(result);
});

// Installed dsh-client-connection/lib/index.js:742–749 returns {rejection}
// or {peer}; its browserPeer is constructed with principal.kind='owner' at714.
test('owner admission uses the installed nested peer contract and rejects all other authority shapes', () => {
  const request = {};
  assert.equal(ownerRequestRejection({ admit: (value) => { assert.equal(value, request); return { peer: ownerPeer() }; } }, request), null);
  for (const value of [undefined, null, true, { principal: { kind: 'owner' } }, { peer: { principal: { kind: 'api' } } },
    { peer: { principal: { kind: 'visitor' } } }, { peer: {} }, Promise.resolve({ peer: ownerPeer() })]) {
    assert.equal(ownerRequestRejection({ admit: () => value }, request), 403);
  }
  assert.equal(ownerRequestRejection({}, request), 403);
  assert.equal(ownerRequestRejection({ admit() { throw new Error(SECRET); } }, request), 403);
});

test('unauthenticated, API peer, revoked peer and admission failures cannot read or change configuration', async (t) => {
  const f = fixture(t), original = fs.readFileSync(f.configFile, 'utf8');
  const aborted = new AbortController(); aborted.abort();
  const cases = [
    [() => ({ rejection: 401 }), 401], [() => ({ rejection: 403 }), 403],
    [() => ({ peer: { principal: { kind: 'api' }, signal: new AbortController().signal } }), 403],
    [() => ({ peer: { principal: { kind: 'owner' }, signal: aborted.signal } }), 403],
    [() => { throw new Error(SECRET); }, 403], [undefined, 403],
  ];
  for (const [admit, status] of cases) {
    f.connection.admit = admit;
    for (const endpoint of ENDPOINTS) {
      const response = await f.call(endpoint, { method: ['config', 'apply', 'napcat/qrcode', 'tokens/config', 'tokens/bonus', 'tokens/acknowledge'].includes(endpoint) ? 'POST' : 'GET',
        body: endpoint === 'config' ? { patch: { voiceTranscription: true }, revision: f.store.snapshot().revision } : {} }).done;
      assert.equal(response.status, status); clean(response);
    }
  }
  assert.equal(f.state.stateReads, 0);
  assert.equal(f.state.applyCalls, 0);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
});

test('a current owner can read state with safe headers, saved/effective fields and secret presence only', async (t) => {
  const f = fixture(t);
  assert.equal(f.registration.registered, true);
  assert.equal(ENDPOINTS.length, 54 + Object.keys(SOCIAL_ACCOUNT_ROUTES).length);
  assert.equal(ENDPOINTS.length + 1, 55 + Object.keys(SOCIAL_ACCOUNT_ROUTES).length, 'persona contributes separate GET and POST methods');
  assert.deepEqual([...f.routes.keys()].sort(), ENDPOINTS.map((name) => PREFIX + name).sort());
  const response = await f.call('state').done;
  assert.equal(response.status, 200); clean(response);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.body.config.secretConfigured.saved.onebotAccessToken, true);
  assert.equal(Object.hasOwn(response.body.config.saved, 'onebotAccessToken'), false);
  assert.equal(response.body.runtime.phone.state, 'offline');
  assert.equal(response.body.runtime.model.managedByHost, true);
  assert.equal(response.body.pendingReload, false);
});

test('structured account settings above 32 KiB save atomically while oversized configuration stays bounded', async (t) => {
  const f = fixture(t);
  const qqAccounts = Array.from({ length: 9 }, (_, index) => ({
    qq: index ? String(1000 + index) : '123', name: `使用者 ${index}`, enabled: true, activeIdentityId: 'role-0',
    identities: Array.from({ length: 8 }, (_, identity) => ({
      id: `role-${identity}`, name: `身份 ${identity}`, relationType: 'custom',
      userRole: '朋友', companionRole: '伙伴', userTitle: '', companionTitle: '', description: '场景说明'.repeat(125),
    })),
  }));
  const body = { patch: { qqAccounts }, revision: f.store.snapshot().revision };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 32768);
  let response = await f.call('config', { method: 'POST', body }).done;
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.config.saved.qqAccounts, qqAccounts);
  assert.equal(f.state.applyCalls, 0, 'saving identities must not initiate network or apply a runtime');
  clean(response);
  const saved = fs.readFileSync(f.configFile, 'utf8');
  response = await f.call('config', { method: 'POST',
    chunks: ['{"patch":{"qqAccounts":[],"padding":"', 'a'.repeat(1024 * 1024), '"}}'] }).done;
  assert.equal(response.status, 400);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), saved);
  clean(response);
});

test('route methods and JSON content envelopes are enforced before configuration changes', async (t) => {
  const f = fixture(t), original = fs.readFileSync(f.configFile, 'utf8');
  for (const [endpoint, method] of [['state', 'POST'], ['config', 'GET'], ['apply', 'DELETE']]) {
    const response = await f.call(endpoint, { method, body: {} }).done;
    assert.equal(response.status, 405); clean(response);
  }
  for (const options of [{ contentType: 'text/plain', body: '{}' }, { body: '{broken JSON' }, { body: [] },
    { body: null }, { body: { patch: {}, revision: f.store.snapshot().revision, unexpected: SECRET } },
    { chunks: ['{"patch":{"onebotAccessToken":"', SECRET.repeat(1200),
      '"},"revision":"' + f.store.snapshot().revision + '"}'] }]) {
    const response = await f.call('config', { method: 'POST', ...options }).done;
    assert.equal(response.status, 400); clean(response);
  }
  const response = await f.call('apply', { method: 'POST', body: { patch: {} } }).done;
  assert.equal(response.status, 400);
  assert.equal(f.state.applyCalls, 0);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
});

test('unknown patch fields, invalid permission changes and stale revisions leave the winning saved config intact', async (t) => {
  const f = fixture(t), revision = f.store.snapshot().revision;
  for (const patch of [{ projectRoot: '/tmp/forbidden' }, { allowedPhoneKeys: ['home'] }, { maxListenSeconds: 4 }]) {
    const response = await f.call('config', { method: 'POST', body: { revision, patch } }).done;
    assert.equal(response.status, 400); clean(response);
  }
  f.store.save({ voiceTranscription: true }, { revision });
  const winning = fs.readFileSync(f.configFile, 'utf8');
  const response = await f.call('config', { method: 'POST', body: { revision, patch: { allowMemoryWrites: true } } }).done;
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'CONFLICT'); clean(response);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), winning);
});

test('saving persists only config and explicit apply waits for the actual runtime callback', async (t) => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { apply: () => wait });
  const saved = await f.call('config', { method: 'POST', body: { revision: f.store.snapshot().revision,
    patch: { autoStartOneBot: true, onebotAccessToken: '' } } }).done;
  assert.equal(saved.status, 200); clean(saved);
  assert.equal(saved.body.config.saved.autoStartOneBot, true);
  assert.equal(saved.body.runtime.personalQQ.enabled, false);
  assert.equal(saved.body.pendingReload, true);
  assert.equal(f.state.applyCalls, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).onebotAccessToken, SECRET);
  const applying = f.call('apply', { method: 'POST', body: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.applyCalls, 1);
  assert.equal(applying.settled, false, 'apply response must await the actual host callback');
  assert.equal(f.state.generation, 1);
  release();
  const applied = await applying.done;
  assert.equal(applied.status, 200); clean(applied);
  assert.equal(applied.body.pendingReload, false);
  assert.equal(f.state.generation, 2);
});

test('busy runtime and active apply forbid changes, invalid saved configuration forbids reload', async (t) => {
  const f = fixture(t), original = fs.readFileSync(f.configFile, 'utf8');
  f.state.pending = 1;
  let response = await f.call('apply', { method: 'POST', body: {} }).done;
  assert.equal(response.status, 409); assert.equal(response.body.code, 'BUSY');
  f.state.pending = 0; f.state.applying = true;
  response = await f.call('config', { method: 'POST', body: { revision: f.store.snapshot().revision,
    patch: { voiceTranscription: true } } }).done;
  assert.equal(response.status, 409); assert.equal(response.body.code, 'BUSY');
  response = await f.call('apply', { method: 'POST', body: {} }).done;
  assert.equal(response.status, 409);
  assert.equal(f.state.applyCalls, 0);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
  f.state.applying = false;
  fs.writeFileSync(f.configFile, JSON.stringify({ maxListenSeconds: 4, onebotAccessToken: SECRET }));
  response = await f.call('apply', { method: 'POST', body: {} }).done;
  assert.equal(response.status, 400); assert.equal(response.body.code, 'INVALID_CONFIG'); clean(response);
  assert.ok(response.body.validationErrors.some((error) => error.field === 'maxListenSeconds'));
  assert.equal(f.state.applyCalls, 0);
});

test('unavailable reload and unexpected runtime failure are reported without private exception text', async (t) => {
  const unavailable = fixture(t, { noApply: true });
  let response = await unavailable.call('apply', { method: 'POST', body: {} }).done;
  assert.equal(response.status, 503); assert.equal(response.body.code, 'UNAVAILABLE'); clean(response);
  const failed = fixture(t, { apply() { throw new Error(SECRET); } });
  response = await failed.call('apply', { method: 'POST', body: {} }).done;
  assert.equal(response.status, 500); assert.equal(response.body.code, 'INTERNAL_ERROR'); clean(response);
});

test('owner revoked while a POST body is arriving cannot save or apply', async (t) => {
  for (const endpoint of ['config', 'apply']) {
    const f = fixture(t), before = fs.readFileSync(f.configFile, 'utf8'), abort = new AbortController();
    f.setPeer({ principal: { kind: 'owner' }, signal: abort.signal });
    const request = new Readable({ read() {} });
    const requestState = f.call(endpoint, { method: 'POST', request });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    request.push(JSON.stringify(endpoint === 'config' ? { revision: f.store.snapshot().revision,
      patch: { voiceTranscription: true } } : {})); request.push(null);
    const response = await requestState.done;
    assert.equal(response.status, 403); clean(response);
    assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
    assert.equal(f.state.applyCalls, 0);
  }
});

test('unloading unregisters all routes and revokes captured handlers and an in-flight POST', async (t) => {
  const f = fixture(t), original = fs.readFileSync(f.configFile, 'utf8');
  const capturedState = f.routes.get(PREFIX + 'state');
  const request = new Readable({ read() {} });
  const saving = f.call('config', { method: 'POST', request });
  await new Promise((resolve) => setImmediate(resolve));
  await f.registration.dispose();
  assert.equal(f.registration.registered, false);
  assert.equal(f.routes.size, 0);
  assert.deepEqual(f.cleanup.slice().sort(), ENDPOINTS.map((name) => PREFIX + name).sort());
  request.push(JSON.stringify({ revision: f.store.snapshot().revision, patch: { voiceTranscription: true } })); request.push(null);
  const response = await saving.done;
  assert.notEqual(response.status, 200); clean(response);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
  const after = await invoke(capturedState).done;
  assert.notEqual(after.status, 200); clean(after);
  await f.registration.dispose();
  assert.equal(f.cleanup.length, ENDPOINTS.length);
});

test('partial webServer.register failure removes earlier routes and revokes their retained handlers', async (t) => {
  const f = fixture(t, { failAfter: 1 });
  assert.equal(f.routes.size, 0);
  assert.equal(f.cleanup.length, 1);
  assert.equal(f.registration?.registered === true, false);
  assert.equal(f.captured.length, 1);
  const response = await invoke(f.captured[0].handler).done;
  assert.notEqual(response.status, 200); clean(response);
  assert.equal(f.state.stateReads, 0);
});

test('owner library endpoints use fixed services, bounded query envelopes and no-store binary images', async (t) => {
  const requests = [], bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const f = fixture(t, { napcat: { status: async () => ({ configured: true, login: { isLogin: true } }),
    qrcode: async (input, options) => { assert.equal(options.authorize(), true); requests.push(input); return { available: false, code: 'ALREADY_LOGGED_IN' }; } },
    library: { listMemes: async (input) => { requests.push(input); return { items: [], total: 0 }; },
      memeImage: async (id) => { requests.push(id); return { mime: 'image/png', bytes }; },
      persona: () => ({ text: 'fixture role', revision: 'fixture-revision', editable: true }),
      savePersona: (input) => ({ ...input, appliesNextTurn: true }) } });
  let response = await f.call('napcat/status').done;
  assert.equal(response.body.napcat.login.isLogin, true);
  response = await f.call('napcat/qrcode', { method: 'POST', body: { refresh: false } }).done;
  assert.equal(response.body.qrcode.available, false);
  assert.deepEqual(requests.shift(), { refresh: false });
  response = await f.call('memes', { url: PREFIX + 'memes?query=%E9%B1%BC&offset=24&limit=12' }).done;
  assert.deepEqual(requests.shift(), { query: '鱼', offset: 24, limit: 12 });
  response = await f.call('meme-image', { url: PREFIX + 'meme-image?id=opaque', binary: true }).done;
  assert.deepEqual(response.body, bytes);
  assert.equal(requests.shift(), 'opaque');
  assert.equal(response.headers['Content-Type'], 'image/png');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal((await f.call('persona').done).body.persona.text, 'fixture role');
  response = await f.call('persona', { method: 'POST', body: { text: 'new role', revision: 'fixture-revision' } }).done;
  assert.equal(response.body.persona.appliesNextTurn, true);
  for (const url of ['memes?path=/tmp', 'memes?limit=24&limit=12', 'memes?offset=-1', 'memes?offset=', 'meme-image?id=x&path=/tmp']) {
    response = await f.call(url.split('?')[0], { url: PREFIX + url }).done;
    assert.equal(response.status, 400);
  }
  for (const body of [{ refresh: 'true' }, { refresh: true, token: SECRET }]) {
    response = await f.call('napcat/qrcode', { method: 'POST', body }).done;
    assert.equal(response.status, 400); clean(response);
  }
});

test('revocation while loading private images or persona prevents their response', async (t) => {
  for (const endpoint of ['persona', 'meme-image', 'napcat/qrcode']) {
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    const f = fixture(t, { library: { persona: () => delayed, memeImage: () => delayed },
      napcat: { qrcode: (_input, options) => delayed.then(() => ({ available: options.authorize(), image: { base64: SECRET } })) } });
    const pending = f.call(endpoint, { ...(endpoint === 'napcat/qrcode' ? { method: 'POST', body: {} } : {}), url: PREFIX + endpoint + '?id=fixture' });
    await new Promise((resolve) => setImmediate(resolve));
    f.setPeer({ principal: { kind: 'api' } });
    release(endpoint === 'meme-image' ? { mime: 'image/png', bytes: Buffer.from(SECRET) } : { text: SECRET });
    const response = await pending.done;
    assert.equal(response.status, 403); clean(response);
  }
});

test('persona changes are blocked during active QQ replies or runtime apply', async (t) => {
  let writes = 0;
  const f = fixture(t, { library: { savePersona: () => { writes++; return {}; } } });
  f.state.pending = 1;
  let response = await f.call('persona', { method: 'POST', body: { text: 'fixture', revision: 'revision' } }).done;
  assert.equal(response.status, 409);
  f.state.pending = 0; f.state.applying = true;
  response = await f.call('persona', { method: 'POST', body: { text: 'fixture', revision: 'revision' } }).done;
  assert.equal(response.status, 409);
  assert.equal(writes, 0);
});

test('control center dispatches model, speech, voice and component actions to their fixed services', async (t) => {
  const calls = [];
  const action = (name, result = {}) => async (body, options) => {
    if (options) assert.equal(options.authorize(), true);
    calls.push({ name, body }); return result;
  };
  const f = fixture(t, { model: { snapshot: action('model/status'), save: action('model/config'),
    probe: action('model/probe', { ok: true, probe: { ok: true } }), testConnection: action('model/test', { ok: true, test: { ok: true } }), saveSelection: action('model/selection'),
    saveSpeechSelection: action('speech/selection'), prepareSpeech: action('speech/prepare') },
  dependencies: { snapshot: () => ({ items: [], busy: false }), check: action('dependencies/check'), action: action('dependencies/action', { accepted: true }) },
  voice: { snapshot: () => ({ config: {} }), save: action('voice/config'), test: action('voice/check', { ok: true }) },
  diagnostics: { phone: () => ({ enabled: false, state: 'disabled' }), checkPhone: action('phone/check'), connectPhone: action('phone/connect') } });
  assert.equal((await f.call('model/status').done).status, 200);
  assert.equal((await f.call('dependencies').done).status, 200);
  assert.equal((await f.call('voice/status').done).status, 200);
  for (const [endpoint, body] of [['model/config', { provider: 'fixture' }], ['model/probe', { provider: 'fixture' }], ['model/test', { provider: 'fixture', model: 'fixture' }],
    ['model/selection', { provider: 'fixture', model: 'fixture' }], ['speech/selection', { providerId: 'fixture' }],
    ['speech/prepare', { providerId: 'fixture' }], ['dependencies/action', { id: 'fixture', action: 'install' }],
    ['dependencies/check', { updates: true }], ['voice/config', { patch: {} }], ['voice/check', {}], ['phone/check', {}], ['phone/connect', {}]]) {
    const response = await f.call(endpoint, { method: 'POST', body }).done;
    assert.equal(response.status, 200, endpoint);
    assert.ok(calls.some((call) => call.name === endpoint), endpoint);
  }
  assert.equal(f.state.applyCalls, 0, 'service actions must never fall through to companion reload');
  assert.equal((await f.call('model/rebind', { method: 'POST', body: {} }).done).status, 200);
  assert.equal(f.state.applyCalls, 1);
  for (const [endpoint, body] of [['dependencies/check', { updates: 'true' }], ['voice/check', { text: SECRET }],
    ['phone/check', { device: 'arbitrary' }], ['phone/connect', { device: 'arbitrary' }], ['model/rebind', { patch: {} }]]) {
    const response = await f.call(endpoint, { method: 'POST', body }).done;
    assert.equal(response.status, 400); clean(response);
  }
});

test('phone connection routes share the diagnostics gate and expose busy state without triggering reload', async (t) => {
  let release; const pending = new Promise((resolve) => { release = resolve; });
  const phone = { enabled: true, device: 'fixture-phone:5555', adbPath: '/fixture/adb' }, calls = [];
  const diagnostics = new RuntimeDiagnostics({ getRuntime: () => ({ phoneTools: phone }),
    execFileImpl: async (...args) => { calls.push(args); return pending; } });
  t.after(() => diagnostics.dispose());
  const f = fixture(t, { diagnostics });
  f.state.pending = 1;
  assert.equal((await f.call('phone/connect', { method: 'POST', body: {} }).done).status, 409);
  assert.equal(calls.length, 0);
  f.state.pending = 0;
  const running = f.call('phone/connect', { method: 'POST', body: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const state = await f.call('state').done;
  assert.equal(state.body.runtime.busy, true); assert.equal(state.body.runtime.phone.checking, true);
  for (const endpoint of ['phone/check', 'phone/connect', 'apply']) {
    const response = await f.call(endpoint, { method: 'POST', body: {} }).done;
    assert.equal(response.status, 409, endpoint); assert.equal(response.body.code, 'BUSY');
  }
  assert.equal(calls.length, 1); assert.equal(f.state.applyCalls, 0);
  release({ stdout: 'device', stderr: SECRET });
  const response = await running.done;
  assert.equal(response.status, 200); clean(response);
  assert.equal(response.body.ok, true); assert.equal(response.body.state.runtime.phone.state, 'online');
  assert.equal(response.body.state.runtime.phone.checking, false); assert.equal(response.body.state.runtime.busy, false);
  assert.deepEqual(calls.map(([, args]) => args), [['connect', 'fixture-phone:5555'], ['-s', 'fixture-phone:5555', 'get-state']]);
});

test('owner revocation or panel unload during connect prevents verification and a private state response', async (t) => {
  for (const mode of ['revoke', 'unload']) {
    let release; const pending = new Promise((resolve) => { release = resolve; });
    const phone = { enabled: true, device: 'fixture-phone:5555', adbPath: '/fixture/adb' }, calls = [];
    const diagnostics = new RuntimeDiagnostics({ getRuntime: () => ({ phoneTools: phone }),
      execFileImpl: async (...args) => { calls.push(args); return pending; } });
    t.after(() => diagnostics.dispose());
    const f = fixture(t, { diagnostics });
    const running = f.call('phone/connect', { method: 'POST', body: {} });
    await new Promise((resolve) => setImmediate(resolve));
    if (mode === 'revoke') f.setPeer({ principal: { kind: 'api' } });
    else await f.registration.dispose();
    release({ stdout: 'connected', stderr: SECRET });
    const response = await running.done;
    assert.equal(response.status, 403); clean(response); assert.equal(calls.length, 1);
    assert.equal(diagnostics.phone().checkedAt, null); assert.equal(f.state.applyCalls, 0);
  }
});

test('meme detail, metadata edit and browser import dispatch with owner authority and a busy guard', async (t) => {
  const calls = [], f = fixture(t, { library: {
    memeDetail: async (id, options) => { assert.equal(options.authorize(), true); calls.push(['detail', id]); return { id, revision: 'fixture' }; },
    saveMemeMetadata: async (body, options) => { assert.equal(options.authorize(), true); assert.equal(options.getBusy(), false); calls.push(['edit', body]); return { id: body.id, description: body.patch.description }; },
    importMeme: async (body, options) => { assert.equal(options.authorize(), true); assert.equal(options.getBusy(), false); calls.push(['import', body]); return { id: 'new', imported: true }; },
  } });
  let response = await f.call('meme-detail', { url: PREFIX + 'meme-detail?id=opaque' }).done;
  assert.equal(response.status, 200); assert.equal(response.body.meme.id, 'opaque');
  response = await f.call('meme-metadata', { method: 'POST', body: { id: 'opaque', revision: 'fixture', patch: { description: '鲸鱼点头，表示同意。' } } }).done;
  assert.equal(response.status, 200); assert.equal(response.body.meme.description, '鲸鱼点头，表示同意。');
  response = await f.call('memes/import', { method: 'POST', body: { filename: 'hello.png', description: '开心欢迎。', imageBase64: 'A'.repeat(40000) } }).done;
  assert.equal(response.status, 200, 'image import has its own limit above ordinary 32 KiB action requests');
  assert.equal(response.body.meme.imported, true);
  assert.deepEqual(calls.map(([name]) => name), ['detail', 'edit', 'import']);
  assert.equal(f.state.applyCalls, 0);
  for (const endpoint of ['meme-metadata', 'memes/import']) {
    f.state.pending = 1;
    response = await f.call(endpoint, { method: 'POST', body: {} }).done;
    assert.equal(response.status, 409); assert.equal(response.body.code, 'BUSY');
    f.state.pending = 0; f.state.applying = true;
    assert.equal((await f.call(endpoint, { method: 'POST', body: {} }).done).status, 409);
    f.state.applying = false;
    assert.equal((await f.call(endpoint, { method: 'GET' }).done).status, 405);
  }
  assert.equal(calls.length, 3);
  response = await f.call('meme-detail', { url: PREFIX + 'meme-detail?id=x&id=y' }).done;
  assert.equal(response.status, 400);
  response = await f.call('meme-detail', { url: PREFIX + 'meme-detail?id=x&path=/tmp/private' }).done;
  assert.equal(response.status, 400);
});

test('upload JSON is bounded independently and malformed requests never reach the library', async (t) => {
  let writes = 0;
  const f = fixture(t, { library: { importMeme: () => { writes++; return {}; }, saveMemeMetadata: () => { writes++; return {}; } } });
  for (const options of [{ body: '{invalid' }, { body: [] }, { body: null }, { body: {}, contentType: 'text/plain' },
    { chunks: ['{"imageBase64":"', 'A'.repeat(12 * 1024 * 1024), '"}'] }]) {
    const response = await f.call('memes/import', { method: 'POST', ...options }).done;
    assert.equal(response.status, 400); clean(response);
  }
  const ordinary = await f.call('meme-metadata', { method: 'POST', body: { patch: { description: 'a'.repeat(40000) } } }).done;
  assert.equal(ordinary.status, 400);
  assert.equal(writes, 0);
});

test('owner revocation or runtime replacement during an upload cannot write to a different library', async (t) => {
  for (const mode of ['revoke', 'runtime', 'manager']) {
    let writes = 0;
    const f = fixture(t, { library: { importMeme: () => { writes++; return {}; }, saveMemeMetadata: () => { writes++; return {}; } } });
    for (const endpoint of ['meme-metadata', 'memes/import']) {
      const request = new Readable({ read() {} }), original = f.controller.getRuntime();
      const pending = f.call(endpoint, { method: 'POST', request });
      await new Promise((resolve) => setImmediate(resolve));
      if (mode === 'revoke') f.setPeer({ principal: { kind: 'api' } });
      else if (mode === 'runtime') f.controller.getRuntime = () => ({ ...original });
      else original.memeManager = {};
      request.push('{}'); request.push(null);
      const response = await pending.done;
      assert.equal(response.status, mode === 'revoke' ? 403 : 409); clean(response);
      f.setPeer(ownerPeer()); f.controller.getRuntime = () => original;
    }
    assert.equal(writes, 0);
  }
});

test('delayed meme responses are suppressed after revocation or a running library change', async (t) => {
  for (const endpoint of ['meme-detail', 'meme-metadata', 'memes/import']) {
    for (const mode of ['revoke', 'runtime']) {
      let release; const wait = new Promise((resolve) => { release = resolve; });
      const f = fixture(t, { library: { memeDetail: () => wait, saveMemeMetadata: () => wait, importMeme: () => wait } });
      const pending = f.call(endpoint, { method: endpoint === 'meme-detail' ? 'GET' : 'POST', body: {}, url: PREFIX + endpoint + '?id=opaque' });
      await new Promise((resolve) => setImmediate(resolve));
      if (mode === 'revoke') f.setPeer({ principal: { kind: 'api' } });
      else f.controller.getRuntime = () => null;
      release({ description: SECRET });
      const response = await pending.done;
      assert.equal(response.status, mode === 'revoke' ? 403 : 409); clean(response);
    }
  }
});

test('actual owner routes import, read, edit, search and reload description sidecars without path exposure', async (t) => {
  const f = fixture(t), runtime = f.controller.getRuntime();
  runtime.memeManager = new MemeManager({ desktopMemeDir: path.join(f.root, 'fixture-gallery') });
  f.controller.library = new PanelLibrary({ getRuntime: () => f.controller.getRuntime() });
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
  let response = await f.call('memes/import', { method: 'POST', body: {
    filename: 'wave.png', title: '挥手', tags: ['问好'], description: '鲸鱼挥动小鳍，表示开心欢迎。',
    aiDescription: '适合熟人间轻松问候。', imageBase64,
  } }).done;
  assert.equal(response.status, 200); assert.equal(response.body.meme.imported, true);
  const added = response.body.meme;
  assert.equal(response.text.includes(f.root), false);
  response = await f.call('memes/import', { method: 'POST', body: {
    filename: 'same-image.png', title: '新标题不应覆盖', tags: ['新标签不应合并'], description: '重复上传不会覆盖精修描写。', imageBase64,
  } }).done;
  assert.equal(response.status, 200); assert.equal(response.body.meme.imported, false);
  assert.equal(response.body.meme.duplicate, true);
  assert.equal(response.body.meme.revision, added.revision);
  assert.equal(response.body.meme.title, added.title);
  assert.deepEqual(response.body.meme.tags, added.tags);
  assert.equal(response.body.meme.description, added.description);
  assert.match(response.body.meme.note, /保留原有描写/);
  response = await f.call('meme-detail', { url: PREFIX + 'meme-detail?id=' + added.id }).done;
  assert.equal(response.status, 200); assert.equal(response.body.meme.aiDescription, '适合熟人间轻松问候。');
  response = await f.call('meme-metadata', { method: 'POST', body: {
    id: added.id, revision: added.revision, patch: { description: '鲸鱼轻轻点头，表示同意或鼓励。' },
  } }).done;
  assert.equal(response.status, 200); assert.equal(response.body.meme.descriptionStatus, 'ready');
  response = await f.call('meme-metadata', { method: 'POST', body: {
    id: added.id, revision: added.revision, patch: { description: '旧版本不能覆盖' },
  } }).done;
  assert.equal(response.status, 409); assert.equal(response.body.code, 'CONFLICT');
  response = await f.call('memes', { url: PREFIX + 'memes?query=' + encodeURIComponent('同意 熟人') }).done;
  assert.equal(response.status, 200); assert.equal(response.body.gallery.total, 1);
  assert.equal(response.body.gallery.items[0].description, '鲸鱼轻轻点头，表示同意或鼓励。');
  assert.equal(response.text.includes(f.root), false);
  const reloaded = new MemeManager({ desktopMemeDir: runtime.memeManager.desktopMemeDir });
  assert.equal(reloaded.getMetadata(added.file).description, '鲸鱼轻轻点头，表示同意或鼓励。');
  response = await f.call('memes/import', { method: 'POST', body: { filename: '../private.png', title: '', description: '含义', imageBase64 } }).done;
  assert.equal(response.status, 400); clean(response);
  assert.equal(f.state.applyCalls, 0);
});

test('platform account route snapshot is owner-only and does not start a driver', async t => {
  const f = fixture(t); let probes = 0;
  f.runtime.socialAccounts = { snapshot: () => ({ revision: 'fixture', platforms: [], operations: [] }), startLogin() { probes++; } };
  const result = await f.call('social/accounts').done;
  assert.equal(result.status, 200); assert.equal(result.body.accounts.revision, 'fixture'); assert.equal(probes, 0);
  f.setPeer({ principal: { kind: 'guest' } });
  assert.equal((await f.call('social/accounts').done).status, 403); assert.equal(probes, 0);
});

test('platform login slow body cannot migrate to a replacement runtime', async t => {
  const f = fixture(t); let starts = 0;
  const accounts = { startLogin: async () => { starts++; return {}; }, snapshot: () => ({ platforms: [], operations: [] }) };
  f.runtime.socialAccounts = accounts;
  let release; const gate = new Promise(resolve => release = resolve);
  async function* chunks() { yield '{"platform":"x"'; await gate; yield '}'; }
  const pending = f.call('social/login/start', { method: 'POST', chunks: chunks() });
  await new Promise(resolve => setImmediate(resolve)); f.setRuntime({ socialAccounts: accounts }); release();
  const result = await pending.done; assert.equal(result.status, 403); assert.equal(starts, 0);
});

test('platform route revocation during a driver suppresses private results and exposes only safe error copy', async t => {
  const f = fixture(t); let release; const gate = new Promise(resolve => release = resolve);
  f.runtime.socialAccounts = { async read() { await gate; return { private: SECRET }; }, snapshot: () => ({ platforms: [], operations: [] }) };
  const pending = f.call('social/read', { method: 'POST', body: { platform: 'bilibili', request: { operation: 'profile' } } });
  await new Promise(resolve => setImmediate(resolve)); f.setPeer({ principal: { kind: 'guest' } }); release();
  const result = await pending.done; assert.equal(result.status, 403); clean(result);
});
