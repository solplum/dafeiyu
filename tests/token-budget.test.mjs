import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeStore } from '../packages/dsh-dafeiyu/src/life-store.js';
import { TimeWallet } from '../packages/dsh-dafeiyu/src/time-wallet.js';
import { TokenBudget, DEFAULT_TOKEN_BUDGET_POLICY, normalizeTokenUsage } from '../packages/dsh-dafeiyu/src/token-budget.js';
import { createTokenUsageBridge } from '../packages/dsh-dafeiyu/src/token-usage-bridge.js';
const yes = () => true, auth = { authorize: yes };
const a = { accountId: '20002', identityId: 'default' }, b = { accountId: '30003', identityId: 'default' };
function fixture(t, policy) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-budget-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clock = { value: Date.parse('2026-10-24T10:00:00.000Z') };
  const store = new LifeStore({ directory, now: () => clock.value });
  const budget = new TokenBudget({ store, now: () => clock.value });
  const configure = (patch) => budget.configure(patch, { ...auth, revision: budget.snapshot().revision });
  if (policy) configure(policy);
  const bindings = new Map();
  function bind(id = 'session-1', origin = 'autonomy', scope = a, work = 'work-1') {
    const binding = { scope, origin, ...(origin === 'autonomy' ? { activityId: work } : { userTaskId: work }) };
    budget.bindSession(id, binding, auth); bindings.set(id, binding); return binding;
  }
  const event = (requestId, status, extra = {}, sessionId = 'session-1') => ({ requestId, status, sessionId,
    ...bindings.get(sessionId), provider: 'fixture-provider', model: 'fixture-model', purpose: 'main', at: new Date(clock.value).toISOString(), ...extra });
  const observe = (requestId, status, extra, sessionId) => budget.observe(event(requestId, status, extra, sessionId), auth);
  return { directory, clock, store, budget, configure, bindings, bind, event, observe };
}
const small = { dailyTokens: 10, monthlyTokens: 30, requestReserveTokens: 20 };

test('defaults are real Token units while constructor, snapshots and unknown binding reads never create a file or mint a grant', (t) => {
  const f = fixture(t), before = f.store.read().revision;
  assert.deepEqual(f.budget.snapshot().policy, DEFAULT_TOKEN_BUDGET_POLICY);
  assert.equal(f.budget.snapshot().balanceTokens, 0);
  assert.equal(f.budget.snapshot().dailyRemainingTokens, 50000);
  assert.deepEqual(f.budget.snapshot().transactions, []);
  assert.equal(f.budget.resolveBinding('missing-session'), null); assert.equal(f.budget.context({ scope: {} }), null);
  assert.equal(f.store.read().revision, before); assert.equal(fs.existsSync(f.store.file), false);
});

test('an unmetered user CLI result keeps its gap visible without freezing autonomous allowance edits', t => {
  const f = fixture(t, small); f.bind('cli-session', 'user-task', a, 'cli-job-1');
  f.observe('cli-request', 'started', {}, 'cli-session'); f.observe('cli-request', 'unknown', {}, 'cli-session');
  assert.equal(f.budget.snapshot().requests[0].reservedTokens, 0);
  f.configure({ dailyTokens: 25 });
  const state = f.budget.snapshot(); assert.equal(state.policy.dailyTokens, 25); assert.equal(state.balanceTokens, 30);
  assert.equal(state.requests[0].status, 'unknown'); assert.equal(state.requests[0].acknowledgedUnmetered, false);
  assert.equal(state.requests[0].settledTokens, null); assert.equal(state.pendingUnknownCount, 1);
  assert.equal(state.pendingAutonomyUnknownCount, 0);
});

test('active calls of either origin still block edits and unknown autonomous consumption remains protected', t => {
  for (const origin of ['user-task', 'autonomy']) {
    const f = fixture(t, small); f.bind('active-session', origin, a, 'work-active');
    f.observe('active-request', 'started', {}, 'active-session');
    assert.throws(() => f.configure({ dailyTokens: 25 }), { code: 'BUSY' });
    f.observe('active-request', 'usage', { usage: { totalTokens: 3 } }, 'active-session');
    assert.throws(() => f.configure({ dailyTokens: 25 }), { code: 'BUSY' });
    f.observe('active-request', 'unknown', {}, 'active-session');
    if (origin === 'autonomy') assert.throws(() => f.configure({ dailyTokens: 25 }), { code: 'BUSY' });
    else assert.equal(f.configure({ dailyTokens: 25 }).ok, true);
  }
});

