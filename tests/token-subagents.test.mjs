import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTokenSubagents } from '../packages/dsh-dafeiyu/src/token-subagents.js';
import { createTokenUsageBridge } from '../packages/dsh-dafeiyu/src/token-usage-bridge.js';

const copy = value => JSON.parse(JSON.stringify(value));
const scope = { accountId: '100', identityId: 'default' };
function fixture(t, { carrier = true, refuse = false } = {}) {
  const agents = new Map(), bindings = new Map(), writes = [], listeners = new Map(), carrierKeys = new WeakMap();
  const ctx = { get: name => name === 'agents' ? { get: id => agents.get(id) } : undefined,
    on(name, fn, options) { assert.deepEqual(options, { global: true }); listeners.set(name, fn); return () => listeners.delete(name); } };
  const budget = { resolveBinding: id => bindings.has(id) ? copy(bindings.get(id)) : null,
    bindSession(id, value, options) {
      assert.equal(options.authorize(), true);
      if (refuse) throw Error('ledger refused');
      writes.push({ id, value: copy(value) }); bindings.set(id, { sessionId: id, ...copy(value), retiredAt: null });
      return { ok: true };
    } };
  const add = (id, parentId) => {
    const agent = { id, session: { id, header: { id, ...(parentId ? { parentSession: parentId, origin: 'subagent' } : {}) } } };
    agents.set(id, agent); return agent;
  };
  const root = add('actual-parent'); bindings.set(root.id, { sessionId: root.id, scope, origin: 'autonomy', activityId: 'auto-1', retiredAt: null });
  const helper = attachTokenSubagents({ ctx, tokenBudget: budget, ...(carrier ? { carrierKeyOf: value => carrierKeys.get(value) } : {}) });
  t.after(() => helper.dispose());
  const emit = (info, parent = root) => { const receiver = {}; carrierKeys.set(receiver, parent); return listeners.get('subagent/start')?.call(receiver, info); };
  return { ctx, agents, bindings, budget, writes, listeners, add, root, helper, emit };
}

