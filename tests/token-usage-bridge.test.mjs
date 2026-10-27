import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenUsageBridge } from '../packages/dsh-dafeiyu/src/token-usage-bridge.js';

const binding = () => ({ scope: { accountId: '100', identityId: 'default' }, origin: 'autonomy', activityId: 'auto-fixture' });
const request = (patch = {}) => Object.freeze({ sessionId: 'owned-session', provider: 'fixture-provider', model: 'fixture-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE_PROMPT' }] }], ...patch });
const usage = (patch = {}) => ({ type: 'usage', usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 10, reasoningTokens: 2, ...patch } });
const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind } });
const collect = async (stream) => { const values = []; for await (const value of stream) values.push(value); return values; };
function fixture(t, overrides = {}) {
  const events = [], listeners = new Set(); let current, sequence = 0, unregisters = 0;
  const ctx = { on(name, listener, options) {
    assert.equal(name, 'llm/stream'); assert.deepEqual(options, { global: true });
    current = listener; listeners.add(listener); return () => { listeners.delete(listener); unregisters++; };
  } };
  const bridge = createTokenUsageBridge({ ctx, resolveBinding: () => binding(), onEvent: event => events.push(event),
    now: () => 1792886400000, idFactory: () => 'request-' + ++sequence, ...overrides });
  t.after(() => bridge.dispose());
  return { ctx, bridge, events, call: (options, next) => current(options, next),
    get listeners() { return listeners.size; }, get unregisters() { return unregisters; } };
}

test('unbound sessions pass through unchanged without starting a token account', async t => {
  const f = fixture(t, { resolveBinding: () => null }), chunks = [usage(), finish()]; let nextCalls = 0;
  const output = await collect(f.call(request(), () => { nextCalls++; return chunks; }));
  assert.equal(nextCalls, 1); assert.deepEqual(f.events, []);
  assert.equal(output[0], chunks[0]); assert.equal(output[1], chunks[1]);
});

test('ownership resolves at iteration and started persistence completes before calling the provider', async t => {
  let current = null, release; const gate = new Promise(resolve => { release = resolve; });
  const events = []; const f = fixture(t, { resolveBinding: () => current,
    onEvent: async event => { events.push(event); if (event.status === 'started') await gate; } });
  let nextCalls = 0;
  const stream = f.call(request(), () => { nextCalls++; return [usage(), finish()]; });
  current = binding(); const pending = collect(stream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events[0].status, 'started'); assert.equal(nextCalls, 0);
  release(); await pending; assert.equal(nextCalls, 1);
  assert.equal(events.at(-1).status, 'completed');
});

test('cumulative usage is replaced, repeated samples are ignored and original chunks keep their order and identity', async t => {
  const f = fixture(t), first = usage(), duplicate = usage(), last = usage({ outputTokens: 7, totalTokens: 37 });
  const text = { type: 'text-delta', index: 0, text: 'PRIVATE_OUTPUT' }, end = finish('tool-calls');
  const chunks = [text, first, duplicate, last, end];
  const output = await collect(f.call(request(), () => chunks));
  assert.equal(output.length, chunks.length); chunks.forEach((chunk, index) => assert.equal(output[index], chunk));
  assert.deepEqual(f.events.map(event => event.status), ['started', 'usage', 'usage', 'completed']);
  assert.deepEqual(f.events.at(-1).usage, last.usage);
  assert.equal(f.events.at(-1).finishReason, 'tool-calls');
  assert.equal(f.events.at(-1).usage.inputTokens, 20); assert.equal(f.events.at(-1).usage.outputTokens, 7);
  assert.equal(f.events.at(-1).usage.reasoningTokens, 2);
  assert.equal(JSON.stringify(f.events).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(f.events).includes('messages'), false);
});

test('separate invocations reuse no request ID even when they use the same frozen options object', async t => {
  const f = fixture(t), options = request();
  for (let i = 0; i < 2; i++) await collect(f.call(options, () => [usage(), finish()]));
  const starts = f.events.filter(event => event.status === 'started');
  assert.notEqual(starts[0].requestId, starts[1].requestId);
  assert.deepEqual(starts.map(event => event.scope), [binding().scope, binding().scope]);
  assert.equal(starts[0].activityId, 'auto-fixture'); assert.equal(starts[0].workId, 'auto-fixture');
});

