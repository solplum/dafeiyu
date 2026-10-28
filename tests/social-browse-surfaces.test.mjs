import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SOCIAL_ACCOUNT_ROUTES, socialAccountRoute } from '../packages/dsh-dafeiyu/src/social/account-routes.mjs';

test('browse route preserves exact payload, owner recheck and passive snapshot boundaries', async () => {
  const calls = [], request = { action: 'next', expectedVideoId: 'media-' + 'a'.repeat(64) };
  let authorized = true, release;
  const snapshot = { revision: 'fixture', platforms: [], operations: [] };
  const manager = { snapshot: () => snapshot, async browse(platform, input, context) {
    calls.push({ platform, input, context }); return { ok: true, action: input.action, state: 'active' };
  } };
  assert.equal(SOCIAL_ACCOUNT_ROUTES['social/browse'], 'POST');
  const context = { authorize: () => authorized };
  const result = await socialAccountRoute('social/browse', manager, { platform: 'douyin', request }, context);
  assert.equal(result.accounts, snapshot); assert.equal(result.browse.action, 'next');
  assert.equal(calls[0].input, request); assert.equal(calls[0].context, context);
  await assert.rejects(socialAccountRoute('social/browse', manager, { platform: 'douyin', request, extra: true }, context), { code: 'INVALID_REQUEST' });
  authorized = false;
  await assert.rejects(socialAccountRoute('social/browse', manager, { platform: 'douyin', request }, context), { code: 'FORBIDDEN' });
  assert.equal(calls.length, 1);
  authorized = true;
  manager.browse = async () => { await new Promise(resolve => release = resolve); return { private: 'MUST_NOT_ESCAPE' }; };
  const pending = socialAccountRoute('social/browse', manager, { platform: 'douyin', request: { action: 'current' } }, context);
  await Promise.resolve(); authorized = false; release();
  await assert.rejects(pending, { code: 'FORBIDDEN' });
});

function previewFixture() {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = new Map(); this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.textContent = ''; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
  }
  const ids = new Map(), calls = [], storage = new Map();
  for (const id of ['platforms', 'message', 'browse-actions', 'browse-content', 'operations', 'refresh', 'read', 'prepare']) ids.set(id, new Element());
  const snapshot = { revision: 'fixture', platforms: [{ platform: 'douyin', name: '抖音', state: 'bound', accountId: '123', accountName: '离线账号', driverAvailable: true, nextAvailable: true, capabilities: [] }], operations: [] };
  const observation = (letter = 'a') => ({ platformVideoId: '1234567890123456789', id: 'media-' + letter.repeat(64), url: 'https://www.douyin.com/', author: '离线作者', description: '页面文案 <script>无执行</script>', media: { muted: true, paused: true, currentTime: 1, duration: 5 } });
  let current = observation(), state = 'stopped', failure, gate, stopGate, routeFailure;
  const script = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/social/accounts-preview-client.js', import.meta.url), 'utf8');
  vm.runInNewContext(script, { document: { getElementById: id => ids.get(id), createElement: tag => new Element(tag), createTextNode: text => String(text) },
    location: { hash: '#fixture-owner', pathname: '/' }, history: { replaceState() {} }, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    AbortController, URL, setTimeout: () => 1, clearTimeout() {}, crypto: { randomUUID: () => '12345678-1234-4234-8234-123456789012' },
    fetch: async (url, options = {}) => {
      const route = url.slice('/api/'.length), payload = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ route, payload }); let browse;
      if (routeFailure?.route === route) { const code = routeFailure.code; routeFailure = undefined;
        return { ok: false, json: async () => ({ ok: false, code, error: code }) }; }
      if (route === 'social/browse') {
        const action = payload.request.action;
        if (action === 'current' && gate) await gate;
        if (action === 'stop' && stopGate) await stopGate;
        if (failure) { const code = failure; failure = undefined; return { ok: false, json: async () => ({ ok: false, code, error: code }) }; }
        if (action === 'next') current = observation('b');
        if (action === 'stop') state = 'stopped'; else if (action !== 'history') state = 'active';
        browse = { ok: true, action, state, current: action === 'stop' ? null : current, history: action === 'stop' ? [] : [current] };
      }
      if (route === 'social/recover-executor') snapshot.platforms[0].cleanupRequired = false;
      return { ok: true, json: async () => ({ ok: true, accounts: structuredClone(snapshot), ...(browse ? { browse } : {}) }) };
    } });
  const text = node => typeof node === 'string' ? node : (node.textContent || '') + node.children.map(text).join('');
  const nodes = node => typeof node === 'string' ? [] : [node, ...node.children.flatMap(nodes)];
  const platformButton = label => nodes(ids.get('platforms')).find(node => node.tag === 'button' && node.textContent === label);
  const recoveryCheckbox = () => { const label = nodes(ids.get('platforms')).find(node => node.tag === 'label' && text(node).includes('我已确认旧执行器停止，并核对了原平台结果'));
    return label && nodes(label).find(node => node.tag === 'input' && node.type === 'checkbox'); };
  const button = label => ids.get('browse-actions').children.find(node => node.tag === 'button' && node.textContent === label);
  const flush = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); };
  const click = async label => { const node = button(label); assert(node, 'missing button ' + label); assert.equal(node.disabled, false); node.listeners.get('click')(); await flush(); };
  return { calls, snapshot, ids, holdStop(value) { stopGate = value; }, videoId(value) { current.platformVideoId = value; }, button, platformButton, recoveryCheckbox, flush, click, allText: () => text(ids.get('platforms')),
    text: () => text(ids.get('browse-content')), fail(code) { failure = code; }, failRoute(route, code) { routeFailure = { route, code }; }, hold(value) { gate = value; } };
}

