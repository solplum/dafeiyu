import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanion } from '../packages/dsh-dafeiyu/src/index.js';
import { QQGateway } from '../packages/dsh-dafeiyu/src/qq-gateway.js';
import { ownerContextFor, buildHostPrompt } from '../packages/dsh-dafeiyu/src/native-context.js';
import { isOwnerOneBotMessage } from '../packages/dsh-dafeiyu/src/onebot-admission.js';
import { registerNativeOneBotTools } from '../packages/dsh-dafeiyu/src/native-onebot-tools.js';

const options = { ownerQq: '123', expectedSelfId: '456' };
const incoming = (id = -1) => { const time = Math.floor(Date.now() / 1000); return { channel: 'onebot', isGroup: false, userId: '123', messageId: String(id), time: time * 1000,
  raw: { post_type: 'message', message_type: 'private', user_id: 123, self_id: 456, message_id: id, time } }; };
function identityFixture() {
  let record;
  const manager = { findByAgent: (agent) => agent === record.agent ? record : undefined };
  const agent = { session: { id: 'actual-onebot-session' }, ctx: { get: (name) => name === 'onebotChannel' ? { manager } : undefined } };
  record = { agent, sessionId: agent.session.id, channel: 'onebot', scope: 'private', selfId: '456', peerId: '123',
    replyTarget: { scope: 'private', targetId: '123' } };
  return { agent, record, manager, resolve: () => ownerContextFor(agent, '', { ownerQq: '123', onebotManager: manager }) };
}

test('personal QQ admission requires the exact owner, small account and private message envelope', () => {
  assert.equal(isOwnerOneBotMessage(incoming(), options), true);
  for (const mutate of [
    (m) => { m.raw.message_type = 'group'; }, (m) => { m.raw.message_type = 'unknown'; },
    (m) => { m.userId = 'visitor'; }, (m) => { m.raw.user_id = 456; },
    (m) => { m.raw.self_id = 999; }, (m) => { delete m.raw.self_id; },
    (m) => { delete m.raw.message_id; }, (m) => { m.messageId = 'different'; },
    (m) => { m.channel = 'official'; }, (m) => { m.isGroup = true; },
    (m) => { m.raw.group_id = 999; }, (m) => { m.groupId = '999'; },
    (m) => { m.messageType = 'group'; }, (m) => { m.selfId = '999'; },
  ]) { const msg = incoming(); mutate(msg); assert.equal(isOwnerOneBotMessage(msg, options), false); }
  assert.equal(isOwnerOneBotMessage(incoming(), { ownerQq: '456', expectedSelfId: '456' }), false);
  assert.equal(isOwnerOneBotMessage(incoming(), { ownerQq: '123' }), false);
});

test('source time is checked before any voice processing when a connection floor is set', () => {
  const msg = incoming();
  const connection = { ...options, connectedAtMs: msg.time + 100 };
  assert.equal(isOwnerOneBotMessage(msg, connection), true);
  assert.equal(isOwnerOneBotMessage(msg, { ...connection, connectedAtMs: msg.time + 1000 }), false);
  delete msg.raw.time;
  assert.equal(isOwnerOneBotMessage(msg, connection), false);
});

test('real personal QQ registry grants private role and memory on the first native turn', () => {
  const { agent, manager, resolve } = identityFixture();
  const identity = resolve();
  assert.equal(identity.isOwner, true);
  assert.equal(identity.channel, 'onebot');
  assert.equal(identity.scope, 'c2c');
  const bridge = { buildSystemPrompt(_extra, options) { return options.isOwner ? 'PRIVATE_CANARY' : 'PUBLIC'; } };
  assert.equal(buildHostPrompt(bridge, { agent }, { ownerQq: '123', onebotManager: manager }), 'PRIVATE_CANARY');
  const forged = { session: agent.session, ctx: { get: () => undefined } };
  assert.equal(ownerContextFor(forged, '', { ownerQq: '123', onebotManager: manager }).isOwner, false);
});

