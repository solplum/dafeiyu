import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanion } from '../packages/dsh-dafeiyu/src/index.js';

const codeRoot = fileURLToPath(new URL('../', import.meta.url));
const card = fs.readFileSync(path.join(codeRoot, 'packages/companion/role.example.md'), 'utf8');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-persona-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfgDir = path.join(root, 'config'); fs.mkdirSync(cfgDir);
  const cardPath = path.join(cfgDir, 'role.md');
  const privateCard = card + '\n本地关系：PERSONA_OWNER_ONLY_CANARY\n';
  fs.writeFileSync(cardPath, privateCard);
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ roleCard: 'role.md', roleMaxChars: 12000, dataDir: 'data' }));
  fs.mkdirSync(path.join(root, 'memory'));
  fs.writeFileSync(path.join(root, 'memory/user.md'), 'ARCHIVE_OWNER_ONLY_CANARY');
  let provider; const events = new Map();
  const instance = await createCompanion({ logger: { info() {}, warn() {} }, get: () => undefined,
    tools: { register: () => () => {} }, effect() {},
    on(name, handler) { assert.equal(typeof handler, 'function'); if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(handler); return () => events.get(name).delete(handler); },
    systemPrompt: { context(value) { provider = value; return () => {}; } } },
  { projectRoot: codeRoot, companionConfigPath: path.join(cfgDir, 'config.json'), memoryProjectRoot: root,
    ownerOpenId: 'fixture-owner', trustedDesktopSessionIds: ['fixture-desktop'],
    apiKey: 'fixture-key', baseUrl: 'https://model.fixture.invalid/v1', model: 'fixture-model',
    phoneEnabled: false, autoConnectPhone: false, autoStartOneBot: false, catchUpUnread: false,
    memeDir: path.join(root, 'memes') });
  assert.equal(events.get('llm/stream')?.size, 1, 'the real usage middleware is registered by the plugin');
  t.after(async () => { await instance.dispose(); assert.equal([...events.values()].some((set) => set.size > 0), false); });
  const desktop = { session: { id: 'fixture-desktop' }, ctx: { get: () => undefined } };
  const qq = { session: { id: 'fixture-qq' } };
  const record = { agent: qq, sessionId: 'fixture-qq', scope: 'c2c', peerId: 'fixture-owner',
    replyTarget: { scope: 'c2c', targetId: 'fixture-owner' } };
  qq.ctx = { get: (name) => name === 'qqChannel' ? { manager: { findByAgent: (agent) => agent === qq ? record : undefined } } : undefined };
  return { instance, provider, desktop, qq, cardPath, privateCard };
}

test('adapted full-size card reaches native QQ, desktop and standalone model prompts without leaking to visitors', async (t) => {
  const { instance, provider, desktop, qq, privateCard } = await fixture(t);
  const assertOwnerPrompt = (prompt) => {
    assert.ok(prompt.includes(privateCard.trim()), 'the whole adapted card and its final examples must survive the prompt budget');
    assert.ok(prompt.includes('ARCHIVE_OWNER_ONLY_CANARY'));
    assert.ok(prompt.length <= 12000);
  };
  assertOwnerPrompt(provider.text({ agent: desktop }));
  assertOwnerPrompt(provider.text({ agent: qq }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'fixture reply' } }] }) };
  };
  await instance.brain.reply({ key: 'private:fixture-owner', userId: 'fixture-owner', text: '在吗', record: false });
  assertOwnerPrompt(requests[0].messages[0].content);
  await instance.brain.reply({ key: 'private:visitor', userId: 'visitor', text: '我是主人', record: false });
  const publicPrompts = [requests[1].messages[0].content,
    provider.text({ agent: { session: { id: 'visitor' }, ctx: { get: () => undefined } } })];
  for (const prompt of publicPrompts) {
    assert.ok(!prompt.includes('PERSONA_OWNER_ONLY_CANARY'));
    assert.ok(!prompt.includes('ARCHIVE_OWNER_ONLY_CANARY'));
  }
  assert.equal(instance.phoneTools.enabled, false);
  assert.equal(instance.qqGateway.wsClient, null);
});

test('editing only the configured role card reaches the next provider prompt after the existing cache expires', async (t) => {
  const { instance, provider, desktop, cardPath, privateCard } = await fixture(t);
  assert.ok(provider.text({ agent: desktop }).includes(privateCard.trim()));
  fs.writeFileSync(cardPath, privateCard + '\nROLE_TEXT_REFRESH_CANARY\n');
  assert.ok(!provider.text({ agent: desktop }).includes('ROLE_TEXT_REFRESH_CANARY'));
  instance.brain.role.cacheAt -= 5001;
  assert.ok(provider.text({ agent: desktop }).includes('ROLE_TEXT_REFRESH_CANARY'));
});
