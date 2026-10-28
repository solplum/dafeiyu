import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { NativeOneBotBridge } from '../packages/dsh-dafeiyu/src/native-onebot.js';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';
import { buildHostPrompt } from '../packages/dsh-dafeiyu/src/native-context.js';

const yes = () => true;
const a = { accountId: '20002', identityId: 'default' }, b = { accountId: '30003', identityId: 'default' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'life-memory-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clock = { value: Date.parse('2026-10-24T10:00:00Z') };
  const life = new LifeMemory({ directory, now: () => clock.value });
  return { life, directory, clock, event: (id, scope = a, userText = '今天面试，下午三点等结果') => ({ phase: 'received', messageId: String(id), scope, selfId: '10001', userText }) };
}

test('automatic recording is opt-in, side effect free on reads and authorization bound', (t) => {
  const f = fixture(t); assert.equal(f.life.snapshot().total, 0); assert.equal(fs.existsSync(f.life.store.file), false);
  assert.equal(f.life.capture(f.event(1), { authorize: yes }).skipped, true);
  assert.throws(() => f.life.configure({ learningEnabled: true }, { authorize: () => false }), { code: 'FORBIDDEN' });
  f.life.configure({ learningEnabled: true }, { authorize: yes });
  assert.throws(() => f.life.capture(f.event(1), { authorize: () => false }), { code: 'FORBIDDEN' });
  assert.equal(f.life.snapshot().total, 0);
});

test('messages survive restart exactly once and memories stay scoped by account and identity', (t) => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1), { authorize: yes }); f.life.capture(f.event(1, b, 'PRIVATE_B_CANARY'), { authorize: yes });
  f.life.capture(f.event(2, { ...a, identityId: 'other' }, 'OTHER_ID_CANARY'), { authorize: yes });
  const reload = new LifeMemory({ directory: f.directory }); reload.capture(f.event(1), { authorize: yes });
  assert.equal(reload.snapshot().total, 3);
  assert.ok(reload.context(a).includes('今天面试')); assert.ok(!reload.context(a).includes('PRIVATE_B_CANARY'));
  assert.ok(!reload.context(a).includes('OTHER_ID_CANARY')); assert.equal(reload.context({}), '');
});

test('outcome updates never equate an assistant statement or failed delivery with a completed action', (t) => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1), { authorize: yes });
  f.life.capture({ ...f.event(1), phase: 'failed', assistantText: '我已经修改电脑了' }, { authorize: yes });
  f.life.capture({ ...f.event(1), phase: 'completed' }, { authorize: yes });
  assert.equal(f.life.snapshot().items[0].outcome, 'failed');
  assert.match(f.life.context(a), /助手回复不证明操作完成/);
});

test('CAS, storage corruption and an interrupted writer never silently discard memory', (t) => {
  const f = fixture(t), revision = f.life.snapshot().revision;
  f.life.configure({ learningEnabled: true }, { authorize: yes, revision });
  assert.throws(() => f.life.configure({ learningEnabled: false }, { authorize: yes, revision }), { code: 'CONFLICT' });
  fs.mkdirSync(f.life.store.lock);
  assert.throws(() => f.life.capture(f.event(1), { authorize: yes }), { code: 'BUSY' }); fs.rmdirSync(f.life.store.lock);
  fs.writeFileSync(f.life.store.file, '{broken');
  assert.equal(f.life.observe(f.event(1), { authorize: yes }).ok, false);
  assert.equal(fs.readFileSync(f.life.store.file, 'utf8'), '{broken');
});

