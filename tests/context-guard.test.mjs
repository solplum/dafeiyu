import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContextGuard } from '../packages/dsh-dafeiyu/src/context-guard.js';
import { createTokenUsageBridge } from '../packages/dsh-dafeiyu/src/token-usage-bridge.js';
import { LifeStore } from '../packages/dsh-dafeiyu/src/life-store.js';
import { TokenBudget } from '../packages/dsh-dafeiyu/src/token-budget.js';

const yes = () => true, scope = { accountId: '20002', identityId: 'default' };
const content = value => [{ role: 'user', content: [{ type: 'text', text: value }] }];
const finish = (kind = 'stop', failure) => ({ type: 'finish', reason: { kind, ...(failure ? { failure } : {}) } });
const receipt = (tokens = 17, ending = finish()) => [{ type: 'usage', usage: { inputTokens: tokens - 3, outputTokens: 3, totalTokens: tokens } }, ending];
const collect = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result; };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

function fixture(t, { contextWindow = 10000 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-guard-fixture-'));
  const store = new LifeStore({ directory }), budget = new TokenBudget({ store });
  budget.configure({ dailyTokens: 100, monthlyTokens: 1000, requestReserveTokens: 100 }, { revision: budget.snapshot().revision, authorize: yes });
  const agents = new Map(), managed = new Map(), listeners = new Map(), events = [], bindingCalls = new Map();
  let providerCalls = 0, bindingHook;
  let resolver = async (provider, model) => ({ provider, id: model, context: { contextWindow }, defaultMaxTokens: 1000 });
  const llm = { resolveModelInfo: (...args) => resolver(...args) };
  const ctx = {
    get: name => name === 'agents' ? agents : name === 'llm' ? llm : undefined,
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener);
      return () => listeners.get(name).delete(listener);
    },
  };
  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args); };
  const guard = createContextGuard({ ctx, now: () => Date.parse('2026-10-26T00:00:00Z') });
  const bridge = createTokenUsageBridge({ ctx,
    async resolveBinding(id) {
      if (!managed.has(id)) return null;
      const count = (bindingCalls.get(id) || 0) + 1; bindingCalls.set(id, count);
      if (bindingHook) await bindingHook(id, count);
      if (agents.get(id) !== managed.get(id)) throw Object.assign(new Error('fixture ownership revoked'), { code: 'INVALID_USAGE_BINDING' });
      return budget.resolveBinding(id);
    },
    beforeDispatch: options => guard.beforeDispatch(options),
    onDispatch: options => guard.onDispatch(options),
    onSettlement: (options, value) => guard.onSettlement(options, value),
    usageIsAuthoritative: options => guard.usageIsAuthoritative(options),
    onEvent(event) { events.push(event); return budget.observe(event, { authorize: yes }); },
  });
  const turn = (agent, id = 1) => emit('session/event', agent.session, { type: 'turn/start', data: { turn: id } });
  const add = (id, { origin = 'user-task', owned = true, accountScope = scope, billion = false } = {}) => {
    const agent = { id, ctx: { get: name => name === 'biliBasicCompactionPolicy' && billion ? { owner: 'billion-context' } : undefined },
      session: { id, header: { id }, seq: 0, messages: content('short fixture input'),
        requestHeader() { return { config: { provider: 'fixture-provider', model: 'fixture-model', maxTokens: 1000 } }; },
        deriveMessages() { return this.messages; }, toolHistory() { return this.history; } } };
    agents.set(id, agent);
    if (owned) {
      managed.set(id, agent);
      budget.bindSession(id, { origin, scope: accountScope, ...(origin === 'autonomy' ? { activityId: 'auto:' + id } : { userTaskId: 'work:' + id }) }, { authorize: yes });
    }
    turn(agent); return agent;
  };
  const options = (agent, patch = {}) => Object.freeze({ sessionId: agent.id, provider: 'fixture-provider', model: 'fixture-model',
    maxTokens: 1000, messages: agent.session.messages, ...patch });
  const dispatch = (agent, chunks = receipt(), patch = {}) => {
    const stream = [...listeners.get('llm/stream')][0];
    return collect(stream(options(agent, patch), () => { providerCalls++; return typeof chunks === 'function' ? chunks() : chunks; }));
  };
  t.after(() => { bridge.dispose(); guard.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { agents, managed, events, store, budget, guard, bridge, llm, add, turn, options, dispatch, emit,
    setResolver(value) { resolver = value; }, setBindingHook(value) { bindingHook = value; },
    get providerCalls() { return providerCalls; } };
}

test('whole-request admission preserves real usage attribution and uses resolved output reserve without changing the request', async t => {
  const f = fixture(t), agent = f.add('normal');
  const options = f.options(agent, { maxTokens: undefined }), view = await f.guard.beforeDispatch(options);
  assert.equal(view.outputTokens, 1000); assert.equal(view.estimated, true); assert.equal(view.source, 'utf8-conservative-v1');
  assert.ok(view.inputTokens > 0); assert.equal(options.maxTokens, undefined);
  const chunks = receipt(), output = await f.dispatch(agent, chunks);
  chunks.forEach((chunk, index) => assert.equal(output[index], chunk));
  const value = f.budget.snapshot();
  assert.equal(f.providerCalls, 1); assert.equal(value.requests[0].settledTokens, 17);
  assert.equal(value.requests[0].origin, 'user-task'); assert.equal(value.today.autonomyTokens, 0);
  assert.equal(value.balanceTokens, 1000); assert.equal(value.dailyRemainingTokens, 100);
});

test('a local capacity refusal precedes started, provider dispatch and autonomous reservations', async t => {
  const f = fixture(t), agent = f.add('capacity', { origin: 'autonomy' }), before = fs.readFileSync(f.store.file);
  await assert.rejects(f.dispatch(agent, receipt(), { messages: content('PRIVATE_LARGE'.repeat(1200)) }), { code: 'CONTEXT_CAPACITY_REQUIRED' });
  assert.equal(f.providerCalls, 0); assert.deepEqual(f.events, []); assert.deepEqual(fs.readFileSync(f.store.file), before);
  const value = f.budget.snapshot(); assert.equal(value.reservedTokens, 0); assert.equal(value.pendingUnknownCount, 0);
  assert.equal(f.guard.failureFor(agent).providerStarted, false);
});

test('unknown metadata, output defaults and attachment projections fail closed without provider or ledger events', async t => {
  for (const kind of ['metadata', 'output', 'image', 'file']) {
    const f = fixture(t), agent = f.add('unknown-' + kind);
    const patch = {};
    if (kind === 'metadata') f.setResolver(async (provider, model) => ({ provider, id: model }));
    if (kind === 'output') { patch.maxTokens = undefined; f.setResolver(async (provider, model) => ({ provider, id: model, context: { contextWindow: 10000 } })); }
    if (['image', 'file'].includes(kind)) patch.messages = [{ role: 'user', content: [{ type: kind, attachment: { attachmentId: 'sha256:' + 'a'.repeat(64) } }] }];
    await assert.rejects(f.dispatch(agent, receipt(), patch), { code: 'CONTEXT_GUARD_UNAVAILABLE' });
    assert.equal(f.providerCalls, 0); assert.deepEqual(f.events, []); assert.equal(f.budget.snapshot().pendingUnknownCount, 0);
  }
});

test('unowned requests bypass companion context and token state even with a corrupt ledger', async t => {
  const f = fixture(t), foreign = f.add('foreign-project', { owned: false });
  fs.writeFileSync(f.store.file, '{PRIVATE_CORRUPT_FIXTURE');
  f.setResolver(() => assert.fail('foreign metadata must not be requested'));
  const output = await f.dispatch(foreign, receipt());
  assert.equal(output.length, 2); assert.equal(f.providerCalls, 1); assert.deepEqual(f.events, []);
  assert.equal(f.guard.failureFor(foreign), null); assert.equal(fs.readFileSync(f.store.file, 'utf8'), '{PRIVATE_CORRUPT_FIXTURE');
});

test('concurrent sessions retain independent capacity latches, ownership and actual settlements', async t => {
  const f = fixture(t), a = f.add('owner-a'), b = f.add('peer-b', { accountScope: { accountId: '30003', identityId: 'other' } });
  const results = await Promise.allSettled([f.dispatch(a, receipt(), { messages: content('large'.repeat(3000)) }), f.dispatch(b, receipt(23))]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[0].reason.code, 'CONTEXT_CAPACITY_REQUIRED');
  assert.equal(results[1].status, 'fulfilled'); assert.equal(f.providerCalls, 1); assert.equal(f.guard.failureFor(b), null);
  const rows = f.budget.snapshot().requests; assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, b.id);
  assert.equal(rows[0].scope.accountId, '30003'); assert.equal(rows[0].settledTokens, 23);
});

