import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanion } from '../packages/dsh-dafeiyu/src/index.js';

const codeRoot = fileURLToPath(new URL('../', import.meta.url));

test('native owner uses configured card and separated shared memory root without starting a second engine', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-memory-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfgDir = path.join(dir, 'companion-config');
  const memoryRoot = path.join(dir, 'shared-owner-data');
  fs.mkdirSync(cfgDir);
  fs.mkdirSync(path.join(memoryRoot, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ roleCard: 'fixture-role.md', dataDir: 'fixture-data' }));
  fs.writeFileSync(path.join(cfgDir, 'fixture-role.md'), 'CONFIGURED_ROLE_NATIVE_CANARY 这是测试角色卡');
  fs.writeFileSync(path.join(memoryRoot, 'memory/user.md'), 'SEPARATED_MEMORY_ROOT_CANARY');
  const tools = new Map(), events = new Map();
  let promptProvider;
  const ctx = {
    logger: { info() {}, warn() {} },
    get: () => undefined,
    on(name, handler) { assert.equal(typeof handler, 'function'); if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(handler); return () => events.get(name).delete(handler); },
    systemPrompt: { context(provider) { promptProvider = provider; return () => { promptProvider = null; }; } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    effect() {},
  };
  const instance = await createCompanion(ctx, { projectRoot: codeRoot,
    companionConfigPath: path.join(cfgDir, 'config.json'), memoryProjectRoot: memoryRoot,
    trustedDesktopSessionIds: ['actual-local-session'], allowMemoryWrites: true,
    memeDir: path.join(dir, 'meme-fixture'), phoneEnabled: false,
    autoConnectPhone: false, autoStartOneBot: false, catchUpUnread: false });
  assert.equal(events.get('llm/stream')?.size, 1);
  t.after(async () => { await instance.dispose(); assert.equal([...events.values()].some((set) => set.size > 0), false); });
  // Any accidental attempt to use the standalone Brain would fail the test.
  instance.brain.reply = () => { throw new Error('native prompt must not run standalone model'); };
  const agent = { session: { id: 'actual-local-session' }, ctx: { get: () => undefined } };
  const ownerPrompt = promptProvider.text({ agent });
  assert.ok(ownerPrompt.includes('CONFIGURED_ROLE_NATIVE_CANARY'));
  assert.ok(ownerPrompt.includes('SEPARATED_MEMORY_ROOT_CANARY'));
  const visitor = { session: { id: 'untrusted-local-session' }, ctx: agent.ctx };
  const publicPrompt = promptProvider.text({ agent: visitor });
  assert.ok(!publicPrompt.includes('CONFIGURED_ROLE_NATIVE_CANARY'));
  assert.ok(!publicPrompt.includes('SEPARATED_MEMORY_ROOT_CANARY'));
  assert.equal(instance.brain.memoryBridge, instance.memoryBridge);
  assert.equal(instance.phoneTools.transcribeAudio, undefined, 'an absent STT must not become a truthy fake transcriber');
  assert.equal(instance.phoneTools.enabled, false);
  assert.equal(instance.qqGateway.wsClient, null);
  const saved = await tools.get('dafeiyu_remember').execute({ summary: '稳定偏好', detail: 'NATIVE_SEPARATED_FACT_CANARY' }, { agent });
  assert.equal(saved.kind, 'fact');
  assert.equal(fs.existsSync(path.join(memoryRoot, 'memory/facts.json')), true);
  assert.ok(promptProvider.text({ agent }).includes('NATIVE_SEPARATED_FACT_CANARY'));
  const found = await tools.get('dafeiyu_memory_search').execute({ query: 'NATIVE_SEPARATED_FACT_CANARY' }, { agent });
  assert.equal(found.total, 1);
});