test('ambiguous zero from the installed-host bridge holds the autonomous reservation instead of settling it as free', async t => {
  const f = fixture(t, small); f.bind(); let middleware;
  const bridge = createTokenUsageBridge({ ctx: { on(_name, callback) { middleware = callback; return () => {}; } },
    resolveBinding: id => f.budget.resolveBinding(id), onEvent: event => f.budget.observe(event, auth), now: () => f.clock.value });
  t.after(() => bridge.dispose());
  const stream = middleware({ sessionId: 'session-1', provider: 'fixture', model: 'fixture' }, async function* () {
    yield { type: 'text-delta', index: 0, text: 'output without reliable accounting' };
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  for await (const _chunk of stream) {}
  const state = f.budget.snapshot(), row = state.requests[0];
  assert.equal(row.status, 'unknown'); assert.equal(row.usage, null); assert.equal(row.settledTokens, null);
  assert.equal(state.reservedTokens, 20); assert.equal(state.balanceTokens, 30); assert.equal(state.pendingAutonomyUnknownCount, 1);
  assert.equal(state.transactions.filter(entry => entry.kind === 'spend').length, 0);
});

test('policy saves are owner authorized CAS and initialize only the selected monthly amount without changing the time wallet', (t) => {
  const f = fixture(t), wallet = new TimeWallet({ store: f.store, now: () => f.clock.value });
  wallet.configure({ enabled: false, dailySeconds: 13, monthlySeconds: 17 }, auth);
  const previous = f.store.read().state, revision = f.budget.snapshot().revision;
  assert.throws(() => f.budget.configure(small, { revision, authorize: () => false }), { code: 'FORBIDDEN' });
  f.budget.configure(small, { revision, ...auth });
  assert.equal(f.budget.snapshot().balanceTokens, 30);
  assert.throws(() => f.budget.configure({ dailyTokens: 5 }, { revision, ...auth }), { code: 'CONFLICT' });
  assert.throws(() => f.budget.configure({ dailyTokens: 5 }, auth), { code: 'INVALID_PATCH' });
  const next = f.store.read().state;
  assert.deepEqual(next.wallet, previous.wallet); assert.deepEqual(next.policy, previous.policy);
  assert.equal(next.autonomy, undefined, 'a token policy never enables autonomous activity');
  assert.equal(fs.statSync(f.store.file).mode & 0o777, 0o600);
});

test('authorization is rechecked at commit and raw callback errors are never exposed', (t) => {
  const f = fixture(t); let checks = 0;
  assert.throws(() => f.budget.bindSession('session-1', { scope: a, origin: 'user-task' }, { authorize: () => ++checks === 1 }), { code: 'FORBIDDEN' });
  assert.equal(fs.existsSync(f.store.file), false);
  assert.throws(() => f.budget.bindSession('session-1', { scope: a, origin: 'user-task' }, { authorize() { throw new Error('PRIVATE_CREDENTIAL'); } }),
    (error) => error.code === 'FORBIDDEN' && !error.message.includes('PRIVATE'));
});

test('user work records full usage even with a disabled or empty budget and never spends free or pocket tokens', (t) => {
  const f = fixture(t, { enabled: false, dailyTokens: 0, monthlyTokens: 0, requestReserveTokens: 20 });
  f.bind('session-1', 'user-task'); f.observe('request-1', 'started');
  const result = f.observe('request-1', 'failed', { usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 15 } });
  assert.equal(result.result.request.settledTokens, 110); assert.equal(result.result.request.status, 'failed');
  const s = f.budget.snapshot(); assert.equal(s.balanceTokens, 0); assert.equal(s.dailyRemainingTokens, 0); assert.equal(s.reservedTokens, 0);
  assert.deepEqual(s.today, { userTaskTokens: 110, autonomyTokens: 0, freeTokens: 0, pocketTokens: 0 });
  assert.equal(s.transactions[0].kind, 'user-task'); assert.equal(s.transactions[0].pocketTokens, 0);
});

test('cumulative samples replace rather than add, caches are separate input and reasoning is not charged twice', (t) => {
  const f = fixture(t, { dailyTokens: 100, monthlyTokens: 200000, requestReserveTokens: 20 }); f.bind();
  f.observe('request-1', 'started'); f.observe('request-1', 'usage', { usage: { inputTokens: 10, outputTokens: 2 } });
  f.clock.value++; f.observe('request-1', 'usage', { usage: { inputTokens: 46487, outputTokens: 62, cacheReadTokens: 17536, cacheWriteTokens: 0, reasoningTokens: 50 } });
  f.clock.value++; const result = f.observe('request-1', 'completed', { finishReason: 'stop' }).result.request;
  assert.equal(result.settledTokens, 64085); assert.equal(result.freeTokens, 100); assert.equal(result.pocketTokens, 63985);
  assert.equal(f.budget.snapshot().balanceTokens, 136015);
  f.observe('request-1', 'completed', { usage: { totalTokens: 999999 } });
  assert.equal(f.budget.snapshot().balanceTokens, 136015); assert.equal(f.budget.snapshot().transactions.filter((row) => row.kind === 'spend').length, 1);
});

test('a provider aggregate wins only when valid and no smaller than any reported billed bucket', () => {
  assert.equal(normalizeTokenUsage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens: 95, reasoningTokens: 15 }).totalTokens, 95);
  assert.equal(normalizeTokenUsage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens: 40, reasoningTokens: 15 }).totalTokens, 40,
    'provider aggregate may overlap buckets, so it need not equal their sum');
  assert.equal(normalizeTokenUsage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 15 }).totalTokens, 100);
  for (const totalTokens of [-1, undefined, null, NaN, Infinity, 2.5, '95', 0, 39])
    assert.equal(normalizeTokenUsage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens }), null);
  for (const invalid of [undefined, {}, { inputTokens: 0 }, { outputTokens: 0 }, { inputTokens: 1, outputTokens: -1 },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }, { totalTokens: 10, prompt: 'PRIVATE' }]) assert.equal(normalizeTokenUsage(invalid), null);
  assert.equal(normalizeTokenUsage({ totalTokens: 0 }).totalTokens, 0, 'explicit measured zero is different from no usage');
});