test('a compression failure during metadata await cannot admit a concurrent request after the new pause', async t => {
  const f = fixture(t), agent = f.add('compression-race'); await f.dispatch(agent);
  const gate = deferred(), entered = deferred(), before = fs.readFileSync(f.store.file), eventCount = f.events.length;
  f.setResolver(async (provider, model) => { entered.resolve(); await gate.promise; return { provider, id: model, context: { contextWindow: 10000 }, defaultMaxTokens: 1000 }; });
  const pending = f.dispatch(agent); await entered.promise;
  f.emit('tools/result', { agent, name: 'compress' }, { isError: true }); gate.resolve();
  await assert.rejects(pending, { code: 'CONTEXT_COMPACTION_FAILED' });
  assert.equal(f.providerCalls, 1); assert.equal(f.events.length, eventCount); assert.deepEqual(fs.readFileSync(f.store.file), before);
});

test('revocation and cancellation during metadata await stop before started and preserve zero new unknowns', async t => {
  for (const action of ['revoke', 'cancel']) {
    const f = fixture(t), agent = f.add('await-' + action), controller = new AbortController(), gate = deferred(), entered = deferred();
    f.setResolver(async (provider, model) => { entered.resolve(); await gate.promise; return { provider, id: model, context: { contextWindow: 10000 }, defaultMaxTokens: 1000 }; });
    const pending = f.dispatch(agent, receipt(), { signal: controller.signal }); await entered.promise;
    if (action === 'revoke') f.agents.delete(agent.id); else controller.abort();
    gate.resolve(); await assert.rejects(pending);
    assert.equal(f.providerCalls, 0); assert.deepEqual(f.events, []); assert.equal(f.budget.snapshot().pendingUnknownCount, 0);
  }
});

