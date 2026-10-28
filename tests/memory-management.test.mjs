import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryBridge, MemoryStoreError } from '../packages/dsh-dafeiyu/src/memory-bridge.js';
import { MemoryPanelController, MemoryPanelError } from '../packages/dsh-dafeiyu/src/memory-panel.js';
import { NativeCompanionTools } from '../packages/dsh-dafeiyu/src/native-companion-tools.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = new MemoryBridge({ projectRoot: root, ownerQq: '10001', ownerOpenId: 'fixture-owner-openid' });
  fs.mkdirSync(bridge.memoryDir);
  const archive = '# 本人档案\nOLD_ARCHIVE_CANARY 喜欢冷饮\n\n# 散步\n周末喜欢公园。\n';
  const timeline = '\n---\n\n### [2020-01-02] 旧事件\n- **详情**：OLD_EVENT_CANARY 曾约定周五见面。\n';
  fs.writeFileSync(bridge.userMdPath, archive); fs.writeFileSync(bridge.timelineMdPath, timeline);
  return { bridge, archive, timeline, root };
}
const archiveRecord = (bridge) => bridge.snapshot().items.find((record) => record.detail.includes('OLD_ARCHIVE_CANARY'));
const mutate = (bridge, action, id, values = {}, options) => bridge[action]({ id, revision: bridge.snapshot().revision, ...values }, options);
function toolsFor(bridge, { identity = { isOwner: true, scope: 'c2c', peerId: '10001', sessionId: 'verified-session',
  accountProfile: { identity: { id: 'identity-a' } } }, writable = true } = {}) {
  const definitions = new Map();
  const tools = new NativeCompanionTools({ memoryBridge: bridge, allowMemoryWrites: writable,
    getExecutionContext: () => identity, memeManager: { listMemes: () => [] } });
  tools.registerToCordis({ tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } } });
  return { tools, definitions, identity };
}

test('construction and management reads never migrate archives or create an overlay; legacy IDs survive unrelated appends', (t) => {
  const { bridge, archive, timeline } = fixture(t);
  const snapshot = bridge.snapshot(), old = archiveRecord(bridge), event = snapshot.items.find((record) => record.kind === 'event');
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/); assert.ok(old.id.startsWith('archive:')); assert.ok(event.id.startsWith('event:'));
  assert.equal(fs.existsSync(bridge.overlayPath), false);
  assert.equal(fs.readFileSync(bridge.userMdPath, 'utf8'), archive); assert.equal(fs.readFileSync(bridge.timelineMdPath, 'utf8'), timeline);
  bridge.remember({ kind: 'event', summary: '后来事件', detail: '新增内容' });
  assert.equal(archiveRecord(bridge).id, old.id);
  assert.ok(bridge.snapshot().items.some((record) => record.id === event.id));
  assert.ok(fs.readFileSync(bridge.timelineMdPath, 'utf8').startsWith(timeline));
});

test('archive correction and forgetting uniformly filter search, snapshots and automatic prompts without rewriting the source', (t) => {
  const { bridge, archive } = fixture(t), old = archiveRecord(bridge);
  const corrected = mutate(bridge, 'correct', old.id, { summary: '更新偏好', detail: 'NEW_CORRECTED_CANARY 喜欢热水' });
  assert.equal(corrected.record.id, old.id); assert.equal(corrected.record.status, 'active'); assert.equal(corrected.record.canRestore, true);
  assert.equal(bridge.searchMemories('OLD_ARCHIVE_CANARY').total, 0);
  assert.equal(bridge.snapshot({ query: 'OLD_ARCHIVE_CANARY' }).total, 0);
  assert.doesNotMatch(bridge.buildSystemPrompt('', { isOwner: true }), /OLD_ARCHIVE_CANARY/);
  assert.match(bridge.buildSystemPrompt('', { isOwner: true }), /NEW_CORRECTED_CANARY/);
  const forgotten = mutate(bridge, 'forget', old.id, { reason: '用户要求忘掉' });
  assert.equal(forgotten.record.status, 'forgotten'); assert.equal(bridge.searchMemories('NEW_CORRECTED_CANARY').total, 0);
  assert.doesNotMatch(bridge.buildSystemPrompt('', { isOwner: true }), /NEW_CORRECTED_CANARY/);
  assert.equal(bridge.snapshot({ status: 'forgotten' }).items[0].id, old.id);
  assert.match(forgotten.note, /历史聊天.*未被擦除/);
  assert.equal(fs.readFileSync(bridge.userMdPath, 'utf8'), archive);
  assert.equal(fs.statSync(bridge.overlayPath).mode & 0o777, 0o600);
});

