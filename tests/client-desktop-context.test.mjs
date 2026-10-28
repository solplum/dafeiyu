import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shipped = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
assert.equal(shipped.split('() => h(Panel),').length, 2);
const source = shipped.replace('() => h(Panel),', '() => h(DesktopContextPanel, { active: window.__active, controlBlocked: window.__blocked }),');
const ONE = '12345678-1234-4234-8234-123456789abc', TWO = '12345678-1234-4234-8234-123456789def';
const PREVIEW = '12345678-1234-4234-8234-000000000001';

// The actual shipped React component is rendered; all API responses are local
// fixtures. These tests cannot call models, browse, or modify real sessions.
function fixture() {
  let component, hookIndex, rootRender, tree, dirty = false, effects = [], timerId = 0;
  let previewGate, recoverGate, recoverFailure, previewPatch;
  const instances = new Map(), calls = [], timers = new Map();
  const snapshot = { revision: 'fixture-revision-1', automaticReplay: false, sessions: [
    { sessionId: ONE, paused: true, busy: false, seq: 7, maxTokens: 256000 },
    { sessionId: TWO, paused: true, busy: false, seq: 8, maxTokens: 256000 },
  ] };
  const React = {
    Fragment: Symbol('fragment'), createElement(type, props, ...children) { return { type, props: { ...(props || {}), children: children.flat(Infinity) } }; },
    useState(initial) {
      const instance = component, index = hookIndex++, hook = instance.hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      hook.set ||= next => { const value = typeof next === 'function' ? next(hook.value) : next;
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
  const host = { __active: true, __blocked: false, __ModuleLoader__: { load({ factory }) {
    factory(name => { assert.equal(name, 'react'); return React; }).apply({ slots: {
      inject(_name, callback) { callback(); }, register(_definition, render) { rootRender = render; },
    } });
  } } };
  vm.runInNewContext(source, { window: host, document: {}, AbortController, URL, URLSearchParams, TextEncoder, Date, Math,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => {
      const route = url.split('/api/')[1], method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ route, method, payload }); let value;
      if (route === 'desktop-context/status') value = { ok: true, desktopContext: structuredClone(snapshot) };
      else if (route === 'desktop-context/preview') {
        if (previewGate) await previewGate;
        value = { ok: true, desktopContext: { sessionId: payload.sessionId, previewId: PREVIEW, allowed: true,
          totalTokens: 80000, limitTokens: 90000, maxTokens: 8192, ...previewPatch } };
      } else if (route === 'desktop-context/recover') {
        if (recoverGate) await recoverGate;
        value = recoverFailure || { ok: true, desktopContext: { sessionId: payload.sessionId, recovered: true, automaticReplay: false, maxTokens: 8192 } };
      } else assert.fail('Unexpected API: ' + route);
      return { ok: value.ok === true, status: value.ok === true ? 200 : 503, json: async () => structuredClone(value) };
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
      dirty = false; tree = render(rootRender()); const pending = effects; effects = []; pending.forEach(effect => effect());
      await Promise.resolve(); await new Promise(resolve => setImmediate(resolve));
      if (!dirty && !effects.length) return;
    }
    assert.fail('Desktop context UI did not settle');
  }
  const nodes = (node = tree) => !node || typeof node !== 'object' || node.props.hidden ? [] : [node, ...node.props.children.flatMap(child => nodes(child))];
  const text = (node = tree) => typeof node === 'string' ? node : node?.props?.hidden ? '' : node?.props?.children.map(child => text(child)).join('') || '';
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label);
  async function click(label) { const node = button(label); assert(node, 'Missing button: ' + label); assert.equal(Boolean(node.props.disabled), false); node.props.onClick(); await flush(); }
  const checkbox = () => nodes().find(node => node.type === 'input' && node.props.type === 'checkbox');
  return { snapshot, calls, nodes, text, button, click, flush, checkbox,
    async acknowledge() { const node = checkbox(); assert(node, 'explicit confirmation must be present'); node.props.onChange({ target: { checked: true } }); await flush(); },
    async target(value) { nodes().find(node => node.type === 'select').props.onChange({ target: { value } }); await flush(); },
    async active(value) { host.__active = value; await flush(); }, async blocked(value) { host.__blocked = value; await flush(); },
    setPreviewGate(value) { previewGate = value; }, setRecoverGate(value) { recoverGate = value; },
    preview(value) { previewPatch = value; }, failRecover(value) { recoverFailure = value; },
    dispose() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); },
  };
}