test('personal QQ failures never fall back to trusted desktop even for an allowlisted id', () => {
  for (const mutate of [
    (r) => { r.scope = 'group'; }, (r) => { r.peerId = '789'; },
    (r) => { r.selfId = '123'; }, (r) => { r.replyTarget.targetId = '789'; },
    (r) => { r.sessionId = 'different'; }, (r) => { r.channel = 'official'; },
  ]) {
    const { agent, record, manager } = identityFixture(); mutate(record);
    assert.equal(ownerContextFor(agent, '', { ownerQq: '123', onebotManager: manager,
      trustedDesktopSessionIds: [agent.session.id] }).isOwner, false);
  }
  const { agent } = identityFixture();
  assert.equal(ownerContextFor(agent, '', { ownerQq: '123', trustedDesktopSessionIds: [agent.session.id] }).isOwner, false);
});

test('personal QQ meme tool uses the registry recipient, requires the same connected small account and preserves uncertain receipts', async () => {
  const { agent, resolve } = identityFixture();
  const calls = [];
  const gateway = { connected: true, selfId: '456', async sendImage(...args) {
    calls.push(args); return { ok: false, uncertain: true, error: 'timeout' };
  } };
  let tool;
  const unregister = registerNativeOneBotTools({ tools: { register(definition) { tool = definition; return () => {}; } } }, {
    getExecutionContext: resolve, qqGateway: gateway,
    memeManager: { readImage(filename) { assert.equal(filename, 'real.png'); return { path: '/fixture/real.png' }; } },
  });
  const result = await tool.execute({ filename: 'real.png' }, { agent });
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.deepEqual(calls, [['private:123', '/fixture/real.png']]);
  gateway.selfId = '999';
  assert.equal((await tool.execute({ filename: 'real.png' }, { agent })).ok, false);
  assert.equal(calls.length, 1);
  unregister();
  await assert.rejects(tool.execute({ filename: 'real.png' }, { agent }), /已卸载/);
});

test('desktop and official bot executions cannot use personal QQ to send across channels', async () => {
  let tool;
  for (const identity of [{ isOwner: true, scope: 'desktop', trusted: true }, { isOwner: true, scope: 'c2c' }]) {
    const unregister = registerNativeOneBotTools({ tools: { register(d) { tool = d; } } }, {
      getExecutionContext: () => identity, qqGateway: { sendImage() { assert.fail('cross-channel send'); } }, memeManager: {},
    });
    await assert.rejects(tool.execute({ filename: 'x.png' }, {}), /个人 QQ/);
    unregister();
  }
});

test('cancelled image send keeps a confirmed receipt without reporting ordinary turn success', async () => {
  const controller = new AbortController(); let tool;
  const unregister = registerNativeOneBotTools({ tools: { register(d) { tool = d; } } }, {
    getExecutionContext: () => ({ isOwner: true, channel: 'onebot', scope: 'c2c', selfId: '456', peerId: '123' }),
    memeManager: { readImage() { return { path: '/fixture/real.png' }; } },
    qqGateway: { connected: true, selfId: '456', async sendImage() {
      controller.abort(); return { ok: true, data: { message_id: 17 } };
    } },
  });
  const result = await tool.execute({ filename: 'real.png' }, { signal: controller.signal });
  assert.equal(result.ok, false); assert.equal(result.cancelled, true);
  assert.equal(result.delivered, true); assert.equal(result.messageId, '17');
  unregister();
});

