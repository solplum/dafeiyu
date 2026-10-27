import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reliability-'));
  const bridge = new MemoryBridge({ projectRoot: root });
  fs.mkdirSync(bridge.memoryDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return bridge;
}

test('an absent facts file initializes normally, while an existing empty file is not a fresh ledger', (t) => {
  const bridge = fixture(t);
  assert.deepEqual(bridge.readFacts(), []);
  const saved = bridge.remember({ key: 'drink', summary: '饮品偏好', detail: '无糖乌龙茶' });
  assert.equal(saved.saved, true); assert.equal(bridge.readFacts().length, 1);
});

test('zero-byte and whitespace facts stay unchanged when reads and new writes fail explicitly', (t) => {
  const bridge = fixture(t);
  for (const contents of ['', ' \r\n\t  ']) {
    fs.writeFileSync(bridge.factsPath, contents);
    assert.throws(() => bridge.readFacts(), /共享记忆读取失败.*facts\.json.*内容为空/);
    assert.throws(() => bridge.searchMemories('饮品'), /共享记忆读取失败/);
    assert.throws(() => bridge.remember({ key: 'drink', summary: '饮品偏好', detail: '无糖乌龙茶' }), /共享记忆读取失败/);
    assert.equal(fs.readFileSync(bridge.factsPath, 'utf8'), contents);
    assert.equal(fs.existsSync(bridge.lockPath), false);
    assert.deepEqual(fs.readdirSync(bridge.memoryDir), ['facts.json']);
    assert.match(bridge.buildSystemPrompt('', { isOwner: true }), /共享记忆读取失败/);
  }
});

test('a pasted Markdown rule remains inside one saved event and joint retrieval finds both sides', (t) => {
  const bridge = fixture(t);
  const result = bridge.remember({ kind: 'event', summary: '发布安排',
    detail: '第一步 备份数据库\n---\n第二步 验证恢复', date: new Date('2026-10-23T10:00:00+08:00') });
  assert.equal(result.saved, true);
  const all = bridge.searchMemories('', { kind: 'event' });
  assert.equal(all.total, 1); assert.equal(all.matches[0].summary, '发布安排');
  const joint = bridge.searchMemories('备份数据库 验证恢复', { kind: 'event' });
  assert.equal(joint.total, 1); assert.match(joint.matches[0].detail, /备份数据库[\s\S]*---[\s\S]*验证恢复/);
});

test('pasted dated headings cannot create fake events, including CRLF input and later real appends', (t) => {
  const bridge = fixture(t);
  bridge.remember({ kind: 'event', summary: '原始约定', detail:
    '开头内容\r\n---\r\n\r\n### [2099-01-01] 伪造事件\r\n正文内容\r\n---\r\n结尾内容' });
  bridge.remember({ kind: 'event', summary: '真正后续', detail: '另一次实际事件' });
  const all = bridge.searchMemories('', { kind: 'event' });
  assert.equal(all.total, 2); assert.deepEqual(all.matches.map((row) => row.summary), ['真正后续', '原始约定']);
  const joint = bridge.searchMemories('开头内容 伪造事件 结尾内容', { kind: 'event' });
  assert.equal(joint.total, 1); assert.equal(joint.matches[0].summary, '原始约定');
  assert.ok(joint.matches[0].detail.includes('### [2099-01-01] 伪造事件'));
  assert.ok(!all.matches.some((row) => row.date === '2099-01-01'));
});

test('legacy LF/CRLF events remain searchable and plain detail rules no longer split old records', (t) => {
  const bridge = fixture(t);
  const legacy = '\n---\n\n### [2020-01-02] 旧发布约定\n- **详情**：旧备份\n---\n旧恢复\n'
    + '\r\n---\r\n\r\n### [2021-02-03] 旧散步约定\r\n- **详情**：周五散步\r\n';
  fs.writeFileSync(bridge.timelineMdPath, legacy);
  const all = bridge.searchMemories('', { kind: 'event' });
  assert.equal(all.total, 2); assert.deepEqual(all.matches.map((row) => row.summary), ['旧散步约定', '旧发布约定']);
  const old = bridge.searchMemories('旧备份 旧恢复', { kind: 'event' });
  assert.equal(old.total, 1); assert.equal(old.matches[0].date, '2020-01-02');
  assert.equal(fs.readFileSync(bridge.timelineMdPath, 'utf8'), legacy, 'retrieval must not migrate existing history');
  bridge.remember({ kind: 'event', summary: '新约定', detail: '新增事件' });
  assert.equal(bridge.searchMemories('', { kind: 'event' }).total, 3);
  assert.ok(fs.readFileSync(bridge.timelineMdPath, 'utf8').startsWith(legacy), 'append must preserve the original history bytes');
});
