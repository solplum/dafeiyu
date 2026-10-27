import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeOneBotBridge } from '../packages/dsh-dafeiyu/src/native-onebot.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) { assert.ok(Date.now() < end, 'fixture did not reach the expected state'); await tick(); }
}

function fixture(options = {}) {
  const listeners = new Map(), created = [], calls = [], sent = [], mounted = [];
  const clock = { value: 1700000000000 };
  const emit = (name, ...args) => { for (const handler of [...(listeners.get(name) || [])]) handler(...args); };
  const finish = (call, text = `reply:${call.message.content[0].text}`) => {
    const turn = call.turn;
    emit('session/event', call.agent.session, { type: 'turn/start', data: { turn } });
    emit('agent/inbox/claimed', { agent: call.agent, message: call.message, turn });
    emit('session/event', call.agent.session, { type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { content: [{ type: 'text', text }] } } });
    emit('session/event', call.agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  };
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'offline', model: 'fixture' }) },
    agentPresets: { mount: async (_ctx, name) => mounted.push(name) },
    agents: { withoutInitiator: (fn) => fn(), create: async (opts) => {
      const scopedTools = { guards: [], restrictions: [], guard(fn) { this.guards.push(fn); }, restrict(value) { this.restrictions.push(value); } };
      const record = { opts, calls: [], canceled: 0, disposed: 0, scopedTools };
      const agent = { session: { id: opts.sessionId }, ctx: { get: (name) => name === 'tools' ? scopedTools : services[name] },
        cancel() { record.canceled++; }, followup(message) {
          const call = { agent, message, turn: record.calls.length + 1, record };
          record.calls.push(call); calls.push(call); options.respond?.(call, finish);
        } };
      record.agent = agent; created.push(record);
      await opts.setup(agent.ctx, agent);
      if (options.createGate) await options.createGate.promise;
      return { agent, dispose: async () => { record.disposed++; if (options.disposeGate) await options.disposeGate.promise; } };
    } },
  };
  const ctx = { get: (name) => services[name], on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler); return () => listeners.get(name).delete(handler);
  } };
  const gateway = { selfId: '10001', connected: true, connectedAtMs: clock.value, online: true, loginVerified: true, identitySource: 'lifecycle',
    async sendMessage(...args) { sent.push(args); return options.send ? options.send(...args) : { ok: true }; } };
  const bridge = new NativeOneBotBridge({ ctx, qqGateway: gateway, ownerQq: '20002', expectedSelfId: '10001',
    qqAccounts: ['20002', '30003', '40004', '50005'].map((qq) => ({ qq, name: `account-${qq}`, enabled: true, activeIdentityId: 'default',
      identities: [{ id: 'default', name: '默认身份', relationType: 'existing', userRole: '', companionRole: '', userTitle: '', companionTitle: '', description: '' }] })),
    rejectBeforeConnection: true, now: () => clock.value, turnTimeoutMs: 1000, queueTimeoutMs: 5000, disposeTimeoutMs: 25,
    logger: { warn() {} }, ...options.bridge });
  const incoming = (qq, id, text = `${qq}:${id}`) => {
    const time = Math.floor(clock.value / 1000);
    return { channel: 'onebot', selfId: '10001', userId: qq, messageId: String(id), messageType: 'private', isGroup: false, groupId: null,
      text, time: time * 1000, raw: { post_type: 'message', message_type: 'private', self_id: 10001, user_id: Number(qq), message_id: id, time } };
  };
  return { bridge, created, calls, sent, mounted, gateway, clock, listeners, emit, finish, incoming,
    status: (qq = '20002') => bridge.status.conversations.find((c) => c.qq === qq) };
}

function toolEnding(f, call, { kind = 'completed', finalText, mixedText = '准备执行（仅离线事件）', toolResult = { ok: true } } = {}) {
  const { agent, message, turn } = call;
  f.emit('session/event', agent.session, { type: 'turn/start', data: { turn } });
  f.emit('agent/inbox/claimed', { agent, message, turn });
  f.emit('session/event', agent.session, { type: 'assistant/message', surfaceOp: 'append', data: { turn,
    message: { content: [{ type: 'text', text: mixedText }, { type: 'tool-call', id: 'fixture-call', name: 'offline-fixture', arguments: '{}' }] } } });
  f.emit('session/event', agent.session, { type: 'tool/call', data: { turn, callId: 'fixture-call' } });
  f.emit('session/event', agent.session, { type: 'tool/result', data: { turn, callId: 'fixture-call', result: toolResult } });
  if (finalText) f.emit('session/event', agent.session, { type: 'assistant/message', surfaceOp: 'append', data: { turn,
    message: { content: [{ type: 'text', text: finalText }] } } });
  f.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind, error: { message: 'PRIVATE_PROVIDER_ERROR' } } } });
}

test('three independent conversations run concurrently while each account remains FIFO and fixed to its own recipient', async (t) => {
  const f = fixture(); t.after(() => f.bridge.dispose());
  const tasks = ['20002', '30003', '40004', '50005'].map((qq) => f.bridge.handleIncoming(f.incoming(qq, 1)));
  const nextA = f.bridge.handleIncoming(f.incoming('20002', 2));
  await until(() => f.calls.length === 3);
  assert.equal(f.bridge.status.running, 3); assert.equal(f.bridge.status.queued, 2);
  assert.deepEqual(f.calls.map((c) => c.message.content[0].text).sort(), ['20002:1', '30003:1', '40004:1']);
  const a = f.calls.find((call) => call.message.content[0].text === '20002:1');
  f.finish(f.calls.find((call) => call.message.content[0].text === '30003:1')); await until(() => f.calls.length === 4);
  assert.equal(f.calls[3].message.content[0].text, '50005:1', 'an unrelated account does not wait for the slow primary');
  f.finish(a); await until(() => f.calls.length === 5);
  assert.equal(f.calls[4].message.content[0].text, '20002:2');
  for (const text of ['40004:1', '50005:1', '20002:2']) f.finish(f.calls.find((call) => call.message.content[0].text === text));
  assert.ok((await Promise.all([...tasks, nextA])).every((result) => result.delivered));
  assert.equal(f.created.length, 4); assert.equal(f.mounted.length, 1);
  for (const record of f.created.slice(1)) {
    assert.equal(record.scopedTools.guards[0]().includes('未授权'), true);
    assert.deepEqual(record.scopedTools.restrictions, [{ allow: [] }]);
  }
  assert.deepEqual(f.sent.map(([target]) => target).sort(), ['private:20002', 'private:20002', 'private:30003', 'private:40004', 'private:50005'].sort());
});