test('personal QQ plugin path uses native prompt and tools, filters before STT, and never calls legacy Brain', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-onebot-wiring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'packages/companion'), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../packages/companion/src', import.meta.url)), path.join(root, 'packages/companion/src'), 'dir');
  fs.mkdirSync(path.join(root, 'memory'));
  fs.writeFileSync(path.join(root, 'memory/user.md'), 'ONEBOT_PRIVATE_FIXTURE_CANARY');
  const tools = new Map(), listeners = new Map(), prompts = [], sent = [];
  let prompt, turns = 0, transcriptions = 0;
  const emit = (event, ...args) => { for (const cb of [...(listeners.get(event) || [])]) cb(...args); };
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }) },
    agentPresets: { async mount() {} },
    agents: { async create(opts) {
      const own = {}, session = { id: opts.sessionId };
      const agent = { session, ctx: { get: (name) => own[name], provide: (name, value) => { own[name] = value; } },
        cancel() {}, followup(message) {
          const turn = ++turns;
          prompts.push(prompt.text({ agent }));
          emit('session/event', session, { type: 'turn/start', data: { turn } });
          emit('agent/inbox/claimed', { agent, message, turn });
          Promise.resolve(tools.get('dafeiyu_status').execute({}, { agent })).then((status) => {
            assert.equal(status.conversationEngine, 'native-dsh');
            emit('session/event', session, { type: 'assistant/message', surfaceOp: 'append', data: { turn,
              message: { content: [{ type: 'text', text: '来自宿主原生会话的状态回复' }] } } });
            emit('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
          });
        } };
      await opts.setup(agent.ctx, agent);
      return { agent, async dispose() {} };
    } },
  };
  const ctx = { logger: { info() {}, warn() {} }, get: (name) => services[name],
    on(event, callback) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback);
      return () => listeners.get(event).delete(callback); },
    effect() {},
    systemPrompt: { context(value) { prompt = value; return () => {}; } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
  };
  const previous = QQGateway.prototype.startOneBot;
  QQGateway.prototype.startOneBot = async function () {
    this.connected = true; this.connectedAtMs = Date.now(); this.identitySource = 'lifecycle'; this.wsClient = {};
    this.api = async (action) => {
      if (action === 'get_login_info') { this.loginVerified = true; return { ok: true, data: { user_id: 456 } }; }
      this.online = true;
      return { ok: true, data: { online: true } };
    };
    await this.onConnect?.();
  };
  t.after(() => { QQGateway.prototype.startOneBot = previous; });
  const instance = await createCompanion(ctx, { projectRoot: root, ownerQq: '123', onebotSelfId: '456',
    onebotEngine: 'native', onebotWs: 'ws://fixture', autoStartOneBot: true, voiceTranscription: true });
  t.after(() => instance.dispose());
  instance.brain.reply = () => { assert.fail('legacy model must never be called'); };
  instance.voiceProcessor.hasVoice = () => { transcriptions++; return false; };
  instance.qqGateway.sendMessage = async (...args) => { sent.push(args); return { ok: true, data: { message_id: 20 } }; };
  const stranger = incoming(); stranger.userId = '789'; stranger.raw.user_id = 789;
  await instance.qqGateway.onMessage(stranger);
  assert.equal(transcriptions, 0); assert.equal(turns, 0);
  const old = incoming(); old.raw.time -= 10; old.time = old.raw.time * 1000;
  await instance.qqGateway.onMessage(old);
  assert.equal(transcriptions, 0); assert.equal(turns, 0);
  await instance.qqGateway.onMessage({ ...incoming(), text: '查询伴侣状态' });
  assert.equal(turns, 1); assert.equal(sent.length, 1); assert.match(prompts[0], /ONEBOT_PRIVATE_FIXTURE_CANARY/);
  assert.equal(sent[0][0], 'private:123'); assert.equal(sent[0][2].selfId, '456');
  assert.equal(instance.autoReady.enabled, false);
  instance.dispose(); await instance.nativeOneBot.dispose();
  assert.equal([...listeners.values()].every((set) => !set.size), true);
});

