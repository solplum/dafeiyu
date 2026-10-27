import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shipped = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
assert.equal(shipped.split('() => h(Panel),').length, 2);
const source = shipped.replace('() => h(Panel),', '() => h(VideoPlatformsPanel, { active: window.__active }),');

// The actual shipped component is rendered; browser/network/QQ are fixtures.
function fixture() {
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
      if (route === 'social/status') { value = { ok: true, social: structuredClone(social) }; if (readGate) await readGate; }
      else if (route === 'social/check') { if (gate) await gate; value = failure || { ok: true, test: testResult, social }; }
      else assert.fail('Unexpected API: ' + route);
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
  async function click(label) { const node = button(label); assert(node, 'Missing button: ' + label); assert.equal(Boolean(node.props.disabled), false); node.props.onClick(); await flush(); }
  return { social, calls, timers, nodes, text, button, article, click, flush,
    setGate(value) { gate = value; }, setReadGate(value) { readGate = value; }, result(value) { testResult = value; }, error(value) { failure = value; },
    async active(value) { host.__active = value; await flush(); },
    dispose() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); },
  };
}

test('video platforms is a settings subtab and preserves consumer/life navigation mappings', () => {
  assert.match(shipped, /\['social', '视频平台'\]/);
  assert.match(shipped, /const settingTabs = \[[^\]]*'social'/);
  assert.match(shipped, /key === 'social' \? h\(VideoPlatformsPanel, \{ active: tab === 'social' \}\)/);
  assert.match(shipped, /const everydayTabs = \['overview', 'capabilities', 'background', 'memes', 'memory', 'life'\]/);
});

test('opening reads only snapshots and shows two separate three-state cards with explanations collapsed', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  assert.deepEqual(f.calls, [{ route: 'social/status', method: 'GET', payload: undefined }]);
  for (const platform of ['B站', '抖音']) for (const title of ['浏览状态', '独立账号', '发布准备', '待绑定独立账号']) assert.ok(f.text(f.article(platform)).includes(title), platform + title);
  assert.equal(f.nodes().filter((node) => node.type === 'article').length, 2);
  assert.equal(f.text().includes('prepared-not-connected'), false); assert.equal(f.text().includes('浏览组件'), false);
  assert.equal(f.nodes().filter((node) => node.type === 'button' && f.text(node) === '检查浏览').length, 1);
  assert.equal(f.nodes().filter((node) => node.type === 'button' && f.text(node) === '检查抖音浏览').length, 1);
  assert.equal(f.nodes().some((node) => node.type === 'button' && /登录|上传|发布/.test(f.text(node))), false);
  await f.click('刷新状态'); assert.equal(f.calls.filter((call) => call.route === 'social/status').length, 2);
  assert.equal(f.calls.some((call) => call.method === 'POST'), false);
});

test('explicit Bilibili browse check uses one UUID, no account requirement and 180 second timeout', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); let release;
  f.setGate(new Promise((resolve) => { release = resolve; })); const run = f.button('检查浏览').props.onClick; run(); run(); await f.flush();
  assert.deepEqual(f.calls.filter((call) => call.method === 'POST'), [{ route: 'social/check', method: 'POST', payload: { platform: 'bilibili', requestId: '12345678-1234-4234-8234-000000000001' } }]);
  assert.equal([...f.timers.values()].some((item) => item.ms === 180000), true);
  assert.equal(f.button('检查浏览中…').props.disabled, true); release(); await f.flush();
  assert.ok(f.text().includes('公开浏览检查通过')); assert.ok(f.text().includes('公开测试视频'));
  assert.equal(f.nodes().find((node) => node.type === 'a').props.href, 'https://www.bilibili.com/video/BV1ab411c7de/');
  assert.equal(f.text().includes('待绑定独立账号'), true);
});

for (const state of ['server busy', 'missing', 'disabled']) test('browse check refuses ' + state + ' in button and handler', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  if (state === 'server busy') f.social.busy = true;
  else if (state === 'missing') f.social.bilibili.browse.configured = false;
  else f.social.bilibili.browse.enabled = false;
  await f.flush(); assert.equal(f.button('检查浏览').props.disabled, true); f.button('检查浏览').props.onClick(); await f.flush();
  assert.equal(f.calls.some((call) => call.method === 'POST'), false);
});

