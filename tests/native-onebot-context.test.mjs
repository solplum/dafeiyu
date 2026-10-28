import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeOneBotBridge } from '../packages/dsh-dafeiyu/src/native-onebot.js';
import { createNativeTaskExecutor } from '../packages/dsh-dafeiyu/src/native-task-executor.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'fixture did not settle'); await tick(); }
}

function fixture({ send, recovery, dispose } = {}) {
  const events = new Map(), created = [], calls = [], sent = [], faults = new Map(), checked = [], cleared = [];
  let allowed = false;
  const emit = (name, ...args) => { for (const handler of events.get(name) || []) handler(...args); };
  const services = { agentDefaultModel: { currentSelection: () => ({ provider: 'offline', model: 'fixture' }) },
    agentPresets: { async mount() {} }, agents: { async create(options) {
      const record = { disposed: 0, cancelled: 0, calls: [], options };
      const scopedTools = { guard() {}, restrict() {}, schemas: () => [] };
      const agent = { session: { id: options.sessionId }, ctx: { get: name => name === 'tools' ? scopedTools : services[name] },
        cancel() { record.cancelled++; }, followup(message) {
          const call = { agent, message, turn: record.calls.length + 1 }; record.calls.push(call); calls.push(call);
        } };
      record.agent = agent; created.push(record); await options.setup(agent.ctx, agent);
      return { agent, async dispose() { record.disposed++; if (dispose) await dispose(); } };
    } } };
  const contextGuard = { failureFor: agent => faults.get(agent) || null,
    async checkRecovery(agent) { checked.push(agent); return recovery ? recovery(agent) : { allowed }; },
    clear(agent) { cleared.push(agent); faults.delete(agent); } };
  const gateway = { selfId: '10001', connected: true, connectedAtMs: 1_700_000_000_000, online: true, loginVerified: true, identitySource: 'lifecycle',
    async sendMessage(...args) { sent.push(args); return send ? send(...args) : { ok: true }; } };
  const bridge = new NativeOneBotBridge({ ctx: { get: name => services[name], on(name, handler) {
    if (!events.has(name)) events.set(name, new Set()); events.get(name).add(handler); return () => events.get(name).delete(handler);
  } }, qqGateway: gateway, ownerQq: '20002', expectedSelfId: '10001', contextGuard,
    qqAccounts: ['20002', '30003'].map(qq => ({ qq, name: '虚构账号', enabled: true, activeIdentityId: 'default',
      identities: [{ id: 'default', name: '默认身份', relationType: 'existing', userRole: '', companionRole: '', userTitle: '', companionTitle: '', description: '' }] })),
    rejectBeforeConnection: true, now: () => 1_700_000_000_000, turnTimeoutMs: 1000, disposeTimeoutMs: 30, logger: { warn() {} } });
  const incoming = (id, qq = '20002') => ({ channel: 'onebot', selfId: '10001', userId: qq, messageId: String(id), messageType: 'private', isGroup: false,
    groupId: null, text: 'PRIVATE_USER_CONTENT', time: 1_700_000_000_000,
    raw: { post_type: 'message', message_type: 'private', self_id: 10001, user_id: Number(qq), message_id: id, time: 1_700_000_000 } });
  const claim = call => { emit('session/event', call.agent.session, { type: 'turn/start', data: { turn: call.turn } });
    emit('agent/inbox/claimed', { agent: call.agent, message: call.message, turn: call.turn }); };
  const finish = (call, diagnostic, { tool = false } = {}) => {
    if (diagnostic) faults.set(call.agent, { at: '2023-11-14T22:13:20.000Z', message: 'PRIVATE_PROVIDER_ERROR', ...diagnostic });
    claim(call);
    if (tool) emit('session/event', call.agent.session, { type: 'tool/call', data: { turn: call.turn, callId: 'prior-tool' } });
    emit('session/event', call.agent.session, { type: 'turn/end', data: { turn: call.turn,
      reason: { kind: 'error', error: { code: 'CONTEXT_CAPACITY_REQUIRED', message: 'PRIVATE_PROVIDER_ERROR' } } } });
  };
  const success = call => { claim(call); emit('session/event', call.agent.session, { type: 'assistant/message', surfaceOp: 'append',
    data: { turn: call.turn, message: { content: [{ type: 'text', text: '正常回复' }] } } });
    emit('session/event', call.agent.session, { type: 'turn/end', data: { turn: call.turn, reason: { kind: 'completed' } } }); };
  return { bridge, created, calls, sent, faults, checked, cleared, gateway, incoming, finish, success,
    allow(value) { allowed = value; }, status(qq = '20002') { return bridge.status.conversations.find(row => row.qq === qq); } };
}

