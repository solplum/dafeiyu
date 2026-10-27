import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { NativeCompanionTools } from '../packages/dsh-dafeiyu/src/native-companion-tools.js';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';
import { experienceTools } from '../packages/dsh-dafeiyu/src/experience-tools.js';
import { TokenBudget } from '../packages/dsh-dafeiyu/src/token-budget.js';

test('additional QQ account can search/correct its own experiences but cannot read owner archives or mutate guessed IDs', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-tools-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lifeMemory = new LifeMemory({ directory: path.join(directory, 'life') }), memoryBridge = new MemoryBridge({ projectRoot: directory, ownerQq: '20002' });
  lifeMemory.configure({ learningEnabled: true }, { authorize: () => true });
  for (const [accountId, messageId, userText] of [['20002', '1', 'OWNER_PRIVATE_CANARY'], ['30003', '2', 'GUEST_OWN_CANARY']])
    lifeMemory.capture({ phase: 'received', selfId: '10001', messageId, userText, scope: { accountId, identityId: 'default' } }, { authorize: () => true });
  memoryBridge.remember({ summary: '主人档案', detail: 'OWNER_ARCHIVE_CANARY' });
  const tools = new Map(), identity = { isOwner: false, channel: 'onebot', scope: 'c2c', peerId: '30003', accountProfile: { account: { qq: '30003' }, identity: { id: 'default' } } };
  const instance = new NativeCompanionTools({ memoryBridge, lifeMemory, memeManager: {}, getExecutionContext: () => identity });
  instance.registerToCordis({ tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } } }); t.after(() => instance.dispose());
  const result = await tools.get('dafeiyu_experience_search').execute({}, {});
  assert.equal(result.total, 1); assert.equal(result.items[0].detail, 'GUEST_OWN_CANARY');
  const own = result.items[0];
  assert.equal((await tools.get('dafeiyu_experience_update').execute({ action: 'correct', id: own.id, revision: result.revision, detail: 'GUEST_CORRECTION_CANARY' }, {})).ok, true);
  const owner = lifeMemory.snapshot({ accountId: '20002' }).items[0];
  const cross = await tools.get('dafeiyu_experience_update').execute({ action: 'delete', id: owner.id, revision: lifeMemory.snapshot().revision }, {});
  assert.equal(cross.ok, false); assert.equal(lifeMemory.snapshot({ accountId: '20002' }).items[0].detail, 'OWNER_PRIVATE_CANARY');
  await assert.rejects(tools.get('dafeiyu_memory_search').execute({ query: 'OWNER_ARCHIVE_CANARY' }, {}), /主人/);
  await assert.rejects(tools.get('dafeiyu_experience_search').execute({ accountId: '20002' }, {}));
});

test('model experience recall skips forgotten pages and never matches details past their visible age', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-recall-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scope = { accountId: '30003', identityId: 'default' }, clock = { value: Date.parse('2026-10-01T00:00:00Z') };
  const memory = new LifeMemory({ directory, now: () => clock.value });
  memory.configure({ learningEnabled: true }, { authorize: () => true });
  const capture = (id, userText) => memory.capture({ phase: 'received', selfId: '10001', messageId: String(id), userText, scope }, { authorize: () => true });
  capture(1, 'Coffee hot SUMMARY_CANARY '.repeat(10) + 'AGED_DETAIL_CANARY');
  for (let id = 2; id <= 13; id++) {
    capture(id, 'FORGOTTEN_CANARY');
    memory.manage('forget', { id: memory.snapshot().items[0].id }, { scope, authorize: () => true });
  }
  clock.value += 10 * 86400000;
  const identity = { isOwner: false, channel: 'onebot', scope: 'c2c', peerId: scope.accountId,
    accountProfile: { account: { qq: scope.accountId }, identity: { id: scope.identityId } } };
  const search = experienceTools({ memory, getExecutionContext: () => identity, owner: '20002', isClosed: () => false })[0];
  const before = fs.readFileSync(memory.store.file), result = await search.execute({}, {});
  assert.equal(result.total, 1); assert.equal(result.items.length, 1); assert.equal(result.items[0].clarity, 'summary');
  assert.doesNotMatch(JSON.stringify(result), /FORGOTTEN_CANARY|AGED_DETAIL_CANARY|history|assistantText/);
  assert.equal((await search.execute({ query: 'AGED_DETAIL_CANARY' }, {})).total, 0);
  assert.equal((await search.execute({ query: 'SUMMARY_CANARY' }, {})).total, 1);
  for (const query of ['Coffee hot', 'coFfee', '  COFFEE\t hot  ']) assert.equal((await search.execute({ query }, {})).total, 1);
  assert.equal((await search.execute({ query: 'Coffee missing' }, {})).total, 0);
  assert.equal((await search.execute({ query: 'coffee AGED_DETAIL_CANARY' }, {})).total, 0);
  assert.equal(memory.snapshot().total, 13); assert.deepEqual(fs.readFileSync(memory.store.file), before);
});

