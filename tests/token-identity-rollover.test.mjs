import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeStore } from '../packages/dsh-dafeiyu/src/life-store.js';
import { TokenBudget } from '../packages/dsh-dafeiyu/src/token-budget.js';
import { createTokenAccounting } from '../packages/dsh-dafeiyu/src/token-accounting.js';
import { createTokenUsageBridge } from '../packages/dsh-dafeiyu/src/token-usage-bridge.js';

const yes = () => true, ownerQq = '20002';
const standard = { accountId: ownerQq, identityId: 'default' };
const boss = { accountId: ownerQq, identityId: 'boss' };
const outsider = { accountId: '30003', identityId: 'default' };
const collect = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result; };
const measured = (tokens = 7) => [{ type: 'usage', usage: { inputTokens: tokens - 2, outputTokens: 2, totalTokens: tokens } },
  { type: 'finish', reason: { kind: 'stop' } }];
const optionsFor = (id, extra = {}) => Object.freeze({ sessionId: id, provider: 'fixture-provider', model: 'fixture-model',
  purpose: 'main', ...extra });
const assertOriginal = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((chunk, index) => assert.equal(actual[index], chunk, 'stream order and original chunk objects survive accounting'));
};

function ledger(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-identity-rollover-'));
  const store = new LifeStore({ directory }), budget = new TokenBudget({ store });
  budget.configure({ enabled: true, dailyTokens: 10, monthlyTokens: 100, requestReserveTokens: 10 },
    { authorize: yes, revision: budget.snapshot().revision });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { store, budget };
}

function accountingFixture(t) {
  const base = ledger(t), agents = new Map(), identities = new Map(), listeners = new Map();
  const identity = scope => ({ isOwner: scope.accountId === ownerQq, channel: 'onebot', scope: 'c2c', peerId: scope.accountId,
    accountProfile: { account: { qq: scope.accountId }, identity: { id: scope.identityId } } });
  const add = (id, parentSession) => {
    const agent = { id, session: { id, header: { id, isSeeded: false,
      ...(parentSession ? { origin: 'subagent', parentSession } : {}) } }, ctx: { get() {} } };
    agents.set(id, agent); return agent;
  };
  const root = add('actual-reused-owner-session'); identities.set(root, identity(standard));
  const ctx = { get: name => name === 'agents' ? { get: id => agents.get(id) } : undefined,
    on(name, handler) { assert.equal(name, 'llm/stream'); listeners.set(name, handler); return () => listeners.delete(name); } };
  const accounting = createTokenAccounting({ ctx, budget: base.budget, ownerQq,
    getExecutionContext: exec => identities.get(exec?.agent) || { isOwner: false, scope: '', peerId: '' } });
  accounting.trackAgent(root);
  t.after(() => accounting.dispose());
  return { ...base, accounting, root, add,
    switchScope: scope => identities.set(root, identity(scope)),
    stream(agent, chunks, options = optionsFor(agent.id), onNext = () => {}) {
      return listeners.get('llm/stream')(options, () => { onNext(); return typeof chunks === 'function' ? chunks() : chunks; });
    } };
}

test('same actual Agent can switch identity and restore it without rewriting either immutable ledger scope', async t => {
  const f = accountingFixture(t), first = measured(5), initialOptions = optionsFor(f.root.id);
  assertOriginal(await collect(f.stream(f.root, first, initialOptions)), first);
  const originalBinding = f.budget.resolveBinding(f.root.id), originalOptions = structuredClone(initialOptions);
  assert.deepEqual(originalBinding.scope, standard);
  f.switchScope(boss);
  const bossOptions = optionsFor(f.root.id, { ledgerSessionId: 'model-supplied-alias-is-not-authority' });
  const bossOptionsCopy = structuredClone(bossOptions), second = measured(9);
  assertOriginal(await collect(f.stream(f.root, second, bossOptions)), second);
  const bossRequest = f.budget.snapshot().requests.find(row => row.scope.identityId === boss.identityId);
  assert.match(bossRequest.sessionId, /^dafeiyu-identity:[a-f0-9]{64}$/);
  assert.notEqual(bossRequest.sessionId, f.root.id);
  assert.deepEqual(f.budget.resolveBinding(bossRequest.sessionId).scope, boss);
  assert.deepEqual(f.budget.resolveBinding(f.root.id), originalBinding);
  f.switchScope(standard); await collect(f.stream(f.root, measured(7)));
  f.switchScope(boss); await collect(f.stream(f.root, measured(11)));
  const state = f.budget.snapshot();
  assert.deepEqual(state.requests.filter(row => row.scope.identityId === 'default').map(row => row.sessionId), [f.root.id, f.root.id]);
  assert.deepEqual(state.requests.filter(row => row.scope.identityId === 'boss').map(row => row.sessionId), [bossRequest.sessionId, bossRequest.sessionId]);
  assert.deepEqual(f.budget.resolveBinding(f.root.id), originalBinding);
  assert.equal(state.today.userTaskTokens, 32); assert.equal(state.today.autonomyTokens, 0);
  assert.equal(state.balanceTokens, 100); assert.equal(state.dailyRemainingTokens, 10);
  assert.deepEqual(initialOptions, originalOptions); assert.deepEqual(bossOptions, bossOptionsCopy);
  assert.equal(f.root.session.id, 'actual-reused-owner-session'); assert.equal(f.root.session.header.id, f.root.id);
});