test('invalid terminal receipts preserve partial usage and autonomous holds without settling a partial bill', t => {
  for (const status of ['completed', 'failed', 'cancelled']) for (const bad of [
    { inputTokens: 30, outputTokens: 2, totalTokens: 0 },
    { inputTokens: 3, outputTokens: 2, totalTokens: -1 },
    { inputTokens: 3, outputTokens: 2, totalTokens: undefined },
    { inputTokens: -1, outputTokens: 2 },
  ]) {
    const f = fixture(t, { dailyTokens: 0, monthlyTokens: 50, requestReserveTokens: 10 }); f.bind();
    f.observe('request-1', 'started'); f.observe('request-1', 'usage', { usage: { inputTokens: 25, outputTokens: 5 } });
    const partial = f.budget.snapshot().requests[0].usage;
    assert.equal(f.observe('request-1', 'usage', { usage: bad }).result.ignored, true);
    const row = f.observe('request-1', status, { usage: bad }).result.request;
    assert.equal(row.status, 'unknown'); assert.equal(row.unmetered, true); assert.deepEqual(row.usage, partial);
    assert.equal(row.settledTokens, null); assert.equal(row.reservedTokens, 30);
    const value = f.budget.snapshot(); assert.equal(value.balanceTokens, 50); assert.equal(value.reservedTokens, 30);
    assert.equal(value.pendingAutonomyUnknownCount, 1); assert.equal(value.transactions.some(row => row.kind === 'spend'), false);
  }
});

test('a positive billed bucket with provider total zero is unknown even without an earlier sample', t => {
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const f = fixture(t, small); f.bind(); f.observe('request-1', 'started');
    const row = f.observe('request-1', 'completed', { usage: { inputTokens: 0, outputTokens: 0, [key]: 2, totalTokens: 0 } }).result.request;
    assert.equal(row.status, 'unknown'); assert.equal(row.usage, null); assert.equal(row.settledTokens, null);
    assert.equal(row.reservedTokens, 20); assert.equal(f.budget.snapshot().balanceTokens, 30);
  }
});

test('shared reservations prevent concurrent overspend and release unused capacity after actual settlement', async (t) => {
  const f = fixture(t, small); f.bind(); f.bind('session-2', 'autonomy', b, 'work-2');
  const another = new TokenBudget({ store: f.store, now: () => f.clock.value });
  await Promise.all([Promise.resolve().then(() => f.observe('request-1', 'started')),
    Promise.resolve().then(() => another.observe(f.event('request-2', 'started', {}, 'session-2'), auth))]);
  assert.equal(f.budget.snapshot().reservedTokens, 40); assert.equal(f.budget.snapshot().availableTokens, 0);
  assert.throws(() => f.observe('request-3', 'started'), { code: 'LIMIT' });
  f.observe('request-1', 'completed', { usage: { totalTokens: 6 } });
  assert.equal(f.budget.snapshot().availableTokens, 14);
  f.observe('request-2', 'completed', { usage: { totalTokens: 14 } }, 'session-2');
  assert.equal(f.budget.snapshot().balanceTokens, 20); assert.equal(f.budget.snapshot().dailyRemainingTokens, 0);
  assert.equal(f.budget.snapshot().reservedTokens, 0);
});

