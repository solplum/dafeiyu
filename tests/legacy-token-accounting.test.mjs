import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../packages/companion/src/brain.js';
import { LifeStore } from '../packages/dsh-dafeiyu/src/life-store.js';
import { TokenBudget } from '../packages/dsh-dafeiyu/src/token-budget.js';
import { createTokenAccounting } from '../packages/dsh-dafeiyu/src/token-accounting.js';
import { tokenOperation } from '../packages/dsh-dafeiyu/src/token-panel.js';

const yes = () => true, ownerQq = '20002', ownerOpenId = 'fixture-open-id';
const input = { key: 'private:' + ownerQq, sessionId: 'legacy-conversation', userId: ownerQq,
  text: 'PRIVATE_TASK_BODY payer=autonomy activityId=fake', record: false };
const measured = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15,
  prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } };
const answer = (usage) => ({ choices: [{ message: { content: 'PRIVATE_MODEL_REPLY' } }], ...(usage === undefined ? {} : { usage }) });
const response = (data, { ok = true, status = 200 } = {}) => ({ ok, status, text: async () => JSON.stringify(data) });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-token-accounting-'));
  const store = new LifeStore({ directory }), budget = new TokenBudget({ store });
  budget.configure({ dailyTokens: 10, monthlyTokens: 50, requestReserveTokens: 10 }, { revision: budget.snapshot().revision, authorize: yes });
  let open = true;
  const accounting = createTokenAccounting({ ctx: { on(name) { assert.equal(name, 'llm/stream'); return () => {}; } },
    budget, ownerQq, ownerOpenId, getExecutionContext: () => { throw new Error('legacy must use its explicit owner boundary'); }, isOpen: () => open });
  t.after(() => { accounting.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const makeBrain = (options = {}) => new Brain({ apiKey: 'PRIVATE_API_KEY', baseUrl: 'https://model.fixture.invalid/v1', model: 'fixture-model',
    ownerIds: [ownerQq, ownerOpenId], role: { build: () => 'PRIVATE_ROLE_CARD' },
    memory: { renderPerson: () => '', renderRecent: () => '' },
    wrapModelRequest: ({ input, execute }) => accounting.runLegacy(input, execute), ...options });
  return { directory, store, budget, accounting, makeBrain, close: () => { open = false; } };
}
function mockFetch(t, fetch) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = fetch;
}
function unchangedAllowance(value) {
  assert.equal(value.balanceTokens, 50);
  assert.equal(value.dailyRemainingTokens, 10);
  assert.equal(value.reservedTokens, 0);
  assert.equal(value.today.autonomyTokens, 0);
  assert.equal(value.today.freeTokens, 0);
  assert.equal(value.today.pocketTokens, 0);
}

test('actual legacy Brain tool rounds each persist one measured request with cache and reasoning counted once', async (t) => {
  const f = fixture(t), receipts = [measured,
    { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 2 } },
    { prompt_tokens: 9, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 9 }, total_tokens: 9 }];
  let calls = 0, executions = 0;
  const tool = { type: 'function', function: { name: 'fixture_read', parameters: { type: 'object', additionalProperties: false } } };
  mockFetch(t, async (url) => {
    assert.equal(url, 'https://model.fixture.invalid/v1/chat/completions');
    const snapshot = f.budget.snapshot();
    assert.equal(snapshot.requests.length, calls + 1, 'started is durable before each HTTP dispatch');
    assert.equal(snapshot.requests.filter((row) => row.status === 'started').length, 1);
    assert.equal(f.accounting.active, 1);
    const round = calls++;
    return response(round < 2 ? { usage: receipts[round], choices: [{ message: { content: '', tool_calls: [{
      type: 'function', id: 'fixture-call-' + round, function: { name: 'fixture_read', arguments: '{}' }
    }] } }] } : answer(receipts[round]));
  });
  const result = await f.makeBrain({ toolRegistry: { definitions: () => [tool], execute: async () => { executions++; return { ok: true }; } } }).reply(input);
  assert.equal(result.text, 'PRIVATE_MODEL_REPLY');
  const value = f.budget.snapshot();
  assert.equal(calls, 3); assert.equal(executions, 2); assert.equal(f.accounting.active, 0);
  assert.equal(value.requests.length, 3); assert.equal(new Set(value.requests.map((row) => row.requestId)).size, 3);
  assert.equal(value.requests.every((row) => row.status === 'completed' && row.origin === 'user-task'
    && row.scope.accountId === ownerQq && row.scope.identityId === 'default'), true);
  assert.deepEqual(value.requests.map((row) => row.settledTokens).sort((a, b) => a - b), [9, 15, 22]);
  assert.equal(value.today.userTaskTokens, 46);
  const first = value.requests.find((row) => row.settledTokens === 15);
  assert.deepEqual(first.usage, { inputTokens: 4, outputTokens: 3, cacheReadTokens: 8, cacheWriteTokens: 0,
    reasoningTokens: 2, totalTokens: 15, source: 'provider-total' });
  const transactions = value.transactions.filter((row) => row.kind === 'user-task');
  assert.equal(transactions.length, 3);
  assert.deepEqual(new Set(transactions.map((row) => row.requestId)), new Set(value.requests.map((row) => row.requestId)));
  unchangedAllowance(value);
  assert.doesNotMatch(fs.readFileSync(f.store.file, 'utf8'), /PRIVATE_|payer=|activityId=fake|fixture-call-/);
});