test('user tasks, compaction and titles retain trusted work ownership and bounded metadata', async t => {
  const f = fixture(t, { resolveBinding: () => ({ scope: binding().scope, origin: 'user-task', userTaskId: 'task-1', secret: 'PRIVATE_BINDING' }) });
  for (const purpose of [undefined, 'compaction', 'session-title'])
    await collect(f.call(request({ purpose }), () => [usage(), finish('max-tokens')]));
  assert.deepEqual(f.events.filter(event => event.status === 'started').map(event => event.purpose), ['main', 'compaction', 'session-title']);
  for (const event of f.events) {
    assert.equal(event.userTaskId, 'task-1'); assert.equal(event.workId, 'task-1'); assert.equal(event.activityId, undefined);
    assert.equal(event.provider, 'fixture-provider'); assert.equal(event.model, 'fixture-model');
    assert.equal(event.secret, undefined);
  }
});

test('refused started persistence prevents a provider call and emits no invented zero-usage terminal', async t => {
  const events = [], f = fixture(t, { onEvent: event => { events.push(event); throw new Error('storage refused'); } });
  await assert.rejects(collect(f.call(request(), () => assert.fail('provider must not start'))), /storage refused/);
  assert.deepEqual(events.map(event => event.status), ['started']); assert.equal(events[0].usage, undefined);
});

test('an explicitly disallowed reservation result prevents dispatch even when storage does not throw', async t => {
  for (const refusal of [{ allowed: false }, { ok: true, result: { allowed: false } }]) {
    const events = [], f = fixture(t, { onEvent: event => { events.push(event); return refusal; } });
    await assert.rejects(collect(f.call(request(), () => assert.fail('budget refused'))), { code: 'USAGE_START_REJECTED' });
    assert.deepEqual(events.map(event => event.status), ['started']);
  }
});

test('model failure and cancellation still report the last actual provider usage without error text', async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(collect(f.call(request(), () => (async function* () {
    yield usage(); throw new Error('PRIVATE_PROVIDER_FAILURE');
  })())), /PRIVATE_PROVIDER_FAILURE/);
  assert.equal(f.events.at(-1).status, 'failed'); assert.deepEqual(f.events.at(-1).usage, usage().usage);
  await collect(f.call(request({ signal: controller.signal }), () => (async function* () {
    yield usage(); controller.abort(); yield finish('aborted');
  })()));
  assert.equal(f.events.at(-1).status, 'cancelled'); assert.equal(f.events.at(-1).usage.outputTokens, 3);
  assert.equal(JSON.stringify(f.events).includes('PRIVATE_PROVIDER_FAILURE'), false);
});

test('missing provider usage is unknown for completion, empty streams, failure and cancellation', async t => {
  const f = fixture(t), controller = new AbortController();
  await collect(f.call(request(), () => [finish()]));
  assert.equal(f.events.at(-1).status, 'unknown'); assert.equal(f.events.at(-1).usage, undefined);
  await collect(f.call(request(), () => []));
  assert.equal(f.events.at(-1).status, 'unknown'); assert.equal(f.events.at(-1).finishReason, 'stream-ended');
  await assert.rejects(collect(f.call(request(), () => { throw new Error('no stream'); })));
  assert.equal(f.events.at(-1).status, 'unknown'); assert.equal(f.events.at(-1).usage, undefined);
  const beforeCancelledDispatch = f.events.length;
  controller.abort();
  await assert.rejects(collect(f.call(request({ signal: controller.signal }), () => assert.fail('already cancelled'))));
  assert.equal(f.events.length, beforeCancelledDispatch, 'known pre-dispatch cancellation must not mint an unknown reservation');
  const afterDispatch = new AbortController();
  await collect(f.call(request({ signal: afterDispatch.signal }), () => (async function* () {
    afterDispatch.abort(); yield finish('aborted');
  })()));
  assert.equal(f.events.at(-1).status, 'unknown'); assert.equal(f.events.at(-1).finishReason, 'aborted');
  assert.equal(f.events.at(-1).usage, undefined, 'after provider dispatch, missing usage remains unknown');
});

