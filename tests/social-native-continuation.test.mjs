import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { BrowserAccountDriver } from '../packages/dsh-dafeiyu/src/social/browser-account.mjs';
import { SocialAccounts } from '../packages/dsh-dafeiyu/src/social/accounts.mjs';
import { DOUYIN_RECOMMEND, DOUYIN_RECOMMEND_LINK, DOUYIN_NEXT, isRecommendationUrl,
  douyinBrowseExpressions } from '../packages/dsh-dafeiyu/src/social/douyin-browse.mjs';

const owner = 'continuation-fixture-owner';
const identityUrl = 'https://creator.douyin.com/creator-micro/home';
const verifiedVideoIdentity = { verified: true, kind: 'platform-video-id', attribute: 'data-fixture-video-id' };
const firstVideoId = '1234567890123456789', nextVideoId = '1234567890123456790';
const fingerprint = value => 'media-' + createHash('sha256').update(value).digest('hex');
const video = { id: fingerprint(JSON.stringify(['platform-video-id', firstVideoId])), mediaSourceFingerprint: fingerprint('fixture-media'),
  identityKind: 'platform-video-id', platformVideoId: firstVideoId, url: DOUYIN_RECOMMEND,
  author: '@fixture-author', description: 'fixture page text',
  media: { muted: true, paused: true, currentTime: 0, duration: 20 } };