test('restore undoes correction and forgetting in operation order and refuses an empty undo stack', (t) => {
  const { bridge } = fixture(t), old = archiveRecord(bridge);
  mutate(bridge, 'correct', old.id, { summary: '新的偏好', detail: 'NEW_PREFERENCE' });
  mutate(bridge, 'forget', old.id);
  let restored = mutate(bridge, 'restore', old.id);
  assert.equal(restored.record.status, 'active'); assert.equal(restored.record.detail, 'NEW_PREFERENCE');
  restored = mutate(bridge, 'restore', old.id);
  assert.match(restored.record.detail, /OLD_ARCHIVE_CANARY/); assert.equal(restored.record.canRestore, false);
  assert.deepEqual(restored.record.history.map((item) => item.action), ['correct', 'forget', 'restore', 'restore']);
  assert.throws(() => mutate(bridge, 'restore', old.id), { code: 'NOT_UNDOABLE' });
});

test('same-key fact updates are reversible and do not rewrite the previously stored fact bytes', (t) => {
  const { bridge } = fixture(t);
  const first = bridge.remember({ key: 'drink', summary: '饮品', detail: 'FIRST_DRINK' });
  const original = fs.readFileSync(bridge.factsPath, 'utf8');
  const next = bridge.remember({ key: 'drink', summary: '饮品变化', detail: 'SECOND_DRINK' });
  assert.equal(next.id, first.id); assert.equal(next.recordId, first.recordId);
  assert.equal(bridge.readFacts().length, 1); assert.equal(bridge.searchMemories('FIRST_DRINK').total, 0);
  assert.equal(bridge.searchMemories('SECOND_DRINK').total, 1); assert.equal(fs.readFileSync(bridge.factsPath, 'utf8'), original);
  mutate(bridge, 'restore', first.recordId);
  assert.equal(bridge.searchMemories('FIRST_DRINK').total, 1); assert.equal(bridge.searchMemories('SECOND_DRINK').total, 0);
});

test('new events have persistent stable IDs and legacy events can be corrected through the overlay', (t) => {
  const { bridge, timeline } = fixture(t);
  const saved = bridge.remember({ kind: 'event', summary: '新增约定', detail: 'NEW_EVENT_CANARY' });
  const reloaded = new MemoryBridge({ projectRoot: bridge.projectRoot, ownerQq: '10001' });
  assert.equal(reloaded.searchMemories('NEW_EVENT_CANARY').matches[0].id, saved.id);
  const old = bridge.searchMemories('OLD_EVENT_CANARY').matches[0];
  mutate(bridge, 'correct', old.id, { summary: '取消约定', detail: '该见面安排已经取消' });
  assert.equal(bridge.searchMemories('OLD_EVENT_CANARY').total, 0);
  assert.doesNotMatch(bridge.buildSystemPrompt('', { isOwner: true }), /OLD_EVENT_CANARY/);
  assert.ok(fs.readFileSync(bridge.timelineMdPath, 'utf8').startsWith(timeline));
});

