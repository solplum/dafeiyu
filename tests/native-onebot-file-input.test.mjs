import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createCompanion } from '../packages/dsh-dafeiyu/src/index.js';
import { QQGateway, hasOneBotFile } from '../packages/dsh-dafeiyu/src/qq-gateway.js';
import { VoiceProcessor } from '../packages/dsh-dafeiyu/src/voice-processor.js';

const until = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'offline assembly did not reach the expected state');
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// Exercise the shipped websocket parser, native queue and real VoiceProcessor.
// Only the transport and model provider boundaries are offline fixtures.
async function assembly(t, { unknownNotice = false, imageSupport = null, failImageStorage = false, finishTurn = true, replyText = 'offline text reply', disposeBarrier, ownTool = false, presentationMode = 'native', failCreate = false, failSocialTools = false } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-file-input-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, 'packages/companion'), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../packages/companion/src', import.meta.url)), path.join(projectRoot, 'packages/companion/src'), 'dir');
  const state = { commands: [], sent: [], inputs: [], messages: [], toolCounts: [], assembledToolCounts: [], imageSaves: [], activeRestrictions: 0, agents: 0, turns: 0 }, listeners = new Map();
  const emit = (name, ...args) => { for (const fn of [...(listeners.get(name) || [])]) fn(...args); };
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'offline', model: 'fixture' }) },
    agentPresets: { async mount() {} },
    agents: { withoutInitiator: (fn) => fn(), async create(options) {
      state.agents++;
      if (failCreate === 'before-setup') throw new Error('fixture create refused');
      const scopedListeners = new Map();
      const own = { tools: { restrict({ allow }) { if (failSocialTools) throw new Error('fixture scoped restriction refused'); assert.deepEqual(allow, []); state.activeRestrictions++; return () => { state.activeRestrictions--; }; },
        guard() { return () => {}; }, presentAs() { assert.fail('already-native scope must not redeclare its presentation'); },
        schemas() { return [...(state.activeRestrictions ? [] : [{ name: 'bash' }]), ...(ownTool ? [{ name: 'scope_owned_tool' }] : []),
          ...(presentationMode === 'ptc' ? [{ name: 'run_code' }] : [])]; }, modeFor() { return presentationMode; } } }, session = { id: options.sessionId };
      const agent = { session, ctx: { get: (name) => own[name], provide: (name, value) => { own[name] = value; },
        on(name, fn) { if (!scopedListeners.has(name)) scopedListeners.set(name, new Set()); scopedListeners.get(name).add(fn);
          return () => scopedListeners.get(name).delete(fn); } }, cancel() {},
        async followup(message) {
          const turn = ++state.turns; state.inputs.push(message.content[0].text); state.messages.push(message);
          state.toolCounts.push(own.tools.schemas().length);
          const assembly = { tools: own.tools.schemas(), sections: [], contexts: [], variables: { fixture: true } };
          let next = async () => assembly;
          for (const listener of [...(scopedListeners.get('system-prompt/assemble') || [])].reverse()) {
            const previous = next; next = () => listener(assembly, { scope: agent, agent }, previous);
          }
          const accepted = await next(); state.assembledToolCounts.push(accepted.tools.length);
          assert.equal(accepted.sections, assembly.sections); assert.equal(accepted.contexts, assembly.contexts);
          assert.equal(accepted.variables, assembly.variables);
          emit('session/event', session, { type: 'turn/start', data: { turn } });
          emit('agent/inbox/claimed', { agent, message, turn });
          emit('session/event', session, { type: 'assistant/message', surfaceOp: 'append', data: { turn,
            message: { content: [{ type: 'text', text: replyText }] } } });
          if (finishTurn) emit('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
        } };
      await options.setup(agent.ctx, agent);
      if (failCreate === 'after-setup') throw new Error('fixture create failed after setup');
      return { agent, async dispose() { if (disposeBarrier) await disposeBarrier; } };
    } },
  };
  if (imageSupport !== null) {
    services.llm = { async resolveModelInfo(provider, id) { return { provider, id, inputModalities: imageSupport ? ['text', 'image'] : ['text'] }; },
      imageRequestPricing() { return { priceImages() {} }; } };
    services.attachments = { imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 1024, mediaTypes: ['image/png'] },
      async saveImages(inputs) { state.imageSaves.push(inputs); if (failImageStorage) throw new Error('fixture validation refused');
        return inputs.map(() => ({ id: 'durable-fixture-image', mediaType: 'image/png', width: 1, height: 1 })); } };
  }
  const ctx = { logger: { info() {}, warn() {} }, get: (name) => services[name], effect() {},
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn); },
    systemPrompt: { context() { return () => {}; } }, tools: { register() { return () => {}; } },
  };
  let socket;
  class OfflineSocket extends EventEmitter {
    constructor() { super(); socket = this; this.readyState = 0; }
    open() { this.readyState = 1; this.emit('open'); }
    receive(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
    send(bytes) {
      const request = JSON.parse(bytes); state.commands.push(request.action);
      let response;
      if (request.action === 'get_login_info') response = { status: 'ok', retcode: 0, data: { user_id: 456 } };
      else if (request.action === 'get_status') response = { status: 'ok', retcode: 0, data: { online: true } };
      else if (request.action === 'send_private_msg') {
        assert.equal(String(request.params.user_id), '123'); state.sent.push(request.params.message);
        response = unknownNotice ? { status: 'async', retcode: 1 }
          : { status: 'ok', retcode: 0, data: { message_id: 900 + state.sent.length } };
      } else assert.fail('unsupported offline transport action: ' + request.action);
      queueMicrotask(() => this.receive({ echo: request.echo, ...response }));
    }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const start = QQGateway.prototype.startOneBot;
  QQGateway.prototype.startOneBot = function () { this.WebSocketImpl = OfflineSocket; return start.call(this); };
  let instance;
  try {
    instance = await createCompanion(ctx, { projectRoot, ownerQq: '123', onebotSelfId: '456', onebotEngine: 'native',
      onebotWs: 'ws://fixture.invalid', autoStartOneBot: true, voiceTranscription: true });
  } finally { QQGateway.prototype.startOneBot = start; }
  t.after(async () => { instance.dispose(); await instance.nativeOneBot.dispose(); });
  assert.equal(instance.voiceProcessor.hasVoice, VoiceProcessor.prototype.hasVoice, 'the real parser must not be stubbed');
  instance.brain.reply = () => assert.fail('legacy provider must not run');
  socket.open(); await until(() => instance.qqGateway.loginVerified && instance.qqGateway.online === true);
  const receive = (id, message, extra = {}) => socket.receive({ post_type: 'message', message_type: 'private',
    self_id: 456, user_id: 123, message_id: id, time: Math.ceil(Date.now() / 1000), message, ...extra });
  const settled = async (id) => {
    const key = '456:123:' + id;
    await until(() => instance.nativeOneBot.seen.has(key) && !instance.nativeOneBot.seen.get(key).pending);
    return instance.nativeOneBot.seen.get(key).promise;
  };
  return { instance, state, receive, settled };
}

test('file recognition uses segment kinds or CQ file, never attachment text or a raw fallback over canonical text', () => {
  assert.equal(hasOneBotFile({ message: [{ type: 'file', data: { name: 'PRIVATE_NAME' } }] }), true);
  assert.equal(hasOneBotFile({ message: '[CQ:file,file=PRIVATE_PATH]' }), true);
  assert.equal(hasOneBotFile({ raw_message: '[CQ:file,file=PRIVATE_PATH]' }), true);
  assert.equal(hasOneBotFile({ message: [{ type: 'text', data: { text: '[CQ:file,file=literal]' } }], raw_message: '[CQ:file,file=stale]' }), false);
  assert.equal(hasOneBotFile({ message: [null, { type: 'image', data: {} }] }), false);
});

test('actual gateway and voice assembly classify files and mixed commands once, then accept a new text without replay', async (t) => {
  const f = await assembly(t);
  f.instance.backgroundTasks.list = () => assert.fail('an unread attachment must not bypass preparation through a task command');
  const file = [{ type: 'file', data: { name: 'PRIVATE_FILE_NAME', file: 'PRIVATE_FILE_PATH', url: 'https://fixture.invalid/no-download' } }];
  f.receive(-101, file); f.receive(-101, file);
  const first = await f.settled(-101);
  assert.equal(first.failureType, 'unsupported_input');
  assert.deepEqual(first.notification, { attempted: true, delivered: true });
  assert.equal(f.state.agents, 0); assert.equal(f.state.sent.length, 1);
  assert.match(f.state.sent[0], /还不能读取 QQ 文件.*未交给模型/);
  f.receive(-101, file); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.sent.length, 1, 'completed duplicates do not send another notice');
  f.receive(-102, [...file, { type: 'text', data: { text: '任务列表' } }]);
  assert.equal((await f.settled(-102)).failureType, 'unsupported_input');
  f.receive(-103, '[CQ:file,file=PRIVATE_CQ_PATH]');
  assert.equal((await f.settled(-103)).failureType, 'unsupported_input');
  assert.equal(f.state.sent.length, 3); assert.equal(f.state.agents, 0);
  assert.equal(f.state.commands.some((action) => /download|file|record/.test(action)), false);
  assert.doesNotMatch(JSON.stringify({ results: [first], status: f.instance.nativeOneBot.status, sent: f.state.sent }), /PRIVATE_FILE|PRIVATE_CQ/);
  const text = [{ type: 'text', data: { text: '新的文字请求' } }];
  f.receive(-104, text); f.receive(-104, text);
  assert.equal((await f.settled(-104)).ok, true);
  assert.deepEqual(f.state.inputs, ['新的文字请求']); assert.equal(f.state.agents, 1);
  assert.equal(f.instance.nativeOneBot.status.conversations[0].state, 'idle');
  f.receive(-105, [{ type: 'face', data: { id: '14' } }]);
  assert.equal((await f.settled(-105)).ok, true);
  assert.equal(f.state.inputs.at(-1), '[QQ系统表情：微笑]');
  assert.equal(f.instance.nativeOneBot.status.conversations[0].failureType, null);
  f.receive(-106, []);
  const empty = await f.settled(-106);
  assert.equal(empty.failureType, 'empty_input'); assert.deepEqual(empty.notification, { attempted: true, delivered: true });
  assert.equal(f.state.inputs.length, 2); assert.equal(f.state.sent.length, 6);
});

