import test from 'node:test';
import assert from 'node:assert/strict';
import { modelTestFixture } from './helpers/model-test-fixture.mjs';
import { createModelTestRunner } from '../packages/dsh-dafeiyu/src/model-test-runner.js';
const yes = () => true, request = { provider: 'fixture', model: 'model' };
const usage = { inputTokens: 21, outputTokens: 3, totalTokens: 24 };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function llmFixture(events = [{ type: 'text-delta', text: 'OK' }, { type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }]) {
  const calls = [], preparations = [];
  const llm = { async prepareCall(config, signal, configure) {
    preparations.push(config); const controls = configure({ maxTokens: config.maxTokens }, {});
    return { config: { ...config, ...controls }, stream(options) { calls.push(options); return { async *[Symbol.asyncIterator]() { for (const row of events) yield row; } }; } };
  } };
  return { llm, calls, preparations };
}
test('fixed owner test uses a real isolated registry agent, complete capacity guard and actual user-task usage', async t => {
  const native = llmFixture(), f = modelTestFixture({ llm: native.llm }); t.after(() => f.cleanup());
  const before = f.budget.snapshot(), result = await f.runner.run(request, { authorize: yes });
  assert.equal(result.visible, true); assert.equal(result.terminal, 'stop');
  assert.deepEqual(result.accounting, { origin: 'user-task', state: 'measured', totalTokens: 24 });
  assert.equal(native.calls.length, 1); assert.equal(f.creations.length, 1); assert.equal(f.registry.size, 0);
  assert.deepEqual(f.restrictions, [{ allow: [] }]); assert.match(f.guards[0]({ name: 'anything' }), /不允许/);
  assert.deepEqual(native.calls[0].messages, [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }]);
  assert.deepEqual(native.calls[0].tools, []); assert.match(native.calls[0].sessionId, /^dafeiyu-model-test:/); assert.equal(native.calls[0].maxTokens, 16);
  const after = f.budget.snapshot(); assert.equal(after.requests.length, 1); assert.equal(after.requests[0].settledTokens, 24);
  assert.equal(after.requests[0].origin, 'user-task'); assert.equal(after.balanceTokens, before.balanceTokens); assert.equal(after.dailyRemainingTokens, before.dailyRemainingTokens);
  assert.equal(f.runner.busy, false); assert.equal(f.runner.blocked, false);
});
test('unknown usage is retained and a second new diagnostic cannot clear it or invent zero', async t => {
  for (const value of [undefined, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }]) {
    const native = llmFixture([{ type: 'text-delta', text: 'OK' }, ...(value ? [{ type: 'usage', usage: value }] : []), { type: 'finish', reason: { kind: 'stop' } }]);
    const f = modelTestFixture({ llm: native.llm }); t.after(() => f.cleanup());
    const result = await f.runner.run(request, { authorize: yes });
    assert.deepEqual(result.accounting, { origin: 'user-task', state: 'unknown' });
    assert.equal(f.budget.snapshot().requests[0].status, 'unknown'); assert.equal(f.runner.blocked, true);
    await assert.rejects(f.runner.run(request, { authorize: yes }), { code: 'MODEL_TEST_UNCONFIRMED' }); assert.equal(native.calls.length, 1);
  }
});
test('the existing explicit owner usage acknowledgement permits only a new test and preserves the unknown original', async t => {
  const events = [{ type: 'text-delta', text: 'OK' }, { type: 'finish', reason: { kind: 'stop' } }];
  const native = llmFixture(events), f = modelTestFixture({ llm: native.llm }); t.after(() => f.cleanup());
  await f.runner.run(request, { authorize: yes });
  const first = f.budget.snapshot().requests[0];
  f.budget.acknowledgeUnknown(first.requestId, { confirmedStopped: true, acknowledgedUnmetered: true, revision: f.budget.snapshot().revision, authorize: yes });
  assert.equal(f.runner.blocked, false);
  events.splice(1, 0, { type: 'usage', usage });
  const fresh = await f.runner.run(request, { authorize: yes }); assert.equal(fresh.accounting.totalTokens, 24);
  const rows = f.budget.snapshot().requests, original = rows.find(row => row.requestId === first.requestId), next = rows.find(row => row.requestId !== first.requestId);
  assert.equal(rows.length, 2); assert.equal(original.status, 'unknown'); assert.equal(original.unmetered, true); assert.equal(original.acknowledgedUnmetered, true);
  assert.notEqual(next.sessionId, first.sessionId); assert.equal(native.calls.length, 2);
});
test('capacity refusal, arbitrary input, missing owner and changed identity prevent provider dispatch', async t => {
  const native = llmFixture(), f = modelTestFixture({ llm: native.llm, contextWindow: 1 }); t.after(() => f.cleanup());
  await assert.rejects(f.runner.run({ ...request, messages: [] }, { authorize: yes }), { code: 'INVALID_PATCH' });
  await assert.rejects(f.runner.run(request, { authorize: () => false }), { code: 'FORBIDDEN' });
  await assert.rejects(f.runner.run(request, { authorize: yes }), { code: 'CONTEXT_CAPACITY_REQUIRED' });
  assert.equal(native.calls.length, 0); assert.equal(f.budget.snapshot().requests.length, 0); assert.equal(f.runner.blocked, false);
  const changed = llmFixture(), prepare = changed.llm.prepareCall;
  const g = modelTestFixture({ llm: changed.llm }); t.after(() => g.cleanup());
  changed.llm.prepareCall = async (...args) => { const result = await prepare(...args); g.setScope({ accountId: '30003', identityId: 'default' }); return result; };
  await assert.rejects(g.runner.run(request, { authorize: yes }), { code: 'FORBIDDEN' }); assert.equal(changed.calls.length, 0);
});
test('timeout keeps the actual pending preparation occupied until it exits, then never dispatches it', async t => {
  const native = llmFixture(), wait = gate(), prepare = native.llm.prepareCall;
  native.llm.prepareCall = async (...args) => { await wait.promise; return prepare(...args); };
  const f = modelTestFixture({ llm: native.llm, timeoutMs: 5 }); t.after(() => f.cleanup());
  await assert.rejects(f.runner.run(request, { authorize: yes }), { code: 'PANEL_CONNECTION_TIMEOUT' }); assert.equal(f.runner.busy, true);
  await assert.rejects(f.runner.run(request, { authorize: yes }), { code: 'MODEL_TEST_BUSY' });
  wait.resolve(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(native.calls.length, 0); assert.equal(f.runner.busy, false); assert.equal(f.runner.blocked, false);
});
test('failed real agent cleanup retains the durable unretired binding, including after a new runner is constructed', async t => {
  const native = llmFixture(), f = modelTestFixture({ llm: native.llm, disposeAgent: async () => { throw Error('fixture disposal uncertain'); } }); t.after(() => f.cleanup());
  await assert.rejects(f.runner.run(request, { authorize: yes }), { code: 'MODEL_TEST_UNCONFIRMED' });
  assert.equal(f.runner.busy, true); assert.equal(f.runner.blocked, true); assert.equal(f.budget.read().state.tokenBudget.sessions[0].retiredAt, null);
  await assert.rejects(f.runner.run(request, { authorize: yes }), { code: 'MODEL_TEST_BUSY' }); assert.equal(native.calls.length, 1);
  const reloaded = createModelTestRunner({ ctx: f.ctx, tokenBudget: f.executionBudget, getScope: () => ({ accountId: '20002', identityId: 'default' }) });
  await assert.rejects(reloaded.run(request, { authorize: yes }), { code: 'MODEL_TEST_UNCONFIRMED' }); assert.equal(native.calls.length, 1);
  await reloaded.dispose();
});

test('late actual usage after the HTTP timeout remains a cancelled user task while the original stream owns occupancy', async t => {
  const wait = gate(), calls = [];
  const llm = { async prepareCall(config) { return { config, stream(options) { calls.push(options); return { async *[Symbol.asyncIterator]() {
    await wait.promise; yield { type: 'usage', usage }; yield { type: 'finish', reason: { kind: 'stop' } };
  } }; } }; } };
  const f = modelTestFixture({ llm, timeoutMs: 5 }); t.after(() => f.cleanup());
  await assert.rejects(f.runner.run(request, { authorize: yes }), { code: 'PANEL_CONNECTION_TIMEOUT' });
  assert.equal(f.runner.busy, true); assert.equal(f.budget.snapshot().requests[0].status, 'started');
  await assert.rejects(f.runner.run(request, { authorize: yes }), { code: 'MODEL_TEST_BUSY' });
  wait.resolve(); await new Promise(resolve => setTimeout(resolve, 30));
  const row = f.budget.snapshot().requests[0]; assert.equal(row.status, 'cancelled'); assert.equal(row.settledTokens, 24);
  assert.equal(row.origin, 'user-task'); assert.equal(f.runner.busy, false); assert.equal(calls.length, 1);
});