test('experience search pages active scoped matches with a bounded limit and an explicit end cursor', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-pages-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scope = { accountId: '30003', identityId: 'default' }, memory = new LifeMemory({ directory });
  memory.configure({ learningEnabled: true }, { authorize: () => true });
  for (let index = 1; index <= 27; index++) memory.capture({ phase: 'received', selfId: '10001', messageId: String(index),
    userText: 'PAGE_CANARY_' + index, scope }, { authorize: () => true });
  const identity = { isOwner: false, channel: 'onebot', scope: 'c2c', peerId: scope.accountId,
    accountProfile: { account: { qq: scope.accountId }, identity: { id: scope.identityId } } };
  const search = experienceTools({ memory, getExecutionContext: () => identity, owner: '20002', isClosed: () => false })[0];
  const before = fs.readFileSync(memory.store.file), pages = [];
  let offset = 0;
  do {
    const page = await search.execute({ query: 'PAGE_CANARY_', offset, limit: 10 }, {});
    assert.equal(page.total, 27); assert.equal(page.offset, offset); assert.ok(page.items.length <= 10);
    pages.push(...page.items); offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(pages.length, 27); assert.equal(new Set(pages.map(row => row.id)).size, 27);
  assert.equal(pages[0].detail, 'PAGE_CANARY_27'); assert.equal(pages.at(-1).detail, 'PAGE_CANARY_1');
  assert.equal((await search.execute({ offset: 5000, limit: 20 }, {})).nextOffset, null);
  for (const patch of [{ offset: -1 }, { offset: 5001 }, { limit: 0 }, { limit: 21 }])
    await assert.rejects(search.execute(patch, {}), { code: 'INVALID_PATCH' });
  assert.deepEqual(fs.readFileSync(memory.store.file), before);
});