test('an unconfirmed unsupported-input notice keeps unknown protection and duplicates never resend', async (t) => {
  const f = await assembly(t, { unknownNotice: true });
  const file = [{ type: 'file', data: { name: 'PRIVATE_FILE_NAME' } }];
  f.receive(-201, file); f.receive(-201, file);
  const result = await f.settled(-201);
  assert.equal(result.failureType, 'unsupported_input');
  assert.equal(result.notification.delivered, false); assert.equal(result.notification.uncertain, true);
  const conversation = f.instance.nativeOneBot.status.conversations[0];
  assert.equal(conversation.state, 'blocked'); assert.equal(conversation.requiresUncertainAcknowledgement, true);
  assert.equal(f.instance.nativeOneBot.status.uncertainEntries, 1);
  f.receive(-201, file); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.sent.length, 1); assert.equal(f.state.agents, 0);
  await assert.rejects(f.instance.nativeOneBot.recoverConversation({ qq: '123', identityId: 'default' }), { code: 'UNCERTAIN_ACK_REQUIRED' });
  assert.equal(f.instance.nativeOneBot.status.conversations[0].requiresUncertainAcknowledgement, true);
});

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
test('current image and mface bytes reach native host image content once and social tools restore before the next text task', async t => {
  const f = await assembly(t, { imageSupport: true });
  const image = [{ type: 'image', data: { file: 'base64://' + pngBase64 } }];
  f.instance.nativeOneBot.armProgress = () => assert.fail('pure image social input has no task progress message');
  f.receive(-301, image); f.receive(-301, image);
  assert.equal((await f.settled(-301)).ok, true);
  assert.equal(f.state.imageSaves.length, 1); assert.equal(f.state.turns, 1);
  assert.deepEqual(Buffer.from(f.state.imageSaves[0][0].data), Buffer.from(pngBase64, 'base64'));
  assert.equal(f.state.messages[0].content[1].type, 'image');
  assert.equal(f.state.messages[0].content[1].attachment.id, 'durable-fixture-image');
  assert.equal(f.state.toolCounts[0], 0); assert.equal(f.state.assembledToolCounts[0], 0); assert.equal(f.state.activeRestrictions, 0);
  delete f.instance.nativeOneBot.armProgress;
  f.receive(-302, [{ type: 'text', data: { text: '新的文字任务' } }]);
  assert.equal((await f.settled(-302)).ok, true); assert.equal(f.state.toolCounts[1], 1); assert.equal(f.state.assembledToolCounts[1], 1);
  f.instance.nativeOneBot.armProgress = () => assert.fail('pure mface input has no task progress message');
  f.receive(-303, [{ type: 'mface', data: { file: 'base64://' + pngBase64 } }]);
  assert.equal((await f.settled(-303)).ok, true); assert.equal(f.state.messages[2].content[1].type, 'image');
  assert.equal(f.state.toolCounts[2], 0); assert.equal(f.state.activeRestrictions, 0);
  assert.equal(f.instance.nativeOneBot.status.conversations[0].failureType, null);
});
test('a new image on a text-only route gets one truthful limitation notice and never creates a model task', async t => {
  const f = await assembly(t, { imageSupport: false });
  const image = [{ type: 'image', data: { file: '/private/never-read', url: 'https://fixture.invalid/never-download' } }];
  f.receive(-401, image); f.receive(-401, image);
  const result = await f.settled(-401);
  assert.equal(result.failureType, 'image_unavailable'); assert.equal(f.state.imageSaves.length, 0);
  assert.equal(f.state.agents, 0); assert.equal(f.state.turns, 0); assert.equal(f.state.sent.length, 1);
  assert.match(f.state.sent[0], /图片已经到 QQ/); assert.match(f.state.sent[0], /请勿反复重发/);
  assert.equal(f.state.commands.some(action => /image|download/.test(action)), false);
});
test('a host image validation failure does not submit placeholder text or retry the current attachment', async t => {
  const f = await assembly(t, { imageSupport: true, failImageStorage: true });
  f.receive(-501, [{ type: 'image', data: { file: 'base64://' + pngBase64 } }]);
  assert.equal((await f.settled(-501)).failureType, 'image_input_failed');
  assert.equal(f.state.imageSaves.length, 1); assert.equal(f.state.turns, 0); assert.equal(f.state.agents, 0);
  assert.equal(f.state.sent.length, 1);
});