async function readinessFixture(t, initiallyOnline = false, initiallyLoggedIn = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'packages/companion'), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../packages/companion/src', import.meta.url)), path.join(root, 'packages/companion/src'), 'dir');
  const state = { online: initiallyOnline, loginAllowed: initiallyLoggedIn, models: 0, stt: 0, calls: [], sent: [], inputs: [], pause: null };
  const listeners = new Map();
  const emit = (name, ...args) => { for (const fn of [...(listeners.get(name) || [])]) fn(...args); };
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }) },
    agentPresets: { async mount() {} },
    agents: { async create(options) {
      const own = {}, session = { id: options.sessionId };
      const agent = { session, ctx: { get: (name) => own[name], provide: (name, value) => { own[name] = value; } }, cancel() {},
        followup(message) {
          const turn = ++state.models;
          state.inputs.push(message.content[0].text);
          emit('session/event', session, { type: 'turn/start', data: { turn } });
          emit('agent/inbox/claimed', { agent, message, turn });
          emit('session/event', session, { type: 'assistant/message', surfaceOp: 'append', data: { turn,
            message: { content: [{ type: 'text', text: `native-reply-${turn}` }] } } });
          emit('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
        } };
      await options.setup(agent.ctx, agent);
      return { agent, async dispose() {} };
    } },
  };
  const ctx = { logger: { info() {}, warn() {} }, get: (name) => services[name], effect() {},
    on(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler);
      return () => listeners.get(name).delete(handler); },
    systemPrompt: { context() { return () => {}; } }, tools: { register() { return () => {}; } },
  };
  const previous = QQGateway.prototype.startOneBot;
  QQGateway.prototype.startOneBot = async function () {
    this.connected = true; this.connectedAtMs = Date.now(); this.identitySource = 'lifecycle'; this.wsClient = {};
    this.api = async (action) => {
      state.calls.push(action);
      await state.pause?.(action);
      if (action === 'get_login_info') {
        this.loginVerified = state.loginAllowed;
        return state.loginAllowed ? { ok: true, data: { user_id: 456 } } : { ok: false, error: 'not logged in' };
      }
      assert.equal(action, 'get_status');
      this.online = state.online;
      return { ok: true, data: { online: state.online } };
    };
    await this.onConnect?.();
  };
  let instance;
  try {
    instance = await createCompanion(ctx, { projectRoot: root, ownerQq: '123', onebotSelfId: '456',
      onebotEngine: 'native', onebotWs: 'ws://fixture', autoStartOneBot: true, voiceTranscription: true });
  } finally { QQGateway.prototype.startOneBot = previous; }
  instance.brain.reply = () => assert.fail('legacy model must not run');
  instance.voiceProcessor.hasVoice = () => { state.stt++; return false; };
  instance.qqGateway.sendMessage = async (...args) => { state.sent.push(args); return { ok: true, data: { message_id: 99 } }; };
  t.after(async () => { instance.dispose(); await instance.nativeOneBot.dispose(); });
  const send = (id = -1) => instance.qqGateway.onMessage({ ...incoming(id), text: '查询伴侣状态' });
  return { instance, state, send };
}

test('actual plugin queues voice preparation before later text in the same conversation', async (t) => {
  const f = await readinessFixture(t, true);
  let release, started;
  const preparing = new Promise((resolve) => { started = resolve; });
  f.instance.voiceProcessor.hasVoice = (raw) => raw.fixtureVoice === true;
  f.instance.voiceProcessor.processInboundVoice = async () => {
    started(); await new Promise((resolve) => { release = resolve; });
    return { ok: true, text: '[语音转写]: 先前的语音要求' };
  };
  const voice = incoming(-41); voice.raw.fixtureVoice = true;
  const first = f.instance.qqGateway.onMessage({ ...voice, text: '[语音]' });
  await preparing;
  const second = f.instance.qqGateway.onMessage({ ...incoming(-42), text: '后来的补充文字' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.models, 0, 'later text cannot overtake an earlier STT operation');
  release(); await Promise.all([first, second]);
  assert.deepEqual(f.state.inputs, ['[语音] [语音转写]: 先前的语音要求', '后来的补充文字']);
  assert.equal(f.state.sent.length, 2);
});

for (const [label, voiceResult] of [['failed', { ok: false, text: '[语音处理失败]: PRIVATE_ERROR_CANARY' }],
  ['empty', { ok: true, text: '' }]]) test(label + ' voice preparation sends one safe QQ notice without a model session or duplicate recognition', async (t) => {
  const f = await readinessFixture(t, true);
  let preparations = 0;
  f.instance.voiceProcessor.hasVoice = () => true;
  f.instance.voiceProcessor.processInboundVoice = async () => { preparations++; return voiceResult; };
  const msg = { ...incoming(-43), text: '[语音]' };
  await Promise.all([f.instance.qqGateway.onMessage(msg), f.instance.qqGateway.onMessage(structuredClone(msg))]);
  await f.instance.qqGateway.onMessage(structuredClone(msg));
  assert.equal(f.state.models, 0);
  assert.equal(preparations, 1); assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.sent[0][0], 'private:123');
  assert.equal(f.state.sent[0][1], '这条语音没有识别成功，尚未执行你的请求。请重新录音或发送文字。');
  assert.deepEqual(f.state.sent[0][2], { messageId: '-43', selfId: '456' });
  const status = f.instance.nativeOneBot.status;
  assert.equal(status.sessionCreated, false);
  assert.equal(status.conversations[0].failureType, 'voice_input_failed');
  assert.equal(JSON.stringify({ status, sent: f.state.sent }).includes('PRIVATE_ERROR_CANARY'), false);
});

