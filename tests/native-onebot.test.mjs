import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeOneBotBridge } from '../packages/dsh-dafeiyu/src/native-onebot.js';

const incoming = (id = 1, patch = {}) => ({ channel: 'onebot', selfId: '10001', userId: '20002',
  messageId: String(id), messageType: 'private', isGroup: false, groupId: null, text: '查询伴侣状态',
  raw: { post_type: 'message', message_type: 'private', self_id: 10001, user_id: 20002, message_id: id }, ...patch });

function fixture(options = {}) {
  const listeners = new Map(), created = [], mounted = [], sent = [], warnings = [];
  let responder = options.responder;
  const emit = (name, ...args) => { for (const listener of [...(listeners.get(name) || [])]) listener(...args); };
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'host-provider', model: 'host-selected-model' }) },
    agentPresets: { mount: async (_ctx, preset) => { mounted.push(preset); } },
    agents: { withoutInitiator: (fn) => fn(), create: async (opts) => {
      const session = { id: opts.sessionId }, calls = [], canceled = [];
      const own = {};
      const agent = { session, ctx: { get: (name) => own[name] ?? services[name], provide: (name, service) => { own[name] = service; } }, cancel: (reason) => canceled.push(reason),
        followup(message) { calls.push(message); responder?.({ agent, message, emit, calls }); } };
      const record = { opts, agent, calls, canceled, disposed: 0 };
      created.push(record);
      await opts.setup(agent.ctx, agent);
      return { agent, dispose: async () => { record.disposed++; } };
    } },
  };
  const ctx = { get: (name) => services[name], on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return () => listeners.get(name).delete(handler);
  } };
  const gateway = { selfId: '10001', connected: true, online: true, loginVerified: true, identitySource: 'lifecycle', sendMessage: async (...args) => {
    sent.push(args); return { ok: true, data: { message_id: 42 } };
  } };
  const bridge = new NativeOneBotBridge({ ctx, qqGateway: gateway, ownerQq: '20002', expectedSelfId: '10001',
    // Normal asynchronous fixtures must tolerate process contention from the full suite.
    // Timeout-specific cases still pass an explicit short deadline.
    logger: { warn: (line) => warnings.push(line) }, turnTimeoutMs: 1000,
    now: () => Math.max(1700000001000, Number.isSafeInteger(gateway.connectedAtMs) ? gateway.connectedAtMs + 1000 : 0), ...options.bridge });
  return { bridge, ctx, gateway, services, created, mounted, sent, emit, listeners, warnings,
    setResponder: (fn) => { responder = fn; } };
}

function finish({ agent, message, emit }, { turn = 1, text = '当前状态已查询', reason = { kind: 'completed' }, content } = {}) {
  emit('session/event', agent.session, { type: 'turn/start', data: { turn } });
  emit('agent/inbox/claimed', { agent, message, turn });
  emit('session/event', agent.session, { type: 'user/message', data: message });
  emit('session/event', agent.session, { type: 'assistant/message', surfaceOp: 'append',
    data: { turn, message: { content: content || [{ type: 'text', text }] } } });
  emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason } });
}

test('real native create/preset/default-model contracts lead to one original private reply', async () => {
  const f = fixture({ responder: (args) => finish(args) });
  const result = await f.bridge.handleIncoming(incoming());
  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.created[0].opts.agentOptions, { provider: 'host-provider', model: 'host-selected-model' });
  assert.deepEqual(f.created[0].opts.meta, { agentPreset: 'standard' });
  assert.deepEqual(f.mounted, ['standard']);
  assert.match(result.sessionId, /^im:dafeiyu-onebot:10001:dm:20002:/);
  assert.equal(f.sent[0][0], 'private:20002');
  assert.equal(f.sent[0][1], '当前状态已查询');
  assert.deepEqual(f.sent[0][2], { messageId: '1', selfId: '10001' });
  await f.bridge.dispose();
});