function fixture(feedUrls, options = {}) {
  const videoIdentity = Object.hasOwn(options, 'videoIdentity') ? options.videoIdentity : verifiedVideoIdentity;
  const { videoExpression, videoReady, openNavigationExpression, openNavigationReady, feedReady } = douyinBrowseExpressions(videoIdentity);
  const tabs = [{ targetId: 'identity', url: identityUrl }, ...feedUrls.map((url, index) => ({ targetId: 'feed-' + index, url }))];
  let selected = 'identity', identities = 0, observations = 0, wrongAfter = false, stopCalls = 0, navigations = 0, recommendationClicks = 0, nextClicks = 0, redirected = false;
  let metadataReady = options.metadataInitiallyReady !== false, metadataWaits = 0, description = video.description;
  let stableVideoId = Object.hasOwn(options, 'videoId') ? options.videoId : firstVideoId;
  const selections = [];
  const currentTab = () => tabs.find(tab => tab.targetId === selected);
  const rect = { width: 100, height: 100, bottom: 120, top: 20 };
  const leaf = text => ({ innerText: text, getBoundingClientRect: () => rect });
  const media = { currentSrc: options.ready === false || options.emptySource ? '' : 'fixture-media',
    readyState: options.readyState ?? 4, networkState: 2, srcObject: options.emptySource ? { fixture: true } : null, currentTime: 0, duration: 20,
    muted: false, paused: false, matches: () => true, pause() { this.paused = true; }, getBoundingClientRect: () => rect };
  const activeRow = { getBoundingClientRect: () => rect, getAttribute(attribute) {
    assert.equal(attribute, 'data-fixture-video-id'); return stableVideoId;
  }, querySelectorAll(selector) {
    if (selector === 'video') return [media];
    if (selector === '[data-e2e="feed-video-nickname"]') return metadataReady ? [leaf(video.author)] : [];
    if (selector === '[data-e2e="video-desc"]') return metadataReady ? [leaf(description)] : [];
    return [];
  } };
  const expressionValue = expression => vm.runInNewContext(expression, {
    URL, location: { href: currentTab().url }, innerHeight: 800, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    crypto: webcrypto, TextEncoder, window: {}, MutationObserver: class { observe() {} },
    document: {
      documentElement: {}, addEventListener() {},
      querySelectorAll: selector => {
        if (selector === '[data-e2e="feed-active-video"]') return isRecommendationUrl(currentTab().url) ? [activeRow] : [];
        if (selector === 'video' || selector === 'video,audio') return [media];
        assert.equal(selector, DOUYIN_RECOMMEND_LINK);
        return Array.from({ length: options.linkCount ?? 1 }, () => ({ innerText: options.linkText ?? '推荐',
          getBoundingClientRect: () => ({ width: options.hiddenLink ? 0 : 40, height: 20, bottom: 40, top: 20 }) }));
      },
    },
  });
  const runtime = {
    children: new Set(), cleanupPending: false,
    async run(body) {
      const browser = {
        async listTabs() { return tabs; }, async ensureRealTab() {},
        async switchTab(id) { assert(tabs.some(tab => tab.targetId === id)); selected = id; selections.push(id); },
        async openOrReuseTab(url) {
          if (!options.openLanding) throw Error('existing-page fixture must not create or navigate a page');
          assert.equal(url, DOUYIN_RECOMMEND); navigations++;
          tabs.push({ targetId: 'feed-created', url: options.redirectOnWait ? DOUYIN_RECOMMEND : options.openLanding }); selected = 'feed-created';
        },
      };
      const page = {
        async url() { return currentTab().url; },
        async goto() { throw Error('identity must not navigate the feed tab away'); },
        async waitForFunction(expression) {
          if (expression === openNavigationReady && options.redirectOnWait && !redirected) { currentTab().url = options.openLanding; redirected = true; }
          if ([openNavigationReady, feedReady, videoReady].includes(expression) || expression.includes('function observeDouyinVideo(')) {
            let ready = await expressionValue(expression);
            if (!ready && !metadataReady && options.resolveDelayedMetadata) {
              metadataWaits++; await Promise.resolve(); metadataReady = true; ready = await expressionValue(expression);
            }
            if (!ready) throw Object.assign(Error('fixture wait timed out'), { code: 'BROWSER_UNKNOWN' });
          }
        },
        async evaluate(expression) {
          if (expression === videoExpression) { observations++; assert(selected.startsWith('feed-')); return expressionValue(expression); }
          if (expression === openNavigationExpression) return expressionValue(expression);
          if (expression.includes("state:'login-pending'")) {
            identities++;
            if (identities > 1 && options.afterIdentityDescription) description = options.afterIdentityDescription;
            if (identities > 1 && options.afterIdentitySource) media.currentSrc = options.afterIdentitySource;
            if (identities > 1 && Object.hasOwn(options, 'afterIdentityVideoId')) stableVideoId = options.afterIdentityVideoId;
            return { loggedIn: true, accountId: wrongAfter && identities > 1 ? 'other-account' : owner, name: 'fixture' };
          }
          if (expression.includes('iframe[src*=captcha]')) return false;
          throw Error('unexpected expression');
        },
        locator(selector) {
          assert([DOUYIN_RECOMMEND_LINK, DOUYIN_NEXT].includes(selector));
          return { async click() {
            if (selector === DOUYIN_NEXT) {
              nextClicks++; if (options.emptyAfterNext) media.currentSrc = ''; else if (!options.reuseSource) media.currentSrc = 'next-fixture-media'; description = 'next visible caption';
              if (!options.keepVideoId) stableVideoId = Object.hasOwn(options, 'nextVideoId') ? options.nextVideoId : nextVideoId;
              if (options.wrongAccountAfterNext) wrongAfter = true;
              if (options.delayAfterNext) metadataReady = false;
              return;
            }
            recommendationClicks++;
            if (options.clickUnknown) throw Object.assign(Error('unknown click result'), { code: 'BROWSER_UNKNOWN' });
            currentTab().url = DOUYIN_RECOMMEND + '&from_nav=1';
          } };
        },
      };
      try {
        return await vm.runInNewContext('(async()=>{' + body + '\nreturn result;})()', {
          URL, page, browser, taskSpaces: {
            async list() { return [{ id: 1, name: 'dfy-social-douyin', ownership: 'agent' }]; },
            async useOrCreate() {},
          },
        });
      } catch (error) {
        if (!error.code && ['BINDINGS_REQUIRED', 'ACCOUNT_MISMATCH', 'RISK_CONTROL'].includes(error.message)) error.code = error.message;
        throw error;
      }
    },
    async stop() { stopCalls++; return { stopped: true, browserStopped: false, spaceRetained: true }; },
    async dispose() {},
  };
  const driver = new BrowserAccountDriver({ key: 'douyin', directory: '/fixture-never-read', runtime,
    bindings: { platform: 'douyin', verified: true, accountId: owner,
      browse: { videoIdentity },
      identity: { url: identityUrl, selector: '#fixture-own', attribute: 'innerText', pattern: '^owner:(.+)$' } } });
  return { driver, context: { authorize: () => true, accountId: owner }, selections,
    wrongAfter() { wrongAfter = true; }, get identities() { return identities; }, get observations() { return observations; }, get stopCalls() { return stopCalls; },
    get navigations() { return navigations; }, get recommendationClicks() { return recommendationClicks; }, get metadataWaits() { return metadataWaits; }, get nextClicks() { return nextClicks; } };
}

