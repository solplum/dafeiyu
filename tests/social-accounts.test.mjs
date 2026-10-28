import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SocialAccounts } from '../packages/dsh-dafeiyu/src/social/accounts.mjs';
import { SocialAccountStore, digest } from '../packages/dsh-dafeiyu/src/social/account-store.mjs';
import { readRequest, writeRequest, safeUrl } from '../packages/dsh-dafeiyu/src/social/platforms.mjs';

const yes = () => true, ctx = { authorize: yes }, deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-social-accounts-'));
  let calls = 0, identities = {}, preflight = 0;
  const drivers = Object.fromEntries(['bilibili', 'douyin', 'x'].map(key => [key, {
    capabilities: () => ({ profile: 'available', comment: 'available', reply: 'available', message: 'available', video: 'available' }),
    async startLogin() { return { state: 'login-pending', method: key === 'x' ? 'official-login' : 'qr' }; },
    async checkLogin() { return { loggedIn: true, accountId: identities[key] || key + '-account', name: '虚构账号' }; },
    async account() { return { loggedIn: true, accountId: identities[key] || key + '-account', name: '虚构账号' }; },
    async read(input) { return { ok: true, accountId: identities[key] || key + '-account', items: [], operation: input.operation }; },
    async preflight() { preflight++; },
    async execute(request, operation) {
      calls++;
      if (overrides.execute) return overrides.execute(request, operation);
      return { ok: true, id: 'receipt-' + calls, accountId: operation.accountId, operation: request.operation,
        operationId: operation.operationId, target: request.target || '', parentId: request.parentId || '', contentDigest: digest(request) };
    },
  }]));
  const manager = new SocialAccounts({ directory, drivers, requestPolicy: null });
  t.after(async () => { await manager.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const login = async (key = 'bilibili') => {
    const sessionId = randomUUID();
    await manager.startLogin({ platform: key, requestId: sessionId, revision: manager.snapshot().revision }, ctx);
    await manager.checkLogin({ platform: key, sessionId }, ctx);
    await manager.confirmAccount({ platform: key, accountId: key + '-account', revision: manager.snapshot().revision }, ctx);
  };
  const prepare = async (key = 'bilibili', patch = {}, id = randomUUID()) => manager.prepare(key,
    { operation: 'comment', target: 'public-work-1', text: '虚构评论', ...patch }, { requestId: id, authorize: yes });
  const approve = row => manager.approve({ operationId: row.operation.id, approvalDigest: row.operation.approvalDigest, revision: manager.snapshot().revision }, ctx);
  const execute = row => manager.execute({ operationId: row.operation.id, approvalDigest: row.operation.approvalDigest }, ctx);
  return { directory, manager, drivers, login, prepare, approve, execute, identities, get calls() { return calls; }, get preflight() { return preflight; } };
}

test('construction and status are read only and distinguish three login methods without importing credentials', t => {
  const f = fixture(t), before = fs.readdirSync(f.directory); const snapshot = f.manager.snapshot();
  assert.deepEqual(fs.readdirSync(f.directory), before); assert.equal(snapshot.platforms.length, 3);
  assert.equal(snapshot.platforms.find(row => row.platform === 'x').loginMethod, 'official-login');
  assert(snapshot.platforms.every(row => row.state === 'disconnected' && row.capabilities.every(item => item.state === 'needs-login')));
  assert.equal(f.calls, 0); assert.equal(f.preflight, 0);
});

test('login candidate needs explicit owner confirmation and fresh actual account equality', async t => {
  const f = fixture(t), requestId = randomUUID();
  const revision = f.manager.snapshot().revision;
  await assert.rejects(f.manager.startLogin({ platform: 'bilibili', requestId, revision }, { authorize: () => false }), { code: 'FORBIDDEN' });
  const result = await f.manager.startLogin({ platform: 'bilibili', requestId, revision }, ctx);
  assert.equal(result.sessionId, requestId);
  await f.manager.checkLogin({ platform: 'bilibili', sessionId: requestId }, ctx);
  assert.equal(f.manager.snapshot().platforms[0].state, 'candidate');
  await assert.rejects(f.manager.read('bilibili', { operation: 'inbox' }, ctx), { code: 'ACCOUNT_REQUIRED' });
  const confirmed = f.manager.confirmAccount({ platform: 'bilibili', accountId: 'other', revision: f.manager.snapshot().revision }, ctx);
  await assert.rejects(confirmed, { code: 'CONFLICT' });
  f.identities.bilibili = 'another-account';
  await assert.rejects(f.manager.confirmAccount({ platform: 'bilibili', accountId: 'bilibili-account', revision: f.manager.snapshot().revision }, ctx), { code: 'ACCOUNT_MISMATCH' });
});

test('same login request is not restarted, pending sessions require explicit handling and stale revision cannot replace them', async t => {
  const f = fixture(t), requestId = randomUUID(); let starts = 0;
  f.drivers.bilibili.startLogin = async () => { starts++; return { state: 'login-pending' }; };
  const revision = f.manager.snapshot().revision;
  await f.manager.startLogin({ platform: 'bilibili', requestId, revision }, ctx);
  await f.manager.startLogin({ platform: 'bilibili', requestId, revision }, ctx);
  await assert.rejects(f.manager.startLogin({ platform: 'bilibili', requestId: randomUUID(), revision }, ctx), { code: 'LOGIN_PENDING' });
  assert.equal(starts, 1);
});

test('exact reviewed content is approved by CAS and executed only once across reloads', async t => {
  const f = fixture(t); await f.login(); const row = await f.prepare();
  assert.equal(f.calls, 0); assert.equal((await f.execute(row)).operation.state, 'draft');
  f.approve(row); const result = await f.execute(row);
  assert.equal(result.operation.state, 'sent'); assert.equal(f.calls, 1);
  assert.equal((await f.execute(row)).operation.state, 'sent'); assert.equal(f.calls, 1);
  const reloaded = new SocialAccounts({ directory: f.directory, drivers: f.drivers, requestPolicy: null }); t.after(() => reloaded.dispose());
  const again = await reloaded.execute({ operationId: row.operation.id, approvalDigest: row.operation.approvalDigest }, ctx);
  assert.equal(again.operation.state, 'sent'); assert.equal(f.calls, 1);
  await assert.rejects(f.prepare('bilibili', { text: 'changed' }, row.operation.id), { code: 'CONFLICT' });
});

test('unknown execution retains account protection and cannot be retried with a new operation id', async t => {
  const f = fixture(t, { execute: async () => { throw Error('PRIVATE_RAW_FAILURE'); } }); await f.login();
  const row = await f.prepare(); f.approve(row); const result = await f.execute(row);
  assert.equal(result.operation.state, 'unknown'); assert.equal(f.calls, 1);
  await assert.rejects(f.prepare(), { code: 'RESULT_UNKNOWN' });
  await f.execute(row); assert.equal(f.calls, 1); assert.doesNotMatch(JSON.stringify(f.manager.snapshot()), /PRIVATE/);
});

test('another process cannot dispatch an account while its durable operation is active', async t => {
  const gate = deferred(), entered = deferred(), f = fixture(t, { execute: async () => { entered.resolve(); await gate.promise; throw Error('uncertain'); } });
  await f.login(); const one = await f.prepare(), two = await f.prepare(); f.approve(one); f.approve(two);
  const pending = f.execute(one); await entered.promise;
  const second = new SocialAccounts({ directory: f.directory, drivers: f.drivers, requestPolicy: null }); t.after(() => second.dispose());
  await assert.rejects(second.execute({ operationId: two.operation.id, approvalDigest: two.operation.approvalDigest }, ctx), { code: 'BUSY' });
  assert.equal(f.calls, 1); gate.resolve(); await pending;
});

test('wrong target, account, parent, operation and digest receipts all remain unknown', async t => {
  for (const field of ['target', 'accountId', 'parentId', 'operation', 'contentDigest', 'operationId', 'id']) {
    const f = fixture(t, { execute: async (request, op) => ({ ok: true, id: 'receipt', accountId: op.accountId, operation: request.operation,
      operationId: op.operationId, target: request.target, parentId: '', contentDigest: digest(request), [field]: 'mismatch' }) });
    await f.login(); const row = await f.prepare(); f.approve(row);
    const result = await f.execute(row);
    if (field === 'id') assert.equal(result.operation.state, 'sent', 'a platform id is opaque but bounded');
    else assert.equal(result.operation.state, 'unknown', field);
  }
});

test('account switch is rejected before dispatch and does not silently bind the new account', async t => {
  const f = fixture(t); await f.login(); const row = await f.prepare(); f.approve(row);
  f.identities.bilibili = 'different-login';
  await assert.rejects(f.execute(row), { code: 'ACCOUNT_MISMATCH' }); assert.equal(f.calls, 0);
  assert.equal(f.manager.snapshot().platforms[0].accountId, 'bilibili-account');
});

test('revocation during read and during a write does not leak a result or erase possible effects', async t => {
  let open = true; const f = fixture(t); await f.login();
  f.drivers.bilibili.read = async () => { open = false; return { ok: true, accountId: 'bilibili-account', items: ['PRIVATE_MESSAGE'] }; };
  await assert.rejects(f.manager.read('bilibili', { operation: 'inbox' }, { authorize: () => open }), { code: 'FORBIDDEN' });
  open = true; const row = await f.prepare(); f.approve(row);
  f.drivers.bilibili.execute = async () => { open = false; return {}; };
  const result = await f.manager.execute({ operationId: row.operation.id, approvalDigest: row.operation.approvalDigest }, { authorize: () => open });
  assert.equal(result.operation.state, 'unknown');
});

test('one platform can proceed while another is unknown and outgoing content never changes allowance or memory', async t => {
  const f = fixture(t, { execute: async (request, op) => {
    if (op.accountId === 'bilibili-account') throw Error('unknown');
    return { ok: true, id: 'message-1', accountId: op.accountId, operation: request.operation, operationId: op.operationId,
      target: request.target || '', parentId: request.parentId || '', contentDigest: digest(request) };
  } });
  await f.login(); await f.login('douyin');
  const one = await f.prepare(); f.approve(one); await f.execute(one);
  const two = await f.prepare('douyin', { operation: 'message', target: 'recipient-1' }); f.approve(two);
  assert.equal((await f.execute(two)).operation.state, 'sent'); assert.equal(f.calls, 2);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['accounts.json', 'bilibili', 'douyin']);
});