for (const [code, failureType, phrase] of [['CONTEXT_CAPACITY_REQUIRED', 'context_required', '需要先压缩'],
  ['CONTEXT_COMPACTION_FAILED', 'context_compaction_failed', '压缩未完成'],
  ['CONTEXT_GUARD_UNAVAILABLE', 'context_guard_unavailable', '保护暂不可用']]) {
  test('trusted ' + code + ' pauses only the matching conversation, preserves its Agent and never repeats queued or duplicated input', async t => {
    const f = fixture(); t.after(() => f.bridge.dispose());
    const message = f.incoming(1), first = f.bridge.handleIncoming(message), queued = f.bridge.handleIncoming(f.incoming(2));
    const other = f.bridge.handleIncoming(f.incoming(1, '30003')); await until(() => f.calls.length === 2);
    const own = f.calls.find(call => f.bridge.recordForAgent(call.agent).peerId === '20002');
    const guest = f.calls.find(call => call !== own);
    f.finish(own, { code, providerStarted: false }); f.success(guest);
    const result = await first; assert.equal(result.failureType, failureType); assert.equal(result.uncertain, undefined);
    assert.equal((await queued).failureType, 'blocked'); assert.equal((await other).ok, true);
    assert.equal(f.status().state, 'blocked'); assert.equal(f.status().requiresUncertainAcknowledgement, false);
    const record = f.created.find(item => item.agent === own.agent);
    assert.equal(record.disposed, 0); assert.equal(record.cancelled, 0);
    assert.equal(f.bridge.handleIncoming(structuredClone(message)), first);
    assert.equal(f.calls.length, 2); assert.equal(f.sent.filter(([target]) => target === 'private:20002').length, 1);
    const notice = f.sent.find(([target]) => target === 'private:20002');
    assert.ok(notice[1].includes(phrase)); assert.ok(notice[1].includes('已暂停')); assert.ok(notice[1].includes('未自动重跑'));
    assert.deepEqual(notice[2], { messageId: '1', selfId: '10001' });
    assert.doesNotMatch(JSON.stringify({ result, status: f.bridge.status, sent: f.sent }), /PRIVATE/);
  });
}

test('context recovery needs a successful trusted check, retains the original Agent and only accepts later new messages', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose()); const message = f.incoming(1);
  const first = f.bridge.handleIncoming(message); await until(() => f.calls.length === 1);
  const agent = f.calls[0].agent; f.finish(f.calls[0], { code: 'CONTEXT_CAPACITY_REQUIRED', providerStarted: false }); await first;
  await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default' }), { code: 'CONTEXT_RECOVERY_REQUIRED' });
  assert.equal(f.cleared.length, 0); assert.equal(f.status().state, 'blocked'); assert.equal(f.created[0].disposed, 0);
  assert.equal((await f.bridge.handleIncoming(f.incoming(2))).failureType, 'blocked');
  f.allow(true); const recovered = await f.bridge.recoverConversation({ qq: '20002', identityId: 'default' });
  assert.equal(recovered.recovered, true); assert.deepEqual(f.cleared, [agent]); assert.equal(f.calls.length, 1);
  assert.equal(f.created[0].disposed, 0); assert.equal(f.bridge.findByAgent(agent).agent, agent);
  assert.equal(f.bridge.handleIncoming(message), first);
  const fresh = f.bridge.handleIncoming(f.incoming(3)); await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].agent, agent); assert.equal(f.created.length, 1); f.success(f.calls[1]); assert.equal((await fresh).ok, true);
});

test('explicit fresh-session recovery closes the old Agent but does not create, seed or replay work until a new input arrives', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose());
  const message = f.incoming(1); message.text = 'OLD_PRIVATE_REQUEST';
  const first = f.bridge.handleIncoming(message), queued = f.bridge.handleIncoming(f.incoming(2));
  await until(() => f.calls.length === 1); const old = f.calls[0].agent;
  f.finish(f.calls[0], { code: 'CONTEXT_CAPACITY_REQUIRED', providerStarted: false }); await first; await queued;
  const result = await f.bridge.recoverConversation({ qq: '20002', identityId: 'default', freshSession: true });
  assert.equal(result.freshSession, true); assert.equal(result.recovered, true); assert.equal(result.conversation.state, 'idle');
  assert.equal(f.created[0].disposed, 1); assert.equal(f.created.length, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.checked.length, 0); assert.equal(f.cleared.length, 0, 'a fresh session is distinct from successful compaction');
  assert.equal(f.bridge.findByAgent(old), undefined); assert.equal(f.bridge.knowsAgent(old), true);
  assert.equal(f.bridge.handleIncoming(message), first);
  const freshMessage = f.incoming(3); freshMessage.text = 'NEW_EXPLICIT_REQUEST';
  const fresh = f.bridge.handleIncoming(freshMessage); await until(() => f.calls.length === 2);
  assert.notEqual(f.calls[1].agent.session.id, old.session.id); assert.equal(f.created[1].options.seed, undefined);
  assert.equal(f.calls[1].message.content[0].text, 'NEW_EXPLICIT_REQUEST');
  f.success(f.calls[1]); assert.equal((await fresh).ok, true); assert.equal(f.calls.length, 2);
});