test('common preferences share an account while same-key fictional facts stay isolated to the current identity', (t) => {
  const { bridge } = fixture(t);
  bridge.remember({ key: 'drink', summary: '本人偏好', detail: 'COMMON_OWNER_PREFERENCE' }, { actor: 'tool' });
  bridge.remember({ key: 'drink', scope: 'identity', summary: '身份 A', detail: 'IDENTITY_A_CANARY' }, { context: { identityId: 'a' }, actor: 'tool' });
  bridge.remember({ key: 'drink', scope: 'identity', summary: '身份 B', detail: 'IDENTITY_B_CANARY' }, { context: { identityId: 'b' }, actor: 'tool' });
  for (const identityId of ['a', 'b']) {
    const memoryContext = { accountId: bridge.accountId, identityId };
    const search = bridge.searchMemories('CANARY', { memoryContext });
    assert.equal(search.matches.some((record) => record.detail.includes(`IDENTITY_${identityId.toUpperCase()}_CANARY`)), true);
    assert.equal(search.matches.some((record) => record.detail.includes(`IDENTITY_${identityId === 'a' ? 'B' : 'A'}_CANARY`)), false);
    const prompt = bridge.buildSystemPrompt('', { isOwner: true, memoryContext });
    assert.match(prompt, /COMMON_OWNER_PREFERENCE|OLD_ARCHIVE_CANARY/);
    assert.ok(prompt.includes(`IDENTITY_${identityId.toUpperCase()}_CANARY`));
    assert.ok(!prompt.includes(`IDENTITY_${identityId === 'a' ? 'B' : 'A'}_CANARY`));
  }
  assert.equal(bridge.searchMemories('IDENTITY_').total, 0, 'unknown identity cannot read identity-scoped records');
  assert.equal(bridge.snapshot({ scope: 'identity' }).total, 2);
  assert.equal(bridge.searchMemories('COMMON_OWNER_PREFERENCE', { memoryContext: { accountId: 'other' } }).total, 0);
});

test('inferences remain unconfirmed even when a confirmation flag is supplied, until an explicit owner correction', (t) => {
  const { bridge } = fixture(t);
  const saved = bridge.remember({ summary: '模型推测', detail: 'INFERENCE_CANARY', sourceType: 'inference' }, { actor: 'tool' });
  assert.equal(saved.status, 'unconfirmed'); assert.equal(saved.provenance.confirmed, false);
  assert.equal(bridge.searchMemories('INFERENCE_CANARY').total, 0);
  assert.doesNotMatch(bridge.buildSystemPrompt('', { isOwner: true }), /INFERENCE_CANARY/);
  const inferred = mutate(bridge, 'correct', saved.recordId, { summary: '仍是推断', detail: 'UNCONFIRMED_CANARY', sourceType: 'inference', confirmed: true });
  assert.equal(inferred.record.status, 'unconfirmed'); assert.equal(inferred.record.provenance.confirmed, false);
  const confirmed = mutate(bridge, 'correct', saved.recordId, { summary: '用户已确认', detail: 'CONFIRMED_CANARY', sourceType: 'user_explicit', confirmed: true });
  assert.equal(confirmed.record.provenance.actor, 'panel'); assert.equal(bridge.searchMemories('CONFIRMED_CANARY').total, 1);
});

test('unconfirmed user-declared legacy data is excluded and forged active/unconfirmed overlays fail closed', (t) => {
  const { bridge } = fixture(t);
  bridge.remember({ key: 'pending-user', summary: '待确认', detail: 'UNCONFIRMED_USER_CANARY' }, { actor: 'tool' });
  const base = JSON.parse(fs.readFileSync(bridge.factsPath, 'utf8'));
  base.facts[0].provenance.confirmed = false;
  fs.writeFileSync(bridge.factsPath, JSON.stringify(base));
  assert.equal(bridge.searchMemories('UNCONFIRMED_USER_CANARY').total, 0);
  assert.equal(bridge.snapshot({ status: 'unconfirmed' }).items[0].detail, 'UNCONFIRMED_USER_CANARY');
  const old = archiveRecord(bridge);
  mutate(bridge, 'correct', old.id, { summary: '待确认推断', detail: 'PENDING_OVERLAY', sourceType: 'inference' });
  const overlay = JSON.parse(fs.readFileSync(bridge.overlayPath, 'utf8'));
  overlay.entries[old.id].current.status = 'active';
  fs.writeFileSync(bridge.overlayPath, JSON.stringify(overlay));
  assert.throws(() => bridge.snapshot(), { code: 'INVALID_MEMORY' });
  assert.doesNotMatch(bridge.buildSystemPrompt('', { isOwner: true }), /PENDING_OVERLAY|OLD_ARCHIVE_CANARY/);
});

