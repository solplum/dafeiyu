import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { NapCatPanel, NapCatPanelError } from '../packages/dsh-dafeiyu/src/napcat-panel.js';

const SECRET = 'NAPCAT_PRIVATE_TOKEN_SENTINEL';
const CREDENTIAL = Buffer.from('NAPCAT_PRIVATE_CREDENTIAL_SENTINEL').toString('base64');
const QR_URL = 'https://txz.qq.com/p?k=PRIVATE_SCAN_TOKEN_SENTINEL';
const NEW_QR_URL = 'https://txz.qq.com/p?k=NEW_PRIVATE_SCAN_TOKEN_SENTINEL';
const ID = 'a'.repeat(64);
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length); header.write(type, 4);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), bytes])));
  return Buffer.concat([header, bytes, checksum]);
}
function png() {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const success = (data) => new Response(JSON.stringify({ code: 0, message: 'success', data }), { headers: { 'Content-Type': 'application/json' } });
function clean(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [SECRET, CREDENTIAL, QR_URL, NEW_QR_URL]) assert.equal(serialized.includes(secret), false);
}
function fixture(t, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-panel-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'data/config'), { recursive: true }); fs.mkdirSync(path.join(directory, 'tools'));
  fs.writeFileSync(path.join(directory, 'tools/docker'), 'fixture-only-do-not-execute', { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'compose.yaml'), JSON.stringify({ name: 'fixture-qq', services: { napcat: { container_name: 'fixture-napcat' } } }));
  const webuiFile = path.join(directory, 'data/config/webui.json');
  fs.writeFileSync(webuiFile, JSON.stringify({ host: '0.0.0.0', port: 6099, token: SECRET }));
  const state = { commands: [], requests: [], expected: '456', authCalls: 0, qrReads: 0, statusCalls: 0,
    png: png(), beforeInfo: null, afterQrRead: null, encodedUrls: [],
    inspect: { id: ID, state: 'running', running: true, paused: false, restarting: false, restarts: 2,
      ports: { '6099/tcp': [{ HostIp: '127.0.0.1', HostPort: '16099' }] }, project: 'fixture-qq', service: 'napcat', workingDir: directory },
    login: { isLogin: false, isOffline: false, coreReady: false, qrLoginAccepted: false, loginPhase: 'waiting_qrcode',
      qrcodeurl: QR_URL, loginError: '' },
    info: { uin: '', online: false, uid: SECRET, nick: SECRET, avatarUrl: QR_URL },
  };
  const execFileImpl = options.execFileImpl || (async (file, args, execOptions) => {
    state.commands.push(args);
    assert.equal(file, path.join(directory, 'tools/docker'));
    assert.deepEqual(args.slice(0, 2), ['--host', `unix://${process.platform === 'darwin' ? path.join(os.homedir(), '.orbstack/run/docker.sock') : '/var/run/docker.sock'}`]);
    assert.equal(execOptions.cwd, directory);
    assert.equal(execOptions.env.DOCKER_CONTEXT, undefined);
    assert.equal(execOptions.env.DOCKER_TLS_VERIFY, undefined);
    assert.equal(typeof execOptions.timeout, 'number');
    if (args[2] === 'inspect') return { stdout: JSON.stringify(state.inspect), stderr: SECRET };
    assert.fail('QR must not read the asynchronous container PNG');
  });
  const fetchImpl = options.fetchImpl || (async (url, fetchOptions) => {
    const endpoint = new URL(url).pathname;
    assert.equal(new URL(url).origin, 'http://127.0.0.1:16099');
    assert.equal(new URL(url).search, '');
    assert.equal(fetchOptions.method, 'POST'); assert.equal(fetchOptions.redirect, 'error');
    assert.ok(fetchOptions.signal instanceof AbortSignal);
    state.requests.push(endpoint);
    const intercepted = await state.interceptResponse?.(endpoint);
    if (intercepted) return intercepted;
    if (endpoint === '/api/auth/login') {
      state.authCalls++;
      assert.deepEqual(JSON.parse(fetchOptions.body), { hash: createHash('sha256').update(SECRET + '.napcat').digest('hex') });
      assert.equal(fetchOptions.headers.Authorization, undefined);
      return success({ Credential: CREDENTIAL });
    }
    assert.equal(fetchOptions.headers.Authorization, `Bearer ${CREDENTIAL}`);
    assert.deepEqual(JSON.parse(fetchOptions.body), {});
    if (endpoint === '/api/QQLogin/CheckLoginStatus') { state.statusCalls++; return success(state.login); }
    if (endpoint === '/api/QQLogin/GetQQLoginInfo') { await state.beforeInfo?.(); return success(state.info); }
    if (endpoint === '/api/QQLogin/RefreshQRcode') { state.login.qrcodeurl = NEW_QR_URL; state.login.loginError = ''; return success({ qrcodeurl: NEW_QR_URL }); }
    assert.fail('Unexpected NapCat endpoint');
  });
  const panel = new NapCatPanel({ deploymentDir: directory, getExpectedSelfId: () => state.expected,
    fetchImpl, execFileImpl, qrEncoder: async (url) => {
      state.encodedUrls.push(url); state.qrReads++; state.afterQrRead?.();
      if (state.qrError) throw new Error(SECRET);
      return state.png;
    }, ...options });
  t.after(() => panel.dispose());
  return { panel, state, directory, webuiFile };
}

