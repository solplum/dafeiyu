import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { QQGateway } from '../packages/dsh-dafeiyu/src/qq-gateway.js';

const PRIVATE = 'PRIVATE_REMOTE_REASON_TOKEN_AND_MESSAGE';
class Socket extends EventEmitter {
  static instances = [];
  constructor() { super(); this.readyState = 0; this.sent = []; Socket.instances.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.emit('open'); }
  close(code, reason = Buffer.from(PRIVATE)) { this.readyState = 3; this.emit('close', code, reason); }
  receive(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
class BrowserSocket {
  static instances = [];
  constructor() { this.readyState = 0; this.listeners = new Map(); BrowserSocket.instances.push(this); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  emit(name, value) { this.listeners.get(name)?.(value); }
  open() { this.readyState = 1; this.emit('open'); }
  close() { this.readyState = 3; this.emit('close', { code: 1000, reason: PRIVATE }); }
}
async function fixture(t, WebSocketImpl = Socket) {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const gateway = new QQGateway({ ownerQq: '100', expectedSelfId: '200', appId: '', appSecret: '',
    onebotWs: 'ws://fixture.invalid', onebotHttp: '', WebSocketImpl });
  t.after(() => gateway.stop());
  await gateway.startOneBot();
  const socket = WebSocketImpl.instances?.at(-1);
  socket?.open();
  return { gateway, socket, warnings };
}

test('transport close records only fixed diagnostics and preserves unknown-send and reconnect semantics', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  assert.equal(gateway.lastDisconnect, null);
  const login = gateway.api('get_login_info');
  socket.receive({ echo: socket.sent.at(-1).echo, status: 'ok', retcode: 0, data: { user_id: 200 } });
  await login;
  gateway.online = true;
  const pending = gateway.sendMessage('private:100', 'synthetic once', { selfId: '200' });
  const before = Date.now();
  socket.close(1001);
  const result = await pending;
  assert.equal(result.uncertain, true);
  assert.equal(socket.sent.length, 2, 'one login read and one send, no replay or login write');
  assert.equal(gateway.connected, false);
  assert.equal(gateway.connectedAtMs, 0);
  assert.equal(gateway.loginVerified, false);
  assert.equal(gateway.online, false);
  assert.equal(gateway.selfId, '200');
  assert.ok(gateway.reconnectTimer);
  assert.deepEqual({ ...gateway.lastDisconnect, at: null }, { at: null, closeCode: 1001, reason: 'going-away' });
  assert.ok(Date.parse(gateway.lastDisconnect.at) >= before);
  assert.match(gateway.lastError, /传输.*断开/);
  assert.match(gateway.lastError, /QQ 登录状态需另行核实/);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0][1], gateway.lastDisconnect);
  assert.ok(!JSON.stringify([gateway.lastDisconnect, gateway.lastError, warnings]).includes(PRIVATE));
});

test('close codes have bounded fixed classifications and never copy a remote reason', async (t) => {
  for (const [code, closeCode, reason] of [[1000, 1000, 'normal-closure'], [1006, 1006, 'abnormal-closure'],
    [1012, 1012, 'service-restart'], [1013, 1013, 'retry-later'], [4001, 4001, 'other-closure'],
    [undefined, null, 'unknown-closure'], ['1001', null, 'unknown-closure'], [999, null, 'unknown-closure'],
    [5000, null, 'unknown-closure'], [1001.5, null, 'unknown-closure']]) {
    const { gateway, socket } = await fixture(t);
    socket.close(code);
    assert.equal(gateway.lastDisconnect.closeCode, closeCode);
    assert.equal(gateway.lastDisconnect.reason, reason);
    assert.ok(!gateway.lastError.includes(PRIVATE));
    gateway.stop();
  }
});

test('browser CloseEvent code is supported without reading its private reason', async (t) => {
  const { gateway, socket, warnings } = await fixture(t, BrowserSocket);
  const event = { code: 1012 };
  Object.defineProperty(event, 'reason', { get() { throw new Error('must not inspect remote reason'); } });
  socket.readyState = 3;
  socket.emit('close', event);
  assert.equal(gateway.lastDisconnect.closeCode, 1012);
  assert.equal(gateway.lastDisconnect.reason, 'service-restart');
  assert.equal(warnings.length, 1);
  assert.ok(gateway.reconnectTimer);
});

