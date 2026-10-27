import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { browseRequest, SocialAccountError } from '../packages/dsh-dafeiyu/src/social/platforms.mjs';
import { SocialAccounts } from '../packages/dsh-dafeiyu/src/social/accounts.mjs';
import { BrowserAccountDriver } from '../packages/dsh-dafeiyu/src/social/browser-account.mjs';
import { DOUYIN_RECOMMEND, DOUYIN_NEXT, douyinVideoExpression, douyinVideoReady, douyinVideoObservation, douyinVideoIdentityBinding, douyinBrowseExpressions, isRecommendationUrl } from '../packages/dsh-dafeiyu/src/social/douyin-browse.mjs';

const yes = () => true, context = { authorize: yes }, owner = 'dy-fixture-owner';
const mediaId = value => 'media-' + createHash('sha256').update(String(value)).digest('hex');
const verifiedVideoIdentity = { verified: true, kind: 'platform-video-id', attribute: 'data-fixture-video-id' };
const platformId = value => BigInt('0x' + createHash('sha256').update(String(value)).digest('hex').slice(0, 14)).toString().padStart(18, '0');
const current = value => ({ id: mediaId(JSON.stringify(['platform-video-id', platformId(value)])), mediaSourceFingerprint: mediaId(value),
  identityKind: 'platform-video-id', platformVideoId: platformId(value),
  url: DOUYIN_RECOMMEND, author: '@fixture-' + value, description: '页面文字 ' + value,
  media: { muted: true, paused: true, currentTime: 1.234, duration: 20 } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

function managerFixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-douyin-browse-')), calls = [];
  const driver = {
    idle: true, capabilities: () => ({}), async dispose() {},
    async browse(input, scope) { calls.push(input.action); return overrides.browse ? overrides.browse(input, scope) : { ok: true, accountId: scope.accountId, state: input.action === 'stop' ? 'stopped' : 'active', current: current('one'), history: [] }; },
  };
  const manager = new SocialAccounts({ directory, drivers: { douyin: driver }, requestPolicy: null });
  manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: owner, name: 'fixture', generation: 1 }; }, { authorize: yes });
  t.after(async () => { await manager.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, manager, driver, calls };
}

test('browse accepts only Douyin manual actions and an opaque observation for one next step', () => {
  for (const action of ['open', 'current', 'stop', 'history']) assert.deepEqual(browseRequest('douyin', { action }), { action });
  assert.deepEqual(browseRequest('douyin', { action: 'next', expectedVideoId: mediaId('one') }), { action: 'next', expectedVideoId: mediaId('one') });
  for (const key of ['bilibili', 'x']) assert.throws(() => browseRequest(key, { action: 'open' }), { code: 'INVALID_OPERATION' });
  for (const request of [{ action: 'auto' }, { action: 'next' }, { action: 'next', expectedVideoId: '12345' },
    { action: 'open', target: 'https://example.com' }, { action: 'current', expectedVideoId: mediaId('one') },
    { action: 'next', expectedVideoId: mediaId('one'), repeats: 3 },
    { action: 'next', expectedVideoId: mediaId('one'), videoIdentity: verifiedVideoIdentity },
    { action: 'current', bindings: { browse: { videoIdentity: verifiedVideoIdentity } } }, null]) assert.throws(() => browseRequest('douyin', request));
  for (const url of ['http://www.douyin.com/?recommend=1', 'https://www.douyin.com.evil/?recommend=1',
    'https://u:p@www.douyin.com/?recommend=1', 'https://www.douyin.com/?recommend=1#private', 'https://www.douyin.com/video/1']) assert.equal(isRecommendationUrl(url), false);
  assert.equal(isRecommendationUrl(DOUYIN_RECOMMEND), true);
});

