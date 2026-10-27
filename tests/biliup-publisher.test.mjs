import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BiliupPublisher, runBiliup } from '../packages/dsh-dafeiyu/src/social/biliup-publisher.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BVID = 'BV1xx411c7mD';
const SECRET = 'PRIVATE-CREDENTIAL-CANARY';
function fixture(t, options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'biliup-wrapper-'));
  const root = fs.realpathSync(temporary); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const media = path.join(root, 'media'); fs.mkdirSync(media, { mode: 0o700 });
  const video = path.join(media, 'original.mp4'); fs.writeFileSync(video, 'video fixture');
  const cover = path.join(media, 'cover.png'); fs.writeFileSync(cover, 'cover fixture');
  const binary = path.join(root, 'managed-biliup'); fs.writeFileSync(binary, 'managed patched binary fixture', { mode: 0o700 });
  const cookieFile = path.join(root, 'dedicated.json');
  fs.writeFileSync(cookieFile, JSON.stringify({ token_info: { mid: 1234, access_token: SECRET }, cookie_info: { cookies: [{ name: 'DedeUserID', value: '1234' }] } }), { mode: 0o600 });
  const state = { account: options.noAccount ? null : { mid: '1234', cookieFile, verified: true }, allowed: true,
    runs: [], queries: [], probes: [], probe: null, run: null, query: null, writeReceipt: true, receipt: { code: 0, data: { aid: 123456, bvid: BVID } } };
  const directory = path.join(root, 'publisher');
  let publisher;
  const config = { directory, binary, binarySha256: digest(fs.readFileSync(binary)), mediaRoots: [media],
    getAccount: () => state.account, authorize: () => state.allowed,
    probe: async (file) => { state.probes.push(file); return state.probe ? state.probe(file) : { duration: 1, width: 320, height: 240 }; },
    run: async (invocation) => {
      state.runs.push(invocation);
      const id = path.basename(invocation.cwd);
      assert.equal(publisher.journal.read(id).state, 'dispatching', 'state is durable before any child call');
      assert(fs.existsSync(publisher.journal.claimFile(id)), 'claim is durable before any child call');
      if (state.run) return state.run(invocation);
      const receiptFile = invocation.args[invocation.args.indexOf('--receipt-file') + 1];
      assert.notEqual(receiptFile, publisher.journal.claimFile(id));
      if (state.writeReceipt) fs.writeFileSync(receiptFile, JSON.stringify(state.receipt), { mode: 0o600 });
      return { closed: true, exitCode: 0, stdout: 'fake BV1234567890 must be ignored' };
    }, query: options.noQuery ? null : async (query) => {
      state.queries.push(query);
      if (state.query) return state.query(query);
      return { found: true, aid: query.aid, bvid: query.bvid, accountId: query.accountId, ...query.expected, partsCount: 1, reviewStatus: 'reviewing' };
    } };
  publisher = new BiliupPublisher(config);
  const draft = { video, cover, title: '本次核对的标题', description: '本次核对的简介', tags: ['测试'], tid: 171, copyright: 1 };
  return { root, media, video, cover, binary, cookieFile, directory, state, config, publisher, draft };
}

