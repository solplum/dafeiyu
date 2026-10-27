import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { SocialAccounts } from '../packages/dsh-dafeiyu/src/social/accounts.mjs';
import { socialAccountRoute } from '../packages/dsh-dafeiyu/src/social/account-routes.mjs';
import { digest } from '../packages/dsh-dafeiyu/src/social/account-store.mjs';

const shipped = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
assert.equal(shipped.split('() => h(Panel),').length, 2);
const source = shipped.replace('() => h(Panel),', '() => h(PlatformAccountsPanel, { active: window.__active }),');

// The actual shipped component is rendered; browser/network/QQ are fixtures.
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dfy-account-ui-")); let writes = 0, reads = 0, checks = 0, uncertain = false, forbidden = false, browseCalls = [], browseFailure, browseStopGate, browseState = 'stopped', browseVideoId = '1234567890123456789';
  let browser = null;
  const driver = { browseStatus: () => ({ state: browseState }), async checkBrowser() { checks++; browser = { configured: true, ready: true, state: 'ready', reason: null, checkedAt: '2026-10-27T00:00:00Z', expiresAt: '2026-10-27T00:01:00Z' }; return browser; }, nextAvailable: true, capabilities: () => ({profile:"implemented-not-verified",comment:"implemented-not-verified"}),
    async startLogin(){return {image:{mime:"image/png",base64:"iVBORw0KGgo="}};},
    async checkLogin(){return {loggedIn:true,accountId:"123",name:"fixture"};},
    async account(){return {loggedIn:true,accountId:"123",name:"fixture"};},
    async closeLogin(){}, async preflight(){},
    async browse(request, context) {
      browseCalls.push(request);
      if (request.action === 'stop' && browseStopGate) await browseStopGate;
      if (!context.authorize()) throw Object.assign(Error('denied'), { code: 'FORBIDDEN' });
      if (browseFailure) { const code = browseFailure; browseFailure = undefined; throw Object.assign(Error(code), { code }); }
      browseState = request.action === 'stop' ? 'stopped' : 'active';
      if (browser?.lifecycle !== undefined) browser = { ...browser, lifecycle: request.action === 'stop' ? 'closed' : 'active',
        state: request.action === 'stop' ? 'ready-to-start' : 'ready', ready: true, canStartNewActivity: request.action === 'stop', activityReady: request.action !== 'stop' };
      const current = { platformVideoId: browseVideoId, id: 'media-' + (request.action === 'next' ? 'b' : 'a').repeat(64), url: 'https://www.douyin.com/', author: '离线作者', description: '离线视频页面文字', media: { muted: true, paused: true, currentTime: 2, duration: 30 } };
      return { ok: true, action: request.action, accountId: '123', state: request.action === 'stop' ? 'stopped' : 'active', current: request.action === 'stop' ? null : current, history: request.action === 'stop' ? [] : [current] };
    },
    async read(){reads++;return {ok:true,accountId:"123",items:[]};},
    async execute(request, context){writes++;if(uncertain)throw Error("unknown");return {ok:true,id:"receipt-1",accountId:"123",operation:request.operation,operationId:context.operationId,target:request.target||"",parentId:request.parentId||"",contentDigest:digest(request)};} };
  const manager = new SocialAccounts({directory,requestPolicy:null,drivers:{bilibili:driver,douyin:driver,x:driver}});
  t.after(async()=>{await manager.dispose();fs.rmSync(directory,{recursive:true,force:true});});
  let component, hookIndex, rootRender, tree, dirty = false, effects = [], timerId = 0, serial = 0, gate, readGate, failure;
  let testResult = { ok: true, bvid: 'BV1ab411c7de', title: '公开测试视频', url: 'https://www.bilibili.com/video/BV1ab411c7de/', kind: 'video-detail', note: '已读取公开标题' };
  const instances = new Map(), calls = [], timers = new Map();
  const social = { bilibili: { browse: { configured: true, enabled: true, readiness: 'not-verified', lastCheck: null, lastResult: null }, account: { configured: false }, publication: { state: 'prepared-not-connected' } },
    douyin: { browse: { configured: true, enabled: true, readiness: 'not-verified' }, account: { configured: false }, publication: { state: 'prepared-not-connected' } }, busy: false };
  const React = {
    Fragment: Symbol('fragment'), createElement(type, props, ...children) { return { type, props: { ...(props || {}), children: children.flat(Infinity) } }; },
    useState(initial) {
      const instance = component, index = hookIndex++, hook = instance.hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      hook.set ||= (next) => { const value = typeof next === 'function' ? next(hook.value) : next;
        if (!Object.is(value, hook.value)) { hook.value = value; dirty = true; } };
      return [hook.value, hook.set];
    },
    useRef(initial) { return component.hooks[hookIndex++] ||= { current: initial }; },
    useEffect(effect, deps) {
      const instance = component, index = hookIndex++, old = instance.hooks[index];
      if (!old || !deps || deps.some((value, at) => !Object.is(value, old.deps?.[at]))) {
        instance.hooks[index] = { deps, cleanup: old?.cleanup };
        effects.push(() => { old?.cleanup?.(); instance.hooks[index].cleanup = effect(); });
      }
    },
  };
  const host = { __active: true, __ModuleLoader__: { load({ factory }) {
    factory((name) => { assert.equal(name, 'react'); return React; }).apply({ slots: { inject(_name, callback) { callback(); }, register(_definition, render) { rootRender = render; } } });
  } } };
  vm.runInNewContext(source, { window: host, document: {}, AbortController, URL, URLSearchParams, TextEncoder, Date, Math,
    crypto: { randomUUID: () => '12345678-1234-4234-8234-' + (++serial).toString().padStart(12, '0') },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => {
      const route = url.split('/api/')[1], method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ route, method, payload }); let value;
      try { value = await socialAccountRoute(route, manager, payload || {}, { authorize: () => !forbidden }); }
      catch(error) { value={ok:false,code:error.code,error:error.code||'未确认'}; }
      return { ok: true, status: 200, json: async () => structuredClone(value) };
    },
  });
  function render(node, location = 'root') {
    if (node == null || node === false) return null;
    if (typeof node !== 'object') return String(node);
    if (typeof node.type === 'function') {
      const key = location + ':' + node.type.name, instance = instances.get(key) || { hooks: [] }; instances.set(key, instance);
      const previous = component; component = instance; hookIndex = 0; const child = node.type(node.props); component = previous;
      return render(child, location + 'f');
    }
    return { ...node, props: { ...node.props, children: node.props.children.map((child, at) => render(child, location + '.' + (child?.props?.key ?? at))) } };
  }
  async function flush() {
    for (let attempt = 0; attempt < 30; attempt++) {
      dirty = false; tree = render(rootRender()); const pending = effects; effects = []; pending.forEach((effect) => effect());
      await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve));
      if (!dirty && !effects.length) return;
    }
    assert.fail('Social UI did not settle');
  }
  const nodes = (node = tree) => !node || typeof node !== 'object' || node.props.hidden ? [] : [node, ...node.props.children.flatMap((child) => nodes(child))];
  const text = (node = tree) => typeof node === 'string' ? node : node?.props?.hidden ? '' : node?.props?.children.map((child) => text(child)).join('') || '';
  const button = (label) => nodes().find((node) => node.type === 'button' && text(node) === label);
  const article = (label) => nodes().find((node) => node.type === 'article' && node.props['aria-label'] === label + '连接状态');
  async function click(label) { const node = button(label) || nodes().find(node => node.type === 'summary' && text(node) === label); assert(node, 'Missing button: ' + label); assert.equal(Boolean(node.props.disabled), false); node.props.onClick(); await flush(); }
  return { manager, browseCalls, get checks() { return checks; }, setBrowser(value) { browser = value; driver.runtime = { backend: 'native-ego', status: () => ({ configured: browser.configured, nativeReady: browser.activityReady === undefined ? browser.ready : browser.activityReady, lifecycle: browser.lifecycle, canStartNewActivity: browser.canStartNewActivity, activityReady: browser.activityReady, metadata: browser }) }; }, holdStop(value) { browseStopGate = value; }, videoId(value) { browseVideoId = value; }, failBrowse(code) { browseFailure = code; }, get writes(){return writes;}, get reads(){return reads;}, uncertain(){uncertain=true;}, revoke(){forbidden=true;}, social, calls, timers, nodes, text, button, article, click, flush,
    setGate(value) { gate = value; }, setReadGate(value) { readGate = value; }, result(value) { testResult = value; }, error(value) { failure = value; },
    async active(value) { host.__active = value; await flush(); },
    dispose() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); },
  };
}