test('owner revocation and an aborted caller cannot dispatch browse or expose local history', async t => {
  const f = managerFixture(t), aborted = new AbortController(); aborted.abort();
  for (const action of ['open', 'current', 'history', 'stop']) {
    await assert.rejects(f.manager.browse('douyin', { action }, { authorize: () => false }), { code: 'FORBIDDEN' });
    await assert.rejects(f.manager.browse('douyin', { action }, { ...context, signal: aborted.signal }), { code: 'FORBIDDEN' });
  }
  assert.deepEqual(f.calls, []);
  let allowed = true;
  f.driver.browse = async () => { allowed = false; return { ok: true, history: ['private'] }; };
  await assert.rejects(f.manager.browse('douyin', { action: 'history' }, { authorize: () => allowed }), { code: 'FORBIDDEN' });
});

test('a persisted safety pause blocks every network browse action while history and stop remain available', async t => {
  const f = managerFixture(t);
  f.manager.holdPlatform({ platform: 'douyin', revision: f.manager.snapshot().revision, reason: 'owner-paused' }, context);
  for (const request of [{ action: 'open' }, { action: 'current' }, { action: 'next', expectedVideoId: mediaId('one') }]) {
    await assert.rejects(f.manager.browse('douyin', request, context), { code: 'RISK_CONTROL' });
  }
  assert.deepEqual(f.calls, []);
  const before = fs.readFileSync(f.manager.store.file);
  await f.manager.browse('douyin', { action: 'history' }, context);
  assert.deepEqual(fs.readFileSync(f.manager.store.file), before);
  await f.manager.browse('douyin', { action: 'stop' }, context);
  assert.deepEqual(f.calls, ['history', 'stop']);
  assert.equal(f.manager.snapshot().platforms.find(p => p.platform === 'douyin').safetyPause.reason, 'owner-paused');
});

test('stop cancels an in-flight browse, waits for cleanup, then closes its own browser despite a platform pause', async t => {
  const entered = deferred(), cleanup = deferred(), aborted = deferred(); let stopCalls = 0;
  const f = managerFixture(t);
  f.driver.browse = async (input, scope) => {
    if (input.action === 'stop') { stopCalls++; assert.equal(f.driver.idle, true); return { ok: true, state: 'stopped', history: [] }; }
    f.driver.idle = false; entered.resolve();
    scope.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    await cleanup.promise; f.driver.idle = true;
    throw new SocialAccountError('BROWSER_UNKNOWN');
  };
  const pending = f.manager.browse('douyin', { action: 'open' }, context);
  const rejected = assert.rejects(pending, { code: 'BROWSER_UNKNOWN' }); await entered.promise;
  f.manager.holdPlatform({ platform: 'douyin', revision: f.manager.snapshot().revision, reason: 'owner-paused' }, context);
  const stopping = f.manager.browse('douyin', { action: 'stop' }, context);
  await aborted.promise; await turn(); assert.equal(stopCalls, 0);
  cleanup.resolve(); await rejected;
  const stopped = await stopping; assert.equal(stopped.state, 'stopped'); assert.equal(stopCalls, 1);
  assert.equal(fs.existsSync(path.join(f.directory, 'douyin', '.runtime-lock')), false);
});

test('manager rejects changed account generations, revoked authority and mismatched browse receipts', async t => {
  for (const scenario of ['generation', 'account', 'oversize', 'revoke']) {
    const f = managerFixture(t); let allowed = true;
    f.driver.browse = async (_input, scope) => {
      if (scenario === 'generation') f.manager.store.transact(state => { state.accounts.douyin.generation++; }, { authorize: yes });
      if (scenario === 'revoke') allowed = false;
      return { ok: true, accountId: scenario === 'account' ? 'other' : scope.accountId,
        current: current('one'), extra: scenario === 'oversize' ? 'x'.repeat(33000) : '' };
    };
    await assert.rejects(f.manager.browse('douyin', { action: 'open' }, { authorize: () => allowed }),
      { code: scenario === 'generation' ? 'ACCOUNT_MISMATCH' : scenario === 'revoke' ? 'FORBIDDEN' : 'INVALID_RECEIPT' });
  }
});