test('real overrun is fully charged as debt and blocks later autonomy, including after the daily reset', (t) => {
  const f = fixture(t, { dailyTokens: 5, monthlyTokens: 5, requestReserveTokens: 10 }); f.bind();
  f.observe('request-1', 'started'); f.observe('request-1', 'completed', { usage: { totalTokens: 25 } });
  assert.equal(f.budget.snapshot().balanceTokens, -15); assert.equal(f.budget.snapshot().overdrawnTokens, 15);
  assert.throws(() => f.observe('request-2', 'started'), { code: 'LIMIT' });
  f.clock.value += 86400000; assert.equal(f.budget.snapshot().dailyRemainingTokens, 5);
  assert.throws(() => f.observe('request-2', 'started'), { code: 'LIMIT' });
  f.budget.add({ requestId: 'owner-bonus-1', tokens: 20 }, auth);
  assert.equal(f.observe('request-2', 'started').result.allowed, true);
});

test('already observed cumulative overrun enlarges its hold and blocks new autonomy before final settlement', (t) => {
  const f = fixture(t, { dailyTokens: 0, monthlyTokens: 20, requestReserveTokens: 10 }); f.bind();
  f.observe('request-1', 'started'); f.observe('request-1', 'usage', { usage: { totalTokens: 30 } });
  assert.equal(f.budget.snapshot().reservedTokens, 30); assert.equal(f.budget.snapshot().availableTokens, 0);
  assert.equal(f.budget.snapshot().overdrawnTokens, 10); assert.equal(f.budget.snapshot().balanceTokens, 20, 'a hold is not settlement');
  assert.throws(() => f.observe('request-2', 'started'), { code: 'LIMIT' });
  f.observe('request-1', 'usage', { usage: { totalTokens: 25 } });
  assert.equal(f.budget.snapshot().reservedTokens, 30, 'a corrected smaller sample never prematurely releases the conservative hold');
  f.observe('request-1', 'completed'); assert.equal(f.budget.snapshot().balanceTokens, -5);
});

for (const status of ['failed', 'cancelled']) test(status + ' requests still settle actual reported consumption', (t) => {
  const f = fixture(t, { dailyTokens: 10, monthlyTokens: 30, requestReserveTokens: 20 }); f.bind();
  f.observe('request-1', 'started'); f.observe('request-1', status, { usage: { totalTokens: 23 }, finishReason: status === 'failed' ? 'error' : 'aborted' });
  assert.equal(f.budget.snapshot().balanceTokens, 17); assert.equal(f.budget.snapshot().today.autonomyTokens, 23);
  assert.equal(f.budget.snapshot().requests[0].status, status); assert.equal(f.budget.snapshot().reservedTokens, 0);
});

test('a request crossing local midnight spends its starting day and monthly grants accumulate only on authorized writes', (t) => {
  const f = fixture(t); f.clock.value = Date.parse('2026-10-31T15:59:00Z');
  f.configure({ dailyTokens: 10, monthlyTokens: 10, requestReserveTokens: 5 }); f.bind(); f.observe('request-1', 'started');
  f.clock.value = Date.parse('2026-10-31T16:01:00Z'); const before = fs.readFileSync(f.store.file);
  assert.equal(f.budget.snapshot().balanceTokens, 10); assert.equal(f.budget.snapshot().dailyRemainingTokens, 10);
  assert.equal(f.budget.snapshot().availableTokens, 20, 'the old reservation is covered by its own starting day');
  assert.deepEqual(fs.readFileSync(f.store.file), before);
  f.observe('request-1', 'completed', { usage: { totalTokens: 15 } });
  const s = f.budget.snapshot(); assert.equal(s.balanceTokens, 15); assert.equal(s.dailyRemainingTokens, 10);
  assert.equal(s.today.autonomyTokens, 0); assert.equal(f.store.read().state.tokenBudget.days['2026-10-31'], 10);
  assert.equal(s.transactions.filter((row) => row.kind === 'monthly').length, 2);
});

test('monthly and owner grants have durable once-only IDs across missed months and restarts', (t) => {
  const f = fixture(t, { monthlyTokens: 10 }); const before = f.budget.snapshot().revision;
  f.clock.value = Date.parse('2026-12-24T10:00:00Z');
  for (let at = 0; at < 3; at++) assert.equal(f.budget.snapshot().balanceTokens, 10);
  assert.equal(f.budget.snapshot().revision, before);
  f.budget.add({ requestId: 'bonus-uuid-1', tokens: 1 }, auth);
  const restarted = new TokenBudget({ store: new LifeStore({ directory: f.directory }), now: () => f.clock.value });
  assert.equal(restarted.add({ requestId: 'bonus-uuid-1', tokens: 1 }, auth).result.duplicate, true);
  assert.equal(restarted.snapshot().balanceTokens, 31); assert.equal(restarted.snapshot().transactions.filter((row) => row.kind === 'monthly').length, 3);
  assert.throws(() => restarted.add({ requestId: 'bonus-uuid-1', tokens: 2 }, auth), { code: 'BINDING_CONFLICT' });
});

