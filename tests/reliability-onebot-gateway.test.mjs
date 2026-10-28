import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { QQGateway } from '../packages/dsh-dafeiyu/src/qq-gateway.js';

class Socket extends EventEmitter {
  static instances = [];
  constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 0; this.sent = []; Socket.instances.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.emit('open'); }
  receive(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  close() { this.readyState = 3; this.emit('close'); }
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, options = {}) {
  const messages = [];
  const gateway = new QQGateway({ ownerQq: '100', onebotWs: 'ws://fixture.invalid', onebotHttp: '',
    appId: '', appSecret: '', WebSocketImpl: Socket, onMessage: (message) => messages.push(message), ...options });
  t.after(() => gateway.stop());
  await gateway.startOneBot();
  const socket = Socket.instances.at(-1);
  socket.open();
  return { gateway, socket, messages };
}
const incoming = (patch = {}) => ({ post_type: 'message', message_type: 'private', self_id: 200,
  user_id: 100, message_id: 1, time: 123, message: [{ type: 'text', data: { text: 'fixture' } }], ...patch });
function ack(socket, value) { socket.receive({ echo: socket.sent.at(-1).echo, ...value }); }

test('forward WS uses bearer auth and binds only the configured bot identity without automatic login queries', async (t) => {
  const { gateway, socket, messages } = await fixture(t, { accessToken: 'fixture-token', expectedSelfId: '200' });
  assert.equal(socket.options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(gateway.connected, true);
  assert.equal(gateway.loginVerified, false);
  assert.equal(socket.sent.length, 0);
  for (const patch of [{}, { self_id: undefined }, { self_id: 999 }, { user_id: 200 },
    { message_type: 'unknown' }, { message_type: 'group', group_id: undefined }]) socket.receive(incoming(patch));
  await settle();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].selfId, '200');
  assert.equal(messages[0].messageType, 'private');
  assert.equal(messages[0].userId, '100');
  assert.equal(gateway.selfId, '200');
  assert.equal(gateway.identityConflict, false);
});

test('unbound messages cannot establish identity, and lifecycle/heartbeat cannot replace a bound bot account', async (t) => {
  const { gateway, socket, messages } = await fixture(t);
  socket.receive(incoming());
  await settle();
  assert.equal(messages.length, 0);
  assert.equal(gateway.selfId, '');
  socket.receive({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 200 });
  socket.receive(incoming());
  await settle();
  assert.equal(messages.length, 1);
  assert.equal(gateway.selfId, '200');
  socket.receive({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 999, status: { online: true } });
  socket.receive(incoming());
  await settle();
  assert.equal(gateway.selfId, '200');
  assert.equal(gateway.identityConflict, true);
  assert.equal(messages.length, 1);
  assert.equal((await gateway.sendMessage('private:100', 'blocked', { selfId: '200' })).ok, false);
  assert.equal(socket.sent.length, 0);
});

test('explicit login probe validates the bound bot and preserves identity on conflicting login results', async (t) => {
  const { gateway, socket } = await fixture(t, { expectedSelfId: '200' });
  let pending = gateway.api('get_login_info');
  ack(socket, { status: 'ok', retcode: 0, data: { user_id: 200 } });
  assert.equal((await pending).ok, true);
  assert.equal(gateway.loginVerified, true);
  pending = gateway.api('get_login_info');
  ack(socket, { status: 'ok', retcode: 0, data: { user_id: 999 } });
  assert.equal((await pending).ok, false);
  assert.equal(gateway.selfId, '200');
  assert.equal(gateway.identityConflict, true);
  assert.equal(gateway.loginVerified, false);
  const before = socket.sent.length;
  assert.equal((await gateway.api('send_private_msg', { user_id: 100, message: 'blocked' })).ok, false);
  assert.equal(socket.sent.length, before);
});

test('owner and bot IDs cannot be conflated, including dynamic login binding', async (t) => {
  assert.throws(() => new QQGateway({ ownerQq: '100', expectedSelfId: '100' }), /主人 QQ/);
  const { gateway, socket } = await fixture(t);
  const pending = gateway.api('get_login_info');
  ack(socket, { status: 'ok', retcode: 0, data: { user_id: 100 } });
  assert.equal((await pending).ok, false);
  assert.equal(gateway.selfId, '');
  assert.equal(gateway.identityConflict, true);
});

test('WS malformed/async/missing-message-ID acknowledgements never confirm delivery or retry sends', async (t) => {
  const { gateway, socket } = await fixture(t, { expectedSelfId: '200' });
  for (const value of [{}, { status: 'async', retcode: 1 }, { status: 'unknown' },
    { status: 'ok', retcode: 'garbage' }, { status: 'ok', retcode: 0 }]) {
    const pending = gateway.sendMessage('private:100', 'fixture', { selfId: '200' });
    ack(socket, value);
    const result = await pending;
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.uncertain, true, JSON.stringify(value));
  }
  assert.equal(socket.sent.length, 5);
  const rejected = gateway.sendMessage('private:100', 'fixture', { selfId: '200' });
  ack(socket, { status: 'failed', retcode: 100, wording: 'fixture rejection' });
  assert.deepEqual(await rejected, { ok: false, error: 'fixture rejection' });
  const delivered = gateway.sendMessage('private:100', 'fixture', { selfId: '200' });
  ack(socket, { status: 'ok', retcode: 0, data: { message_id: 321 } });
  assert.deepEqual(await delivered, { ok: true, data: { message_id: 321 } });
  const before = socket.sent.length;
  assert.equal((await gateway.sendMessage('private:100', 'wrong bot', { selfId: '999' })).ok, false);
  assert.equal(socket.sent.length, before);
});

