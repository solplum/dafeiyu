import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Role, fitMemoryEntries } from '../packages/companion/src/role.js';
import { Brain } from '../packages/companion/src/brain.js';
import { OneBot } from '../packages/companion/src/transport-onebot.js';
import { Waker } from '../packages/companion/src/wake.js';
import { Humanizer } from '../packages/companion/src/humanize.js';
import { AutoReadyManager } from '../packages/dsh-dafeiyu/src/auto-ready.js';
import { QQGateway } from '../packages/dsh-dafeiyu/src/qq-gateway.js';
import { createCompanion } from '../packages/dsh-dafeiyu/src/index.js';
import { fileURLToPath } from 'node:url';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-companion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const base = 1700000000000;
const message = (id, offset = 1, text = id) => ({ channel: 'onebot', userId: '123', userName: 'owner',
  isGroup: false, messageId: id, time: base + offset * 1000, text });
function managerFixture(t, options = {}) {
  const root = directory(t), calls = { generations: [], sent: [], records: [] };
  const gateway = { async fetchFriendHistory() { return { ok: true, messages: [], coverage: { complete: true } }; },
    async sendMessage(key, text) { calls.sent.push(text); return { ok: true }; } };
  const brain = { async reply(input) { calls.generations.push(input); return { text: input.text }; },
    recordReply(...args) { calls.records.push(args); } };
  const manager = new AutoReadyManager({ projectRoot: root, ownerQq: '123', qqGateway: gateway,
    brain, humanizer: { async say(text, { send }) { for (const chunk of text.split('|')) await send(chunk); } },
    logger: { warn() {} }, privateWindowMs: 60000, ...options });
  manager.saveState({ lastProcessedTime: base });
  t.after(() => manager.dispose());
  return { root, manager, gateway, brain, calls };
}

test('total role budget preserves rules and persona despite an oversized archive', (t) => {
  const root = directory(t); fs.mkdirSync(path.join(root, 'memory'));
  const cardPath = path.join(root, 'role.md'); fs.writeFileSync(cardPath, 'PUBLIC_PERSONA 说话简短，别编造。');
  fs.writeFileSync(path.join(root, 'memory/user.md'), '- 无关的完整事实\n'.repeat(1500));
  fs.writeFileSync(path.join(root, 'memory/timeline.md'), '### [2026-01-01] 火星出差\n- 约定周五确认火星出差地点。\n\n'
    + Array.from({ length: 80 }, (_, i) => `### [2026-02-01] 无关${i}\n- 已完成其他事情${i}。`).join('\n\n'));
  const role = new Role({ cardPath, memoryProjectRoot: root, maxChars: 1400 });
  const prompt = role.build({ includePrivateMemory: true, query: '火星出差地点是什么' });
  assert.ok(prompt.length <= 1400, String(prompt.length));
  assert.match(prompt, /PUBLIC_PERSONA/); assert.match(prompt, /基本规矩/); assert.match(prompt, /周五确认火星出差地点/);
  assert.ok(!role.build({ includePrivateMemory: false }).includes('火星出差'));
});

test('memory budget omits a whole oversized event instead of injecting half of it', () => {
  const text = '### [2026-01-01] 巨长事件\n' + '不完整事实'.repeat(100) + '\n\n### [2026-01-02] 小事\n- 完整的小事件';
  const selected = fitMemoryEntries(text, 100, { recent: true });
  assert.ok(selected.length <= 100); assert.match(selected, /完整的小事件/); assert.doesNotMatch(selected, /不完整事实/);
});

test('Brain uses the injected archive bridge and keeps group context public', async (t) => {
  const root = directory(t), seen = [];
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options) => { const body = JSON.parse(options.body); seen.push(body.messages[0].content);
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'answer' } }] }) }; };
  const roleContexts = [], bridgeContexts = [];
  const brain = new Brain({ apiKey: 'fixture', ownerIds: ['123'],
    role: { build(ctx) { roleContexts.push(ctx); return 'public role'; } },
    memoryBridge: { buildSystemPrompt(_extra, ctx) { bridgeContexts.push(ctx); return ctx.isOwner ? 'shared private archive' : 'public archive'; } },
    memory: { renderPerson() { return ''; }, renderRecent() { return ''; }, recentTurns() { return []; } } });
  await brain.reply({ key: 'private:123', userId: '123', text: '旧约定', record: false });
  await brain.reply({ key: 'group:g', userId: '123', text: '旧约定', isGroup: true, record: false });
  assert.equal(roleContexts[0].includePrivateMemory, false); assert.equal(bridgeContexts[0].isOwner, true);
  assert.equal(bridgeContexts[0].query, '旧约定'); assert.equal(bridgeContexts[1].isOwner, false);
  assert.deepEqual(seen, ['shared private archive', 'public archive']); assert.ok(root);
});

