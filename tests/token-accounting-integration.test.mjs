import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LifeStore } from '../packages/dsh-dafeiyu/src/life-store.js';
import { TokenBudget } from '../packages/dsh-dafeiyu/src/token-budget.js';
import { createTokenAccounting, ownerTokenView, tokenPrompt, registerTokenStatusTool } from '../packages/dsh-dafeiyu/src/token-accounting.js';
import { tokenOperation } from '../packages/dsh-dafeiyu/src/token-panel.js';
import { PrivateConfigStore } from '../packages/dsh-dafeiyu/src/config-store.js';
import { ConfigurationPanelController, registerConfigPanel } from '../packages/dsh-dafeiyu/src/config-panel.js';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';
import { buildHostPrompt } from '../packages/dsh-dafeiyu/src/native-context.js';

const yes = () => true, ownerQq = '20002';
const a = { accountId: ownerQq, identityId: 'default' }, b = { accountId: '30003', identityId: 'default' };
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-accounting-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LifeStore({ directory }), budget = new TokenBudget({ store });
  budget.configure({ dailyTokens: 10, monthlyTokens: 50, requestReserveTokens: 10 }, { revision: budget.snapshot().revision, authorize: yes });
  let middleware, open = true;
  const identities = new Map(), tools = new Map();
  const identity = (scope, isOwner = scope.accountId === ownerQq) => ({ isOwner, channel: 'onebot', scope: 'c2c', peerId: scope.accountId,
    accountProfile: { account: { qq: scope.accountId }, identity: { id: scope.identityId } } });
  const ownerAgent = { session: { id: 'owner-session' }, ctx: { get() {} } };
  const guestAgent = { session: { id: 'guest-session' }, ctx: { get() {} } };
  identities.set(ownerAgent, identity(a)); identities.set(guestAgent, identity(b));
  const getExecutionContext = (exec) => identities.get(exec?.agent) || { isOwner: false, scope: '', peerId: '' };
  const ctx = { on(name, callback) { assert.equal(name, 'llm/stream'); middleware = callback; return () => {}; },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } };
  const accounting = createTokenAccounting({ ctx, budget, ownerQq, getExecutionContext, isOpen: () => open });
  t.after(() => accounting.dispose());
  const options = (agent = ownerAgent, patch = {}) => ({ sessionId: agent.session.id, provider: 'fixture-provider', model: 'fixture-model', purpose: 'main', ...patch });
  const stream = (next, opts = options()) => middleware(opts, next);
  return { directory, store, budget, accounting, ownerAgent, guestAgent, identities, identity, getExecutionContext, ctx, tools, options, stream,
    close: () => { open = false; }, isOpen: () => open,
    registerStatus() { return registerTokenStatusTool(ctx, { budget, getExecutionContext, ownerQq, isOpen: () => open }); } };
}
const measured = async function* () {
  yield { type: 'usage', usage: { inputTokens: 46487, outputTokens: 62, cacheReadTokens: 17536, cacheWriteTokens: 0, reasoningTokens: 50 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
};

test('tracking Agents and rendering a token context preview never writes the ledger or invokes a provider', (t) => {
  const f = fixture(t), before = fs.readFileSync(f.store.file), revision = f.budget.snapshot().revision;
  f.accounting.trackAgent(f.ownerAgent); f.accounting.trackAgent(f.ownerAgent); f.accounting.trackAgent(f.guestAgent);
  const context = tokenPrompt(f.budget, f.getExecutionContext({ agent: f.ownerAgent }), ownerQq);
  assert.match(context, /用户.*不扣你的零花/); assert.equal(f.accounting.active, 0);
  assert.equal(f.budget.resolveBinding(f.ownerAgent.session.id), null, 'context assembly only stages metadata');
  assert.equal(tokenPrompt(f.budget, f.getExecutionContext({ agent: f.guestAgent }), ownerQq), '');
  assert.deepEqual(fs.readFileSync(f.store.file), before); assert.equal(f.budget.snapshot().revision, revision);
});

test('the real accounting middleware and shared LifeStore settle cache buckets as user work without charging her allowance', async (t) => {
  const f = fixture(t); f.accounting.trackAgent(f.ownerAgent); let calls = 0;
  const next = async function* () { calls++; yield* measured(); };
  await collect(f.stream(next));
  const s = f.budget.snapshot(); assert.equal(calls, 1); assert.equal(f.accounting.active, 0);
  assert.equal(s.requests.length, 1); assert.equal(s.requests[0].origin, 'user-task'); assert.equal(s.requests[0].settledTokens, 64085);
  assert.equal(s.today.userTaskTokens, 64085); assert.equal(s.today.autonomyTokens, 0);
  assert.equal(s.balanceTokens, 50); assert.equal(s.dailyRemainingTokens, 10);
  assert.equal(s.requests[0].freeTokens, 0); assert.equal(s.requests[0].pocketTokens, 0);
  assert.equal(s.transactions[0].kind, 'user-task');
});

test('an untracked DSH stream passes through unchanged even if the companion ledger is corrupted', async (t) => {
  const f = fixture(t); fs.writeFileSync(f.store.file, '{PRIVATE_BROKEN_LEDGER');
  const chunks = [{ type: 'text-delta', text: 'unrelated host stream' }, { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }];
  let calls = 0;
  const result = await collect(f.stream(async function* () { calls++; yield* chunks; }, { ...f.options(), sessionId: 'not-managed-by-companion' }));
  assert.equal(calls, 1); assert.equal(result[0], chunks[0]); assert.equal(result[1], chunks[1]);
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), '{PRIVATE_BROKEN_LEDGER');
});