test('global CAS notices any original-source change and prevents stale corrections before creating an overlay', (t) => {
  const { bridge } = fixture(t), record = archiveRecord(bridge), revision = bridge.snapshot().revision;
  fs.appendFileSync(bridge.timelineMdPath, '\n新的外部记录\n');
  assert.throws(() => bridge.correct({ id: record.id, revision, summary: 'new', detail: 'new' }), { code: 'CONFLICT' });
  assert.equal(fs.existsSync(bridge.overlayPath), false); assert.equal(fs.existsSync(bridge.lockPath), false);
});

test('a conflicting source edit at commit time cannot be overwritten by a prepared correction', (t) => {
  const { bridge } = fixture(t), record = archiveRecord(bridge); let checks = 0;
  assert.throws(() => mutate(bridge, 'correct', record.id, { summary: 'new', detail: 'new' }, { authorize() {
    checks++; if (checks === 3) fs.appendFileSync(bridge.timelineMdPath, '\n外部编辑\n'); return true;
  } }), { code: 'CONFLICT' });
  assert.equal(fs.existsSync(bridge.overlayPath), false);
  assert.equal(fs.existsSync(bridge.lockPath), false); assert.deepEqual(fs.readdirSync(bridge.memoryDir).filter((name) => name.endsWith('.tmp')), []);
});

test('empty, malformed and invalid overlays fail closed without exposing original facts or rewriting damage', (t) => {
  const { bridge } = fixture(t);
  for (const contents of ['', ' ', '{INVALID_OVERLAY_CANARY', JSON.stringify({ version: 1, entries: { bad: {} } })]) {
    fs.writeFileSync(bridge.overlayPath, contents);
    assert.throws(() => bridge.snapshot(), { code: 'INVALID_MEMORY' });
    assert.throws(() => bridge.searchMemories('OLD_ARCHIVE_CANARY'), { code: 'INVALID_MEMORY' });
    assert.throws(() => bridge.remember({ summary: 'new', detail: 'new' }), { code: 'INVALID_MEMORY' });
    const prompt = bridge.buildSystemPrompt('', { isOwner: true });
    assert.match(prompt, /共享记忆读取失败/); assert.doesNotMatch(prompt, /OLD_ARCHIVE_CANARY|INVALID_OVERLAY_CANARY/);
    assert.equal(fs.readFileSync(bridge.overlayPath, 'utf8'), contents); assert.equal(fs.existsSync(bridge.lockPath), false);
  }
});

test('external edits to a corrected original stop retrieval rather than silently resurrecting its raw text', (t) => {
  const { bridge } = fixture(t), record = archiveRecord(bridge);
  mutate(bridge, 'forget', record.id);
  fs.writeFileSync(bridge.userMdPath, '# 本人档案\nCHANGED_ORIGINAL_CANARY\n');
  assert.throws(() => bridge.searchMemories('CHANGED_ORIGINAL_CANARY'), { code: 'CONFLICT' });
  assert.doesNotMatch(bridge.buildSystemPrompt('', { isOwner: true }), /CHANGED_ORIGINAL_CANARY|OLD_ARCHIVE_CANARY/);
});

