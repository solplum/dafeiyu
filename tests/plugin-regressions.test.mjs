import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoReadyManager } from '../packages/dsh-dafeiyu/src/auto-ready.js';

function fixture(t, overrides = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ready-offline-'));
  const calls = { replies: [], sent: [], records: [], timeline: [], history: 0, phone: 0 };
  const gateway = { ownerOpenId: 'owner-openid',
    async fetchFriendHistory() { calls.history++; return { ok: true, messages: [] }; },
    async sendMessage(...args) { calls.sent.push(args); return { ok: true }; } };
  const brain = { async reply(input) { calls.replies.push(input); return { text: 'reply' }; },
    recordReply(...args) { calls.records.push(args); } };
  const manager = new AutoReadyManager({ projectRoot, ownerQq: '123', ownerOpenId: 'owner-openid',
    qqGateway: gateway, brain, humanizer: { async say(text, { send }) { await send(text); } },
    phoneTools: { async getDeviceState() { calls.phone++; return { online: true }; } },
    memoryBridge: { appendTimeline(item) { calls.timeline.push(item); } },
    logger: { info() {}, warn() {} }, privateWindowMs: 60000, groupWindowMs: 60000,
    ...overrides });
  t.after(() => { manager.dispose(); fs.rmSync(projectRoot, { recursive: true, force: true }); });
  return { projectRoot, manager, calls, gateway, brain };
}
const msg = (patch = {}) => ({ channel: 'onebot', userId: '123', userName: 'owner', text: 'hello',
  isGroup: false, messageId: 'm1', time: Date.now(), ...patch });

test('default startup does not query history or probe a device', async (t) => {
  const { manager, calls } = fixture(t);
  const status = await manager.executeAutoReady();
  assert.deepEqual(status, { phone: 'not-requested', catchUp: 'not-requested' });
  assert.equal(calls.history, 0);
  assert.equal(calls.phone, 0);
});

test('failed and empty history reads do not discard the last valid watermark', async (t) => {
  const { manager, gateway } = fixture(t);
  manager.saveState({ lastProcessedTime: 1000 });
  gateway.fetchFriendHistory = async () => ({ ok: false, error: 'offline' });
  assert.equal((await manager.catchUpUnreadMessages()).ok, false);
  assert.equal(manager.state.lastProcessedTime, 1000);
  gateway.fetchFriendHistory = async () => ({ ok: true, messages: [] });
  await manager.catchUpUnreadMessages();
  assert.equal(manager.state.lastProcessedTime, 1000);
});

test('a failed send is retryable and is never recorded as delivered', async (t) => {
  const { manager, gateway, calls } = fixture(t);
  manager.saveState({ lastProcessedTime: 1000 });
  gateway.sendMessage = async () => ({ ok: false, error: 'send failed' });
  const input = msg({ time: 2000 });
  manager.enqueueIncomingMessage(input);
  const [result] = await manager.flush();
  assert.equal(result.ok, false);
  assert.equal(manager.state.lastProcessedTime, 1000);
  assert.equal(calls.records.length, 0);
  gateway.sendMessage = async (...args) => { calls.sent.push(args); return { ok: true }; };
  manager.enqueueIncomingMessage(input);
  await manager.flush();
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.records.length, 1);
  assert.equal(calls.replies[0].record, false);
});

test('group batching keeps different speakers separate and never includes private owner memory', async (t) => {
  const { manager, calls } = fixture(t);
  manager.enqueueIncomingMessage(msg({ isGroup: true, groupId: 'g', text: 'owner words', messageId: 'a' }));
  manager.enqueueIncomingMessage(msg({ isGroup: true, groupId: 'g', userId: 'visitor', text: '大肥鱼 visitor', messageId: 'b' }));
  await manager.flush();
  assert.equal(calls.replies.length, 2);
  assert.deepEqual(new Set(calls.replies.map((input) => input.userId)), new Set(['123', 'visitor']));
  assert.ok(calls.replies.every((input) => input.isOwner === false && input.isGroup === true));
  assert.ok(calls.replies.every((input) => !input.text.includes('owner words 大肥鱼 visitor')));
});