test('status uses authenticated v4.18.41 POST contracts and returns only safe fields', async (t) => {
  const { panel, state } = fixture(t);
  state.login = { ...state.login, isLogin: true, coreReady: true, loginPhase: 'ready' };
  state.info = { ...state.info, uin: '456', online: true };
  const value = await panel.status(); clean(value);
  assert.equal(value.configured, true);
  assert.deepEqual(value.container, { available: true, running: true, state: 'running', restarts: 2 });
  assert.deepEqual(value.webui, { reachable: true, authenticated: true });
  assert.deepEqual(value.login, { isLogin: true, isOffline: false, phase: 'ready', coreReady: true,
    qrLoginAccepted: false, accountId: '456', selfMatches: true, qrcodeRevision: null, issue: null });
  assert.deepEqual(state.requests, ['/api/auth/login', '/api/QQLogin/CheckLoginStatus', '/api/QQLogin/GetQQLoginInfo']);
  assert.equal(JSON.stringify(panel), '{}');
});

test('login flags never prove the bound account without GetQQLoginInfo identity and online evidence', async (t) => {
  const f = fixture(t); f.state.login = { ...f.state.login, isLogin: true, coreReady: true, loginPhase: 'ready' };
  let value = await f.panel.status(); clean(value);
  assert.equal(value.code, 'LOGIN_IDENTITY_UNVERIFIED'); assert.equal(value.login.selfMatches, null);
  f.state.info = { uin: '789', online: true };
  value = await f.panel.status(); clean(value);
  assert.equal(value.code, 'ACCOUNT_MISMATCH'); assert.equal(value.login.selfMatches, false); assert.equal(value.login.accountId, '789');
  const qr = await f.panel.qrcode({ refresh: true }); clean(qr);
  assert.equal(qr.available, false);
  assert.equal(f.state.qrReads, 0);
  assert.equal(f.state.requests.includes('/api/QQLogin/RefreshQRcode'), false);
});

test('confirmed logged-in, offline, accepted, initializing and reconnecting accounts never read or refresh QR', async (t) => {
  for (const phase of ['ready', 'offline', 'qrcode_scanned', 'initializing', 'reconnecting']) {
    const f = fixture(t); f.state.login.loginPhase = phase;
    if (phase === 'ready') { f.state.login.isLogin = true; f.state.login.coreReady = true; f.state.info = { uin: '456', online: true }; }
    if (phase === 'offline') { f.state.login.isOffline = true; f.state.info = { uin: '456', online: false }; }
    if (phase === 'qrcode_scanned' || phase === 'initializing') f.state.login.qrLoginAccepted = true;
    const value = await f.panel.qrcode({ refresh: true }); clean(value);
    assert.equal(value.available, false, phase); assert.equal(value.code, 'LOGIN_NOT_WAITING', phase);
    assert.equal(f.state.qrReads, 0, phase);
    assert.equal(f.state.requests.includes('/api/QQLogin/RefreshQRcode'), false, phase);
    assert.equal(f.state.commands.some((args) => args.includes('restart') || args.includes('stop')), false);
  }
});