test('reconnect clears current error but retains last disconnect; late old events cannot corrupt it', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  socket.close(1006);
  const previous = gateway.lastDisconnect;
  clearTimeout(gateway.reconnectTimer); gateway.reconnectTimer = null;
  await gateway.startOneBot();
  const replacement = Socket.instances.at(-1); replacement.open();
  assert.equal(gateway.lastError, '');
  assert.equal(gateway.lastDisconnect, previous);
  socket.close(4001);
  socket.emit('error', new Error(PRIVATE));
  assert.equal(gateway.lastError, '');
  assert.equal(gateway.lastDisconnect, previous);
  assert.equal(gateway.connected, true);
  assert.equal(warnings.length, 1);
  replacement.emit('error', new Error(PRIVATE));
  assert.match(gateway.lastError, /传输.*错误/);
  assert.ok(!gateway.lastError.includes(PRIVATE));
  assert.equal(gateway.lastDisconnect, previous, 'an error is not itself a close');
});

test('intentional stop does not create a transport failure or schedule a new connection', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  gateway.stop();
  socket.emit('error', new Error(PRIVATE));
  socket.close(1001);
  assert.equal(gateway.lastDisconnect, null);
  assert.equal(gateway.lastError, '');
  assert.equal(gateway.reconnectTimer, null);
  assert.equal(warnings.length, 0);
  assert.equal(socket.sent.length, 0);
});

test('QQ offline evidence is distinct from a transport close and does not request login', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  socket.receive({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 200, status: { online: false } });
  assert.equal(gateway.online, false);
  assert.equal(gateway.connected, true);
  assert.equal(gateway.lastDisconnect, null);
  assert.equal(gateway.lastError, '');
  assert.equal(gateway.reconnectTimer, null);
  assert.equal(socket.sent.length, 0);
  assert.equal(warnings.length, 0);
});

test('startup errors cannot expose arbitrary exception details as diagnostics', async (t) => {
  class ThrowingSocket { constructor() { throw new Error(PRIVATE); } }
  const { gateway, warnings } = await fixture(t, ThrowingSocket);
  assert.match(gateway.lastError, /传输.*启动失败/);
  assert.equal(gateway.lastDisconnect, null);
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify([gateway.lastError, warnings]).includes(PRIVATE));
});

async function verifySocket(gateway, socket) {
  const login = gateway.api('get_login_info');
  socket.receive({ echo: socket.sent.at(-1).echo, status: 'ok', retcode: 0, data: { user_id: 200 } });
  assert.equal((await login).ok, true);
  socket.receive({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 200, status: { online: true } });
}

const offlineNotice = (extra = {}) => ({ post_type: 'notice', notice_type: 'bot_offline', self_id: 200,
  user_id: 200, time: 1, tag: PRIVATE, message: PRIVATE, ...extra });

test('verified current account offline notice records fixed evidence separately from transport and never replays pending sends', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  assert.equal(gateway.lastAccountOffline, null);
  await verifySocket(gateway, socket);
  const pending = gateway.sendMessage('private:100', 'synthetic once', { selfId: '200' });
  const echo = socket.sent.at(-1).echo;
  const before = Date.now();
  socket.receive(offlineNotice());
  assert.deepEqual({ ...gateway.lastAccountOffline, at: null }, { at: null, source: 'onebot',
    event: 'bot_offline', reason: 'account-offline' });
  assert.ok(Date.parse(gateway.lastAccountOffline.at) >= before, 'timestamp comes from the local clock');
  assert.ok(Object.isFrozen(gateway.lastAccountOffline));
  assert.equal(gateway.online, false);
  assert.equal(gateway.loginVerified, false);
  assert.equal(gateway.connected, true);
  assert.equal(gateway.wsClient, socket);
  assert.equal(gateway.lastDisconnect, null);
  assert.equal(gateway.reconnectTimer, null);
  assert.equal(socket.sent.length, 2, 'one login read and original send only');
  assert.match(gateway.lastError, /QQ 网关报告账号离线/);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0][1], gateway.lastAccountOffline);
  assert.ok(!JSON.stringify([warnings, gateway.lastError, gateway.lastAccountOffline]).includes(PRIVATE));
  assert.equal(gateway.pendingReqs.has(echo), true, 'notice cannot decide whether an existing send succeeded');
  socket.receive({ echo, status: 'ok', retcode: 0, data: { message_id: 'synthetic-receipt' } });
  assert.equal((await pending).ok, true, 'existing definitive send receipt keeps its meaning');
  const accountEvidence = gateway.lastAccountOffline;
  socket.close(1006);
  assert.equal(gateway.lastAccountOffline, accountEvidence, 'transport close retains account evidence');
  assert.equal(gateway.lastDisconnect.reason, 'abnormal-closure');
});

