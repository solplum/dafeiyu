import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeOneBotBridge } from '../packages/dsh-dafeiyu/src/native-onebot.js';
import { BackgroundTaskManager } from '../packages/dsh-dafeiyu/src/background-tasks.js';

const scope = Object.freeze({ selfId: '10001', peerId: '20002', identityId: 'default' });
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < end, 'integration fixture did not reach the expected state'); await tick(); }
}

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-background-qq-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const listeners = new Map(), created = [], calls = [], sent = [], runs = [];
  const clock = { value: 1700000000000 };
  const emit = (name, ...args) => { for (const handler of [...(listeners.get(name) || [])]) handler(...args); };
  const finish = (call, text) => {
    emit('session/event', call.agent.session, { type: 'turn/start', data: { turn: call.turn } });
    emit('agent/inbox/claimed', { agent: call.agent, message: call.message, turn: call.turn });
    emit('session/event', call.agent.session, { type: 'assistant/message', surfaceOp: 'append', data: {
      turn: call.turn, message: { content: [{ type: 'text', text }] },
    } });
    emit('session/event', call.agent.session, { type: 'turn/end', data: { turn: call.turn, reason: { kind: 'completed' } } });
  };
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'offline', model: 'background-fixture' }) },
    agentPresets: { async mount() {} },
    agents: { withoutInitiator: (fn) => fn(), async create(opts) {
      const tools = { guard() {}, restrict() {} }, record = { opts, calls: [], cancelled: 0, disposed: 0 };
      const agent = { session: { id: opts.sessionId }, ctx: { get: (name) => name === 'tools' ? tools : services[name] },
        cancel() { record.cancelled++; }, followup(message) {
          const call = { agent, message, turn: record.calls.length + 1, record };
          calls.push(call); record.calls.push(call); options.respond?.(call, finish);
        } };
      record.agent = agent; created.push(record); await opts.setup(agent.ctx, agent);
      return { agent, async dispose() { record.disposed++; } };
    } },
  };
  const ctx = { get: (name) => services[name], on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler); return () => listeners.get(name).delete(handler);
  } };
  const gateway = { selfId: '10001', connected: true, connectedAtMs: clock.value, online: true,
    loginVerified: true, identitySource: 'lifecycle', wsClient: {}, async sendMessage(...args) {
      sent.push(args); return options.send ? options.send(...args) : { ok: true, data: { message_id: sent.length } };
    } };
  let bridge;
  const manager = new BackgroundTaskManager({ storeFile: path.join(dir, 'tasks.json'), defaultCwd: workspace,
    executors: { native: { available: async () => ({ available: true }), async run(job) {
      const gate = deferred(), run = { job, signal: job.signal, gate, finished: false };
      runs.push(run);
      const result = await gate.promise; run.finished = true;
      return result;
    } } }, maxConcurrent: options.maxConcurrent || 2,
    deliver: (target, text) => bridge.sendBackgroundResult(target, text),
    isAuthorized: (target) => bridge.isBackgroundScopeAuthorized(target),
    ...(options.manager || {}),
  });
  const identity = (id) => ({ id, name: id, relationType: 'existing', userRole: '', companionRole: '',
    userTitle: '', companionTitle: '', description: '' });
  bridge = new NativeOneBotBridge({ ctx, qqGateway: gateway, ownerQq: '20002', expectedSelfId: '10001',
    qqAccounts: ['20002', '30003'].map((qq) => ({ qq, name: qq, enabled: true, activeIdentityId: 'default',
      identities: [identity('default'), identity('alternate')] })),
    backgroundTasks: manager, rejectBeforeConnection: true, now: () => clock.value,
    turnTimeoutMs: 1000, disposeTimeoutMs: 25, logger: { warn() {} }, ...(options.bridge || {}) });
  const incoming = (id, text, peerId = '20002') => {
    const time = Math.floor(clock.value / 1000);
    return { channel: 'onebot', selfId: '10001', userId: peerId, messageId: String(id), messageType: 'private',
      isGroup: false, groupId: null, text, time: time * 1000,
      raw: { post_type: 'message', message_type: 'private', self_id: 10001, user_id: Number(peerId), message_id: id, time } };
  };
  const submit = (originId, title = '受控后台任务', patch = {}) => manager.submit({ scope: { ...scope }, originId: String(originId),
    title, prompt: `仅离线执行器：${title}`, difficulty: 'normal', executor: 'native', ...patch });
  t.after(async () => {
    for (const run of runs) run.gate.resolve({ status: 'cancelled', text: '', executor: 'native' });
    await manager.dispose(); await bridge.dispose(); fs.rmSync(dir, { recursive: true, force: true });
  });
  return { bridge, manager, created, calls, sent, runs, gateway, emit, finish, incoming, submit, dir };
}