test('round-robin scheduling gives waiting accounts a turn before one account drains its backlog', async (t) => {
  const f = fixture({ bridge: { maxConcurrent: 1 } }); t.after(() => f.bridge.dispose());
  const tasks = [['20002', 1], ['20002', 2], ['20002', 3], ['30003', 1], ['40004', 1]]
    .map(([qq, id]) => f.bridge.handleIncoming(f.incoming(qq, id)));
  for (let at = 0; at < tasks.length; at++) { await until(() => f.calls.length === at + 1); f.finish(f.calls[at]); }
  assert.ok((await Promise.all(tasks)).every((result) => result.ok));
  assert.deepEqual(f.calls.map((call) => call.message.content[0].text), ['20002:1', '30003:1', '40004:1', '20002:2', '20002:3']);
});

test('global and per-conversation bounds reject excess work without disturbing admitted conversations', async (t) => {
  const f = fixture({ bridge: { maxConcurrent: 1, maxPending: 4, maxConversationPending: 2 } }); t.after(() => f.bridge.dispose());
  const tasks = [f.bridge.handleIncoming(f.incoming('20002', 1)), f.bridge.handleIncoming(f.incoming('20002', 2))];
  assert.equal((await f.bridge.handleIncoming(f.incoming('20002', 3))).failureType, 'queue_full');
  tasks.push(f.bridge.handleIncoming(f.incoming('30003', 1)), f.bridge.handleIncoming(f.incoming('40004', 1)));
  assert.equal((await f.bridge.handleIncoming(f.incoming('50005', 1))).failureType, 'queue_full');
  assert.equal(f.bridge.status.pending, 4);
  for (let at = 0; at < tasks.length; at++) { await until(() => f.calls.length === at + 1); f.finish(f.calls[at]); }
  assert.ok((await Promise.all(tasks)).every((result) => result.ok));
  assert.equal(f.calls.length, 4);
});

test('expired queued work never prepares or models and a prior successful turn does not hide the later failure', async (t) => {
  const f = fixture({ bridge: { maxConcurrent: 1, queueTimeoutMs: 20 } }); t.after(() => f.bridge.dispose());
  const first = f.bridge.handleIncoming(f.incoming('20002', 1)); await until(() => f.calls.length === 1);
  let prepares = 0;
  const msg = f.incoming('20002', 2), queued = f.bridge.handleIncoming(msg, { prepare: () => { prepares++; return msg; } });
  f.clock.value += 21;
  assert.equal((await queued).failureType, 'queue_expired');
  assert.equal(prepares, 0); assert.equal(f.calls.length, 1);
  f.finish(f.calls[0]); assert.equal((await first).ok, true);
  assert.equal(f.status().failureType, 'queue_expired'); assert.equal(f.status().canRecover, true);
  assert.equal(f.bridge.handleIncoming(msg), queued, 'expired request retains its terminal deduplication proof');
  const oldAgent = f.created[0].agent;
  assert.equal((await f.bridge.recoverConversation({ qq: '20002', identityId: 'default' })).recovered, true);
  assert.equal(f.created[0].disposed, 0); assert.equal(f.bridge.findByAgent(oldAgent).agent, oldAgent);
});

test('voice preparation is FIFO inside its conversation, concurrent across accounts and updates trusted active input', async (t) => {
  const gate = deferred(), entered = [];
  const f = fixture(); t.after(() => f.bridge.dispose());
  const voice = f.incoming('20002', 1, ''), next = f.incoming('20002', 2, '含有停字也只是正常聊天');
  const first = f.bridge.handleIncoming(voice, { prepare: async (msg, { signal }) => { entered.push('voice'); assert.equal(signal.aborted, false); await gate.promise; return { ...msg, text: '识别后的真实文本' }; } });
  const second = f.bridge.handleIncoming(next, { prepare: (msg) => { entered.push('next'); return msg; } });
  const other = f.bridge.handleIncoming(f.incoming('30003', 1));
  await until(() => f.calls.length === 1); assert.deepEqual(entered, ['voice']);
  assert.equal(f.calls[0].message.content[0].text, '30003:1'); f.finish(f.calls[0]); await other;
  gate.resolve(); await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].message.role, 'user'); assert.equal(f.calls[1].message.content[0].text, '识别后的真实文本');
  assert.equal(f.bridge.recordForAgent(f.calls[1].agent).active.incoming.text, '识别后的真实文本');
  assert.deepEqual(entered, ['voice']); f.finish(f.calls[1]); await first;
  await until(() => f.calls.length === 3); assert.deepEqual(entered, ['voice', 'next']);
  assert.equal(f.calls[2].message.content[0].text, next.text); f.finish(f.calls[2]); assert.equal((await second).ok, true);
});