test('repeated account offline notices preserve the first local evidence and do not log again', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  socket.receive(offlineNotice());
  const evidence = gateway.lastAccountOffline;
  socket.receive(offlineNotice({ time: 99, tag: 'DIFFERENT_PRIVATE', message: 'DIFFERENT_PRIVATE' }));
  await verifySocket(gateway, socket);
  socket.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline, evidence);
  assert.equal(warnings.length, 1);
  assert.equal(socket.sent.length, 2, 'explicit login reads only, never automatic authentication');
  assert.equal(gateway.online, false);
  assert.equal(gateway.loginVerified, false);
  assert.equal(gateway.reconnectTimer, null);
});

test('account notices cannot establish connection identity from configuration or lifecycle alone', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  for (const event of [offlineNotice(), { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 200 },
    { post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 200, status: { online: true } }, offlineNotice()]) socket.receive(event);
  assert.equal(gateway.lastAccountOffline, null);
  assert.equal(gateway.online, true);
  assert.equal(gateway.loginVerified, false);
  assert.equal(gateway.lastError, '');
  assert.equal(warnings.length, 0);
});

test('foreign, invalid, unconfigured and conflicted account notices cannot change verified state', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  for (const self_id of [201, '0200', '', null, 100]) socket.receive(offlineNotice({ self_id }));
  socket.receive({ ...offlineNotice(), notice_type: 'other_notice' });
  assert.equal(gateway.lastAccountOffline, null);
  assert.equal(gateway.online, true);
  assert.equal(gateway.loginVerified, true);
  gateway.identityConflict = true;
  socket.receive(offlineNotice());
  gateway.identityConflict = false;
  gateway.expectedSelfId = '';
  socket.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline, null);
  assert.equal(gateway.online, true);
  assert.equal(gateway.loginVerified, true);
  assert.equal(warnings.length, 0);
});

test('old socket and stopped gateway account notices have no effect', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  socket.close(1006);
  clearTimeout(gateway.reconnectTimer); gateway.reconnectTimer = null;
  await gateway.startOneBot();
  const replacement = Socket.instances.at(-1); replacement.open();
  await verifySocket(gateway, replacement);
  const transport = gateway.lastDisconnect;
  socket.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline, null);
  assert.equal(gateway.online, true);
  assert.equal(gateway.loginVerified, true);
  assert.equal(gateway.lastError, '');
  assert.equal(gateway.lastDisconnect, transport);
  gateway.stop();
  replacement.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline, null);
  assert.equal(warnings.length, 1, 'only the earlier transport close was logged');
});

test('a new socket cannot reuse prior connection verification or an HTTP login result', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  socket.close(1006);
  clearTimeout(gateway.reconnectTimer); gateway.reconnectTimer = null;
  await gateway.startOneBot();
  const replacement = Socket.instances.at(-1); replacement.open();
  gateway.loginVerified = true; gateway.online = true; // A separate HTTP observation must not authenticate this socket.
  replacement.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline, null);
  assert.equal(gateway.online, true);
  assert.equal(gateway.loginVerified, true);
  await verifySocket(gateway, replacement);
  replacement.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline.event, 'bot_offline');
  assert.equal(warnings.length, 2);
});

test('account offline notice preserves cancellation as an unknown send and does not replay it', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  const controller = new AbortController();
  const send = gateway.api('send_private_msg', { user_id: 100, message: 'synthetic once' }, { signal: controller.signal });
  socket.receive(offlineNotice());
  controller.abort();
  const result = await send;
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(gateway.pendingReqs.size, 0);
  assert.equal(socket.sent.length, 2);
  assert.equal(gateway.reconnectTimer, null);
  assert.equal(warnings.length, 1);
});

