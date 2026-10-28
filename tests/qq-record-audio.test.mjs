import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { QQGateway } from '../packages/dsh-dafeiyu/src/qq-gateway.js';
import { VoiceProcessor } from '../packages/dsh-dafeiyu/src/voice-processor.js';
const wav = Buffer.alloc(48); wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8);
const make = () => { const gateway = new QQGateway({ ownerQq: '100', expectedSelfId: '200' });
  Object.assign(gateway, { connected: true, online: true, loginVerified: true }); return gateway; };
class RecordSocket extends EventEmitter {
  static current;
  constructor() { super(); RecordSocket.current = this; this.readyState = 0; this.sent = []; }
  send(bytes) { this.sent.push(JSON.parse(bytes)); }
  close() { this.readyState = 3; this.emit('close'); }
  receive(data) { this.emit('message', JSON.stringify(data)); }
}
async function socketFixture(t) {
  const gateway = new QQGateway({ ownerQq: '100', expectedSelfId: '200', onebotWs: 'ws://fixture.invalid',
    onebotHttp: 'http://fixture.invalid', appId: '', appSecret: '', WebSocketImpl: RecordSocket });
  t.after(() => gateway.stop());
  await gateway.startOneBot();
  const socket = RecordSocket.current; socket.readyState = 1; socket.emit('open');
  Object.assign(gateway, { online: true, loginVerified: true });
  return { gateway, socket };
}
test('a single QQ recording lookup can finish after the ordinary 3-second deadline without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let httpCalls = 0; t.mock.method(globalThis, 'fetch', async () => { httpCalls++; assert.fail('must not replay through HTTP'); });
  const { gateway, socket } = await socketFixture(t);
  const pending = gateway.getRecordAudio({ file: 'slow-first-download' }, { selfId: '200' });
  t.mock.timers.tick(3500);
  assert.equal(socket.sent.length, 1); assert.equal(gateway.pendingReqs.size, 1); assert.equal(httpCalls, 0);
  socket.receive({ echo: socket.sent[0].echo, status: 'ok', retcode: 0, data: { base64: wav.toString('base64') } });
  assert.deepEqual(await pending, wav); assert.equal(gateway.pendingReqs.size, 0);
  t.mock.timers.tick(30000); assert.equal(socket.sent.length, 1); assert.equal(httpCalls, 0);
});
test('QQ recording lookup has a 30-second bound, ignores late completion and never retries by HTTP', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let httpCalls = 0; t.mock.method(globalThis, 'fetch', async () => { httpCalls++; assert.fail('no media replay'); });
  const { gateway, socket } = await socketFixture(t);
  const pending = gateway.api('get_record', { file: 'never-ready', out_format: 'wav' });
  t.mock.timers.tick(29999); assert.equal(gateway.pendingReqs.size, 1);
  t.mock.timers.tick(1); const result = await pending;
  assert.equal(result.ok, false); assert.match(result.error, /超时/); assert.equal(gateway.pendingReqs.size, 0);
  socket.receive({ echo: socket.sent[0].echo, status: 'ok', retcode: 0, data: { base64: wav.toString('base64') } });
  assert.equal(result.ok, false); assert.equal(socket.sent.length, 1); assert.equal(httpCalls, 0);
});
test('cancelling or stopping a slow recording settles immediately and does not accept late audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', () => assert.fail('cancelled recording must not fall back'));
  for (const stop of [false, true]) {
    const { gateway, socket } = await socketFixture(t), controller = new AbortController();
    const pending = gateway.getRecordAudio({ file: 'pending' }, { selfId: '200', signal: controller.signal });
    const rejected = assert.rejects(pending);
    t.mock.timers.tick(3500);
    if (stop) gateway.stop(); else controller.abort();
    await rejected; assert.equal(gateway.pendingReqs.size, 0);
    socket.receive({ echo: socket.sent[0].echo, status: 'ok', retcode: 0, data: { base64: wav.toString('base64') } });
    t.mock.timers.tick(30000); assert.equal(socket.sent.length, 1);
  }
});
test('ordinary QQ sends retain the 3-second unknown-delivery bound without a second send', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', () => assert.fail('unknown sends must not fall back'));
  const { gateway, socket } = await socketFixture(t);
  const pending = gateway.sendPrivateMsg('100', 'one send');
  t.mock.timers.tick(2999); assert.equal(gateway.pendingReqs.size, 1);
  t.mock.timers.tick(1); assert.equal((await pending).uncertain, true);
  assert.equal(gateway.pendingReqs.size, 0); assert.equal(socket.sent.length, 1);
});
test('direct HTTP recording reads share the 30-second bound and respect cancellation without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signals.push(options.signal);
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const gateway = make(); t.after(() => gateway.stop());
  const timed = gateway.api('get_record', { file: 'http-record', out_format: 'wav' });
  t.mock.timers.tick(29999); assert.equal(signals[0].aborted, false);
  t.mock.timers.tick(1); assert.equal((await timed).ok, false); assert.equal(signals[0].aborted, true);
  const controller = new AbortController();
  const cancelled = gateway.api('get_record', { file: 'cancelled-record', out_format: 'wav' }, { signal: controller.signal });
  controller.abort(); assert.equal((await cancelled).ok, false); assert.equal(signals[1].aborted, true);
  t.mock.timers.tick(30000); assert.equal(signals.length, 2);
});
test('stopping an HTTP-only recording cancels the managed request immediately and removes it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, requestSignal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++; requestSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  });
  const gateway = make(); t.after(() => gateway.stop());
  const pending = gateway.getRecordAudio({ file: 'stop-http-read' }, { selfId: '200' });
  const rejected = assert.rejects(pending);
  assert.equal(gateway.httpControllers.size, 1);
  gateway.stop(); await rejected;
  assert.equal(requestSignal.aborted, true); assert.equal(gateway.httpControllers.size, 0);
  t.mock.timers.tick(30000); assert.equal(calls, 1);
});
test('NapCat converts the admitted file identifier to bounded WAV bytes without using its container path', async () => {
  const gateway = make(); let calls = 0;
  gateway.api = async (action, params) => { calls++; assert.equal(action, 'get_record');
    assert.deepEqual(params, { file: 'trusted-record-identifier', out_format: 'wav' });
    return { ok: true, data: { file: '/app/.config/QQ/container-only.wav', base64: wav.toString('base64') } }; };
  assert.deepEqual(await gateway.getRecordAudio({ file: 'trusted-record-identifier', url: 'https://ignored.invalid' }, { selfId: '200' }), wav);
  assert.equal(calls, 1);
});
test('record conversion refuses identity changes, offline connections and cancellation before or after lookup', async () => {
  for (const change of [g => { g.selfId = '300'; }, g => { g.online = false; }, g => { g.loginVerified = false; }, g => { g.identityConflict = true; }]) {
    const gateway = make(); change(gateway); gateway.api = () => assert.fail('must not request audio');
    await assert.rejects(gateway.getRecordAudio({ file: 'record' }, { selfId: '200' }));
  }
  const gateway = make(), controller = new AbortController(); let calls = 0;
  gateway.api = async () => { calls++; controller.abort(); return { ok: true, data: { base64: wav.toString('base64') } }; };
  await assert.rejects(gateway.getRecordAudio({ file: 'record' }, { selfId: '200', signal: controller.signal }));
  await assert.rejects(gateway.getRecordAudio({ file: 'record' }, { selfId: '200', signal: controller.signal })); assert.equal(calls, 1);
});
test('bad, missing, oversized or non-WAV results fail without accepting a remote path or retrying conversion', async () => {
  for (const data of [{ file: '/app/audio.wav' }, { base64: '!!!!' }, { base64: Buffer.from('not wave').toString('base64') },
    { base64: Buffer.alloc(100).toString('base64') }]) {
    const gateway = make(); let calls = 0; gateway.api = async () => { calls++; return { ok: true, data }; };
    await assert.rejects(gateway.getRecordAudio({ file: 'record' }, { selfId: '200', maxBytes: 64 })); assert.equal(calls, 1);
  }
});
test('resolved QQ audio reaches STT in a private temporary WAV and is removed on success and failure', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-record-test-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const fail of [false, true]) {
    let readFile, resolves = 0;
    const processor = new VoiceProcessor({ tempDir: directory, fetchImpl: () => assert.fail('must not fetch a SILK URL'), sttProvider: async file => {
      readFile = file; assert.equal(path.extname(file), '.wav'); assert.deepEqual(fs.readFileSync(file), wav); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      if (fail) throw new Error('decoder failure'); return '真实识别结果'; } });
    const result = await processor.processInboundVoice({ message: [{ type: 'record', data: { file: 'record', url: 'https://ignored.invalid/voice.silk' } }] },
      { resolveRecord: async data => { resolves++; assert.equal(data.file, 'record'); return wav; } });
    assert.equal(result.ok, !fail); assert.equal(resolves, 1); assert.equal(fs.existsSync(readFile), false); assert.deepEqual(fs.readdirSync(directory), []);
  }
});
test('CQ recording references use the same resolver and abort before transcription on a changed generation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-record-cancel-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controller = new AbortController(); const processor = new VoiceProcessor({ tempDir: directory, sttProvider: () => assert.fail('cancelled audio must not reach STT') });
  const result = await processor.processInboundVoice('[CQ:record,file=rec&amp;x&#44;y]', { signal: controller.signal,
    resolveRecord: async data => { assert.equal(data.file, 'rec&x,y'); controller.abort(); return wav; } });
  assert.equal(result.ok, false); assert.deepEqual(fs.readdirSync(directory), []);
});