test('real OneBot lifecycle records both users while guest tool isolation and fixed replies remain intact', async (t) => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  const listeners = new Map(), prompts = [], restrictions = [], sent = [];
  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args); };
  let bridge; const privateBridge = new MemoryBridge({ projectRoot: f.directory, ownerQq: a.accountId });
  const services = { agentDefaultModel: { currentSelection: () => ({ provider: 'offline', model: 'fixture' }) },
    agentPresets: { mount: async () => {} }, agents: { withoutInitiator: (fn) => fn(), create: async (options) => {
      let mode = 'ptc';
      const tools = { guard() {}, restrict(value) { restrictions.push(value); }, schemas: () => [{ name: 'dafeiyu_experience_search' }, { name: 'dafeiyu_experience_update' }, { name: 'bash' }], modeFor: () => mode, presentAs(value) { mode = value; } };
      const agent = { session: { id: options.sessionId }, ctx: { get: (key) => key === 'tools' ? tools : services[key] }, cancel() {},
        followup(message) {
          prompts.push(buildHostPrompt(privateBridge, { agent }, { ownerQq: a.accountId, onebotManager: bridge, lifeMemory: f.life }));
          const turn = 1;
          emit('session/event', agent.session, { type: 'turn/start', data: { turn } });
          emit('agent/inbox/claimed', { agent, message, turn });
          emit('session/event', agent.session, { type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { content: [{ type: 'text', text: '收到你的面试消息' }] } } });
          emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
        } };
      await options.setup(agent.ctx, agent); return { agent, dispose() {} };
    } } };
  bridge = new NativeOneBotBridge({ ctx: { get: (key) => services[key], on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn);
  } }, ownerQq: a.accountId, qqAccounts: [a, b].map((s) => ({ qq: s.accountId, name: '测试账号', enabled: true, activeIdentityId: 'default', identities: [{ id: 'default', name: '默认身份', relationType: 'existing', userRole: '', companionRole: '', userTitle: '', companionTitle: '', description: '' }] })), expectedSelfId: '10001',
  qqGateway: { connected: true, online: true, loginVerified: true, selfId: '10001', async sendMessage(target) { sent.push(target); return { ok: true }; } },
  onExperience: (event, options) => f.life.observe(event, options) });
  t.after(() => bridge.dispose());
  for (const [scope, id, text] of [[a, 1, 'OWNER_EXPERIENCE_CANARY'], [b, 2, 'GUEST_EXPERIENCE_CANARY']]) {
    const time = Math.floor(Date.now() / 1000);
    assert.equal((await bridge.handleIncoming({ channel: 'onebot', selfId: '10001', userId: scope.accountId, messageId: String(id),
      messageType: 'private', isGroup: false, groupId: null, text, time: time * 1000,
      raw: { post_type: 'message', message_type: 'private', self_id: 10001, user_id: Number(scope.accountId), message_id: id, time } })).ok, true);
  }
  assert.equal(f.life.snapshot().total, 2); assert.ok(f.life.snapshot().items.every((row) => row.outcome === 'completed'));
  assert.ok(prompts[0].includes('OWNER_EXPERIENCE_CANARY')); assert.ok(prompts[1].includes('GUEST_EXPERIENCE_CANARY'));
  assert.ok(!prompts[1].includes('OWNER_EXPERIENCE_CANARY')); assert.deepEqual(restrictions, [{ allow: ['dafeiyu_experience_search', 'dafeiyu_experience_update'] }]);
  assert.deepEqual(sent, ['private:20002', 'private:30003']);
});

test('age changes detail to summary, pinned/pending stay clear and reads do not reinforce', (t) => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1, a, '面试的具体经过'.repeat(40) + 'DETAIL_TAIL_CANARY'), { authorize: yes });
  const id = f.life.snapshot().items[0].id, revision = f.life.snapshot().revision;
  f.clock.value += 10 * 86400000;
  assert.equal(f.life.snapshot().items[0].clarity, 'summary');
  assert.ok(!f.life.context(a).includes('DETAIL_TAIL_CANARY'));
  f.life.context(a); f.life.context(a); assert.equal(f.life.snapshot().revision, revision);
  f.clock.value += 40 * 86400000; assert.equal(f.life.context(a), '');
  f.life.manage('pin', { id, value: true }, { scope: a, authorize: yes });
  assert.equal(f.life.snapshot().items[0].clarity, 'clear');
  f.life.manage('pin', { id, value: false }, { scope: a, authorize: yes });
  f.life.manage('pending', { id, value: true }, { scope: a, authorize: yes });
  assert.equal(f.life.snapshot().items[0].clarity, 'clear');
});

test('correction, undo and real deletion cover history, summaries and replay tombstones', (t) => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1, a, 'DELETE_SECRET_CANARY'), { authorize: yes }); const id = f.life.snapshot().items[0].id;
  assert.throws(() => f.life.manage('correct', { id, detail: 'wrong scope' }, { scope: b, authorize: yes }), { code: 'NOT_FOUND' });
  f.life.manage('correct', { id, detail: 'CORRECTED_SECRET_CANARY' }, { scope: a, authorize: yes });
  f.life.manage('restore', { id }, { scope: a, authorize: yes }); assert.match(f.life.context(a), /DELETE_SECRET_CANARY/);
  f.life.manage('delete', { id }, { scope: a, authorize: yes });
  assert.ok(!fs.readFileSync(f.life.store.file, 'utf8').includes('SECRET_CANARY'));
  assert.equal(f.life.snapshot().total, 0);
  f.life.capture(f.event(1), { authorize: yes }); assert.equal(f.life.snapshot().total, 0);
});