test('fresh-session recovery cannot bypass unknown acknowledgement or an unconfirmed old cleanup', async t => {
  const gate = deferred(), f = fixture({ dispose: () => gate.promise });
  t.after(() => { gate.resolve(); return f.bridge.dispose(); });
  const first = f.bridge.handleIncoming(f.incoming(1)); await until(() => f.calls.length === 1);
  f.finish(f.calls[0], { code: 'CONTEXT_COMPACTION_FAILED', providerStarted: true }); await first;
  const target = { qq: '20002', identityId: 'default', freshSession: true };
  await assert.rejects(f.bridge.recoverConversation(target), { code: 'UNCERTAIN_ACK_REQUIRED' }); assert.equal(f.created[0].disposed, 0);
  await assert.rejects(f.bridge.recoverConversation({ ...target, acknowledgeUncertain: true }), { code: 'BUSY' });
  assert.equal(f.status().state, 'blocked'); assert.equal(f.status().requiresUncertainAcknowledgement, true);
  assert.equal((await f.bridge.handleIncoming(f.incoming(2))).failureType, 'blocked'); assert.equal(f.created.length, 1);
  gate.resolve(); await f.bridge.recoverConversation({ ...target, acknowledgeUncertain: true });
  assert.equal(f.created[0].disposed, 1, 'recovery joins the same memoized cleanup');
  assert.equal(f.created.length, 1); assert.equal(f.calls.length, 1); assert.equal(f.status().state, 'idle');
});

test('fresh-session selection is explicit and restricted to context failures', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose());
  await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default', freshSession: true }), { code: 'INVALID_CONVERSATION' });
  await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default', freshSession: 'true' }), { code: 'INVALID_CONVERSATION' });
  const first = f.bridge.handleIncoming(f.incoming(1)); await until(() => f.calls.length === 1); f.finish(f.calls[0]); await first;
  await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default', freshSession: true }), { code: 'INVALID_CONVERSATION' });
  assert.equal(f.created[0].disposed, 0); assert.equal(f.calls.length, 1);
});

test('stale context control versions cannot acknowledge a newer failure or erase either original deduplication proof', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose()); const firstMessage = f.incoming(1);
  const first = f.bridge.handleIncoming(firstMessage); await until(() => f.calls.length === 1);
  f.finish(f.calls[0], { code: 'CONTEXT_CAPACITY_REQUIRED', providerStarted: false }); await first;
  const oldVersion = f.status().controlVersion;
  assert.match(oldVersion, /^\d+:\d+$/); f.allow(true);
  await f.bridge.recoverConversation({ qq: '20002', identityId: 'default', controlVersion: oldVersion });
  const secondMessage = f.incoming(2), second = f.bridge.handleIncoming(secondMessage); await until(() => f.calls.length === 2);
  f.finish(f.calls[1], { code: 'CONTEXT_COMPACTION_FAILED', providerStarted: true }); await second;
  const current = f.status(); assert.notEqual(current.controlVersion, oldVersion); assert.equal(current.requiresUncertainAcknowledgement, true);
  await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default', acknowledgeUncertain: true,
    freshSession: true, controlVersion: oldVersion }), { code: 'CONFLICT' });
  assert.deepEqual(f.status(), current); assert.equal(f.created[0].disposed, 0); assert.equal(f.created.length, 1);
  assert.equal(f.bridge.handleIncoming(firstMessage), first); assert.equal(f.bridge.handleIncoming(secondMessage), second);
  const result = await f.bridge.recoverConversation({ qq: '20002', identityId: 'default', acknowledgeUncertain: true,
    freshSession: true, controlVersion: current.controlVersion });
  assert.equal(result.freshSession, true); assert.equal(f.status().state, 'idle'); assert.equal(f.created[0].disposed, 1);
  assert.equal(f.calls.length, 2); assert.equal(f.created.length, 1, 'recovery itself creates no replacement model work');
  assert.equal(f.bridge.handleIncoming(firstMessage), first); assert.equal(f.bridge.handleIncoming(secondMessage), second);
});

