import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';
import { NativeCompanionTools } from '../packages/dsh-dafeiyu/src/native-companion-tools.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-term-memory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bridge = new MemoryBridge({ projectRoot: directory, ownerQq: '20002' });
  return { bridge, directory };
}
const context = { accountId: '20002', identityId: 'a' };
const yes = () => true;

test('relevant long-term entry takes priority over unrelated facts under the existing prompt budget', (t) => {
  const { bridge } = fixture(t);
  bridge.remember({ key: 'old-topic', summary: '旧项目资料', detail: 'OLD_RELEVANT_TARGET ' + '旧项目的有效资料。'.repeat(180) });
  for (let i = 0; i < 12; i++) bridge.remember({ key: 'unrelated-' + i, summary: '其他资料 ' + i, detail: '无关内容'.repeat(60) });
  const prompt = bridge.buildSystemPrompt('', { isOwner: true, query: 'OLD_RELEVANT_TARGET', maxChars: 4096 });
  assert.ok(prompt.length <= 4096);
  assert.ok(prompt.includes('OLD_RELEVANT_TARGET'));
  assert.match(prompt, /dafeiyu_memory_index/);
});

test('long-term directory pages metadata while full content is read by stable ID and revision', (t) => {
  const { bridge } = fixture(t);
  const detail = '开头'.repeat(250) + ' PostgreSQL database 项目数据库 ' + '结尾'.repeat(250);
  const first = bridge.remember({ summary: '项目数据库', detail, scope: 'identity' }, { context, actor: 'tool' });
  for (let i = 0; i < 23; i++) bridge.remember({ key: 'topic-' + i, summary: '资料 ' + i, detail: '独立正文 ' + i });
  const before = fs.readFileSync(bridge.factsPath);
  const index = bridge.indexMemories('database POSTGRESQL', { memoryContext: context, maxChars: 1600 });
  assert.equal(index.total, 1);
  assert.equal(index.matches[0].id, first.recordId);
  assert.equal(index.matches[0].detail, undefined);
  assert.equal(index.matches[0].history, undefined);
  assert.ok(index.matches[0].excerpt.includes('PostgreSQL'));
  assert.ok(JSON.stringify(index.matches).length <= 1600);
  const pages = [0, 10, 20].map(offset => bridge.indexMemories('', { memoryContext: context, offset, limit: 10 }));
  assert.equal(new Set(pages.flatMap(page => page.matches.map(row => row.id))).size, 24);
  assert.equal(pages[0].nextOffset, 10); assert.equal(pages[2].nextOffset, null);
  let offset = 0, body = '';
  do {
    const page = bridge.readMemory(first.recordId, { revision: index.revision, memoryContext: context, offset, maxChars: 300 });
    body += page.record.detail; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(body, detail);
  assert.deepEqual(fs.readFileSync(bridge.factsPath), before, 'directory and body reads must not write or reinforce');
});

test('cached long-term index follows correction, forgetting, restoration and deletion and rejects stale reads', (t) => {
  const { bridge } = fixture(t);
  bridge.remember({ key: 'drink', summary: '饮品', detail: 'OLD_COFFEE_CANARY' });
  const old = bridge.indexMemories('OLD_COFFEE_CANARY');
  const id = old.matches[0].id;
  const fixed = bridge.correct({ id, revision: old.revision, summary: '饮品', detail: 'NEW_TEA_CANARY' }, { authorize: yes });
  assert.equal(bridge.indexMemories('OLD_COFFEE_CANARY').total, 0);
  assert.equal(bridge.indexMemories('NEW_TEA_CANARY').total, 1);
  assert.throws(() => bridge.readMemory(id, { revision: old.revision }), { code: 'CONFLICT' });
  const forgotten = bridge.forget({ id, revision: fixed.revision }, { authorize: yes });
  assert.equal(bridge.indexMemories('NEW_TEA_CANARY').total, 0);
  assert.throws(() => bridge.readMemory(id, { revision: forgotten.revision }), { code: 'NOT_FOUND' });
  const restored = bridge.restore({ id, revision: forgotten.revision }, { authorize: yes });
  assert.equal(bridge.indexMemories('NEW_TEA_CANARY').total, 1);
  bridge.delete({ id, revision: restored.revision }, { authorize: yes });
  assert.equal(bridge.indexMemories('NEW_TEA_CANARY').total, 0);
  assert.throws(() => bridge.readMemory(id, { revision: bridge.snapshot().revision }), { code: 'NOT_FOUND' });
});

test('scope filtering precedes index construction and cached reads never bypass a broken source', (t) => {
  const { bridge } = fixture(t);
  bridge.remember({ summary: '共同事项', detail: 'COMMON_PROJECT' });
  const a = bridge.remember({ summary: 'A', detail: 'IDENTITY_A_PRIVATE', scope: 'identity' }, { context, actor: 'tool' });
  bridge.remember({ summary: 'B', detail: 'IDENTITY_B_PRIVATE', scope: 'identity' }, { context: { identityId: 'b' }, actor: 'tool' });
  const own = bridge.indexMemories('', { memoryContext: context });
  assert.equal(own.total, 2); assert.doesNotMatch(JSON.stringify(own), /IDENTITY_B_PRIVATE/);
  assert.equal(bridge.indexMemories('PRIVATE', { memoryContext: { accountId: 'other', identityId: 'a' } }).total, 0);
  assert.throws(() => bridge.readMemory(a.recordId, { revision: own.revision, memoryContext: { accountId: '20002', identityId: 'b' } }), { code: 'NOT_FOUND' });
  const file = bridge.factsPath, bytes = fs.readFileSync(file);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => bridge.indexMemories('COMMON_PROJECT'), { code: 'INVALID_MEMORY' });
  assert.throws(() => bridge.readMemory(a.recordId, { revision: own.revision, memoryContext: context }), { code: 'INVALID_MEMORY' });
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(bridge.memoryDir, '.memory-delete.pending'), 'pending');
  assert.throws(() => bridge.indexMemories('COMMON_PROJECT'), { code: 'DELETE_PENDING' });
});