test('revoked ownership rejects a previously bound session before its next provider call', async (t) => {
  const f = fixture(t); f.accounting.trackAgent(f.ownerAgent); await collect(f.stream(measured));
  let calls = 0; f.identities.set(f.ownerAgent, { isOwner: false, scope: '', peerId: '' });
  const before = f.budget.snapshot().requests.length;
  await assert.rejects(() => collect(f.stream(async function* () { calls++; yield* measured(); })));
  assert.equal(calls, 0); assert.equal(f.budget.snapshot().requests.length, before);
});

test('closing authority rejects a fresh staged dispatch but late actual usage after admitted cancellation still settles', async (t) => {
  const f = fixture(t); f.accounting.trackAgent(f.ownerAgent); const controller = new AbortController(); let calls = 0;
  const iterator = f.stream(async function* () {
    calls++; yield { type: 'text-delta', text: 'provider already began' };
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'aborted' } };
  }, f.options(f.ownerAgent, { signal: controller.signal }))[Symbol.asyncIterator]();
  await iterator.next(); assert.equal(f.accounting.active, 1);
  controller.abort(); f.close(); f.identities.set(f.ownerAgent, { isOwner: false, scope: '', peerId: '' });
  while (!(await iterator.next()).done) { /* Already consumed tokens remain facts. */ }
  const s = f.budget.snapshot(); assert.equal(s.requests[0].status, 'cancelled'); assert.equal(s.requests[0].settledTokens, 10);
  assert.equal(s.balanceTokens, 50); assert.equal(f.accounting.active, 0); assert.equal(calls, 1);
  await assert.rejects(() => collect(f.stream(async function* () { calls++; yield* measured(); })));
  assert.equal(calls, 1);
});

test('owner token views expose shared resources but only that account identity requests and transactions', async (t) => {
  const f = fixture(t); f.accounting.trackAgent(f.ownerAgent); f.accounting.trackAgent(f.guestAgent);
  await collect(f.stream(measured)); await collect(f.stream(measured, f.options(f.guestAgent)));
  const view = ownerTokenView(f.budget, a);
  assert.equal(view.sharedBudgetVisible, true); assert.equal(view.balanceTokens, 50); assert.equal(view.policy.dailyTokens, 10);
  assert.equal(view.requests.length, 1); assert.deepEqual(view.requests[0].scope, a);
  assert.equal(view.transactions.length, 1); assert.equal(view.today.userTaskTokens, 64085);
  assert.equal(JSON.stringify(view).includes('guest-session'), false);
  assert.equal(f.budget.snapshot().requests.length, 2);
});