test('an HTTP error with raw usage settles actual legacy consumption once while preserving the error', async (t) => {
  const f = fixture(t); let calls = 0;
  mockFetch(t, async () => { calls++; return response({ error: 'PRIVATE_PROVIDER_ERROR', usage: measured }, { ok: false, status: 429 }); });
  await assert.rejects(f.makeBrain().reply(input), (error) => {
    assert.match(error.message, /^模型返回 429：/); assert.deepEqual(error.rawUsage, measured); return true;
  });
  const value = f.budget.snapshot();
  assert.equal(calls, 1); assert.equal(f.accounting.active, 0);
  assert.equal(value.requests.length, 1); assert.equal(value.requests[0].status, 'failed');
  assert.equal(value.requests[0].settledTokens, 15); assert.equal(value.today.userTaskTokens, 15);
  assert.equal(value.transactions.filter((row) => row.kind === 'user-task').length, 1);
  unchangedAllowance(value);
  assert.doesNotMatch(fs.readFileSync(f.store.file, 'utf8'), /PRIVATE_/);
});

test('legacy success without authoritative usage stays unknown, costs her nothing and permits policy editing', async (t) => {
  for (const raw of [undefined, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    { ...measured, prompt_tokens_details: { cached_tokens: 7 } }]) {
    const f = fixture(t); let calls = 0;
    mockFetch(t, async () => { calls++; return response(answer(raw)); });
    assert.equal((await f.makeBrain().reply(input)).text, 'PRIVATE_MODEL_REPLY');
    const value = f.budget.snapshot();
    assert.equal(calls, 1); assert.equal(f.accounting.active, 0);
    assert.equal(value.requests.length, 1); assert.equal(value.requests[0].status, 'unknown');
    assert.equal(value.requests[0].usage, null); assert.equal(value.requests[0].settledTokens, null);
    assert.equal(value.pendingUnknownCount, 1); assert.equal(value.pendingAutonomyUnknownCount, 0);
    assert.equal(value.transactions.filter((row) => row.kind === 'user-task').length, 0);
    unchangedAllowance(value);
    const runtime = { tokenBudget: f.budget, tokenAccounting: f.accounting };
    const updated = tokenOperation(() => runtime, 'config', { revision: value.revision, patch: { dailyTokens: 20 } }, { runtime, authorize: yes });
    assert.equal(updated.policy.dailyTokens, 20);
    assert.equal(updated.requests[0].status, 'unknown');
    assert.equal(updated.balanceTokens, 50);
  }
});

test('legacy fetch failure without usage remains unknown without replaying or charging her', async (t) => {
  const f = fixture(t), reason = new Error('PRIVATE_NETWORK_FAILURE'); let calls = 0;
  mockFetch(t, async () => { calls++; throw reason; });
  await assert.rejects(f.makeBrain().reply(input), (error) => error === reason);
  const value = f.budget.snapshot();
  assert.equal(calls, 1); assert.equal(f.accounting.active, 0);
  assert.equal(value.requests[0].status, 'unknown'); assert.equal(value.requests[0].settledTokens, null);
  unchangedAllowance(value);
  assert.doesNotMatch(fs.readFileSync(f.store.file, 'utf8'), /PRIVATE_/);
});