test('native directory and body tools use actual identity and reject caller-provided account or stale revision', async (t) => {
  const { bridge } = fixture(t);
  const saved = bridge.remember({ summary: '检索题目', detail: 'OWNER_ONLY_BODY' });
  let identity = { isOwner: true, scope: 'desktop', trusted: true, sessionId: 'trusted', accountProfile: { identity: { id: 'a' } } };
  const tools = new Map(), instance = new NativeCompanionTools({ memoryBridge: bridge, memeManager: {}, getExecutionContext: () => identity });
  instance.registerToCordis({ tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } } });
  t.after(() => instance.dispose());
  const index = await tools.get('dafeiyu_memory_index').execute({ query: 'OWNER_ONLY_BODY' }, {});
  assert.equal(index.total, 1); assert.equal(index.matches[0].detail, undefined);
  const read = await tools.get('dafeiyu_memory_read').execute({ id: saved.recordId, revision: index.revision }, {});
  assert.equal(read.record.detail, 'OWNER_ONLY_BODY');
  await assert.rejects(tools.get('dafeiyu_memory_index').execute({ query: 'x', accountId: 'other' }, {}));
  identity = { isOwner: false, scope: 'c2c', peerId: '30003' };
  await assert.rejects(tools.get('dafeiyu_memory_index').execute({ query: 'OWNER_ONLY_BODY' }, {}), /主人/);
  await assert.rejects(tools.get('dafeiyu_memory_read').execute({ id: saved.recordId, revision: index.revision }, {}), /主人/);
});


test('owner clearAll empties facts, archive and events after backing up originals', (t) => {
  const { bridge, directory } = fixture(t);
  bridge.remember({ key: 'tea', summary: '喜欢热茶', detail: '日常喜欢喝热茶。' });
  fs.writeFileSync(path.join(directory, 'memory', 'user.md'), '# 档案\n\n### 主要使用者\n\n主人档案段落。\n', { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'memory', 'timeline.md'), '# 手账\n\n## [2026-10-28] 事件\n\n今天的事。\n', { mode: 0o600 });
  const before = bridge.snapshot({}).items.length;
  assert.ok(before >= 3);
  const result = bridge.clearAll({}, { authorize: yes });
  assert.equal(result.cleared, before);
  const after = bridge.snapshot({});
  assert.equal(after.items.length, 0);
  const files = fs.readdirSync(path.join(directory, 'memory'));
  assert.ok(files.some((name) => name.startsWith('facts.json.bak-')), 'facts backup exists');
  assert.ok(files.some((name) => name.startsWith('user.md.bak-')), 'archive backup exists');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'memory', 'facts.json'), 'utf8')).facts.length, 0);
  // 清空后再记新条目仍然可用
  bridge.remember({ key: 'fresh', summary: '新的记忆', detail: '清空后重新积累。' });
  assert.equal(bridge.snapshot({}).items.length, 1);
});

test('clearAll refuses without owner authorization', (t) => {
  const { bridge } = fixture(t);
  bridge.remember({ key: 'tea', summary: '喜欢热茶', detail: '日常喜欢喝热茶。' });
  assert.throws(() => bridge.clearAll({}, { authorize: () => false }), /主人管理权限/);
  assert.equal(bridge.snapshot({}).items.length, 1);
});