test('missing dedicated account permits only prepared records and never invokes a child or query', async (t) => {
  const f = fixture(t, { noAccount: true });
  fs.rmSync(f.binary); fs.rmSync(f.cookieFile);
  const prepared = await f.publisher.prepare(f.draft);
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.accountId, null);
  assert.deepEqual(prepared.media, { duration: 1, width: 320, height: 240 }); assert.equal(f.state.probes.length, 1);
  const result = await f.publisher.submit(prepared.id, prepared.approvalDigest);
  assert.equal(result.state, 'prepared'); assert.match(result.note, /不会上传或投稿/);
  assert.equal(f.state.runs.length, 0); assert.equal(f.state.queries.length, 0);
  assert(!fs.existsSync(f.publisher.journal.claimFile(prepared.id)));
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('preparation is idempotent and rejects injected infrastructure fields', async (t) => {
  const f = fixture(t); const first = await f.publisher.prepare(f.draft), second = await f.publisher.prepare(f.draft);
  assert.equal(first.id, second.id);
  for (const field of ['binary', 'cookieFile', 'accountId', 'receiptFile', 'endpoint', 'args']) {
    await assert.rejects(f.publisher.prepare({ ...f.draft, [field]: '/private/arbitrary' }), { code: 'INVALID_DRAFT' });
  }
  assert.equal(f.state.runs.length, 0);
});

test('corrupt and audio-only media cannot become a prepared video regardless of mp4 extension', async (t) => {
  for (const media of [null, {}, { duration: 1 }, { duration: NaN, width: 320, height: 240 },
    { duration: Infinity, width: 320, height: 240 }, { duration: 0, width: 320, height: 240 },
    { duration: -1, width: 320, height: 240 }, { duration: 1, width: 0, height: 240 },
    { duration: 1, width: 320, height: -1 }, { duration: 1, width: 320.5, height: 240 },
    { duration: 1, width: 320, height: '240' }]) {
    const f = fixture(t, { noAccount: true }); f.state.probe = async () => media;
    await assert.rejects(f.publisher.prepare(f.draft), { code: 'INVALID_VIDEO' });
    assert.equal(f.state.runs.length, 0); assert.equal(f.state.queries.length, 0);
    assert.equal(fs.readdirSync(f.publisher.journal.root).length, 0);
  }
});

test('probe execution or JSON failures are safe errors and leave no prepared record', async (t) => {
  const f = fixture(t, { noAccount: true }); f.state.probe = async () => { throw new SyntaxError(SECRET); };
  await assert.rejects(f.publisher.prepare(f.draft), (error) => error.code === 'INVALID_VIDEO' && !error.message.includes(SECRET));
  assert.equal(fs.readdirSync(f.publisher.journal.root).length, 0); assert.equal(f.state.runs.length, 0);
});

test('a file changed during the media probe must be prepared again', async (t) => {
  const f = fixture(t, { noAccount: true });
  f.state.probe = async () => { fs.writeFileSync(f.video, 'changed after the decoder inspected it'); return { duration: 1, width: 320, height: 240 }; };
  await assert.rejects(f.publisher.prepare(f.draft), { code: 'ASSET_CHANGED' });
  assert.equal(fs.readdirSync(f.publisher.journal.root).length, 0); assert.equal(f.state.runs.length, 0);
});

test('local media validation does not claim an unverified Bilibili duration policy', async (t) => {
  const f = fixture(t, { noAccount: true }); f.state.probe = async () => ({ duration: 100000, width: 320, height: 240 });
  const prepared = await f.publisher.prepare(f.draft);
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.media.duration, 100000); assert.equal(f.state.runs.length, 0);
});

test('a single accepted receipt is read back by exact identifiers and duplicate submits never run again', async (t) => {
  const f = fixture(t); const draft = await f.publisher.prepare(f.draft);
  const result = await f.publisher.submit(draft.id, draft.approvalDigest);
  assert.equal(result.state, 'verified'); assert.equal(result.reviewStatus, 'reviewing');
  assert.deepEqual(result.receipt, { code: 0, aid: 123456, bvid: BVID });
  assert.equal(result.url, 'https://www.bilibili.com/video/' + BVID);
  assert.equal(f.state.runs.length, 1); assert.equal(f.state.queries.length, 1);
  assert.equal(f.state.runs[0].binary, f.binary);
  assert.deepEqual(f.state.runs[0].args.slice(0, 5), ['--user-cookie', f.cookieFile, '--rust-log', 'off', 'upload']);
  assert.equal((await f.publisher.submit(draft.id, draft.id)).state, 'verified');
  assert.equal(f.state.runs.length, 1);
  assert.equal(fs.statSync(f.publisher.journal.claimFile(draft.id)).mode & 0o777, 0o600);
});