async function bind(f) {
  await f.click('打开扫码登录'); await f.click('检查登录'); await f.click('确认这是大肥鱼的账号');
}
async function draft(f) {
  await f.click('准备本地草稿');
  const input = f.nodes().find(node => node.type === 'input' && node.props.value === '');
  // The reader controls precede the compose controls: address fields by their labels.
  const targetLabel=f.nodes().find(node=>node.type==='label'&&f.text(node)==='对象');
  const target=f.nodes(targetLabel).find(node=>node.type==='input'); target.props.onChange({target:{value:'exact-video'}});
  const body=f.nodes().find(node=>node.type==='textarea'); body.props.onChange({target:{value:'exact comment'}}); await f.flush();
  await f.click('仅准备草稿');
}

test('native account panel reads only metadata, shows three platforms and never starts login implicitly', async t => {
  const f=fixture(t);t.after(()=>f.dispose());await f.flush();
  assert.deepEqual(f.calls.map(row=>row.route),['social/accounts']);assert.equal(f.writes,0);assert.equal(f.reads,0);
  for(const name of ['B站','抖音','X'])assert(f.text().includes(name));
  assert.equal(f.manager.snapshot().platforms.every(row=>row.state==='disconnected'),true);
});

test('native login renders QR, requires candidate confirmation and submits exact approved content once',async t=>{
  const f=fixture(t);t.after(()=>f.dispose());await f.flush();await bind(f);
  assert.equal(f.manager.snapshot().platforms[0].state,'bound');assert.equal(f.writes,0);
  await draft(f);assert.equal(f.writes,0);const prepared=f.manager.snapshot().operations[0];assert.equal(prepared.text,'exact comment');
  await f.click('确认内容并执行');assert.equal(f.writes,1);assert(f.text().includes('receipt-1'));
  assert.equal(f.button('确认内容并执行'),undefined);assert.equal(f.manager.snapshot().operations[0].state,'sent');
});