test('official recommendation tracking parameters survive both tab selection and return after account verification', async () => {
  for (const url of [DOUYIN_RECOMMEND + '&from_nav=1', 'https://www.douyin.com/?from_nav=1&recommend=1']) {
    const f = fixture([url]);
    const result = await f.driver.browse({ action: 'current' }, f.context);
    assert.equal(result.current.id, video.id);
    assert.equal(result.accountId, owner);
    assert.equal(result.visualUnderstanding, false);
    assert.equal(f.identities, 2); assert.equal(f.observations, 2);
    assert.deepEqual(f.selections, ['identity', 'feed-0', 'identity', 'feed-0']);
  }
});

test('untrusted hosts, fragment-bearing pages and ambiguous managed feeds never become the current video', async () => {
  for (const urls of [
    ['https://www.douyin.com.evil/?recommend=1'],
    [DOUYIN_RECOMMEND + '#different-state'],
    ['https://www.douyin.com:9443/?recommend=1'],
    ['https://u:p@www.douyin.com/?recommend=1'],
    [DOUYIN_RECOMMEND, DOUYIN_RECOMMEND + '&from_nav=1'],
  ]) {
    const f = fixture(urls);
    await assert.rejects(f.driver.browse({ action: 'current' }, f.context), { code: 'BINDINGS_REQUIRED' });
    assert.equal(f.observations, 0);
    assert.equal((await f.driver.browse({ action: 'history' }, f.context)).current, null);
  }
});

test('a valid native feed URL still cannot return content after the creator account changes', async () => {
  const f = fixture([DOUYIN_RECOMMEND + '&from_nav=1']); f.wrongAfter();
  await assert.rejects(f.driver.browse({ action: 'current' }, f.context), { code: 'ACCOUNT_MISMATCH' });
  const local = await f.driver.browse({ action: 'history' }, f.context);
  assert.equal(local.current, null); assert.deepEqual(local.history, []);
  assert.equal(f.identities, 2);
});

test('open waits for a client-side selection redirect and follows the observed recommendation link once', async () => {
  for (const landing of ['https://www.douyin.com/jingxuan', 'https://www.douyin.com/']) {
    const f = fixture([], { openLanding: landing, redirectOnWait: true });
    const result = await f.driver.browse({ action: 'open' }, f.context);
    assert.equal(result.current.id, video.id); assert.equal(result.accountId, owner);
    assert.equal(f.navigations, 1); assert.equal(f.recommendationClicks, 1);
    assert.equal(f.identities, 2); assert.equal(f.observations, 2);
  }
});

test('open never clicks an ambiguous, hidden or differently labelled recommendation control', async () => {
  for (const options of [{ linkCount: 2 }, { linkCount: 0 }, { hiddenLink: true }, { linkText: '推荐广告' }]) {
    const f = fixture([], { openLanding: 'https://www.douyin.com/jingxuan', ...options });
    await assert.rejects(f.driver.browse({ action: 'open' }, f.context));
    assert.equal(f.navigations, 1); assert.equal(f.recommendationClicks, 0); assert.equal(f.observations, 0);
  }
});

test('open never clicks a recommendation control from a wrong origin or an unobserved route', async () => {
  for (const landing of ['https://www.douyin.com.evil/jingxuan', 'https://www.douyin.com/search',
    'https://www.douyin.com/jingxuan#different-state', 'https://www.douyin.com/?modal_id=123']) {
    const f = fixture([], { openLanding: landing });
    await assert.rejects(f.driver.browse({ action: 'open' }, f.context));
    assert.equal(f.recommendationClicks, 0); assert.equal(f.observations, 0);
  }
});

test('current and next never use the open-only navigation fallback', async () => {
  for (const action of ['current', 'next']) {
    const f = fixture(['https://www.douyin.com/jingxuan']);
    if (action === 'next') f.driver.browseCurrent = structuredClone(video);
    await assert.rejects(f.driver.browse({ action, ...(action === 'next' ? { expectedVideoId: video.id } : {}) }, f.context), { code: 'BINDINGS_REQUIRED' });
    assert.equal(f.navigations, 0); assert.equal(f.recommendationClicks, 0); assert.equal(f.observations, 0);
  }
});