test('cancellation in the second binding await does not create started or fictitious unknown consumption', async t => {
  const f = fixture(t), agent = f.add('binding-cancel', { origin: 'autonomy' }), controller = new AbortController();
  f.setBindingHook((_id, count) => { if (count === 2) controller.abort(); });
  await assert.rejects(f.dispatch(agent, receipt(), { signal: controller.signal }), { code: 'USAGE_REQUEST_ABORTED' });
  assert.equal(f.providerCalls, 0); assert.deepEqual(f.events, []);
  assert.equal(f.budget.snapshot().reservedTokens, 0); assert.equal(f.budget.snapshot().pendingUnknownCount, 0);
});

test('compaction measures its own selected input while a full original conversation is paused', async t => {
  const f = fixture(t), agent = f.add('compact-small'); agent.session.messages = content('original-large'.repeat(1000));
  await assert.rejects(f.dispatch(agent), { code: 'CONTEXT_CAPACITY_REQUIRED' });
  await f.dispatch(agent, receipt(31), { purpose: 'compaction', messages: content('selected short summary input'), maxTokens: 512 });
  assert.equal(f.providerCalls, 1);
  const row = f.budget.snapshot().requests[0]; assert.equal(row.purpose, 'compaction'); assert.equal(row.settledTokens, null);
  assert.equal(row.status, 'unknown', 'compaction attribution is unresolved until an authoritative source receipt can be verified');
  assert.equal(f.guard.failureFor(agent).code, 'CONTEXT_CAPACITY_REQUIRED', 'maintenance success does not silently replay or clear the paused original');
});

test('failed compaction keeps its unverified usage unknown and pauses main requests without another started event', async t => {
  const f = fixture(t), agent = f.add('compact-failed');
  await f.dispatch(agent, receipt(29, finish('error', { code: 'SERVER_ERROR' })), { purpose: 'compaction' });
  const before = fs.readFileSync(f.store.file), count = f.events.length;
  await assert.rejects(f.dispatch(agent), { code: 'CONTEXT_COMPACTION_FAILED' });
  const row = f.budget.snapshot().requests[0]; assert.equal(row.status, 'unknown'); assert.equal(row.settledTokens, null);
  assert.equal(f.providerCalls, 1); assert.equal(f.events.length, count); assert.deepEqual(fs.readFileSync(f.store.file), before);
});

test('compaction synthetic usage remains unknown both with and without the optional Billion owner marker', async t => {
  for (const billion of [false, true]) {
    const f = fixture(t), agent = f.add('billion-authored-' + billion, { billion });
    await f.dispatch(agent, receipt(77), { purpose: 'compaction' });
    const row = f.budget.snapshot().requests[0]; assert.equal(row.status, 'unknown'); assert.equal(row.usage, null);
    assert.equal(row.settledTokens, null); assert.equal(f.events.some(event => event.status === 'usage'), false);
    assert.equal(f.budget.snapshot().balanceTokens, 1000); assert.equal(f.budget.snapshot().today.userTaskTokens, 0);
    assert.equal(f.guard.failureFor(agent).code, 'CONTEXT_GUARD_UNAVAILABLE', 'unverified receipt does not prove that compression failed');
  }
});