const posts = f => f.calls.filter(row => row.method === 'POST');

test('desktop capacity opens with a metadata-only GET and never starts preview/recovery implicitly', async t => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  assert.deepEqual(f.calls, [{ route: 'desktop-context/status', method: 'GET', payload: undefined }]);
  assert.equal(f.button('先检查一下').props.disabled, false); assert.equal(f.checkbox(), undefined);
  assert(f.text().includes('已暂停')); assert.equal(posts(f).length, 0);
});

test('desktop preview pins the selected sequence and 8192 reply tokens; recovery needs explicit no-replay confirmation', async t => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('先检查一下');
  assert.deepEqual(posts(f)[0], { route: 'desktop-context/preview', method: 'POST', payload: { sessionId: ONE, expectedSeq: 7, maxTokens: 8192 } });
  assert.equal(f.button('让她继续').props.disabled, true);
  f.button('让她继续').props.onClick(); await f.flush(); assert.equal(posts(f).length, 1);
  await f.acknowledge(); await f.click('让她继续');
  assert.deepEqual(posts(f)[1], { route: 'desktop-context/recover', method: 'POST', payload: { sessionId: ONE, previewId: PREVIEW, acknowledgeNoReplay: true } });
  assert(f.text().includes('不会自动补发')); assert.equal(f.button('先检查一下').props.disabled, true);
});

test('desktop recovery dispatches once even through a repeated old handler and consumes the preview on unknown result', async t => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('先检查一下'); await f.acknowledge();
  let release; f.setRecoverGate(new Promise(resolve => release = resolve));
  f.failRecover({ ok: false, code: 'UNAVAILABLE', error: '没确认她是否已恢复，重新查看一次；不会自动重试。' });
  const stale = f.button('让她继续').props.onClick; stale(); stale(); await f.flush();
  assert.equal(posts(f).filter(row => row.route.endsWith('/recover')).length, 1);
  release(); await f.flush(); stale(); await f.flush();
  assert.equal(posts(f).filter(row => row.route.endsWith('/recover')).length, 1);
  assert.equal(f.button('让她继续'), undefined); assert(f.text().includes('没确认她是否已恢复'));
  assert(!f.text().includes('不会自动补发'));
});

test('blocked or hidden desktop capacity handlers cannot submit old previews or recovery actions', async t => {
  for (const change of ['blocked', 'active']) {
    const f = fixture(); t.after(() => f.dispose()); await f.flush();
    const check = f.button('先检查一下').props.onClick;
    await f.click('先检查一下'); await f.acknowledge(); const recover = f.button('让她继续').props.onClick;
    await f[change](change === 'blocked'); const before = posts(f).length;
    check(); recover(); await f.flush(); assert.equal(posts(f).length, before);
  }
});

test('changing target or refreshing clears desktop capacity preview and its checkbox', async t => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('先检查一下'); await f.acknowledge();
  const stale = f.button('让她继续').props.onClick;
  await f.target(TWO); assert.equal(f.checkbox(), undefined); stale(); await f.flush();
  assert.equal(posts(f).length, 1); await f.click('先检查一下');
  assert.equal(posts(f).at(-1).payload.sessionId, TWO); assert.equal(posts(f).at(-1).payload.expectedSeq, 8);
  await f.acknowledge(); await f.click('查看对话');
  assert.equal(f.checkbox(), undefined); assert.equal(f.button('让她继续'), undefined);
});

test('late desktop capacity previews cannot revive controls after hiding or blocking', async t => {
  for (const change of ['active', 'blocked']) {
    const f = fixture(); t.after(() => f.dispose()); await f.flush(); let release;
    f.setPreviewGate(new Promise(resolve => release = resolve)); await f.click('先检查一下');
    await f[change](change === 'blocked'); release(); await f.flush();
    assert.equal(f.checkbox(), undefined); assert.equal(f.button('让她继续'), undefined);
  }
});

test('mismatched desktop capacity targets and insufficient previews never offer recovery', async t => {
  for (const patch of [{ sessionId: TWO }, { allowed: false }, { totalTokens: 90001 }]) {
    const f = fixture(); t.after(() => f.dispose()); f.preview(patch); await f.flush(); await f.click('先检查一下');
    assert.equal(f.checkbox(), undefined); assert.equal(f.button('让她继续'), undefined);
    assert(f.text().includes('检查没通过')); assert.equal(posts(f).length, 1);
  }
});