test('scoped recall versions allow ID reading and correction after real ledger writes while preserving Token state', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-scope-cas-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scope = { accountId: '30003', identityId: 'default' }, memory = new LifeMemory({ directory });
  memory.configure({ learningEnabled: true }, { authorize: () => true });
  const body = 'FULL_RECENT_DETAIL '.repeat(100) + 'ID_READ_TAIL_CANARY';
  memory.capture({ phase: 'received', selfId: '10001', messageId: '1', userText: body, scope }, { authorize: () => true });
  const identity = { isOwner: false, channel: 'onebot', scope: 'c2c', peerId: scope.accountId,
    accountProfile: { account: { qq: scope.accountId }, identity: { id: scope.identityId } } };
  const [search, update] = experienceTools({ memory, getExecutionContext: () => identity, owner: '20002', isClosed: () => false });
  const first = await search.execute({}, {}), id = first.items[0].id;
  assert.match(first.recallRevision, /^[a-f0-9]{64}$/); assert.doesNotMatch(first.items[0].detail, /ID_READ_TAIL_CANARY/);
  const budget = new TokenBudget({ store: memory.store });
  budget.bindSession('fixture-token-session', { scope, origin: 'user-task', userTaskId: 'fixture-user-work' }, { authorize: () => true });
  const meta = { requestId: 'fixture-token-request', sessionId: 'fixture-token-session', scope,
    origin: 'user-task', userTaskId: 'fixture-user-work', provider: 'fixture', model: 'fixture', purpose: 'main' };
  budget.observe({ ...meta, status: 'started' }, { authorize: () => true });
  budget.observe({ ...meta, status: 'completed', usage: { totalTokens: 17 } }, { authorize: () => true });
  const tokens = memory.store.read().state.tokenBudget;
  assert.notEqual(memory.snapshot().revision, first.revision);
  const found = await search.execute({ id, recallRevision: first.recallRevision, revision: first.revision }, {});
  assert.equal(found.items.length, 1); assert.equal(found.items[0].detail, body); assert.equal(found.items[0].detailOmitted, false);
  assert.equal(found.recallRevision, first.recallRevision);
  await update.execute({ action: 'correct', id, detail: '用户确认后的新内容', recallRevision: first.recallRevision, revision: first.revision }, {});
  assert.deepEqual(memory.store.read().state.tokenBudget, tokens);
  const current = await search.execute({}, {});
  assert.notEqual(current.recallRevision, first.recallRevision); assert.equal(current.items[0].detail, '用户确认后的新内容');
  await assert.rejects(search.execute({ id, recallRevision: first.recallRevision }, {}), { code: 'CONFLICT' });
  await assert.rejects(update.execute({ action: 'correct', id, detail: '过期请求不能覆盖', recallRevision: first.recallRevision }, {}), { code: 'CONFLICT' });
  await assert.rejects(search.execute({ id }, {}), { code: 'INVALID_PATCH' });
});

test('ID reads respect age projection, inactive state, scope and memory-policy versions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-id-guards-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scope = { accountId: '30003', identityId: 'default' }, clock = { value: Date.parse('2026-10-01T00:00:00Z') };
  const memory = new LifeMemory({ directory, now: () => clock.value });
  memory.configure({ learningEnabled: true }, { authorize: () => true });
  memory.capture({ phase: 'received', selfId: '10001', messageId: '1', userText: 'SUMMARY_PREFIX '.repeat(20) + 'EXPIRED_ID_TAIL', scope }, { authorize: () => true });
  let identity = { isOwner: false, channel: 'onebot', scope: 'c2c', peerId: scope.accountId,
    accountProfile: { account: { qq: scope.accountId }, identity: { id: scope.identityId } } };
  const [search, update] = experienceTools({ memory, getExecutionContext: () => identity, owner: '20002', isClosed: () => false });
  const first = await search.execute({}, {}), id = first.items[0].id;
  clock.value += 10 * 86400000;
  const aged = await search.execute({ id, recallRevision: first.recallRevision }, {});
  assert.equal(aged.items[0].clarity, 'summary'); assert.doesNotMatch(JSON.stringify(aged), /EXPIRED_ID_TAIL/);
  memory.capture({ phase: 'received', selfId: '10001', messageId: '2', userText: 'OTHER_SCOPE_CANARY', scope: { ...scope, identityId: 'other' } }, { authorize: () => true });
  assert.equal((await search.execute({}, {})).recallRevision, first.recallRevision, 'another identity does not invalidate this domain');
  memory.configure({ detailedDays: 4 }, { authorize: () => true });
  await assert.rejects(search.execute({ id, recallRevision: first.recallRevision }, {}), { code: 'CONFLICT' });
  const current = await search.execute({}, {});
  const forgottenResult = await update.execute({ action: 'forget', id, recallRevision: current.recallRevision }, {});
  assert.equal(forgottenResult.result.status, 'inactive'); assert.equal(forgottenResult.result.detail, undefined);
  assert.doesNotMatch(JSON.stringify(forgottenResult), /EXPIRED_ID_TAIL/);
  const forgotten = await search.execute({}, {}); assert.equal(forgotten.total, 0);
  await assert.rejects(search.execute({ id, recallRevision: forgotten.recallRevision }, {}), { code: 'NOT_FOUND' });
  identity = { ...identity, accountProfile: { ...identity.accountProfile, identity: { id: 'other' } } };
  const other = await search.execute({}, {});
  await assert.rejects(search.execute({ id, recallRevision: other.recallRevision }, {}), { code: 'NOT_FOUND' });
});