test('an unlogged waiting account locally encodes its current API URL without reading a stale cache PNG', async (t) => {
  const f = fixture(t);
  const qr = await f.panel.qrcode(); clean(qr);
  assert.equal(qr.available, true); assert.equal(qr.image.mime, 'image/png');
  assert.deepEqual(Buffer.from(qr.image.base64, 'base64'), f.state.png);
  assert.equal(f.state.qrReads, 1); assert.equal(f.state.statusCalls, 3);
  assert.deepEqual(f.state.encodedUrls, [QR_URL]);
  assert.equal(qr.revision, createHash('sha256').update(QR_URL).digest('hex'));
  assert.ok(Number.isFinite(Date.parse(qr.checkedAt)));
  assert.equal(f.state.commands.some((args) => args.includes('exec')), false);
  assert.equal(f.state.requests.includes('/api/QQLogin/GetQQLoginQrcode'), false);
  assert.equal(f.state.requests.includes('/api/QQLogin/RefreshQRcode'), false);
  assert.equal(Object.hasOwn(qr, 'expiresAt'), false, 'API supplies no proven QR expiry');
});

test('refresh requires an explicit true and never retries or calls logout/start endpoints', async (t) => {
  const f = fixture(t);
  const refreshed = await f.panel.qrcode({ refresh: true });
  assert.equal(refreshed.available, true);
  assert.deepEqual(f.state.encodedUrls, [NEW_QR_URL], 'encode fresh URL even while the container cache is still the old PNG');
  assert.equal(refreshed.revision, createHash('sha256').update(NEW_QR_URL).digest('hex'));
  assert.equal(f.state.requests.filter((endpoint) => endpoint === '/api/QQLogin/RefreshQRcode').length, 1);
  await assert.rejects(f.panel.qrcode({ refresh: 'true' }), (error) => error instanceof NapCatPanelError && error.code === 'INVALID_PATCH');
  assert.ok(f.state.requests.every((endpoint) => ['/api/auth/login', '/api/QQLogin/CheckLoginStatus',
    '/api/QQLogin/GetQQLoginInfo', '/api/QQLogin/RefreshQRcode'].includes(endpoint)));
});

test('status reports a safe revision and never exposes raw login errors or scan URLs', async (t) => {
  const f = fixture(t);
  let value = await f.panel.status(); clean(value);
  assert.equal(value.login.qrcodeRevision, createHash('sha256').update(QR_URL).digest('hex'));
  assert.equal(value.login.issue, null);
  for (const [error, code] of [
    ['二维码已过期，请刷新 ' + SECRET + QR_URL, 'QR_EXPIRED'],
    ['QQ 登录服务无法重新连接 ' + SECRET, 'LOGIN_NETWORK_UNAVAILABLE'],
    ['登录失败: ' + SECRET + QR_URL, 'LOGIN_REJECTED'],
  ]) {
    f.state.login.loginError = error;
    value = await f.panel.status(); clean(value);
    assert.equal(value.login.issue.code, code);
    assert.equal(value.login.qrcodeRevision, null);
    const qr = await f.panel.qrcode(); clean(qr);
    assert.equal(qr.code, code); assert.equal(qr.available, false);
  }
  assert.equal(f.state.qrReads, 0);
  assert.equal(f.state.requests.includes('/api/QQLogin/RefreshQRcode'), false);
  assert.equal((await f.panel.qrcode({ refresh: true })).available, true, 'explicit refresh can recover an expired login generation');
});

