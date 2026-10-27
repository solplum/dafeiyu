import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../packages/companion/src/brain.js';
import { normalizeOpenAiTokenUsage } from '../packages/dsh-dafeiyu/src/legacy-token-meter.js';

const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
const replyInput = { key: 'private:owner', sessionId: 'legacy-fixture', userId: 'owner', text: 'synthetic private task', record: false };
const answer = (extra = {}) => ({ choices: [{ message: { content: 'fixture answer' } }], ...extra });
const response = (data, { ok = true, status = 200 } = {}) => ({ ok, status, text: async () => JSON.stringify(data) });
function brain(options = {}) {
  return new Brain({ apiKey: 'fixture-secret', baseUrl: 'https://model.fixture.invalid/v1', model: 'fixture-model', ownerIds: ['owner'],
    role: { build: () => 'synthetic private role' }, memory: { renderPerson: () => '', renderRecent: () => '' }, ...options });
}
function mockFetch(t, fetch) {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = fetch;
}

test('OpenAI cached prompt and reasoning are disjointly normalized without double charging', () => {
  assert.deepEqual(normalizeOpenAiTokenUsage({ ...usage, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 2 } }),
    { inputTokens: 4, outputTokens: 3, cacheReadTokens: 8, cacheWriteTokens: 0, totalTokens: 15, reasoningTokens: 2 });
  assert.deepEqual(normalizeOpenAiTokenUsage({ prompt_tokens: 12, completion_tokens: 3 }),
    { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 });
});

test('DeepSeek cache misses are uncached input, never cache writes', () => {
  const raw = { ...usage, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 4 };
  assert.deepEqual(normalizeOpenAiTokenUsage(raw),
    { inputTokens: 4, outputTokens: 3, cacheReadTokens: 8, cacheWriteTokens: 0, totalTokens: 15 });
  assert.deepEqual(normalizeOpenAiTokenUsage({ ...raw, prompt_tokens_details: { cached_tokens: 8 } }), normalizeOpenAiTokenUsage(raw));
  assert.equal(normalizeOpenAiTokenUsage({ ...raw, prompt_tokens_details: { cached_tokens: 7 } }), null);
  assert.equal(normalizeOpenAiTokenUsage({ ...raw, prompt_cache_miss_tokens: 5 }), null);
});

test('cache-only positive usage is evidence; all-zero or invalid usage remains unknown', () => {
  assert.deepEqual(normalizeOpenAiTokenUsage({ prompt_tokens: 8, completion_tokens: 0, prompt_cache_hit_tokens: 8 }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 8, cacheWriteTokens: 0, totalTokens: 8 });
  for (const raw of [undefined, null, [], {}, { prompt_tokens: 1 }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    { ...usage, prompt_tokens: -1 }, { ...usage, completion_tokens: 0.5 }, { ...usage, prompt_tokens: '12' },
    { ...usage, total_tokens: 14 }, { ...usage, total_tokens: undefined }, { ...usage, total_tokens: NaN },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }, { ...usage, prompt_tokens_details: null },
    { ...usage, prompt_tokens_details: { cached_tokens: undefined } }, { ...usage, prompt_cache_hit_tokens: 13 },
    { ...usage, prompt_cache_hit_tokens: -1 }, { ...usage, prompt_cache_miss_tokens: 2 },
    { ...usage, completion_tokens_details: [] }, { ...usage, completion_tokens_details: { reasoning_tokens: 4 } },
    { ...usage, completion_tokens_details: { reasoning_tokens: undefined } }]) {
    assert.equal(normalizeOpenAiTokenUsage(raw), null);
  }
});

test('normalizer only returns token metadata and does not retain provider payload or costs', () => {
  const raw = { ...usage, cost: 100, messages: [{ content: 'private' }], secret: 'private', prompt_tokens_details: { cached_tokens: 4, content: 'private' } };
  const before = JSON.stringify(raw);
  assert.deepEqual(normalizeOpenAiTokenUsage(raw), { inputTokens: 8, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0, totalTokens: 15 });
  assert.equal(JSON.stringify(raw), before);
});

test('Brain wraps exactly one actual HTTP request per tool round with no prompt or secret in input', async (t) => {
  const tool = { type: 'function', function: { name: 'fixture_read', parameters: { type: 'object', additionalProperties: false } } };
  const requests = [], wrapped = [], settled = [], tools = [];
  mockFetch(t, async (url, options) => {
    requests.push({ url, options });
    const round = requests.length;
    return response(round < 3 ? { usage: { ...usage, prompt_tokens: 12 + round, total_tokens: 15 + round },
      choices: [{ message: { content: '', tool_calls: [{ id: 'call-' + round, type: 'function', function: { name: 'fixture_read', arguments: '{}' } }] } }] }
      : answer({ usage }));
  });
  const b = brain({ toolRegistry: { definitions: () => [tool], execute: async (...args) => { tools.push(args); return { ok: true }; } },
    wrapModelRequest: async ({ input, execute }) => {
      wrapped.push({ input, execute });
      assert.equal(Object.isFrozen(input), true);
      assert.deepEqual(Object.keys(input).sort(), ['isGroup', 'isOwner', 'key', 'model', 'platform', 'sessionId', 'signal', 'userId']);
      assert.equal(input.sessionId, replyInput.sessionId);
      assert.equal(input.model, 'fixture-model');
      assert.equal(input.isOwner, true);
      const data = await execute();
      settled.push(data);
      return data;
    } });
  const result = await b.reply(replyInput);
  assert.equal(result.text, 'fixture answer');
  assert.equal(result.raw, settled[2]);
  assert.equal(wrapped.length, 3);
  assert.equal(new Set(wrapped.map((entry) => entry.execute)).size, 3);
  assert.equal(requests.length, 3);
  assert.equal(tools.length, 2);
  assert.deepEqual(settled.map((data) => normalizeOpenAiTokenUsage(data.usage).totalTokens), [16, 17, 15]);
  assert.equal(JSON.parse(requests[0].options.body).messages.some((message) => message.content === replyInput.text), true);
});

