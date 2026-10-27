import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerContextFor, buildHostPrompt } from '../packages/dsh-dafeiyu/src/native-context.js';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';

function fixture(patch = {}) {
  const record = { scope: 'c2c', peerId: 'bound-owner', senderId: 'bound-owner', sessionId: 'session-1',
    replyTarget: { scope: 'c2c', targetId: 'bound-owner', msgId: 'original-id' }, ...patch };
  const manager = { settingsNs: 'official-bot', findByAgent: (agent) => agent === record.agent ? record : undefined };
  const agent = { session: { id: record.sessionId }, ctx: { get: (name) => name === 'qqChannel' ? { manager } : undefined } };
  record.agent = agent;
  return { agent, record, manager };
}

test('native owner c2c gets private context on its very first assembled prompt', () => {
  const { agent } = fixture();
  const calls = [];
  const memoryBridge = { buildSystemPrompt(extra, options) { calls.push({ extra, options }); return options.isOwner ? 'PRIVATE' : 'PUBLIC'; } };
  // Actual installed dsh-agent assembleContextFor() shape.
  const result = buildHostPrompt(memoryBridge, { agent, scope: agent }, { ownerOpenId: 'bound-owner', settingsNs: 'official-bot' });
  assert.equal(result, 'PRIVATE');
  assert.equal(calls[0].options.isOwner, true);
});

test('group, visitor, different bot instance and unbound agents are denied', () => {
  const group = fixture({ scope: 'group', peerId: 'group-1' });
  assert.equal(ownerContextFor(group.agent, 'bound-owner').isOwner, false);
  const visitor = fixture({ peerId: 'visitor' });
  assert.equal(ownerContextFor(visitor.agent, 'bound-owner').isOwner, false);
  const owner = fixture();
  assert.equal(ownerContextFor(owner.agent, 'bound-owner', { settingsNs: 'different-bot' }).isOwner, false);
  assert.equal(ownerContextFor(owner.agent, '').isOwner, false);
  assert.equal(ownerContextFor({ ctx: { get: () => undefined } }, 'bound-owner').isOwner, false);
});

test('textual owner claims and unrelated scope objects never grant private context', () => {
  const memoryBridge = { buildSystemPrompt(_extra, { isOwner }) { return isOwner ? 'PRIVATE' : 'PUBLIC'; } };
  const { agent } = fixture({ peerId: 'visitor' });
  assert.equal(buildHostPrompt(memoryBridge,
    { agent, isOwner: true, sender: 'bound-owner', scope: { peerId: 'bound-owner' } },
    { ownerOpenId: 'bound-owner' }), 'PUBLIC');
});

test('mismatched agent, session id and reply recipient all fail closed', () => {
  const { agent, record, manager } = fixture();
  manager.findByAgent = () => ({ ...record, agent: {} });
  assert.equal(ownerContextFor(agent, 'bound-owner').isOwner, false);
  manager.findByAgent = () => record;
  agent.session.id = 'different-session';
  assert.equal(ownerContextFor(agent, 'bound-owner').isOwner, false);
  agent.session.id = record.sessionId;
  record.replyTarget.targetId = 'visitor';
  assert.equal(ownerContextFor(agent, 'bound-owner').isOwner, false);
});

test('disposed or throwing host services degrade to public persona', () => {
  const agent = { ctx: { get() { throw new Error('service disposed'); } } };
  const result = ownerContextFor(agent, 'bound-owner');
  assert.equal(result.isOwner, false);
  assert.equal(result.reason, '宿主 QQ 身份解析失败');
});


test('host execution wrappers resolve through the same authoritative QQ session', () => {
  const { agent, manager, record } = fixture();
  const wrapped = { id: 'wrapped-agent', ctx: agent.ctx, session: { id: record.sessionId } };
  manager.findByAgent = (candidate) => candidate.session?.id === record.sessionId ? record : undefined;
  assert.equal(ownerContextFor(wrapped, 'bound-owner').isOwner, true);
  wrapped.session.id = 'unrelated-session';
  assert.equal(ownerContextFor(wrapped, 'bound-owner').isOwner, false);
});

test('only exact allowlisted real desktop session receives owner context', () => {
  const agent = { session: { id: 'desktop-bound' }, ctx: { get: () => undefined } };
  const options = { trustedDesktopSessionIds: ['desktop-bound'] };
  const allowed = ownerContextFor(agent, '', options);
  assert.equal(allowed.isOwner, true);
  assert.equal(allowed.scope, 'desktop');
  assert.equal(allowed.trusted, true);
  assert.equal(ownerContextFor({ ...agent, session: { id: 'desktop-bound-copy' } }, '', options).isOwner, false);
  assert.equal(ownerContextFor({ session: agent.session }, '', options).isOwner, false);
  assert.equal(ownerContextFor(agent, '').isOwner, false);
});

