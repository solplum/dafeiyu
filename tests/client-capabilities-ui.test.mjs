import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
const ids = ['computer', 'desktop', 'browser', 'web', 'qq', 'phone', 'voice-input', 'voice-output', 'memory', 'memes', 'background'];
const capability = (id, patch = {}) => ({ id, title: '测试能力 ' + id, description: '可使用此项能力', examples: ['运行一个安全测试'],
  present: true, available: true, state: 'ready', stateText: '已就绪，尚未实测', reason: '等待主动验证', nextStep: '点击按钮验证',
  section: id === 'qq' ? 'qq' : 'dependencies', checkedAt: '2026-10-24T01:00:00Z', verifiedAt: null, expiresAt: null,
  verification: { status: 'not-tested', message: '尚未进行安全验证' }, canProbe: ['computer', 'desktop', 'browser'].includes(id), ...patch });

// Execute the actual shipped component and handlers with an isolated React host.
// Every capability operation uses fixture responses; no real GUI, QQ or model is used.
function fixture() {
  let component, hookIndex, root, tree, dirty = false, effects = [], timerId = 0, uuidSerial = 0;
  const instances = new Map(), calls = [], timers = new Map(), animationFrames = [];
  const state = { ok: true, canApply: true, pendingReload: false, config: { revision: 'fixture-1',
    saved: { ownerQq: '123', onebotSelfId: '456', onebotEngine: 'native' },
    effective: { ownerQq: '123', onebotSelfId: '456', onebotEngine: 'native', qqAccounts: [{ qq: '123', enabled: true,
      activeIdentityId: 'default', identities: [{ id: 'default', name: '默认身份', relationType: 'existing' }] }] },
    running: {}, overriddenFields: [], secretConfigured: {} },
    runtime: { ready: true, busy: false, companion: { conversations: [] }, phone: { state: 'disabled' }, model: {}, backgroundTasks: { active: 0 } }, paths: {} };
  let capabilities = { busy: false, checkedAt: null, items: ids.map((id) => capability(id)) };
  let failRead = false, failMutation = false, mutationGate, readGate, probePatch = {}, invalidRead = false, operationFailureCode = '';
  const React = {
    Fragment: Symbol('fragment'), createElement(type, props, ...children) { return { type, props: { ...(props || {}), children: children.flat(Infinity) } }; },
    useState(initial) {
      const instance = component, index = hookIndex++;
      const hook = instance.hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial };
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
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load({ factory }) { factory((name) => { assert.equal(name, 'react'); return React; }).apply({ slots: {
      inject(_name, callback) { callback(); }, register(_definition, render) { root = render(); },
    } }); } } },
    document: { hidden: false }, AbortController, TextEncoder, URLSearchParams, Date, Math,
    requestAnimationFrame(callback) { animationFrames.push(callback); return animationFrames.length; },
    crypto: { randomUUID: () => '00112233-4455-4677-8899-' + (++uuidSerial).toString(16).padStart(12, '0') },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => {
      const route = url.split('/api/')[1], method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ route, method, payload }); let result, status = 200;
      if (route === 'state') result = state;
      else if (route === 'capabilities') {
        const cached = structuredClone(capabilities);
        if (readGate) await readGate;
        if (failRead) { status = 503; result = { ok: false, error: 'PRIVATE_COMPONENT_READ_ERROR' }; }
        else result = { ok: true, capabilities: invalidRead ? null : cached };
      } else if (route === 'capabilities/check' || route === 'capabilities/probe') {
        if (route === 'capabilities/probe' && payload.id === 'desktop') {
          assert.ok(nodes().some((node) => node.props['aria-label'] === '大肥鱼电脑控制测试输入'), 'desktop input must render before probe dispatch');
          assert.ok(nodes().some((node) => node.props['aria-label'] === '验证电脑输入'), 'desktop click target must render before probe dispatch');
        }
        if (mutationGate) await mutationGate;
        if (operationFailureCode) result = { ok: false, code: operationFailureCode, error: 'PRIVATE_CAPABILITY_PROBE_ERROR', capabilities, state };
        else if (failMutation) { status = 500; result = { ok: false, error: 'PRIVATE_CAPABILITY_PROBE_ERROR' }; }
        else {
          if (route === 'capabilities/check') {
            assert.deepEqual(payload, {}); capabilities.checkedAt = '2026-10-24T02:00:00Z';
          } else {
            assert.equal(['computer', 'desktop', 'browser'].includes(payload.id), true);
            assert.match(payload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            Object.assign(capabilities.items.find((item) => item.id === payload.id), { state: 'verified', stateText: '实测通过',
              verifiedAt: '2026-10-24T02:00:00Z', verification: { status: 'passed', message: '本地测试完成' } }, probePatch);
          }
          result = { ok: true, capabilities };
        }
      } else if (route === 'dependencies') result = { ok: true, dependencies: { busy: false, items: [] } };
      else if (route === 'napcat/status') result = { ok: true, napcat: { available: false } };
      else if (route === 'config' || route === 'apply') assert.fail('Unexpected configuration write');
      else assert.fail('Unexpected API: ' + route);
      return { ok: status === 200, status, json: async () => structuredClone(result) };
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
      dirty = false; tree = render(root); const pending = effects; effects = []; for (const effect of pending) effect();
      for (const callback of animationFrames.splice(0)) callback();
      await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve));
      if (!dirty && !effects.length) return;
    }
    assert.fail('UI did not settle');
  }
  const nodes = (node = tree) => !node || typeof node !== 'object' || node.props.hidden ? []
    : [node, ...node.props.children.flatMap((child) => nodes(child))];
  const text = (node = tree) => typeof node === 'string' ? node : node?.props?.hidden ? '' : node?.props?.children.map((child) => text(child)).join('') || '';
  const aliases = { '当前状态': '首页', '能力': '功能', '后台任务': '任务', '查看能力': '查看功能',
    '刷新能力': '刷新功能', '检测组件': '检查连接', '刷新后台任务': '刷新任务', '保存': '仅保存', '保存并应用': '保存并生效',
    'QQ 连接': 'QQ账号', '依赖与更新': '安装与更新' };
  const button = (label) => nodes().find((node) => node.type === 'button' && text(node) === (aliases[label] || label));
  const summary = (title, scope) => nodes(scope).find((node) => node.type === 'summary' && text(node) === title);
  async function expand(title, scope) {
    const node = summary(title, scope); assert(node, 'Missing summary: ' + title);
    if (!node.props['aria-expanded']) { node.props.onClick({ preventDefault() {} }); await flush(); }
  }
  async function expandSettings() {
    const node = summary('任务设置');
    if (node) await expand('任务设置');
  }
  async function inspectCapabilities() {
    for (const node of nodes().filter((node) => node.type === 'summary' && text(node) === '高级详情' && !node.props['aria-expanded'])) {
      node.props.onClick({ preventDefault() {} });
    }
    await flush();
  }
  const field = (suffix) => nodes().find((node) => node.type === 'input' && node.props.id?.endsWith(suffix));
  const probe = (id) => nodes().find((node) => node.type === 'button' && node.props['aria-label'] === '安全验证 ' + id);
  const config = (id) => nodes().find((node) => node.type === 'button' && node.props['aria-label'] === '配置能力 ' + id);
  const article = (id) => nodes().find((node) => node.type === 'article' && node.props['aria-label'] === '能力 ' + id);
  async function click(label) {
    if (!button(label) && ['QQ 连接', '依赖与更新', 'QQ账号', '安装与更新'].includes(label)) await click('设置');
    const node = button(label); assert(node, 'Missing button: ' + label); assert.equal(Boolean(node.props.disabled), false, 'Disabled button: ' + label);
    node.props.onClick?.(); await flush();
  }
  return { state, calls, timers, nodes, text, button, field, probe, config, article, click, flush, expand, expandSettings, inspectCapabilities,
    get capabilities() { return capabilities; }, set capabilities(value) { capabilities = value; },
    setFailRead(value) { failRead = value; }, setInvalidRead(value) { invalidRead = value; },
    setFailMutation(value) { failMutation = value; }, setMutationGate(value) { mutationGate = value; }, setProbePatch(value) { probePatch = value; },
    setOperationFailureCode(value) { operationFailureCode = value; },
    setReadGate(value) { readGate = value; },
    dispose() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); } };
}