test('validation rejects unknown platforms, arbitrary URL origins, browser scripts and malformed replies before a driver', () => {
  for (const url of ['https://evil.test/', 'http://www.bilibili.com/', 'https://www.bilibili.com.evil.test/', 'https://a@www.bilibili.com/'])
    assert.throws(() => safeUrl('bilibili', url), { code: 'INVALID_TARGET' });
  assert.throws(() => writeRequest('x', { operation: 'reply', target: '123', text: 'reply' }), { code: 'INVALID_TARGET' });
  assert.throws(() => writeRequest('douyin', { operation: 'message', target: 'abc', text: 'text', script: 'fetch()' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => readRequest('x', { operation: 'inbox', limit: 999 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => readRequest('__proto__', { operation: 'profile' }), { code: 'INVALID_PLATFORM' });
});

test('private store refuses corruption, stale CAS, existing write locks and symlink metadata without creating replacement data', t => {
  const f = fixture(t), store = new SocialAccountStore(f.directory), version = store.read().revision;
  store.transact(state => { state.accounts.x = { state: 'disconnected', generation: 0 }; }, { revision: version, authorize: yes });
  assert.throws(() => store.transact(() => {}, { revision: version, authorize: yes }), { code: 'CONFLICT' });
  const bytes = fs.readFileSync(store.file); fs.writeFileSync(path.join(f.directory, '.write-lock'), 'old');
  assert.throws(() => store.transact(() => {}, { authorize: yes }), { code: 'STORAGE_BUSY' });
  assert.deepEqual(fs.readFileSync(store.file), bytes); fs.unlinkSync(path.join(f.directory, '.write-lock'));
  fs.writeFileSync(store.file, '{BROKEN'); assert.throws(() => store.read(), { code: 'STORAGE_INVALID' });
  fs.unlinkSync(store.file); const other = path.join(f.directory, 'other'); fs.writeFileSync(other, bytes); fs.symlinkSync(other, store.file);
  assert.throws(() => store.read(), { code: 'STORAGE_INVALID' });
});

test('cancel requests do not free an executing platform before the driver actually finishes', async t => {
  const gate = deferred(); const f = fixture(t, { execute: async () => { await gate.promise; throw Error('cancelled or unknown'); } });
  await f.login(); const row = await f.prepare(); f.approve(row); const pending = f.execute(row);
  await new Promise(resolve => setImmediate(resolve)); f.manager.cancel({ platform: 'bilibili' }, ctx);
  assert.equal(f.manager.snapshot().platforms[0].busy, true);
  await assert.rejects(f.manager.read('bilibili', { operation: 'profile' }, ctx), { code: 'BUSY' });
  gate.resolve(); assert.equal((await pending).operation.state, 'unknown'); assert.equal(f.manager.snapshot().platforms[0].blocked, true);
});

test('explicit recovery removes only an idle stale lease; another live instance in the same PID remains protected', async t => {
  const gate = deferred(), f = fixture(t, { execute: async () => { await gate.promise; throw Error('unknown'); } });
  await f.login(); const row = await f.prepare(); f.approve(row); const pending = f.execute(row);
  await new Promise(resolve => setImmediate(resolve));
  const another = new SocialAccounts({ directory: f.directory, drivers: f.drivers, requestPolicy: null });
  assert.throws(() => another.acknowledgeUnknown({ operationId: row.operation.id, revision: another.snapshot().revision, executionStopped: true, resultReviewed: true }, ctx), { code: 'BUSY' });
  gate.resolve(); await pending;
  const lease = path.join(f.directory, 'bilibili/.runtime-lock'); fs.writeFileSync(lease, JSON.stringify({ token: randomUUID(), pid: process.pid }));
  assert.equal(another.snapshot().platforms[0].cleanupRequired, true);
  another.acknowledgeUnknown({ operationId: row.operation.id, revision: another.snapshot().revision, executionStopped: true, resultReviewed: true }, ctx);
  assert.equal(fs.existsSync(lease), false); assert.equal(another.snapshot().operations[0].state, 'unknown');
  assert.equal(another.snapshot().platforms[0].blocked, false); assert.equal(f.calls, 1);
});

test('changed cover is rejected before upload, and received replies do not require a target', async t => {
  const f = fixture(t); await f.login();
  const video = path.join(f.directory, 'fixture.mp4'), cover = path.join(f.directory, 'fixture.png');
  fs.writeFileSync(video, 'fake-video'); fs.writeFileSync(cover, 'fake-cover');
  const row = await f.manager.prepare('bilibili', { operation: 'video', video, cover, title: 'fixture', declaration: 'none' }, { requestId: randomUUID(), authorize: yes });
  f.approve(row); fs.writeFileSync(cover, 'changed-cover'); await assert.rejects(f.execute(row), { code: 'MEDIA_CHANGED' }); assert.equal(f.calls, 0);
  assert.equal(readRequest('bilibili', { operation: 'replies' }).operation, 'replies');
});

test('login image refresh is local-only, session-bound and expires without regenerating QR or persisting it', async t => {
  const f = fixture(t); let clock = 0, starts = 0; f.manager.now = () => clock;
  f.drivers.bilibili.startLogin = async () => { starts++; return { image: { mime: 'image/png', base64: 'iVBORw0KGgo=' } }; };
  const id = randomUUID(); await f.manager.startLogin({ platform: 'bilibili', requestId: id, revision: f.manager.snapshot().revision }, ctx);
  assert.equal(f.manager.snapshot().platforms[0].loginImageAvailable, true);
  const image = f.manager.loginImage({ platform: 'bilibili', sessionId: id }, ctx); assert.equal(image.image.base64, 'iVBORw0KGgo=');
  assert.equal(starts, 1); assert.equal(fs.readFileSync(path.join(f.directory, 'accounts.json'), 'utf8').includes('iVBOR'), false);
  assert.throws(() => f.manager.loginImage({ platform: 'bilibili', sessionId: randomUUID() }, ctx), { code: 'CONFLICT' });
  assert.throws(() => f.manager.loginImage({ platform: 'bilibili', sessionId: id }, { authorize: () => false }), { code: 'FORBIDDEN' });
  clock = 120001; assert.equal(f.manager.snapshot().platforms[0].loginImageAvailable, false);
  assert.throws(() => f.manager.loginImage({ platform: 'bilibili', sessionId: id }, ctx), { code: 'CONFLICT' }); assert.equal(starts, 1);
});

test('explicit executor stop cleans up but retains unknown result and requires a separate reviewed acknowledgement', async t => {
  const f = fixture(t, { execute: async () => { throw Error('unknown'); } }); await f.login(); const row = await f.prepare(); f.approve(row); await f.execute(row);
  const driver = f.drivers.bilibili; driver.idle = false; let stops = 0;
  driver.closeLogin = async () => { stops++; driver.idle = true; };
  fs.writeFileSync(path.join(f.directory, 'bilibili/.runtime-lock'), JSON.stringify({ token: randomUUID(), pid: process.pid }));
  assert.equal(f.manager.busy, true);
  assert.throws(() => f.manager.acknowledgeUnknown({ operationId: row.operation.id, revision: f.manager.snapshot().revision, executionStopped: true, resultReviewed: true }, ctx), { code: 'BUSY' });
  await f.manager.stopExecutor({ platform: 'bilibili', revision: f.manager.snapshot().revision }, ctx);
  assert.equal(stops, 1); assert.equal(f.manager.busy, false); assert.equal(f.manager.snapshot().platforms[0].blocked, true);
  f.manager.acknowledgeUnknown({ operationId: row.operation.id, revision: f.manager.snapshot().revision, executionStopped: true, resultReviewed: true }, ctx);
  assert.equal(f.manager.snapshot().operations[0].state, 'unknown'); assert.equal(f.calls, 1);
});

test('maintenance admission blocks new account activity and revokes an in-flight read', async t => {
  const f = fixture(t); await f.login(); let open = false; f.manager.isOpen = () => open;
  await assert.rejects(f.manager.read('bilibili', { operation: 'profile' }, ctx), { code: 'FORBIDDEN' });
  open = true; f.drivers.bilibili.read = async () => { open = false; return { ok: true, accountId: 'bilibili-account', private: 'must-not-return' }; };
  await assert.rejects(f.manager.read('bilibili', { operation: 'profile' }, ctx), { code: 'FORBIDDEN' }); assert.equal(f.calls, 0);
});