test('failed first online probe recovers on the same connection only after a new valid owner message', async (t) => {
  const f = await readinessFixture(t);
  assert.deepEqual(f.state.calls, ['get_login_info', 'get_status']);
  const socket = f.instance.qqGateway.wsClient;
  f.state.online = true;
  const stranger = incoming(-2); stranger.userId = '789'; stranger.raw.user_id = 789;
  const old = incoming(-3); old.raw.time -= 10; old.time = old.raw.time * 1000;
  await f.instance.qqGateway.onMessage(stranger);
  await f.instance.qqGateway.onMessage(old);
  assert.equal(f.state.calls.length, 2);
  assert.equal(f.state.models, 0); assert.equal(f.state.stt, 0);
  await f.send(-4);
  assert.equal(f.instance.qqGateway.wsClient, socket);
  assert.deepEqual(f.state.calls, ['get_login_info', 'get_status', 'get_login_info', 'get_status']);
  assert.equal(f.state.models, 1); assert.equal(f.state.sent.length, 1);
});

test('offline heartbeat revokes a prior success and prevents transcription and model execution', async (t) => {
  const f = await readinessFixture(t, true);
  f.instance.qqGateway.online = false;
  f.state.online = false;
  await f.send();
  assert.equal(f.state.models, 0); assert.equal(f.state.stt, 0); assert.equal(f.state.sent.length, 0);
  assert.equal(f.state.calls.length, 2);
  // A later online heartbeat restores this still authenticated connection.
  f.instance.qqGateway.online = true;
  f.state.online = true;
  await f.send(-2);
  assert.equal(f.state.models, 1);
});

test('concurrent eligible owner messages share one login/status recheck', async (t) => {
  const f = await readinessFixture(t);
  f.state.online = true;
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  f.state.pause = (action) => action === 'get_login_info' ? paused : undefined;
  const tasks = [f.send(-1), f.send(-2), f.send(-3)];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.state.calls, ['get_login_info', 'get_status', 'get_login_info']);
  release(); await Promise.all(tasks);
  assert.deepEqual(f.state.calls, ['get_login_info', 'get_status', 'get_login_info', 'get_status']);
  assert.equal(f.state.models, 3); assert.equal(f.state.sent.length, 3);
});

test('verification of an old socket cannot release input into a new connection generation', async (t) => {
  const f = await readinessFixture(t);
  f.state.online = true;
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  let held = false;
  f.state.pause = (action) => { if (action === 'get_login_info' && !held) { held = true; return paused; } };
  const oldInput = f.send(-1);
  await new Promise((resolve) => setImmediate(resolve));
  const gateway = f.instance.qqGateway;
  gateway.wsClient = {}; gateway.connectedAtMs += 1000; gateway.loginVerified = false; gateway.online = false;
  await gateway.onConnect();
  release(); await oldInput;
  assert.equal(f.state.models, 0); assert.equal(f.state.stt, 0);
  // The old check stops after login; only the new generation probes status.
  assert.deepEqual(f.state.calls, ['get_login_info', 'get_status', 'get_login_info', 'get_login_info', 'get_status']);
  const msg = incoming(-2); msg.raw.time = Math.floor(gateway.connectedAtMs / 1000); msg.time = msg.raw.time * 1000;
  await gateway.onMessage({ ...msg, text: 'new connection' });
  assert.equal(f.state.models, 1);
});