test('history expands beyond 20 messages until the original floor is covered', async (t) => {
  const { manager, gateway, calls } = managerFixture(t), counts = [];
  const rows = Array.from({ length: 36 }, (_, i) => message(String(i), i - 1));
  gateway.fetchFriendHistory = async (_owner, count) => { counts.push(count); return { ok: true, messages: rows.slice(-count) }; };
  const result = await manager.catchUpUnreadMessages();
  assert.equal(result.ok, true); assert.deepEqual(counts, [20, 40]);
  assert.equal(calls.generations[0].text.split(' ').length, 35);
  assert.equal(manager.state.historyWatermarkTime, base + 34000);
});

test('unknown truncated history never advances a watermark or claims recovery', async (t) => {
  const { manager, gateway, calls } = managerFixture(t);
  gateway.fetchFriendHistory = async () => ({ ok: true, messages: [message('only-newest', 30)] });
  const result = await manager.catchUpUnreadMessages();
  assert.equal(result.incomplete, true); assert.equal(manager.state.historyWatermarkTime, base);
  assert.equal(calls.sent.length, 0); assert.equal(calls.generations.length, 0);
});

test('live replies during a slow history fetch cannot swallow older offline messages', async (t) => {
  const { manager, gateway, calls } = managerFixture(t); let release;
  gateway.fetchFriendHistory = async () => new Promise((resolve) => { release = resolve; });
  const catchup = manager.catchUpUnreadMessages();
  manager.enqueueIncomingMessage(message('live', 3)); await manager.flush();
  assert.equal(manager.state.historyWatermarkTime, base);
  release({ ok: true, messages: [message('boundary', -1), message('old', 1), message('live', 3)] });
  const result = await catchup;
  assert.equal(result.ok, true); assert.equal(calls.sent.filter((text) => text === 'live').length, 1);
  assert.ok(calls.sent.some((text) => text.includes('old')));
  assert.equal(manager.state.historyWatermarkTime, base + 3000);
});

test('a definite partial failure resumes cached remaining chunks without rerunning tools', async (t) => {
  const { manager, gateway, calls } = managerFixture(t); let fail = true;
  gateway.sendMessage = async (_key, text) => {
    if (text === 'second' && fail) return { ok: false, error: 'explicit platform rejection' };
    calls.sent.push(text); return { ok: true };
  };
  const item = message('two-chunks', 1, 'first|second');
  manager.enqueueIncomingMessage(item); assert.equal((await manager.flush())[0].ok, false);
  fail = false; manager.enqueueIncomingMessage(item); await manager.flush();
  assert.deepEqual(calls.sent, ['first', 'second']); assert.equal(calls.generations.length, 1);
  assert.equal(calls.records.length, 1);
});

test('uncertain sends are blocked across manager restart', async (t) => {
  const { root, manager, gateway, brain, calls } = managerFixture(t);
  gateway.sendMessage = async () => ({ ok: false, uncertain: true, error: 'ACK lost' });
  const item = message('uncertain'); manager.enqueueIncomingMessage(item); await manager.flush(); manager.dispose();
  const again = new AutoReadyManager({ projectRoot: root, ownerQq: '123', qqGateway: gateway, brain,
    humanizer: { async say(text, { send }) { await send(text); } }, logger: { warn() {} }, privateWindowMs: 60000 });
  t.after(() => again.dispose()); again.enqueueIncomingMessage(item);
  const result = (await again.flush())[0]; assert.equal(result.ok, false); assert.match(result.error, /阻止自动重放/);
  assert.equal(calls.generations.length, 1);
});

test('a pending generation record after a crash blocks model/tool replay', async (t) => {
  const { root, manager, gateway, brain, calls } = managerFixture(t);
  const item = message('generation-crash'); let release;
  brain.reply = async (input) => { calls.generations.push(input); return new Promise((resolve) => { release = resolve; }); };
  manager.enqueueIncomingMessage(item); const first = manager.flush();
  await new Promise((resolve) => setImmediate(resolve)); manager.dispose();
  const again = new AutoReadyManager({ projectRoot: root, ownerQq: '123', qqGateway: gateway, brain,
    humanizer: new Humanizer({ enabled: false }), logger: { warn() {} }, privateWindowMs: 60000 });
  t.after(() => again.dispose()); again.enqueueIncomingMessage(item);
  assert.equal((await again.flush())[0].uncertain, true);
  release({ text: 'late result' }); await first;
  assert.equal(calls.generations.length, 1); assert.equal(calls.sent.length, 0);
});