test('unhandled segments and oversized source cannot hide behind text task commands or become empty input', async t => {
  const f = await assembly(t);
  f.instance.backgroundTasks.list = () => assert.fail('unsupported mixed segments must not execute a task command');
  f.receive(-601, [{ type: 'text', data: { text: '任务列表' } }, { type: 'video', data: { url: 'https://fixture.invalid/no-read' } }]);
  assert.equal((await f.settled(-601)).failureType, 'unsupported_message');
  f.receive(-602, Array.from({ length: 1025 }, () => ({ type: 'face', data: { id: '14' } })));
  assert.equal((await f.settled(-602)).failureType, 'unsupported_message');
  assert.equal(f.state.turns, 0); assert.equal(f.state.agents, 0); assert.equal(f.state.sent.length, 2);
});
test('raw_message-only record follows voice preparation while a CQ record inside a canonical text stays literal', async t => {
  const f = await assembly(t);
  f.receive(-701, undefined, { raw_message: '[CQ:record,file=fixture-record]' });
  assert.equal((await f.settled(-701)).failureType, 'voice_input_failed');
  assert.equal(f.state.turns, 0);
  const literal = '[CQ:record,file=this-is-literal-text]';
  f.receive(-702, [{ type: 'text', data: { text: literal } }]);
  assert.equal((await f.settled(-702)).ok, true); assert.equal(f.state.inputs[0], literal);
});
test('a custom message factory cannot silently drop a prepared image and send only its placeholder', async t => {
  const f = await assembly(t, { imageSupport: true });
  f.instance.nativeOneBot.createMessage = ({ requestId, text }) => ({ id: requestId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } });
  f.receive(-801, [{ type: 'image', data: { file: 'base64://' + pngBase64 } }]);
  assert.equal((await f.settled(-801)).failureType, 'image_input_failed');
  assert.equal(f.state.imageSaves.length, 1); assert.equal(f.state.turns, 0); assert.equal(f.state.activeRestrictions, 0);
});