function driverFixture({ videoIdentity = verifiedVideoIdentity } = {}) {
  let video = current('one'), account = owner, active = 'creator', clicks = 0, runs = 0, stops = 0, afterIdentity, clickUnknown = false;
  const tabs = [{ targetId: 'creator', url: 'https://creator.douyin.com/creator-micro/home' }, { targetId: 'feed', url: DOUYIN_RECOMMEND }];
  const scripts = [], selected = [];
  const runtime = {
    children: new Set(), cleanupPending: false,
    async run(body) {
      runs++; scripts.push(body); let identities = 0;
      const browser = {
        async ensureRealTab() {}, async listTabs() { return tabs; },
        async switchTab(id) { assert(tabs.some(t => t.targetId === id)); active = id; selected.push(id); },
        async openOrReuseTab(url) { const tab = tabs.find(t => t.url === url); if (!tab) throw Error('unexpected navigation'); active = tab.targetId; },
      };
      const page = {
        async url() { return tabs.find(t => t.targetId === active).url; },
        async goto() { throw Error('unexpected navigation away from an existing tab'); },
        async waitForFunction() {},
        async evaluate(expression) {
          if (expression === douyinVideoObservation(videoIdentity)) {
            assert.equal(active, 'feed');
            return structuredClone(douyinVideoIdentityBinding(videoIdentity) ? video
              : { ...video, id: video.mediaSourceFingerprint, identityKind: 'media-source-fingerprint', platformVideoId: null });
          }
          if (expression === douyinBrowseExpressions(videoIdentity).openNavigationExpression) return 'feed';
          if (expression.includes("state:'login-pending'")) { identities++; const found = identities > 1 && afterIdentity ? afterIdentity : account; return { loggedIn: true, accountId: found, name: 'fixture' }; }
          if (expression.includes('iframe[src*=captcha]')) return false;
          throw Error('unexpected browser expression');
        },
        locator(selector) {
          assert.equal(selector, DOUYIN_NEXT);
          return { async click() { assert.equal(active, 'feed'); clicks++; if (clickUnknown) throw new SocialAccountError('BROWSER_UNKNOWN'); video = current('after-' + clicks); } };
        },
      };
      try {
        return await vm.runInNewContext('(async()=>{' + body + '\nreturn result;})()', {
          URL, page, browser, taskSpaces: { async list() { return [{ id: 1, name: 'dfy-social-douyin', ownership: 'agent' }]; }, async useOrCreate() {} },
        });
      } catch (error) { if (!error.code && ['ACCOUNT_MISMATCH', 'BINDINGS_REQUIRED', 'RISK_CONTROL'].includes(error.message)) error.code = error.message; throw error; }
    },
    async stop() { stops++; }, async dispose() {},
  };
  const driver = new BrowserAccountDriver({ key: 'douyin', directory: '/not-used-fixture', runtime,
    bindings: { platform: 'douyin', verified: true, accountId: owner, browse: { videoIdentity }, identity: {
      url: 'https://creator.douyin.com/creator-micro/home', selector: '#own', attribute: 'innerText', pattern: '^own:(.+)$' } } });
  return { driver, runtime, scripts, selected, context: { ...context, accountId: owner },
    setVideo(value) { video = value; }, setAccount(value) { account = value; }, setAfterIdentity(value) { afterIdentity = value; },
    setUnknown(value) { clickUnknown = value; }, get clicks() { return clicks; }, get runs() { return runs; }, get stops() { return stops; } };
}

test('driver checks identity in a separate tab before and after projection; history is local and bounded', async () => {
  const f = driverFixture();
  for (let i = 0; i < 24; i++) { f.setVideo(current(i)); await f.driver.browse({ action: i === 0 ? 'open' : 'current' }, f.context); }
  assert.deepEqual(f.selected.slice(0, 4), ['creator', 'feed', 'creator', 'feed']);
  const runs = f.runs, result = await f.driver.browse({ action: 'history' }, f.context);
  assert.equal(f.runs, runs); assert.equal(result.history.length, 20); assert.equal(result.history[0].id, current(4).id);
  assert.equal(result.current.id, current(23).id); assert.equal(result.visualUnderstanding, false); assert.equal(result.autonomous, false);
  assert.equal(result.evidence, 'page-text-and-playback-metadata');
  result.history[0].description = 'caller mutation';
  assert.notEqual((await f.driver.browse({ action: 'history' }, f.context)).history[0].description, 'caller mutation');
});