for (const debt of [0, 5]) test('new-month projection permits admission with no daily free and ' + debt + ' old debt without writing a grant on GET', (t) => {
  const f = fixture(t, { dailyTokens: 0, monthlyTokens: 10, requestReserveTokens: 5 }); f.bind();
  f.observe('request-1', 'started'); f.observe('request-1', 'completed', { usage: { totalTokens: 10 + debt } });
  f.clock.value = Date.parse('2026-11-01T10:00:00Z');
  const before = fs.readFileSync(f.store.file), revision = f.store.read().revision;
  for (let index = 0; index < 3; index++) {
    const s = f.budget.snapshot();
    assert.equal(s.balanceTokens, debt ? -debt : 0); assert.equal(s.availableTokens, 0); assert.equal(s.overdrawnTokens, debt);
    assert.equal(s.pendingMonthlyTokens, 10); assert.equal(s.projectedAvailableTokens, 10 - debt); assert.equal(s.projectedOverdrawnTokens, 0);
    assert.equal(s.transactions.filter((row) => row.kind === 'monthly').length, 1);
  }
  assert.deepEqual(fs.readFileSync(f.store.file), before); assert.equal(f.store.read().revision, revision);
  assert.equal(f.observe('request-2', 'started').result.allowed, true);
  const saved = f.budget.snapshot(); assert.equal(saved.balanceTokens, 10 - debt); assert.equal(saved.pendingMonthlyTokens, 0);
  assert.equal(saved.transactions.filter((row) => row.kind === 'monthly').length, 2);
});

test('unknown usage keeps its reservation until explicitly acknowledged and never becomes a fabricated zero cost', (t) => {
  const f = fixture(t, small); f.bind(); f.observe('request-1', 'started'); f.observe('request-1', 'completed');
  let s = f.budget.snapshot(); assert.equal(s.requests[0].status, 'unknown'); assert.equal(s.requests[0].usage, null);
  assert.equal(s.requests[0].settledTokens, null); assert.equal(s.reservedTokens, 20); assert.equal(s.pendingUnknownCount, 1);
  assert.throws(() => f.observe('request-2', 'started'), { code: 'UNMETERED' });
  assert.throws(() => f.budget.acknowledgeUnknown('request-1', { confirmedStopped: true, ...auth }), { code: 'INVALID_PATCH' });
  f.budget.acknowledgeUnknown('request-1', { confirmedStopped: true, acknowledgedUnmetered: true, ...auth });
  s = f.budget.snapshot(); assert.equal(s.unmeteredCount, 1); assert.equal(s.pendingUnknownCount, 0); assert.equal(s.reservedTokens, 0);
  assert.equal(s.balanceTokens, 30); assert.equal(s.requests[0].status, 'unknown'); assert.equal(s.requests[0].settledTokens, null);
  assert.equal(s.requests[0].acknowledgedUnmetered, true);
  f.observe('request-1', 'completed', { usage: { totalTokens: 3 } });
  assert.equal(f.budget.snapshot().requests[0].settledTokens, null, 'a late terminal cannot replace an already unknown terminal');
  assert.equal(f.observe('request-2', 'started').result.allowed, true);
});

test('startup converts partial cumulative samples to unknown, keeps holds and never settles an unfinished sample', (t) => {
  const f = fixture(t, { dailyTokens: 50, monthlyTokens: 100, requestReserveTokens: 20 }); f.bind();
  f.observe('request-1', 'started'); f.observe('request-2', 'started');
  f.observe('request-2', 'usage', { usage: { inputTokens: 2, outputTokens: 3 } });
  const restarted = new TokenBudget({ store: new LifeStore({ directory: f.directory }), now: () => f.clock.value });
  assert.equal(restarted.recoverStartup(auth).result.recovered, 2); assert.equal(restarted.recoverStartup(auth).result.recovered, 0);
  const s = restarted.snapshot(); assert.equal(s.balanceTokens, 100); assert.equal(s.reservedTokens, 40); assert.equal(s.unmeteredCount, 2);
  assert(s.requests.every((row) => row.status === 'unknown' && row.settledTokens === null));
  assert.equal(s.transactions.filter((row) => row.kind === 'spend').length, 0);
});