test('social output overflow keeps empty-tool guard until actual host cleanup confirms, even after local turnEnded', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = await assembly(t, { finishTurn: false, replyText: 'an oversized social reply', disposeBarrier: barrier });
  f.instance.nativeOneBot.maxReplyChars = 1;
  f.receive(-901, [{ type: 'face', data: { id: '14' } }]);
  const result = await f.settled(-901);
  assert.equal(result.failureType, 'model_failed'); assert.equal(result.uncertain, true);
  assert.equal(f.state.activeRestrictions, 1, 'local overflow is not a confirmed host turn/end');
  assert.equal(f.instance.nativeOneBot.status.conversations[0].state, 'blocked');
  release(); await until(() => f.state.activeRestrictions === 0);
  assert.equal(f.state.turns, 1);
});

test('scope-owned tools remain visible under the official restriction contract without failing normal social input', async t => {
  const f = await assembly(t, { ownTool: true });
  f.receive(-1001, [{ type: 'face', data: { id: '14' } }]);
  assert.equal((await f.settled(-1001)).ok, true);
  assert.equal(f.state.turns, 1); assert.equal(f.state.toolCounts[0], 1); assert.equal(f.state.assembledToolCounts[0], 0);
  assert.equal(f.state.activeRestrictions, 0);
  assert.equal(f.instance.nativeOneBot.status.conversations[0].failureType, null);
});
test('a preset-owned PTC presentation is preserved while a pure social message receives its normal final reply', async t => {
  const f = await assembly(t, { presentationMode: 'ptc' });
  f.receive(-1002, [{ type: 'face', data: { id: '14' } }]);
  assert.equal((await f.settled(-1002)).ok, true);
  assert.equal(f.state.turns, 1); assert.equal(f.state.toolCounts[0], 1); assert.equal(f.state.assembledToolCounts[0], 0);
  assert.equal(f.state.sent.length, 1); assert.equal(f.state.activeRestrictions, 0);
});