test('multibyte descriptions keep the full browse receipt within the manager byte budget', async () => {
  const f = driverFixture(); let result;
  for (let i = 0; i < 24; i++) {
    f.setVideo({ ...current(i), author: '鱼'.repeat(100), description: '视'.repeat(700) });
    result = await f.driver.browse({ action: i === 0 ? 'open' : 'current' }, f.context);
    assert(Buffer.byteLength(JSON.stringify(result)) <= 32000);
  }
  assert(result.history.length > 0 && result.history.length < 20);
  assert.equal(result.history.at(-1).id, current(23).id);
  assert.equal(result.current.description.length, 700);
});

test('only an exact verified local data-attribute binding enables next; unbound current remains read-only', async () => {
  for (const videoIdentity of [null, {}, { ...verifiedVideoIdentity, verified: false },
    { ...verifiedVideoIdentity, kind: 'media-source-fingerprint' }, { ...verifiedVideoIdentity, attribute: 'href' },
    { ...verifiedVideoIdentity, attribute: 'data-id]' }, { ...verifiedVideoIdentity, attribute: 'data-id\n' },
    { ...verifiedVideoIdentity, selector: '#arbitrary' }]) {
    const f = driverFixture({ videoIdentity });
    assert.equal(f.driver.nextAvailable, false);
    const first = await f.driver.browse({ action: 'current' }, f.context), runs = f.runs;
    assert.equal(first.current.platformVideoId, null); assert.equal(first.current.identityKind, 'media-source-fingerprint');
    await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'BROWSE_NEXT_UNAVAILABLE' });
    assert.equal(f.runs, runs); assert.equal(f.clicks, 0);
  }
  assert.equal(driverFixture().driver.nextAvailable, true);
});

test('a persisted owner pause prevents a verified next fixture from starting any runtime or click', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-browse-paused-driver-')), f = driverFixture();
  const manager = new SocialAccounts({ directory, drivers: { douyin: f.driver }, requestPolicy: null });
  manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: owner, name: 'fixture', generation: 1 }; }, { authorize: yes });
  t.after(async () => { await manager.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  f.driver.browseCurrent = current('one'); f.driver.browseAccount = owner; f.driver.browseState = 'active';
  manager.holdPlatform({ platform: 'douyin', revision: manager.snapshot().revision, reason: 'owner-paused' }, context);
  await assert.rejects(manager.browse('douyin', { action: 'next', expectedVideoId: current('one').id }, context), { code: 'RISK_CONTROL' });
  assert.equal(f.driver.nextAvailable, true); assert.equal(f.runs, 0); assert.equal(f.clicks, 0);
});

test('missing or malformed observed stable IDs cannot dispatch next despite a verified binding', async () => {
  for (const id of [null, '', '123', '1'.repeat(26), '123456789a']) {
    const f = driverFixture();
    f.setVideo({ ...current('one'), ...(id === null ? { id: mediaId('one') } : {}), platformVideoId: id === null ? null : id, identityKind: id === null ? 'media-source-fingerprint' : 'platform-video-id' });
    if (id === null) {
      const first = await f.driver.browse({ action: 'current' }, f.context), runs = f.runs;
      await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'BROWSE_NEXT_UNAVAILABLE' });
      assert.equal(f.runs, runs);
    } else {
      await assert.rejects(f.driver.browse({ action: 'current' }, f.context), { code: 'INVALID_RECEIPT' });
    }
    assert.equal(f.clicks, 0);
  }
});