test('the read-only Token tool refuses guests, copied session objects and cancelled owners', async (t) => {
  const f = fixture(t); f.registerStatus(); const tool = f.tools.get('dafeiyu_token_status');
  assert(tool); assert.deepEqual(tool.parameters.properties, {}); assert.equal(tool.parameters.additionalProperties, false);
  const before = fs.readFileSync(f.store.file);
  assert.throws(() => tool.execute({}, { agent: f.guestAgent }), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
  assert.throws(() => tool.execute({}, { agent: { session: { id: f.ownerAgent.session.id } } }), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
  const controller = new AbortController(); controller.abort();
  assert.throws(() => tool.execute({}, { agent: f.ownerAgent, signal: controller.signal }), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
  const result = tool.execute({}, { agent: f.ownerAgent }); assert.equal(result.origin, 'user-task');
  assert.deepEqual(fs.readFileSync(f.store.file), before);
});

test('external CLI success or failure without authoritative usage remains unknown and never charges her', async (t) => {
  for (const fail of [false, true]) {
    const f = fixture(t); let calls = 0;
    const invoke = () => f.accounting.runExternal('codex', { id: 'external-job-1', parent: f.ownerAgent,
      scope: { peerId: a.accountId, identityId: a.identityId } }, async () => { calls++; if (fail) throw new Error('PRIVATE_CLI_BODY'); return { ok: true }; });
    if (fail) await assert.rejects(invoke, /PRIVATE_CLI_BODY/); else assert.deepEqual(await invoke(), { ok: true });
    const s = f.budget.snapshot(); assert.equal(calls, 1); assert.equal(s.requests[0].origin, 'user-task');
    assert.equal(s.requests[0].status, 'unknown'); assert.equal(s.requests[0].usage, null); assert.equal(s.requests[0].settledTokens, null);
    assert.equal(s.balanceTokens, 50); assert.equal(s.reservedTokens, 0); assert.equal(s.unmeteredCount, 1);
    assert.doesNotMatch(JSON.stringify(s), /PRIVATE/);
  }
});

test('external CLI rejects cross-scope and guest calls before binding, writing or invoking it', async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.store.file); let calls = 0;
  const controller = new AbortController(); controller.abort();
  for (const input of [
    { id: 'job-1', parent: f.ownerAgent, scope: { peerId: b.accountId, identityId: b.identityId } },
    { id: 'job-2', parent: f.ownerAgent, scope: { peerId: a.accountId, identityId: 'other' } },
    { id: 'job-3', parent: f.guestAgent, scope: { peerId: b.accountId, identityId: b.identityId } },
    { id: 'job-cancelled', parent: f.ownerAgent, scope: { peerId: a.accountId, identityId: a.identityId }, signal: controller.signal },
  ]) await assert.rejects(() => f.accounting.runExternal('minimax', input, async () => { calls++; }), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
  assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.store.file), before);
});

test('external task dispatch is once-only while active and after an unknown result across accounting reloads', async t => {
  const f = fixture(t); let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const input = { id: 'external-once-only', parent: f.ownerAgent, scope: { peerId: a.accountId, identityId: a.identityId } };
  const first = f.accounting.runExternal('codex', input, async () => { calls++; await gate; return { ok: true }; });
  const active = fs.readFileSync(f.store.file);
  try {
    await assert.rejects(() => f.accounting.runExternal('codex', input, async () => { calls++; }), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
    assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(f.store.file), active);
  } finally { release(); await first; }
  f.accounting.dispose();
  const reloadedBudget = new TokenBudget({ store: new LifeStore({ directory: f.directory }) });
  reloadedBudget.recoverStartup({ authorize: yes });
  const reloaded = createTokenAccounting({ ctx: { on() { return () => {}; } }, budget: reloadedBudget,
    ownerQq, getExecutionContext: f.getExecutionContext });
  t.after(() => reloaded.dispose());
  const before = fs.readFileSync(f.store.file);
  await assert.rejects(() => reloaded.runExternal('codex', input, async () => { calls++; }), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
  assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(f.store.file), before);
  assert.equal(reloadedBudget.snapshot().requests.length, 1); assert.equal(reloadedBudget.snapshot().requests[0].status, 'unknown');
});

