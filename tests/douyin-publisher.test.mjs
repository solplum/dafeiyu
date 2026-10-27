import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DouyinPublisher } from '../packages/dsh-dafeiyu/src/social/douyin-publisher.mjs';
import { EgoDouyinDriver } from '../packages/dsh-dafeiyu/src/social/ego-douyin-driver.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-stage-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const video = path.join(root, 'video.mp4'); fs.writeFileSync(video, 'isolated-video-bytes');
  const calls = [], draft = { video, title: '本地测试标题', description: '本地描述', tags: [], declaration: 'none', accountId: 'fixture-account' };
  let rejectSubmit = false, returnedId = '1234567890123456789', accountId = draft.accountId, status = 'reviewing', authorized = true;
  const driver = {
    async account() { calls.push('account'); return { loggedIn: true, accountId }; },
    async prepare(record) { calls.push('prepare'); return { ready: true, draftToken: 'fixture-draft-token', ...record.metadata }; },
    async inspectDraft(record) { calls.push('inspect'); return { ready: true, draftToken: 'fixture-draft-token', ...record.metadata }; },
    async submitOnce() { calls.push('submit'); if (rejectSubmit) throw new Error('timeout after click'); return { accountId, draftToken: 'fixture-draft-token', workId: returnedId }; },
    async queryWork(workId) { calls.push('query'); return { accountId, workId, title: draft.title, reviewStatus: status }; },
  };
  const options = { directory: path.join(root, 'journal'), driver, authorize: () => authorized, probe: async () => ({ duration: 3, width: 1080, height: 1920 }) };
  const publisher = new DouyinPublisher(options);
  return { root, draft, calls, driver, publisher, options,
    rejectSubmit(value) { rejectSubmit = value; }, returnedId(value) { returnedId = value; }, account(value) { accountId = value; },
    status(value) { status = value; }, authorize(value) { authorized = value; } };
}

test('without an account prepare and preview are local, and upload/submit refuse before browser use', async (t) => {
  const f = fixture(t); delete f.draft.accountId;
  const prepared = await f.publisher.prepare(f.draft); assert.equal(prepared.state, 'prepared'); assert.equal(prepared.accountId, null);
  assert.equal(prepared.video.bytes, 20); assert.match(prepared.video.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.publisher.preview(prepared.id), prepared);
  await assert.rejects(f.publisher.upload(prepared.id, prepared.approvalDigest), (error) => error.code === 'ACCOUNT_REQUIRED');
  await assert.rejects(f.publisher.submit(prepared.id, prepared.approvalDigest), (error) => error.code === 'ACCOUNT_REQUIRED');
  assert.deepEqual(f.calls, []);
});

test('exact prepared draft uploads, submits once and separately queries actual work ID/review status', async (t) => {
  const f = fixture(t), prepared = await f.publisher.prepare(f.draft), { id, approvalDigest } = prepared;
  assert.equal((await f.publisher.upload(id, approvalDigest)).state, 'ready');
  const result = await f.publisher.submit(id, approvalDigest);
  assert.equal(result.state, 'submitted'); assert.equal(result.workId, '1234567890123456789'); assert.equal(result.reviewStatus, 'pending-verification');
  const queried = await f.publisher.query(id); assert.equal(queried.state, 'verified'); assert.equal(queried.reviewStatus, 'reviewing');
  assert.match(queried.note, /审核中/); f.status('public'); assert.equal((await f.publisher.query(id)).reviewStatus, 'public');
  await assert.rejects(f.publisher.submit(id, approvalDigest), (error) => error.code === 'NO_REPLAY');
  assert.equal(f.calls.filter((value) => value === 'submit').length, 1);
});

test('unknown dispatch is durable across a new publisher and blocks another draft on the same account', async (t) => {
  const f = fixture(t), prepared = await f.publisher.prepare(f.draft); await f.publisher.upload(prepared.id, prepared.approvalDigest); f.rejectSubmit(true);
  const result = await f.publisher.submit(prepared.id, prepared.approvalDigest); assert.equal(result.state, 'unknown');
  const restarted = new DouyinPublisher(f.options); assert.equal(restarted.preview(prepared.id).state, 'unknown');
  await assert.rejects(restarted.submit(prepared.id, prepared.approvalDigest), (error) => error.code === 'BUSY_OR_UNKNOWN');
  const other = await restarted.prepare({ ...f.draft, title: '另一个稿件' });
  await assert.rejects(restarted.upload(other.id, other.approvalDigest), (error) => error.code === 'BUSY_OR_UNKNOWN');
  assert.equal(f.calls.filter((value) => value === 'submit').length, 1);
});