test('preparation failures expose only whitelisted types and recover without throwing away established history', async (t) => {
  const f = fixture({ respond: (call, finish) => finish(call) }); t.after(() => f.bridge.dispose());
  await f.bridge.handleIncoming(f.incoming('20002', 1));
  const agent = f.created[0].agent;
  const types = [['VOICE_INPUT_FAILED', 'voice_input_failed'], ['VOICE_DISABLED', 'voice_disabled'], ['CONNECTION_CHANGED', 'connection_changed'], ['CANCELLED', 'cancelled'], ['__proto__', 'prepare_failed']];
  for (let at = 0; at < types.length; at++) {
    const [code, type] = types[at];
    const result = await f.bridge.handleIncoming(f.incoming('20002', at + 2), { prepare() { throw Object.assign(new Error('PRIVATE provider token and voice body'), { code }); } });
    assert.equal(result.failureType, type); assert.equal(f.status().state, 'failed'); assert.equal(f.status().requiresUncertainAcknowledgement, false);
    assert.equal(JSON.stringify({ result, status: f.bridge.status }).includes('PRIVATE'), false);
    await f.bridge.recoverConversation({ qq: '20002', identityId: 'default' });
    assert.equal(f.created[0].disposed, 0); assert.equal(f.bridge.findByAgent(agent).agent, agent);
  }
  assert.equal((await f.bridge.handleIncoming(f.incoming('20002', 99))).ok, true); assert.equal(f.created.length, 1);
});

test('voice recognition failure shares one queued task and one notice across concurrent, sending and completed duplicates without creating an Agent', async (t) => {
  const prepareGate = deferred(), sendGate = deferred(); let preparations = 0;
  const f = fixture({ send: () => sendGate.promise }); t.after(() => f.bridge.dispose());
  const msg = f.incoming('20002', 1, '[语音]');
  const prepare = async () => { preparations++; await prepareGate.promise;
    throw Object.assign(new Error('PRIVATE_RECOGNIZER_ERROR'), { code: 'VOICE_INPUT_FAILED' }); };
  const first = f.bridge.handleIncoming(msg, { prepare });
  assert.equal(f.bridge.handleIncoming(structuredClone(msg), { prepare }), first);
  await until(() => preparations === 1); prepareGate.resolve(); await until(() => f.sent.length === 1);
  assert.equal(f.created.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.bridge.handleIncoming(structuredClone(msg), { prepare }), first);
  sendGate.resolve({ ok: true }); const result = await first;
  assert.equal(result.failureType, 'voice_input_failed'); assert.deepEqual(result.notification, { attempted: true, delivered: true });
  assert.equal(f.bridge.handleIncoming(structuredClone(msg), { prepare }), first); await first;
  assert.equal(preparations, 1); assert.equal(f.sent.length, 1); assert.equal(f.created.length, 0);
  assert.deepEqual(f.sent[0], ['private:20002', '这条语音没有识别成功，尚未执行你的请求。请重新录音或发送文字。',
    { messageId: '1', selfId: '10001' }]);
  assert.doesNotMatch(JSON.stringify({ result, status: f.bridge.status, sent: f.sent }), /PRIVATE/);
});

test('voice failure cannot notify after cancellation, disposal, expiry, identity or connection generation changes', async (t) => {
  for (const mode of ['stop', 'dispose', 'expired', 'identity', 'self', 'socket', 'connectedAt', 'offline', 'unverified', 'disconnected']) {
    const gate = deferred(); let entered = false;
    const f = fixture(); t.after(() => f.bridge.dispose());
    const running = f.bridge.handleIncoming(f.incoming('20002', 1, '[语音]'), { prepare: async () => {
      entered = true; await gate.promise; throw Object.assign(new Error('PRIVATE'), { code: 'VOICE_INPUT_FAILED' });
    } });
    await until(() => entered);
    if (mode === 'stop') await f.bridge.stopConversation({ qq: '20002', identityId: 'default' });
    if (mode === 'dispose') await f.bridge.dispose();
    if (mode === 'expired') f.clock.value += f.bridge.dedupWindowMs + 1;
    if (mode === 'identity') f.bridge.accountConfig.qqAccounts[0].enabled = false;
    if (mode === 'self') f.gateway.selfId = '99999';
    if (mode === 'socket') f.gateway.wsClient = { replacement: true };
    if (mode === 'connectedAt') f.gateway.connectedAtMs++;
    if (mode === 'offline') f.gateway.online = false;
    if (mode === 'unverified') f.gateway.loginVerified = false;
    if (mode === 'disconnected') f.gateway.connected = false;
    gate.resolve(); const result = await running;
    assert.equal(result.ok, false, mode); assert.equal(f.sent.length, 0, mode);
    assert.equal(f.created.length, 0, mode); assert.equal(f.calls.length, 0, mode);
    assert.notEqual(result.notification?.delivered, true, mode);
  }
});

test('voice failure notice receipts retain the original recognition failure and unknown delivery deduplication without retry', async (t) => {
  for (const receipt of [{ ok: false, uncertain: false }, { ok: false, uncertain: true }, undefined]) {
    const f = fixture({ send: async () => receipt }); t.after(() => f.bridge.dispose());
    const msg = f.incoming('20002', 1, '[语音]'); let preparations = 0;
    const prepare = () => { preparations++; throw Object.assign(new Error('PRIVATE'), { code: 'VOICE_INPUT_FAILED' }); };
    const first = f.bridge.handleIncoming(msg, { prepare }), result = await first;
    const uncertain = receipt?.uncertain === true || receipt === undefined;
    assert.equal(result.failureType, 'voice_input_failed'); assert.equal(result.notification.delivered, false);
    assert.equal(result.notification.failureType, uncertain ? 'delivery_unknown' : 'send_failed');
    assert.equal(f.status().requiresUncertainAcknowledgement, uncertain);
    assert.equal(f.bridge.status.uncertainEntries, uncertain ? 1 : 0);
    assert.equal(f.bridge.handleIncoming(structuredClone(msg), { prepare }), first); await first;
    assert.equal(f.sent.length, 1); assert.equal(preparations, 1); assert.equal(f.created.length, 0);
    if (uncertain) await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default' }), { code: 'UNCERTAIN_ACK_REQUIRED' });
  }
});