test('ordinary detail really compacts and later recall cannot invent the lost detail', (t) => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1, a, '很久以前的普通聊天'.repeat(30) + 'OLD_DETAIL_TAIL_CANARY'), { authorize: yes });
  f.clock.value += 10 * 86400000; f.life.consolidate({ authorize: yes });
  const row = f.life.snapshot().items[0]; assert.equal(row.compacted, true); assert.ok(!row.detail.includes('OLD_DETAIL_TAIL_CANARY'));
  f.life.manage('pin', { id: row.id, value: true }, { scope: a, authorize: yes });
  assert.equal(f.life.snapshot().items[0].clarity, 'summary');
  f.life.manage('correct', { id: row.id, detail: '用户补充了新的完整说明' }, { scope: a, authorize: yes });
  assert.equal(f.life.snapshot().items[0].clarity, 'clear');
});

test('legacy real deletion removes raw facts, archive or events while preserving survivor corrections', (t) => {
  for (const source of ['memory/facts.json', 'memory/user.md', 'memory/timeline.md']) {
    const f = fixture(t), bridge = new MemoryBridge({ projectRoot: f.directory, ownerQq: a.accountId });
    bridge.remember({ summary: '原始秘密', detail: 'DELETE_RAW_SECRET_CANARY' });
    bridge.remember({ summary: '保留事实', detail: 'KEEP_RAW_CANARY' });
    fs.writeFileSync(bridge.userMdPath, '# 删除档案\nDELETE_RAW_SECRET_CANARY\n# 保留档案\nKEEP_ARCHIVE_CANARY\n');
    bridge.remember({ kind: 'event', summary: '删除事件', detail: 'DELETE_RAW_SECRET_CANARY' });
    bridge.remember({ kind: 'event', summary: '保留事件', detail: 'KEEP_EVENT_CANARY' });
    let snapshot = bridge.snapshot();
    const target = snapshot.items.find((row) => row.source === source && row.detail.includes('DELETE_RAW_SECRET_CANARY'));
    const survivor = snapshot.items.find((row) => row.source === source && row.detail.includes('KEEP_'));
    bridge.correct({ id: survivor.id, revision: snapshot.revision, summary: '保留纠正', detail: 'KEEP_CORRECTION_CANARY' });
    snapshot = bridge.snapshot();
    bridge.correct({ id: target.id, revision: snapshot.revision, summary: '秘密纠正', detail: 'DELETE_OVERLAY_SECRET_CANARY' });
    bridge.delete({ id: target.id, revision: bridge.snapshot().revision }, { authorize: yes });
    const file = source === 'memory/facts.json' ? bridge.factsPath : source === 'memory/user.md' ? bridge.userMdPath : bridge.timelineMdPath;
    assert.ok(!fs.readFileSync(file, 'utf8').includes('DELETE_RAW_SECRET_CANARY'));
    assert.ok(!fs.readFileSync(bridge.overlayPath, 'utf8').includes('DELETE_OVERLAY_SECRET_CANARY'));
    assert.equal(bridge.searchMemories('KEEP_CORRECTION_CANARY').total, 1);
    assert.equal(bridge.snapshot().items.length, 5);
  }
});

test('an interrupted legacy deletion blocks recall rather than resurrecting a partial old view', (t) => {
  const f = fixture(t), bridge = new MemoryBridge({ projectRoot: f.directory });
  bridge.remember({ summary: '待删除', detail: 'DELETE_INTERRUPTED_CANARY' });
  const row = bridge.snapshot().items[0]; let calls = 0;
  assert.throws(() => bridge.delete({ id: row.id, revision: bridge.snapshot().revision }, { authorize: () => ++calls < 5 }));
  assert.throws(() => bridge.snapshot(), { code: 'DELETE_PENDING' });
  assert.throws(() => bridge.searchMemories('CANARY'), { code: 'DELETE_PENDING' });
  assert.equal(bridge.resumeDelete({ confirmed: true }, { authorize: yes }).deleted, true);
  assert.equal(bridge.searchMemories('DELETE_INTERRUPTED_CANARY').total, 0);
  assert.ok(!fs.readFileSync(bridge.factsPath, 'utf8').includes('DELETE_INTERRUPTED_CANARY'));
});