test('a navigation or success toast without exact work ID is unknown, never success', async (t) => {
  const f = fixture(t), prepared = await f.publisher.prepare(f.draft); await f.publisher.upload(prepared.id, prepared.approvalDigest);
  f.returnedId('https://creator.douyin.com/creator-micro/content/manage');
  const result = await f.publisher.submit(prepared.id, prepared.approvalDigest); assert.equal(result.state, 'unknown'); assert.equal(result.workId, null);
});

test('account mismatch, wrong approval and changed local content block before any upload or submit', async (t) => {
  const f = fixture(t), prepared = await f.publisher.prepare(f.draft);
  await assert.rejects(f.publisher.upload(prepared.id, 'wrong-digest'), (error) => error.code === 'FORBIDDEN');
  f.account('other-account'); await assert.rejects(f.publisher.upload(prepared.id, prepared.approvalDigest), (error) => error.code === 'ACCOUNT_MISMATCH');
  f.account(f.draft.accountId); fs.writeFileSync(f.draft.video, 'changed fixture bytes');
  await assert.rejects(f.publisher.upload(prepared.id, prepared.approvalDigest), (error) => error.code === 'ASSET_CHANGED');
  assert.equal(f.calls.includes('prepare'), false); assert.equal(f.calls.includes('submit'), false);
});

test('prepare is deduplicated by account and exact content metadata and never resets a submitted record', async (t) => {
  const f = fixture(t), first = await f.publisher.prepare(f.draft), second = await f.publisher.prepare(f.draft); assert.equal(first.id, second.id);
  await f.publisher.upload(first.id, first.approvalDigest); await f.publisher.submit(first.id, first.approvalDigest);
  assert.equal((await f.publisher.prepare(f.draft)).state, 'submitted');
  assert.notEqual((await f.publisher.prepare({ ...f.draft, accountId: 'different-account' })).id, first.id);
});

test('parallel upload attempts are serialized across independent publisher instances', async (t) => {
  const f = fixture(t), prepared = await f.publisher.prepare(f.draft); let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  const original = f.driver.prepare; f.driver.prepare = async (...args) => { entered(); await gate; return original(...args); };
  const pending = f.publisher.upload(prepared.id, prepared.approvalDigest); await ready;
  const second = new DouyinPublisher(f.options);
  await assert.rejects(second.upload(prepared.id, prepared.approvalDigest), (error) => error.code === 'BUSY_OR_UNKNOWN');
  release(); assert.equal((await pending).state, 'ready'); assert.equal(f.calls.filter((value) => value === 'prepare').length, 1);
});

test('process interruption markers are read as unknown, never silently resumed', async (t) => {
  const f = fixture(t), prepared = await f.publisher.prepare(f.draft);
  f.publisher.journal.update(prepared.id, 'dispatching');
  assert.equal(new DouyinPublisher(f.options).preview(prepared.id).state, 'unknown');
  await assert.rejects(f.publisher.submit(prepared.id, prepared.approvalDigest), (error) => error.code === 'NO_REPLAY');
});

test('malformed metadata and journal corruption fail closed without browser actions', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.publisher.prepare({ ...f.draft, title: 'a'.repeat(31) }), (error) => error.code === 'INVALID_DRAFT');
  await assert.rejects(f.publisher.prepare({ ...f.draft, declaration: undefined }), (error) => error.code === 'INVALID_DRAFT');
  const prepared = await f.publisher.prepare(f.draft), file = f.publisher.journal.file(prepared.id);
  const json = JSON.parse(fs.readFileSync(file, 'utf8')); json.record.state = 'ready'; fs.writeFileSync(file, JSON.stringify(json));
  assert.throws(() => f.publisher.preview(prepared.id), (error) => error.code === 'INVALID_JOURNAL'); assert.deepEqual(f.calls, []);
});

test('unsupported browser features fail before dispatch and leave an offline draft usable', async (t) => {
  const f = fixture(t), prepared = await f.publisher.prepare(f.draft);
  f.driver.validateDraft = () => { const error = new Error('unverified cover widget'); error.code = 'DRAFT_FEATURE_PENDING'; throw error; };
  await assert.rejects(f.publisher.upload(prepared.id, prepared.approvalDigest), (error) => error.code === 'DRAFT_FEATURE_PENDING');
  assert.equal(f.publisher.preview(prepared.id).state, 'prepared'); assert.deepEqual(f.calls, []);
  assert.equal(fs.readdirSync(f.options.directory).some((file) => file.endsWith('.lock')), false);
});

test('Ego driver refuses unverified live DOM bindings without starting browser or importing cookies', async () => {
  const driver = new EgoDouyinDriver({ runScript() { assert.fail('no browser calls before account/DOM verification'); }, space: 'douyin', targetId: 'fixture' });
  await assert.rejects(driver.account(), (error) => error.code === 'BINDINGS_REQUIRED');
});