test('native unknown receipt stays protected and does not offer automatic replay; GET refresh remains passive',async t=>{
  const f=fixture(t);t.after(()=>f.dispose());await f.flush();await bind(f);await draft(f);f.uncertain();
  await f.click('确认内容并执行');assert.equal(f.writes,1);assert.equal(f.manager.snapshot().operations[0].state,'unknown');
  assert.equal(f.button('确认内容并执行'),undefined);assert.equal(f.button('按上述确认解除保护').props.disabled,true);
  await f.click('刷新账号状态');assert.equal(f.writes,1);assert.equal(f.reads,0);
});

test('native owner error is visible and does not start a platform action',async t=>{
  const f=fixture(t);t.after(()=>f.dispose());await f.flush();f.revoke();await f.click('打开扫码登录');
  assert(f.text().includes('FORBIDDEN'));assert.equal(f.writes,0);assert.equal(f.manager.snapshot().platforms[0].state,'disconnected');
});

test('native browse stays passive, binds next to the current observation and keeps stop available during a platform pause', async t => {
  const f = fixture(t); t.after(() => f.dispose()); await f.flush();
  assert.equal(f.browseCalls.length, 0); assert.equal(f.button('下一个').props.disabled, true);
  assert.equal(f.button('打开推荐').props.disabled, true);
  const ctx = { authorize: () => true }, sessionId = '12345678-1234-4234-8234-123456789012';
  await f.manager.startLogin({ platform: 'douyin', requestId: sessionId, revision: f.manager.snapshot().revision }, ctx);
  await f.manager.checkLogin({ platform: 'douyin', sessionId }, ctx);
  await f.manager.confirmAccount({ platform: 'douyin', accountId: '123', revision: f.manager.snapshot().revision }, ctx);
  await f.click('刷新账号状态'); assert.equal(f.browseCalls.length, 0);
  await f.click('打开推荐'); assert.deepEqual(f.browseCalls.at(-1), { action: 'open' });
  assert(f.text().includes('离线视频页面文字')); assert(f.text().includes('不代表已理解视频画面'));
  assert(!f.text().includes('media-')); assert(f.text().includes('页面播放器静音：已确认'));
  await f.click('下一个'); assert.equal(f.browseCalls.at(-1).expectedVideoId, 'media-' + 'a'.repeat(64));
  await f.click('查看有限历史'); assert.equal(f.browseCalls.at(-1).action, 'history');
  f.manager.holdPlatform({ platform: 'douyin', revision: f.manager.snapshot().revision, reason: 'owner-paused' }, ctx);
  await f.click('刷新账号状态'); assert.equal(f.button('打开推荐').props.disabled, true); assert.equal(f.button('读取当前').props.disabled, true);
  assert.equal(f.button('停止').props.disabled, false); assert.equal(f.button('查看有限历史').props.disabled, false);
  await f.click('停止'); assert.equal(f.browseCalls.at(-1).action, 'stop'); assert(f.text().includes('当前未在浏览。'));
  assert.equal(f.button('下一个').props.disabled, true); assert.equal(f.writes, 0);
});