test('the shared memory write lock excludes both management and normal writers', (t) => {
  const { bridge } = fixture(t), record = archiveRecord(bridge);
  fs.mkdirSync(bridge.lockPath);
  assert.throws(() => mutate(bridge, 'forget', record.id), { code: 'BUSY' });
  assert.throws(() => bridge.remember({ summary: 'new', detail: 'new' }), { code: 'BUSY' });
  assert.equal(fs.existsSync(bridge.overlayPath), false);
  fs.rmdirSync(bridge.lockPath);
  assert.equal(mutate(bridge, 'forget', record.id).saved, true);
});

test('failed atomic replacement preserves the previous effective view, temporary cleanup and lock release', (t) => {
  const { bridge } = fixture(t), record = archiveRecord(bridge);
  const rename = mock.method(fs, 'renameSync', () => { throw new Error('fixture rename failure'); });
  try { assert.throws(() => mutate(bridge, 'forget', record.id), /fixture rename failure/); }
  finally { rename.mock.restore(); }
  assert.equal(bridge.searchMemories('OLD_ARCHIVE_CANARY').total, 1); assert.equal(fs.existsSync(bridge.overlayPath), false);
  assert.equal(fs.existsSync(bridge.lockPath), false); assert.deepEqual(fs.readdirSync(bridge.memoryDir).filter((name) => name.endsWith('.tmp')), []);
});

test('revoked owner authorization prevents a commit even after the temporary file was prepared', (t) => {
  const { bridge } = fixture(t), record = archiveRecord(bridge); let checks = 0;
  assert.throws(() => mutate(bridge, 'forget', record.id, {}, { authorize: () => ++checks < 3 }), { code: 'FORBIDDEN' });
  assert.equal(fs.existsSync(bridge.overlayPath), false); assert.equal(fs.existsSync(bridge.lockPath), false);
});

test('native tools bind account, identity and source actor from the verified execution, never model arguments', async (t) => {
  const { bridge } = fixture(t), { definitions, tools } = toolsFor(bridge);
  t.after(() => tools.dispose());
  const saved = await definitions.get('dafeiyu_remember').execute({ key: 'fiction', summary: '当前扮演', detail: 'NATIVE_IDENTITY_CANARY', scope: 'identity' }, {});
  assert.equal(saved.saved, true); assert.equal(saved.scope.accountId, '10001'); assert.equal(saved.scope.identityId, 'identity-a');
  assert.equal(saved.provenance.actor, 'tool'); assert.equal(saved.provenance.sessionId, 'verified-session');
  await assert.rejects(definitions.get('dafeiyu_remember').execute({ summary: 'fake', detail: 'fake', accountId: 'other' }, {}));
  const found = await definitions.get('dafeiyu_memory_search').execute({ query: 'NATIVE_IDENTITY_CANARY' }, {});
  assert.equal(found.total, 1); assert.match(found.revision, /^[a-f0-9]{64}$/);
  const corrected = await definitions.get('dafeiyu_memory_correct').execute({ id: saved.recordId, revision: found.revision,
    summary: '更正扮演', detail: 'NATIVE_CORRECTED_CANARY' }, {});
  assert.equal(corrected.saved, true); assert.equal(corrected.record.provenance.actor, 'tool');
});

test('tools cannot mutate another identity by guessing its stable ID and current global revision', async (t) => {
  const { bridge } = fixture(t), other = bridge.remember({ summary: '身份 B', detail: 'OTHER_IDENTITY', scope: 'identity' }, { context: { identityId: 'identity-b' } });
  const { definitions, tools } = toolsFor(bridge); t.after(() => tools.dispose());
  const result = await definitions.get('dafeiyu_memory_forget').execute({ id: other.recordId, revision: bridge.snapshot().revision }, {});
  assert.equal(result.ok, false); assert.equal(fs.existsSync(bridge.overlayPath), false);
  const ownSearch = await definitions.get('dafeiyu_memory_search').execute({ query: 'OTHER_IDENTITY' }, {});
  assert.equal(ownSearch.total, 0);
});