test('an explicit failed check stays failed without retry or successful video link', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.result({ ok: false, note: '公开内容暂未返回', url: 'javascript:alert(1)' });
  await f.flush(); await f.click('检查浏览'); assert.ok(f.text().includes('公开浏览尚未通过')); assert.ok(f.text().includes('公开内容暂未返回'));
  assert.equal(f.text().includes('公开浏览检查通过'), false); assert.equal(f.nodes().some((node) => node.type === 'a'), false);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('malformed success cannot claim verification and raw error details remain hidden', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.result({ ok: true, bvid: 'not-an-id', title: '<script>ignored</script>', url: 'https://attacker.test/' });
  await f.flush(); await f.click('检查浏览'); assert.equal(f.text().includes('公开浏览检查通过'), false); assert.equal(f.nodes().some((node) => node.type === 'a'), false);
  f.error({ ok: false, error: 'PRIVATE_RAW_ERROR /Users/private/token' }); await f.click('检查浏览');
  assert.doesNotMatch(f.text(), /PRIVATE_RAW_ERROR|Users\/private/); assert.equal(f.calls.filter((call) => call.method === 'POST').length, 2);
});

test('hidden page ignores a late check result and rejects a stale handler without another POST', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); let release;
  f.setGate(new Promise((resolve) => { release = resolve; })); const stale = f.button('检查浏览').props.onClick; stale(); await f.flush();
  await f.active(false); release(); await f.flush(); stale(); await f.flush();
  assert.equal(f.text().includes('公开浏览检查通过'), false); assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('advanced statuses and result text stay inert and never add platform write controls', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.social.douyin.publication.state = 'unknown'; f.social.bilibili.browse.readiness = 'failed';
  await f.flush(); assert.ok(f.text(f.article('抖音')).includes('结果待核对')); assert.ok(f.text(f.article('B站')).includes('需要处理'));
  const summary = f.nodes(f.article('B站')).find((node) => node.type === 'summary'); summary.props.onClick({ preventDefault() {} }); await f.flush();
  assert.ok(f.text(f.article('B站')).includes('浏览组件：已接入')); assert.ok(f.text(f.article('B站')).includes('prepared-not-connected'));
  f.result({ ok: true, bvid: 'BV1ab411c7de', title: '<script>do not run</script>', url: 'https://www.bilibili.com/video/BV1ab411c7de/' }); await f.click('检查浏览');
  assert.ok(f.text().includes('<script>do not run</script>')); assert.equal(f.nodes().some((node) => node.type === 'script' || node.props.dangerouslySetInnerHTML), false);
});

test('actual BiliBrowser read-verified readiness and object check timestamps display correctly', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.social.bilibili.browse.readiness = 'read-verified';
  f.social.bilibili.browse.lastCheck = { ok: true, at: '2026-10-25T01:02:03.000Z', toolCount: 7 };
  await f.flush(); assert.ok(f.text(f.article('B站')).includes('检查通过')); assert.equal(f.calls.some((call) => call.method === 'POST'), false);
  const summary = f.nodes(f.article('B站')).find((node) => node.type === 'summary'); summary.props.onClick({ preventDefault() {} }); await f.flush();
  assert.doesNotMatch(f.text(f.article('B站')), /Invalid Date|\[object Object\]/);
  const timestamp = new Date('2026-10-25T01:02:03.000Z').toLocaleString(); assert.ok(f.text(f.article('B站')).includes(timestamp));
});

for (const [readiness, label] of [['needs-login', '需要登录独立账号'], ['verification-required', '需要账号验证'], ['cleanup-unconfirmed', '结果待核对']]) {
  test('Douyin ' + readiness + ' is displayed honestly without claiming a successful browse', async (t) => {
    const f = fixture(); t.after(() => f.dispose()); f.social.douyin.browse.readiness = readiness;
    f.social.douyin.browse.lastResult = { ok: false, state: readiness };
    await f.flush(); assert.ok(f.text(f.article('抖音')).includes(label));
    assert.equal(f.text(f.article('抖音')).includes('检查通过'), false); assert.equal(f.calls.some(call => call.method === 'POST'), false);
  });
}

for (const [state, label] of [['needs-login', '上次检查需登录'], ['verification-required', '上次检查需验证']]) {
  test('expired ' + state + ' evidence remains an explicit historical obstacle without claiming current verification', async (t) => {
    const f = fixture(); t.after(() => f.dispose());
    f.social.douyin.browse.readiness = 'not-verified';
    f.social.douyin.browse.lastResult = { ok: false, state };
    await f.flush(); assert.ok(f.text(f.article('抖音')).includes(label));
    assert.equal(f.text(f.article('抖音')).includes('检查通过'), false);
    assert.equal(f.text(f.article('抖音')).includes('需要处理'), false);
    assert.equal(f.calls.some((call) => call.method === 'POST'), false);
  });
}