test('independent system prompts and stop lists cannot bypass the whole-request capacity ceiling', async t => {
  for (const patch of [{ system: 'PRIVATE_HIDDEN_SYSTEM'.repeat(1000) }, { stop: ['PRIVATE_LONG_STOP'.repeat(1000)] }]) {
    const f = fixture(t), agent = f.add('request-fields');
    await assert.rejects(f.dispatch(agent, receipt(), patch), { code: 'CONTEXT_CAPACITY_REQUIRED' });
    assert.equal(f.providerCalls, 0); assert.deepEqual(f.events, []);
  }
});

test('metadata timeout and disposal cancel pending lookups without unhandled or late provider work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), agent = f.add('timeout'), entered = deferred(); let signal;
  f.setResolver((_provider, _model, lookupSignal) => { signal = lookupSignal; entered.resolve(); return new Promise(() => {}); });
  const pending = f.dispatch(agent); await entered.promise;
  const rejected = assert.rejects(pending, { code: 'CONTEXT_GUARD_UNAVAILABLE' });
  t.mock.timers.tick(5001); await rejected;
  assert.equal(signal.aborted, true); assert.equal(f.providerCalls, 0); assert.deepEqual(f.events, []);
  const g = fixture(t), other = g.add('dispose'), started = deferred(), late = deferred(); let otherSignal;
  g.setResolver((_provider, _model, lookupSignal) => { otherSignal = lookupSignal; started.resolve(); return late.promise; });
  const disposing = g.dispatch(other); await started.promise;
  const stopped = assert.rejects(disposing, { code: 'CONTEXT_GUARD_UNAVAILABLE' }); g.guard.dispose(); await stopped;
  assert.equal(otherSignal.aborted, true); late.reject(Error('PRIVATE_LATE_LOOKUP_FAILURE'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(g.providerCalls, 0); assert.deepEqual(g.events, []);
});

test('recovery permits are bound to session sequence and failure identity and include historical tool declarations', async t => {
  const f = fixture(t), agent = f.add('recover-cas');
  await assert.rejects(f.dispatch(agent, receipt(), { messages: content('oversized'.repeat(1500)) }));
  agent.session.history = { tools: [{ name: 'old', description: 'schema'.repeat(2500) }], updates: [] };
  assert.equal((await f.guard.checkRecovery(agent)).allowed, false);
  delete agent.session.history; agent.session.seq++;
  assert.equal((await f.guard.checkRecovery(agent)).allowed, true); agent.session.seq++;
  assert.throws(() => f.guard.clear(agent), { code: 'CONTEXT_RECOVERY_REQUIRED' });
  assert.equal((await f.guard.checkRecovery(agent)).allowed, true);
  f.emit('tools/result', { agent, name: 'compress' }, { isError: true });
  assert.throws(() => f.guard.clear(agent), { code: 'CONTEXT_RECOVERY_REQUIRED' });
  assert.equal((await f.guard.checkRecovery(agent)).allowed, true); f.guard.clear(agent);
  assert.equal(f.guard.failureFor(agent), null); await f.dispatch(agent); assert.equal(f.providerCalls, 1);
});

test('duplicate turn notifications retain previous dispatch proof and copied Agents cannot inherit diagnostics', async t => {
  const f = fixture(t), agent = f.add('turn-proof'); await f.dispatch(agent);
  f.turn(agent, 1); f.turn(agent, 1);
  f.emit('tools/result', { agent, name: 'compress' }, { isError: true });
  assert.equal(f.guard.failureFor(agent).providerStarted, true);
  const copy = { ...agent, session: { ...agent.session, header: { ...agent.session.header } } };
  assert.equal(f.guard.failureFor(copy), null);
  f.agents.set(agent.id, copy); assert.equal(f.guard.failureFor(copy), null); assert.equal(f.guard.failureFor(agent), null);
});

test('the real finish-chunk context-window code pauses main dispatch while retaining already reported usage', async t => {
  const f = fixture(t), agent = f.add('provider-capacity');
  await f.dispatch(agent, receipt(19, finish('error', { code: 'CONTEXT_WINDOW_EXCEEDED' })));
  assert.equal(f.guard.failureFor(agent)?.code, 'CONTEXT_CAPACITY_REQUIRED');
  assert.equal(f.budget.snapshot().requests[0].settledTokens, 19);
  const count = f.events.length;
  await assert.rejects(f.dispatch(agent), { code: 'CONTEXT_CAPACITY_REQUIRED' });
  assert.equal(f.events.length, count); assert.equal(f.providerCalls, 1);
});