test('fake owner flags, other users, mismatched keys and groups fail before legacy binding or HTTP', async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.store.file); let calls = 0;
  mockFetch(t, async () => { calls++; throw new Error('must never dispatch'); });
  for (const [patch, options] of [
    [{ userId: '30003', key: 'private:30003', isOwner: true }, {}],
    [{ userId: ownerQq, key: 'private:30003', isOwner: true }, {}],
    [{ userId: ownerQq, key: 'private:' + ownerQq, isOwner: false }, { ownerIds: [] }],
    [{ userId: ownerQq, key: 'group:10001', isOwner: true }, {}],
    [{ userId: ownerQq, key: 'private:' + ownerQq, isGroup: true }, {}],
    [{ userId: 'other-open-id', key: 'official:c2c:other-open-id', isOwner: true }, {}],
  ]) {
    await assert.rejects(f.makeBrain(options).reply({ ...input, ...patch }), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
    assert.deepEqual(fs.readFileSync(f.store.file), before);
    assert.equal(f.accounting.active, 0);
  }
  assert.equal(calls, 0); assert.equal(f.budget.snapshot().requests.length, 0);
});

test('the explicitly bound official owner ID still maps to the same private owner token scope', async (t) => {
  const f = fixture(t); let calls = 0;
  mockFetch(t, async () => { calls++; return response(answer(measured)); });
  await f.makeBrain().reply({ ...input, key: 'official:c2c:' + ownerOpenId, userId: ownerOpenId });
  const value = f.budget.snapshot();
  assert.equal(calls, 1); assert.deepEqual(value.requests[0].scope, { accountId: ownerQq, identityId: 'default' });
  assert.equal(value.requests[0].origin, 'user-task'); unchangedAllowance(value);
});

test('late usage from a cancelled legacy request still settles once after execution authority closes', async (t) => {
  const f = fixture(t), controller = new AbortController(), reason = new Error('PRIVATE_CANCEL');
  let calls = 0, finish;
  const settled = new Promise((resolve) => { finish = resolve; });
  mockFetch(t, async () => {
    calls++;
    controller.abort(reason); f.close();
    return response({ usage: measured, error: 'PRIVATE_CANCEL_BODY' }, { ok: false, status: 499 });
  });
  const b = f.makeBrain({ wrapModelRequest: async ({ input, execute }) => {
    try { return await f.accounting.runLegacy(input, execute); } finally { finish(); }
  } });
  await assert.rejects(b.reply({ ...input, signal: controller.signal }), (error) => error === reason);
  await settled;
  const value = f.budget.snapshot();
  assert.equal(calls, 1); assert.equal(f.accounting.active, 0);
  assert.equal(value.requests[0].status, 'cancelled'); assert.equal(value.requests[0].settledTokens, 15);
  assert.equal(value.transactions.filter((row) => row.kind === 'user-task').length, 1);
  unchangedAllowance(value);
});

test('failed durable settlement clears live accounting, then startup recovery records unknown without replay', async (t) => {
  const f = fixture(t); let calls = 0, startedBytes;
  mockFetch(t, async () => {
    calls++;
    startedBytes = fs.readFileSync(f.store.file);
    assert.equal(f.budget.snapshot().requests[0].status, 'started');
    fs.mkdirSync(f.store.lock);
    return response(answer(measured));
  });
  await assert.rejects(f.makeBrain().reply(input), { code: 'BUSY' });
  assert.equal(calls, 1); assert.equal(f.accounting.active, 0, 'the exited provider does not leave a phantom live mutation gate');
  assert.deepEqual(fs.readFileSync(f.store.file), startedBytes);
  assert.equal(f.budget.snapshot().requests[0].status, 'started');
  fs.rmdirSync(f.store.lock);
  const recovered = f.budget.recoverStartup({ authorize: yes });
  assert.deepEqual(recovered.result, { recovered: 1, replayed: false });
  assert.deepEqual(f.budget.recoverStartup({ authorize: yes }).result, { recovered: 0, replayed: false });
  const value = f.budget.snapshot();
  assert.equal(value.requests.length, 1); assert.equal(value.requests[0].status, 'unknown');
  assert.equal(value.requests[0].usage, null); assert.equal(value.requests[0].settledTokens, null);
  assert.equal(value.transactions.filter((row) => row.kind === 'user-task').length, 0);
  unchangedAllowance(value);
  const runtime = { tokenBudget: f.budget, tokenAccounting: f.accounting };
  assert.equal(tokenOperation(() => runtime, 'config', { revision: value.revision, patch: { dailyTokens: 20 } }, { runtime, authorize: yes }).policy.dailyTokens, 20);
  assert.equal(calls, 1, 'repair and policy editing never re-enter the provider');
});