test('overview links to the capability tab and opening only reads the capability snapshot once', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  assert.ok(f.button('查看能力'));
  assert.deepEqual(f.calls.map(({ route, method }) => ({ route, method })), [{ route: 'state', method: 'GET' }]);
  const tabs = f.nodes().filter((node) => node.props.role === 'tab').map((node) => f.text(node));
  assert.deepEqual(tabs.slice(0, 3), ['首页', '功能', '任务']);
  await f.click('查看能力');
  assert.deepEqual(f.calls.map(({ route, method }) => ({ route, method })), [{ route: 'state', method: 'GET' }, { route: 'capabilities', method: 'GET' }]);
  assert.equal(ids.every((id) => Boolean(f.article(id))), true);
  assert.equal(f.nodes().filter((node) => node.type === 'article').length, 11);
  assert.equal(f.text().includes('同一份状态记录'), false, 'explanation is hidden until help opens');
  assert.equal(f.text().includes('DSH 技能'), false, 'technical evidence is collapsed by default');
  assert.equal(f.nodes().some((node) => node.props['aria-label'] === 'DSH 界面控制测试区'), false);
  const help = f.nodes().find((node) => node.type === 'button' && node.props['aria-label'] === '功能说明');
  help.props.onClick(); await f.flush(); assert.ok(f.text().includes('同一份状态记录'));
  help.props.onClick(); await f.flush();
  await f.click('当前状态'); await f.click('能力');
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities').length, 1);
  assert.equal(f.calls.some(({ method }) => method === 'POST'), false);
});