test('consumer early-close settles once with actual sampled usage and closes the upstream iterator', async t => {
  const f = fixture(t); let upstreamClosed = 0;
  const stream = f.call(request(), () => (async function* () {
    try { yield usage(); yield finish(); } finally { upstreamClosed++; }
  })());
  await stream.next(); await stream.return(); await stream.return();
  assert.equal(upstreamClosed, 1);
  assert.deepEqual(f.events.map(event => event.status), ['started', 'usage', 'cancelled']);
  assert.equal(f.events.at(-1).usage.outputTokens, 3);
});

test('late usage and finish chunks remain observable but cannot change or duplicate settled accounting', async t => {
  const f = fixture(t), chunks = [usage(), finish(), usage({ outputTokens: 999 }), finish('error')];
  const output = await collect(f.call(request(), () => chunks));
  output.forEach((chunk, index) => assert.equal(chunk, chunks[index]));
  assert.deepEqual(f.events.map(event => event.status), ['started', 'usage', 'completed']);
  assert.equal(f.events.at(-1).usage.outputTokens, 3); assert.equal(f.events.at(-1).finishReason, 'stop');
});

test('invalid usage never fabricates zero; whitelisted provider fields are copied instead of retaining mutable input', async t => {
  const f = fixture(t), chunk = usage({ cost: 'PRIVATE_PRICE', outputTokens: -1 });
  await collect(f.call(request(), () => [chunk, finish()]));
  assert.equal(f.events.at(-1).status, 'unknown'); assert.equal(f.events.at(-1).usage, undefined);
  const original = usage({ cost: 'PRIVATE_PRICE' });
  const stream = f.call(request(), () => [original, finish()]);
  await stream.next(); original.usage.outputTokens = 10000; await stream.next(); await stream.next();
  assert.equal(f.events.at(-1).usage.outputTokens, 3); assert.equal(f.events.at(-1).usage.cost, undefined);
  assert.equal(JSON.stringify(f.events).includes('PRIVATE_PRICE'), false);
});

test('terminal storage refusal is reported once and never triggers another model request or terminal event', async t => {
  const events = [], f = fixture(t, { onEvent: event => { events.push(event); if (event.status === 'completed') throw Error('terminal write failed'); } });
  let calls = 0;
  await assert.rejects(collect(f.call(request(), () => { calls++; return [usage(), finish()]; })), /terminal write failed/);
  assert.equal(calls, 1); assert.deepEqual(events.map(event => event.status), ['started', 'usage', 'completed']);
});

test('invalid ownership fails closed and account changes cannot rewrite a request already in progress', async t => {
  let owner = binding(); const f = fixture(t, { resolveBinding: () => owner });
  const stream = f.call(request(), () => [usage(), finish()]);
  await stream.next(); owner.scope.accountId = '999'; await stream.next(); await stream.next();
  assert.equal(f.events.at(-1).scope.accountId, '100');
  owner = { ...binding(), origin: 'untrusted' };
  await assert.rejects(collect(f.call(request(), () => assert.fail('invalid origin'))), { code: 'INVALID_USAGE_BINDING' });
});

test('dispose unregisters once, drains already-started accounting and blocks a prebuilt owned stream from starting', async t => {
  const f = fixture(t);
  assert.throws(() => createTokenUsageBridge({ ctx: f.ctx, resolveBinding: binding, onEvent() {} }), { code: 'USAGE_BRIDGE_ALREADY_REGISTERED' });
  const active = f.call(request(), () => [usage(), finish()]);
  await active.next();
  const notStarted = f.call(request(), () => assert.fail('disposed bridge must not dispatch'));
  f.bridge.dispose(); f.bridge.dispose();
  assert.equal(f.listeners, 0); assert.equal(f.unregisters, 1);
  await active.next(); await active.next(); assert.equal(f.events.at(-1).status, 'completed');
  await assert.rejects(collect(notStarted), { code: 'USAGE_BRIDGE_CLOSED' });
  assert.equal(f.events.filter(event => event.status === 'started').length, 1);
  const replacement = createTokenUsageBridge({ ctx: f.ctx, resolveBinding: () => null, onEvent() {} });
  replacement.dispose(); assert.equal(f.listeners, 0);
});