test('native next needs verified capability and a stable current video ID; stale handlers cannot submit', async t => {
  for (const videoId of [undefined, null, '', 'blob:fixture', '123', '12345678901234567890123456', '1234567890123456789\n']) {
    const f = fixture(t); t.after(() => f.dispose()); await f.flush(); f.videoId(videoId);
    f.manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: '123', name: 'fixture', generation: 1 }; }, { authorize: () => true });
    await f.click('刷新账号状态'); await f.click('打开推荐');
    assert.equal(f.button('下一个').props.disabled, true);
    const before = f.browseCalls.length; f.button('下一个').props.onClick(); await f.flush();
    assert.equal(f.browseCalls.length, before); assert(f.text().includes('切换视频仍待验证'));
  }
  const f = fixture(t); t.after(() => f.dispose()); await f.flush();
  f.manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: '123', name: 'fixture', generation: 1 }; }, { authorize: () => true });
  await f.click('刷新账号状态'); await f.click('打开推荐');
  const stale = f.button('下一个'); assert.equal(stale.props.disabled, false);
  f.manager.drivers.douyin.nextAvailable = false; await f.click('刷新账号状态');
  assert.equal(f.manager.snapshot().platforms.some(row => row.nextAvailable), false);
  assert.equal(f.button('下一个').props.disabled, true);
  const before = f.browseCalls.length; stale.props.onClick(); await f.flush();
  assert.equal(f.browseCalls.length, before); assert(f.text().includes('切换视频仍待验证'));
});