test('voice failure notification timeout is bounded and a late receipt cannot repeat recognition or send another notice', async (t) => {
  const gate = deferred(); let preparations = 0;
  const f = fixture({ bridge: { statusTimeoutMs: 15 }, send: () => gate.promise }); t.after(() => f.bridge.dispose());
  const msg = f.incoming('20002', 1, '[语音]'), prepare = () => {
    preparations++; throw Object.assign(new Error('PRIVATE'), { code: 'VOICE_INPUT_FAILED' });
  };
  const first = f.bridge.handleIncoming(msg, { prepare }), result = await first;
  assert.equal(result.failureType, 'voice_input_failed'); assert.equal(result.notification.uncertain, true);
  gate.resolve({ ok: true }); await tick();
  assert.equal(result.notification.delivered, false); assert.equal(f.bridge.handleIncoming(structuredClone(msg), { prepare }), first);
  assert.equal(f.sent.length, 1); assert.equal(preparations, 1); assert.equal(f.created.length, 0);
});

test('voice failure notice stays within its FIFO slot while an unrelated account continues normally', async (t) => {
  const gate = deferred(), notice = '这条语音没有识别成功，尚未执行你的请求。请重新录音或发送文字。';
  const f = fixture({ send: (_target, text) => text === notice ? gate.promise : { ok: true }, respond: (call, finish) => finish(call) });
  t.after(() => f.bridge.dispose());
  const voice = f.bridge.handleIncoming(f.incoming('20002', 1, '[语音]'), { prepare() {
    throw Object.assign(new Error('PRIVATE'), { code: 'VOICE_INPUT_FAILED' });
  } });
  const later = f.bridge.handleIncoming(f.incoming('20002', 2, '后续文字'));
  const other = f.bridge.handleIncoming(f.incoming('30003', 1, '另一账号文字'));
  await until(() => f.sent.some(([, text]) => text === notice)); await other;
  assert.deepEqual(f.calls.map((call) => call.message.content[0].text), ['另一账号文字']);
  gate.resolve({ ok: true }); const result = await voice; await later;
  assert.equal(result.notification.delivered, true);
  assert.deepEqual(f.calls.map((call) => call.message.content[0].text), ['另一账号文字', '后续文字']);
  assert.equal(f.sent.filter(([, text]) => text === notice).length, 1);
});

