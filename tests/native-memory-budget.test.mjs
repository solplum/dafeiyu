import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';
import { createCompanion } from '../packages/dsh-dafeiyu/src/index.js';
import { Role } from '../packages/companion/src/role.js';
import { Memory } from '../packages/companion/src/memory.js';
import { Brain } from '../packages/companion/src/brain.js';

const codeRoot = fileURLToPath(new URL('../', import.meta.url));
const SNAPSHOT = '【共享记忆快照：长期事实、相关检索与近期事件】\n';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-memory-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridge = new MemoryBridge({ projectRoot: dir });
  fs.mkdirSync(bridge.memoryDir);
  fs.writeFileSync(bridge.userMdPath, '# 测试档案\n' + '旧档案'.repeat(3000));
  for (let i = 0; i < 8; i++) {
    bridge.remember({ kind: 'fact', key: `key-${i}`, summary: `事实${i}`, detail: `COMPLETE_FACT_${i}_` + '长事实内容'.repeat(300) });
    bridge.remember({ kind: 'event', summary: `事件${i}`, detail: `COMPLETE_EVENT_${i}_` + '长事件内容'.repeat(300) });
  }
  return { dir, bridge };
}

function assertWholeSnapshot(prompt, bridge) {
  const start = prompt.indexOf(SNAPSHOT);
  if (start < 0) {
    assert.ok(prompt.includes('"truncated":true'));
    return;
  }
  const value = JSON.parse(prompt.slice(start + SNAPSHOT.length));
  assert.equal(value.truncated, true);
  const complete = bridge.searchMemories('', { limit: 100, maxChars: 100000 }).matches;
  for (const record of value.matches) {
    assert.ok(complete.some((stored) => stored.kind === record.kind && stored.source === record.source
      && stored.summary === record.summary && stored.detail === record.detail), 'prompt must select complete entries rather than cut them');
  }
}

test('bridge bounds the entire role/private-memory/environment prompt and keeps valid complete-entry JSON', (t) => {
  const { bridge } = fixture(t);
  for (const maxChars of [512, 1024, 4096]) {
    const prompt = bridge.buildSystemPrompt('环境说明'.repeat(1000), {
      isOwner: true, roleText: 'SHORT_ROLE_CARD_CANARY', query: 'COMPLETE_EVENT_0_', maxChars,
    });
    assert.ok(prompt.length <= maxChars, `${prompt.length} > ${maxChars}`);
    assert.ok(prompt.includes('SHORT_ROLE_CARD_CANARY'));
    assertWholeSnapshot(prompt, bridge);
  }
  assert.throws(() => bridge.buildSystemPrompt('', { maxChars: 511 }), /至少 512/);
  const longRole = bridge.buildSystemPrompt('', { isOwner: true, roleText: '长角色设定'.repeat(2000), maxChars: 1024 });
  assert.ok(longRole.length <= 1024);
  assert.ok(longRole.includes('角色上下文已按预算截断'));
});

test('actual native provider respects roleMaxChars including phone state and shared long history', async (t) => {
  const { dir, bridge } = fixture(t);
  const cfgDir = path.join(dir, 'config'); fs.mkdirSync(cfgDir);
  const card = 'SHORT_NATIVE_CARD_CANARY 请保持这张小卡完整';
  fs.writeFileSync(path.join(cfgDir, 'role.md'), card);
  for (const roleMaxChars of [512, 1024, 4096]) {
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ roleMaxChars, roleCard: 'role.md', dataDir: 'data' }));
    let provider; const events = new Map();
    const instance = await createCompanion({ logger: { info() {}, warn() {} }, get: () => undefined,
      tools: { register: () => () => {} }, effect() {},
      on(name, handler) { assert.equal(typeof handler, 'function'); if (!events.has(name)) events.set(name, new Set());
        events.get(name).add(handler); return () => events.get(name).delete(handler); },
      systemPrompt: { context(value) { provider = value; return () => {}; } } },
    { projectRoot: codeRoot, companionConfigPath: path.join(cfgDir, 'config.json'), memoryProjectRoot: dir,
      trustedDesktopSessionIds: ['budget-session'], phoneEnabled: false, memeDir: path.join(dir, 'memes') });
    try {
      assert.equal(events.get('llm/stream')?.size, 1);
      const agent = { session: { id: 'budget-session' }, ctx: { get: () => undefined } };
      const prompt = provider.text({ agent });
      assert.ok(prompt.length <= roleMaxChars, `${prompt.length} > ${roleMaxChars}`);
      assert.ok(prompt.includes(card), 'a complete small configured card has priority');
      assert.ok(prompt.includes('手机当前离线'));
      assertWholeSnapshot(prompt, bridge);
    } finally { await instance.dispose(); assert.equal([...events.values()].some((set) => set.size > 0), false); }
  }
});

test('actual Brain request bounds its main system prompt after adding long shared facts and old events', async (t) => {
  const { dir, bridge } = fixture(t);
  const cardPath = path.join(dir, 'role.md');
  const card = 'SHORT_BRAIN_CARD_CANARY 这张小卡应完整';
  fs.writeFileSync(cardPath, card);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const maxChars of [512, 1024, 4096]) {
    let mainSystem;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      mainSystem = body.messages.find((message) => message.role === 'system').content;
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '离线替身回复' } }] }) };
    };
    const role = new Role({ cardPath, maxChars, memoryProjectRoot: dir });
    const brain = new Brain({ role, memory: new Memory({ dir: path.join(dir, 'ledger') }), memoryBridge: bridge, ownerIds: ['owner'] });
    await brain.reply({ key: 'private:owner', userId: 'owner', text: 'COMPLETE_EVENT_0_', record: false });
    assert.ok(mainSystem.length <= maxChars, `${mainSystem.length} > ${maxChars}`);
    assert.ok(mainSystem.includes(card));
    assertWholeSnapshot(mainSystem, bridge);
  }
});