test('executable and media changes fail before a claim or external process exists', async (t) => {
  for (const change of ['binary', 'video', 'cover']) {
    const f = fixture(t); const draft = await f.publisher.prepare(f.draft);
    fs.writeFileSync(f[change], 'changed local content');
    await assert.rejects(f.publisher.submit(draft.id, draft.id), { code: change === 'binary' ? 'BINARY_CHANGED' : 'ASSET_CHANGED' });
    assert.equal(f.publisher.preview(draft.id).state, 'prepared'); assert.equal(f.state.runs.length, 0);
    assert(!fs.existsSync(f.publisher.journal.claimFile(draft.id)));
  }
});

test('dedicated credential identity is validated locally before submission without exposing secrets', async (t) => {
  const f = fixture(t); const draft = await f.publisher.prepare(f.draft);
  fs.writeFileSync(f.cookieFile, JSON.stringify({ token_info: { mid: 4321, access_token: SECRET } }));
  await assert.rejects(f.publisher.submit(draft.id, draft.id), (error) => error.code === 'ACCOUNT_MISMATCH' && !error.message.includes(SECRET));
  assert.equal(f.state.runs.length, 0); assert(!fs.existsSync(f.publisher.journal.claimFile(draft.id)));
});

test('authority and approval digest are mandatory and a changed account cannot receive a prepared submission', async (t) => {
  const f = fixture(t); const draft = await f.publisher.prepare(f.draft);
  await assert.rejects(f.publisher.submit(draft.id, 'a'.repeat(64)), { code: 'FORBIDDEN' });
  f.state.allowed = false; await assert.rejects(f.publisher.submit(draft.id, draft.id), { code: 'FORBIDDEN' });
  f.state.allowed = true; f.state.account = { ...f.state.account, mid: '4321' };
  await assert.rejects(f.publisher.submit(draft.id, draft.id), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(f.state.runs.length, 0);
});

test('literal title text reaches argv unchanged and infrastructure paths remain owner supplied', async (t) => {
  const f = fixture(t), title = '$(touch /tmp/forbidden);`echo nope`';
  const draft = await f.publisher.prepare({ ...f.draft, title });
  const result = await f.publisher.submit(draft.id, draft.id);
  assert.equal(result.state, 'verified');
  const args = f.state.runs[0].args;
  assert.equal(args[args.indexOf('--title') + 1], title);
  assert.equal(args[args.indexOf('--user-cookie') + 1], f.cookieFile);
});

test('exit zero and stdout BV strings without the exact private receipt remain unknown and retain the lock across restart', async (t) => {
  const f = fixture(t); f.state.writeReceipt = false;
  const draft = await f.publisher.prepare(f.draft);
  const result = await f.publisher.submit(draft.id, draft.id);
  assert.equal(result.state, 'unknown'); assert.equal(result.receipt, null); assert.equal(f.state.queries.length, 0);
  assert.equal((await f.publisher.submit(draft.id, draft.id)).state, 'unknown'); assert.equal(f.state.runs.length, 1);
  const restarted = new BiliupPublisher(f.config);
  assert.equal((await restarted.prepare(f.draft)).state, 'unknown');
  assert.equal((await restarted.submit(draft.id, draft.id)).state, 'unknown'); assert.equal(f.state.runs.length, 1);
  const other = await f.publisher.prepare({ ...f.draft, title: '另一个任务' });
  await assert.rejects(f.publisher.submit(other.id, other.id), { code: 'BUSY_OR_UNKNOWN' });
});

test('every child startup, cancellation or nonzero result is unknown without retry', async (t) => {
  for (const run of [async () => { throw new Error(SECRET); }, async () => ({ closed: false, exitCode: 0 }),
    async () => ({ closed: true, exitCode: 1 }), async () => ({ closed: true, exitCode: 0, cancelled: true })]) {
    const f = fixture(t); f.state.run = run; const draft = await f.publisher.prepare(f.draft);
    const result = await f.publisher.submit(draft.id, draft.id);
    assert.equal(result.state, 'unknown'); assert(!JSON.stringify(result).includes(SECRET));
    assert.equal((await f.publisher.submit(draft.id, draft.id)).state, 'unknown'); assert.equal(f.state.runs.length, 1);
    assert(fs.readdirSync(f.publisher.journal.root).some((name) => name.endsWith('.lock')));
  }
});

test('malformed, foreign, overspecified or unsafe receipts cannot become successful deliveries', async (t) => {
  for (const receipt of [{ code: 1, data: { aid: 123456, bvid: BVID } }, { code: 0, data: { aid: '123456', bvid: BVID } },
    { code: 0, data: { aid: 123456, bvid: 'BV123' } }, { code: 0, data: { aid: 123456, bvid: BVID, cookie: SECRET } },
    { code: 0, data: { aid: 123456, bvid: [BVID] } },
    { code: 0, data: { aid: 123456, bvid: BVID }, message: SECRET }]) {
    const f = fixture(t); f.state.receipt = receipt; const draft = await f.publisher.prepare(f.draft);
    const result = await f.publisher.submit(draft.id, draft.id);
    assert.equal(result.state, 'unknown'); assert.equal(f.state.queries.length, 0); assert(!JSON.stringify(result).includes(SECRET));
  }
});

test('query exceptions or wrong-account results keep the exact receipt and unknown protection', async (t) => {
  for (const query of [async () => { throw new Error(SECRET); }, async (request) => ({ found: true, ...request.expected,
    aid: request.aid, bvid: request.bvid, accountId: '4321', partsCount: 1, reviewStatus: 'public' })]) {
    const f = fixture(t); f.state.query = query; const draft = await f.publisher.prepare(f.draft);
    const result = await f.publisher.submit(draft.id, draft.id);
    assert.equal(result.state, 'unknown'); assert.equal(result.receipt.bvid, BVID); assert(!JSON.stringify(result).includes(SECRET));
    assert.equal(f.state.runs.length, 1); assert(fs.readdirSync(f.publisher.journal.root).some((name) => name.endsWith('.lock')));
  }
});

test('pending detail visibility stays submitted and an explicit query can verify without a second upload', async (t) => {
  const f = fixture(t); f.state.query = async () => ({ found: false });
  const draft = await f.publisher.prepare(f.draft); const result = await f.publisher.submit(draft.id, draft.id);
  assert.equal(result.state, 'submitted'); assert.equal(f.state.runs.length, 1);
  f.state.query = null;
  assert.equal((await f.publisher.query(draft.id)).state, 'verified'); assert.equal(f.state.runs.length, 1);
});

test('without a query driver receipt acceptance is reported separately from public visibility', async (t) => {
  const f = fixture(t, { noQuery: true }); const draft = await f.publisher.prepare(f.draft);
  const result = await f.publisher.submit(draft.id, draft.id);
  assert.equal(result.state, 'submitted'); assert.equal(result.reviewStatus, 'pending-verification');
  assert.equal(f.state.queries.length, 0); assert.equal(f.state.runs.length, 1);
});

test('an already aborted operation remains prepared and does not consume the one-shot claim', async (t) => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  const draft = await f.publisher.prepare(f.draft);
  const result = await f.publisher.submit(draft.id, draft.id, { signal: controller.signal });
  assert.equal(result.state, 'prepared'); assert.equal(f.state.runs.length, 0);
  assert(!fs.existsSync(f.publisher.journal.claimFile(draft.id)));
});