test('expired successful browse evidence stays pending and cannot imply a current successful check', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.social.douyin.browse.readiness = 'not-verified';
  f.social.douyin.browse.lastResult = { ok: true, state: 'video-observed' };
  await f.flush(); assert.ok(f.text(f.article('抖音')).includes('待检查'));
  assert.equal(f.text(f.article('抖音')).includes('检查通过'), false);
  assert.equal(f.calls.some((call) => call.method === 'POST'), false);
});

test('Douyin explicit check uses its own platform UUID and shows only bounded search evidence as success', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.result({ ok: true, state: 'search-read', url: 'https://www.douyin.com/search/' + encodeURIComponent('公开测试'),
    videos: [{ id: '1234567890123456789', url: 'https://www.douyin.com/video/1234567890123456789', title: '实际公开结果' }],
    frameCount: 0, note: '仅已读取公开检索结果，尚未观看这些视频。' });
  await f.flush(); await f.click('检查抖音浏览');
  assert.deepEqual(f.calls.filter((call) => call.method === 'POST'), [{ route: 'social/check', method: 'POST', payload: { platform: 'douyin', requestId: '12345678-1234-4234-8234-000000000001' } }]);
  assert.ok(f.text(f.article('抖音')).includes('公开浏览检查通过')); assert.ok(f.text(f.article('抖音')).includes('尚未观看'));
  assert.ok(f.text(f.article('抖音')).includes('实际公开结果'));
  assert.equal(f.text(f.article('B站')).includes('公开浏览检查通过'), false);
  assert.equal(f.nodes(f.article('抖音')).find((node) => node.type === 'a').props.href.startsWith('https://www.douyin.com/search/'), true);
});

for (const state of ['needs-login', 'verification-required']) test('Douyin ' + state + ' check remains an obstacle even if a malformed backend sets ok true', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.result({ ok: true, state, note: state === 'needs-login' ? '页面要求登录独立账号。' : '平台要求人工验证，已停止。', frameCount: 0 });
  await f.flush(); await f.click('检查抖音浏览');
  const article = f.text(f.article('抖音')); assert.ok(article.includes(state === 'needs-login' ? '需要登录独立账号' : '需要人工完成账号验证'));
  assert.equal(article.includes('公开浏览检查通过'), false); assert.equal(f.nodes(f.article('抖音')).some((node) => node.type === 'a'), false);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('Douyin title alone or empty frames cannot become successful viewing; real sampled frame metadata can', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.result({ ok: true, state: 'video-observed', title: '只是页面标题', url: 'https://www.douyin.com/video/1234567890123456789',
    video: { id: '1234567890123456789', currentTime: 0 }, frameCount: 0 });
  await f.flush(); await f.click('检查抖音浏览'); assert.equal(f.text(f.article('抖音')).includes('公开浏览检查通过'), false);
  f.result({ ok: true, state: 'video-observed', url: 'https://www.douyin.com/video/1234567890123456789',
    video: { id: '1234567890123456789', currentTime: 2 }, frameCount: 1, note: '已读取当前时间及1帧，不表示完整看完。' });
  await f.click('检查抖音浏览'); assert.ok(f.text(f.article('抖音')).includes('公开浏览检查通过')); assert.ok(f.text(f.article('抖音')).includes('不表示完整看完'));
});

test('two platform results stay independent and duplicate or hidden Douyin clicks never dispatch twice', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('检查浏览');
  f.result({ ok: false, state: 'needs-login', note: '等待独立账号。' });
  let release; f.setGate(new Promise((resolve) => { release = resolve; })); const stale = f.button('检查抖音浏览').props.onClick;
  stale(); stale(); await f.flush(); assert.equal(f.button('检查抖音浏览中…').props.disabled, true); assert.equal(f.button('检查浏览').props.disabled, true);
  release(); await f.flush(); assert.ok(f.text(f.article('B站')).includes('公开浏览检查通过')); assert.ok(f.text(f.article('抖音')).includes('需要登录独立账号'));
  await f.active(false); stale(); await f.flush(); assert.equal(f.calls.filter((call) => call.method === 'POST').length, 2);
});