for (const failCreate of ['before-setup', 'after-setup']) {
  test('pre-model ' + failCreate + ' session failure sends one admitted fixed notice without retrying the input', async t => {
    const f = await assembly(t, { failCreate });
    const face = [{ type: 'face', data: { id: '14' } }];
    f.receive(-1101, face); f.receive(-1101, face);
    const result = await f.settled(-1101);
    assert.equal(result.failureType, 'session_failed');
    assert.deepEqual(result.notification, { attempted: true, delivered: true });
    assert.equal(f.state.turns, 0); assert.equal(f.state.sent.length, 1);
    assert.match(f.state.sent[0], /还没开始处理/);
    assert.equal(f.instance.nativeOneBot.status.conversations[0].state, 'blocked');
    f.receive(-1101, face); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.agents, 1); assert.equal(f.state.sent.length, 1);
  });
}
test('a pre-model social restriction failure sends one notice even though the newly created record is retired', async t => {
  const f = await assembly(t, { failSocialTools: true });
  f.receive(-1102, [{ type: 'face', data: { id: '14' } }]);
  const result = await f.settled(-1102);
  assert.equal(result.failureType, 'session_failed');
  assert.deepEqual(result.notification, { attempted: true, delivered: true });
  assert.equal(f.state.turns, 0); assert.equal(f.state.sent.length, 1);
});
test('unknown delivery of a pre-model session notice retains acknowledgement protection and is never resent', async t => {
  const f = await assembly(t, { failCreate: 'after-setup', unknownNotice: true });
  const face = [{ type: 'face', data: { id: '14' } }];
  f.receive(-1103, face); f.receive(-1103, face);
  const result = await f.settled(-1103);
  assert.equal(result.failureType, 'session_failed'); assert.equal(result.notification.uncertain, true);
  assert.equal(f.state.turns, 0); assert.equal(f.state.sent.length, 1);
  assert.equal(f.instance.nativeOneBot.status.conversations[0].requiresUncertainAcknowledgement, true);
  f.receive(-1103, face); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.sent.length, 1); assert.equal(f.state.agents, 1);
});

test('pre-model session failure notice is suppressed after its admitted connection changes', async t => {
  const f = await assembly(t);
  f.instance.nativeOneBot.setupAgent = async () => { f.instance.qqGateway.connected = false; throw new Error('fixture setup interrupted'); };
  f.receive(-1104, [{ type: 'face', data: { id: '14' } }]);
  const result = await f.settled(-1104);
  assert.equal(result.failureType, 'session_failed');
  assert.deepEqual(result.notification, { attempted: false, delivered: false });
  assert.equal(f.state.turns, 0); assert.equal(f.state.sent.length, 0);
});