test('revoked owner authority after child execution cannot trigger query or replay', async (t) => {
  const f = fixture(t); f.state.run = async () => { f.state.allowed = false; return { closed: true, exitCode: 0 }; };
  const draft = await f.publisher.prepare(f.draft), result = await f.publisher.submit(draft.id, draft.id);
  assert.equal(result.state, 'unknown'); assert.equal(f.state.queries.length, 0); assert.equal(f.state.runs.length, 1);
});

test('a preexisting claim is never cleared or replayed even if the record still says prepared', async (t) => {
  const f = fixture(t), draft = await f.publisher.prepare(f.draft);
  fs.writeFileSync(f.publisher.journal.claimFile(draft.id), 'previous attempt', { mode: 0o600 });
  const result = await f.publisher.submit(draft.id, draft.id);
  assert.equal(result.state, 'unknown'); assert.equal(f.state.runs.length, 0);
  assert.equal(fs.readFileSync(f.publisher.journal.claimFile(draft.id), 'utf8'), 'previous attempt');
});

test('concurrent submits run a task once and keep the whole account busy until the child closes', async (t) => {
  const f = fixture(t); let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  f.state.run = async (invocation) => {
    started(); await new Promise((resolve) => { release = resolve; });
    fs.writeFileSync(invocation.args[invocation.args.indexOf('--receipt-file') + 1], JSON.stringify(f.state.receipt), { mode: 0o600 });
    return { closed: true, exitCode: 0 };
  };
  const first = await f.publisher.prepare(f.draft), other = await f.publisher.prepare({ ...f.draft, title: '同时准备的另一任务' });
  const pending = f.publisher.submit(first.id, first.id); await ready;
  assert.equal((await f.publisher.submit(first.id, first.id)).state, 'unknown');
  await assert.rejects(f.publisher.submit(other.id, other.id), { code: 'BUSY_OR_UNKNOWN' });
  assert.equal(f.state.runs.length, 1); release();
  assert.equal((await pending).state, 'verified');
});