test('an explicit unknown terminal preserves partial usage and conservative hold instead of inventing a full bill', (t) => {
  const f = fixture(t, { dailyTokens: 0, monthlyTokens: 50, requestReserveTokens: 10 }); f.bind();
  f.observe('request-1', 'started'); f.observe('request-1', 'usage', { usage: { totalTokens: 30 } });
  const row = f.observe('request-1', 'unknown', { usage: { totalTokens: 25 }, finishReason: 'stream-ended' }).result.request;
  assert.equal(row.status, 'unknown'); assert.equal(row.unmetered, true); assert.equal(row.usage.totalTokens, 25);
  assert.equal(row.settledTokens, null); assert.equal(row.freeTokens, null); assert.equal(row.pocketTokens, null);
  let s = f.budget.snapshot(); assert.equal(s.balanceTokens, 50); assert.equal(s.reservedTokens, 30);
  assert.equal(s.unmeteredCount, 1); assert.equal(s.pendingUnknownCount, 1);
  assert.equal(s.transactions.some((transaction) => transaction.kind === 'spend'), false);
  assert.throws(() => f.observe('request-2', 'started'), { code: 'UNMETERED' });
  f.observe('request-1', 'completed', { usage: { totalTokens: 40 } });
  assert.equal(f.budget.snapshot().balanceTokens, 50, 'a second terminal never rewrites the unknown outcome');
  f.budget.acknowledgeUnknown('request-1', { ...auth, confirmedStopped: true, acknowledgedUnmetered: true });
  s = f.budget.snapshot(); assert.equal(s.reservedTokens, 0); assert.equal(s.unmeteredCount, 1);
  assert.equal(s.requests[0].settledTokens, null); assert.equal(s.requests[0].usage.totalTokens, 25);
  assert.equal(s.requests[0].acknowledgedUnmetered, true);
});