test('recall excludes inactive rows before pagination and retains the management view for undo', t => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1, a, 'ACTIVE_OLD_CANARY'), { authorize: yes });
  const first = f.life.snapshot().items[0].id;
  for (let id = 2; id <= 13; id++) {
    f.life.capture(f.event(id, a, 'INACTIVE_NEW_CANARY'), { authorize: yes });
    f.life.manage('forget', { id: f.life.snapshot().items[0].id }, { scope: a, authorize: yes });
  }
  f.life.capture(f.event(14, b, 'OTHER_ACCOUNT_CANARY'), { authorize: yes });
  f.life.capture(f.event(15, { ...a, identityId: 'other' }, 'OTHER_IDENTITY_CANARY'), { authorize: yes });
  const before = fs.readFileSync(f.life.store.file), recalled = f.life.recall(a, { limit: 10 });
  assert.equal(recalled.total, 1); assert.deepEqual(recalled.items.map(row => row.id), [first]);
  assert.equal(recalled.truncated, false); assert.doesNotMatch(JSON.stringify(recalled), /INACTIVE_|OTHER_|history|assistantText/);
  assert.equal(f.life.snapshot({ ...a, limit: 50 }).total, 13);
  assert.deepEqual(fs.readFileSync(f.life.store.file), before);
});

test('recall and automatic context query only the age-visible projection without resurrecting stored old detail', t => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1, a, 'VISIBLE_SUMMARY_CANARY '.repeat(10) + 'HIDDEN_DETAIL_CANARY'), { authorize: yes });
  assert.equal(f.life.recall(a, { query: 'HIDDEN_DETAIL_CANARY' }).total, 1);
  f.clock.value += 10 * 86400000;
  const before = fs.readFileSync(f.life.store.file);
  assert.equal(f.life.recall(a, { query: 'HIDDEN_DETAIL_CANARY' }).total, 0);
  const summary = f.life.recall(a, { query: 'VISIBLE_SUMMARY_CANARY' });
  assert.equal(summary.total, 1); assert.equal(summary.items[0].clarity, 'summary');
  assert.equal(summary.items[0].detail, summary.items[0].summary); assert.equal(summary.items[0].detailOmitted, true);
  assert.doesNotMatch(JSON.stringify(summary), /HIDDEN_DETAIL_CANARY/);
  f.clock.value += 30 * 86400000;
  assert.equal(f.life.context(a, { query: 'HIDDEN_DETAIL_CANARY' }), '');
  assert.match(f.life.context(a, { query: 'VISIBLE_SUMMARY_CANARY' }), /VISIBLE_SUMMARY_CANARY/);
  assert.deepEqual(fs.readFileSync(f.life.store.file), before);
});

test('restoring changed memory invalidates derived growth and scheduled autonomous topics without changing unknown execution', t => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1, a, '原始偏好'), { authorize: yes }); const id = f.life.snapshot().items[0].id;
  f.life.manage('correct', { id, detail: '后来偏好' }, { scope: a, authorize: yes });
  f.life.store.update(state => {
    state.growth.push({ id: 'synthetic-growth', scope: a, evidence: [id], status: 'applied' });
    state.autonomy = { policy: {}, activities: ['scheduled', 'running', 'unknown'].map((status, index) => ({
      id: 'synthetic-activity-' + index, scope: a, sourceId: id, status, topic: 'STALE_TOPIC_CANARY' })), awaitingReply: [] };
  }, { authorize: yes });
  f.life.manage('restore', { id }, { scope: a, authorize: yes });
  const state = f.life.store.read().state;
  assert.equal(state.memories[0].detail, '原始偏好'); assert.deepEqual(state.growth, []);
  assert.deepEqual(state.autonomy.activities.map(row => row.status), ['skipped', 'running', 'unknown']);
  assert.ok(state.autonomy.activities.every(row => row.topic === ''));
  assert.equal(state.autonomy.nextAt, f.clock.value + 30 * 60_000);
});

test('full memory receives a new message after fading while preserving fixed promises, growth evidence and replay tombstones', t => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1, a, 'OLD_CAPTURE_CANARY'), { authorize: yes }); const original = f.life.snapshot().items[0];
  f.life.store.update(state => {
    state.memories = Array.from({ length: 5000 }, (_, index) => ({ ...original,
      id: index < 3 ? String(index + 1).padStart(64, '0') : index === 3 ? original.id : String(index + 1).padStart(64, '0'),
      pinned: index === 0, pending: index === 1, at: '2026-01-01T00:00:00.000Z', history: [] }));
    state.seen = state.memories.map(row => row.id);
    state.growth = [{ id: 'retained-growth', scope: a, status: 'applied', evidence: [state.memories[2].id] }];
    state.autonomy = { policy: {}, awaitingReply: [], activities: [{ id: 'old-candidate', scope: a,
      status: 'scheduled', topic: 'OLD_CAPTURE_CANARY', sourceId: original.id }] };
  }, { authorize: yes });
  const seen = f.life.store.read().state.seen;
  assert.equal(f.life.capture(f.event(99999, a, 'NEW_CAPTURE_CANARY'), { authorize: yes }).result.saved, true);
  const state = f.life.store.read().state;
  assert.equal(state.memories.length, 4001); assert.ok(state.memories.some(row => row.pinned));
  assert.ok(state.memories.some(row => row.pending)); assert.equal(state.growth.length, 1);
  assert.ok(state.memories.some(row => row.id === state.growth[0].evidence[0]));
  assert.ok(seen.every(id => state.seen.includes(id))); assert.equal(state.autonomy.activities[0].status, 'skipped');
  assert.equal(state.autonomy.activities[0].topic, ''); assert.equal(state.memories.some(row => row.id === original.id), false);
  assert.equal(f.life.capture(f.event(1), { authorize: yes }).result.duplicate, true);
  assert.equal(f.life.snapshot().total, 4001);
});

