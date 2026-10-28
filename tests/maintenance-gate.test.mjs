import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanion } from '../packages/dsh-dafeiyu/src/index.js';
import { QQGateway } from '../packages/dsh-dafeiyu/src/qq-gateway.js';

function message(id = -1) {
  const time = Math.floor(Date.now() / 1000);
  return { channel: 'onebot', isGroup: false, userId: '123', messageId: String(id), time: time * 1000, text: 'fixture status',
    raw: { post_type: 'message', message_type: 'private', user_id: 123, self_id: 456, message_id: id, time } };
}
function barrier() {
  let enter, release;
  return { started: new Promise((resolve) => { enter = resolve; }),
    wait: new Promise((resolve) => { release = resolve; }), entered: () => enter(), release: () => release() };
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'packages/companion'), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../packages/companion/src', import.meta.url)), path.join(root, 'packages/companion/src'), 'dir');
  const state = { transcriptions: 0, handled: 0, identityWait: null, models: 0, phoneCommands: 0 };
  const ctx = { logger: { info() {}, warn() {} }, effect() {}, on() { return () => {}; },
    get: () => undefined, systemPrompt: { context() { return () => {}; } }, tools: { register() { return () => {}; } } };
  const previous = QQGateway.prototype.startOneBot;
  QQGateway.prototype.startOneBot = async function () {
    this.connected = true; this.connectedAtMs = Date.now(); this.identitySource = 'lifecycle'; this.wsClient = {};
    this.api = async (action) => {
      if (action === 'get_login_info') {
        if (state.identityWait) { state.identityWait.entered(); await state.identityWait.wait; }
        this.loginVerified = true; return { ok: true, data: { user_id: 456 } };
      }
      assert.equal(action, 'get_status'); this.online = true; return { ok: true, data: { online: true } };
    };
    await this.onConnect?.();
  };
  let runtime;
  try { runtime = await createCompanion(ctx, { projectRoot: root, ownerQq: '123', onebotSelfId: '456',
    onebotEngine: 'native', onebotWs: 'ws://fixture', autoStartOneBot: true, voiceTranscription: true }); }
  finally { QQGateway.prototype.startOneBot = previous; }
  t.after(() => runtime.dispose());
  runtime.brain.reply = () => { state.models++; assert.fail('maintenance fixtures must not call a model'); };
  runtime.phoneTools.runCommand = () => { state.phoneCommands++; assert.fail('maintenance fixtures must not operate a phone'); };
  runtime.voiceProcessor.hasVoice = () => false;
  runtime.nativeOneBot.handleIncoming = async (input, { prepare } = {}) => {
    await prepare?.(input, { signal: new AbortController().signal });
    state.handled++; return { ok: true };
  };
  return { runtime, state, send: (id) => runtime.qqGateway.onMessage(message(id)) };
}

test('maintenance prevents all new inbound processing until release, with idempotent generation-safe release', async (t) => {
  const f = await fixture(t), releaseA = f.runtime.beginMaintenance();
  assert.equal(typeof releaseA, 'function'); assert.equal(f.runtime.beginMaintenance(), null);
  await f.send(-1); assert.equal(f.state.handled, 0); assert.equal(f.runtime.incomingPending, 0);
  releaseA(); await f.send(-2); assert.equal(f.state.handled, 1);
  const releaseB = f.runtime.beginMaintenance(); assert.equal(typeof releaseB, 'function');
  releaseA(); assert.equal(f.runtime.beginMaintenance(), null, 'old release must not release a later maintenance generation');
  releaseB(); assert.equal(typeof f.runtime.beginMaintenance(), 'function');
});

test('the whole inbound voice preparation interval blocks maintenance before any model work', { timeout: 2000 }, async (t) => {
  const f = await fixture(t), gate = barrier();
  f.runtime.voiceProcessor.hasVoice = () => true;
  f.runtime.voiceProcessor.processInboundVoice = async () => { f.state.transcriptions++; gate.entered(); await gate.wait; return { ok: true, text: 'fixture transcription' }; };
  const pending = f.send(-3); await gate.started;
  assert.equal(f.runtime.voiceProcessor.active, 0); assert.equal(f.runtime.nativeOneBot.status.pending, 0);
  assert.equal(f.runtime.incomingPending, 1); assert.equal(f.runtime.beginMaintenance(), null);
  gate.release(); await pending;
  assert.equal(f.runtime.incomingPending, 0); assert.equal(f.state.handled, 1);
  const release = f.runtime.beginMaintenance(); assert.equal(typeof release, 'function'); release();
});

test('an awaited identity recheck is covered before any model or speech work', async (t) => {
  const f = await fixture(t), gate = barrier(); f.state.identityWait = gate;
  f.runtime.qqGateway.loginVerified = false;
  const pending = f.send(-4); await gate.started;
  assert.equal(f.runtime.incomingPending, 1); assert.equal(f.runtime.beginMaintenance(), null);
  gate.release(); await pending;
  assert.equal(f.state.handled, 1); assert.equal(f.runtime.incomingPending, 0);
});

test('native handling and failed speech cleanup release the incoming guard on every completion path', async (t) => {
  const f = await fixture(t), gate = barrier();
  f.runtime.nativeOneBot.handleIncoming = async (input, { prepare } = {}) => {
    await prepare?.(input, { signal: new AbortController().signal });
    gate.entered(); await gate.wait; throw new Error('fixture failure');
  };
  const pending = f.send(-5); await gate.started;
  assert.equal(f.runtime.beginMaintenance(), null); gate.release(); await pending;
  assert.equal(f.runtime.incomingPending, 0);
  f.runtime.voiceProcessor.hasVoice = () => true;
  f.runtime.voiceProcessor.processInboundVoice = async () => { throw new Error('fixture transcription failure'); };
  await f.send(-6); assert.equal(f.runtime.incomingPending, 0);
  const release = f.runtime.beginMaintenance(); assert.equal(typeof release, 'function'); release();
});

test('active speech work independently blocks maintenance, and disposed runtimes cannot reacquire it', async (t) => {
  const f = await fixture(t);
  f.runtime.voiceProcessor.active = 1; assert.equal(f.runtime.beginMaintenance(), null);
  f.runtime.voiceProcessor.active = 0; f.runtime.voiceOutput.active = 1; assert.equal(f.runtime.beginMaintenance(), null);
  f.runtime.voiceOutput.active = 0; const release = f.runtime.beginMaintenance(); assert.equal(typeof release, 'function');
  await f.runtime.dispose(); release(); assert.equal(f.runtime.beginMaintenance(), null);
  assert.equal(f.state.models, 0); assert.equal(f.state.phoneCommands, 0);
});