test('a background execution releases the QQ conversation for normal chat and returns exactly one result to its fixed recipient', async (t) => {
  let job;
  const f = fixture(t, { respond: (call, finish) => {
    if (call.message.content[0].text === '启动慢任务') {
      void f.submit('101', '慢速只读任务').then((accepted) => { job = accepted; finish(call, `已受理 ${job.id}`); });
    } else finish(call, `CHAT:${call.message.content[0].text}`);
  } });
  assert.equal((await f.bridge.handleIncoming(f.incoming(101, '启动慢任务'))).ok, true);
  assert.ok(job?.id);
  await until(() => f.runs.length === 1);
  const chat = await f.bridge.handleIncoming(f.incoming(1, '任务还在跑时继续聊天'));
  assert.equal(chat.ok, true); assert.equal(f.runs[0].finished, false);
  assert.equal(f.calls.length, 2); assert.equal(f.bridge.status.pending, 0);
  assert.equal(f.sent.filter(([, text]) => text === 'CHAT:任务还在跑时继续聊天').length, 1);
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'BACKGROUND_RESULT_A', executor: 'native' });
  await until(() => f.sent.some(([, text]) => text.includes('BACKGROUND_RESULT_A')));
  await f.manager.flushDeliveries();
  assert.equal((await f.manager.get(job.id, scope)).status, 'succeeded');
  assert.equal(f.sent.filter(([, text]) => text.includes('BACKGROUND_RESULT_A')).length, 1);
  assert.ok(f.sent.every(([target]) => target === 'private:20002'));
  assert.equal(f.calls.length, 2, 'background notification must not require another foreground model turn');
});

test('QQ task-list and progress commands read the running job without another model invocation or execution', async (t) => {
  const f = fixture(t);
  const job = await f.submit('102', '可查询的后台任务'); await until(() => f.runs.length === 1);
  await f.bridge.handleIncoming(f.incoming(2, '任务列表'));
  await f.bridge.handleIncoming(f.incoming(3, `查询任务 ${job.id}`));
  assert.equal(f.calls.length, 0); assert.equal(f.created.length, 0); assert.equal(f.runs.length, 1);
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(([target, text]) => target === 'private:20002' && text.includes(job.id)));
  assert.ok(f.sent.some(([, text]) => text.includes('可查询的后台任务')));
  assert.equal(f.runs[0].finished, false);
});

test('repeated admission of one origin before and after completion never repeats a job or its QQ result', async (t) => {
  const f = fixture(t);
  const first = await f.submit('103', '重复事件任务');
  const duplicate = await f.submit('103', '重复事件任务');
  assert.equal(duplicate.id, first.id); await until(() => f.runs.length === 1);
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'ONCE_ONLY_BACKGROUND_RESULT', executor: 'native' });
  await until(() => f.sent.some(([, text]) => text.includes('ONCE_ONLY_BACKGROUND_RESULT')));
  const again = await f.submit('103', '重复事件任务');
  await f.manager.flushDeliveries(); await tick();
  assert.equal(again.id, first.id); assert.equal(f.runs.length, 1);
  assert.equal(f.sent.filter(([, text]) => text.includes('ONCE_ONLY_BACKGROUND_RESULT')).length, 1);
});

test('QQ cancellation is scoped and does not let a late worker success produce a second final result', async (t) => {
  const f = fixture(t);
  const job = await f.submit('104', '需要取消的任务'); await until(() => f.runs.length === 1);
  await f.bridge.handleIncoming(f.incoming(4, `取消任务 ${job.id}`));
  assert.equal(f.calls.length, 0); assert.equal(f.runs.length, 1);
  assert.equal((await f.manager.get(job.id, scope)).status, 'cancelling');
  assert.equal(f.runs[0].signal?.aborted, true);
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'LATE_CANCELLED_RESULT_MUST_NOT_SEND', executor: 'native' });
  await until(() => f.runs[0].finished); await f.manager.flushDeliveries();
  assert.equal((await f.manager.get(job.id, scope)).status, 'cancelled');
  assert.equal(f.sent.some(([, text]) => text.includes('LATE_CANCELLED_RESULT_MUST_NOT_SEND')), false);
  assert.ok(f.sent.every(([target]) => target === 'private:20002'));
});