test('preparation cannot substitute another sender, message, receiver or source timestamp', async (t) => {
  const f = fixture(); t.after(() => f.bridge.dispose());
  for (const [at, mutate] of [
    (msg) => ({ ...msg, userId: '30003', raw: { ...msg.raw, user_id: 30003 } }),
    (msg) => ({ ...msg, selfId: '99999', raw: { ...msg.raw, self_id: 99999 } }),
    (msg) => ({ ...msg, messageId: '999', raw: { ...msg.raw, message_id: 999 } }),
    (msg) => ({ ...msg, time: msg.time + 1000, raw: { ...msg.raw, time: msg.raw.time + 1 } }),
  ].entries()) {
    const result = await f.bridge.handleIncoming(f.incoming('20002', at + 1), { prepare: mutate });
    assert.equal(result.ok, false); assert.ok(['identity_changed', 'prepare_failed'].includes(result.failureType));
  }
  assert.equal(f.created.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('rolling deduplication capacity recovers after expiry while old source messages cannot execute again', async (t) => {
  const f = fixture({ bridge: { maxSeen: 2, dedupWindowMs: 1000 }, respond: (call, finish) => finish(call) }); t.after(() => f.bridge.dispose());
  const old = f.incoming('20002', 1);
  await f.bridge.handleIncoming(old); await f.bridge.handleIncoming(f.incoming('20002', 2));
  assert.equal((await f.bridge.handleIncoming(f.incoming('20002', 3))).failureType, 'dedup_full');
  f.clock.value += 2001;
  assert.equal((await f.bridge.handleIncoming(f.incoming('20002', 3))).ok, true);
  assert.equal(f.bridge.status.dedupEntries, 1); assert.equal(f.calls.length, 3);
  const stale = await f.bridge.handleIncoming(old);
  assert.equal(stale.rejected, true); assert.equal(stale.failureType, 'queue_expired'); assert.equal(f.calls.length, 3);
});

test('stop revokes only the chosen conversation, suppresses late output and recovery never replays prior inputs', async (t) => {
  const f = fixture(); t.after(() => f.bridge.dispose());
  const msg = f.incoming('20002', 1), first = f.bridge.handleIncoming(msg);
  const queued = f.bridge.handleIncoming(f.incoming('20002', 2));
  const other = f.bridge.handleIncoming(f.incoming('30003', 1));
  await until(() => f.calls.length === 2);
  const original = f.calls.find((call) => call.message.content[0].text === '20002:1');
  const unaffected = f.calls.find((call) => call.message.content[0].text === '30003:1');
  const stopped = await f.bridge.stopConversation({ qq: '20002', identityId: 'default' });
  assert.equal(stopped.conversation.state, 'blocked'); assert.equal(stopped.conversation.requiresUncertainAcknowledgement, true);
  assert.equal((await first).failureType, 'stopped'); assert.equal((await queued).failureType, 'stopped');
  assert.equal(original.record.canceled, 1); assert.equal(unaffected.record.canceled, 0);
  assert.equal(f.bridge.knowsAgent(original.agent), true); assert.equal(f.bridge.findByAgent(original.agent), undefined);
  f.finish(original, 'LATE PRIVATE OUTPUT'); f.finish(unaffected); assert.equal((await other).ok, true);
  assert.deepEqual(f.sent.map(([target]) => target), ['private:30003']);
  await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default' }), { code: 'UNCERTAIN_ACK_REQUIRED' });
  await f.bridge.recoverConversation({ qq: '20002', identityId: 'default', acknowledgeUncertain: true });
  assert.equal(f.calls.length, 2); assert.equal(f.created.length, 2);
  assert.equal(f.bridge.handleIncoming(msg), first); assert.equal((await f.bridge.handleIncoming(msg)).failureType, 'stopped');
  const after = f.bridge.handleIncoming(f.incoming('20002', 3)); await until(() => f.calls.length === 3);
  assert.notEqual(f.calls[2].agent.session.id, original.agent.session.id); f.finish(f.calls[2]); assert.equal((await after).ok, true);
  assert.equal(f.bridge.findByAgent(original.agent), undefined); assert.equal(f.bridge.knowsAgent(original.agent), true);
});

test('stop during preparation cancels its signal without starting a model, and a late transcript stays fenced', async (t) => {
  const gate = deferred(); let signal;
  const f = fixture(); t.after(() => f.bridge.dispose());
  const msg = f.incoming('20002', 1, ''), task = f.bridge.handleIncoming(msg, { prepare: async (_msg, context) => { signal = context.signal; await gate.promise; return { ...msg, text: 'late transcript' }; } });
  await until(() => Boolean(signal)); await f.bridge.stopConversation({ qq: '20002', identityId: 'default' });
  assert.equal(signal.aborted, true); assert.equal((await task).failureType, 'stopped');
  assert.equal(f.status().requiresUncertainAcknowledgement, false);
  await f.bridge.recoverConversation({ qq: '20002', identityId: 'default' }); gate.resolve(); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.created.length, 0); assert.equal(f.sent.length, 0);
});

test('recovery waits for old-agent disposal and refuses to create replacement work while cleanup is unknown', async (t) => {
  const disposeGate = deferred(); const f = fixture({ disposeGate }); t.after(() => { disposeGate.resolve(); return f.bridge.dispose(); });
  const first = f.bridge.handleIncoming(f.incoming('20002', 1)); await until(() => f.calls.length === 1);
  await f.bridge.stopConversation({ qq: '20002', identityId: 'default' }); await first;
  await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default', acknowledgeUncertain: true }), { code: 'BUSY' });
  assert.equal((await f.bridge.handleIncoming(f.incoming('20002', 2))).failureType, 'blocked'); assert.equal(f.created.length, 1);
  disposeGate.resolve(); await f.bridge.recoverConversation({ qq: '20002', identityId: 'default', acknowledgeUncertain: true });
  assert.equal(f.created.length, 1); assert.equal(f.created[0].disposed, 1);
});

test('stopped late creation is disposed before recovery and never follows up', async (t) => {
  const createGate = deferred(); const f = fixture({ createGate }); t.after(() => { createGate.resolve(); return f.bridge.dispose(); });
  const first = f.bridge.handleIncoming(f.incoming('20002', 1)); await until(() => f.created.length === 1);
  await f.bridge.stopConversation({ qq: '20002', identityId: 'default' }); assert.equal((await first).failureType, 'stopped');
  assert.equal(f.status().requiresUncertainAcknowledgement, false);
  await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default' }), { code: 'BUSY' });
  createGate.resolve(); await f.bridge.recoverConversation({ qq: '20002', identityId: 'default' });
  assert.equal(f.calls.length, 0); assert.equal(f.created[0].disposed, 1); assert.equal(f.created[0].canceled, 1);
  assert.equal(f.bridge.knowsAgent(f.created[0].agent), true); assert.equal(f.bridge.findByAgent(f.created[0].agent), undefined);
});

test('uncertain sends stay deduplicated past the rolling window until explicit acknowledgement, with no automatic resend', async (t) => {
  const f = fixture({ bridge: { dedupWindowMs: 1000, maxSeen: 1 }, respond: (call, finish) => finish(call), send: async () => ({ uncertain: true }) }); t.after(() => f.bridge.dispose());
  const original = f.incoming('20002', 1); const task = f.bridge.handleIncoming(original);
  assert.equal((await task).failureType, 'delivery_unknown'); assert.equal(f.bridge.status.uncertainEntries, 1);
  f.clock.value += 2001;
  assert.equal((await f.bridge.handleIncoming(f.incoming('30003', 1))).failureType, 'dedup_full');
  assert.equal(f.bridge.status.dedupEntries, 1); assert.equal(f.sent.length, 1);
  await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default' }), { code: 'UNCERTAIN_ACK_REQUIRED' });
  await f.bridge.recoverConversation({ qq: '20002', identityId: 'default', acknowledgeUncertain: true });
  assert.equal(f.bridge.status.dedupEntries, 0); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  assert.equal((await f.bridge.handleIncoming(original)).rejected, true); assert.equal(f.calls.length, 1);
});

test('stopping an in-flight chunk preserves unknown delivery and never sends the next chunk after a late receipt', async (t) => {
  const sendGate = deferred(); const f = fixture({ bridge: { chunkChars: 2 }, respond: (call, finish) => finish(call, 'abcdef'), send: () => sendGate.promise });
  t.after(() => { sendGate.resolve({ ok: true }); return f.bridge.dispose(); });
  const first = f.bridge.handleIncoming(f.incoming('20002', 1)); await until(() => f.sent.length === 1);
  await f.bridge.stopConversation({ qq: '20002', identityId: 'default' });
  assert.equal((await first).uncertain, true); assert.equal(f.status().requiresUncertainAcknowledgement, true);
  sendGate.resolve({ ok: true }); await tick(); assert.equal(f.sent.length, 1);
  assert.equal(f.status().lastReplyAt, null);
});

test('control targets fail closed, status snapshots contain no messages and disposal revokes queued work', async () => {
  const f = fixture({ bridge: { maxConcurrent: 1 } });
  const first = f.bridge.handleIncoming(f.incoming('20002', 1, 'SECRET_USER_BODY'));
  const second = f.bridge.handleIncoming(f.incoming('30003', 1, 'SECRET_QUEUED_BODY'));
  await until(() => f.calls.length === 1);
  for (const target of [{ qq: '99999', identityId: 'default' }, { qq: '20002', identityId: 'default', extra: 'bad' }, { qq: '20002', identityId: '../bad' }])
    await assert.rejects(f.bridge.stopConversation(target), { code: 'INVALID_CONVERSATION' });
  await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default', acknowledgeUncertain: 'yes' }), { code: 'INVALID_CONVERSATION' });
  const status = f.bridge.status; status.conversations[0].state = 'corrupted';
  assert.equal(f.status().state, 'running'); assert.equal(JSON.stringify(f.bridge.status).includes('SECRET'), false);
  const old = f.calls[0]; await f.bridge.dispose();
  assert.equal((await first).ok, false); assert.equal((await second).failureType, 'unavailable');
  f.finish(old, 'SECRET_LATE'); await tick(); assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 1);
  assert.equal(f.bridge.knowsAgent(old.agent), true); assert.equal(f.bridge.findByAgent(old.agent), undefined);
  assert.ok([...f.listeners.values()].every((items) => items.size === 0));
});

test('a completed tool-only turn sends one qualified terminal receipt without replaying the action or treating it as success', async (t) => {
  const f = fixture(); t.after(() => f.bridge.dispose());
  const msg = f.incoming('20002', 1), task = f.bridge.handleIncoming(msg);
  await until(() => f.calls.length === 1); toolEnding(f, f.calls[0]);
  const result = await task;
  assert.equal(result.ok, false); assert.equal(result.failureType, 'model_failed');
  assert.equal(result.delivered, undefined); assert.deepEqual(result.notification, { attempted: true, delivered: true });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], 'private:20002');
  assert.match(f.sent[0][1], /没有生成结果说明.*仍需核实/); assert.doesNotMatch(f.sent[0][1], /准备执行|PRIVATE_PROVIDER_ERROR|任务成功/);
  assert.equal(f.status().lastReplyAt, null); assert.equal(f.status().failureType, 'model_failed');
  assert.equal(f.bridge.handleIncoming(msg), task); await f.bridge.handleIncoming(msg);
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
});