test('activity reports admitted input and confirmed delivery without retaining message bodies', async () => {
  let complete;
  const f = fixture({ responder: (args) => { complete = () => finish(args); } });
  assert.equal(f.bridge.status.lastEventAt, null);
  assert.equal(f.bridge.status.lastReplyAt, null);
  assert.equal(f.bridge.status.active, false);
  await f.bridge.handleIncoming(incoming(1, { userId: '99999' }));
  assert.equal(f.bridge.status.lastEventAt, null, 'rejected input must not be reported as owner activity');
  const pending = f.bridge.handleIncoming(incoming());
  await new Promise((resolve) => setImmediate(resolve));
  const active = f.bridge.status;
  assert.equal(active.pending, 1);
  assert.equal(active.active, true);
  assert.ok(Number.isFinite(Date.parse(active.lastEventAt)));
  assert.equal(active.lastReplyAt, null);
  assert.equal(JSON.stringify(active).includes('查询伴侣状态'), false);
  complete();
  assert.equal((await pending).delivered, true);
  assert.equal(f.bridge.status.pending, 0);
  assert.equal(f.bridge.status.active, false);
  assert.ok(Number.isFinite(Date.parse(f.bridge.status.lastReplyAt)));
  await f.bridge.dispose();
});

test('only bound bot/owner private messages with exact raw provenance are admitted', async () => {
  const f = fixture({ responder: (args) => finish(args) });
  const rejected = [
    incoming(1, { isGroup: true }), incoming(1, { channel: 'official' }),
    incoming(1, { raw: { ...incoming().raw, message_type: 'group' } }),
    incoming(1, { raw: { ...incoming().raw, self_id: undefined } }),
    incoming(1, { raw: { ...incoming().raw, message_id: undefined } }),
    incoming(1, { raw: { ...incoming().raw, user_id: 10001 }, userId: '10001' }),
    incoming(1, { raw: { ...incoming().raw, user_id: 30003 }, userId: '30003' }),
    incoming(1, { selfId: '30003' }), incoming(1, { messageId: '2' }),
    incoming(1, { raw: { ...incoming().raw, group_id: 0 } }),
    incoming(1, { raw: { ...incoming().raw, self_id: 30003 }, selfId: '30003' }),
  ];
  for (const msg of rejected) assert.equal((await f.bridge.handleIncoming(msg)).ok, false);
  f.gateway.selfId = '';
  assert.equal((await f.bridge.handleIncoming(incoming())).ok, false);
  assert.equal(f.created.length, 0);
  await f.bridge.dispose();
});

test('same message is deduplicated before model, including concurrent delivery', async () => {
  const f = fixture({ responder: (args) => setImmediate(() => finish(args)) });
  const first = f.bridge.handleIncoming(incoming());
  const second = f.bridge.handleIncoming(incoming());
  assert.equal(first, second);
  await Promise.all([first, second]);
  await f.bridge.handleIncoming(incoming());
  assert.equal(f.created[0].calls.length, 1);
  assert.equal(f.sent.length, 1);
  await f.bridge.dispose();
});

test('successive inputs reuse one real session and wait for previous turn and send', async () => {
  let turn = 0, simultaneous = 0, peak = 0;
  const f = fixture({ responder: (args) => { simultaneous++; peak = Math.max(peak, simultaneous);
    const current = ++turn;
    setTimeout(() => { simultaneous--; finish(args, { turn: current, text: `reply-${current}` }); }, 5);
  } });
  const results = await Promise.all([f.bridge.handleIncoming(incoming(1)), f.bridge.handleIncoming(incoming(2))]);
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(f.created.length, 1);
  assert.equal(peak, 1);
  assert.deepEqual(f.sent.map((args) => args[1]), ['reply-1', 'reply-2']);
  await f.bridge.dispose();
});

test('current persona requests remain user messages in the same account conversation with a fixed reply target', async () => {
  let turn = 0;
  const f = fixture({ responder: (args) => finish(args, { turn: ++turn }) });
  const requests = ['今天先叫我阿青，说话正经一些。', '现在恢复之前的称呼，但回答详细一点。'];
  const results = [];
  for (const [index, text] of requests.entries()) results.push(await f.bridge.handleIncoming(incoming(index + 1, { text })));
  assert.equal(results.every((result) => result.delivered), true);
  assert.equal(f.created.length, 1);
  assert.equal(results[0].sessionId, results[1].sessionId);
  assert.deepEqual(f.created[0].calls.map(({ role, content, source }) => ({ role, content, kind: source.kind })),
    requests.map((text) => ({ role: 'user', content: [{ type: 'text', text }], kind: 'user' })));
  assert.deepEqual(f.sent.map(([target, , context]) => ({ target, selfId: context.selfId })),
    requests.map(() => ({ target: 'private:20002', selfId: '10001' })));
  await f.bridge.dispose();
});