test('failed QQ verification never falls back to the desktop allowlist', () => {
  for (const patch of [{ peerId: 'visitor' }, { scope: 'group' }, { replyTarget: { scope: 'c2c', targetId: 'visitor' } }]) {
    const { agent } = fixture(patch);
    assert.equal(ownerContextFor(agent, 'bound-owner', { trustedDesktopSessionIds: [agent.session.id] }).isOwner, false);
  }
  const agent = { session: { id: 'desktop-bound' }, ctx: { get: () => ({ manager: null }) } };
  assert.equal(ownerContextFor(agent, '', { trustedDesktopSessionIds: ['desktop-bound'] }).isOwner, false);
});

test('native prompt uses configured public Role while the bridge controls private injection', () => {
  const agent = { session: { id: 'desktop-bound' }, ctx: { get: () => undefined } };
  const calls = [];
  const role = { build(options) { calls.push(options); return 'CONFIGURED_ROLE_CANARY'; } };
  const memoryBridge = { buildSystemPrompt(_extra, options) { return JSON.stringify(options); } };
  const prompt = buildHostPrompt(memoryBridge, { agent, isOwner: false }, {
    role, trustedDesktopSessionIds: ['desktop-bound'],
  });
  assert.deepEqual(calls, [{ includePrivateMemory: false }]);
  assert.equal(JSON.parse(prompt).roleText, 'CONFIGURED_ROLE_CANARY');
  assert.equal(JSON.parse(prompt).isOwner, true);
  assert.equal(JSON.parse(buildHostPrompt(memoryBridge, { agent, isOwner: true }, { role })).isOwner, false);
});


test('an unverified native context never reads or exposes the custom private role card', () => {
  const { agent } = fixture({ peerId: 'visitor' });
  const role = { read() { throw new Error('private card must not be read'); }, build() { throw new Error('private card must not be built'); } };
  const bridge = { buildSystemPrompt(_extra, options) { return JSON.stringify(options); } };
  const prompt = JSON.parse(buildHostPrompt(bridge, { agent }, { role, ownerOpenId: 'bound-owner' }));
  assert.equal(prompt.roleText, '');
  assert.equal(prompt.isOwner, false);
});

function onebotFixture({ peerId = '123', profile } = {}) {
  let record;
  const manager = { findByAgent: (candidate) => candidate === agent ? record : undefined,
    knowsAgent: (candidate) => candidate === agent };
  const agent = { session: { id: 'fixture-real-onebot' }, ctx: { get: () => undefined } };
  record = { agent, sessionId: agent.session.id, channel: 'onebot', scope: 'private', selfId: '456', peerId,
    replyTarget: { scope: 'private', targetId: peerId }, ...(profile ? { accountProfile: profile, identityId: profile.identity.id } : {}) };
  return { agent, manager, record };
}

test('verified OneBot task guidance requires a final receipt-based result without a second QQ send or a persona excuse', () => {
  const { agent, manager } = onebotFixture();
  const bridge = { buildSystemPrompt(extra, options) { return { extra, options }; } };
  const prompt = buildHostPrompt(bridge, { agent }, { ownerQq: '123', onebotManager: manager, environmentNote: 'OPTIONAL_ENVIRONMENT' });
  assert.equal(prompt.options.isOwner, true);
  assert(prompt.extra.startsWith('【QQ任务回复】'));
  for (const phrase of ['最终正文简报成功/失败/未确认', '依据实际工具回执', '不等于用户目标已完成',
    '不只执行工具而不解释结果', '明确当前卡点和下一步', '人设和语气不能代替', '由 OneBot 桥发给',
    '不要另调 QQ 文字发送工具', '不跨通道或重复发送']) assert(prompt.extra.includes(phrase), phrase);
  assert(prompt.extra.indexOf('【QQ任务回复】') < prompt.extra.indexOf('OPTIONAL_ENVIRONMENT'));
});