test('non-completed host endings send one sanitized status while preserving the execution failure', async (t) => {
  for (const kind of ['error', 'aborted', 'blocked', 'max-tokens', 'unknown']) {
    const f = fixture(); t.after(() => f.bridge.dispose());
    const task = f.bridge.handleIncoming(f.incoming('20002', 1)); await until(() => f.calls.length === 1);
    toolEnding(f, f.calls[0], { kind, finalText: 'PRIVATE_PARTIAL_FINAL' });
    const result = await task;
    assert.equal(result.ok, false); assert.equal(result.failureType, 'model_failed'); assert.equal(result.notification.delivered, true);
    assert.equal(f.sent.length, 1); assert.match(f.sent[0][1], /未能正常结束.*结果尚未确认/);
    assert.doesNotMatch(JSON.stringify({ result, status: f.bridge.status, sent: f.sent }), /PRIVATE/);
  }
});

test('exceptions and timeouts after model submission send bounded factual failure notices without another followup', async (t) => {
  for (const mode of ['exception', 'timeout']) {
    const f = fixture({ bridge: { turnTimeoutMs: 20 }, respond: mode === 'exception' ? () => { throw new Error('PRIVATE_TOOL_FAILURE'); } : undefined });
    t.after(() => f.bridge.dispose());
    const result = await f.bridge.handleIncoming(f.incoming('20002', 1));
    assert.equal(result.failureType, mode === 'timeout' ? 'timeout' : 'model_failed');
    assert.equal(result.notification.delivered, true); assert.equal(result.ok, false); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    if (mode === 'timeout') { assert.equal(result.uncertain, true); assert.equal(f.created[0].canceled, 1); }
  }
});

test('a final-body send attempt is never followed by an extra status or a resend, even when its outcome is unknown', async (t) => {
  for (const receipt of [{ ok: false }, { ok: false, uncertain: true }, undefined]) {
    const f = fixture({ respond: (call, finish) => finish(call), send: async () => receipt }); t.after(() => f.bridge.dispose());
    const msg = f.incoming('20002', 1), task = f.bridge.handleIncoming(msg), result = await task;
    assert.equal(result.ok, false); assert.equal(result.notification, undefined); assert.equal(f.sent.length, 1);
    await f.bridge.handleIncoming(msg); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  }
});

test('status delivery failure is separate from the original execution failure and unknown notifications retain deduplication proof', async (t) => {
  for (const uncertain of [false, true]) {
    const f = fixture({ send: async () => ({ ok: false, uncertain }) }); t.after(() => f.bridge.dispose());
    const msg = f.incoming('20002', 1), task = f.bridge.handleIncoming(msg); await until(() => f.calls.length === 1);
    toolEnding(f, f.calls[0], { kind: 'error' }); const result = await task;
    assert.equal(result.failureType, 'model_failed'); assert.equal(result.uncertain, undefined);
    assert.equal(result.notification.delivered, false); assert.equal(result.notification.failureType, uncertain ? 'delivery_unknown' : 'send_failed');
    assert.equal(f.status().requiresUncertainAcknowledgement, uncertain); assert.equal(f.bridge.status.uncertainEntries, uncertain ? 1 : 0);
    assert.equal(f.bridge.handleIncoming(msg), task); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
    if (uncertain) await assert.rejects(f.bridge.recoverConversation({ qq: '20002', identityId: 'default' }), { code: 'UNCERTAIN_ACK_REQUIRED' });
  }
});

test('a hung terminal receipt times out without a second send and a late receipt never changes the failed task', async (t) => {
  const gate = deferred(); const f = fixture({ bridge: { statusTimeoutMs: 20 }, send: () => gate.promise });
  t.after(() => { gate.resolve({ ok: true }); return f.bridge.dispose(); });
  const task = f.bridge.handleIncoming(f.incoming('20002', 1)); await until(() => f.calls.length === 1); toolEnding(f, f.calls[0]);
  const result = await task;
  assert.equal(result.failureType, 'model_failed'); assert.equal(result.notification.uncertain, true); assert.equal(f.sent.length, 1);
  gate.resolve({ ok: true }); await tick(); assert.equal(f.sent.length, 1); assert.equal(result.notification.delivered, false);
});