test('automatic QR rotation changes status revision and a generation change during encoding withholds the old code', async (t) => {
  const f = fixture(t);
  const initial = await f.panel.status();
  f.state.login.qrcodeurl = NEW_QR_URL;
  const rotated = await f.panel.status(); clean(rotated);
  assert.notEqual(rotated.login.qrcodeRevision, initial.login.qrcodeRevision);
  assert.equal(rotated.login.qrcodeRevision, createHash('sha256').update(NEW_QR_URL).digest('hex'));
  f.state.afterQrRead = () => { f.state.login.qrcodeurl = QR_URL; };
  const qr = await f.panel.qrcode(); clean(qr);
  assert.equal(qr.available, false); assert.equal(qr.code, 'QR_CHANGED');
  assert.deepEqual(f.state.encodedUrls, [NEW_QR_URL]);
  assert.equal(Object.hasOwn(qr, 'image'), false);
});

test('a refresh that reports the same URL cannot reuse old pixels', async (t) => {
  const f = fixture(t);
  f.state.interceptResponse = (endpoint) => endpoint === '/api/QQLogin/RefreshQRcode' ? success({ qrcodeurl: QR_URL }) : undefined;
  const qr = await f.panel.qrcode({ refresh: true }); clean(qr);
  assert.equal(qr.available, false); assert.equal(qr.code, 'QR_REFRESH_UNCONFIRMED'); assert.equal(f.state.qrReads, 0);
});

test('generating, missing or untrusted QR URLs never render a stale or foreign scan credential', async (t) => {
  const f = fixture(t);
  for (const [phase, url] of [
    ['generating_qrcode', QR_URL], ['waiting_qrcode', ''],
    ['waiting_qrcode', 'https://evil.invalid/private-scan-token'],
    ['waiting_qrcode', 'https://qq.com.evil.invalid/private-scan-token'],
    ['waiting_qrcode', 'http://txz.qq.com/p?k=private'],
    ['waiting_qrcode', 'https://private@txz.qq.com/p?k=private'],
    ['waiting_qrcode', 'https://txz.qq.com:9000/p?k=private'],
    ['waiting_qrcode', 'https://txz.qq.com/p?k=private\n'],
    ['waiting_qrcode', 'https://txz.qq.com/p?k=' + 'x'.repeat(2048)],
  ]) {
    f.state.login.loginPhase = phase; f.state.login.qrcodeurl = url;
    const st = await f.panel.status(); clean(st); assert.equal(st.login.qrcodeRevision, null);
    const qr = await f.panel.qrcode(); clean(qr);
    assert.equal(qr.available, false); assert.equal(qr.code, 'LOGIN_NOT_WAITING');
  }
  assert.equal(f.state.qrReads, 0);
});

test('the declared real encoder creates a valid PNG from a fixed offline QQ URL', async (t) => {
  // No QQ API, network, browser, account data or scan is involved in this probe.
  const f = fixture(t, { qrEncoder: undefined });
  const qr = await f.panel.qrcode(); clean(qr);
  assert.equal(qr.available, true);
  const bytes = Buffer.from(qr.image.base64, 'base64');
  assert.equal(bytes.readUInt32BE(16), 320); assert.equal(bytes.readUInt32BE(20), 320);
  assert.equal(qr.revision, createHash('sha256').update(QR_URL).digest('hex'));
  assert.equal(f.state.qrReads, 0); assert.equal(f.state.commands.some((args) => args.includes('exec')), false);
});

test('QR bytes and refresh are withheld when owner authorization is revoked during awaited work', async (t) => {
  const f = fixture(t); let authorized = true;
  f.state.beforeInfo = () => { authorized = false; };
  let value = await f.panel.qrcode({ refresh: true }, { authorize: () => authorized }); clean(value);
  assert.equal(value.code, 'FORBIDDEN'); assert.equal(f.state.qrReads, 0);
  assert.equal(f.state.requests.includes('/api/QQLogin/RefreshQRcode'), false);
  f.state.beforeInfo = null; authorized = true;
  f.state.afterQrRead = () => { authorized = false; };
  value = await f.panel.qrcode({}, { authorize: () => authorized }); clean(value);
  assert.equal(value.code, 'FORBIDDEN'); assert.equal(Object.hasOwn(value, 'image'), false);
});