test('stale page media and repeated old next observations cannot dispatch another switch', async () => {
  const f = driverFixture(), first = await f.driver.browse({ action: 'open' }, f.context);
  f.setVideo(current('changed-outside-this-request'));
  await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'BINDINGS_REQUIRED' });
  assert.equal(f.clicks, 0); const runs = f.runs;
  await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'CONFLICT' });
  assert.equal(f.runs, runs); assert.equal(f.clicks, 0);
  const fresh = await f.driver.browse({ action: 'current' }, f.context);
  const next = await f.driver.browse({ action: 'next', expectedVideoId: fresh.current.id }, f.context);
  assert.notEqual(next.current.id, fresh.current.id); assert.equal(f.clicks, 1);
  await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: fresh.current.id }, f.context), { code: 'CONFLICT' });
  assert.equal(f.clicks, 1);
});

test('unknown next keeps the observation consumed; wrong pre/post account never returns a video', async () => {
  const f = driverFixture(), first = await f.driver.browse({ action: 'open' }, f.context);
  f.setUnknown(true);
  await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'BROWSER_UNKNOWN' });
  assert.equal(f.clicks, 1); const runs = f.runs;
  await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'CONFLICT' });
  assert.equal(f.runs, runs); assert.equal(f.clicks, 1);
  for (const phase of ['before', 'after']) {
    const g = driverFixture();
    if (phase === 'before') g.setAccount('intruder'); else g.setAfterIdentity('intruder');
    await assert.rejects(g.driver.browse({ action: 'open' }, g.context), { code: 'ACCOUNT_MISMATCH' });
    assert.equal((await g.driver.browse({ action: 'history' }, g.context)).current, null);
  }
});

test('changing account scope clears old browse history and stop returns no previous account metadata', async () => {
  const f = driverFixture(); await f.driver.browse({ action: 'open' }, f.context);
  const stopped = await f.driver.browse({ action: 'stop' }, context);
  assert.equal(f.stops, 1); assert.equal(stopped.current, null); assert.deepEqual(stopped.history, []);
  f.runtime.stop = async () => ({ stopped: true, browserStopped: false });
  assert.equal((await f.driver.browse({ action: 'stop' }, context)).browserStopped, false);
  const changed = await f.driver.browse({ action: 'history' }, { ...context, accountId: 'different-owner-account' });
  assert.deepEqual(changed.history, []); assert.equal(changed.current, null);
  const other = new BrowserAccountDriver({ key: 'x', directory: '/unused', runtime: f.runtime });
  await assert.rejects(other.browse({ action: 'open' }, f.context), { code: 'INVALID_OPERATION' });
});

function domFixture({ ambiguous = false, missingText = false, missingAuthor = false, hiddenText = false, videoId = null, emptySource = false, readyState = 4 } = {}) {
  const rect = { width: 100, height: 100, top: 10, bottom: 110 };
  const leaf = (innerText, visible = true) => ({ innerText, getBoundingClientRect: () => visible ? rect : { ...rect, top: -200, bottom: -100 } });
  const video = { ...leaf(''), currentSrc: emptySource ? '' : 'https://media.invalid/video?private-signature=DO-NOT-PROJECT',
    src: emptySource ? '' : 'fixture-src', srcObject: emptySource ? { fixture: true } : null, readyState, networkState: 2, currentTime: 1.23456, duration: 10.98765,
    muted: false, paused: false, matches: s => s === 'video,audio', pause() { this.paused = true; } };
  const audio = { ...video, currentSrc: 'https://media.invalid/audio', paused: false };
  const row = { ...leaf('UNRELATED_COMMENT_AND_PRIVATE_PANEL'), getAttribute(attribute) {
    assert.equal(attribute, 'data-fixture-video-id'); return videoId;
  }, querySelectorAll(selector) {
    if (selector === 'video') return [video];
    if (selector === '[data-e2e="feed-video-nickname"]') return missingAuthor ? [] : [leaf('@public-author')];
    if (selector === '[data-e2e="video-desc"]') return missingText ? [] : [leaf('public description', !hiddenText)];
    return [];
  } };
  const handlers = new Map(); let observerCallback, observerCount = 0;
  const document = {
    documentElement: {}, matches: () => false, addEventListener(name, handler) { handlers.set(name, handler); },
    querySelectorAll(selector) {
      if (selector === '[data-e2e="feed-active-video"]') return ambiguous ? [row, row] : [row];
      if (selector === 'video') return [video];
      if (selector === 'video,audio') return [video, audio];
      return [];
    },
  };
  const sandbox = { document, crypto: webcrypto, TextEncoder, innerHeight: 800, getComputedStyle: () => ({ visibility: 'visible' }),
    MutationObserver: class { constructor(callback) { observerCallback = callback; observerCount++; } observe() {} } };
  sandbox.window = sandbox; vm.createContext(sandbox);
  return { sandbox, video, audio, handlers, setVideoId(value) { videoId = value; }, revealMetadata() { ambiguous = false; missingText = false; missingAuthor = false; hiddenText = false; },
    mutate(node) { observerCallback([{ addedNodes: [node] }]); }, get observerCount() { return observerCount; } };
}