test('native stale next handler rechecks pause, cleanup and stop-in-progress before any POST', async t => {
  for (const change of [{ safetyPause: { reason: 'owner-paused' } }, { cleanupRequired: true }, { blocked: true }, { busy: true }, { driverAvailable: false }]) {
    const f = fixture(t); t.after(() => f.dispose()); await f.flush();
    f.manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: '123', name: 'fixture', generation: 1 }; }, { authorize: () => true });
    await f.click('刷新账号状态'); await f.click('打开推荐'); const stale = f.button('下一个');
    const snapshot = f.manager.snapshot.bind(f.manager);
    f.manager.snapshot = () => { const value = snapshot(); Object.assign(value.platforms.find(row => row.platform === 'douyin'), change); return value; };
    await f.click('刷新账号状态'); assert.equal(f.button('下一个').props.disabled, true);
    const before = f.calls.filter(row => row.route === 'social/browse').length;
    stale.props.onClick(); await f.flush(); assert.equal(f.calls.filter(row => row.route === 'social/browse').length, before);
  }
  const f = fixture(t); t.after(() => f.dispose()); await f.flush();
  f.manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: '123', name: 'fixture', generation: 1 }; }, { authorize: () => true });
  await f.click('刷新账号状态'); await f.click('打开推荐'); const stale = f.button('下一个');
  let release; f.holdStop(new Promise(resolve => release = resolve));
  f.button('停止').props.onClick(); await f.flush();
  const before = f.calls.filter(row => row.route === 'social/browse').length;
  stale.props.onClick(); await f.flush(); assert.equal(f.calls.filter(row => row.route === 'social/browse').length, before);
  release(); await f.flush(); assert(f.text().includes('当前未在浏览。'));
});

test('native account refresh clears old browse content when account, generation or binding state changes', async t => {
  for (const change of [{ accountId: 'different-account' }, { generation: 2 }, { state: 'candidate' }]) {
    const f = fixture(t); t.after(() => f.dispose()); await f.flush();
    f.manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: '123', name: 'fixture', generation: 1 }; }, { authorize: () => true });
    await f.click('刷新账号状态'); await f.click('打开推荐'); assert(f.text().includes('离线视频页面文字'));
    const before = f.browseCalls.length;
    f.manager.store.transact(state => Object.assign(state.accounts.douyin, change), { authorize: () => true });
    await f.click('刷新账号状态');
    assert(!f.text().includes('离线视频页面文字')); assert(!f.text().includes('离线作者'));
    assert.equal(f.button('下一个').props.disabled, true); assert.equal(f.browseCalls.length, before);
  }
});

test('native unknown reads and failed stops retain a review state and never claim a stopped browser', async t => {
  const f = fixture(t); t.after(() => f.dispose()); await f.flush();
  f.manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: '123', name: 'fixture', generation: 1 }; }, { authorize: () => true });
  await f.click('刷新账号状态'); await f.click('打开推荐');
  f.failBrowse('BROWSER_UNKNOWN'); await f.click('读取当前');
  assert(f.text().includes('浏览状态待核对')); assert(!f.text().includes('本次浏览已打开'));
  assert.equal(f.button('下一个').props.disabled, true);
  await f.click('打开推荐'); f.failBrowse('CLEANUP_UNCONFIRMED'); await f.click('停止');
  assert(f.text().includes('浏览状态待核对')); assert(!f.text().includes('本次浏览已打开'));
  assert(!f.text().includes('本次浏览已停止，登录资料保留。'));
});

const nativeAccountCard = f => f.nodes().find(node => node.type === 'article' && node.props['aria-label'] === '抖音账号');
const nativeAccountButton = (f, label) => f.nodes(nativeAccountCard(f)).find(node => node.type === 'button' && f.text(node) === label);
const nativeRecoveryCheckbox = f => { const label = f.nodes(nativeAccountCard(f)).find(node => node.type === 'label' && f.text(node).includes('已确认旧执行器停止并核对平台结果'));
  return label && f.nodes(label).find(node => node.type === 'input' && node.props.type === 'checkbox'); };
async function protectedNativeFixture(f) {
  f.manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: '123', name: 'fixture', generation: 1 }; }, { authorize: () => true });
  const directory = f.manager.store.privateDirectory('douyin'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.runtime-lock'), JSON.stringify({ pid: process.pid, token: '12345678-1234-4234-8234-123456789012' }));
  await f.click('刷新账号状态');
}