test('registry only recognizes its actual agent or wrapper sharing the same actual session', async () => {
  const f = fixture({ responder: (args) => finish(args) });
  await f.bridge.handleIncoming(incoming());
  const agent = f.created[0].agent;
  const record = f.bridge.findByAgent(agent);
  assert.equal(record.channel, 'onebot');
  assert.equal(record.scope, 'private');
  assert.equal(record.selfId, '10001');
  assert.equal(record.peerId, '20002');
  assert.equal(f.bridge.findByAgent({ session: agent.session }).agent, agent);
  assert.equal(f.bridge.findByAgent({ session: { id: agent.session.id } }), undefined);
  assert.equal(f.bridge.findByAgent({ id: agent.id }), undefined);
  assert.equal(agent.ctx.get('onebotChannel'), undefined, 'per-agent provenance comes from the bridge registry, not a shared Cordis service name');
  await f.bridge.dispose();
  assert.equal(f.bridge.findByAgent(agent), undefined);
  assert.equal(f.bridge.knowsAgent(agent), true);
});

test('foreign sessions, unclaimed turns, replay and tool-call narratives never become QQ replies', async () => {
  const f = fixture({ responder(args) {
    const { agent, message, emit } = args;
    finish({ ...args, agent: { session: { id: agent.session.id } } }, { text: 'foreign' });
    emit('session/event', agent.session, { type: 'assistant/message', surfaceOp: 'append',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'unclaimed' }] } } });
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } });
    emit('agent/inbox/claimed', { agent, message, turn: 2 });
    for (const event of [
      { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { content: [{ type: 'text', text: 'old-turn' }] } } },
      { type: 'assistant/message', surfaceOp: 'update', data: { turn: 2, message: { content: [{ type: 'text', text: 'replayed' }] } } },
      { type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, message: { content: [{ type: 'text', text: 'interim' }, { type: 'tool-call' }] } } },
    ]) emit('session/event', agent.session, event);
    finish(args, { turn: 2, text: 'real-final' });
  } });
  assert.equal((await f.bridge.handleIncoming(incoming())).ok, true);
  assert.deepEqual(f.sent.map((args) => args[1]), ['real-final']);
  await f.bridge.dispose();
});

test('user/message after turn/start correlates actual host events without claimed hook', async () => {
  const f = fixture({ responder({ agent, message, emit }) {
    emit('session/event', agent.session, { type: 'turn/start', data: { turn: 3 } });
    emit('session/event', agent.session, { type: 'user/message', data: message });
    emit('session/event', agent.session, { type: 'assistant/message', surfaceOp: 'append', data: { turn: 3,
      message: { content: [{ type: 'text', text: 'correlated' }] } } });
    emit('session/event', agent.session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
  } });
  assert.equal((await f.bridge.handleIncoming(incoming())).ok, true);
  await f.bridge.dispose();
});

test('host errors and empty/unknown endings report failure with a factual status instead of invented success', async () => {
  for (const end of [{ kind: 'error', error: { message: 'provider rejected' } }, { kind: 'aborted' }, undefined]) {
    const f = fixture({ responder: (args) => finish(args, { reason: end || { kind: 'unknown' } }) });
    const result = await f.bridge.handleIncoming(incoming());
    assert.equal(result.ok, false);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0][1], /未能正常结束.*结果尚未确认/);
    assert.equal(result.notification.delivered, true);
    await f.bridge.dispose();
  }
  const f = fixture({ responder: (args) => finish(args, { content: [{ type: 'image', path: '/private/arbitrary.png' }] }) });
  const result = await f.bridge.handleIncoming(incoming());
  assert.match(result.error, /未返回/);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /没有生成结果说明.*仍需核实/);
  await f.bridge.dispose();
});