test('each item distinguishes component existence, current readiness, actual verification and expiry', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  Object.assign(f.capabilities.items[0], { present: true, available: false, state: 'failed', stateText: '实际执行失败',
    verification: { status: 'failed', message: '测试命令未完成' }, reason: '工具调用受限', nextStep: '检查本机权限' });
  Object.assign(f.capabilities.items[1], { present: null, available: null, state: 'unknown', stateText: '' });
  Object.assign(f.capabilities.items[2], { state: 'verified', stateText: '已通过', verifiedAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-02T00:00:00Z' });
  await f.flush(); await f.click('能力'); await f.inspectCapabilities();
  const computer = f.text(f.article('computer'));
  for (const part of ['组件：已检测到', '就绪：当前未就绪', '实际执行失败', '尚未实际验证', '测试命令未完成', '工具调用受限', '检查本机权限']) assert.ok(computer.includes(part), part);
  const desktop = f.text(f.article('desktop'));
  assert.ok(desktop.includes('组件：尚未检测')); assert.ok(desktop.includes('就绪：尚未确认'));
  const browser = f.text(f.article('browser'));
  assert.ok(browser.includes('实测已过期，需重验')); assert.ok(browser.includes('（已过期）'));
  assert.equal(browser.includes('已通过'), false, 'expired proof cannot retain a success badge');
});

test('component details show checked host tools, versions and missing permissions without filling unrelated capability cards', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  Object.assign(f.capabilities.items.find((item) => item.id === 'desktop'), { components: {
    skillVisible: true, terminalVisible: true, cliPresent: true, version: '1.2.3', accessibilityGranted: false, screenshotsGranted: null,
  } });
  Object.assign(f.capabilities.items.find((item) => item.id === 'browser'), { components: {
    skillVisible: false, terminalVisible: null, cliPresent: false,
  } });
  await f.flush(); await f.click('能力'); await f.inspectCapabilities();
  const desktop = f.text(f.article('desktop'));
  for (const part of ['DSH 技能：可见', 'DSH 终端：可调用', '控制组件：已检测到', '控制组件版本：1.2.3', '辅助功能：未授权', '屏幕录制：尚未确认']) assert.ok(desktop.includes(part), part);
  const browser = f.text(f.article('browser'));
  for (const part of ['DSH 技能：不可见', 'DSH 终端：尚未确认', '控制组件：未检测到']) assert.ok(browser.includes(part), part);
  assert.equal(browser.includes('辅助功能：'), false); assert.equal(browser.includes('屏幕录制：'), false);
  assert.equal(browser.includes('控制组件版本：'), false);
  assert.equal(f.text(f.article('qq')).includes('DSH 技能：'), false);
});

