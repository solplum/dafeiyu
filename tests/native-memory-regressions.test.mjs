import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';
import { NativeCompanionTools } from '../packages/dsh-dafeiyu/src/native-companion-tools.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stable-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridge = new MemoryBridge({ projectRoot: dir });
  fs.mkdirSync(bridge.memoryDir);
  fs.writeFileSync(bridge.userMdPath, '# 档案\nPRIVATE_ARCHIVE_CANARY');
  return bridge;
}

function registeredTools(bridge, identity = { isOwner: true, scope: 'desktop', trusted: true }) {
  const tools = new Map();
  const native = new NativeCompanionTools({ memoryBridge: bridge, allowMemoryWrites: true,
    memeManager: { listMemes: () => [] }, getExecutionContext: () => identity });
  native.registerToCordis({ tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } });
  return { native, tools };
}

test('remember defaults to stable fact and survives a long event history and reload', (t) => {
  const bridge = fixture(t);
  const saved = bridge.remember({ summary: '饮品偏好', detail: 'PREFERRED_DRINK_CANARY 无糖乌龙茶' });
  assert.equal(saved.kind, 'fact');
  for (let i = 0; i < 8; i++) bridge.remember({ kind: 'event', summary: `事件${i}`, detail: '后来发生的事'.repeat(150) });
  const reloaded = new MemoryBridge({ projectRoot: bridge.projectRoot });
  assert.ok(reloaded.buildSystemPrompt('', { isOwner: true }).includes('PREFERRED_DRINK_CANARY'));
  assert.equal(reloaded.searchMemories('PREFERRED_DRINK_CANARY').matches[0].source, 'memory/facts.json');
  const updated = reloaded.remember({ key: '饮品偏好', summary: '饮品偏好', detail: '改成热水' });
  assert.equal(updated.id, saved.id);
  assert.equal(reloaded.readFacts().length, 1);
  assert.equal(reloaded.searchMemories('PREFERRED_DRINK_CANARY').total, 0);
});

test('search retrieves complete old timeline entries beyond the old prompt tail', (t) => {
  const bridge = fixture(t);
  const old = '\n---\n\n### [2020-01-02] 旧约定\n- **详情**：OLD_EVENT_CANARY 下周一起散步\n';
  fs.writeFileSync(bridge.timelineMdPath, old + '\n---\n\n### [2026-10-22] 新事件\n' + '最新事件'.repeat(1000));
  const result = bridge.searchMemories('OLD_EVENT_CANARY', { kind: 'event' });
  assert.equal(result.total, 1);
  assert.equal(result.matches[0].summary, '旧约定');
  assert.ok(result.matches[0].detail.includes('下周一起散步'));
  assert.equal(result.truncated, false);
});

test('retrieval marks truncated results and keeps the actual matching passage', (t) => {
  const bridge = fixture(t);
  fs.writeFileSync(bridge.timelineMdPath, '\n---\n\n### [2020-01-02] 很长的旧事件\n' + '前文'.repeat(2000) + 'MATCH_NEAR_END_CANARY' + '结尾'.repeat(100));
  const result = bridge.searchMemories('MATCH_NEAR_END_CANARY', { maxChars: 600 });
  assert.equal(result.truncated, true);
  assert.equal(result.matches[0].truncated, true);
  assert.ok(result.matches[0].detail.includes('MATCH_NEAR_END_CANARY'));
});

test('failed reads are explicit and never silently overwrite corrupted facts', (t) => {
  const bridge = fixture(t);
  fs.writeFileSync(bridge.factsPath, '{CORRUPT_CANARY');
  assert.throws(() => bridge.searchMemories('anything'), /共享记忆读取失败/);
  assert.throws(() => bridge.remember({ summary: 'new', detail: 'new' }), /共享记忆读取失败/);
  assert.equal(fs.readFileSync(bridge.factsPath, 'utf8'), '{CORRUPT_CANARY');
  const prompt = bridge.buildSystemPrompt('', { isOwner: true });
  assert.ok(prompt.includes('共享记忆读取失败'));
  assert.ok(!prompt.includes('PRIVATE_ARCHIVE_CANARY'));
  assert.equal(fs.existsSync(bridge.lockPath), false);
  assert.ok(!bridge.buildSystemPrompt('', { isOwner: false }).includes('共享记忆读取失败'));
});

test('shared directory lock rejects concurrent writers without modifying saved facts', (t) => {
  const bridge = fixture(t);
  bridge.remember({ summary: 'existing', detail: 'existing' });
  const before = fs.readFileSync(bridge.factsPath, 'utf8');
  fs.mkdirSync(bridge.lockPath);
  const other = new MemoryBridge({ projectRoot: bridge.projectRoot });
  assert.throws(() => other.remember({ summary: 'other writer', detail: 'other value' }), /正在写入，未保存/);
  assert.equal(fs.readFileSync(bridge.factsPath, 'utf8'), before);
  fs.rmdirSync(bridge.lockPath);
  other.remember({ summary: 'other writer', detail: 'other value' });
  assert.equal(bridge.readFacts().length, 2);
});

test('failed atomic replacement preserves the previous facts and removes temporary files and lock', (t) => {
  const bridge = fixture(t);
  bridge.remember({ summary: 'existing', detail: 'existing' });
  const before = fs.readFileSync(bridge.factsPath, 'utf8');
  const rename = mock.method(fs, 'renameSync', () => { throw new Error('RENAME_FAILURE_CANARY'); });
  try { assert.throws(() => bridge.remember({ summary: 'new', detail: 'new' }), /RENAME_FAILURE_CANARY/); }
  finally { rename.mock.restore(); }
  assert.equal(fs.readFileSync(bridge.factsPath, 'utf8'), before);
  assert.equal(fs.existsSync(bridge.lockPath), false);
  assert.deepEqual(fs.readdirSync(bridge.memoryDir).filter((file) => file.endsWith('.tmp')), []);
});

test('native remember/search use the real authorized execution and expose storage failures', async (t) => {
  const bridge = fixture(t);
  const { tools, native } = registeredTools(bridge);
  const saved = await tools.get('dafeiyu_remember').execute({ summary: '便好', detail: 'NATIVE_MEMORY_CANARY' }, {});
  assert.equal(saved.saved, true);
  assert.equal(saved.kind, 'fact');
  const result = await tools.get('dafeiyu_memory_search').execute({ query: 'NATIVE_MEMORY_CANARY' }, {});
  assert.equal(result.total, 1);
  fs.writeFileSync(bridge.factsPath, '{broken');
  const failed = await tools.get('dafeiyu_memory_search').execute({ query: 'NATIVE_MEMORY_CANARY' }, {});
  assert.equal(failed.ok, false);
  assert.match(failed.error, /共享记忆读取失败/);
  native.dispose();
  assert.equal(tools.size, 0);
});

test('untrusted desktop, visitor and group cannot read or write private memory', async (t) => {
  const bridge = fixture(t);
  for (const identity of [{ isOwner: false, scope: 'desktop' }, { isOwner: false, scope: 'c2c' }, { isOwner: true, scope: 'group' }]) {
    const { tools, native } = registeredTools(bridge, identity);
    await assert.rejects(tools.get('dafeiyu_remember').execute({ summary: 'forbidden', detail: 'forbidden' }, {}), /仅绑定主人/);
    await assert.rejects(tools.get('dafeiyu_memory_search').execute({ query: 'PRIVATE_ARCHIVE_CANARY' }, {}), /仅绑定主人/);
    native.dispose();
  }
  assert.equal(fs.existsSync(bridge.factsPath), false);
});
