import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContextGuard } from '../packages/dsh-dafeiyu/src/context-guard.js';
import { estimateContextRequest } from '../packages/dsh-dafeiyu/src/context-request-size.js';
import { createTokenUsageBridge } from '../packages/dsh-dafeiyu/src/token-usage-bridge.js';
import { createDesktopContextControl, writeDesktopContextMaintenanceHold } from '../packages/dsh-dafeiyu/src/desktop-context-control.js';

const yes = () => true, no = () => false;
const now = () => Date.parse('2026-10-27T00:00:00Z');
const contextWindow = 1048576;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fixedError = { code: 'UNKNOWN', message: '上下文保护已暂停后续模型调用；原请求未自动重跑' };

function fixture(t, { initialize = true, messages, header, sessionId = 'fixture-desktop', maxTokens = 256000 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-context-fixture-'));
  const file = path.join(directory, 'desktop-context.private.json');
  const agents = new Map(), listeners = new Map(); let open = true, owner = true, calls = 0, hookGate;
  const sampleHeader = header || { config: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max', maxTokens },
    tools: [{ name: 'fixture-tool', description: 'schema'.repeat(5000) }] };
  const agent = { id: sessionId, phase: 'idle', get status() { return this.phase === 'turn' ? 'running' : 'idle'; },
    inbox: { nextTurn: [], nextStep: [], get hasPending() { return Boolean(this.nextTurn.length || this.nextStep.length); } },
    session: { id: sessionId, header: { id: sessionId }, seq: 58, requestHeader() { return sampleHeader; },
      messages: messages || [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE_FIXTURE:'.repeat(46000) }] }],
      deriveMessages() { return this.messages; }, toolHistory() { return { tools: sampleHeader.tools, updates: [] }; },
      requestContext() { return { provider: 'fixture-provider', model: 'fixture-model', contextWindow }; } },
    async runMaintenance(job) { if (this.phase !== 'idle') throw Object.assign(Error('busy fixture'), { code: 'BUSY' }); this.phase = 'maintenance';
      try { return await job(); } finally { this.phase = 'idle'; } } };
  agents.set(sessionId, agent);
  const llm = {
    async resolveModelInfo(provider, model) { calls++; if (hookGate) await hookGate(); return { provider, id: model, context: { contextWindow }, defaultMaxTokens: 256000 }; },
    async resolveCallConfig(config) { return { ...config }; },
  };
  const ctx = { get: name => name === 'agents' ? agents : name === 'llm' ? llm : undefined,
    on(name, callback, options) { if (!listeners.has(name)) listeners.set(name, []); const row = { callback, options };
      if (options?.prepend) listeners.get(name).unshift(row); else listeners.get(name).push(row);
      return () => { listeners.set(name, listeners.get(name).filter(value => value !== row)); }; } };
  const events = [{ seq: 14, type: 'request/header', data: { header: sampleHeader } },
    { seq: 50, type: 'turn/start', data: { turn: 3 } }, { seq: 55, type: 'assistant/attempt', data: {} },
    { seq: 57, type: 'turn/end', data: { turn: 3, reason: { kind: 'error', error: fixedError } } }];
  const maintenanceInput = { directory, sessionId, expectedSeq: 58, header: sampleHeader, events,
    capacityEvidence: { inputTokens: 750000, outputTokens: maxTokens, contextWindow }, acknowledgeNoReplay: true };
  if (initialize) writeDesktopContextMaintenanceHold(maintenanceInput, { authorize: yes, now });
  const instances = [];
  const build = () => {
    const control = createDesktopContextControl({ ctx, directory, trustedSessionIds: [sessionId],
      getExecutionContext: () => ({ isOwner: owner, trusted: true, scope: 'desktop' }), isOpen: () => open, now });
    const guard = createContextGuard({ ctx, now, persistence: control.persistence }); control.attachGuard(guard);
    const instance = { control, guard }; instances.push(instance); return instance;
  };
  const first = build();
  const options = patch => ({ ...sampleHeader.config, sessionId, messages: agent.session.deriveMessages(), tools: sampleHeader.tools,
    toolHistory: agent.session.toolHistory(), ...patch });
  const waterfall = async (target = agent, config = sampleHeader.config) => {
    const rows = [...listeners.get('agent/request') || []];
    const run = index => index === rows.length ? Promise.resolve(config) : rows[index].callback({ agent: target, signal: new AbortController().signal }, () => run(index + 1));
    return run(0);
  };
  const preview = (control = first.control) => control.preview({ sessionId, expectedSeq: agent.session.seq, maxTokens: 8192 }, { authorize: yes });
  const recover = (value, control = first.control, authorize = yes) => control.recover({ sessionId, previewId: value.previewId, acknowledgeNoReplay: true }, { authorize });
  t.after(() => { for (const instance of instances) { instance.guard.dispose(); instance.control.dispose(); } fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, agent, agents, llm, ctx, events, sampleHeader, maintenanceInput, ...first, build, options, waterfall, preview, recover,
    setOwner(value) { owner = value; }, setOpen(value) { open = value; }, setGate(value) { hookGate = value; }, get calls() { return calls; } };
}

test('maintenance migration holds every purpose across reload and owner snapshots never probe or write', async t => {
  const f = fixture(t), before = fs.readFileSync(f.file), status = f.control.snapshot();
  assert.equal(status.enabled, true); assert.equal(status.sessions[0].holdKind, 'maintenance-migration'); assert.equal(status.sessions[0].paused, true);
  for (const purpose of [undefined, 'title', 'compaction']) await assert.rejects(f.guard.beforeDispatch(f.options({ purpose })), { code: 'CONTEXT_CAPACITY_REQUIRED' });
  assert.equal(f.calls, 0); assert.deepEqual(fs.readFileSync(f.file), before);
  const loaded = f.build(); assert.equal(loaded.guard.failureFor(f.agent).kind, 'maintenance-migration');
  await assert.rejects(loaded.guard.beforeDispatch(f.options()), { code: 'CONTEXT_CAPACITY_REQUIRED' });
});

test('preview counts the unchanged complete request; explicit recovery caps future waterfall without replay or header mutation', async t => {
  const f = fixture(t), before = fs.readFileSync(f.file), header = JSON.stringify(f.sampleHeader);
  const value = await f.preview();
  const exact = estimateContextRequest(f.options({ maxTokens: 8192 }));
  assert.equal(value.sessionId, f.agent.id); assert.equal(value.inputTokens, exact.inputTokens); assert.equal(value.outputTokens, 8192);
  assert.equal(value.totalTokens, exact.inputTokens + 8192); assert.equal(value.limitTokens, Math.floor(contextWindow * .9));
  assert.equal(value.automaticReplay, false); assert.equal(value.allowed, true); assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal((await f.waterfall()).maxTokens, 256000, 'preview does not install the policy');
  assert.equal(f.guard.failureFor(f.agent).kind, 'maintenance-migration');
  const result = await f.recover(value); assert.deepEqual(result, { ok: true, recovered: true, maxTokens: 8192, automaticReplay: false });
  assert.equal(f.guard.failureFor(f.agent), null); assert.equal((await f.waterfall()).maxTokens, 8192);
  assert.equal(JSON.stringify(f.sampleHeader), header, 'only the real host may append a later request/header');
  assert.deepEqual(f.agent.inbox.nextTurn, []); assert.deepEqual(f.agent.inbox.nextStep, []);
  const text = fs.readdirSync(f.directory).filter(name => name.endsWith('.json')).map(name => fs.readFileSync(path.join(f.directory, name), 'utf8')).join('');
  assert.equal(text.includes('PRIVATE_FIXTURE'), false); assert.equal(text.includes('schema'.repeat(10)), false);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).sessions[0].reviews.length, 1);
  assert.equal(fs.statSync(path.join(f.directory, fs.readdirSync(f.directory).find(name => name.startsWith('context-review-')))).mode & 0o777, 0o400);
  await assert.rejects(f.recover(value), { code: 'CONFLICT' });
});

test('a restored output policy is applied and checked again against exact final options', async t => {
  const f = fixture(t), value = await f.preview(); await f.recover(value);
  const loaded = f.build();
  assert.equal(loaded.control.snapshot().sessions[0].maxTokens, 8192);
  assert.equal((await f.waterfall(f.agent, { ...f.sampleHeader.config, maxTokens: 4096 })).maxTokens, 4096);
  await assert.rejects(loaded.guard.beforeDispatch(f.options({ maxTokens: 256000 })), { code: 'CONTEXT_GUARD_UNAVAILABLE' });
  assert.equal(loaded.guard.failureFor(f.agent).code, 'CONTEXT_GUARD_UNAVAILABLE');
  assert.equal(f.build().guard.failureFor(f.agent).code, 'CONTEXT_GUARD_UNAVAILABLE');
});

test('known successful admission settles its durable intent; interrupted admission reloads into a hold', async t => {
  const f = fixture(t); await f.recover(await f.preview());
  const request = f.options({ maxTokens: 8192 }); await f.guard.beforeDispatch(request);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).sessions[0].pending.length, 1);
  assert.equal(f.guard.failureFor(f.agent), null, 'a live local admission is not an interrupted old worker');
  f.guard.onDispatch(request); f.guard.onSettlement(request, { status: 'completed', finishReason: 'stop' });
  assert.equal(JSON.parse(fs.readFileSync(f.file)).sessions[0].pending.length, 0);
  const other = f.options({ maxTokens: 8192 }); await f.guard.beforeDispatch(other);
  const loaded = f.build(); assert.equal(loaded.guard.failureFor(f.agent).kind, 'interrupted-admission');
  await assert.rejects(loaded.guard.beforeDispatch(f.options({ purpose: 'compaction', maxTokens: 8192 })), { code: 'CONTEXT_GUARD_UNAVAILABLE' });
  await assert.rejects(f.preview(loaded.control), { code: 'CONTEXT_RECOVERY_REQUIRED' });
});

