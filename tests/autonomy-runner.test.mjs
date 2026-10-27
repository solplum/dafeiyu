import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomyRunner } from '../packages/dsh-dafeiyu/src/autonomy-runner.js';

function fixture(kind = 'chat', options = {}) {
  const listeners = new Map(), registry = new Map(), restrictions = [], calls = [], prompts = [], creations = [];
  let disposed = 0, serial = 0, firstCall;
  const fire = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args); };
  const services = { agentDefaultModel: { currentSelection: () => ({ provider: 'offline', model: 'fixture' }) }, agentPresets: { mount: async () => {} },
    agents: { get: (id) => registry.get(id), withoutInitiator: (fn) => fn(), async create(spec) {
      creations.push(spec); options.onCreate?.(spec);
      const guards = [], tools = { guard(fn) { guards.push(fn); }, restrict(value) { restrictions.push(value); }, presentAs() {},
        schemas: () => ['ego_space_open', 'ego_navigate', 'ego_snapshot', 'ego_space_close', 'bash', 'qq_send', 'phone_screenshot'].map((name) => ({ name })),
        async execute(exec) {
          exec.agent ||= agent;
          for (const guard of guards) if (guard(exec)) throw new Error('denied by actual scoped guard');
          let next = async () => { calls.push(exec); return { isError: false }; };
          for (const fn of [...(listeners.get('tools/execute') || [])].reverse()) { const previous = next; next = () => fn(exec, previous); }
          return next();
        } };
      const agent = { id: spec.sessionId, session: { id: spec.sessionId }, ctx: { get: (name) => name === 'tools' ? tools : services[name] }, cancel() {},
        followup(message) {
          prompts.push(message.content[0].text); firstCall?.(agent);
          return Promise.resolve().then(async () => {
            const turn = ++serial;
            fire('agent/inbox/claimed', { agent, message, turn });
            await assert.rejects(tools.execute({ name: 'bash', arguments: { command: 'must never run' } }));
            if (kind === 'browse') { await tools.execute({ name: 'ego_navigate', arguments: { space: 'fixed-owned-space', url: 'https://www.bilibili.com' } }); await tools.execute({ name: 'ego_snapshot', arguments: { space: 'fixed-owned-space' } }); }
            fire('session/event', agent.session, { type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { content: [{ type: 'text', text: '实际结果正文' }] } } });
            fire('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
          });
        } };
      registry.set(agent.id, agent); await spec.setup(agent.ctx, agent);
      return { agent, async dispose() { disposed++; await options.dispose?.(); registry.delete(agent.id); } };
    } } };
  const ctx = { get: (name) => services[name], on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn);
  } };
  const runner = createAutonomyRunner({ ctx, tokenBudget: options.tokenBudget,
    controlAccess: { runAutonomous: async (_input, operation) => operation({ space: 'fixed-owned-space', onCleanupUnknown() { throw new Error('unexpected cleanup failure'); } }) } });
  return { runner, restrictions, calls, prompts, listeners, creations, get disposed() { return disposed; }, onFirst(fn) { firstCall = fn; } };
}
test('native proactive draft uses the host model, blocks tools and never sends QQ from the worker', async () => {
  const f = fixture();
  const result = await f.runner({ id: 'auto-chat-123', kind: 'chat', topic: '面试' }, { signal: new AbortController().signal, authorize: () => true, context: 'ONLY_SCOPED_HISTORY' });
  assert.equal(result.status, 'succeeded'); assert.equal(result.text, '实际结果正文'); assert.deepEqual(f.restrictions, [{ allow: [] }]);
  assert.equal(f.calls.length, 0); assert.equal(f.disposed, 1); assert.match(f.prompts[0], /ONLY_SCOPED_HISTORY/);
  assert.ok([...f.listeners.values()].every((handlers) => handlers.size === 0));
});
test('opted-in first greeting is text-only and accounted as autonomy without invented shared memories', async () => {
  const budget = budgetFixture(), f = fixture('chat', { tokenBudget: budget.tokenBudget });
  const result = await f.runner({ id: 'auto-first-greeting', kind: 'chat', origin: 'greeting', topic: '首次主动问候', scope: scoped },
    { signal: new AbortController().signal, authorize: () => true, context: '' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(f.restrictions, [{ allow: [] }]);
  assert.equal(f.calls.length, 0);
  assert.match(f.prompts[0], /首次主动.*不代表第一次认识/);
  assert.match(f.prompts[0], /不要编造共同经历/);
  assert.match(f.prompts[0], /不调用工具，只输出文字正文/);
  assert.equal(f.prompts[0].includes('PRIVATE_'), false);
  assert.deepEqual(budget.bindings[0].value, { origin: 'autonomy', scope: scoped, activityId: 'auto-first-greeting' });
  assert.equal(budget.retirements.length, 1);
});
test('unsupported activity kinds and greeting browser mixtures cannot create a native agent', async () => {
  for (const activity of [{ kind: 'greeting' }, { kind: 'unknown' }, { kind: 'browse', origin: 'greeting' }]) {
    const f = fixture();
    assert.equal((await f.runner(activity, { signal: new AbortController().signal, authorize: () => true })).status, 'failed');
    assert.equal(f.creations.length, 0);
    assert.equal(f.prompts.length, 0);
  }
});
test('legacy Bilibili browser execution cannot fall back to the old generic browser tools', async () => {
  const f = fixture('browse');
  const result = await f.runner({ id: 'auto-browser-123', kind: 'browse', platform: 'bilibili', topic: '摄影' },
    { signal: new AbortController().signal, authorize: () => true, context: '' });
  assert.equal(result.status, 'failed'); assert.equal(f.creations.length, 0); assert.equal(f.calls.length, 0);
});

const scoped = { accountId: '100', identityId: 'default' };
function budgetFixture({ reserve = 16384, bind, retire, context } = {}) {
  const bindings = [], retirements = [], contexts = [];
  const tokenBudget = {
    snapshot: () => ({ policy: { requestReserveTokens: reserve } }),
    async bindSession(id, value, options) { assert.equal(options.authorize(), true); bindings.push({ id, value }); await bind?.(id, value, options); },
    async retireSession(id, options) { assert.equal(options.authorize(), true); retirements.push(id); await retire?.(id, options); },
    context(input) { contexts.push(input); return context || { sharedBudgetVisible: false, today: { autonomyTokens: 17 }, pendingUnknownCount: 0, unmeteredCount: 0,
      requests: [{ private: 'PRIVATE_OTHER_ACCOUNT_OR_REQUEST' }], balanceTokens: 'PRIVATE_SHARED_BALANCE' }; },
  };
  return { tokenBudget, bindings, retirements, contexts };
}
test('autonomous session is durably bound before creation with a capped output limit and only its own summary in context', async () => {
  for (const [reserve, expected] of [[16384, 4096], [512, 512]]) {
    const b = budgetFixture({ reserve }), order = [];
    const original = b.tokenBudget.bindSession; b.tokenBudget.bindSession = async (...args) => { await original(...args); order.push('bound'); };
    const f = fixture('chat', { tokenBudget: b.tokenBudget, onCreate(spec) { order.push('create'); assert.equal(spec.sessionId, b.bindings[0].id); },
      dispose() { order.push('disposed'); } });
    const retire = b.tokenBudget.retireSession; b.tokenBudget.retireSession = async (...args) => { order.push('retired'); return retire(...args); };
    const result = await f.runner({ id: 'auto-accounted-1', kind: 'chat', topic: '摄影', scope: scoped },
      { signal: new AbortController().signal, authorize: () => true, context: 'OWN_HISTORY' });
    assert.equal(result.status, 'succeeded'); assert.deepEqual(order, ['bound', 'create', 'disposed', 'retired']);
    assert.equal(f.creations[0].agentOptions.maxTokens, expected);
    assert.deepEqual(b.bindings[0].value, { origin: 'autonomy', scope: scoped, activityId: 'auto-accounted-1' });
    assert.deepEqual(b.contexts, [{ scope: scoped, origin: 'autonomy' }]);
    assert.deepEqual(b.retirements, [f.creations[0].sessionId]);
    assert.match(f.prompts[0], /大米饭/); assert.match(f.prompts[0], /用户交办的任务由用户承担/); assert.match(f.prompts[0], /"autonomyTokens":17/);
    assert.equal(f.prompts[0].includes('PRIVATE_'), false);
  }
});
test('rejected ownership persistence prevents autonomous creation and never substitutes a global budget view', async () => {
  const b = budgetFixture({ bind() { throw Error('binding refused'); } }), f = fixture('chat', { tokenBudget: b.tokenBudget });
  await assert.rejects(f.runner({ id: 'auto-refused-1', kind: 'chat', scope: scoped },
    { signal: new AbortController().signal, authorize: () => true }), /binding refused/);
  assert.equal(f.creations.length, 0); assert.equal(f.prompts.length, 0); assert.equal(b.contexts.length, 0);
  const shared = budgetFixture({ context: { sharedBudgetVisible: true, balanceTokens: 'PRIVATE_SHARED' } });
  const g = fixture('chat', { tokenBudget: shared.tokenBudget });
  await assert.rejects(g.runner({ id: 'auto-refused-2', kind: 'chat', scope: scoped },
    { signal: new AbortController().signal, authorize: () => true }), /归属未确认/);
  assert.equal(g.creations.length, 0); assert.equal(g.prompts.length, 0); assert.equal(shared.retirements.length, 1);
});
test('autonomous cancellation while binding retires the undispatched session, while uncertain handle cleanup does not', async () => {
  const controller = new AbortController(), b = budgetFixture({ bind() { controller.abort(); } });
  const f = fixture('chat', { tokenBudget: b.tokenBudget });
  assert.equal((await f.runner({ id: 'auto-cancel-1', kind: 'chat', scope: scoped },
    { signal: controller.signal, authorize: () => true })).status, 'cancelled');
  assert.equal(f.creations.length, 0); assert.equal(b.retirements.length, 1);
  const pending = budgetFixture(), g = fixture('chat', { tokenBudget: pending.tokenBudget, dispose() { throw Error('cleanup uncertain'); } });
  await assert.rejects(g.runner({ id: 'auto-cleanup-1', kind: 'chat', scope: scoped },
    { signal: new AbortController().signal, authorize: () => true }), { code: 'CONTROL_CLEANUP_UNCONFIRMED' });
  assert.equal(g.disposed, 1); assert.equal(pending.retirements.length, 0);
});
