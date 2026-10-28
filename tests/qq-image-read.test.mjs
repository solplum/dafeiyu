import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { QQGateway } from '../packages/dsh-dafeiyu/src/qq-gateway.js';

async function fixture(t) {
  let socket;
  class Socket extends EventEmitter {
    constructor() { super(); socket = this; this.readyState = 0; this.sent = []; }
    send(bytes) { this.sent.push(JSON.parse(bytes)); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const gateway = new QQGateway({ ownerQq: '100', expectedSelfId: '200', onebotWs: 'ws://fixture.invalid',
    onebotHttp: 'http://fixture.invalid', WebSocketImpl: Socket });
  t.after(() => gateway.stop());
  await gateway.startOneBot(); socket.readyState = 1; socket.emit('open');
  return { gateway, socket };
}

test('a single image lookup waits for its one result and cannot fall back or accept late success after its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('image lookup must not repeat through HTTP'));
  const { gateway, socket } = await fixture(t);
  const pending = gateway.api('get_image', { file: 'admitted-image' }, { singleAttempt: true });
  t.mock.timers.tick(3500); assert.equal(gateway.pendingReqs.size, 1); assert.equal(socket.sent.length, 1);
  t.mock.timers.tick(26499); assert.equal(gateway.pendingReqs.size, 1);
  t.mock.timers.tick(1); const result = await pending;
  assert.equal(result.ok, false); assert.match(result.error, /超时.*未自动重试/);
  assert.equal(gateway.pendingReqs.size, 0);
  socket.emit('message', JSON.stringify({ echo: socket.sent[0].echo, status: 'ok', retcode: 0, data: { url: 'https://fixture.invalid/late' } }));
  assert.equal(result.ok, false); assert.equal(socket.sent.length, 1);
});

test('the one image result may arrive after three seconds and cancellation prevents a fallback read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('image lookup must not repeat through HTTP'));
  const { gateway, socket } = await fixture(t);
  const pending = gateway.api('get_image', { file: 'admitted-image' }, { singleAttempt: true });
  t.mock.timers.tick(3500);
  socket.emit('message', JSON.stringify({ echo: socket.sent[0].echo, status: 'ok', retcode: 0, data: { url: 'https://fixture.invalid/image' } }));
  assert.deepEqual(await pending, { ok: true, data: { url: 'https://fixture.invalid/image' } });
  const controller = new AbortController();
  const cancelled = gateway.api('get_image', { file: 'next-image' }, { singleAttempt: true, signal: controller.signal });
  controller.abort(); assert.equal((await cancelled).ok, false);
  t.mock.timers.tick(30000); assert.equal(socket.sent.length, 2); assert.equal(gateway.pendingReqs.size, 0);
});

test('direct HTTP image lookup uses one bounded request and aborts at thirty seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++; signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const gateway = new QQGateway({ ownerQq: '100', onebotWs: '', onebotHttp: 'http://fixture.invalid' });
  t.after(() => gateway.stop());
  const pending = gateway.api('get_image', { file: 'admitted-image' }, { singleAttempt: true });
  t.mock.timers.tick(29999); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1); assert.equal((await pending).ok, false);
  assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(gateway.httpControllers.size, 0);
});

test('ordinary read probes retain their existing HTTP fallback when singleAttempt was not requested', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return { ok: true,
    json: async () => ({ status: 'ok', retcode: 0, data: { online: true } }) }; });
  const { gateway, socket } = await fixture(t);
  const pending = gateway.api('get_status');
  t.mock.timers.tick(3000);
  assert.equal((await pending).ok, true); assert.equal(calls, 1); assert.equal(socket.sent.length, 1);
});