test('the shipped usage bridge keeps a last invalid sample unknown and cannot replay a previously started request', async (t) => {
  const f = fixture(t, { dailyTokens: 0, monthlyTokens: 50, requestReserveTokens: 10 }); f.bind();
  let middleware, calls = 0;
  const bridge = createTokenUsageBridge({ ctx: { on(name, handler) { assert.equal(name, 'llm/stream'); middleware = handler; return () => {}; } },
    resolveBinding: (id) => f.budget.resolveBinding(id), now: () => f.clock.value, idFactory: () => 'request-1',
    onEvent: (event) => f.budget.observe(event, auth) });
  t.after(() => bridge.dispose());
  const options = { sessionId: 'session-1', provider: 'fixture-provider', model: 'fixture-model', purpose: 'main' };
  const next = async function* () {
    calls++; yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: -1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  for await (const _chunk of middleware(options, next)) { /* Provider chunks keep their own contract. */ }
  const s = f.budget.snapshot(); assert.equal(s.requests[0].status, 'unknown'); assert.equal(s.requests[0].settledTokens, null);
  assert.equal(s.requests[0].usage.totalTokens, 30); assert.equal(s.reservedTokens, 30); assert.equal(s.balanceTokens, 50);
  await assert.rejects(async () => { for await (const _chunk of middleware(options, next)) { /* never executes */ } }, { code: 'USAGE_START_REJECTED' });
  assert.equal(calls, 1);
});

test('retiring a session rejects a new request but permits the original in-flight usage and settlement', (t) => {
  const f = fixture(t, small); f.bind(); f.observe('request-1', 'started'); f.budget.retireSession('session-1', auth);
  assert.throws(() => f.observe('request-2', 'started'), { code: 'RETIRED' });
  f.observe('request-1', 'usage', { usage: { totalTokens: 5 } });
  assert.equal(f.observe('request-1', 'completed').result.request.settledTokens, 5);
});

test('overlapping tasks on one user session keep immutable per-request work while current binding advances', (t) => {
  const f = fixture(t, small); const old = f.bind('session-1', 'user-task', a, 'task-old'); f.observe('request-1', 'started');
  f.bind('session-1', 'user-task', a, 'task-new'); f.observe('request-2', 'started');
  f.budget.observe(f.event('request-1', 'usage', { ...old, usage: { totalTokens: 7 } }), auth);
  f.budget.observe(f.event('request-1', 'completed', old), auth);
  f.observe('request-2', 'completed', { usage: { totalTokens: 11 } });
  assert.equal(f.budget.resolveBinding('session-1').userTaskId, 'task-new');
  assert.deepEqual(f.budget.snapshot().requests.map((row) => [row.userTaskId, row.settledTokens]), [['task-new', 11], ['task-old', 7]]);
  assert.throws(() => f.observe('request-1', 'completed'), { code: 'BINDING_CONFLICT' });
  assert.equal(f.budget.snapshot().balanceTokens, 30);
  assert.throws(() => f.budget.bindSession('session-1', { scope: b, origin: 'user-task' }, auth), { code: 'BINDING_CONFLICT' });
  assert.throws(() => f.budget.bindSession('session-1', { scope: a, origin: 'autonomy' }, auth), { code: 'BINDING_CONFLICT' });
});

test('activity, sender, session and work ID substitutions are rejected before any charge or new request', (t) => {
  const f = fixture(t, small); f.bind(); f.observe('request-1', 'started');
  assert.throws(() => f.budget.bindSession('session-1', { scope: a, origin: 'autonomy', activityId: 'different' }, auth), { code: 'BINDING_CONFLICT' });
  for (const patch of [{ scope: b }, { origin: 'user-task', userTaskId: 'forged' }, { activityId: 'forged' }, { workId: 'forged' }]) {
    assert.throws(() => f.observe('request-1', 'completed', { ...patch, usage: { totalTokens: 10 } }));
  }
  assert.equal(f.budget.snapshot().reservedTokens, 20); assert.equal(f.budget.snapshot().balanceTokens, 30);
});

test('a repeated started request is persistently denied permission to call the model again, even after completion', (t) => {
  const f = fixture(t, small); f.bind(); assert.equal(f.observe('request-1', 'started').result.allowed, true);
  assert.equal(f.observe('request-1', 'started').result.allowed, false);
  assert.equal(f.budget.snapshot().reservedTokens, 20);
  f.observe('request-1', 'completed', { usage: { totalTokens: 0 } });
  assert.equal(f.observe('request-1', 'started').result.allowed, false);
  const fresh = new TokenBudget({ store: new LifeStore({ directory: f.directory }), now: () => f.clock.value });
  assert.equal(fresh.observe(f.event('request-1', 'started'), auth).result.allowed, false);
  assert.equal(fresh.snapshot().balanceTokens, 30); assert.equal(fresh.snapshot().today.autonomyTokens, 0);
});

test('scoped views never include other accounts or identities, and unknown scopes have no request or transaction history', (t) => {
  const f = fixture(t, small); f.bind('session-1', 'user-task'); f.bind('session-2', 'user-task', b, 'PRIVATE_B_WORK');
  f.bind('session-3', 'user-task', { ...a, identityId: 'other' }, 'PRIVATE_OTHER_ID_WORK');
  for (const [id, session] of [['request-1', 'session-1'], ['request-2', 'session-2'], ['request-3', 'session-3']]) {
    f.observe(id, 'started', {}, session); f.observe(id, 'completed', { usage: { totalTokens: 3 } }, session);
  }
  const own = f.budget.snapshot({ scope: a }); assert.equal(own.requests.length, 1); assert.equal(own.transactions.length, 1);
  assert.equal(own.today.userTaskTokens, 3); assert.doesNotMatch(JSON.stringify(own), /PRIVATE/);
  assert.equal(own.sharedBudgetVisible, false);
  for (const field of ['policy', 'balanceTokens', 'dailyRemainingTokens', 'availableTokens', 'overdrawnTokens',
    'pendingMonthlyTokens', 'projectedAvailableTokens', 'projectedOverdrawnTokens']) assert.equal(own[field], null);
  const unknown = f.budget.snapshot({ scope: { accountId: '99999', identityId: 'unknown' } });
  assert.deepEqual(unknown.requests, []); assert.deepEqual(unknown.transactions, []); assert.equal(unknown.today.userTaskTokens, 0);
  assert.equal(unknown.reservedTokens, 0); assert.equal(unknown.balanceTokens, null); assert.equal(unknown.policy, null);
  assert.equal(f.budget.snapshot().sharedBudgetVisible, true);
});

test('unresolved autonomous receipts remain actionable beyond the hundred most recent requests and within their own scope', t => {
  const f = fixture(t, small); f.bind();
  f.observe('old-autonomy-unknown', 'started'); f.observe('old-autonomy-unknown', 'unknown');
  f.bind('later-user-session', 'user-task', b);
  for (let index = 0; index < 105; index++) {
    const id = 'new-user-' + index;
    f.observe(id, 'started', {}, 'later-user-session');
    f.observe(id, 'completed', { usage: { totalTokens: 1 } }, 'later-user-session');
  }
  const before = fs.readFileSync(f.store.file), status = f.budget.snapshot();
  assert.equal(status.requests.length, 100); assert.equal(status.pendingAutonomyUnknownCount, 1);
  assert.equal(status.requests.at(-1).requestId, 'old-autonomy-unknown');
  assert.equal(status.requests[0].requestId, 'new-user-104');
  assert.equal(f.budget.snapshot({ scope: a }).requests[0].requestId, 'old-autonomy-unknown');
  assert.equal(f.budget.snapshot({ scope: b }).requests.some(row => row.requestId === 'old-autonomy-unknown'), false);
  assert.deepEqual(fs.readFileSync(f.store.file), before, 'read-only selection does not acknowledge or settle anything');
  f.budget.acknowledgeUnknown('old-autonomy-unknown', { ...auth, confirmedStopped: true, acknowledgedUnmetered: true });
  const after = f.budget.snapshot();
  assert.equal(after.pendingAutonomyUnknownCount, 0); assert.equal(after.reservedTokens, 0);
  assert.equal(after.requests.length, 100); assert.equal(after.requests.some(row => row.requestId === 'old-autonomy-unknown'), false);
});

test('invalid samples preserve the last valid cumulative sample; absent usage and explicitly measured zero remain distinct', (t) => {
  const f = fixture(t, small); f.bind();
  f.observe('request-1', 'started'); f.observe('request-1', 'usage', { usage: { totalTokens: 7 } });
  f.observe('request-1', 'usage', { usage: { inputTokens: -2, outputTokens: 1 } });
  assert.equal(f.observe('request-1', 'completed').result.request.settledTokens, 7);
  f.observe('request-2', 'started');
  assert.equal(f.observe('request-2', 'completed', { usage: {} }).result.request.settledTokens, null);
  f.budget.acknowledgeUnknown('request-2', { ...auth, confirmedStopped: true, acknowledgedUnmetered: true });
  f.observe('request-3', 'started');
  assert.equal(f.observe('request-3', 'completed', { usage: { totalTokens: 0 } }).result.request.settledTokens, 0);
});

test('policy cannot change while calls or unresolved unknown usage are in flight', (t) => {
  const f = fixture(t, small); f.bind(); f.observe('request-1', 'started');
  assert.throws(() => f.configure({ enabled: false }), { code: 'BUSY' });
  f.observe('request-1', 'cancelled'); assert.throws(() => f.configure({ dailyTokens: 1 }), { code: 'BUSY' });
  f.budget.acknowledgeUnknown('request-1', { ...auth, confirmedStopped: true, acknowledgedUnmetered: true });
  f.configure({ enabled: false }); assert.equal(f.budget.snapshot().policy.enabled, false);
});

test('optional ledger validation rejects changed balances, references and injected metadata without rewriting corruption', (t) => {
  const f = fixture(t, small); f.bind(); f.observe('request-1', 'started'); f.observe('request-1', 'completed', { usage: { totalTokens: 5 } });
  const original = fs.readFileSync(f.store.file, 'utf8');
  for (const mutate of [x => { x.balanceTokens++; }, x => { x.requests[0].scope = b; }, x => { x.requests[0].prompt = 'PRIVATE_BODY'; },
    x => { x.transactions.push(x.transactions[0]); }, x => { x.days['2026-02-31'] = 1; }]) {
    const state = JSON.parse(original); mutate(state.tokenBudget); const bytes = JSON.stringify(state); fs.writeFileSync(f.store.file, bytes);
    assert.throws(() => f.budget.snapshot(), (error) => error.code === 'STORAGE' && !/PRIVATE/.test(error.message));
    assert.throws(() => f.budget.add({ requestId: 'bonus-uuid', tokens: 1 }, auth), { code: 'STORAGE' });
    assert.equal(fs.readFileSync(f.store.file, 'utf8'), bytes);
  }
});

test('storage size and writer locks fail closed without leaking paths or partially granting tokens', (t) => {
  const f = fixture(t, small); const before = fs.readFileSync(f.store.file);
  fs.mkdirSync(f.store.lock);
  assert.throws(() => f.budget.add({ requestId: 'bonus-uuid', tokens: 1 }, auth), { code: 'BUSY' });
  fs.rmdirSync(f.store.lock); assert.deepEqual(fs.readFileSync(f.store.file), before);
  fs.writeFileSync(f.store.file, ' '.repeat(16 * 1024 * 1024 + 1));
  assert.throws(() => f.budget.snapshot(), (error) => error.code === 'STORAGE' && !error.message.includes(f.directory));
});

test('owner awards that overflow representable shared capacity are rejected atomically', (t) => {
  const f = fixture(t, small), before = fs.readFileSync(f.store.file);
  assert.throws(() => f.budget.add({ requestId: 'overflow-bonus', tokens: Number.MAX_SAFE_INTEGER - 30 }, auth), { code: 'LIMIT' });
  assert.deepEqual(fs.readFileSync(f.store.file), before); assert.equal(f.budget.snapshot().balanceTokens, 30);
});