test('new login while image is being read and a changed expected account cannot return a stale code', async (t) => {
  const f = fixture(t);
  f.state.afterQrRead = () => { f.state.login.isLogin = true; f.state.login.coreReady = true; f.state.login.loginPhase = 'ready'; };
  let qr = await f.panel.qrcode(); clean(qr);
  assert.equal(qr.available, false); assert.equal(qr.code, 'LOGIN_NOT_WAITING');
  f.state.login = { ...f.state.login, isLogin: false, coreReady: false, loginPhase: 'waiting_qrcode' };
  f.state.afterQrRead = () => { f.state.expected = '789'; };
  qr = await f.panel.qrcode(); clean(qr);
  assert.equal(qr.code, 'EXPECTED_ACCOUNT_CHANGED'); assert.equal(Object.hasOwn(qr, 'image'), false);
});

test('QR rejects empty, fake headers, corrupt CRC, oversized and incomplete image data', async (t) => {
  const f = fixture(t), corrupted = png(); corrupted[corrupted.length - 1] ^= 1;
  for (const bytes of [Buffer.alloc(0), Buffer.from('not an image ' + SECRET), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    corrupted, Buffer.alloc(2 * 1024 * 1024 + 1), png().subarray(0, 40)]) {
    f.state.png = bytes;
    const value = await f.panel.qrcode(); clean(value);
    assert.equal(value.available, false); assert.equal(value.code, 'QR_IMAGE_INVALID');
  }
});

test('credential caching avoids WebUI login-rate exhaustion across polling and concurrent probes', async (t) => {
  const { panel, state } = fixture(t);
  await Promise.all([panel.status(), panel.status(), panel.status()]);
  await panel.status();
  assert.equal(state.authCalls, 1);
  assert.equal(state.requests.filter((endpoint) => endpoint === '/api/QQLogin/CheckLoginStatus').length, 4);
});

test('missing or unbound deployment and stopped container do not contact WebUI', async (t) => {
  const f = fixture(t); f.state.inspect.running = false; f.state.inspect.state = 'exited';
  let value = await f.panel.status(); clean(value);
  assert.equal(value.container.running, false); assert.equal(f.state.requests.length, 0);
  const unsupported = new NapCatPanel({ platform: 'linux', execFileImpl() { assert.fail('no unconfigured Docker execution'); },
    fetchImpl() { assert.fail('no unconfigured HTTP'); } });
  value = await unsupported.status(); clean(value);
  assert.equal(value.configured, false); assert.equal(value.code, 'NOT_CONFIGURED');
  f.state.inspect.running = true; f.state.inspect.state = 'running'; f.state.expected = '';
  const qr = await f.panel.qrcode({ refresh: true }); clean(qr);
  assert.equal(qr.code, 'EXPECTED_ACCOUNT_REQUIRED'); assert.equal(f.state.qrReads, 0);
});

test('foreign container labels and non-loopback WebUI bindings fail before sending credentials', async (t) => {
  for (const mutate of [(state) => { state.inspect.workingDir = '/other/deployment'; },
    (state) => { state.inspect.project = 'other'; }, (state) => { state.inspect.service = 'other'; },
    (state) => { state.inspect.ports['6099/tcp'][0].HostIp = '0.0.0.0'; },
    (state) => { state.inspect.ports['6099/tcp'].push({ HostIp: '0.0.0.0', HostPort: '16099' }); }]) {
    const f = fixture(t); mutate(f.state);
    const value = await f.panel.status(); clean(value);
    assert.ok(['CONTAINER_MISMATCH', 'WEBUI_BINDING_UNSAFE'].includes(value.code));
    assert.equal(f.state.requests.length, 0);
  }
});