test('external unknown receipts from the earlier random-ID format cannot replay after startup recovery', async t => {
  const f = fixture(t), sessionId = 'dafeiyu-external:codex:old-format-job';
  const meta = { sessionId, scope: a, origin: 'user-task', userTaskId: 'old-format-job',
    requestId: 'previous-random-provider-request', provider: 'external-codex', model: 'unreported', purpose: 'main' };
  f.budget.bindSession(sessionId, { scope: a, origin: 'user-task', userTaskId: meta.userTaskId }, { authorize: yes });
  f.budget.observe({ ...meta, status: 'started' }, { authorize: yes });
  assert.equal(f.budget.recoverStartup({ authorize: yes }).result.recovered, 1);
  const before = fs.readFileSync(f.store.file); let calls = 0;
  for (const executor of ['codex', 'minimax']) await assert.rejects(() => f.accounting.runExternal(executor,
    { id: 'old-format-job', parent: f.ownerAgent, scope: { peerId: a.accountId, identityId: a.identityId } },
    async () => { calls++; }), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
  assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.store.file), before);
  assert.equal(f.budget.snapshot().requests[0].requestId, meta.requestId);
  f.budget.acknowledgeUnknown(meta.requestId, { authorize: yes, confirmedStopped: true, acknowledgedUnmetered: true });
  const acknowledged = fs.readFileSync(f.store.file);
  await assert.rejects(() => f.accounting.runExternal('minimax', { id: 'old-format-job', parent: f.ownerAgent,
    scope: { peerId: a.accountId, identityId: a.identityId } }, async () => { calls++; }), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
  assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.store.file), acknowledged, 'acknowledgement releases accounting holds, not dispatch proof');
});

function panelFixture(t) {
  const f = fixture(t), configFile = path.join(f.directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ownerQq, onebotSelfId: '10001' }));
  const config = new PrivateConfigStore({ configFile });
  let runtime = { tokenBudget: f.budget, tokenAccounting: f.accounting }, peer = { principal: { kind: 'owner' }, signal: new AbortController().signal };
  const controller = new ConfigurationPanelController({ store: config, getRuntime: () => runtime,
    getAppliedRevision: () => config.snapshot().revision, getApplying: () => false, getRuntimeError: () => false, paths: () => ({ configFile }) });
  const routes = new Map(), cleanup = [];
  registerConfigPanel({ inject(_names, callback) {
    callback({ get: (name) => name === 'connection' ? { admit: () => ({ peer }) } : { register({ path, handler }) {
      routes.set(path, handler); return () => routes.delete(path); } }, effect(effect) { const dispose = effect(); if (typeof dispose === 'function') cleanup.push(dispose); } });
    return { dispose: async () => {} };
  } }, controller);
  t.after(() => cleanup.reverse().forEach((dispose) => dispose()));
  return { ...f, controller, get runtime() { return runtime; }, setRuntime: (value) => { runtime = value; }, setPeer: (value) => { peer = value; },
    call(endpoint, { method = 'GET', body, chunks, query = '' } = {}) {
      const req = Readable.from(chunks || (body === undefined ? [] : [JSON.stringify(body)]));
      req.method = method; req.url = '/dafeiyu-panel/api/' + endpoint + query; req.headers = { 'content-type': 'application/json' };
      return new Promise((resolve, reject) => {
        const res = { writeHead(status) { this.status = status; }, end(value) { try { resolve({ status: this.status, body: JSON.parse(String(value)) }); } catch (error) { reject(error); } } };
        routes.get('/dafeiyu-panel/api/' + endpoint)(req, res);
      });
    } };
}