test('new capacity failures persist and normal local rejection closes only its own unstarted intent', async t => {
  const f = fixture(t); await f.recover(await f.preview());
  f.agent.session.messages = [{ role: 'user', content: [{ type: 'text', text: 'larger'.repeat(180000) }] }];
  await assert.rejects(f.guard.beforeDispatch(f.options({ maxTokens: 8192 })), { code: 'CONTEXT_CAPACITY_REQUIRED' });
  const state = JSON.parse(fs.readFileSync(f.file)); assert.equal(state.sessions[0].pending.length, 0);
  assert.equal(state.sessions[0].failure.kind, 'guard');
  assert.equal(f.build().guard.failureFor(f.agent).code, 'CONTEXT_CAPACITY_REQUIRED');
});

test('missing, corrupt, permissive and symlinked state fails closed without metadata; it never impacts foreign or QQ Agents', async t => {
  for (const kind of ['missing', 'corrupt', 'permissions', 'symlink']) {
    const f = fixture(t);
    if (kind === 'missing') fs.unlinkSync(f.file);
    if (kind === 'corrupt') fs.writeFileSync(f.file, '{PRIVATE_BAD_STATE');
    if (kind === 'permissions') fs.chmodSync(f.file, 0o644);
    if (kind === 'symlink') { fs.renameSync(f.file, f.file + '.old'); fs.symlinkSync(f.file + '.old', f.file); }
    const loaded = f.build();
    await assert.rejects(loaded.guard.beforeDispatch(f.options()), { code: 'CONTEXT_GUARD_UNAVAILABLE' });
    assert.equal(loaded.control.snapshot().enabled, false); assert.equal(f.calls, 0);
    const other = { ...f.agent, id: 'fixture-qq', session: { ...f.agent.session, id: 'fixture-qq', header: { id: 'fixture-qq' } } };
    f.agents.set(other.id, other);
    assert.equal(loaded.persistence, undefined);
    const options = { ...f.options({ maxTokens: 100 }), sessionId: other.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'short' }] }], tools: [], toolHistory: undefined };
    await loaded.guard.beforeDispatch(options); assert.equal(loaded.guard.failureFor(other), null);
  }
});