test('short turns clear their progress timers and only send the actual final reply', async (t) => {
  const f = fixture({ bridge: { progressDelayMs: 15 }, respond: (call, finish) => finish(call) }); t.after(() => f.bridge.dispose());
  const result = await f.bridge.handleIncoming(f.incoming('20002', 1)); assert.equal(result.ok, true); assert.equal(result.progress, undefined);
  await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(f.sent.length, 1); assert.match(f.sent[0][1], /^reply:/);
});

test('slow turns send progress at most once and serialize final output and the next input behind its confirmed receipt', async (t) => {
  const gate = deferred();
  const f = fixture({ bridge: { progressDelayMs: 15 }, send: (_target, text) => text.startsWith('已收到') ? gate.promise : { ok: true } });
  t.after(() => { gate.resolve({ ok: true }); return f.bridge.dispose(); });
  const first = f.bridge.handleIncoming(f.incoming('20002', 1));
  const next = f.bridge.handleIncoming(f.incoming('20002', 2));
  await until(() => f.sent.length === 1); assert.match(f.sent[0][1], /正在处理.*完成后会回复结果/);
  f.finish(f.calls[0], 'FINAL_RESULT'); await tick(); assert.equal(f.sent.length, 1); assert.equal(f.calls.length, 1);
  gate.resolve({ ok: true }); const result = await first;
  assert.equal(result.ok, true); assert.equal(result.progress.delivered, true);
  await until(() => f.calls.length === 2); f.finish(f.calls[1], 'NEXT_RESULT'); await next;
  assert.deepEqual(f.sent.map(([, text]) => text), ['已收到，正在处理；完成后会回复结果。', 'FINAL_RESULT', 'NEXT_RESULT']);
});

test('a known rejected progress receipt permits the final reply; an unknown progress receipt blocks further sends without replay', async (t) => {
  for (const uncertain of [false, true]) {
    const f = fixture({ bridge: { progressDelayMs: 10 }, send: (_target, text) => text.startsWith('已收到') ? { ok: false, uncertain } : { ok: true } });
    t.after(() => f.bridge.dispose());
    const msg = f.incoming('20002', 1), task = f.bridge.handleIncoming(msg);
    await until(() => f.sent.length === 1);
    if (!uncertain) { f.finish(f.calls[0], 'FINAL_RESULT'); assert.equal((await task).ok, true); assert.equal(f.sent.length, 2); }
    else {
      const result = await task; assert.equal(result.failureType, 'delivery_unknown'); assert.equal(result.progress.uncertain, true);
      assert.equal(result.notification, undefined); assert.equal(f.status().state, 'blocked'); assert.equal(f.created[0].canceled, 1);
      f.finish(f.calls[0], 'LATE_FINAL'); await f.bridge.handleIncoming(msg); await tick(); assert.equal(f.sent.length, 1); assert.equal(f.calls.length, 1);
    }
  }
});

test('progress receipt timeout is bounded and never falls through to a terminal status or late final text', async (t) => {
  const gate = deferred(); const f = fixture({ bridge: { progressDelayMs: 10, statusTimeoutMs: 15 }, send: () => gate.promise });
  t.after(() => { gate.resolve({ ok: true }); return f.bridge.dispose(); });
  const task = f.bridge.handleIncoming(f.incoming('20002', 1)); const result = await task;
  assert.equal(result.failureType, 'delivery_unknown'); assert.equal(result.progress.uncertain, true); assert.equal(f.sent.length, 1);
  gate.resolve({ ok: true }); f.finish(f.calls[0], 'LATE'); await tick(); assert.equal(f.sent.length, 1);
});

test('stop, disposal and changed self identity fence delayed progress and terminal notifications', async (t) => {
  for (const mode of ['stop', 'dispose', 'identity']) {
    const f = fixture({ bridge: { progressDelayMs: 15 } }); t.after(() => f.bridge.dispose());
    const task = f.bridge.handleIncoming(f.incoming('20002', 1)); await until(() => f.calls.length === 1);
    if (mode === 'stop') await f.bridge.stopConversation({ qq: '20002', identityId: 'default' });
    if (mode === 'dispose') await f.bridge.dispose();
    if (mode === 'identity') { f.gateway.selfId = '99999'; toolEnding(f, f.calls[0], { kind: 'error' }); }
    assert.equal((await task).ok, false);
    await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(f.sent.length, 0);
  }
});

test('stopping during progress or terminal status prevents every later send and keeps the active delivery uncertain', async (t) => {
  for (const kind of ['progress', 'terminal']) {
    const gate = deferred(); const f = fixture({ bridge: { progressDelayMs: 10 }, send: () => gate.promise });
    t.after(() => { gate.resolve({ ok: true }); return f.bridge.dispose(); });
    const task = f.bridge.handleIncoming(f.incoming('20002', 1)); await until(() => f.calls.length === 1);
    if (kind === 'terminal') toolEnding(f, f.calls[0]);
    await until(() => f.sent.length === 1);
    await f.bridge.stopConversation({ qq: '20002', identityId: 'default' }); const result = await task;
    assert.equal(result.failureType, 'stopped'); assert.equal(result.uncertain, true); assert.equal(f.status().requiresUncertainAcknowledgement, true);
    gate.resolve({ ok: true }); f.finish(f.calls[0], 'LATE_FINAL'); await tick(); assert.equal(f.sent.length, 1);
  }
});