test('an unknown recommendation click is consumed once without reading or automatically navigating again', async () => {
  const f = fixture([], { openLanding: 'https://www.douyin.com/jingxuan', clickUnknown: true });
  await assert.rejects(f.driver.browse({ action: 'open' }, f.context), { code: 'BROWSER_UNKNOWN' });
  assert.equal(f.navigations, 1); assert.equal(f.recommendationClicks, 1); assert.equal(f.observations, 0);
  assert.equal((await f.driver.browse({ action: 'history' }, f.context)).current, null);
  await assert.rejects(f.driver.browse({ action: 'current' }, f.context), { code: 'BINDINGS_REQUIRED' });
  assert.equal(f.navigations, 1); assert.equal(f.recommendationClicks, 1);
});

test('open and current wait for delayed metadata without a new navigation or recommendation click', async () => {
  for (const action of ['open', 'current']) {
    const f = fixture([DOUYIN_RECOMMEND], { metadataInitiallyReady: false, resolveDelayedMetadata: true });
    const result = await f.driver.browse({ action }, f.context);
    assert.equal(f.metadataWaits, 1); assert.equal(result.current.author, video.author); assert.equal(result.current.description, video.description);
    assert.equal(f.navigations, 0); assert.equal(f.recommendationClicks, 0); assert.equal(f.nextClicks, 0);
  }
});

test('next clicks only once and waits for the next visible metadata before returning', async () => {
  const f = fixture([DOUYIN_RECOMMEND], { delayAfterNext: true, resolveDelayedMetadata: true });
  const first = await f.driver.browse({ action: 'current' }, f.context);
  const next = await f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context);
  assert.notEqual(next.current.id, first.current.id); assert.equal(next.current.description, 'next visible caption');
  assert.equal(f.metadataWaits, 1); assert.equal(f.nextClicks, 1); assert.equal(f.navigations, 0); assert.equal(f.recommendationClicks, 0);
});

test('a verified new video ID proves next even when the player reuses the same source', async () => {
  const f = fixture([DOUYIN_RECOMMEND], { reuseSource: true });
  const first = await f.driver.browse({ action: 'current' }, f.context);
  const next = await f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context);
  assert.equal(first.current.platformVideoId, firstVideoId); assert.equal(next.current.platformVideoId, nextVideoId);
  assert.equal(next.current.mediaSourceFingerprint, first.current.mediaSourceFingerprint);
  assert.notEqual(next.current.id, first.current.id); assert.equal(f.nextClicks, 1);
  await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'CONFLICT' });
  assert.equal(f.nextClicks, 1);
});

test('open/current and a new next ID support loaded empty-source players through the same verified binding', async () => {
  for (const options of [{ emptySource: true }, { emptySource: true, openLanding: 'https://www.douyin.com/jingxuan' }]) {
    const f = fixture(options.openLanding ? [] : [DOUYIN_RECOMMEND], options);
    const first = await f.driver.browse({ action: 'open' }, f.context);
    assert.equal(first.current.platformVideoId, firstVideoId); assert.equal(first.current.mediaSourceFingerprint, null);
    assert.equal(first.current.media.readyState, 4); assert.equal(f.recommendationClicks, options.openLanding ? 1 : 0);
  }
  const f = fixture([DOUYIN_RECOMMEND], { emptyAfterNext: true });
  const first = await f.driver.browse({ action: 'current' }, f.context);
  const next = await f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context);
  assert.equal(next.current.platformVideoId, nextVideoId); assert.equal(next.current.mediaSourceFingerprint, null);
  assert.equal(next.current.media.readyState, 4); assert.equal(f.nextClicks, 1);
  assert.notEqual(next.current.id, first.current.id);
});

test('empty sources without stable identity or loaded media cannot dispatch a next', async () => {
  for (const options of [{ videoIdentity: null }, { videoId: null }, { videoId: 'invalid' }, { readyState: 0 }, { readyState: 1 }]) {
    const f = fixture([DOUYIN_RECOMMEND], { emptySource: true, ...options });
    await assert.rejects(f.driver.browse({ action: 'current' }, f.context), { code: 'BROWSER_UNKNOWN' });
    assert.equal(f.nextClicks, 0); assert.equal(f.recommendationClicks, 0);
  }
});

test('source or caption changes without a new verified video ID leave next unknown and consumed', async () => {
  for (const reuseSource of [true, false]) {
    const f = fixture([DOUYIN_RECOMMEND], { keepVideoId: true, reuseSource });
    const first = await f.driver.browse({ action: 'current' }, f.context);
    await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'BROWSER_UNKNOWN' });
    assert.equal(f.nextClicks, 1);
    assert.equal((await f.driver.browse({ action: 'history' }, f.context)).current, null);
    await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'CONFLICT' });
    assert.equal(f.nextClicks, 1);
  }
});