test('owner, runtime, sequence, inbox and failure changes during an awaited preview preserve the hold', async t => {
  for (const kind of ['owner', 'runtime', 'sequence', 'inbox', 'failure']) {
    const f = fixture(t), entered = deferred(), release = deferred(), before = fs.readFileSync(f.file);
    f.setGate(async () => { entered.resolve(); await release.promise; });
    const promise = f.preview(); await entered.promise;
    if (kind === 'owner') f.setOwner(false);
    if (kind === 'runtime') f.setOpen(false);
    if (kind === 'sequence') f.agent.session.seq++;
    if (kind === 'inbox') f.agent.inbox.nextTurn.push({ id: 'new-unconsumed-input' });
    if (kind === 'failure') { const state = JSON.parse(fs.readFileSync(f.file)); state.sessions[0].failure.id = '11111111-1111-1111-1111-111111111111'; fs.writeFileSync(f.file, JSON.stringify(state)); }
    release.resolve(); await assert.rejects(promise);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).sessions[0].failure !== null, true);
    if (kind !== 'failure') assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(f.agent.inbox.nextTurn.length, kind === 'inbox' ? 1 : 0);
  }
});

test('recovery rechecks authorization and CAS after preview and after its second metadata await', async t => {
  for (const kind of ['revoke-before', 'revoke-await', 'sequence', 'header', 'disk', 'queued', 'agent-replaced']) {
    const f = fixture(t), preview = await f.preview(), entered = deferred(), release = deferred(); let authorized = true;
    if (kind === 'revoke-before') authorized = false;
    if (kind === 'sequence') f.agent.session.seq++;
    if (kind === 'header') f.sampleHeader.config.reasoningEffort = 'different';
    if (kind === 'disk') { const data = JSON.parse(fs.readFileSync(f.file)); data.revision = '11111111-1111-1111-1111-111111111111'; fs.writeFileSync(f.file, JSON.stringify(data)); }
    if (kind === 'queued') f.agent.inbox.nextStep.push({ id: 'new-input' });
    if (kind === 'agent-replaced') f.agents.set(f.agent.id, { ...f.agent });
    if (kind === 'revoke-await') f.setGate(async () => { entered.resolve(); await release.promise; });
    const pending = f.recover(preview, f.control, () => authorized);
    if (kind === 'revoke-await') { await entered.promise; authorized = false; release.resolve(); }
    await assert.rejects(pending);
    const row = JSON.parse(fs.readFileSync(f.file)).sessions[0]; assert.notEqual(row.failure, null); assert.equal(row.policy, null);
  }
});