test('WebUI API failures, 2FA and malformed or oversized responses never expose credentials', async (t) => {
  for (const response of [() => success({ require2FA: true }), () => success({ Credential: 'bad\n' + SECRET }),
    () => new Response(JSON.stringify({ code: -1, message: SECRET })), () => new Response(SECRET, { status: 500 }),
    () => new Response(SECRET), () => new Response(JSON.stringify({ code: 0, data: SECRET.repeat(4000) }))]) {
    const f = fixture(t, { fetchImpl: async () => response() });
    const value = await f.panel.status(); clean(value);
    assert.equal(value.webui.authenticated, false); assert.ok(value.error);
    assert.equal((await f.panel.qrcode()).available, false);
  }
});

test('fetch and Docker probes have enforced timeouts even when a dependency ignores its signal', { timeout: 1000 }, async (t) => {
  let fetchSignal;
  const http = fixture(t, { timeoutMs: 15, fetchImpl: async (_url, options) => {
    fetchSignal = options.signal; return new Promise(() => {});
  } });
  let value = await http.panel.status(); clean(value);
  assert.equal(value.code, 'PROBE_TIMEOUT'); assert.equal(fetchSignal.aborted, true);
  let dockerSignal;
  const docker = fixture(t, { timeoutMs: 15, execFileImpl: async (_file, _args, options) => {
    dockerSignal = options.signal; return new Promise(() => {});
  } });
  value = await docker.panel.status(); clean(value);
  assert.equal(value.code, 'PROBE_TIMEOUT'); assert.equal(dockerSignal.aborted, true);
});

test('underlying command errors and disposal do not retain credentials or allow further probes', async (t) => {
  const f = fixture(t, { execFileImpl: async () => { throw new Error(SECRET); } });
  let value = await f.panel.status(); clean(value); assert.equal(value.code, 'DOCKER_UNAVAILABLE');
  const active = fixture(t); await active.panel.status(); active.panel.dispose();
  const commands = active.state.commands.length, requests = active.state.requests.length;
  value = await active.panel.status(); clean(value); assert.equal(value.code, 'UNAVAILABLE');
  assert.equal(active.state.commands.length, commands); assert.equal(active.state.requests.length, requests);
  const qr = await active.panel.qrcode({ refresh: true }); clean(qr);
  assert.equal(qr.available, false); assert.equal(active.state.commands.length, commands);
});

test('refresh failure or a missing PNG cannot fall back to an old cached image', async (t) => {
  const f = fixture(t);
  assert.equal((await f.panel.qrcode()).available, true);
  const initialReads = f.state.qrReads;
  f.state.interceptResponse = (endpoint) => endpoint === '/api/QQLogin/RefreshQRcode'
    ? new Response(JSON.stringify({ code: -1, message: SECRET + QR_URL })) : undefined;
  let qr = await f.panel.qrcode({ refresh: true }); clean(qr);
  assert.equal(qr.available, false); assert.equal(qr.code, 'WEBUI_REJECTED');
  assert.equal(f.state.qrReads, initialReads);
  f.state.interceptResponse = null; f.state.qrError = true;
  qr = await f.panel.qrcode(); clean(qr);
  assert.equal(qr.code, 'QR_READ_FAILED'); assert.equal(Object.hasOwn(qr, 'image'), false);
});

test('no owner authorization means no Docker/WebUI work and pending probes are cancelled on dispose', { timeout: 1000 }, async (t) => {
  const f = fixture(t);
  for (const authorize of [() => false, () => { throw new Error(SECRET); }, () => Promise.resolve(true)]) {
    const value = await f.panel.qrcode({ refresh: true }, { authorize }); clean(value);
    assert.equal(value.code, 'FORBIDDEN');
  }
  assert.equal(f.state.commands.length, 0); assert.equal(f.state.requests.length, 0);
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  let signal;
  const waiting = fixture(t, { fetchImpl: async (_url, options) => {
    signal = options.signal; entered(); return new Promise(() => {});
  } });
  const pending = waiting.panel.status();
  await ready; waiting.panel.dispose();
  const value = await pending; clean(value);
  assert.equal(value.code, 'PROBE_TIMEOUT'); assert.equal(signal.aborted, true);
});