test('missing binding or malformed current video ID keeps current readable and next unavailable without a runtime', async () => {
  for (const options of [{ videoIdentity: null }, { videoIdentity: { ...verifiedVideoIdentity, verified: false } },
    { videoIdentity: { ...verifiedVideoIdentity, attribute: 'href' } },
    { videoId: null }, { videoId: '123' }, { videoId: '1'.repeat(26) }, { videoId: '1234567890\n' }]) {
    const f = fixture([DOUYIN_RECOMMEND], options);
    const first = await f.driver.browse({ action: 'current' }, f.context), identities = f.identities;
    assert.equal(first.current.platformVideoId, null); assert.equal(first.current.identityKind, 'media-source-fingerprint');
    await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'BROWSE_NEXT_UNAVAILABLE' });
    assert.equal(f.identities, identities); assert.equal(f.nextClicks, 0); assert.equal(f.navigations, 0);
  }
});

test('a changed stable video ID still cannot return next after the creator identity changes', async () => {
  const f = fixture([DOUYIN_RECOMMEND], { reuseSource: true, wrongAccountAfterNext: true });
  const first = await f.driver.browse({ action: 'current' }, f.context);
  await assert.rejects(f.driver.browse({ action: 'next', expectedVideoId: first.current.id }, f.context), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(f.nextClicks, 1);
  assert.equal((await f.driver.browse({ action: 'history' }, f.context)).current, null);
});

test('a stable ID changing during the final identity check invalidates a reused-source observation', async () => {
  const f = fixture([DOUYIN_RECOMMEND], { afterIdentityVideoId: nextVideoId });
  await assert.rejects(f.driver.browse({ action: 'current' }, f.context), { code: 'BINDINGS_REQUIRED' });
  assert.equal((await f.driver.browse({ action: 'history' }, f.context)).current, null);
  assert.equal(f.nextClicks, 0);
});

test('the final feed read keeps stable identity across caption and media-source changes', async () => {
  const f = fixture([DOUYIN_RECOMMEND], { afterIdentityDescription: 'caption completed during identity verification' });
  const result = await f.driver.browse({ action: 'current' }, f.context);
  assert.equal(result.current.id, video.id); assert.equal(result.current.description, 'caption completed during identity verification');
  assert.equal(f.observations, 2); assert.equal(f.navigations, 0); assert.equal(f.recommendationClicks, 0);
  const changed = fixture([DOUYIN_RECOMMEND], { afterIdentitySource: 'different-video-arrived-during-identity-check' });
  const sameWork = await changed.driver.browse({ action: 'current' }, changed.context);
  assert.equal(sameWork.current.id, video.id); assert.equal(sameWork.current.platformVideoId, firstVideoId);
  assert.notEqual(sameWork.current.mediaSourceFingerprint, video.mediaSourceFingerprint);
  assert.equal(changed.navigations, 0); assert.equal(changed.recommendationClicks, 0);
});

test('native stop reports retained login space without claiming that the shared Ego browser closed', async () => {
  const f = fixture([DOUYIN_RECOMMEND]);
  await f.driver.browse({ action: 'current' }, f.context);
  const stopped = await f.driver.browse({ action: 'stop' }, f.context);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.spaceRetained, true);
  assert.equal(stopped.browserStopped, false); assert.equal(stopped.current, null);
  assert.deepEqual(stopped.history, []); assert.equal(f.stopCalls, 1);
});

test('local history never escapes the original account and generation after an asynchronous binding change', async t => {
  for (const change of [{ accountId: 'replacement-account' }, { generation: 2 }]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-local-history-scope-')); let calls = 0;
    const driver = { idle: true, capabilities: () => ({}), async dispose() {}, async browse(input, scope) {
      calls++; assert.equal(input.action, 'history'); assert.equal(scope.accountId, owner);
      await Promise.resolve();
      manager.store.transact(state => Object.assign(state.accounts.douyin, change), { authorize: () => true });
      return { ok: true, history: [{ description: 'OLD_SCOPE_MUST_NOT_ESCAPE' }] };
    } };
    const manager = new SocialAccounts({ directory, drivers: { douyin: driver }, requestPolicy: null });
    manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: owner, generation: 1 }; }, { authorize: () => true });
    t.after(async () => { await manager.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
    await assert.rejects(manager.browse('douyin', { action: 'history' }, { authorize: () => true }), { code: 'ACCOUNT_MISMATCH' });
    assert.equal(calls, 1);
  }
});