test('identity conflict revokes socket proof even if a separate observation later restores loginVerified', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  socket.receive({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 201, status: { online: true } });
  socket.receive({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 200, status: { online: true } });
  gateway.loginVerified = true; // Model a later successful HTTP login observation, not this socket's proof.
  socket.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline, null);
  assert.equal(gateway.online, true);
  assert.equal(warnings.length, 0);
  await verifySocket(gateway, socket);
  socket.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline.event, 'bot_offline');
  assert.equal(warnings.length, 1);
});

async function statusSocket(gateway, socket, online = true) {
  const status = gateway.api('get_status');
  socket.receive({ echo: socket.sent.at(-1).echo, status: 'ok', retcode: 0, data: { online } });
  assert.equal((await status).ok, true);
}

test('one socket records a new offline episode after fresh account verification and a subsequent explicit online status', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  socket.receive(offlineNotice());
  const first = gateway.lastAccountOffline;
  await verifySocket(gateway, socket);
  assert.equal(gateway.lastAccountOffline, first, 'identity and heartbeat alone do not begin another episode');
  await statusSocket(gateway, socket);
  assert.equal(gateway.lastError, '');
  socket.receive(offlineNotice());
  assert.notEqual(gateway.lastAccountOffline, first);
  assert.equal(warnings.length, 2);
  assert.equal(gateway.loginVerified, false);
  assert.equal(gateway.online, false);
  assert.equal(gateway.reconnectTimer, null);
});

test('ordinary lifecycle disable retains proven socket identity for fixed offline diagnosis only', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  socket.receive({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'disable', self_id: 200 });
  assert.equal(gateway.loginVerified, false);
  socket.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline.event, 'bot_offline');
  assert.equal(gateway.connected, true);
  assert.equal(gateway.loginVerified, false);
  assert.equal(gateway.online, false);
  assert.equal(socket.sent.length, 1);
  assert.equal(warnings.length, 1);
});

test('online status observed before fresh login verification cannot reset the offline episode', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  socket.receive(offlineNotice());
  const first = gateway.lastAccountOffline;
  await statusSocket(gateway, socket);
  await verifySocket(gateway, socket);
  socket.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline, first);
  assert.equal(warnings.length, 1);
});

test('a status request issued before renewed verification cannot reset an episode by arriving late', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  socket.receive(offlineNotice());
  const first = gateway.lastAccountOffline;
  const staleStatus = gateway.api('get_status');
  const echo = socket.sent.at(-1).echo;
  await verifySocket(gateway, socket);
  socket.receive({ echo, status: 'ok', retcode: 0, data: { online: true } });
  assert.equal((await staleStatus).ok, true);
  socket.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline, first);
  assert.equal(warnings.length, 1);
});

test('a login request issued before the offline notice is not a fresh recovery verification', async (t) => {
  const { gateway, socket, warnings } = await fixture(t);
  await verifySocket(gateway, socket);
  const staleLogin = gateway.api('get_login_info');
  const echo = socket.sent.at(-1).echo;
  socket.receive(offlineNotice());
  const first = gateway.lastAccountOffline;
  socket.receive({ echo, status: 'ok', retcode: 0, data: { user_id: 200 } });
  assert.equal((await staleLogin).ok, true);
  await statusSocket(gateway, socket);
  socket.receive(offlineNotice());
  assert.equal(gateway.lastAccountOffline, first);
  assert.equal(warnings.length, 1);
});

test('failed or mismatched login-info responses revoke proof rather than preserving diagnostic permission', async (t) => {
  for (const response of [{ status: 'failed', retcode: 1, data: null },
    { status: 'ok', retcode: 0, data: { user_id: 300 } }]) {
    const { gateway, socket, warnings } = await fixture(t);
    await verifySocket(gateway, socket);
    const login = gateway.api('get_login_info');
    socket.receive({ echo: socket.sent.at(-1).echo, ...response });
    assert.equal((await login).ok, false);
    socket.receive({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 200, status: { online: true } });
    gateway.loginVerified = true; // A separate HTTP observation cannot restore this socket's proof.
    socket.receive(offlineNotice());
    assert.equal(gateway.lastAccountOffline, null);
    assert.equal(warnings.length, 0);
    gateway.stop();
  }
});
