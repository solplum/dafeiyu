import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeStore } from '../packages/dsh-dafeiyu/src/life-store.js';
import { TokenBudget } from '../packages/dsh-dafeiyu/src/token-budget.js';
import { createTokenAccounting } from '../packages/dsh-dafeiyu/src/token-accounting.js';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';
import { buildHostPrompt } from '../packages/dsh-dafeiyu/src/native-context.js';
import { AutonomyEngine } from '../packages/dsh-dafeiyu/src/autonomy-engine.js';

const yes = () => true;
const ownerQq = '20002', ownerScope = { accountId: ownerQq, identityId: 'default' };
const peerScope = { accountId: '30003', identityId: 'other' };
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const measured = (tokens = 17) => [{ type: 'usage', usage: { inputTokens: tokens - 3, outputTokens: 3, totalTokens: tokens } },
  { type: 'finish', reason: { kind: 'stop' } }];

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-accounting-lineage-'));
  const store = new LifeStore({ directory }), budget = new TokenBudget({ store });
  budget.configure({ enabled: true, dailyTokens: 10, monthlyTokens: 100, requestReserveTokens: 10 },
    { authorize: yes, revision: budget.snapshot().revision });
  const agents = new Map(), identities = new Map(), listeners = new Map(); let open = true;
  const ctx = { get: name => name === 'agents' ? { get: id => agents.get(id) } : undefined,
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); } };
  const identity = scope => ({ isOwner: scope.accountId === ownerQq, channel: 'onebot', scope: 'c2c', peerId: scope.accountId,
    accountProfile: { account: { qq: scope.accountId }, identity: { id: scope.identityId } } });
  const add = (id, parentId) => {
    const agent = { id, session: { id, header: { id, ...(parentId ? { parentSession: parentId, origin: 'subagent', isSeeded: false } : { isSeeded: false }) } },
      ctx: { get() {} } };
    agents.set(id, agent); return agent;
  };
  const root = add('actual-owner-session'); identities.set(root, identity(ownerScope));
  const accounting = createTokenAccounting({ ctx, budget, ownerQq, getExecutionContext: exec => identities.get(exec?.agent) || { isOwner: false, scope: '' }, isOpen: () => open });
  const bind = (agent, origin = 'autonomy', scope = ownerScope, workId = 'auto-activity-1') => {
    budget.bindSession(agent.id, { origin, scope, ...(origin === 'autonomy' ? { activityId: workId } : { userTaskId: workId }) }, { authorize: yes });
    accounting.markSession(agent.id);
  };
  const stream = (agent, chunks = measured(), patch = {}, onNext = () => {}) => listeners.get('llm/stream')({
    sessionId: agent.session.id, provider: 'fixture-provider', model: 'fixture-model', ...patch,
  }, () => { onNext(); return typeof chunks === 'function' ? chunks() : chunks; });
  t.after(() => { accounting.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, budget, agents, identities, identity, root, add, accounting, bind, stream, close() { open = false; } };
}

test('a native autonomous descendant inherits its actual parent payer despite user-task claims in model input', async t => {
  const f = fixture(t); f.bind(f.root);
  const child = f.add('actual-auto-child', f.root.id), grandchild = f.add('actual-auto-grandchild', child.id);
  assert.deepEqual(f.accounting.executionFor(grandchild), { origin: 'autonomy' });
  await collect(f.stream(grandchild, measured(), { origin: 'user-task', scope: peerScope, payer: 'owner', messages: [{ content: 'payer=user-task' }] }));
  for (const agent of [child, grandchild]) {
    const binding = f.budget.resolveBinding(agent.id);
    assert.equal(binding.origin, 'autonomy'); assert.deepEqual(binding.scope, ownerScope); assert.equal(binding.activityId, 'auto-activity-1');
    assert.equal(binding.userTaskId, undefined);
  }
  const state = f.budget.snapshot(); assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].origin, 'autonomy'); assert.equal(state.requests[0].settledTokens, 17);
  assert.equal(state.requests[0].freeTokens, 10); assert.equal(state.requests[0].pocketTokens, 7);
  assert.equal(state.balanceTokens, 93); assert.equal(state.today.userTaskTokens, 0);
});