test('DOM projection hashes the current media source, limits text and exposes no signed media URL or unrelated content', async () => {
  const f = domFixture(), result = await vm.runInContext(douyinVideoExpression, f.sandbox);
  assert.equal(result.id, mediaId(f.video.currentSrc)); assert.equal(result.platformVideoId, null);
  assert.equal(result.mediaSourceFingerprint, mediaId(f.video.currentSrc));
  assert.equal(result.identityKind, 'media-source-fingerprint'); assert.equal(result.author, '@public-author');
  assert.equal(result.description, 'public description'); assert.equal(result.media.currentTime, 1.235);
  assert.equal(result.media.duration, 10.988); assert.equal(result.media.muted, true); assert.equal(result.media.paused, true);
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-PROJECT|media\.invalid|UNRELATED_COMMENT_AND_PRIVATE_PANEL/);
  assert.equal(f.audio.muted, true); assert.equal(f.audio.paused, true);
});

test('verified active-row video IDs distinguish content from reused media sources without exposing source URLs', async () => {
  const f = domFixture({ videoId: '1234567890123456789' }), expression = douyinVideoObservation(verifiedVideoIdentity);
  const first = await vm.runInContext(expression, f.sandbox);
  assert.equal(first.platformVideoId, '1234567890123456789'); assert.equal(first.identityKind, 'platform-video-id');
  f.setVideoId('1234567890123456790');
  const sameSourceNewVideo = await vm.runInContext(expression, f.sandbox);
  assert.notEqual(sameSourceNewVideo.id, first.id); assert.equal(sameSourceNewVideo.mediaSourceFingerprint, first.mediaSourceFingerprint);
  f.video.currentSrc = 'blob:fixture-new-stream';
  const newSourceSameVideo = await vm.runInContext(expression, f.sandbox);
  assert.equal(newSourceSameVideo.platformVideoId, sameSourceNewVideo.platformVideoId);
  assert.equal(newSourceSameVideo.id, sameSourceNewVideo.id); assert.notEqual(newSourceSameVideo.mediaSourceFingerprint, sameSourceNewVideo.mediaSourceFingerprint);
  for (const value of [null, '', '123', '1'.repeat(26), '123456789a', ' 1234567890', '1234567890\n']) {
    f.setVideoId(value); const observed = await vm.runInContext(expression, f.sandbox);
    assert.equal(observed.platformVideoId, null); assert.equal(observed.identityKind, 'media-source-fingerprint');
    assert.equal(observed.id, observed.mediaSourceFingerprint);
  }
});