test('eleven full component snapshots only display fields that apply to each capability', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  for (const item of f.capabilities.items) item.components = { cliPresent: null, version: '2.3.4', skillVisible: null,
    terminalVisible: null, accessibilityGranted: null, screenshotsGranted: null };
  await f.flush(); await f.click('能力'); await f.inspectCapabilities();
  const desktop = f.text(f.article('desktop'));
  for (const label of ['DSH 技能', 'DSH 终端', '控制组件', '辅助功能', '屏幕录制']) assert.ok(desktop.includes(label + '：尚未确认'), label);
  assert.ok(desktop.includes('控制组件版本：2.3.4'));
  const browser = f.text(f.article('browser'));
  for (const label of ['DSH 技能', 'DSH 终端', '控制组件']) assert.ok(browser.includes(label + '：尚未确认'), label);
  assert.ok(browser.includes('控制组件版本：2.3.4'));
  for (const label of ['辅助功能', '屏幕录制']) assert.equal(browser.includes(label + '：'), false, label);
  const computer = f.text(f.article('computer'));
  assert.ok(computer.includes('DSH 终端：尚未确认'));
  for (const label of ['DSH 技能', '控制组件', '控制组件版本', '辅助功能', '屏幕录制']) assert.equal(computer.includes(label + '：'), false, label);
  for (const id of ids.filter((id) => !['computer', 'desktop', 'browser'].includes(id))) {
    const articleText = f.text(f.article(id));
    for (const label of ['DSH 技能', 'DSH 终端', '控制组件', '控制组件版本', '辅助功能', '屏幕录制']) assert.equal(articleText.includes(label + '：'), false, id + ':' + label);
  }
  assert.equal(f.nodes().filter((node) => String(node.props['aria-label'] || '').startsWith('能力组件 ')).length, 3);
});

test('refresh is GET only; explicit component checking posts an empty payload without executing probes', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('能力');
  const count = f.calls.length; await f.click('刷新能力'); await f.click('检测组件');
  assert.deepEqual(f.calls.slice(count).map(({ route, method, payload }) => ({ route, method, payload })), [
    { route: 'capabilities', method: 'GET', payload: undefined }, { route: 'capabilities/check', method: 'POST', payload: {} },
  ]);
  assert.equal(f.text().includes('检测到组件不代表实际操作已经通过'), false);
  await f.expand('高级设置'); assert.ok(f.text().includes('检测到组件不代表实际操作已经通过'));
  assert.equal(f.calls.some(({ route }) => route === 'capabilities/probe'), false);
});

test('safe verification requires backend permission and one request id, and failed verification remains a failure', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.setProbePatch({ state: 'failed', stateText: '安全验证失败', verification: { status: 'failed', message: '未得到工具回执' }, verifiedAt: null });
  await f.flush(); await f.click('能力'); await f.inspectCapabilities();
  assert.equal(f.probe('qq'), undefined); assert.equal(f.probe('phone'), undefined);
  assert.equal(f.probe('memory'), undefined);
  f.probe('computer').props.onClick(); await f.flush();
  const sent = f.calls.filter(({ route }) => route === 'capabilities/probe');
  assert.equal(sent.length, 1); assert.equal(sent[0].method, 'POST');
  assert.deepEqual(sent[0].payload, { id: 'computer', requestId: '00112233-4455-4677-8899-000000000001' });
  assert.ok(f.text(f.article('computer')).includes('安全验证失败'));
  assert.ok(f.text(f.article('computer')).includes('未得到工具回执'));
  assert.equal(f.text().includes('安全验证已通过'), false);
});

test('verification locks repeated clicks and configuration writes while allowing status refresh', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('能力');
  let release; f.setMutationGate(new Promise((resolve) => { release = resolve; }));
  const stale = f.probe('computer'); stale.props.onClick(); stale.props.onClick(); await f.flush();
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities/probe').length, 1);
  assert.equal(f.probe('computer').props.disabled, true);
  assert.equal(f.button('检测组件').props.disabled, true);
  assert.ok(!f.button('保存') || f.button('保存').props.disabled); assert.ok(!f.button('保存并应用') || f.button('保存并应用').props.disabled);
  assert.equal(f.button('刷新能力').props.disabled, false);
  await f.click('刷新能力');
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities').length, 2);
  release(); await f.flush();
  assert.equal(f.probe('computer').props.disabled, false);
  assert.equal(f.calls.some(({ route }) => route === 'config' || route === 'apply'), false);
});