test('native ego_script result envelopes are accepted while timeout, fallback, raw output and conflicting receipts fail closed', async () => {
  const bindings = { verified: true, accountId: 'fixture-account', accountSelector: '#account', accountAttribute: 'data-uid', publishSelector: '#publish',
    uploadReadySelector: '#ready', draftTokenSelector: '#draft', draftTokenAttribute: 'data-draft', declarationSelector: '#declaration',
    workRowSelector: '.work', workIdAttribute: 'data-id', reviewAttribute: 'data-review', workTitleSelector: '.title',
    submitResponse: { pattern: 'https://creator.douyin.com/fixture-submit', workIdPath: ['workId'], okPath: ['status'], okValue: 0 } };
  const value = { loggedIn: true, accountId: bindings.accountId };
  let envelope = { ok: true, result: value, timedOut: false };
  const driver = new EgoDouyinDriver({ runScript: async () => envelope, space: 'owned-fixture', targetId: 'exact-tab', bindings });
  assert.deepEqual(await driver.account(), value);
  envelope = { ok: true, value }; assert.deepEqual(await driver.account(), value, 'normalized caller transport remains compatible');
  for (const bad of [{ ok: true, stdout: '@@DSH_RESULT@@' + JSON.stringify(value) }, { ok: true, result: value, timedOut: true },
    { ok: true, result: value, cancelled: true }, { ok: true, result: value, executionState: 'unknown' },
    { ok: true, result: { ...value, fallback: true } }, { ok: true, result: value, value: { accountId: 'different' } },
    { ok: false, result: value }]) {
    envelope = bad; await assert.rejects(driver.account(), { code: 'BROWSER_UNKNOWN' });
  }
});

test('generated Ego submit script has a durable once claim so even underlying replay only clicks once', async (t) => {
  const f = fixture(t), prepared = await f.publisher.prepare(f.draft), record = f.publisher.journal.read(prepared.id);
  record.draftToken = 'fixture-draft-token'; let clicks = 0, uploads = 0, call;
  const bindings = { verified: true, accountId: f.draft.accountId, accountSelector: '#account', accountAttribute: 'data-uid', publishSelector: '#publish',
    uploadReadySelector: '#ready', draftTokenSelector: '#draft', draftTokenAttribute: 'data-draft-id', declarationSelector: '#declaration',
    workRowSelector: '.work', workIdAttribute: 'data-id', reviewAttribute: 'data-review', workTitleSelector: '.title',
    submitResponse: { pattern: 'https://creator.douyin.com/fixture-submit', workIdPath: ['workId'], okPath: ['status'], okValue: 0 } };
  const page = { url: async () => 'https://creator.douyin.com/creator-micro/content/post/video',
    evaluate: async (expression) => expression.includes('AMBIGUOUS_DRAFT') ? { ...record.metadata, ready: true, draftToken: record.draftToken }
      : expression.includes("button.innerText.trim()") ? true : expression.includes('payload:s.payload')
        ? { done: true, status: 200, url: bindings.submitResponse.pattern, payload: { status: 0, workId: '1234567890123456789' } } : f.draft.accountId,
    goto: async () => ({}), locator: () => ({ click: async () => { clicks++; }, fill: async () => ({}), setInputFiles: async () => { uploads++; } }),
    waitForFunction: async () => true,
    waitForResponse: async () => ({ url: () => bindings.submitResponse.pattern, status: () => 200, json: async () => { throw new Error('Current installed CDP body unavailable'); } }) };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runScript = async (request) => {
    call = request; let output;
    await new AsyncFunction('taskSpaces', 'browser', 'page', 'console', request.args.script)(
      { useOrCreate: async () => ({}) }, { switchTab: async () => ({}) }, page, { log: (line) => { output = JSON.parse(line.split('@@DSH_RESULT@@')[1]); } });
    return { ok: true, result: output, stdout: 'native sentinel parsed', timedOut: false };
  };
  const driver = new EgoDouyinDriver({ runScript, space: 'dedicated-douyin', targetId: 'exact-tab', bindings });
  const options = { claimFile: f.publisher.journal.claimFile(prepared.id) };
  const result = await driver.submitOnce(record, options); assert.equal(result.workId, '1234567890123456789'); assert.equal(call.noRetry, true);
  await assert.rejects(driver.submitOnce(record, options), (error) => error.code === 'EEXIST');
  assert.equal(clicks, 1); assert.equal(fs.statSync(options.claimFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(options.claimFile, 'utf8'), prepared.approvalDigest);
  assert.equal(call.args.script.includes('while'), false); assert.equal(call.args.script.includes('storage_state'), false);
  const uploadOptions = { claimFile: f.publisher.journal.uploadClaimFile(prepared.id) };
  assert.equal((await driver.prepare(record, uploadOptions)).ready, true);
  await assert.rejects(driver.prepare(record, uploadOptions), (error) => error.code === 'EEXIST'); assert.equal(uploads, 1);
});