test('spoofed nickname/isOwner cannot wake an unrelated group sender', async (t) => {
  const { manager, calls } = fixture(t);
  manager.enqueueIncomingMessage(msg({ userId: 'visitor', userName: 'sol 至死 卓霖', isOwner: true,
    isGroup: true, groupId: 'g', text: 'hello' }));
  await manager.flush();
  assert.equal(calls.replies.length, 0);
});

test('same conversation replies serialize while new messages arrive during generation', async (t) => {
  const { manager, brain, calls } = fixture(t);
  let release;
  brain.reply = async (input) => {
    calls.replies.push(input);
    if (calls.replies.length === 1) await new Promise((resolve) => { release = resolve; });
    return { text: input.text };
  };
  manager.enqueueIncomingMessage(msg({ text: 'first', messageId: 'first' }));
  const first = manager.flush();
  await new Promise((resolve) => setImmediate(resolve));
  manager.enqueueIncomingMessage(msg({ text: 'second', messageId: 'second' }));
  const second = manager.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.replies.length, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls.sent.map((call) => call[1]), ['first', 'second']);
});

test('dispose cancels queued replies and prevents sends after in-flight generation', async (t) => {
  const { manager, calls, brain } = fixture(t);
  let release;
  brain.reply = async () => new Promise((resolve) => { release = resolve; });
  manager.enqueueIncomingMessage(msg());
  const pending = manager.flush();
  await new Promise((resolve) => setImmediate(resolve));
  manager.dispose();
  release({ text: 'must not send' });
  await pending;
  manager.enqueueIncomingMessage(msg({ messageId: 'new' }));
  assert.equal(manager.batchQueue.size, 0);
  assert.equal(calls.sent.length, 0);
});

test('official replies preserve source message id, without claiming an inbound subscription', async (t) => {
  const { manager, calls } = fixture(t);
  manager.enqueueIncomingMessage(msg({ channel: 'official', userId: 'owner-openid', messageId: 'official-id' }));
  await manager.flush();
  assert.equal(calls.sent[0][0], 'official:c2c:owner-openid');
  assert.deepEqual(calls.sent[0][2], { messageId: 'official-id' });
  assert.equal(calls.replies[0].isOwner, true);
});

test('simultaneous catchup requests share one send and acknowledge source timestamp', async (t) => {
  const { manager, calls, gateway } = fixture(t);
  const time = Date.now() - 1000;
  manager.saveState({ lastProcessedTime: time - 1000 });
  gateway.fetchFriendHistory = async () => {
    calls.history++;
    await new Promise((resolve) => setImmediate(resolve));
    return { ok: true, messages: [msg({ time })], coverage: { complete: true } };
  };
  await Promise.all([manager.catchUpUnreadMessages(), manager.catchUpUnreadMessages()]);
  assert.equal(calls.history, 1);
  assert.equal(calls.sent.length, 1);
  assert.equal(manager.state.lastProcessedTime, time);
  await manager.catchUpUnreadMessages();
  assert.equal(calls.sent.length, 1);
});


test('initial watermark uses the same second precision as OneBot history', async (t) => {
  const realNow = Date.now;
  Date.now = () => 1700000000123;
  let setup;
  try { setup = fixture(t); } finally { Date.now = realNow; }
  const { manager, gateway, calls } = setup;
  assert.equal(manager.state.lastProcessedTime, 1700000000000);
  gateway.fetchFriendHistory = async () => ({ ok: true, messages: [msg({ time: 1700000000000 })], coverage: { complete: true } });
  await manager.catchUpUnreadMessages();
  assert.equal(calls.sent.length, 1, 'failed/unhandled message in startup second remains recoverable');
});