test('component checking synchronously blocks a stale save handler and preserves existing drafts', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('后台任务'); await f.expandSettings();
  f.field('-externalTaskRouting').props.onChange({ target: { checked: false } }); await f.flush();
  assert.equal(Boolean(f.button('保存').props.disabled), false);
  const staleSave = f.button('保存').props.onClick;
  await f.click('能力');
  let release; f.setMutationGate(new Promise((resolve) => { release = resolve; }));
  f.button('检测组件').props.onClick(); staleSave({ preventDefault() {} }); await f.flush();
  assert.ok(!f.button('保存') || f.button('保存').props.disabled); assert.ok(!f.button('保存并应用') || f.button('保存并应用').props.disabled);
  assert.equal(f.calls.some(({ route }) => route === 'config' || route === 'apply'), false);
  release(); await f.flush(); assert.equal(Boolean(f.button('保存').props.disabled), false);
  await f.click('后台任务'); await f.expandSettings(); assert.equal(f.field('-externalTaskRouting').props.checked, false);
});

test('a slow refresh cannot overwrite a newer completed verification result', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('能力'); await f.inspectCapabilities();
  let release; f.setReadGate(new Promise((resolve) => { release = resolve; }));
  f.button('刷新能力').props.onClick(); await f.flush();
  f.probe('computer').props.onClick(); await f.flush();
  assert.ok(f.text(f.article('computer')).includes('实测通过'));
  release(); await f.flush();
  assert.ok(f.text(f.article('computer')).includes('实测通过'));
  assert.equal(f.text(f.article('computer')).includes('已就绪，尚未实测'), false);
});

test('unapplied configuration and active work block verification even through stale handlers', async (t) => {
  for (const mode of ['pending', 'runtime', 'applying', 'draft']) {
    const f = fixture(); t.after(() => f.dispose());
    if (mode === 'pending') f.state.pendingReload = true;
    if (mode === 'runtime') f.state.runtime.busy = true;
    if (mode === 'applying') f.state.runtime.applying = true;
    await f.flush();
    if (mode === 'draft') {
      await f.click('后台任务'); await f.expandSettings();
      f.field('-externalTaskRouting').props.onChange({ target: { checked: false } }); await f.flush();
    }
    await f.click('能力'); assert.equal(f.probe('computer').props.disabled, true, mode);
    f.probe('computer').props.onClick(); await f.flush();
    assert.equal(f.calls.some(({ route }) => route === 'capabilities/probe'), false, mode);
    assert.equal(f.button('刷新能力').props.disabled, false);
  }
});

test('backend busy state survives navigation and prevents saves until refreshed idle', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.capabilities.busy = true;
  await f.flush(); await f.click('能力');
  assert.equal(f.probe('computer').props.disabled, true); assert.ok(!f.button('保存并应用') || f.button('保存并应用').props.disabled);
  await f.click('后台任务'); assert.ok(!f.button('保存') || f.button('保存').props.disabled);
  await f.click('能力'); f.capabilities.busy = false; await f.click('刷新能力');
  assert.equal(f.probe('computer').props.disabled, false);
});

test('read errors and malformed responses are explicit, do not leak internal errors or retry automatically', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.setFailRead(true);
  await f.flush(); await f.click('能力');
  assert.ok(f.text().includes('能力状态读取失败')); assert.equal(f.text().includes('PRIVATE_COMPONENT_READ_ERROR'), false);
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities').length, 1);
  await f.click('当前状态'); await f.click('能力');
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities').length, 1);
  f.setFailRead(false); f.setInvalidRead(true); await f.click('刷新能力');
  assert.ok(f.text().includes('能力状态读取失败'));
  f.setInvalidRead(false); await f.click('刷新能力');
  assert.equal(f.text().includes('能力状态读取失败'), false);
});

test('unconfirmed verification reports uncertainty without retrying or exposing internal errors', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.setFailMutation(true);
  await f.flush(); await f.click('能力'); f.probe('computer').props.onClick(); await f.flush();
  assert.ok(f.text().includes('安全验证未得到确认')); assert.ok(f.text().includes('不会自动重试'));
  assert.equal(f.text().includes('PRIVATE_CAPABILITY_PROBE_ERROR'), false);
  await f.click('刷新能力'); assert.equal(f.calls.filter(({ route }) => route === 'capabilities/probe').length, 1);
});