test('failed and empty-result workers both generate factual QQ terminal notices without rerunning their work', async (t) => {
  const f = fixture(t);
  const failed = await f.submit('105', '执行失败任务'); await until(() => f.runs.length === 1);
  f.runs[0].gate.resolve({ status: 'failed', text: '', errorCode: 'execution-failed', executor: 'native' });
  await until(() => f.sent.length === 1);
  assert.equal((await f.manager.get(failed.id, scope)).status, 'failed');
  assert.match(f.sent[0][1], /失败|未完成/);
  const empty = await f.submit('106', '没有结果说明的任务'); await until(() => f.runs.length === 2);
  f.runs[1].gate.resolve({ status: 'failed', text: '', errorCode: 'invalid-result', executor: 'native' });
  await until(() => f.sent.length === 2);
  assert.equal((await f.manager.get(empty.id, scope)).status, 'failed');
  assert.match(f.sent[1][1], /失败|未确认|结果|未完成/);
  await f.manager.flushDeliveries(); assert.equal(f.sent.length, 2); assert.equal(f.runs.length, 2); assert.equal(f.calls.length, 0);
});

test('background results remain separate from an active QQ turn even when the foreground final arrives later', async (t) => {
  const f = fixture(t);
  const job = await f.submit('107', '与聊天交错的任务'); await until(() => f.runs.length === 1);
  const chatting = f.bridge.handleIncoming(f.incoming(5, '这句只属于当前聊天'));
  await until(() => f.calls.length === 1);
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'INDEPENDENT_BACKGROUND_RESULT', executor: 'native' });
  await until(() => f.sent.some(([, text]) => text.includes('INDEPENDENT_BACKGROUND_RESULT')));
  assert.equal(f.bridge.status.pending, 1);
  f.finish(f.calls[0], 'INDEPENDENT_FOREGROUND_RESULT');
  assert.equal((await chatting).ok, true);
  assert.equal((await f.manager.get(job.id, scope)).status, 'succeeded');
  assert.equal(f.sent.filter(([, text]) => text.includes('INDEPENDENT_BACKGROUND_RESULT')).length, 1);
  assert.equal(f.sent.filter(([, text]) => text === 'INDEPENDENT_FOREGROUND_RESULT').length, 1);
  assert.equal(f.sent.some(([, text]) => text.includes('INDEPENDENT_BACKGROUND_RESULT') && text.includes('INDEPENDENT_FOREGROUND_RESULT')), false);
});

test('a different user and identity cannot query or cancel the owner job, and a changed receiving account cannot receive its result', async (t) => {
  const f = fixture(t, { respond: (call, finish) => finish(call, '当前账号仅限独立聊天，没有后台任务权限') });
  const job = await f.submit('108', 'PRIVATE_JOB_TITLE'); await until(() => f.runs.length === 1);
  for (const other of [{ ...scope, peerId: '30003' }, { ...scope, identityId: 'alternate' }, { ...scope, selfId: '99999' }]) {
    assert.throws(() => f.manager.get(job.id, other));
    await assert.rejects(f.manager.cancel(job.id, other));
  }
  await f.bridge.handleIncoming(f.incoming(6, `查询任务 ${job.id}`, '30003'));
  assert.equal(f.calls.length, 1, 'a guest remains in its independent chat session and cannot invoke the owner command handler');
  assert.equal(f.sent.some(([target, text]) => target === 'private:30003' && text.includes('PRIVATE_JOB_TITLE')), false);
  assert.equal((await f.manager.get(job.id, scope)).status, 'running');
  const before = f.sent.length; f.gateway.selfId = '99999';
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'PRIVATE_COMPLETION_FOR_OLD_RECEIVER', executor: 'native' });
  await until(() => f.runs[0].finished); await f.manager.flushDeliveries();
  assert.equal(f.sent.length, before, 'a result must not leave through the newly logged-in QQ account');
});