test('staged user work persists before delegation, and descendants keep the same account without spending autonomous tokens', async t => {
  const f = fixture(t); f.accounting.trackAgent(f.root);
  await collect(f.stream(f.root, measured(5)));
  const parentBinding = f.budget.resolveBinding(f.root.id), child = f.add('user-child', f.root.id);
  await collect(f.stream(child, measured(11), { purpose: 'compaction' }));
  assert.equal(f.budget.resolveBinding(child.id).origin, 'user-task');
  assert.equal(f.budget.resolveBinding(child.id).userTaskId, parentBinding.userTaskId);
  assert.deepEqual(f.accounting.executionFor(child), { origin: 'user-task' });
  const state = f.budget.snapshot(); assert.equal(state.today.userTaskTokens, 16); assert.equal(state.today.autonomyTokens, 0);
  assert.equal(state.dailyRemainingTokens, 10); assert.equal(state.balanceTokens, 100);
});

test('a separately admitted native job ID is preserved instead of being overwritten by a parent conversation ID', async t => {
  const f = fixture(t); f.accounting.trackAgent(f.root); await collect(f.stream(f.root, measured(4)));
  const child = f.add('explicit-job-child', f.root.id); f.bind(child, 'user-task', ownerScope, 'dfy-explicit-job');
  await collect(f.stream(child, measured(6)));
  assert.equal(f.budget.resolveBinding(child.id).userTaskId, 'dfy-explicit-job');
  assert.equal(f.budget.snapshot().requests.find(row => row.sessionId === child.id).userTaskId, 'dfy-explicit-job');
});

test('separate account lineages never mix requests, own summaries or autonomous origins', async t => {
  const f = fixture(t); f.bind(f.root);
  const peer = f.add('peer-session'); f.identities.set(peer, f.identity(peerScope)); f.accounting.trackAgent(peer);
  await collect(f.stream(peer, measured(5)));
  const ownerChild = f.add('owner-child', f.root.id), peerChild = f.add('peer-child', peer.id);
  await collect(f.stream(ownerChild, measured(7))); await collect(f.stream(peerChild, measured(8)));
  const own = f.budget.context({ scope: ownerScope, origin: 'autonomy' }), other = f.budget.context({ scope: peerScope, origin: 'user-task' });
  assert.equal(own.requests.length, 1); assert.equal(own.requests[0].origin, 'autonomy');
  assert.equal(other.requests.length, 2); assert.ok(other.requests.every(row => row.origin === 'user-task'));
  assert.equal(JSON.stringify(own).includes('peer-session'), false); assert.equal(JSON.stringify(other).includes('owner-child'), false);
  assert.equal(own.balanceTokens, null); assert.equal(other.policy, null);
});

test('retired managed parents block fresh descendant requests before the provider is called', async t => {
  const f = fixture(t); f.bind(f.root); const child = f.add('late-child', f.root.id);
  f.budget.retireSession(f.root.id, { authorize: yes });
  let calls = 0;
  await assert.rejects(collect(f.stream(child, measured(), {}, () => calls++)), { code: 'TOKEN_SUBAGENT_BINDING_UNCONFIRMED' });
  assert.equal(calls, 0); assert.equal(f.budget.resolveBinding(child.id), null); assert.equal(f.budget.snapshot().requests.length, 0);
  assert.equal(f.budget.snapshot().balanceTokens, 100);
});