test('a journal failure after consuming the claim still returns unknown and preserves account protection', async (t) => {
  const f = fixture(t), draft = await f.publisher.prepare(f.draft);
  f.publisher.journal.update = () => { throw new Error(SECRET); };
  const result = await f.publisher.submit(draft.id, draft.id);
  assert.equal(result.state, 'unknown'); assert(!JSON.stringify(result).includes(SECRET));
  assert.equal(f.state.runs.length, 0); assert(fs.existsSync(f.publisher.journal.claimFile(draft.id)));
  assert(fs.readdirSync(f.publisher.journal.root).some((name) => name.endsWith('.lock')));
});

test('linked or public receipt files are rejected without reading private targets or querying the platform', async (t) => {
  for (const linked of [true, false]) {
    const f = fixture(t), draft = await f.publisher.prepare(f.draft);
    f.state.run = async (invocation) => {
      const file = invocation.args[invocation.args.indexOf('--receipt-file') + 1];
      if (linked) fs.symlinkSync(f.cookieFile, file);
      else fs.writeFileSync(file, JSON.stringify(f.state.receipt), { mode: 0o644 });
      return { closed: true, exitCode: 0 };
    };
    const result = await f.publisher.submit(draft.id, draft.id);
    assert.equal(result.state, 'unknown'); assert.equal(f.state.queries.length, 0); assert(!JSON.stringify(result).includes(SECRET));
  }
});

test('revocation during readback preserves the receipt privately and returns no receipt to the caller', async (t) => {
  const f = fixture(t), draft = await f.publisher.prepare(f.draft);
  f.state.query = async (request) => { f.state.allowed = false; return { found: true, ...request.expected,
    aid: request.aid, bvid: request.bvid, accountId: request.accountId, partsCount: 1, reviewStatus: 'public' }; };
  const result = await f.publisher.submit(draft.id, draft.id);
  assert.equal(result.state, 'unknown'); assert.equal(result.receipt, undefined);
  assert.equal(f.publisher.journal.read(draft.id).receipt.bvid, BVID);
});

test('default process driver proves close and cancels a local child within its bounded lifetime', async (t) => {
  const f = fixture(t);
  const result = await runBiliup({ binary: process.execPath, args: ['--version'], cwd: f.root, home: f.root, timeoutMs: 5000 });
  assert.equal(result.closed, true); assert.equal(result.exitCode, 0);
  const timed = await runBiliup({ binary: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], cwd: f.root, home: f.root, timeoutMs: 20 });
  assert.equal(timed.closed, true); assert.equal(timed.cancelled, true);
});