test('guest/group executions and disabled memory writes never gain management capability', async (t) => {
  const { bridge } = fixture(t), record = archiveRecord(bridge);
  for (const identity of [{ isOwner: false, scope: 'c2c' }, { isOwner: true, scope: 'group' }]) {
    const { definitions, tools } = toolsFor(bridge, { identity });
    for (const action of ['correct', 'forget', 'restore']) await assert.rejects(definitions.get(`dafeiyu_memory_${action}`).execute({
      id: record.id, revision: bridge.snapshot().revision, ...(action === 'correct' ? { summary: 'no', detail: 'no' } : {}) }, {}), /仅绑定主人/);
    tools.dispose();
  }
  const { definitions, tools } = toolsFor(bridge, { writable: false });
  const result = await definitions.get('dafeiyu_memory_forget').execute({ id: record.id, revision: bridge.snapshot().revision }, {});
  assert.equal(result.ok, false); tools.dispose(); assert.equal(fs.existsSync(bridge.overlayPath), false);
});

test('an unbound desktop identity can save common facts but cannot claim an identity scope', async (t) => {
  const { bridge } = fixture(t), { definitions, tools } = toolsFor(bridge, { identity: { isOwner: true, scope: 'desktop', trusted: true } });
  t.after(() => tools.dispose());
  const result = await definitions.get('dafeiyu_remember').execute({ scope: 'identity', summary: 'no', detail: 'no' }, {});
  assert.equal(result.ok, false); assert.equal(fs.existsSync(bridge.factsPath), false);
});

test('management facade enforces owner, current runtime, idle state and sanitized storage errors', (t) => {
  const { bridge } = fixture(t), record = archiveRecord(bridge);
  let runtime = { memoryBridge: bridge, incomingPending: 0 };
  const panel = new MemoryPanelController({ getRuntime: () => runtime });
  assert.throws(() => panel.snapshot({}, { authorize: () => false }), { code: 'FORBIDDEN' });
  runtime.incomingPending = 1;
  assert.throws(() => panel.forget({ id: record.id, revision: bridge.snapshot().revision }), { code: 'BUSY' });
  runtime.incomingPending = 0;
  const saved = panel.correct({ id: record.id, revision: panel.snapshot().revision, summary: '面板确认', detail: 'PANEL_CONFIRMED_CANARY' });
  assert.equal(saved.record.provenance.actor, 'panel'); assert.equal(saved.record.provenance.confirmed, true);
  const stale = new MemoryPanelController({ getRuntime: () => ({ memoryBridge: bridge }) });
  assert.throws(() => stale.snapshot(), { code: 'CONFLICT' });
  const broken = new MemoryPanelController({ getRuntime: () => ({ memoryBridge: { snapshot() { throw new Error('PRIVATE_ERROR_CANARY'); } } }) });
  assert.throws(() => broken.snapshot(), (error) => error instanceof MemoryPanelError && !error.message.includes('PRIVATE_ERROR_CANARY'));
});

test('management validation rejects unsupported scopes, unknown input privileges and oversized fields before writing', (t) => {
  const { bridge } = fixture(t), record = archiveRecord(bridge);
  for (const values of [{ summary: '', detail: 'text' }, { summary: 'ok', detail: 'x'.repeat(2001) },
    { summary: 'ok', detail: 'ok', accountId: 'other' }, { summary: 'ok', detail: 'ok', reason: 'x'.repeat(501) }]) {
    assert.throws(() => mutate(bridge, 'correct', record.id, values), { code: 'INVALID_PATCH' });
  }
  assert.throws(() => bridge.snapshot({ scope: 'guest' }), { code: 'INVALID_PATCH' });
  assert.throws(() => bridge.snapshot({ limit: 101 }), { code: 'INVALID_PATCH' });
  assert.equal(fs.existsSync(bridge.overlayPath), false); assert.equal(fs.existsSync(bridge.lockPath), false);
  assert.ok(MemoryStoreError.prototype instanceof Error);
});