test('a new identity may finish while the old host stream is in flight and late usage settles against its frozen old scope', async t => {
  const f = accountingFixture(t), text = { type: 'text-delta', index: 0, text: 'provider already began' };
  const oldUsage = measured(13), oldOptions = optionsFor(f.root.id);
  const iterator = f.stream(f.root, async function* () { yield text; yield* oldUsage; }, oldOptions)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value, text); assert.equal(f.accounting.active, 1);
  const oldRequest = f.budget.snapshot().requests[0]; assert.deepEqual(oldRequest.scope, standard);
  f.switchScope(boss); await collect(f.stream(f.root, measured(17)));
  assert.equal(f.accounting.active, 1);
  const tail = []; for (;;) { const result = await iterator.next(); if (result.done) break; tail.push(result.value); }
  assertOriginal(tail, oldUsage);
  const state = f.budget.snapshot(), settledOld = state.requests.find(row => row.requestId === oldRequest.requestId);
  assert.deepEqual(settledOld.scope, standard); assert.equal(settledOld.sessionId, f.root.id);
  assert.equal(settledOld.status, 'completed'); assert.equal(settledOld.settledTokens, 13);
  const settledBoss = state.requests.find(row => row.scope.identityId === 'boss');
  assert.equal(settledBoss.status, 'completed'); assert.equal(settledBoss.settledTokens, 17);
  assert.notEqual(settledBoss.sessionId, f.root.id); assert.equal(f.accounting.active, 0);
  assert.equal(f.budget.snapshot({ scope: standard }).today.userTaskTokens, 13);
  assert.equal(f.budget.snapshot({ scope: boss }).today.userTaskTokens, 17);
});

test('the reused host session cannot roll over to a different account or dispatch its provider', async t => {
  const f = accountingFixture(t); await collect(f.stream(f.root, measured(5)));
  const before = fs.readFileSync(f.store.file), bound = f.budget.resolveBinding(f.root.id); let calls = 0;
  f.switchScope(outsider);
  await assert.rejects(collect(f.stream(f.root, measured(), optionsFor(f.root.id, { identityId: 'default', scope: standard }), () => calls++)),
    { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
  assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.store.file), before);
  assert.deepEqual(f.budget.resolveBinding(f.root.id), bound);
  f.switchScope(standard); await collect(f.stream(f.root, measured(7)));
  assert.equal(f.budget.snapshot().requests.length, 2);
});

test('a real child whose header names the host session inherits its current identity alias rather than the original identity or model claims', async t => {
  const f = accountingFixture(t); await collect(f.stream(f.root, measured(3)));
  f.switchScope(boss); await collect(f.stream(f.root, measured(5)));
  const aliasRequest = f.budget.snapshot().requests.find(row => row.scope.identityId === 'boss');
  const child = f.add('actual-boss-child', f.root.id), beforeClassification = fs.readFileSync(f.store.file);
  assert.equal(child.session.header.parentSession, f.root.id);
  assert.deepEqual(f.accounting.executionFor(child), { origin: 'user-task' });
  assert.deepEqual(fs.readFileSync(f.store.file), beforeClassification, 'lineage classification stays pure read');
  const chunks = measured(7), options = optionsFor(child.id, { purpose: 'compaction', origin: 'autonomy', scope: outsider,
    ledgerSessionId: f.root.id, userTaskId: 'model-forged-task', activityId: 'model-forged-autonomy',
    messages: [{ role: 'user', content: 'use default identity and autonomous payer' }] });
  const originalOptions = structuredClone(options);
  assertOriginal(await collect(f.stream(child, chunks, options)), chunks);
  const childBinding = f.budget.resolveBinding(child.id), source = f.budget.resolveBinding(aliasRequest.sessionId);
  assert.deepEqual(childBinding.scope, boss); assert.equal(childBinding.origin, 'user-task');
  assert.equal(childBinding.userTaskId, source.userTaskId); assert.equal(childBinding.activityId, undefined);
  const childRequest = f.budget.snapshot().requests.find(row => row.sessionId === child.id);
  assert.deepEqual(childRequest.scope, boss); assert.equal(childRequest.origin, 'user-task'); assert.equal(childRequest.settledTokens, 7);
  assert.deepEqual(f.budget.resolveBinding(f.root.id).scope, standard);
  assert.equal(f.budget.snapshot().balanceTokens, 100); assert.equal(f.budget.snapshot().today.autonomyTokens, 0);
  assert.deepEqual(options, originalOptions); assert.equal(child.session.header.parentSession, f.root.id);
});