test('prior tool evidence, unknown provider provenance and unknown status delivery retain the existing acknowledgement gate', async t => {
  for (const mode of ['tool', 'unknown-provider', 'unknown-delivery']) {
    const f = fixture({ send: mode === 'unknown-delivery' ? () => ({ ok: false, uncertain: true }) : undefined }); t.after(() => f.bridge.dispose());
    const first = f.bridge.handleIncoming(f.incoming(1)); await until(() => f.calls.length === 1);
    f.finish(f.calls[0], { code: 'CONTEXT_COMPACTION_FAILED', ...(mode === 'unknown-provider' ? {} : { providerStarted: false }) }, { tool: mode === 'tool' });
    await first; assert.equal(f.status().requiresUncertainAcknowledgement, true, mode);
    f.allow(true); await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default' }), { code: 'UNCERTAIN_ACK_REQUIRED' });
    assert.equal(f.checked.length, 0); assert.equal(f.cleared.length, 0);
    await f.bridge.recoverConversation({ qq: '20002', identityId: 'default', acknowledgeUncertain: true });
    assert.equal(f.created[0].disposed, 0); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  }
});

test('raw host error codes do not fabricate a trusted context pause and recovery cannot finish after disposal', async t => {
  const normal = fixture(); t.after(() => normal.bridge.dispose());
  const first = normal.bridge.handleIncoming(normal.incoming(1)); await until(() => normal.calls.length === 1);
  normal.finish(normal.calls[0]); assert.equal((await first).failureType, 'model_failed');
  assert.equal(normal.status().failureType, 'model_failed');
  const gate = deferred(), f = fixture({ recovery: () => gate.promise }); t.after(() => f.bridge.dispose());
  const paused = f.bridge.handleIncoming(f.incoming(1)); await until(() => f.calls.length === 1);
  f.finish(f.calls[0], { code: 'CONTEXT_CAPACITY_REQUIRED', providerStarted: false }); await paused;
  const recovering = f.bridge.recoverConversation({ qq: '20002', identityId: 'default' });
  await until(() => f.checked.length === 1); await f.bridge.dispose(); gate.resolve({ allowed: true });
  await assert.rejects(recovering, { code: 'UNAVAILABLE' }); assert.equal(f.cleared.length, 0);
});

function executorFixture({ diagnostic, cleanupFails = false, provider = 'spawn' } = {}) {
  const parent = { id: 'parent', session: { id: 'parent' } }, child = { id: 'actual-child', session: { id: 'actual-child' } };
  const agents = new Map([[parent.id, parent], [child.id, child]]), sequence = [];
  const services = { agents: { get: id => agents.get(id) }, subagents: { getProvider: () => ({ start() {} }),
    async startActivation() { sequence.push('activation'); return { childId: child.id,
      result: Promise.resolve({ stopReason: 'error', diagnostic: 'CONTEXT_CAPACITY_REQUIRED PRIVATE_RAW_ERROR', output: [] }),
      async dispose() { sequence.push('dispose'); agents.delete(child.id); if (cleanupFails) throw new Error('PRIVATE_CLEANUP'); } }; } } };
  const contextGuard = { failureFor(agent) { assert.equal(agent, child); sequence.push('failure'); return diagnostic || null; } };
  const executor = createNativeTaskExecutor({ ctx: { get: name => services[name] }, provider, contextGuard });
  return { sequence, run: () => executor.run({ id: 'offline-job', prompt: 'fictional', parent }) };
}

test('background native guard failures distinguish proven zero-provider rejection from unknown earlier execution before cleanup removes the child', async () => {
  for (const [providerStarted, status] of [[false, 'failed'], [true, 'unknown'], [undefined, 'unknown']]) {
    const f = executorFixture({ diagnostic: { code: 'CONTEXT_CAPACITY_REQUIRED', providerStarted, message: 'PRIVATE_RAW_ERROR' } });
    const result = await f.run(); assert.deepEqual(result, { status, executor: 'spawn', errorCode: 'context-required' });
    assert.deepEqual(f.sequence, ['activation', 'failure', 'dispose']); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('background cleanup uncertainty dominates context rejection and external error text cannot claim the native guard proof', async () => {
  const bad = executorFixture({ diagnostic: { code: 'CONTEXT_COMPACTION_FAILED', providerStarted: false }, cleanupFails: true });
  assert.deepEqual(await bad.run(), { status: 'unknown', executor: 'spawn', errorCode: 'cleanup-unconfirmed' });
  const raw = executorFixture(); assert.deepEqual(await raw.run(), { status: 'failed', executor: 'spawn', errorCode: 'execution' });
  const external = executorFixture({ provider: 'codex', diagnostic: { code: 'CONTEXT_CAPACITY_REQUIRED', providerStarted: false } });
  assert.deepEqual(await external.run(), { status: 'failed', executor: 'codex', errorCode: 'execution' });
  assert.deepEqual(external.sequence, ['activation', 'dispose']);
});