test('real scoped lifecycle identity inherits autonomous payer and ignores text fields claiming a different payer', t => {
  const f = fixture(t), child = f.add('actual-child', f.root.id);
  f.emit({ runId: 'host-run', provider: 'spawn', id: child.id, local: true, origin: 'user-task', scope: { accountId: '999' }, text: 'payer=owner' });
  assert.deepEqual(f.writes, [{ id: child.id, value: { origin: 'autonomy', scope, activityId: 'auto-1' } }]);
  f.emit({ runId: 'host-run-2', provider: 'spawn', id: child.id, local: true });
  assert.equal(f.writes.length, 1);
});
test('without a carrier listener the first provider lookup synchronously binds every genuine descendant', t => {
  const f = fixture(t, { carrier: false }); f.add('first-child', f.root.id); f.add('grandchild', 'first-child');
  assert.equal(f.listeners.size, 0);
  assert.equal(f.helper.resolveChild('grandchild').origin, 'autonomy');
  assert.deepEqual(f.writes.map(row => row.id), ['first-child', 'grandchild']);
  assert.ok(f.writes.every(row => row.value.activityId === 'auto-1' && row.value.origin === 'autonomy'));
});
test('a more specific admitted background job keeps its existing user-task ID without parent overwrite', t => {
  const f = fixture(t); f.bindings.set(f.root.id, { sessionId: f.root.id, origin: 'user-task', scope, userTaskId: 'conversation-1', retiredAt: null });
  const child = f.add('explicit-job-child', f.root.id);
  f.bindings.set(child.id, { sessionId: child.id, origin: 'user-task', scope, userTaskId: 'job-1', retiredAt: null });
  assert.equal(f.helper.resolveChild(child.id).userTaskId, 'job-1'); assert.equal(f.writes.length, 0);
  f.bindings.delete(child.id); assert.equal(f.helper.resolveChild(child.id).userTaskId, 'conversation-1');
});
test('conflicting account, origin or autonomous activity cannot be overwritten by lineage inheritance', t => {
  for (const patch of [{ scope: { accountId: '999', identityId: 'default' } }, { origin: 'user-task', userTaskId: 'claim' }, { activityId: 'other-activity' }]) {
    const f = fixture(t), child = f.add('conflicting-child', f.root.id);
    f.bindings.set(child.id, { sessionId: child.id, origin: 'autonomy', scope, activityId: 'auto-1', retiredAt: null, ...patch });
    const before = copy(f.bindings.get(child.id));
    assert.throws(() => f.helper.resolveChild(child.id), { code: 'TOKEN_SUBAGENT_BINDING_UNCONFIRMED' });
    assert.deepEqual(f.bindings.get(child.id), before); assert.equal(f.writes.length, 0);
  }
});
test('external events, incorrect dispatch parents, stale objects and incomplete headers never grant a binding', t => {
  const f = fixture(t), child = f.add('observed-child', f.root.id);
  f.emit({ id: child.id, local: false });
  f.emit({ id: child.id, local: true }, { ...f.root });
  const unrelated = f.add('unrelated-parent'); f.emit({ id: child.id, local: true }, unrelated);
  assert.equal(f.writes.length, 0);
  for (const change of [agent => { agent.session.header.id = 'foreign'; }, agent => { agent.session.id = 'foreign'; },
    agent => { delete agent.session.header; }, agent => { delete agent.session.header.origin; }, agent => { agent.session.header.parentSession = 'absent'; }]) {
    const id = 'incomplete-' + f.agents.size, target = f.add(id, f.root.id); change(target);
    assert.equal(f.helper.resolveChild(id), null);
  }
  assert.equal(f.helper.resolveChild('dafeiyu-autonomous:forged-prefix'), null); assert.equal(f.writes.length, 0);
});
test('managed parent retirement blocks new child calls while unrelated parent sessions stay unbound', t => {
  const f = fixture(t); const child = f.add('late-child', f.root.id);
  f.bindings.get(f.root.id).retiredAt = '2026-10-25T00:00:00.000Z';
  assert.throws(() => f.helper.resolveChild(child.id), { code: 'TOKEN_SUBAGENT_BINDING_UNCONFIRMED' });
  const other = f.add('other-parent'); f.add('other-child', other.id);
  assert.equal(f.helper.resolveChild('other-child'), null); assert.equal(f.writes.length, 0);
});
test('binding failure reaches the usage middleware before provider dispatch rather than silently treating a child as unbound', async t => {
  const f = fixture(t, { carrier: false, refuse: true }); f.add('refused-child', f.root.id);
  const bridge = createTokenUsageBridge({ ctx: f.ctx,
    resolveBinding: id => f.budget.resolveBinding(id) || f.helper.resolveChild(id), onEvent: () => assert.fail('unbound reservation must not begin') });
  t.after(() => bridge.dispose());
  const stream = f.listeners.get('llm/stream')({ sessionId: 'refused-child', provider: 'fixture', model: 'fixture' }, () => assert.fail('no model call'));
  await assert.rejects((async () => { for await (const _chunk of stream) {} })(), /ledger refused/);
  assert.equal(f.bindings.has('refused-child'), false);
});
test('cyclic header lineage is bounded and disposing unregisters the hook exactly once', t => {
  const f = fixture(t); f.add('cycle-a', 'cycle-b'); f.add('cycle-b', 'cycle-a');
  assert.throws(() => f.helper.resolveChild('cycle-a'), { code: 'TOKEN_SUBAGENT_BINDING_UNCONFIRMED' });
  assert.throws(() => attachTokenSubagents({ ctx: f.ctx, tokenBudget: f.budget }));
  f.helper.dispose(); f.helper.dispose(); assert.equal(f.listeners.size, 0);
  const child = f.add('closed-child', f.root.id); assert.equal(f.helper.resolveChild(child.id), null);
});