test('unconfirmed outbound is never retried or regenerated for duplicate input', async () => {
  const f = fixture({ responder: (args) => finish(args) });
  f.gateway.sendMessage = async (...args) => { f.sent.push(args); return { ok: false, uncertain: true, error: 'transport timeout' }; };
  const first = await f.bridge.handleIncoming(incoming());
  assert.equal(first.ok, false);
  assert.equal(first.uncertain, true);
  assert.deepEqual(await f.bridge.handleIncoming(incoming()), first);
  assert.equal(f.sent.length, 1);
  assert.equal(f.created[0].calls.length, 1);
  await f.bridge.dispose();
});

test('timeouts cancel only own agent, block subsequent execution and send one unconfirmed-result status', async () => {
  const f = fixture({ bridge: { turnTimeoutMs: 15 } });
  const result = await f.bridge.handleIncoming(incoming());
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.match(result.error, /超时/);
  assert.equal(f.created[0].canceled.length, 1);
  assert.equal((await f.bridge.handleIncoming(incoming(2))).ok, false);
  assert.equal(f.created[0].calls.length, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /超时.*结果尚未确认/);
  assert.equal(result.notification.delivered, true);
  await f.bridge.dispose();
});

test('bounded queue, output and dedup capacity fail closed rather than growing indefinitely', async () => {
  const f = fixture({ bridge: { maxPending: 1 }, responder: (args) => setTimeout(() => finish(args), 5) });
  const first = f.bridge.handleIncoming(incoming());
  assert.match((await f.bridge.handleIncoming(incoming(2))).error, /队列已满/);
  await first;
  await f.bridge.dispose();
  const g = fixture({ bridge: { maxSeen: 1 }, responder: (args) => finish(args) });
  await g.bridge.handleIncoming(incoming());
  assert.match((await g.bridge.handleIncoming(incoming(2))).error, /去重容量/);
  await g.bridge.dispose();
  const h = fixture({ bridge: { maxReplyChars: 3 }, responder: (args) => finish(args, { text: 'too long' }) });
  assert.match((await h.bridge.handleIncoming(incoming())).error, /输出容量/);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0][1], /结果尚未确认/);
  await h.bridge.dispose();
});

test('changing self identity before output prevents misdelivery and image paths are never parsed from prose', async () => {
  const f = fixture({ responder: (args) => { f.gateway.selfId = '30003'; finish(args, { text: '/private/key.png' }); } });
  assert.equal((await f.bridge.handleIncoming(incoming())).ok, false);
  assert.equal(f.sent.length, 0);
  await f.bridge.dispose();
});

test('constructor remains lazy without agent services, and status is a read-only snapshot', async () => {
  const f = fixture();
  delete f.services.agents;
  f.gateway.connected = false;
  assert.equal(f.bridge.status.connected, false);
  assert.equal(f.bridge.status.sessionCreated, false);
  assert.throws(() => { f.bridge.status.connected = true; });
  assert.equal((await f.bridge.handleIncoming(incoming())).failureType, 'session_failed');
  await f.bridge.dispose();
});

test('dispose during active input revokes registry, queued input and event handlers', async () => {
  let observed;
  const f = fixture({ responder: (args) => { observed = args; } });
  const first = f.bridge.handleIncoming(incoming()), second = f.bridge.handleIncoming(incoming(2));
  while (!observed) await new Promise((resolve) => setImmediate(resolve));
  await f.bridge.dispose();
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, false);
  assert.equal(f.created[0].calls.length, 1);
  assert.equal(f.created[0].disposed, 1);
  assert.equal([...f.listeners.values()].reduce((count, set) => count + set.size, 0), 0);
  finish(observed);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.bridge.handleIncoming(incoming(3))).ok, false);
});

test('chunking preserves unicode and stops immediately on a failed receipt', async () => {
  const f = fixture({ bridge: { chunkChars: 2 }, responder: (args) => finish(args, { text: '😀一二三' }) });
  assert.equal((await f.bridge.handleIncoming(incoming())).ok, true);
  assert.deepEqual(f.sent.map((args) => args[1]), ['😀一', '二三']);
  await f.bridge.dispose();
});