test('preview ships single-step browse controls with no implicit platform action and no visible media fingerprint', async () => {
  const f = previewFixture(); await f.flush();
  assert.deepEqual(f.calls.map(row => row.route), ['social/accounts']); assert.equal(f.button('下一个').disabled, true);
  await f.click('打开推荐'); assert.equal(f.calls.filter(row => row.route === 'social/browse').length, 1);
  assert(f.text().includes('离线作者')); assert(f.text().includes('<script>无执行</script>')); assert(!f.text().includes('media-'));
  assert(f.text().includes('页面播放器静音：已确认')); assert(f.text().includes('已暂停'));
  await f.click('下一个'); assert.equal(f.calls.find(row => row.payload?.request?.action === 'next').payload.request.expectedVideoId, 'media-' + 'a'.repeat(64));
  f.fail('BROWSER_UNKNOWN'); await f.click('读取当前'); assert.equal(f.button('下一个').disabled, true);
  f.snapshot.platforms[0].safetyPause = { reason: 'owner-paused' };
  await f.click('查看有限历史'); assert.equal(f.button('打开推荐').disabled, true); assert.equal(f.button('停止').disabled, false);
  await f.click('停止'); assert(f.text().includes('当前未在浏览。')); assert.equal(f.button('下一个').disabled, true);
  assert(f.calls.filter(row => row.route === 'social/browse').every(row => row.payload.platform === 'douyin'));
});

test('preview next needs verified capability and stable current video ID; old handlers cannot submit', async () => {
  for (const videoId of [undefined, null, '', 'blob:fixture', '123', '12345678901234567890123456', '1234567890123456789\n']) {
    const f = previewFixture(); await f.flush(); f.videoId(videoId); await f.click('打开推荐');
    assert.equal(f.button('下一个').disabled, true);
    const before = f.calls.length; f.button('下一个').listeners.get('click')(); await f.flush();
    assert.equal(f.calls.length, before);
  }
  const f = previewFixture(); await f.flush(); await f.click('打开推荐');
  const stale = f.button('下一个'); assert.equal(stale.disabled, false);
  f.snapshot.platforms[0].nextAvailable = false; f.ids.get('refresh').listeners.get('click')(); await f.flush();
  assert.equal(f.button('下一个').disabled, true); assert(f.text().includes('切换视频仍待验证'));
  const before = f.calls.length; stale.listeners.get('click')(); await f.flush();
  assert.equal(f.calls.length, before);
});