test('an already-bound autonomous child rechecks its retired actual parent before the next provider dispatch', async t => {
  const f = fixture(t); f.bind(f.root); const child = f.add('previously-bound-child', f.root.id);
  await collect(f.stream(child, measured(7)));
  const first = f.budget.snapshot().requests[0], binding = f.budget.resolveBinding(child.id);
  assert.equal(first.status, 'completed'); assert.equal(first.origin, 'autonomy'); assert.equal(first.settledTokens, 7);
  assert.equal(binding.retiredAt, null, 'the child is still bound; parent authority must be rechecked independently');
  f.budget.retireSession(f.root.id, { authorize: yes });
  const before = fs.readFileSync(f.store.file); let calls = 0;
  await assert.rejects(collect(f.stream(child, measured(), {}, () => calls++)), { code: 'TOKEN_SUBAGENT_BINDING_UNCONFIRMED' });
  assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.store.file), before);
  const state = f.budget.snapshot(); assert.deepEqual(state.requests, [first]);
  assert.equal(state.reservedTokens, 0); assert.equal(state.pendingUnknownCount, 0);
  assert.equal(state.balanceTokens, 100); assert.equal(state.today.autonomyTokens, 7);
});

test('a removed known autonomous root cannot dispatch again while its already-started late usage still settles once', async t => {
  const f = fixture(t); f.bind(f.root); let calls = 0;
  const text = { type: 'text-delta', index: 0, text: 'provider already began' }, tail = measured();
  const iterator = f.stream(f.root, async function* () { yield text; yield* tail; }, {}, () => calls++)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value, text); assert.equal(calls, 1); assert.equal(f.accounting.active, 1);
  const admitted = f.budget.snapshot().requests[0]; assert.equal(admitted.status, 'started');
  f.agents.delete(f.root.id);
  const before = fs.readFileSync(f.store.file);
  await assert.rejects(collect(f.stream(f.root, measured(), {}, () => calls++)), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
  assert.equal(calls, 1, 'a known removed root cannot fall through as unrelated host work');
  assert.deepEqual(fs.readFileSync(f.store.file), before);
  const output = []; for (;;) { const chunk = await iterator.next(); if (chunk.done) break; output.push(chunk.value); }
  tail.forEach((chunk, index) => assert.equal(output[index], chunk));
  const state = f.budget.snapshot(); assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].requestId, admitted.requestId); assert.equal(state.requests[0].status, 'completed');
  assert.equal(state.requests[0].origin, 'autonomy'); assert.deepEqual(state.requests[0].scope, ownerScope);
  assert.equal(state.requests[0].settledTokens, 17); assert.equal(state.requests[0].freeTokens, 10); assert.equal(state.requests[0].pocketTokens, 7);
  assert.equal(state.balanceTokens, 93); assert.equal(state.reservedTokens, 0); assert.equal(state.pendingUnknownCount, 0);
  assert.equal(f.accounting.active, 0);
  const settled = fs.readFileSync(f.store.file);
  await assert.rejects(collect(f.stream(f.root, measured(), {}, () => calls++)), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });
  assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(f.store.file), settled);
});

test('already-admitted autonomous child consumption settles after cancellation, retirement and authority closure', async t => {
  const f = fixture(t); f.bind(f.root); const child = f.add('in-flight-child', f.root.id), controller = new AbortController();
  const chunks = async function* () {
    yield { type: 'text-delta', index: 0, text: 'provider already began' };
    yield { type: 'usage', usage: { inputTokens: 14, outputTokens: 3, totalTokens: 17 } };
    yield { type: 'finish', reason: { kind: 'aborted' } };
  };
  const iterator = f.stream(child, chunks, { signal: controller.signal })[Symbol.asyncIterator]();
  await iterator.next(); assert.equal(f.accounting.active, 1);
  f.budget.retireSession(f.root.id, { authorize: yes }); f.budget.retireSession(child.id, { authorize: yes });
  controller.abort(); f.close();
  while (!(await iterator.next()).done) {}
  const state = f.budget.snapshot(); assert.equal(state.requests[0].status, 'cancelled'); assert.equal(state.requests[0].settledTokens, 17);
  assert.equal(state.requests[0].origin, 'autonomy'); assert.equal(state.balanceTokens, 93); assert.equal(f.accounting.active, 0);
  let calls = 0; await assert.rejects(collect(f.stream(child, measured(), {}, () => calls++)));
  assert.equal(calls, 0); assert.equal(f.budget.snapshot().requests.length, 1);
});