test('partially sent replies do not advance the last completed reply time', async () => {
  const f = fixture({ bridge: { chunkChars: 2 }, responder: (args) => finish(args, { text: '一二三四五六' }) });
  let sends = 0;
  f.gateway.sendMessage = async () => ++sends === 1 ? { ok: true } : { ok: false, error: 'fixture failure' };
  const result = await f.bridge.handleIncoming(incoming());
  assert.equal(result.ok, false);
  assert.equal(result.sentMessages, 1);
  assert.equal(sends, 2);
  assert.equal(f.bridge.status.lastReplyAt, null);
  assert.ok(f.bridge.status.lastError);
  await f.bridge.dispose();
});

test('known model errors allow a new message while retaining duplicate suppression', async () => {
  let count = 0;
  const f = fixture({ responder: (args) => finish(args, ++count === 1
    ? { reason: { kind: 'error', error: { message: 'model unavailable' } } }
    : { turn: count, text: 'model recovered' }) });
  assert.equal((await f.bridge.handleIncoming(incoming(1))).ok, false);
  assert.equal((await f.bridge.handleIncoming(incoming(2))).ok, true);
  assert.equal(f.created[0].calls.length, 2);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0][1], /未能正常结束/);
  assert.equal(f.sent[1][1], 'model recovered');
  await f.bridge.dispose();
});

test('configured identity alone and disconnected/stale/conflicting identities never report verified', async () => {
  const f = fixture();
  assert.equal(f.bridge.status.identityVerified, true);
  f.gateway.identitySource = 'configured';
  assert.equal(f.bridge.status.identityVerified, false);
  f.gateway.identitySource = 'get_login_info';
  f.gateway.connected = false;
  assert.equal(f.bridge.status.identityVerified, false);
  f.gateway.connected = true;
  f.gateway.identityConflict = true;
  assert.equal(f.bridge.status.identityVerified, false);
  f.gateway.identityConflict = false;
  f.gateway.online = false;
  assert.equal(f.bridge.status.identityVerified, false);
  await f.bridge.dispose();
});