test('an explicit failed capability response still updates safe records instead of discarding the server result', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('能力'); await f.inspectCapabilities();
  f.setOperationFailureCode('FAILED');
  Object.assign(f.capabilities.items[0], { state: 'failed', stateText: '后端已确认验证失败', reason: '固定测试没有匹配回执',
    verifiedAt: null, verification: { status: 'failed' } });
  f.probe('computer').props.onClick(); await f.flush();
  assert.ok(f.text(f.article('computer')).includes('后端已确认验证失败'));
  assert.ok(f.text(f.article('computer')).includes('固定测试没有匹配回执'));
  assert.ok(f.text().includes('安全验证未通过，请查看该项的结果和说明'));
  assert.equal(f.text().includes('安全验证未得到确认'), false);
  assert.equal(f.text().includes('PRIVATE_CAPABILITY_PROBE_ERROR'), false);
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities/probe').length, 1);
});

test('fixed desktop initialization and target diagnostics display as unconfirmed records without retrying', async (t) => {
  for (const code of ['DESKTOP_INIT_UNCONFIRMED', 'DESKTOP_TARGET_UNCONFIRMED']) {
    const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('能力'); await f.inspectCapabilities();
    f.setOperationFailureCode(code);
    Object.assign(f.capabilities.items.find((item) => item.id === 'desktop'), { state: 'failed', stateText: '验证结果未确认',
      reason: code === 'DESKTOP_INIT_UNCONFIRMED' ? '本应用辅助树初始化尚未确认，尚未输入或点击' : '绑定窗口尚未找到唯一测试框，尚未输入或点击',
      verification: { status: 'uncertain', code } });
    f.probe('desktop').props.onClick(); await f.flush();
    assert.ok(f.text().includes('安全验证结果尚未确认'));
    assert.ok(f.text(f.article('desktop')).includes('尚未输入或点击'));
    assert.equal(f.text(f.article('desktop')).includes('实测通过'), false);
    assert.equal(f.text().includes('PRIVATE_CAPABILITY_PROBE_ERROR'), false);
    await f.click('刷新能力');
    assert.equal(f.calls.filter(({ route }) => route === 'capabilities/probe').length, 1);
  }
});

test('unconfirmed cleanup blocks configuration until one capability GET and bounded state GET confirm the host stopped', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('后台任务'); await f.expandSettings();
  f.field('-externalTaskRouting').props.onChange({ target: { checked: false } }); await f.flush();
  await f.click('能力'); await f.inspectCapabilities(); assert.equal(Boolean(f.button('保存').props.disabled), false);
  f.setOperationFailureCode('UNCONFIRMED'); f.capabilities.busy = true; f.state.runtime.busy = true;
  f.capabilities.items[0].reason = '此前检测进程尚未确认停止';
  await f.click('检测组件');
  assert.ok(!f.button('保存') || f.button('保存').props.disabled); assert.ok(!f.button('保存并应用') || f.button('保存并应用').props.disabled);
  assert.equal(f.probe('computer').props.disabled, true); assert.equal(f.button('刷新能力').props.disabled, false);
  assert.ok(f.text().includes('此前检测进程尚未确认停止'));
  f.capabilities.busy = false; f.state.runtime.busy = false;
  const start = f.calls.length; await f.click('刷新能力');
  assert.deepEqual(f.calls.slice(start).map(({ route, method }) => ({ route, method })), [
    { route: 'capabilities', method: 'GET' }, { route: 'state', method: 'GET' },
  ]);
  assert.equal(Boolean(f.button('保存').props.disabled), false); assert.equal(Boolean(f.button('保存并应用').props.disabled), false);
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities/check').length, 1);
  const after = f.calls.length; await f.click('刷新能力');
  assert.deepEqual(f.calls.slice(after).map(({ route }) => route), ['capabilities'], 'idle records do not start a state refresh loop');
  await f.click('后台任务'); await f.expandSettings(); assert.equal(f.field('-externalTaskRouting').props.checked, false);
});

test('a failed probe busy snapshot prevents another probe until capabilities and parent runtime both refresh idle', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('能力');
  f.setOperationFailureCode('TIMEOUT'); f.capabilities.busy = true; f.state.runtime.busy = true;
  Object.assign(f.capabilities.items[0], { state: 'failed', stateText: '验证超时', verification: { status: 'uncertain' } });
  f.probe('computer').props.onClick(); await f.flush();
  assert.equal(f.probe('computer').props.disabled, true); assert.ok(f.text().includes('安全验证结果尚未确认'));
  f.capabilities.busy = false; f.state.runtime.busy = false; await f.click('刷新能力');
  assert.equal(Boolean(f.probe('computer').props.disabled), false);
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities/probe').length, 1);
});