test('persisted actual chunks survive a different splitter after restart', async (t) => {
  const firstHumanizer = new Humanizer({ enabled: false, burstMax: 4 });
  const { root, manager, gateway, brain, calls } = managerFixture(t, { humanizer: firstHumanizer });
  const item = message('stable-chunks', 1, 'first sentence\nsecond sentence'); let fail = true;
  gateway.sendMessage = async (_key, text) => {
    if (text === 'second sentence' && fail) return { ok: false, error: 'rejected' };
    calls.sent.push(text); return { ok: true };
  };
  manager.enqueueIncomingMessage(item); await manager.flush(); manager.dispose(); fail = false;
  const again = new AutoReadyManager({ projectRoot: root, ownerQq: '123', qqGateway: gateway, brain,
    humanizer: new Humanizer({ enabled: false, burstMax: 1 }), logger: { warn() {} }, privateWindowMs: 60000 });
  t.after(() => again.dispose()); again.enqueueIncomingMessage(item); assert.equal((await again.flush())[0].ok, true);
  assert.deepEqual(calls.sent, ['first sentence', 'second sentence']); assert.equal(calls.generations.length, 1);
});

test('history paging reads past an entire same-second watermark boundary', async (t) => {
  const { manager, gateway, calls } = managerFixture(t), cursors = [];
  gateway.fetchFriendHistory = async (_owner, _count, { beforeSeq }) => {
    cursors.push(beforeSeq);
    return beforeSeq === undefined
      ? { ok: true, messages: [message('same-new', 0), message('new', 1)], coverage: { nextCursor: 20 } }
      : { ok: true, messages: [message('older', -1), message('same-old', 0)], coverage: { nextCursor: 18 } };
  };
  const result = await manager.catchUpUnreadMessages(); assert.equal(result.ok, true);
  assert.deepEqual(cursors, [undefined, 20]); assert.match(calls.generations[0].text, /same-old/);
  assert.match(calls.generations[0].text, /same-new/);
});

test('history with a missing timestamp stays incomplete even if the API claims its end', async (t) => {
  const { manager, gateway, calls } = managerFixture(t);
  gateway.fetchFriendHistory = async () => ({ ok: true, messages: [message('unknown-time', 0), { ...message('bad'), time: 0 }], coverage: { complete: true } });
  const result = await manager.catchUpUnreadMessages(); assert.equal(result.incomplete, true);
  assert.equal(manager.state.historyWatermarkTime, base); assert.equal(calls.sent.length, 0);
});