test('invalid phases and contradictory API evidence fail closed instead of offering a QR', async (t) => {
  const f = fixture(t);
  f.state.login.loginPhase = SECRET;
  let value = await f.panel.qrcode({ refresh: true }); clean(value);
  assert.equal(value.available, false); assert.equal(value.code, 'LOGIN_STATE_INVALID');
  f.state.login.loginPhase = 'offline'; f.state.login.isOffline = true;
  f.state.info = { uin: '456', online: true };
  value = await f.panel.status(); clean(value);
  assert.equal(value.code, 'LOGIN_IDENTITY_UNVERIFIED');
  assert.equal(f.state.qrReads, 0);
  assert.equal(f.state.requests.includes('/api/QQLogin/RefreshQRcode'), false);
});

test('fixed account-offline markers precede QR and network keywords without exposing tips or requesting a scan', async (t) => {
  const f = fixture(t);
  for (const [marker, code] of [['SelfOffline', 'LOGIN_SELF_OFFLINE'], ['KickedOffLine', 'LOGIN_KICKED_OFFLINE']]) {
    f.state.login.loginError = `[${marker}] expired offline 网络断开 ${SECRET} ${QR_URL}`;
    const value = await f.panel.status(); clean(value);
    assert.equal(value.login.issue.code, code);
    assert.equal(value.login.phase, 'waiting_qrcode', 'classification does not rewrite the upstream phase');
    assert.equal(value.login.qrcodeRevision, null);
    assert.doesNotMatch(value.login.issue.note, /扫码|二维码|网络异常|风控/);
    const qr = await f.panel.qrcode(); clean(qr);
    assert.equal(qr.available, false);
    assert.equal(qr.code, code);
  }
  f.state.login.loginPhase = 'reconnecting';
  const value = await f.panel.status(); clean(value);
  assert.equal(value.login.phase, 'reconnecting');
  assert.equal(value.login.issue.code, 'LOGIN_KICKED_OFFLINE');
  assert.equal((await f.panel.qrcode({ refresh: true })).code, 'LOGIN_NOT_WAITING');
  assert.equal(f.state.qrReads, 0);
  assert.equal(f.state.requests.includes('/api/QQLogin/RefreshQRcode'), false);
});

test('non-authentication state and QR failures preserve management credential caching', async (t) => {
  const f = fixture(t);
  await f.panel.status();
  for (const response of [() => new Response(SECRET, { status: 500 }),
    () => new Response(JSON.stringify({ code: -1, message: 'Unauthorized ' + SECRET }))]) {
    f.state.interceptResponse = (endpoint) => endpoint === '/api/QQLogin/CheckLoginStatus' ? response() : undefined;
    const value = await f.panel.status(); clean(value);
    assert.equal(value.webui.authenticated, true);
    assert.equal(value.login.isLogin, null);
    assert.equal(value.login.phase, 'unknown');
    assert.equal(value.errorStage, 'login-status');
    f.state.interceptResponse = null;
    await f.panel.status();
    assert.equal(f.state.authCalls, 1, 'ordinary read failures do not clear a valid management credential');
  }
  f.state.interceptResponse = (endpoint) => endpoint === '/api/QQLogin/RefreshQRcode'
    ? new Response(JSON.stringify({ code: -1, message: SECRET })) : undefined;
  assert.equal((await f.panel.qrcode({ refresh: true })).code, 'WEBUI_REJECTED');
  f.state.interceptResponse = null;
  await f.panel.status();
  assert.equal(f.state.authCalls, 1, 'a failed explicit refresh is not retried or used to invalidate management auth');
  assert.equal(f.state.requests.filter((endpoint) => endpoint === '/api/QQLogin/RefreshQRcode').length, 1);
});