test('late creation after disposal is canceled and disposed without invoking a model', async () => {
  const f = fixture({ bridge: { disposeTimeoutMs: 25 } });
  let resolveCreate;
  const pendingCreate = new Promise((resolve) => { resolveCreate = resolve; });
  f.services.agents.create = () => pendingCreate;
  const input = f.bridge.handleIncoming(incoming());
  while (!f.bridge.creating) await new Promise((resolve) => setImmediate(resolve));
  await f.bridge.dispose();
  assert.equal((await input).ok, false);
  let canceled = 0, disposed = 0;
  resolveCreate({ agent: { cancel: () => { canceled++; }, followup: () => assert.fail('late agent must not run') },
    dispose: async () => { disposed++; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(canceled, 1);
  assert.equal(disposed, 1);
  assert.equal(f.sent.length, 0);
});

test('native default-model reasoning selection and factory-generated message ids survive routing', async () => {
  const f = fixture({ responder: (args) => finish(args), bridge: {
    createMessage: ({ requestId, text }) => ({ id: 'fresh-factory-message-id', role: 'user',
      content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } }),
  } });
  f.services.agentDefaultModel.currentSelection = () => ({ provider: 'host-provider', model: 'host-selected-model', reasoningEffort: 'high' });
  assert.equal((await f.bridge.handleIncoming(incoming())).ok, true);
  assert.equal(f.created[0].opts.agentOptions.reasoningEffort, 'high');
  assert.notEqual(f.created[0].calls[0].id, f.created[0].calls[0].source.rpcId);
  assert.equal(f.sent.length, 1);
  await f.bridge.dispose();
});

test('output overflow cancellation waits until the actual host append publication has returned', async () => {
  let publishing = false, canceledOutsidePublication = false;
  const f = fixture({ bridge: { maxReplyChars: 3 }, responder(args) {
    const cancel = args.agent.cancel;
    args.agent.cancel = (reason) => {
      if (publishing) throw new Error('session append cannot reenter while another append is being published');
      canceledOutsidePublication = true;
      cancel(reason);
    };
    publishing = true;
    finish(args, { text: 'too long' });
    publishing = false;
  } });
  assert.equal((await f.bridge.handleIncoming(incoming())).ok, false);
  assert.equal(canceledOutsidePublication, true);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /结果尚未确认/);
  await f.bridge.dispose();
});

const timedIncoming = (id, seconds, normalizedMs = seconds * 1000) => incoming(id, {
  time: normalizedMs, raw: { ...incoming(id).raw, time: seconds },
});

test('opt-in no-history admission requires actual source seconds and exact normalized milliseconds', async () => {
  const f = fixture({ bridge: { rejectBeforeConnection: true }, responder: (args) => finish(args) });
  f.gateway.connectedAtMs = 1700000000123;
  for (const seconds of [undefined, null, 0, -1, 1.5, NaN, Infinity, '1700000000', Number.MAX_SAFE_INTEGER]) {
    const result = await f.bridge.handleIncoming(timedIncoming(1, seconds));
    assert.equal(result.ok, false, String(seconds));
    assert.equal(result.rejected, true);
  }
  // A fallback/current normalized timestamp cannot substitute for absent source
  // time or make an old source timestamp appear new.
  for (const msg of [timedIncoming(2, undefined, 1700000000000),
    timedIncoming(3, 1699999999, 1700000000000), timedIncoming(4, 1700000000, 1700000000001),
    timedIncoming(5, 1700000000, '1700000000000')]) {
    assert.equal((await f.bridge.handleIncoming(msg)).ok, false);
  }
  assert.equal(f.created.length, 0);
  assert.equal(f.sent.length, 0);
  await f.bridge.dispose();
});

test('connection window rejects old messages but accepts exactly the same source second', async () => {
  const f = fixture({ bridge: { rejectBeforeConnection: true }, responder: (args) => finish(args) });
  f.gateway.connectedAtMs = 1700000000999;
  assert.match((await f.bridge.handleIncoming(timedIncoming(1, 1699999999))).error, /历史消息/);
  assert.equal(f.created.length, 0);
  assert.equal((await f.bridge.handleIncoming(timedIncoming(2, 1700000000))).ok, true);
  assert.equal((await f.bridge.handleIncoming(timedIncoming(3, 1700000001))).ok, true);
  assert.equal(f.created[0].calls.length, 2);
  await f.bridge.dispose();
});

test('missing/disconnected connection timestamp and a reconnect use the new exact window', async () => {
  const f = fixture({ bridge: { rejectBeforeConnection: true }, responder: (args) => finish(args) });
  for (const time of [undefined, 0, -1, NaN, Infinity, '1700000000123']) {
    f.gateway.connectedAtMs = time;
    assert.equal((await f.bridge.handleIncoming(timedIncoming(1, 1700000000))).ok, false);
  }
  assert.equal(f.created.length, 0);
  f.gateway.connectedAtMs = 1700000000123;
  assert.equal((await f.bridge.handleIncoming(timedIncoming(2, 1700000000))).ok, true);
  f.gateway.connectedAtMs = 0;
  assert.equal((await f.bridge.handleIncoming(timedIncoming(3, 1700000001))).ok, false);
  f.gateway.connectedAtMs = 1700000005999;
  assert.equal((await f.bridge.handleIncoming(timedIncoming(4, 1700000004))).ok, false);
  assert.equal((await f.bridge.handleIncoming(timedIncoming(5, 1700000005))).ok, true);
  assert.equal(f.created[0].calls.length, 2);
  await f.bridge.dispose();
});

test('reconnection revokes the old active output and its queued input before any further model or send', async () => {
  let firstTurn;
  const f = fixture({ bridge: { rejectBeforeConnection: true }, responder: (args) => { firstTurn = args; } });
  f.gateway.connectedAtMs = 1700000000123;
  const first = f.bridge.handleIncoming(timedIncoming(1, 1700000000));
  const queued = f.bridge.handleIncoming(timedIncoming(2, 1700000000));
  while (!firstTurn) await new Promise((resolve) => setImmediate(resolve));
  f.gateway.connectedAtMs = 1700000001123;
  finish(firstTurn);
  assert.equal((await first).failureType, 'connection_changed');
  assert.equal((await queued).failureType, 'blocked');
  assert.equal(f.created[0].calls.length, 1);
  assert.equal(f.sent.length, 0);
  await f.bridge.dispose();
});