test('corrupt delivery state stops startup rather than discarding uncertain effects', (t) => {
  const root = directory(t), file = path.join(root, 'packages/dsh-dafeiyu/data/state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{broken');
  assert.throws(() => new AutoReadyManager({ projectRoot: root }), /停止自动回复/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('disabled reply branch never reads or writes corrupt state and ignores messages', async (t) => {
  const root = directory(t), file = path.join(root, 'packages/dsh-dafeiyu/data/state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{broken');
  let probes = 0;
  const manager = new AutoReadyManager({ projectRoot: root, ownerQq: '123', enabled: false,
    connectPhone: true, phoneTools: { async getDeviceState() { probes++; return { online: true }; } } });
  t.after(() => manager.dispose());
  assert.deepEqual(await manager.executeAutoReady(), { phone: 'online', catchUp: 'not-requested' });
  assert.equal(probes, 1, 'explicit phone startup remains independent of the reply branch');
  manager.enqueueIncomingMessage(message('ignored')); assert.equal(manager.batchQueue.size, 0);
  assert.equal((await manager.catchUpUnreadMessages()).disabled, true);
  assert.equal(manager.saveState({ lastProcessedTime: 0 }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('native role/tools load with corrupt disabled OneBot state; enabling legacy OneBot still refuses it', async (t) => {
  const root = directory(t), file = path.join(root, 'packages/dsh-dafeiyu/data/state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{broken');
  const companionDir = path.join(root, 'packages/companion'); fs.mkdirSync(companionDir);
  fs.symlinkSync(fileURLToPath(new URL('../packages/companion/src', import.meta.url)), path.join(companionDir, 'src'), 'dir');
  const configPath = path.join(companionDir, 'fixture-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ roleCard: 'fixture-role.md', dataDir: 'fixture-data' }));
  fs.writeFileSync(path.join(companionDir, 'fixture-role.md'), 'CORRUPT_OPTIONAL_STATE_ROLE_CANARY');
  const tools = new Map(), events = new Map(); let prompt;
  const ctx = { logger: { info() {}, warn() {} }, get() {}, effect() {},
    on(name, handler) { assert.equal(typeof handler, 'function'); if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(handler); return () => events.get(name).delete(handler); },
    systemPrompt: { context(value) { prompt = value; return () => {}; } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } };
  const config = { projectRoot: root, companionConfigPath: configPath, memoryProjectRoot: root,
    trustedDesktopSessionIds: ['fixture-session'], phoneEnabled: false, autoStartOneBot: false,
    autoConnectPhone: false, catchUpUnread: false, memeDir: path.join(root, 'fixture-memes') };
  const instance = await createCompanion(ctx, config); t.after(() => instance.dispose());
  assert.equal(instance.autoReady.enabled, false); assert.ok(tools.has('dafeiyu_status'));
  assert.match(prompt.text({ agent: { session: { id: 'fixture-session' }, ctx: { get() {} } } }), /CORRUPT_OPTIONAL_STATE_ROLE_CANARY/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal(events.get('llm/stream')?.size, 1);
  await instance.dispose();
  assert.equal([...events.values()].some((set) => set.size > 0), false, 'a replacement runtime uses the host only after the first unregisters');
  await assert.rejects(createCompanion(ctx, { ...config, onebotEngine: 'legacy', ownerQq: '123', onebotSelfId: '456',
    autoStartOneBot: true, onebotWs: 'ws://fixture' }), /停止自动回复/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal([...events.values()].some((set) => set.size > 0), false, 'failed construction also cleans the usage middleware');
});

test('private role-card details are never included in a visitor/group Brain prompt', async (t) => {
  const root = directory(t), cardPath = path.join(root, 'role.md'); fs.writeFileSync(cardPath, 'PRIVATE_RELATIONSHIP_CARD');
  const prompts = [], original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, options) => { prompts.push(JSON.parse(options.body).messages[0].content);
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'hello' } }] }) }; };
  const brain = new Brain({ apiKey: 'fixture', ownerIds: ['123'], role: new Role({ cardPath }),
    memory: { renderPerson() { return ''; }, renderRecent() { return ''; }, recentTurns() { return []; } } });
  await brain.reply({ key: 'private:999', userId: '999', text: 'hi', record: false });
  await brain.reply({ key: 'group:g', userId: '123', isGroup: true, text: 'hi', record: false });
  await brain.reply({ key: 'private:123', userId: '123', text: 'hi', record: false });
  assert.doesNotMatch(prompts[0], /PRIVATE_RELATIONSHIP/); assert.doesNotMatch(prompts[1], /PRIVATE_RELATIONSHIP/);
  assert.match(prompts[2], /PRIVATE_RELATIONSHIP/);
});

test('failure to save the pre-effect record prevents generation and sending', async (t) => {
  const { manager, calls } = managerFixture(t); manager.saveState = () => false;
  manager.enqueueIncomingMessage(message('save-failure')); const result = (await manager.flush())[0];
  assert.equal(result.ok, false); assert.equal(calls.generations.length, 0); assert.equal(calls.sent.length, 0);
});

test('gateway exposes only source timestamps and real sequence pagination metadata', async () => {
  const gateway = new QQGateway({ onebotWs: '', onebotHttp: '' }), requests = [];
  gateway.api = async (_action, params) => { requests.push(params); return { ok: true, data: { has_more: true,
    messages: [{ message_id: 9, message_seq: 8, user_id: 123, message: 'hello' }] } }; };
  const result = await gateway.fetchFriendHistory('123', 20, { beforeSeq: 10 });
  assert.equal(requests[0].message_seq, 10); assert.equal(result.messages[0].time, 0);
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.nextCursor, 8); gateway.stop();
});

test('quoting the bot in a group reaches the existing quote wake condition', async (t) => {
  class Socket { constructor() { this.listeners = {}; Socket.instance = this; } addEventListener(type, fn) { this.listeners[type] = fn; } close() {} }
  const received = [], lookups = [];
  const bot = new OneBot({ wsUrl: 'ws://fixture', WebSocketImpl: Socket, onMessage(msg) { received.push(msg); } });
  t.after(() => bot.close()); bot.whoSent = async (id) => { lookups.push(id); return '200'; };
  Socket.instance.listeners.message({ data: JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 200,
    user_id: 123, group_id: 7, message: [{ type: 'reply', data: { id: 'original' } }, { type: 'text', data: { text: '继续' } }] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lookups, ['original']); assert.equal(received[0].isQuoteMe, true);
  const waker = new Waker({ probability: 0 }); waker.setConfig('group:7', { question: false, nameMention: false });
  assert.equal(waker.shouldWake(received[0]).reason, 'atMention');
});