test('forbidden or malformed error bodies cannot masquerade as a completed capability operation', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('能力');
  f.setOperationFailureCode('FORBIDDEN');
  Object.assign(f.capabilities.items[0], { state: 'verified', stateText: 'UNTRUSTED_ERROR_SUCCESS' });
  f.probe('computer').props.onClick(); await f.flush();
  assert.equal(f.text().includes('UNTRUSTED_ERROR_SUCCESS'), false);
  assert.ok(f.text().includes('安全验证未得到确认'));
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities/probe').length, 1);
});

test('empty service records retain eleven unknown capabilities with safe configuration navigation', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.capabilities.items = [];
  await f.flush(); await f.click('能力');
  assert.ok(f.text().includes('服务尚未返回能力记录')); assert.equal(f.nodes().filter((node) => node.type === 'article').length, 11);
  assert.equal(f.probe('computer'), undefined); assert.ok(f.text(f.article('computer')).includes('待检查'));
  f.config('qq').props.onClick(); await f.flush();
  assert.ok(f.nodes().some((node) => node.props.role === 'tab' && node.props['aria-selected'] && f.text(node) === 'QQ账号'));
});

test('desktop test controls stay hidden until an explicit probe reveals the fixed nonce input and readback', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('能力');
  const control = (label) => f.nodes().find((node) => node.props['aria-label'] === label);
  assert.equal(control('大肥鱼电脑控制测试输入'), undefined);
  assert.equal(control('验证电脑输入'), undefined);
  assert.equal(control('电脑控制回读'), undefined);
  assert.equal(f.calls.some(({ route }) => route === 'capabilities/probe'), false);
  f.probe('desktop').props.onClick();
  assert.equal(f.calls.some(({ route }) => route === 'capabilities/probe'), false, 'probe waits for the test area to render');
  await f.flush();
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities/probe').length, 1);
  assert.deepEqual(f.calls.find(({ route }) => route === 'capabilities/probe').payload,
    { id: 'desktop', requestId: '00112233-4455-4677-8899-000000000001' });
  assert.ok(control('大肥鱼电脑控制测试输入')); assert.ok(control('验证电脑输入')); assert.ok(control('电脑控制回读'));
  control('大肥鱼电脑控制测试输入').props.onChange({ target: { value: 'arbitrary' } }); await f.flush();
  control('验证电脑输入').props.onClick(); await f.flush(); assert.ok(f.text(control('电脑控制回读')).includes('请输入本次验证标记'));
  const nonce = 'DFY-CAP-' + 'a'.repeat(24);
  control('大肥鱼电脑控制测试输入').props.onChange({ target: { value: nonce } }); await f.flush();
  control('验证电脑输入').props.onClick(); await f.flush(); assert.equal(f.text(control('电脑控制回读')), '电脑控制回读：' + nonce);
  await f.click('收起测试区'); assert.equal(control('大肥鱼电脑控制测试输入'), undefined);
  assert.equal(f.calls.filter(({ route }) => route === 'capabilities/probe').length, 1, 'readback and collapse do not start another probe');
});

test('descriptions, examples and results remain inert text; unknown items and navigation sections cannot inject UI', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  Object.assign(f.capabilities.items[0], { description: '<img src=x onerror=alert(1)>', examples: ['<script>evil()</script>'],
    section: 'https://evil.invalid', verification: { message: '<b>arbitrary</b>' } });
  f.capabilities.items.push(capability('unexpected', { canProbe: true }));
  await f.flush(); await f.click('能力');
  const help = f.nodes(f.article('computer')).find((node) => node.type === 'button' && node.props['aria-label'] === '文件与代码说明');
  help.props.onClick(); await f.flush(); await f.inspectCapabilities();
  assert.ok(f.text().includes('<img src=x onerror=alert(1)>'));
  assert.ok(f.text().includes('<script>evil()</script>')); assert.ok(f.text().includes('<b>arbitrary</b>' )); assert.equal(f.article('unexpected'), undefined);
  assert.equal(f.nodes().some((node) => node.type === 'img' || node.props.dangerouslySetInnerHTML), false);
  f.config('computer').props.onClick(); await f.flush();
  assert.ok(f.nodes().some((node) => node.props.role === 'tab' && node.props['aria-selected'] && f.text(node) === '安装与更新'));
});