test('a loaded srcObject-style player needs verified stable identity and reports no source fingerprint', async () => {
  const f = domFixture({ videoId: '1234567890123456789', emptySource: true, readyState: 4 });
  const expression = douyinVideoObservation(verifiedVideoIdentity);
  const observed = await vm.runInContext(expression, f.sandbox);
  assert.equal(observed.platformVideoId, '1234567890123456789');
  assert.equal(observed.id, mediaId(JSON.stringify(['platform-video-id', observed.platformVideoId])));
  assert.equal(observed.mediaSourceFingerprint, null); assert.equal(observed.media.readyState, 4);
  assert.equal(observed.media.muted, true); assert.equal(observed.media.paused, true);
  f.video.currentSrc = 'blob:later-source';
  const later = await vm.runInContext(expression, f.sandbox);
  assert.equal(later.id, observed.id); assert.equal(later.mediaSourceFingerprint, mediaId('blob:later-source'));
  for (const options of [{ videoId: null }, { videoId: 'invalid-id' }, { readyState: 0 }, { readyState: 1 }, { readyState: 5 }, { readyState: undefined }]) {
    const unavailable = domFixture({ videoId: '1234567890123456789', emptySource: true, ...options });
    if (Object.hasOwn(options, 'readyState')) unavailable.video.readyState = options.readyState;
    assert.equal(await vm.runInContext(expression, unavailable.sandbox), null);
    assert.equal(unavailable.video.paused, true); assert.equal(unavailable.video.muted, true);
  }
  assert.equal(await vm.runInContext(douyinVideoExpression, domFixture({ videoId: '1234567890123456789', emptySource: true }).sandbox), null);
});

test('driver accepts a null fingerprint only with verified stable identity and loaded media; undefined is never a receipt', async () => {
  const valid = driverFixture(), value = current('one');
  valid.setVideo({ ...value, mediaSourceFingerprint: null, media: { ...value.media, readyState: 4 } });
  assert.equal((await valid.driver.browse({ action: 'current' }, valid.context)).current.mediaSourceFingerprint, null);
  for (const patch of [
    { mediaSourceFingerprint: undefined, media: { ...value.media, readyState: 4 } },
    { mediaSourceFingerprint: null, media: { ...value.media, readyState: 0 } },
    { mediaSourceFingerprint: null, media: { ...value.media, readyState: 1 } },
    { mediaSourceFingerprint: null, media: { ...value.media, readyState: undefined } },
    { mediaSourceFingerprint: null, media: { ...value.media, readyState: 5 } },
    { mediaSourceFingerprint: null, platformVideoId: null, identityKind: 'media-source-fingerprint', media: { ...value.media, readyState: 4 } },
    { id: mediaId('wrong-stable-observation') },
  ]) {
    const f = driverFixture(); f.setVideo({ ...value, ...patch });
    await assert.rejects(f.driver.browse({ action: 'current' }, f.context), { code: 'INVALID_RECEIPT' });
    assert.equal(f.clicks, 0);
  }
});

test('manual playback guard pauses later play events and dynamically inserted media without duplicate observers', async () => {
  const f = domFixture(); await vm.runInContext(douyinVideoExpression, f.sandbox);
  await vm.runInContext(douyinVideoExpression, f.sandbox); assert.equal(f.observerCount, 1);
  f.video.paused = false; f.video.muted = false; f.handlers.get('play')({ target: f.video });
  assert.equal(f.video.paused, true); assert.equal(f.video.muted, true);
  const late = { muted: false, paused: false, matches: () => true, pause() { this.paused = true; }, querySelectorAll: () => [] };
  f.mutate(late); assert.equal(late.paused, true); assert.equal(late.muted, true);
});

test('ambiguous active video or unavailable visible author/description fails closed after pausing media', async () => {
  for (const options of [{ ambiguous: true }, { missingText: true }, { hiddenText: true }]) {
    const f = domFixture(options); assert.equal(await vm.runInContext(douyinVideoExpression, f.sandbox), null);
    assert.equal(f.video.paused, true); assert.equal(f.video.muted, true);
  }
});

test('video readiness waits for the full visible observation even when the media source is already loaded', async () => {
  for (const options of [{ missingText: true }, { missingAuthor: true }, { hiddenText: true }, { ambiguous: true }]) {
    const f = domFixture(options), source = f.video.currentSrc;
    assert.equal(await vm.runInContext(douyinVideoReady, f.sandbox), false);
    assert.equal(f.video.currentSrc, source); assert.equal(f.video.paused, true); assert.equal(f.video.muted, true);
    f.revealMetadata();
    assert.equal(await vm.runInContext(douyinVideoReady, f.sandbox), true);
    assert.equal(f.video.currentSrc, source);
  }
});