test('preview stale next handler rechecks pause, cleanup and stop-in-progress before any POST', async () => {
  for (const change of [{ safetyPause: { reason: 'owner-paused' } }, { cleanupRequired: true }, { blocked: true }, { busy: true }, { driverAvailable: false }]) {
    const f = previewFixture(); await f.flush(); await f.click('打开推荐'); const stale = f.button('下一个');
    Object.assign(f.snapshot.platforms[0], change); f.ids.get('refresh').listeners.get('click')(); await f.flush();
    assert.equal(f.button('下一个').disabled, true);
    const before = f.calls.filter(row => row.route === 'social/browse').length;
    stale.listeners.get('click')(); await f.flush(); assert.equal(f.calls.filter(row => row.route === 'social/browse').length, before);
  }
  const f = previewFixture(); await f.flush(); await f.click('打开推荐'); const stale = f.button('下一个');
  let release; f.holdStop(new Promise(resolve => release = resolve)); await f.click('停止');
  const before = f.calls.filter(row => row.route === 'social/browse').length;
  stale.listeners.get('click')(); await f.flush(); assert.equal(f.calls.filter(row => row.route === 'social/browse').length, before);
  release(); await f.flush(); assert(f.text().includes('当前未在浏览。'));
});

test('preview stop remains available while a read waits and ignores its late active result', async () => {
  const f = previewFixture(); await f.flush(); await f.click('打开推荐');
  let release; f.hold(new Promise(resolve => release = resolve));
  await f.click('读取当前'); assert.equal(f.ids.get('browse-actions').children[2].disabled, true); assert.equal(f.button('停止').disabled, false);
  await f.click('停止'); assert(f.text().includes('当前未在浏览。'));
  release(); await f.flush(); assert(f.text().includes('当前未在浏览。')); assert(!f.text().includes('离线作者'));
  assert.equal(f.ids.get('message').textContent, '本次浏览已停止，登录资料保留。');
});

test('preview account, generation and binding-state changes clear only the local browse view', async () => {
  for (const change of [{ accountId: 'different-account' }, { generation: 2 }, { state: 'candidate' }]) {
    const f = previewFixture(); await f.flush(); await f.click('打开推荐');
    assert(f.text().includes('离线作者')); const calls = f.calls.filter(row => row.route === 'social/browse').length;
    Object.assign(f.snapshot.platforms[0], change);
    f.ids.get('refresh').listeners.get('click')(); await f.flush();
    assert(!f.text().includes('离线作者')); assert(!f.text().includes('页面文案'));
    assert.equal(f.button('下一个').disabled, true);
    assert.equal(f.calls.filter(row => row.route === 'social/browse').length, calls);
  }
});

test('preview scope change invalidates a waiting old browse result without an implicit history read', async () => {
  const f = previewFixture(); await f.flush(); await f.click('打开推荐');
  let release; f.hold(new Promise(resolve => release = resolve)); await f.click('读取当前');
  f.snapshot.platforms[0].accountId = 'new-account'; f.snapshot.platforms[0].generation = 2;
  f.ids.get('refresh').listeners.get('click')(); await f.flush();
  assert(!f.text().includes('离线作者'));
  release(); await f.flush();
  assert(!f.text().includes('离线作者')); assert.equal(f.button('下一个').disabled, true);
  assert(!f.calls.some(row => row.payload?.request?.action === 'history'));
});

test('preview unknown reads and failed stops show a state to review instead of claiming active browsing', async () => {
  const f = previewFixture(); await f.flush(); await f.click('打开推荐');
  f.fail('BROWSER_UNKNOWN'); await f.click('读取当前');
  assert(f.text().includes('浏览状态待核对')); assert(!f.text().includes('本次浏览已打开'));
  assert.equal(f.button('下一个').disabled, true);
  await f.click('打开推荐'); f.fail('CLEANUP_UNCONFIRMED'); await f.click('停止');
  assert(f.text().includes('浏览状态待核对')); assert(!f.text().includes('本次浏览已打开'));
  assert(!f.ids.get('message').textContent.includes('浏览已停止'));
});