test('failed initial login probe can recover, while current disconnect and identity conflict forbid execution', async (t) => {
  const f = await readinessFixture(t, true, false);
  assert.deepEqual(f.state.calls, ['get_login_info']);
  assert.equal(f.instance.qqGateway.loginVerified, false);
  f.state.loginAllowed = true;
  await f.send(-1);
  assert.deepEqual(f.state.calls, ['get_login_info', 'get_login_info', 'get_status']);
  assert.equal(f.state.models, 1);
  f.instance.qqGateway.identityConflict = true;
  await f.send(-2);
  f.instance.qqGateway.identityConflict = false;
  f.instance.qqGateway.connected = false;
  await f.send(-3);
  assert.equal(f.state.models, 1); assert.equal(f.state.stt, 1);
  assert.equal(f.state.calls.length, 3);
});

function actualBundleConfig() {
  const packageFile = new URL('../packages/dsh-dafeiyu/package.json', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const patch = fs.readFileSync(new URL(manifest.dsh.bundle.patch, packageFile), 'utf8');
  // This bundle deliberately uses an inline JSON object (also valid YAML), so
  // the regression consumes the shipped entry without a mock configuration.
  const entry = patch.replace(/^#.*$/gm, '').trim().match(
    /^- insert:\r?\n    - id: dsh-dafeiyu\r?\n      name: dsh-dafeiyu\r?\n      config: (\{[^\r\n]*\})$/,
  );
  assert.ok(entry, 'bundle must contain only its single plugin entry and inline config object');
  return JSON.parse(entry[1]);
}

async function bundleConfigFixture(t, { localEnabled, profile = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-bundle-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'packages/companion'), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../packages/companion/src', import.meta.url)), path.join(root, 'packages/companion/src'), 'dir');
  const configFile = path.join(root, 'private-config.json');
  const local = { projectRoot: root, ownerQq: '123', onebotSelfId: '456', onebotWs: 'ws://fixture' };
  if (localEnabled !== undefined) Object.assign(local, { autoStartOneBot: localEnabled, voiceTranscription: localEnabled });
  fs.writeFileSync(configFile, JSON.stringify(local));
  const bundleConfig = actualBundleConfig();
  assert.deepEqual(bundleConfig, {}, 'bundle defaults must not override private opt-ins');
  const state = { starts: 0 };
  const ctx = { logger: { info() {}, warn() {} }, get() {}, effect() {}, on() { return () => {}; },
    systemPrompt: { context() { return () => {}; } }, tools: { register() { return () => {}; } } };
  const previous = QQGateway.prototype.startOneBot;
  QQGateway.prototype.startOneBot = async function () { state.starts++; };
  let instance;
  try { instance = await createCompanion(ctx, { ...bundleConfig, configFile, ...profile }); }
  finally { QQGateway.prototype.startOneBot = previous; }
  t.after(async () => { instance.dispose(); await instance.nativeOneBot?.dispose(); });
  return { instance, state };
}

test('shipped bundle preserves the private configFile opt-in and creates the native OneBot bridge', async (t) => {
  const { instance, state } = await bundleConfigFixture(t, { localEnabled: true });
  assert.equal(state.starts, 1);
  assert.equal(instance.nativeTools.getPersonalQQStatus().enabled, true);
  assert.ok(instance.nativeOneBot);
  assert.equal(instance.autoReady.enabled, false);
});

test('explicit profile false still overrides a private configFile opt-in', async (t) => {
  const { instance, state } = await bundleConfigFixture(t, { localEnabled: true,
    profile: { autoStartOneBot: false, voiceTranscription: false } });
  assert.equal(state.starts, 0);
  assert.equal(instance.nativeTools.getPersonalQQStatus().enabled, false);
  assert.equal(instance.nativeOneBot, undefined);
});

test('shipped bundle without a local opt-in keeps OneBot and automatic actions disabled', async (t) => {
  const { instance, state } = await bundleConfigFixture(t);
  assert.equal(state.starts, 0);
  assert.equal(instance.nativeTools.getPersonalQQStatus().enabled, false);
  assert.equal(instance.nativeOneBot, undefined);
  assert.equal(instance.autoReady.enabled, false);
  assert.deepEqual(instance.startup, { phone: 'not-requested', catchUp: 'not-requested' });
});