test('real Token panel routes keep GET passive, enforce owner/CAS and deduplicate owner awards with the same UUID', async (t) => {
  const f = panelFixture(t), before = fs.readFileSync(f.store.file);
  const status = await f.call('tokens/status'); assert.equal(status.status, 200); assert.equal(status.body.tokens.balanceTokens, 50);
  assert.deepEqual(fs.readFileSync(f.store.file), before);
  const revision = status.body.tokens.revision;
  const first = await f.call('tokens/bonus', { method: 'POST', body: { revision, requestId: 'bonus-uuid-1', tokens: 7 } });
  assert.equal(first.status, 200); assert.equal(first.body.tokens.balanceTokens, 57);
  const stale = await f.call('tokens/config', { method: 'POST', body: { revision, patch: { dailyTokens: 20 } } });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'CONFLICT');
  const repeated = await f.call('tokens/bonus', { method: 'POST', body: { revision: first.body.tokens.revision, requestId: 'bonus-uuid-1', tokens: 7 } });
  assert.equal(repeated.status, 200); assert.equal(repeated.body.tokens.balanceTokens, 57);
  f.setPeer({ principal: { kind: 'api' } });
  assert.equal((await f.call('tokens/status')).status, 403);
  assert.equal((await f.call('tokens/bonus', { method: 'POST', body: { revision: repeated.body.tokens.revision, requestId: 'bonus-uuid-2', tokens: 8 } })).status, 403);
  assert.equal(f.budget.snapshot().balanceTokens, 57);
});

test('Token route slow bodies cannot write after owner revocation or runtime replacement', async (t) => {
  const f = panelFixture(t), before = fs.readFileSync(f.store.file), revision = f.budget.snapshot().revision;
  async function* swapped() { yield '{"revision":"' + revision + '",'; f.setRuntime({ ...f.runtime }); yield '"patch":{"dailyTokens":20}}'; }
  const replaced = await f.call('tokens/config', { method: 'POST', chunks: swapped() });
  assert([403, 409].includes(replaced.status)); assert.deepEqual(fs.readFileSync(f.store.file), before);
  async function* revoked() { yield '{"revision":"' + revision + '",'; f.setPeer({ principal: { kind: 'api' } }); yield '"requestId":"bonus-uuid","tokens":4}'; }
  const denied = await f.call('tokens/bonus', { method: 'POST', chunks: revoked() });
  assert.equal(denied.status, 403); assert.deepEqual(fs.readFileSync(f.store.file), before);
});

test('Token panel rejects active accounting mutations and forged status scope filters without touching storage', async (t) => {
  const f = panelFixture(t), before = fs.readFileSync(f.store.file);
  assert.equal((await f.call('tokens/status', { query: '?accountId=30003' })).status, 400);
  f.setRuntime({ ...f.runtime, tokenAccounting: { active: 1 } });
  const response = await f.call('tokens/config', { method: 'POST', body: { revision: f.budget.snapshot().revision, patch: { dailyTokens: 20 } } });
  assert.equal(response.status, 409); assert.equal(response.body.code, 'BUSY');
  assert.deepEqual(fs.readFileSync(f.store.file), before);
  assert.throws(() => tokenOperation(() => f.runtime, 'status', {}, { runtime: {}, authorize: yes }), { code: 'FORBIDDEN' });
});

for (const maxChars of [512, 1024, 4096]) test('custom owner cards retain rice and truthful Token cognition in a ' + maxChars + '-character real prompt', (t) => {
  const f = fixture(t), memory = new MemoryBridge({ projectRoot: f.directory, ownerQq });
  const card = 'CUSTOM_CARD_CANARY：只聊月亮。'.repeat(300);
  const role = { maxChars, read: () => card, build: () => card };
  const prompt = buildHostPrompt(memory, { agent: f.ownerAgent }, { ownerQq, role, trustedDesktopSessionIds: [f.ownerAgent.session.id],
    tokenContext: tokenPrompt(f.budget, f.getExecutionContext({ agent: f.ownerAgent }), ownerQq), environmentNote: 'OPTIONAL_ENVIRONMENT'.repeat(1000) });
  assert.ok(prompt.length <= maxChars); assert.match(prompt, /CUSTOM_CARD_CANARY/);
  assert.match(prompt, /大米饭/); assert.match(prompt, /Token/); assert.match(prompt, /用户交办算用户/); assert.match(prompt, /自主先免扣再零花Token/);
});