test('invalid schema, unknown sessions, stale expectedSeq and an external maintenance lock never recover', async t => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  for (const body of [
    { sessionId: f.agent.id, expectedSeq: 58, maxTokens: 256000 },
    { sessionId: f.agent.id, maxTokens: 8192 },
    { sessionId: f.agent.id, expectedSeq: 58, maxTokens: 8192, replay: true },
    { sessionId: 'other', expectedSeq: 58, maxTokens: 8192 },
    { sessionId: f.agent.id, expectedSeq: 57, maxTokens: 8192 },
  ]) await assert.rejects(f.control.preview(body, { authorize: yes }));
  const holding = deferred(), entered = deferred();
  const lock = f.agent.runMaintenance(async () => { entered.resolve(); await holding.promise; }); await entered.promise;
  assert.equal(f.agent.status, 'idle'); await assert.rejects(f.preview(), { code: 'BUSY' }); holding.resolve(); await lock;
  const preview = await f.preview();
  await assert.rejects(f.control.recover({ sessionId: f.agent.id, previewId: preview.previewId, acknowledgeNoReplay: false }, { authorize: yes }), { code: 'INVALID_PATCH' });
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('maintenance helper requires real stopped-turn and capacity evidence and cannot overwrite another hold', t => {
  const f = fixture(t, { initialize: false });
  for (const patch of [
    { acknowledgeNoReplay: false }, { expectedSeq: 59 }, { capacityEvidence: { inputTokens: 1, outputTokens: 256000, contextWindow } },
    { events: [...f.events.slice(0, -1), { seq: 56, type: 'tool/call', data: {} }, f.events.at(-1)] },
    { events: f.events.map(value => value.type === 'turn/end' ? { ...value, data: { reason: { kind: 'completed' } } } : value) },
    { header: { ...f.sampleHeader, config: { ...f.sampleHeader.config, model: 'other' } } },
  ]) assert.throws(() => writeDesktopContextMaintenanceHold({ ...f.maintenanceInput, ...patch }, { authorize: yes, now }));
  assert.equal(fs.existsSync(f.file), false);
  assert.throws(() => writeDesktopContextMaintenanceHold(f.maintenanceInput, { authorize: no, now }), { code: 'FORBIDDEN' });
  const result = writeDesktopContextMaintenanceHold(f.maintenanceInput, { authorize: yes, now }); assert.equal(result.held, true);
  assert.throws(() => writeDesktopContextMaintenanceHold(f.maintenanceInput, { authorize: yes, now }), { code: 'CONFLICT' });
});

test('failed storage cannot clear a held session or silently reset it on reload', async t => {
  const f = fixture(t), preview = await f.preview();
  fs.writeFileSync(f.file + '.lock', 'external-lock');
  await assert.rejects(f.recover(preview), { code: 'BUSY' });
  assert.notEqual(JSON.parse(fs.readFileSync(f.file)).sessions[0].failure, null);
  fs.unlinkSync(f.file + '.lock'); assert.equal(f.build().guard.failureFor(f.agent).kind, 'maintenance-migration');
});

test('post-guard pre-provider exits release their own intent without inventing usage, including revocation and refused started writes', async t => {
  for (const kind of ['cancel', 'owner-revoked', 'binding-changed', 'binding-threw', 'disposed', 'start-rejected', 'start-threw', 'invalid-id']) {
    const f = fixture(t); await f.recover(await f.preview());
    const controller = new AbortController(), writes = []; let providerCalls = 0, resolves = 0, bridge;
    const binding = { scope: { accountId: '20002', identityId: 'default' }, origin: 'user-task', userTaskId: 'fixture-task' };
    let handler;
    // Capture the real middleware callback without invoking any provider.
    const proxy = { get: f.ctx.get, on(name, callback) { if (name === 'llm/stream') handler = callback; return () => {}; } };
    bridge = createTokenUsageBridge({ ctx: proxy,
      async resolveBinding() {
        if (++resolves === 2) {
          if (kind === 'cancel') controller.abort();
          if (kind === 'owner-revoked') { f.setOwner(false); throw Object.assign(Error('fixture revoke'), { code: 'INVALID_USAGE_BINDING' }); }
          if (kind === 'binding-changed') return { ...binding, userTaskId: 'different' };
          if (kind === 'binding-threw') throw Object.assign(Error('fixture change'), { code: 'INVALID_USAGE_BINDING' });
          if (kind === 'disposed') bridge.dispose();
        }
        return binding;
      },
      beforeDispatch: value => f.guard.beforeDispatch(value), onAdmissionAborted: value => f.guard.onAdmissionAborted(value),
      onDispatch: value => f.guard.onDispatch(value), onSettlement: (value, receipt) => f.guard.onSettlement(value, receipt),
      onEvent(value) { if (kind === 'start-rejected') return { allowed: false }; if (kind === 'start-threw') throw Error('fixture refused'); writes.push(value); },
      idFactory: () => kind === 'invalid-id' ? '' : 'fixture-request',
    });
    const request = f.options({ maxTokens: 8192, signal: controller.signal });
    await assert.rejects(async () => { for await (const _ of handler(request, () => { providerCalls++; return []; })) {} });
    bridge.dispose(); f.setOwner(true);
    assert.equal(providerCalls, 0); assert.deepEqual(writes, []);
    const row = JSON.parse(fs.readFileSync(f.file)).sessions[0]; assert.equal(row.pending.length, 0); assert.equal(row.failure, null);
    assert.equal(f.build().guard.failureFor(f.agent), null);
  }
});

test('an incomplete state publication stays held after reload even if a candidate open state is present', async t => {
  const f = fixture(t); await f.recover(await f.preview());
  fs.writeFileSync(f.file + '.pending', 'fixture-interrupted-publication', { mode: 0o600 });
  const loaded = f.build();
  assert.equal(loaded.control.snapshot().enabled, false);
  await assert.rejects(loaded.guard.beforeDispatch(f.options({ maxTokens: 8192 })), { code: 'CONTEXT_GUARD_UNAVAILABLE' });
});

test('a second trusted desktop without an explicit migration row remains held for every purpose', async t => {
  const f = fixture(t), other = { ...f.agent, id: 'fixture-older-desktop',
    session: { ...f.agent.session, id: 'fixture-older-desktop', header: { id: 'fixture-older-desktop' } } };
  f.agents.set(other.id, other);
  const control = createDesktopContextControl({ ctx: f.ctx, directory: f.directory,
    trustedSessionIds: [f.agent.id, other.id], getExecutionContext: () => ({ isOwner: true, scope: 'desktop', trusted: true }), now });
  const guard = createContextGuard({ ctx: f.ctx, persistence: control.persistence, now }); control.attachGuard(guard);
  t.after(() => { guard.dispose(); control.dispose(); });
  const before = fs.readFileSync(f.file);
  assert.equal(control.snapshot().sessions.find(value => value.sessionId === other.id).holdKind, 'unreviewed-migration');
  for (const purpose of [undefined, 'session-title', 'compaction']) await assert.rejects(guard.beforeDispatch({ ...f.options({ purpose }), sessionId: other.id }), { code: 'CONTEXT_GUARD_UNAVAILABLE' });
  await assert.rejects(control.preview({ sessionId: other.id, expectedSeq: other.session.seq, maxTokens: 8192 }, { authorize: yes }), { code: 'CONTEXT_RECOVERY_REQUIRED' });
  assert.equal(f.calls, 0); assert.deepEqual(fs.readFileSync(f.file), before);
});