test('all-zero host usage is unknown with or without generated text and never emits a zero consumption sample', async t => {
  for (const text of [false, true]) {
    const f = fixture(t), zero = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    const chunks = [...(text ? [{ type: 'text-delta', index: 0, text: 'PRIVATE_GENERATED_TEXT' }] : []), zero, finish()];
    const output = await collect(f.call(request(), () => chunks));
    output.forEach((chunk, index) => assert.equal(chunk, chunks[index]));
    assert.deepEqual(f.events.map(event => event.status), ['started', 'unknown']);
    assert.equal(f.events.at(-1).usage, undefined);
  }
});

test('a later positive sample resolves an initial ambiguous zero but a final zero keeps prior positive usage partial', async t => {
  const zero = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
  const corrected = fixture(t);
  await collect(corrected.call(request(), () => [zero, usage(), finish()]));
  assert.deepEqual(corrected.events.map(event => event.status), ['started', 'usage', 'completed']);
  assert.deepEqual(corrected.events.at(-1).usage, usage().usage);
  const partial = fixture(t);
  await collect(partial.call(request(), () => [usage(), zero, finish()]));
  assert.deepEqual(partial.events.map(event => event.status), ['started', 'usage', 'unknown']);
  assert.deepEqual(partial.events.at(-1).usage, usage().usage);
});

test('positive cache-only traffic is metered without adding reasoning as a second output bucket', async t => {
  for (const counts of [{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 12 },
    { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 9, totalTokens: 9 }]) {
    const f = fixture(t);
    await collect(f.call(request(), () => [{ type: 'usage', usage: counts }, finish()]));
    assert.equal(f.events.at(-1).status, 'completed'); assert.deepEqual(f.events.at(-1).usage, counts);
  }
  const f = fixture(t);
  await collect(f.call(request(), () => [{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 7 } }, finish()]));
  assert.deepEqual(f.events.map(event => event.status), ['started', 'unknown']);
});

test('contradictory or invalid provider totals stay unknown and cannot erase earlier positive usage', async t => {
  const badSamples = [
    ...['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(key => ({ inputTokens: 0, outputTokens: 0, [key]: 2, totalTokens: 0 })),
    ...[-1, undefined, null, NaN, Infinity, 2.5, '30', 19].map(totalTokens => ({ inputTokens: 20, outputTokens: 3, totalTokens })),
  ];
  for (const bad of badSamples) {
    const f = fixture(t), chunk = { type: 'usage', usage: bad };
    const output = await collect(f.call(request(), () => [usage(), chunk, finish()]));
    assert.equal(output[1], chunk);
    assert.deepEqual(f.events.map(event => event.status), ['started', 'usage', 'unknown']);
    assert.deepEqual(f.events.at(-1).usage, usage().usage);
    const fresh = fixture(t);
    await collect(fresh.call(request(), () => [chunk, finish()]));
    assert.deepEqual(fresh.events.map(event => event.status), ['started', 'unknown']);
    assert.equal(fresh.events.at(-1).usage, undefined);
  }
});

test('a corrected positive provider total clears invalid evidence while valid overlapping totals keep their authority', async t => {
  const f = fixture(t), valid = usage({ totalTokens: 20 });
  await collect(f.call(request(), () => [usage({ totalTokens: 0 }), valid, finish()]));
  assert.deepEqual(f.events.map(event => event.status), ['started', 'usage', 'completed']);
  assert.deepEqual(f.events.at(-1).usage, valid.usage);
  assert.equal(f.events.at(-1).usage.totalTokens, 20, 'do not force an aggregate to equal or exceed the bucket sum');
});