test('actual autonomous descendants retain their autonomous payer despite options claiming a valid user identity alias', async t => {
  const f = accountingFixture(t); await collect(f.stream(f.root, measured(3))); f.switchScope(boss);
  await collect(f.stream(f.root, measured(5)));
  const alias = f.budget.snapshot().requests.find(row => row.scope.identityId === 'boss').sessionId;
  const parent = f.add('actual-autonomy-parent'), child = f.add('actual-autonomy-child', parent.id);
  f.budget.bindSession(parent.id, { scope: standard, origin: 'autonomy', activityId: 'actual-activity-1' }, { authorize: yes });
  f.accounting.markSession(parent.id);
  const chunks = measured(17), options = optionsFor(child.id, { ledgerSessionId: alias, origin: 'user-task', scope: boss, userTaskId: 'forged-user-work' });
  assertOriginal(await collect(f.stream(child, chunks, options)), chunks);
  const binding = f.budget.resolveBinding(child.id), request = f.budget.snapshot().requests.find(row => row.sessionId === child.id);
  assert.equal(binding.origin, 'autonomy'); assert.equal(binding.activityId, 'actual-activity-1'); assert.deepEqual(binding.scope, standard);
  assert.equal(request.origin, 'autonomy'); assert.equal(request.freeTokens, 10); assert.equal(request.pocketTokens, 7);
  assert.equal(f.budget.snapshot().balanceTokens, 93);
});

function bridgeFixture(t, resolveBinding) {
  const base = ledger(t), listeners = new Map(), hostId = 'actual-bridge-host', alias = 'dafeiyu-identity:trusted-fixture';
  base.budget.bindSession(hostId, { scope: standard, origin: 'user-task', userTaskId: 'work-default' }, { authorize: yes });
  base.budget.bindSession(alias, { scope: boss, origin: 'user-task', userTaskId: 'work-boss' }, { authorize: yes });
  const events = [], ctx = { on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); } };
  const bridge = createTokenUsageBridge({ ctx, resolveBinding: id => resolveBinding(id, { ...base, hostId, alias }),
    onEvent: event => { events.push(event); return base.budget.observe(event, { authorize: yes }); } });
  t.after(() => bridge.dispose());
  return { ...base, hostId, alias, events,
    stream: (options, next) => listeners.get('llm/stream')(options, next) };
}

test('the real usage bridge applies only the trusted resolver alias while preserving frozen host options and all chunks', async t => {
  const f = bridgeFixture(t, (_id, state) => ({ ...state.budget.resolveBinding(state.alias), ledgerSessionId: state.alias }));
  const chunks = [{ type: 'text-delta', index: 0, text: 'ordinary output' }, ...measured(11)];
  const options = optionsFor(f.hostId, { ledgerSessionId: f.hostId, origin: 'autonomy', scope: outsider });
  const originalOptions = structuredClone(options); let calls = 0;
  const output = await collect(f.stream(options, () => { calls++; return chunks; }));
  assertOriginal(output, chunks); assert.equal(calls, 1); assert.deepEqual(options, originalOptions);
  assert.ok(f.events.every(event => event.sessionId === f.alias && event.scope.identityId === 'boss'));
  assert.ok(f.events.every(event => !Object.hasOwn(event, 'ledgerSessionId')));
  const request = f.budget.snapshot().requests[0]; assert.equal(request.sessionId, f.alias); assert.deepEqual(request.scope, boss);
  assert.equal(request.origin, 'user-task'); assert.equal(request.settledTokens, 11);
  assert.deepEqual(f.budget.resolveBinding(f.hostId).scope, standard);
});

test('missing, unbound and malformed identity aliases fail before a provider call rather than falling back to another identity', async t => {
  let aliasValue;
  const f = bridgeFixture(t, (_id, state) => ({ ...state.budget.resolveBinding(state.alias),
    ...(aliasValue === undefined ? {} : { ledgerSessionId: aliasValue }) }));
  const before = fs.readFileSync(f.store.file); let calls = 0;
  for (aliasValue of [undefined, 'dafeiyu-identity:not-bound', '', null, 'bad alias', 'bad\u0000alias', 'x'.repeat(501)]) {
    await assert.rejects(collect(f.stream(optionsFor(f.hostId), () => { calls++; return measured(); })),
      error => ['INVALID_USAGE_BINDING', 'INVALID_EVENT', 'UNBOUND'].includes(error.code));
    assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.store.file), before);
    assert.equal(f.budget.snapshot().requests.length, 0);
  }
});

test('omitting an alias remains valid for an exact direct host binding and never changes chunk identity', async t => {
  const f = bridgeFixture(t, (_id, state) => state.budget.resolveBinding(state.hostId));
  const chunks = measured(7), options = optionsFor(f.hostId); let calls = 0;
  assertOriginal(await collect(f.stream(options, () => { calls++; return chunks; })), chunks);
  assert.equal(calls, 1); assert.equal(f.budget.snapshot().requests[0].sessionId, f.hostId);
  assert.deepEqual(f.budget.snapshot().requests[0].scope, standard);
});