test('full protected memory fails atomically instead of evicting retained promises or inserting a replay proof', t => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1), { authorize: yes }); const original = f.life.snapshot().items[0];
  f.life.store.update(state => {
    state.memories = Array.from({ length: 5000 }, (_, index) => ({ ...original, id: String(index + 1).padStart(64, '0'),
      pending: true, at: '2026-01-01T00:00:00.000Z', history: [] }));
    state.seen = state.memories.map(row => row.id);
  }, { authorize: yes });
  const before = fs.readFileSync(f.life.store.file);
  assert.throws(() => f.life.capture(f.event(99999), { authorize: yes }), { code: 'LIMIT' });
  assert.deepEqual(fs.readFileSync(f.life.store.file), before);
  assert.equal(f.life.snapshot().total, 5000);
});

for (const protectedGrowth of [false, true]) test('live rehearsal cannot resurrect expired detail' + (protectedGrowth ? ' retained as growth evidence' : ''), t => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1, a, 'coffee_plan SUMMARY '.repeat(12) + 'EXPIRED_DETAIL_CANARY'), { authorize: yes });
  const id = f.life.snapshot().items[0].id;
  if (protectedGrowth) f.life.store.update(state => {
    state.growth = [{ id: 'protected-growth', scope: a, status: 'applied', evidence: [id] }];
  }, { authorize: yes });
  f.clock.value += 10 * 86400000;
  f.life.capture(f.event(2, a, 'coffee_plan'), { authorize: yes });
  const row = f.life.snapshot().items.find(item => item.id === id);
  assert.equal(row.lastRecalledAt, new Date(f.clock.value).toISOString());
  assert.equal(row.compacted, true); assert.equal(row.clarity, 'summary');
  assert.equal(row.detail.includes('EXPIRED_DETAIL_CANARY'), protectedGrowth, 'growth may keep raw evidence but cannot expose it as clear recall');
  assert.equal(f.life.recall(a, { query: 'EXPIRED_DETAIL_CANARY' }).total, 0);
  assert.doesNotMatch(f.life.context(a, { query: 'coffee_plan' }), /EXPIRED_DETAIL_CANARY/);
  assert.equal(f.life.snapshot().growth.length, protectedGrowth ? 1 : 0);
});

test('explicit rehearsal also compacts aged detail before refreshing its recall timestamp while pinned details remain clear', t => {
  const f = fixture(t); f.life.configure({ learningEnabled: true }, { authorize: yes });
  f.life.capture(f.event(1, a, 'aged_topic SUMMARY '.repeat(12) + 'EXPLICIT_EXPIRED_DETAIL'), { authorize: yes });
  const id = f.life.snapshot().items[0].id;
  f.life.capture(f.event(2, a, 'PINNED_DETAIL_CANARY'), { authorize: yes });
  const pinned = f.life.snapshot().items[0].id;
  f.life.manage('pin', { id: pinned, value: true }, { scope: a, authorize: yes });
  f.clock.value += 10 * 86400000;
  f.life.capture(f.event(3, a, '独立的新消息'), { authorize: yes }); const sourceMessageId = f.life.snapshot().items[0].id;
  for (const target of [id, pinned]) f.life.manage('rehearse', { id: target, sourceMessageId }, { scope: a, authorize: yes });
  const rows = f.life.snapshot().items;
  assert.equal(rows.find(row => row.id === id).clarity, 'summary');
  assert.doesNotMatch(JSON.stringify(f.life.recall(a)), /EXPLICIT_EXPIRED_DETAIL/);
  assert.equal(rows.find(row => row.id === pinned).clarity, 'clear');
  assert.match(JSON.stringify(f.life.recall(a)), /PINNED_DETAIL_CANARY/);
});