test('native login unavailable disables start and check while preserving the existing account without requests', async t => {
  const f = fixture(t); t.after(() => f.dispose()); f.manager.drivers.douyin.loginAvailable = false;
  f.manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: '123', name: 'fixture', generation: 1,
    loginSession: '12345678-1234-4234-8234-123456789012' }; }, { authorize: () => true });
  await f.flush();
  assert.equal(nativeAccountButton(f, '打开扫码登录').props.disabled, true);
  assert.equal(nativeAccountButton(f, '检查登录').props.disabled, true);
  assert(f.text(nativeAccountCard(f)).includes('复用已在 Ego 登录的账号'));
  await f.click('刷新账号状态');
  assert(!f.calls.some(row => row.route === 'social/login/start' || row.route === 'social/login/check'));
  assert.equal(f.manager.snapshot().platforms.find(row => row.platform === 'douyin').accountId, '123');
});

test('native executor recovery is passive until checked and posts exactly the reviewed revision and confirmations', async t => {
  const f = fixture(t); t.after(() => f.dispose()); await f.flush(); await protectedNativeFixture(f);
  assert.equal(nativeAccountButton(f, '解除执行器保护').props.disabled, true);
  assert(!f.calls.some(row => row.route === 'social/recover-executor'));
  nativeRecoveryCheckbox(f).props.onChange({ target: { checked: true } }); await f.flush();
  assert.equal(nativeAccountButton(f, '解除执行器保护').props.disabled, false);
  assert(!f.calls.some(row => row.route === 'social/recover-executor'));
  const revision = f.manager.snapshot().revision;
  await f.click('解除执行器保护');
  const requests = f.calls.filter(row => row.route === 'social/recover-executor'); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].payload, { platform: 'douyin', revision, executionStopped: true, resultReviewed: true });
  assert.equal(f.manager.snapshot().platforms.find(row => row.platform === 'douyin').cleanupRequired, false);
  assert(f.text().includes('没有重跑')); assert.equal(f.writes, 0); assert.equal(f.browseCalls.length, 0);
  assert(!f.text().includes('平台已返回编号'));
});

test('native account revision changes revoke a checked recovery and reject its stale enabled handler', async t => {
  const f = fixture(t); t.after(() => f.dispose()); await f.flush(); await protectedNativeFixture(f);
  nativeRecoveryCheckbox(f).props.onChange({ target: { checked: true } }); await f.flush();
  const old = nativeAccountButton(f, '解除执行器保护'); assert.equal(old.props.disabled, false);
  f.manager.store.transact(state => { state.accounts.douyin.generation++; }, { authorize: () => true });
  await f.click('刷新账号状态');
  assert.equal(nativeRecoveryCheckbox(f).props.checked, false); assert.equal(nativeAccountButton(f, '解除执行器保护').props.disabled, true);
  old.props.onClick(); await f.flush();
  assert(!f.calls.some(row => row.route === 'social/recover-executor')); assert(f.text().includes('状态已变化'));
});

test('native failed recovery preserves the protection and never promotes unknown results to platform success', async t => {
  const f = fixture(t); t.after(() => f.dispose()); await f.flush(); await protectedNativeFixture(f);
  f.manager.recoverExecutor = async () => { throw Object.assign(Error('CLEANUP_UNCONFIRMED'), { code: 'CLEANUP_UNCONFIRMED' }); };
  nativeRecoveryCheckbox(f).props.onChange({ target: { checked: true } }); await f.flush();
  await f.click('解除执行器保护');
  assert.equal(f.calls.filter(row => row.route === 'social/recover-executor').length, 1);
  assert.equal(f.manager.snapshot().platforms.find(row => row.platform === 'douyin').cleanupRequired, true);
  assert(f.text().includes('CLEANUP_UNCONFIRMED')); assert(!f.text().includes('已按明确确认解除保护，没有重跑。'));
  assert(!f.text().includes('平台已返回编号')); assert.equal(f.writes, 0);
});