test('preview native-login-unavailable snapshot disables start and check without issuing either request', async () => {
  const f = previewFixture(); await f.flush();
  Object.assign(f.snapshot.platforms[0], { loginAvailable: false, loginMethod: 'qr', loginSession: 'fixture-session' });
  f.ids.get('refresh').listeners.get('click')(); await f.flush();
  for (const label of ['打开扫码登录', '检查登录']) {
    const button = f.platformButton(label); assert.equal(button.disabled, true); button.listeners.get('click')();
  }
  await f.flush(); assert(f.allText().includes('复用已在 Ego 登录的账号'));
  assert(!f.calls.some(row => row.route === 'social/login/start' || row.route === 'social/login/check'));
});

test('preview executor recovery requires a fresh checkbox and posts the reviewed revision with both confirmations', async () => {
  const f = previewFixture(); await f.flush(); f.snapshot.platforms[0].cleanupRequired = true;
  f.ids.get('refresh').listeners.get('click')(); await f.flush();
  const recover = f.platformButton('解除执行器保护'); assert.equal(recover.disabled, true);
  recover.listeners.get('click')(); await f.flush();
  assert(!f.calls.some(row => row.route === 'social/recover-executor'));
  const checked = f.recoveryCheckbox(); checked.checked = true; checked.listeners.get('change')();
  assert.equal(recover.disabled, false); const revision = f.snapshot.revision;
  recover.listeners.get('click')(); await f.flush();
  const requests = f.calls.filter(row => row.route === 'social/recover-executor'); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].payload, { platform: 'douyin', revision, executionStopped: true, resultReviewed: true });
  assert(f.ids.get('message').textContent.includes('原操作没有重跑'));
  assert(!f.calls.some(row => ['social/execute', 'social/login/start', 'social/browse'].includes(row.route)));
});

test('preview refresh invalidates an old recovery confirmation and detached button handler', async () => {
  const f = previewFixture(); await f.flush(); f.snapshot.platforms[0].cleanupRequired = true;
  f.ids.get('refresh').listeners.get('click')(); await f.flush();
  const firstCheck = f.recoveryCheckbox(); firstCheck.checked = true; firstCheck.listeners.get('change')();
  f.ids.get('refresh').listeners.get('click')(); await f.flush();
  assert.equal(Boolean(f.recoveryCheckbox().checked), false); assert.equal(f.platformButton('解除执行器保护').disabled, true);
  assert(!f.calls.some(row => row.route === 'social/recover-executor'));
  const old = f.platformButton('解除执行器保护'), checked = f.recoveryCheckbox(); checked.checked = true; checked.listeners.get('change')();
  assert.equal(old.disabled, false);
  f.snapshot.revision = 'replacement-revision'; f.ids.get('refresh').listeners.get('click')(); await f.flush();
  assert.equal(Boolean(f.recoveryCheckbox().checked), false); assert.equal(f.platformButton('解除执行器保护').disabled, true);
  old.listeners.get('click')(); await f.flush();
  assert(!f.calls.some(row => row.route === 'social/recover-executor')); assert(f.ids.get('message').textContent.includes('状态已变化'));
});

test('preview failed recovery remains protected and never claims a platform result succeeded', async () => {
  const f = previewFixture(); await f.flush(); f.snapshot.platforms[0].cleanupRequired = true;
  f.ids.get('refresh').listeners.get('click')(); await f.flush();
  const checked = f.recoveryCheckbox(); checked.checked = true; checked.listeners.get('change')();
  f.failRoute('social/recover-executor', 'CLEANUP_UNCONFIRMED'); f.platformButton('解除执行器保护').listeners.get('click')(); await f.flush();
  assert.equal(f.calls.filter(row => row.route === 'social/recover-executor').length, 1);
  assert.equal(f.snapshot.platforms[0].cleanupRequired, true); assert(f.ids.get('message').textContent.includes('CLEANUP_UNCONFIRMED'));
  assert(!f.ids.get('message').textContent.includes('解除保护')); assert(!f.allText().includes('平台已返回编号'));
});