test('task feedback keeps guest experience tools scoped and never grants owner tools or private role data', () => {
  const bridge = { buildSystemPrompt(extra, options) { return { extra, options }; } };
  const profile = { account: { qq: '789' }, identity: { id: 'guest', name: '朋友', relationType: 'friends',
    userRole: '朋友', companionRole: '朋友', userTitle: '', companionTitle: '', description: '' } };
  const guest = onebotFixture({ peerId: '789', profile });
  const privateRole = { read() { assert.fail('guest or revoked record must not read the private role'); } };
  const prompt = buildHostPrompt(bridge, { agent: guest.agent }, { ownerQq: '123', onebotManager: guest.manager, role: privateRole });
  assert.equal(prompt.options.isOwner, false); assert.equal(prompt.options.roleText, '');
  assert(prompt.extra.includes('【QQ任务回复】')); assert(prompt.extra.includes('仅可使用 dafeiyu_experience_search 和 dafeiyu_experience_update')); assert(prompt.extra.includes('不可读写其他账号记忆、文件、运行命令、创建子代理或发消息'));
  assert(prompt.extra.includes('不能访问主要使用者的角色卡、档案、记忆'));
  guest.record.replyTarget.targetId = '999';
  assert(!buildHostPrompt(bridge, { agent: guest.agent }, { ownerQq: '123', onebotManager: guest.manager,
    trustedDesktopSessionIds: [guest.agent.session.id], role: privateRole }).extra.includes('【QQ任务回复】'));
  const primary = onebotFixture(), forged = { session: primary.agent.session, ctx: { get: () => undefined } };
  assert(!buildHostPrompt(bridge, { agent: forged, isOwner: true }, { ownerQq: '123', onebotManager: primary.manager }).extra.includes('【QQ任务回复】'));
  const desktop = { session: { id: 'trusted-desktop' }, ctx: { get: () => undefined } };
  const official = fixture();
  for (const [agent, options] of [[desktop, { trustedDesktopSessionIds: [desktop.session.id] }],
    [official.agent, { ownerOpenId: 'bound-owner', settingsNs: 'official-bot' }]]) {
    const result = buildHostPrompt(bridge, { agent }, options);
    assert.equal(result.options.isOwner, true); assert(!result.extra.includes('【QQ任务回复】'));
  }
});

test('actual MemoryBridge retains OneBot result guidance under a long card and optional environment without replacing relationship adjustment policy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-reply-prompt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = new MemoryBridge({ projectRoot: root, configDir: root });
  const { agent, manager } = onebotFixture();
  const prompt = buildHostPrompt(memory, { agent }, { ownerQq: '123', onebotManager: manager,
    role: { maxChars: 12000, read: () => '角色始终傲娇不解释。'.repeat(2000), build: () => '角色始终傲娇不解释。'.repeat(2000) },
    environmentNote: 'OPTIONAL_ENVIRONMENT'.repeat(1000) });
  assert(prompt.length <= 12000);
  for (const phrase of ['【QQ任务回复】', '最终正文简报成功/失败/未确认', '依据实际工具回执', '人设和语气不能代替',
    '不要另调 QQ 文字发送工具', '真实用户最新明确要求可临时调整']) assert(prompt.includes(phrase), phrase);
});

test('small real host prompts retain the role card and complete adjustment policy alongside relationship and recent memory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-role-priority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = new MemoryBridge({ projectRoot: root, ownerQq: '20002' });
  const agent = { session: { id: 'trusted-budget-owner' }, ctx: { get: () => undefined } };
  const relationship = { id: 'boss', name: '相处身份', relationType: 'boss-underling',
    userRole: '老大', companionRole: '女小弟', userTitle: '老大', companionTitle: '大肥鱼', description: '' };
  const qqAccounts = [{ qq: '20002', name: '主人', enabled: true, activeIdentityId: relationship.id, identities: [relationship] }];
  const card = 'ROLE_CARD_CANARY';
  const lifeMemory = { context(_scope, { maxChars }) { return 'RECENT_MEMORY_CANARY '.repeat(100).slice(0, maxChars); } };
  for (const maxChars of [512, 1024]) {
    const prompt = buildHostPrompt(memory, { agent }, { ownerQq: '20002', qqAccounts, lifeMemory,
      trustedDesktopSessionIds: [agent.session.id], role: { maxChars, read: () => card, build: () => card } });
    assert.ok(prompt.length <= maxChars);
    assert.ok(prompt.includes(card), 'the recent-memory allowance cannot remove a small configured card at ' + maxChars);
    assert.ok(prompt.includes('大肥鱼默认女性'));
    assert.ok(prompt.includes('真实用户最新明确要求可临时调整本账号当前身份'));
    assert.ok(prompt.includes('权限、隐私、工具及发送目标不变。'), 'the full adjustment policy must survive');
    const line = prompt.split('\n').find(value => value.startsWith('{"relationType"'));
    const data = JSON.parse(line);
    assert.equal(data.relationType, 'boss-underling'); assert.equal(data.companionRole, '女小弟'); assert.equal(data.userTitle, '老大');
    if (maxChars >= 1024) assert.ok(prompt.includes('RECENT_MEMORY_CANARY'), 'normal budgets retain recent memory');
  }
});