test('native browser configuration is not current availability and metadata verification is explicit', async t => {
  const f = fixture(t); t.after(() => f.dispose()); await f.flush();
  const ctx = { authorize: () => true };
  f.manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: '123', name: 'fixture', generation: 1 }; }, { authorize: () => true });
  f.setBrowser({ configured: true, ready: false, state: 'not-checked', checkedAt: null, expiresAt: null });
  await f.click('刷新账号状态');
  assert.equal(f.button('打开推荐').props.disabled, true); assert.equal(f.checks, 0); assert.equal(f.browseCalls.length, 0);
  assert(f.text().includes('当前 Ego 空间尚未核验'));
  await f.click('核验 Ego 浏览环境'); assert.equal(f.checks, 1); assert.equal(f.browseCalls.length, 0);
  assert.equal(f.calls.filter(row => row.route === 'social/check-browser').length, 1);
  assert.equal(f.button('打开推荐').props.disabled, false); assert(f.text().includes('没有访问平台页面'));
  const expiry = [...f.timers.values()].at(-1); assert(expiry); expiry.fn(); await f.flush();
  assert.equal(f.checks, 1); assert.equal(f.button('打开推荐').props.disabled, true);
  assert(f.text().includes('这不代表账号已退出')); assert(f.text().includes('已绑定'));
  assert.equal(f.button('停止').props.disabled, false); assert.equal(f.button('查看有限历史').props.disabled, false);
  const stale = f.button('核验 Ego 浏览环境');
  f.manager.holdPlatform({ platform: 'douyin', revision: f.manager.snapshot().revision, reason: 'owner-paused' }, ctx);
  await f.click('刷新账号状态'); assert.equal(f.button('核验 Ego 浏览环境').props.disabled, true);
  stale.props.onClick(); await f.flush(); assert.equal(f.checks, 1);
});


test('closed background browser entry opens one new activity while current and next require an active task', async t => {
  const f = fixture(t); t.after(() => f.dispose()); await f.flush();
  f.manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: '123', generation: 1 }; }, { authorize: () => true });
  f.setBrowser({ configured: true, ready: true, state: 'ready-to-start', lifecycle: 'closed', canStartNewActivity: true, activityReady: false,
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });
  await f.click('刷新账号状态');
  assert.equal(f.button('打开推荐').props.disabled, false); assert.equal(f.button('读取当前').props.disabled, true); assert.equal(f.button('下一个').props.disabled, true);
  assert(f.text().includes('后台浏览入口已核验')); assert(f.text().includes('登录资料保留')); assert(!f.text().includes('最近已核验 Ego 浏览空间'));
  await f.button('读取当前').props.onClick(); await f.flush(); assert.equal(f.browseCalls.length, 0, 'a stale current handler cannot create a background activity');
  await f.click('打开推荐'); assert.equal(f.browseCalls.length, 1); assert.equal(f.button('读取当前').props.disabled, false); assert.equal(f.button('下一个').props.disabled, false);
  const staleOpen = f.button('打开推荐'), expiry = [...f.timers.values()].at(-1); expiry.fn(); await f.flush();
  assert.equal(f.button('打开推荐').props.disabled, true); assert.equal(f.button('读取当前').props.disabled, true); assert.equal(f.button('下一个').props.disabled, true);
  await staleOpen.props.onClick(); await f.flush(); assert.equal(f.browseCalls.length, 1, 'expired admission does not dispatch another open');
  assert.equal(f.button('停止').props.disabled, false); await f.click('停止');
  assert.equal(f.browseCalls.at(-1).action, 'stop'); assert(f.text().includes('本次浏览已结束，登录资料保留'));
  assert.equal(f.button('打开推荐').props.disabled, false); assert.equal(f.button('读取当前').props.disabled, true);
});