test('explicit protected-endpoint auth rejection invalidates only its credential and reports QQ state as unknown', async (t) => {
  for (const response of [() => new Response(JSON.stringify({ code: -1, message: 'Unauthorized' })),
    () => new Response(SECRET, { status: 401 }), () => new Response(SECRET, { status: 403 })]) {
    const f = fixture(t);
    await f.panel.status();
    f.state.interceptResponse = (endpoint) => endpoint === '/api/QQLogin/CheckLoginStatus' ? response() : undefined;
    const value = await f.panel.status(); clean(value);
    assert.equal(value.code, 'WEBUI_AUTH_REJECTED');
    assert.equal(value.errorStage, 'management-auth');
    assert.equal(value.webui.reachable, true);
    assert.equal(value.webui.authenticated, false);
    assert.equal(value.login.isLogin, null);
    assert.equal(value.login.isOffline, null);
    assert.equal(value.login.phase, 'unknown');
    assert.equal(f.state.authCalls, 1, 'no automatic same-call auth retry');
    f.state.interceptResponse = null;
    await f.panel.status();
    assert.equal(f.state.authCalls, 2, 'only the following explicit/poll read renews rejected management auth');
    assert.equal(f.state.requests.includes('/api/QQLogin/RefreshQRcode'), false);
  }
});

test('authentication rejection during account info lookup clears partial login display without claiming QQ is offline', async (t) => {
  const f = fixture(t);
  f.state.login = { ...f.state.login, isLogin: true, coreReady: true, loginPhase: 'ready' };
  f.state.info = { ...f.state.info, uin: '456', online: true };
  await f.panel.status();
  f.state.interceptResponse = (endpoint) => endpoint === '/api/QQLogin/GetQQLoginInfo'
    ? new Response(JSON.stringify({ code: -1, message: 'Unauthorized' })) : undefined;
  const value = await f.panel.status(); clean(value);
  assert.equal(value.code, 'WEBUI_AUTH_REJECTED');
  assert.equal(value.errorStage, 'management-auth');
  assert.equal(value.webui.authenticated, false);
  assert.equal(value.login.isLogin, null);
  assert.equal(value.login.isOffline, null);
  assert.equal(value.login.phase, 'unknown');
  assert.equal(f.state.authCalls, 1);
  assert.equal(f.state.requests.includes('/api/QQLogin/RefreshQRcode'), false);
});

test('late rejection from an older request cannot clear a newly authenticated cache entry even with equal credential text', async (t) => {
  const f = fixture(t);
  await f.panel.status();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let checks = 0;
  f.state.interceptResponse = async (endpoint) => {
    if (endpoint !== '/api/QQLogin/CheckLoginStatus') return undefined;
    checks++;
    if (checks === 1) { entered(); await gate; }
    return checks <= 2 ? new Response(JSON.stringify({ code: -1, message: 'Unauthorized' })) : undefined;
  };
  const oldProbe = f.panel.status();
  await started;
  assert.equal((await f.panel.status()).code, 'WEBUI_AUTH_REJECTED');
  f.state.interceptResponse = null;
  await f.panel.status();
  assert.equal(f.state.authCalls, 2);
  release();
  assert.equal((await oldProbe).code, 'WEBUI_AUTH_REJECTED');
  await f.panel.status();
  assert.equal(f.state.authCalls, 2, 'an old credential handle cannot revoke the replacement generation');
});

test('management login rejection, rate limit and 2FA are fixed metadata rather than QQ login failure', async (t) => {
  for (const [body, code] of [[{ code: -1, message: 'token is invalid' }, 'WEBUI_AUTH_REJECTED'],
    [{ code: -1, message: 'login rate limit' }, 'WEBUI_AUTH_RATE_LIMITED'],
    [{ code: 0, data: { require2FA: true } }, 'WEBUI_2FA_REQUIRED']]) {
    const f = fixture(t, { fetchImpl: async () => new Response(JSON.stringify(body)) });
    const value = await f.panel.status(); clean(value);
    assert.equal(value.code, code);
    assert.equal(value.errorStage, 'management-auth');
    assert.equal(value.webui.authenticated, false);
    assert.equal(value.login.isLogin, null);
    assert.equal(value.login.isOffline, null);
    assert.equal(value.login.phase, 'unknown');
    assert.doesNotMatch(value.error, /扫码|二维码/);
  }
});