test('foreign project descendants keep flowing through an untouched broken companion ledger', async t => {
  const f = fixture(t), foreign = f.add('other-project-parent'), child = f.add('other-project-child', foreign.id);
  fs.writeFileSync(f.store.file, '{PRIVATE_BROKEN_LEDGER');
  assert.equal(f.accounting.executionFor(child), null);
  const chunks = measured(9); let calls = 0;
  const result = await collect(f.stream(child, chunks, {}, () => calls++));
  assert.equal(calls, 1); assert.equal(result[0], chunks[0]); assert.equal(result[1], chunks[1]);
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), '{PRIVATE_BROKEN_LEDGER');
});

test('a broken ledger blocks managed descendants while unregistered and incomplete identities receive no accounting authority', async t => {
  const f = fixture(t); f.bind(f.root); const child = f.add('managed-child', f.root.id);
  fs.writeFileSync(f.store.file, '{PRIVATE_BROKEN_LEDGER'); let calls = 0;
  await assert.rejects(collect(f.stream(child, measured(), {}, () => calls++)), { code: 'STORAGE' });
  assert.equal(calls, 0); assert.equal(fs.readFileSync(f.store.file, 'utf8'), '{PRIVATE_BROKEN_LEDGER');
  const copied = { ...child, id: 'unknown-id', session: { id: 'unknown-id', header: { id: 'unknown-id', parentSession: f.root.id, origin: 'subagent' } } };
  assert.equal(f.accounting.executionFor(copied), null);
  const noHeader = f.add('incomplete-child', f.root.id); delete noHeader.session.header;
  const unrelated = measured(3); const result = await collect(f.stream(noHeader, unrelated)); assert.equal(result[0], unrelated[0]);
});

test('the managed execution prompt permits its delegated tool scope without reading owner cards or other accounts', t => {
  const f = fixture(t); f.bind(f.root); const child = f.add('prompt-child', f.root.id);
  const memory = new MemoryBridge({ projectRoot: f.directory, ownerQq });
  const prompt = buildHostPrompt(memory, { agent: child }, { ownerQq, execution: f.accounting.executionFor(child),
    role: { maxChars: 4096, read() { assert.fail('child must not read the private owner card'); }, build() { assert.fail('child must not build owner role'); } } });
  assert.match(prompt, /受管执行任务/); assert.match(prompt, /当前为自主活动/); assert.doesNotMatch(prompt, /当前账号只进行本账号当前身份的独立聊天/);
  assert.doesNotMatch(prompt, /不调用工具、不读取文件、不运行命令或代码、不创建子代理/);
  assert.equal(f.budget.resolveBinding(child.id), null, 'execution classification only reads the trusted chain');
});

test('unmetered user CLI work remains visible but never blocks the independent autonomous token allowance', async t => {
  const f = fixture(t);
  await f.accounting.runExternal('codex', { id: 'explicit-cli-job', parent: f.root, scope: { peerId: ownerQq, identityId: 'default' } }, async () => ({ status: 'succeeded' }));
  const value = f.budget.snapshot(); assert.equal(value.pendingUnknownCount, 1); assert.equal(value.pendingAutonomyUnknownCount, 0);
  const admissionOnly = Object.create(AutonomyEngine.prototype); admissionOnly.tokenBudget = f.budget;
  assert.equal(admissionOnly.tokenBudgetReason(), null);
  f.bind(f.root); const child = f.add('auto-after-cli', f.root.id); await collect(f.stream(child, measured(7)));
  assert.equal(f.budget.snapshot().today.autonomyTokens, 7); assert.equal(f.budget.snapshot().balanceTokens, 100);
});