test('progress and terminal notices retain their own conversation target while another account completes normally', async (t) => {
  const f = fixture({ bridge: { progressDelayMs: 10 } }); t.after(() => f.bridge.dispose());
  const primary = f.bridge.handleIncoming(f.incoming('20002', 1)); const guest = f.bridge.handleIncoming(f.incoming('30003', 1));
  await until(() => f.calls.length === 2);
  f.finish(f.calls.find((call) => call.message.content[0].text === '30003:1'), 'GUEST_FINAL');
  assert.equal((await guest).ok, true); await until(() => f.sent.length === 2);
  toolEnding(f, f.calls.find((call) => call.message.content[0].text === '20002:1'));
  const result = await primary; assert.equal(result.ok, false); assert.equal(result.progress.delivered, true); assert.equal(result.notification.delivered, true);
  assert.deepEqual(f.sent.map(([target]) => target), ['private:30003', 'private:20002', 'private:20002']);
  assert.equal(f.calls.length, 2);
});

test('the default turn deadline is bounded at ten minutes while explicit short test deadlines remain effective', async (t) => {
  for (const [configured, expected] of [[undefined, 600000], [999999, 600000], [0, 600000], [25, 25]]) {
    const f = fixture({ bridge: { turnTimeoutMs: configured } }); t.after(() => f.bridge.dispose());
    assert.equal(f.bridge.turnTimeoutMs, expected); assert.equal(f.bridge.progressDelayMs, 3000);
    if (configured === 25) {
      const result = await f.bridge.handleIncoming(f.incoming('20002', 1));
      assert.equal(result.failureType, 'timeout'); assert.match(f.sent[0][1], /超时.*操作可能已执行.*核实/);
    }
  }
});

test('production tasks cannot send progress, terminal status or final text after connection or login provenance changes', async (t) => {
  for (const mode of ['disconnected', 'offline', 'unverified', 'socket', 'connectedAt']) {
    const f = fixture({ bridge: { progressDelayMs: 10 } }); t.after(() => f.bridge.dispose());
    const task = f.bridge.handleIncoming(f.incoming('20002', 1)); await until(() => f.calls.length === 1);
    if (mode === 'disconnected') f.gateway.connected = false;
    if (mode === 'offline') f.gateway.online = false;
    if (mode === 'unverified') f.gateway.loginVerified = false;
    if (mode === 'socket') f.gateway.wsClient = { fixture: 'same-self-new-connection' };
    if (mode === 'connectedAt') f.gateway.connectedAtMs++;
    await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(f.sent.length, 0);
    f.finish(f.calls[0], 'STALE_FINAL');
    const result = await task; assert.equal(result.failureType, 'connection_changed'); assert.equal(result.uncertain, true);
    assert.equal(f.sent.length, 0); assert.equal(result.notification, undefined);
  }
  const f = fixture(); t.after(() => f.bridge.dispose());
  const task = f.bridge.handleIncoming(f.incoming('20002', 1)); await until(() => f.calls.length === 1);
  f.gateway.wsClient = { fixture: 'same-self-new-connection' }; toolEnding(f, f.calls[0], { kind: 'error' });
  const result = await task; assert.equal(result.failureType, 'model_failed');
  assert.deepEqual(result.notification, { attempted: false, delivered: false }); assert.equal(f.sent.length, 0);
});

test('duplicates after slow-task progress and after completion share one dispatch, one progress receipt and one final reply', async (t) => {
  const f = fixture({ bridge: { progressDelayMs: 10 } }); t.after(() => f.bridge.dispose());
  const incoming = f.incoming('20002', 1), first = f.bridge.handleIncoming(incoming);
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0][1], '已收到，正在处理；完成后会回复结果。');
  assert.equal(f.status().running, true);
  const duringProgress = f.bridge.handleIncoming(structuredClone(incoming));
  assert.equal(duringProgress, first); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  f.finish(f.calls[0], 'LONG_TASK_FINAL'); const result = await first;
  assert.equal(result.ok, true); assert.equal(result.delivered, true); assert.equal(result.progress.delivered, true);
  const afterCompletion = f.bridge.handleIncoming(structuredClone(incoming));
  assert.equal(afterCompletion, first); assert.equal(await afterCompletion, result);
  assert.equal(await duringProgress, result);
  assert.equal(f.created.length, 1); assert.equal(f.calls.length, 1); assert.equal(f.created[0].calls.length, 1);
  assert.deepEqual(f.sent.map(([target, text]) => ({ target, text })), [
    { target: 'private:20002', text: '已收到，正在处理；完成后会回复结果。' },
    { target: 'private:20002', text: 'LONG_TASK_FINAL' },
  ]);
});

test('an explicit failed tool result followed by host error never redispatches or duplicates the terminal receipt', async (t) => {
  const f = fixture(); t.after(() => f.bridge.dispose());
  const incoming = f.incoming('20002', 1), first = f.bridge.handleIncoming(incoming);
  const concurrentDuplicate = f.bridge.handleIncoming(structuredClone(incoming));
  assert.equal(concurrentDuplicate, first);
  await until(() => f.calls.length === 1);
  let observedToolResult;
  const unregister = f.bridge.ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/result') observedToolResult = event.data.result;
  });
  t.after(unregister);
  toolEnding(f, f.calls[0], { kind: 'error', toolResult: { isError: true, exitCode: 23, content: [{ type: 'text', text: 'CONTROLLED_EXIT_23' }] } });
  const result = await first;
  assert.equal(observedToolResult.isError, true); assert.equal(observedToolResult.exitCode, 23);
  assert.equal(result.ok, false); assert.equal(result.failureType, 'model_failed'); assert.equal(result.delivered, undefined);
  assert.equal(result.notification.delivered, true);
  const afterCompletion = f.bridge.handleIncoming(structuredClone(incoming));
  assert.equal(afterCompletion, first); assert.equal(await afterCompletion, result); assert.equal(await concurrentDuplicate, result);
  assert.equal(f.created.length, 1); assert.equal(f.calls.length, 1); assert.equal(f.created[0].calls.length, 1);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], 'private:20002');
  assert.equal(f.sent[0][1], '本轮未能正常结束，部分操作可能已执行，结果尚未确认。请先核实，避免重复执行。');
  assert.doesNotMatch(f.sent[0][1], /CONTROLLED_EXIT_23|准备执行/);
});