test('HTTP acknowledgement uses the same completion and delivery evidence requirements', async (t) => {
  const gateway = new QQGateway({ ownerQq: '100', onebotWs: '', onebotHttp: 'http://fixture.invalid', appId: '', appSecret: '' });
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; gateway.stop(); });
  for (const data of [{}, { status: 'async', retcode: 1 }, { status: 'ok', retcode: 0 }]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => data });
    const result = await gateway.sendMessage('private:100', 'fixture');
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: -5 } }) });
  assert.equal((await gateway.sendMessage('private:100', 'fixture')).ok, true);
});

test('disconnect clears login readiness, settles uncertain sends and stop suppresses reconnect', async (t) => {
  const { gateway, socket, messages } = await fixture(t, { expectedSelfId: '200' });
  assert.ok(gateway.connectedAtMs > 0);
  const login = gateway.api('get_login_info');
  ack(socket, { status: 'ok', retcode: 0, data: { user_id: 200 } });
  await login;
  const sending = gateway.sendMessage('private:100', 'fixture', { selfId: '200' });
  socket.close();
  assert.equal((await sending).uncertain, true);
  assert.equal(gateway.connected, false);
  assert.equal(gateway.connectedAtMs, 0);
  assert.equal(gateway.loginVerified, false);
  assert.equal(gateway.selfId, '200');
  assert.ok(gateway.reconnectTimer);
  gateway.stop();
  assert.equal(gateway.connectedAtMs, 0);
  assert.equal(gateway.reconnectTimer, null);
  socket.receive(incoming());
  await settle();
  assert.equal(messages.length, 0);
});

test('connection timestamp belongs to the current socket, and explicit status probes update only boolean online state', async (t) => {
  const gateway = new QQGateway({ ownerQq: '100', expectedSelfId: '200', onebotWs: 'ws://fixture.invalid',
    onebotHttp: '', appId: '', appSecret: '', WebSocketImpl: Socket });
  t.after(() => gateway.stop());
  assert.equal(gateway.connectedAtMs, 0);
  await gateway.startOneBot();
  const firstSocket = Socket.instances.at(-1);
  assert.equal(gateway.connectedAtMs, 0);
  const before = Date.now();
  firstSocket.open();
  assert.ok(gateway.connectedAtMs >= before && gateway.connectedAtMs <= Date.now());
  let pending = gateway.api('get_login_info');
  ack(firstSocket, { status: 'ok', retcode: 0, data: { user_id: 200 } });
  await pending;
  for (const online of [true, false]) {
    pending = gateway.api('get_status');
    ack(firstSocket, { status: 'ok', retcode: 0, data: { online, good: true } });
    assert.equal((await pending).ok, true);
    assert.equal(gateway.online, online);
    assert.equal(gateway.loginVerified, true);
  }
  pending = gateway.api('get_status');
  ack(firstSocket, { status: 'ok', retcode: 0, data: { online: 'true' } });
  await pending;
  assert.equal(gateway.online, false);
  pending = gateway.api('get_status');
  ack(firstSocket, { status: 'failed', retcode: 1, data: { online: true } });
  assert.equal((await pending).ok, false);
  assert.equal(gateway.online, false);
  firstSocket.close();
  assert.equal(gateway.connectedAtMs, 0);
  clearTimeout(gateway.reconnectTimer);
  gateway.reconnectTimer = null;
  await gateway.startOneBot();
  const secondSocket = Socket.instances.at(-1);
  secondSocket.open();
  assert.ok(gateway.connectedAtMs > 0);
  const currentTimestamp = gateway.connectedAtMs;
  firstSocket.close();
  assert.equal(gateway.connectedAtMs, currentTimestamp);
  gateway.stop();
  assert.equal(gateway.connectedAtMs, 0);
});

test('HTTP status and login probes use the same verified state updates without connecting a socket', async (t) => {
  const gateway = new QQGateway({ ownerQq: '100', expectedSelfId: '200', onebotWs: '',
    onebotHttp: 'http://fixture.invalid', appId: '', appSecret: '' });
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; gateway.stop(); });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 200 } }) });
  assert.equal((await gateway.api('get_login_info')).ok, true);
  assert.equal(gateway.loginVerified, true);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { online: true, good: true } }) });
  assert.equal((await gateway.api('get_status')).ok, true);
  assert.equal(gateway.online, true);
  assert.equal(gateway.loginVerified, true);
  assert.equal(gateway.connectedAtMs, 0);
});

test('OneBot recipient IDs keep long decimal strings exact across private, group and history RPCs', async (t) => {
  const gateway = new QQGateway({ onebotWs: '', onebotHttp: '', appId: '', appSecret: '' });
  t.after(() => gateway.stop());
  const requests = [];
  gateway.api = async (action, params) => { requests.push({ action, params }); return { ok: true, data: { messages: [] } }; };
  for (const id of ['9007199254740993', '99999999999999999999', '100']) {
    await gateway.sendPrivateMsg(id, 'fixture');
    await gateway.sendGroupMsg(id, 'fixture');
    await gateway.fetchFriendHistory(id);
  }
  assert.deepEqual(requests.map(({ action, params }) => [action, params.user_id ?? params.group_id]), [
    ['send_private_msg', '9007199254740993'], ['send_group_msg', '9007199254740993'], ['get_friend_msg_history', '9007199254740993'],
    ['send_private_msg', '99999999999999999999'], ['send_group_msg', '99999999999999999999'], ['get_friend_msg_history', '99999999999999999999'],
    ['send_private_msg', 100], ['send_group_msg', 100], ['get_friend_msg_history', 100],
  ]);
});