test('a job completed while QQ is disconnected waits for a verified connection and never reruns execution', async (t) => {
  const f = fixture(t);
  const job = await f.submit('109', '离线期间完成的任务'); await until(() => f.runs.length === 1);
  f.gateway.connected = false;
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'RESULT_AFTER_RECONNECTION', executor: 'native' });
  await until(() => f.runs[0].finished); await f.manager.flushDeliveries();
  assert.equal(f.sent.length, 0); assert.equal(f.runs.length, 1);
  assert.equal(f.manager.get(job.id, scope).status, 'succeeded');
  f.gateway.connected = true; f.gateway.connectedAtMs += 1000; f.gateway.wsClient = {};
  await f.manager.flushDeliveries();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], 'private:20002');
  assert.ok(f.sent[0][1].includes('RESULT_AFTER_RECONNECTION'));
  await f.manager.flushDeliveries(); assert.equal(f.sent.length, 1); assert.equal(f.runs.length, 1);
});

test('an unknown background QQ receipt is never automatically retried and cannot cause another execution', async (t) => {
  const f = fixture(t, { send: async () => ({ ok: false, uncertain: true }) });
  const job = await f.submit('110', '发送结果未知的任务'); await until(() => f.runs.length === 1);
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'UNCERTAIN_DELIVERY_RESULT', executor: 'native' });
  await until(() => f.sent.length === 1); await f.manager.flushDeliveries();
  const again = await f.submit('110', '发送结果未知的任务');
  assert.equal(again.id, job.id);
  assert.equal(f.manager.get(job.id, scope).delivery, 'unknown');
  await f.manager.flushDeliveries(); await tick();
  assert.equal(f.sent.length, 1); assert.equal(f.runs.length, 1);
});

test('QQ progress and cancel commands bypass a still-running normal chat without claiming its turn', async (t) => {
  const f = fixture(t);
  const job = await f.submit('111', '聊天期间仍可取消'); await until(() => f.runs.length === 1);
  const chat = f.bridge.handleIncoming(f.incoming(11, '尚未完成的普通聊天'));
  await until(() => f.calls.length === 1);
  await f.bridge.handleIncoming(f.incoming(12, `查询任务 ${job.id}`));
  await f.bridge.handleIncoming(f.incoming(13, `取消任务 ${job.id}`));
  assert.equal(f.calls.length, 1); assert.equal(f.bridge.status.pending, 1);
  assert.equal(f.manager.get(job.id, scope).status, 'cancelling');
  assert.equal(f.runs[0].signal.aborted, true);
  f.runs[0].gate.resolve({ status: 'cancelled', text: '', executor: 'native' });
  await until(() => f.manager.get(job.id, scope).status === 'cancelled');
  await f.manager.flushDeliveries();
  f.finish(f.calls[0], 'CURRENT_CHAT_ONLY');
  assert.equal((await chat).ok, true);
  assert.equal(f.sent.filter(([, text]) => text === 'CURRENT_CHAT_ONLY').length, 1);
  assert.equal(f.sent.filter(([, text]) => text.startsWith(`后台任务 ${job.id}`)).length, 1);
});

test('cancelling a queued job from QQ never starts its executor and does not stop another running task', async (t) => {
  const f = fixture(t, { maxConcurrent: 1 });
  const active = await f.submit('112', '继续运行的任务'); await until(() => f.runs.length === 1);
  const queued = await f.submit('113', '尚未派发的任务');
  assert.equal(f.manager.get(queued.id, scope).status, 'queued');
  await f.bridge.handleIncoming(f.incoming(14, `取消任务 ${queued.id}`));
  assert.equal(f.manager.get(queued.id, scope).status, 'cancelled');
  assert.equal(f.manager.get(active.id, scope).status, 'running'); assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].signal.aborted, false);
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'OTHER_JOB_REMAINS_SUCCESSFUL', executor: 'native' });
  await until(() => f.sent.some(([, text]) => text.includes('OTHER_JOB_REMAINS_SUCCESSFUL')));
  await f.manager.flushDeliveries(); assert.equal(f.runs.length, 1);
  assert.equal(f.sent.filter(([, text]) => text.startsWith(`后台任务 ${queued.id}`)).length, 1);
});

test('duplicate QQ task commands share one reply and never dispatch model or worker work', async (t) => {
  const f = fixture(t);
  const job = await f.submit('114', '状态命令幂等'); await until(() => f.runs.length === 1);
  const msg = f.incoming(15, `查询任务 ${job.id}`);
  const first = f.bridge.handleIncoming(msg), duplicate = f.bridge.handleIncoming(msg);
  assert.equal(duplicate, first); assert.equal((await first).ok, true);
  assert.equal(f.bridge.handleIncoming(msg), first); await f.bridge.handleIncoming(msg);
  assert.equal(f.sent.length, 1); assert.equal(f.runs.length, 1); assert.equal(f.calls.length, 0);
});