test('Brain exposes raw error-response usage to the wrapper once without changing the failure', async (t) => {
  let calls = 0, caught;
  mockFetch(t, async () => { calls++; return response({ error: { message: 'fixture rejection' }, usage }, { ok: false, status: 429 }); });
  const b = brain({ wrapModelRequest: async ({ execute }) => {
    try { return await execute(); } catch (error) { caught = error; throw error; }
  } });
  await assert.rejects(b.reply(replyInput), (error) => {
    assert.equal(error, caught);
    assert.match(error.message, /^模型返回 429：/);
    assert.deepEqual(error.rawUsage, usage);
    assert.equal(Object.keys(error).includes('rawUsage'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('network failure remains the same error and a wrapper cannot execute that request twice', async (t) => {
  const reason = new Error('fixture network failure');
  let calls = 0, wrapped = 0;
  mockFetch(t, async () => { calls++; throw reason; });
  const b = brain({ wrapModelRequest: async ({ execute }) => {
    wrapped++;
    try { return await execute(); } catch (error) {
      assert.equal(error, reason);
      assert.equal(error.rawUsage, undefined);
      await assert.rejects(execute(), /禁止重复执行/);
      throw error;
    }
  } });
  await assert.rejects(b.reply(replyInput), (error) => error === reason);
  assert.equal(calls, 1);
  assert.equal(wrapped, 1);
});

test('cancellation reaches the same single request and wrapper, without retry or a fake zero', async (t) => {
  const controller = new AbortController(), reason = new Error('fixture cancel');
  let entered, observed, calls = 0, wrapped = 0;
  const started = new Promise((resolve) => { entered = resolve; });
  const done = new Promise((resolve) => { observed = resolve; });
  mockFetch(t, async (_url, options) => {
    calls++;
    assert.equal(options.signal.aborted, false);
    entered();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const b = brain({ wrapModelRequest: async ({ input, execute }) => {
    wrapped++;
    try { return await execute(); } catch (error) {
      assert.equal(input.signal.aborted, true);
      assert.equal(error, reason);
      assert.equal(normalizeOpenAiTokenUsage(error.rawUsage), null);
      observed();
      throw error;
    }
  } });
  const pending = b.reply({ ...replyInput, signal: controller.signal });
  await started;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  await done;
  assert.equal(calls, 1);
  assert.equal(wrapped, 1);
});

test('cancellation while the accounting wrapper admits a request prevents a late HTTP dispatch', async (t) => {
  const controller = new AbortController(), reason = new Error('fixture cancel before dispatch');
  let entered, release, observed, calls = 0;
  const started = new Promise((resolve) => { entered = resolve; });
  const admit = new Promise((resolve) => { release = resolve; });
  const done = new Promise((resolve) => { observed = resolve; });
  mockFetch(t, async () => { calls++; throw new Error('must not reach fetch'); });
  const b = brain({ wrapModelRequest: async ({ execute }) => {
    entered();
    await admit;
    try { return await execute(); } catch (error) { observed(); throw error; }
  } });
  const pending = b.reply({ ...replyInput, signal: controller.signal });
  await started;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  release();
  await done;
  assert.equal(calls, 0);
});

test('accounting refusal stops before the HTTP request', async (t) => {
  const refused = new Error('fixture accounting unavailable');
  let calls = 0;
  mockFetch(t, async () => { calls++; throw new Error('must not reach fetch'); });
  const b = brain({ wrapModelRequest: async () => { throw refused; } });
  await assert.rejects(b.reply(replyInput), (error) => error === refused);
  assert.equal(calls, 0);
});

test('no wrapper preserves the existing request body, reply and HTTP error behavior', async (t) => {
  let calls = 0;
  mockFetch(t, async (url, options) => {
    calls++;
    assert.equal(url, 'https://model.fixture.invalid/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer fixture-secret');
    assert.deepEqual(JSON.parse(options.body), { model: 'fixture-model', messages: [
      { role: 'system', content: 'synthetic private role' }, { role: 'user', content: replyInput.text }
    ], temperature: 1.1, stream: false });
    return calls === 1 ? response(answer({ usage })) : response({ error: 'fixture', usage }, { ok: false, status: 500 });
  });
  const b = brain();
  assert.equal((await b.reply(replyInput)).raw.usage.total_tokens, 15);
  await assert.rejects(b.reply(replyInput), (error) => {
    assert.match(error.message, /^模型返回 500：/);
    assert.equal(Object.hasOwn(error, 'rawUsage'), false);
    return true;
  });
  assert.equal(calls, 2);
});
