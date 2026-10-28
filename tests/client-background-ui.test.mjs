import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
const task = (patch = {}) => ({ id: 'job-1', title: '检查项目', kind: 'task', status: 'running', statusText: '正在执行', executor: 'spawn',
  createdAt: '2026-10-24T01:00:00Z', startedAt: '2026-10-24T01:00:01Z', finishedAt: null, progress: '读取源码中',
  text: '', error: '', delivery: 'pending', canCancel: true, scope: { selfId: '456', peerId: '123', identityId: 'default' }, ...patch });

// The shipped module and real event handlers run with isolated React hooks/API
// fixtures. No host/profile, task executor, model, installation or QQ is touched.
function fixture() {
  let component, hookIndex, root, tree, dirty = false, effects = [], timerId = 0, revision = 1;
  const instances = new Map(), calls = [], timers = new Map();
  const state = { ok: true, canApply: true, pendingReload: false,
    config: { revision: 'fixture-1', saved: { ownerQq: '123', onebotSelfId: '456', onebotEngine: 'native' },
      effective: { ownerQq: '123', onebotSelfId: '456', onebotEngine: 'native', qqAccounts: [{ qq: '123', name: '主要账号', enabled: true,
        activeIdentityId: 'default', identities: [{ id: 'default', name: '默认身份', relationType: 'existing', userRole: '', companionRole: '',
          userTitle: '', companionTitle: '', description: '' }] }] }, running: {}, overriddenFields: [], secretConfigured: {} },
    runtime: { ready: true, busy: false, companion: { conversations: [] }, phone: { state: 'disabled' }, model: {},
      backgroundTasks: { ready: true, active: 1, running: 1, queued: 0, pendingDelivery: 0, deliveryUnknown: 0, tasks: [task()],
        executors: [{ name: 'spawn', available: true, verified: true }, { name: 'zcode', available: true, verified: false, reason: '尚未完成实际调用验证' },
          { name: 'minimax', available: false, verified: false, reason: '未检测到可执行文件' }] } }, paths: {} };
  let failSave = false, cancelFailure = false, cancelGate, testFailure = false, testGate, acknowledgeFailure = false, acknowledgeGate, uuidSerial = 0;
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
    crypto: { randomUUID: () => '00112233-4455-4677-8899-' + (++uuidSerial).toString(16).padStart(12, '0') },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => {
      const route = url.split('/api/')[1], method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ route, method, payload }); let result = state, status = 200;
      if (route === 'state') result = state;
      else if (route === 'config') {
        if (failSave) { status = 500; result = { ok: false, error: 'fixture save failure' }; }
        else {
          assert.equal(payload.revision, state.config.revision);
          Object.assign(state.config.saved, payload.patch); Object.assign(state.config.effective, payload.patch);
          state.config.revision = 'fixture-' + (++revision); state.pendingReload = true;
        }
      } else if (route === 'apply') {
        assert.equal(state.runtime.busy, false, 'busy tasks must not be reloaded by UI');
        state.config.running = structuredClone(state.config.effective); state.pendingReload = false; result = { ok: true };
      } else if (route === 'tasks/test') {
        if (testGate) await testGate;
        if (testFailure) { status = 500; result = { ok: false, error: 'PRIVATE_TEST_INTERNAL_ERROR' }; }
        else {
          assert.ok(['native', 'codex', 'zcode', 'minimax'].includes(payload.executor));
          assert.match(payload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          const item = task({ id: 'connect-' + uuidSerial, kind: 'connectivity-test', title: '只读连通测试', executor: payload.executor, status: 'queued', statusText: '排队中' });
          state.runtime.backgroundTasks.tasks.unshift(item); state.runtime.backgroundTasks.active = 1;
          state.runtime.backgroundTasks.queued = 1; state.runtime.backgroundTasks.running = 0; state.runtime.busy = true;
          result = { ok: true, task: item, state };
        }
      } else if (route === 'tasks/cancel') {
        if (cancelGate) await cancelGate;
        if (cancelFailure) { status = 500; result = { ok: false, error: 'PRIVATE_CANCEL_INTERNAL_ERROR' }; }
        else {
          const item = state.runtime.backgroundTasks.tasks.find((item) => item.id === payload.taskId);
          assert(item); assert.equal(payload.qq, item.scope.peerId); assert.equal(payload.identityId, item.scope.identityId);
          Object.assign(item, { status: 'cancelling', statusText: '正在取消', canCancel: false }); result = { ok: true, state };
        }
      } else if (route === 'tasks/acknowledge') {
        if (acknowledgeGate) await acknowledgeGate;
        if (acknowledgeFailure) { status = 500; result = { ok: false, error: 'PRIVATE_ACKNOWLEDGE_INTERNAL_ERROR' }; }
        else {
          const item = state.runtime.backgroundTasks.tasks.find((item) => item.id === payload.taskId);
          assert(item); assert.equal(payload.qq, item.scope.peerId); assert.equal(payload.identityId, item.scope.identityId);
          assert.equal(payload.confirmedStopped, true);
          item.requiresVerification = false; result = { ok: true, state };
        }
      } else assert.fail('Unexpected API: ' + route);
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
      await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve));
      if (!dirty && !effects.length) return;
    }
    assert.fail('UI did not settle');
  }
  const nodes = (node = tree) => !node || typeof node !== 'object' || node.props.hidden ? []
    : [node, ...node.props.children.flatMap((child) => nodes(child))];
  const text = (node = tree) => typeof node === 'string' ? node : node?.props?.hidden ? '' : node?.props?.children.map((child) => text(child)).join('') || '';
  const aliases = { '当前状态': '首页', '能力': '功能', '后台任务': '任务', '查看能力': '查看功能',
    '刷新能力': '刷新功能', '检测组件': '检查连接', '刷新后台任务': '刷新任务', '仅保存': '保存', '保存并生效': '保存', '保存并应用': '保存', '刷新': '刷新状态',
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
  const cancel = (id) => nodes().find((node) => node.type === 'button' && node.props['aria-label'] === '取消后台任务 ' + id);
  const connectivity = (name) => nodes().find((node) => node.type === 'button' && node.props['aria-label'] === '测试连通 ' + name);
  const acknowledge = (id) => nodes().find((node) => node.type === 'button' && node.props['aria-label'] === '解除工作区保护 ' + id);
  const verification = (id) => nodes().find((node) => node.type === 'input' && node.props['aria-label'] === '确认旧执行器已停止 ' + id);
  async function click(label) {
    const groupOf = { 'QQ 连接': '聊天', 'QQ账号': '聊天', '任务': '聊天', '依赖与更新': '高级', '安装与更新': '高级', '声音': '高级', '手机': '高级', '模型服务': '高级', '视频平台': '高级', '功能': '高级', '性格': '她', '记忆': '她', '表情包': '她', '生活与成长': '她' };
    const resolved = aliases[label] || label; if (!button(label) && groupOf[resolved]) await click(groupOf[resolved]);
    const node = button(label); assert(node, 'Missing button: ' + label); assert.equal(Boolean(node.props.disabled), false, 'Disabled button: ' + label);
    if (node.props.onClick) node.props.onClick();
    else nodes().find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await flush();
  }
  async function toggle(suffix, checked) {
    if (!field(suffix)) await expandSettings();
    const node = field(suffix); assert(node, 'Missing field: ' + suffix); assert.equal(Boolean(node.props.disabled), false);
    node.props.onChange({ target: { checked } }); await flush();
  }
  return { state, calls, timers, nodes, text, button, field, cancel, connectivity, acknowledge, verification, click, toggle, flush, expand, expandSettings, inspectCapabilities,
    setFailSave(value) { failSave = value; }, setCancelFailure(value) { cancelFailure = value; }, setCancelGate(value) { cancelGate = value; },
    setTestFailure(value) { testFailure = value; }, setTestGate(value) { testGate = value; },
    setAcknowledgeFailure(value) { acknowledgeFailure = value; }, setAcknowledgeGate(value) { acknowledgeGate = value; },
    dispose() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); } };
}

test('executor names and business work stay visible while finished connection checks have their own history', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.backgroundTasks.tasks = [task({ id: 'business', title: 'Codex 只读连通测试', status: 'succeeded', canCancel: false, delivery: 'sent' }),
    ...['native', 'codex', 'zcode', 'minimax'].map((executor, index) => task({ id: 'probe-' + index, executor,
      kind: 'connectivity-test', title: 'ORIGINAL_PROBE_TITLE_' + index, status: index === 1 ? 'failed' : 'succeeded', canCancel: false, delivery: 'sent' }))];
  await f.flush(); await f.click('后台任务');
  const formal = f.nodes().find(node => node.props['aria-label'] === '正式任务');
  assert.ok(f.text(formal).includes('Codex 只读连通测试'), 'title does not decide source');
  assert.equal(f.nodes(formal).filter(node => node.type === 'article').length, 1);
  assert.equal(f.text().includes('ORIGINAL_PROBE_TITLE_'), false);
  assert.equal(f.text().includes('Codex · 连接检查'), false, 'finished probes start collapsed');
  assert.ok(f.text().includes('连接检查记录（4）'));
  await f.expand('连接检查记录（4）');
  for (const name of ['DSH 原生子代理', 'Codex', 'Z Code', 'MiniMax Code']) assert.ok(f.text().includes(name + ' · 连接检查'));
  assert.ok(f.text().includes('检查失败'));
  assert.equal(f.text().includes('ORIGINAL_PROBE_TITLE_'), false, 'original text remains in advanced details');
  assert.deepEqual(f.calls.map(call => call.route), ['state', 'napcat/status']); // 组导航先落 QQ账号页，NapCat 只读状态轮询
});

test('unconfirmed connection checks retain visible safety controls instead of being hidden in history', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.backgroundTasks.tasks = [task({ id: 'probe-unknown', kind: 'connectivity-test', executor: 'codex',
    status: 'unknown', delivery: 'unknown', canCancel: false, requiresVerification: true })];
  await f.flush(); await f.click('后台任务');
  assert.ok(f.text().includes('还没有正式任务'));
  assert.ok(f.text().includes('需要处理的连接检查'));
  assert.ok(f.text().includes('送达结果未知，不自动重发'));
  assert.ok(f.verification('probe-unknown'));
  assert.equal(f.acknowledge('probe-unknown').props.disabled, true);
  const before = f.calls.length; await f.expand('连接检查记录（1）');
  assert.equal(f.nodes().filter(node => node.props['aria-label'] === '后台任务 probe-unknown').length, 1);
  assert.equal(f.calls.length, before);
});

test('legacy source uncertainty is displayed separately without guessing from its title', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.backgroundTasks.tasks = [task({ kind: 'legacy-unknown', title: 'minimax 只读连通测试',
    status: 'unknown', delivery: 'unknown', canCancel: false, requiresVerification: true })];
  await f.flush(); await f.click('后台任务');
  assert.ok(f.text().includes('历史记录（来源未分类）'));
  const formal = f.nodes().find(node => node.props['aria-label'] === '正式任务');
  assert.equal(f.text(formal).includes('minimax'), false);
  assert.ok(f.verification('job-1')); assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('background tab distinguishes task outcome, QQ delivery and executor detection without starting anything', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.backgroundTasks.tasks = [task({ status: 'succeeded', statusText: '执行完成', text: '已完成只读检查', delivery: 'unknown', canCancel: false }),
    task({ id: 'job-2', status: 'failed', statusText: '执行失败', executor: 'codex', error: '子任务执行未完成', delivery: 'sent', canCancel: false })];
  await f.flush(); await f.click('后台任务');
  for (const copy of ['执行器接入状态', '编号 job-1', '已完成只读检查']) assert.equal(f.text().includes(copy), false, copy + ' is collapsed');
  assert.ok(f.text().includes('协作助手：DSH 原生子代理 · Codex · Z Code · MiniMax Code'));
  assert.ok(f.text().includes('送达结果未知，不自动重发'));
  const help = f.nodes().find((node) => node.type === 'button' && node.props['aria-label'] === '任务说明');
  help.props.onClick(); await f.flush();
  await f.expand('高级设置'); await f.expand('查看结果'); await f.expandSettings();
  for (const copy of ['任务列表', '查询任务 编号', '取消任务 编号', '送达结果未知，不自动重发', 'QQ 结果送达：已确认送达',
    '执行器默认只读', '已检测到，实际调用尚未验证', '当前不可用']) assert.ok(f.text().includes(copy), copy);
  assert.ok(f.text().includes('已完成只读检查')); assert.ok(f.text().includes('子任务执行未完成'));
  assert.equal(f.cancel('job-1').props.disabled, true); assert.equal(f.cancel('job-2').props.disabled, true);
  assert.equal(f.field('-backgroundTasksEnabled').props.checked, true); assert.equal(f.field('-externalTaskRouting').props.checked, true);
  assert.deepEqual(f.calls.map((call) => call.route), ['state', 'napcat/status']);
  assert.equal(f.nodes().some((node) => node.type === 'button' && /启动任务|安装|运行任务/.test(f.text(node))), false);
  assert.equal([...f.timers.values()].some((timer) => timer.ms === 5000), false, 'background tab does not poll or start a job');
});

test('refresh fetches state and preserves unapplied settings drafts while showing the latest task progress', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('后台任务');
  await f.toggle('-externalTaskRouting', false);
  f.state.runtime.backgroundTasks.tasks[0].progress = '新进度：正在整理结果';
  const count = f.calls.length; await f.click('刷新后台任务');
  assert.deepEqual(f.calls.slice(count).map(({ route, method }) => ({ route, method })), [{ route: 'state', method: 'GET' }]);
  assert.ok(f.text().includes('新进度：正在整理结果')); assert.equal(f.field('-externalTaskRouting').props.checked, false);
  assert.equal(f.state.config.saved.externalTaskRouting, undefined);
});

test('a running task can be cancelled while runtime is busy, using only the displayed task and account identity', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.state.runtime.busy = true;
  await f.flush(); await f.click('后台任务'); assert.equal(f.cancel('job-1').props.disabled, false);
  f.cancel('job-1').props.onClick(); await f.flush();
  assert.deepEqual(f.calls.filter((call) => call.route === 'tasks/cancel').map((call) => call.payload), [{ taskId: 'job-1', qq: '123', identityId: 'default' }]);
  assert.ok(f.text().includes('取消请求已受理')); assert.ok(f.text().includes('正在取消')); assert.equal(f.cancel('job-1').props.disabled, true);
  assert.equal(f.calls.some((call) => call.route === 'apply'), false);
});

test('cancel locks duplicate clicks, reports unconfirmed failure without leaking errors and never retries automatically', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('后台任务');
  let release; f.setCancelGate(new Promise((resolve) => { release = resolve; })); f.setCancelFailure(true);
  const node = f.cancel('job-1'); node.props.onClick(); node.props.onClick(); await f.flush();
  assert.equal(f.calls.filter((call) => call.route === 'tasks/cancel').length, 1);
  assert.equal(f.cancel('job-1').props.disabled, true);
  release(); await f.flush(); assert.ok(f.text().includes('取消未得到确认')); assert.equal(f.text().includes('PRIVATE_CANCEL_INTERNAL_ERROR'), false);
  await f.click('刷新后台任务'); assert.equal(f.calls.filter((call) => call.route === 'tasks/cancel').length, 1);
});

test('invalid task scope and configuration application disable cancellation even when a stale handler is called', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.state.runtime.backgroundTasks.tasks[0].scope.identityId = '../invalid';
  await f.flush(); await f.click('后台任务'); assert.equal(f.cancel('job-1').props.disabled, true);
  f.cancel('job-1').props.onClick(); await f.flush(); assert.equal(f.calls.some((call) => call.route === 'tasks/cancel'), false);
  f.state.runtime.backgroundTasks.tasks[0].scope.identityId = 'default'; f.state.runtime.applying = true;
  await f.click('刷新后台任务'); assert.equal(f.cancel('job-1').props.disabled, true);
  f.cancel('job-1').props.onClick(); await f.flush(); assert.equal(f.calls.some((call) => call.route === 'tasks/cancel'), false);
});

test('background settings save atomically through config CAS, preserve drafts on failure and queue the apply while tasks run', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.state.runtime.busy = true;
  await f.flush(); await f.click('后台任务'); await f.toggle('-backgroundTasksEnabled', false); await f.toggle('-externalTaskRouting', false);
  await f.click('当前状态'); await f.click('后台任务'); await f.expandSettings();
  assert.equal(f.field('-backgroundTasksEnabled').props.checked, false);
  assert.equal(f.button('保存并应用').props.disabled, false, 'a busy runtime no longer disables the single save; it queues the apply');
  await f.click('保存并应用');
  assert.equal(f.calls.some((call) => call.route === 'config'), false, 'nothing is written while she is busy; the save is queued');
  assert(f.text().includes('自动保存并生效'), 'the queued apply intent is visible');
  f.setFailSave(true);
  f.state.runtime.busy = false; await f.click('刷新');
  assert.equal(f.field('-externalTaskRouting').props.checked, false, 'a queued save that still fails keeps the drafts');
  f.setFailSave(false); await f.click('保存并应用');
  const saved = f.calls.filter((call) => call.route === 'config').at(-1).payload;
  assert.deepEqual(saved, { revision: 'fixture-1', patch: { backgroundTasksEnabled: false, externalTaskRouting: false }, clearSecrets: [] });
  assert.equal(f.state.config.running.backgroundTasksEnabled, false, 'the single save applies once the runtime is idle');
  assert.equal(f.state.config.running.externalTaskRouting, false);
});

test('profile overrides stay read-only and reflect effective background settings', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.config.saved.externalTaskRouting = true; f.state.config.effective.externalTaskRouting = false;
  f.state.config.overriddenFields = ['externalTaskRouting'];
  await f.flush(); await f.click('后台任务'); await f.expandSettings(); const node = f.field('-externalTaskRouting');
  assert.equal(node.props.checked, false); assert.equal(node.props.disabled, true);
  node.props.onChange({ target: { checked: true } }); await f.flush(); assert.equal(f.field('-externalTaskRouting').props.checked, false);
  assert.ok(f.text().includes('请在 DSH 设置中修改此项。'));
  assert.ok(f.text().includes('本地保存值：开启 · 实际使用值：关闭'));
  assert.equal(f.calls.some((call) => call.route === 'config'), false);
});

test('unavailable service and optional executor snapshots stay readable; task text is rendered as inert text', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); delete f.state.runtime.backgroundTasks;
  await f.flush(); await f.click('后台任务'); assert.ok(f.text().includes('尚未读取后台任务')); assert.equal(f.text().includes('尚未返回执行器检测结果'), false);
  await f.expand('高级设置'); assert.ok(f.text().includes('尚未返回执行器检测结果'));
  f.state.runtime.backgroundTasks = { ready: false, tasks: [task({ status: 'unknown', statusText: '结果待核实', text: '<img src=x onerror=alert(1)>', delivery: 'failed', canCancel: false })] };
  await f.click('刷新后台任务'); assert.ok(f.text().includes('尚未就绪')); assert.ok(f.text().includes('部分操作可能已经执行'));
  await f.expand('查看结果'); assert.ok(f.text().includes('<img src=x onerror=alert(1)>')); assert.equal(f.nodes().some((node) => node.type === 'img' || node.props.dangerouslySetInnerHTML), false);
});

test('each connectivity button explicitly submits one nonce request to the selected executor and explains real QQ/model use', async (t) => {
  for (const [executor, label] of [['native', 'DSH 原生子代理'], ['codex', 'Codex'], ['zcode', 'Z Code'], ['minimax', 'MiniMax Code']]) {
    const f = fixture(); t.after(() => f.dispose());
    Object.assign(f.state.runtime.backgroundTasks, { active: 0, running: 0, queued: 0, tasks: [] });
    await f.flush(); await f.click('后台任务'); await f.expand('高级设置');
    assert.ok(f.text().includes('固定的只读测试任务')); assert.ok(f.text().includes('发给当前绑定主人 QQ')); assert.ok(f.text().includes('少量模型用量'));
    assert.equal(f.calls.some((call) => call.route === 'tasks/test'), false);
    const node = f.connectivity(label); assert(node); assert.equal(Boolean(node.props.disabled), false);
    node.props.onClick(); await f.flush();
    const sent = f.calls.filter((call) => call.route === 'tasks/test'); assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].payload, { executor, requestId: '00112233-4455-4677-8899-000000000001' });
    assert.equal(sent[0].method, 'POST'); assert.ok(f.text().includes('连通测试已受理，任务编号 connect-1'));
    assert.equal(f.cancel('connect-1').props.disabled, false, 'an accepted background test remains cancellable');
    assert.equal(f.connectivity(label).props.disabled, true, 'a running test blocks another test');
    assert.equal(f.calls.some((call) => ['apply', 'dependencies/action'].includes(call.route)), false);
  }
});

test('connectivity duplicate clicks are locked before dispatch and accepted tests do not block cancellation', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  Object.assign(f.state.runtime.backgroundTasks, { active: 0, running: 0, queued: 0, tasks: [] });
  await f.flush(); await f.click('后台任务'); await f.expand('高级设置');
  let release; f.setTestGate(new Promise((resolve) => { release = resolve; }));
  const node = f.connectivity('Codex'); node.props.onClick(); node.props.onClick(); await f.flush();
  assert.equal(f.calls.filter((call) => call.route === 'tasks/test').length, 1); assert.equal(f.connectivity('Codex').props.disabled, true);
  release(); await f.flush(); f.cancel('connect-1').props.onClick(); await f.flush();
  assert.equal(f.calls.filter((call) => call.route === 'tasks/cancel').length, 1);
  assert.equal(f.calls.filter((call) => call.route === 'tasks/test').length, 1);
});

test('runtime work or application blocks connectivity tests in both button and handler while running jobs remain cancellable', async (t) => {
  for (const mode of ['background', 'busy', 'applying']) {
    const f = fixture(); t.after(() => f.dispose());
    if (mode !== 'background') Object.assign(f.state.runtime.backgroundTasks, { active: 0, running: 0, queued: 0 });
    if (mode === 'busy') f.state.runtime.busy = true;
    if (mode === 'applying') f.state.runtime.applying = true;
    await f.flush(); await f.click('后台任务'); await f.expand('高级设置');
    const node = f.connectivity('Z Code'); assert.equal(node.props.disabled, true); node.props.onClick(); await f.flush();
    assert.equal(f.calls.some((call) => call.route === 'tasks/test'), false);
    assert.equal(f.cancel('job-1').props.disabled, mode === 'applying');
  }
});

test('connectivity failures preserve settings drafts, hide internal errors and only retry after another explicit click with a new UUID', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  Object.assign(f.state.runtime.backgroundTasks, { active: 0, running: 0, queued: 0, tasks: [] });
  await f.flush(); await f.click('后台任务'); await f.expand('高级设置'); await f.toggle('-externalTaskRouting', false);
  f.setTestFailure(true); f.connectivity('MiniMax Code').props.onClick(); await f.flush();
  assert.ok(f.text().includes('连通测试未得到确认')); assert.equal(f.text().includes('PRIVATE_TEST_INTERNAL_ERROR'), false);
  assert.equal(f.field('-externalTaskRouting').props.checked, false);
  await f.click('刷新后台任务'); assert.equal(f.calls.filter((call) => call.route === 'tasks/test').length, 1);
  f.setTestFailure(false); f.connectivity('MiniMax Code').props.onClick(); await f.flush();
  const sent = f.calls.filter((call) => call.route === 'tasks/test'); assert.equal(sent.length, 2);
  assert.notEqual(sent[0].payload.requestId, sent[1].payload.requestId);
  assert.equal(f.field('-externalTaskRouting').props.checked, false);
});

test('unknown executor detection remains not checked and successful tasks without errors show no failure explanation', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.backgroundTasks.executors = [{ name: 'codex', available: null, verified: false }];
  f.state.runtime.backgroundTasks.tasks = [task({ status: 'succeeded', statusText: '执行完成', text: '结果已确认', error: '', canCancel: false })];
  await f.flush(); await f.click('后台任务'); await f.expand('高级设置');
  assert.ok(f.text().includes('尚未检测')); assert.equal(f.text().includes('当前不可用'), false);
  const card = f.nodes().find((node) => node.type === 'article' && node.props['aria-label'] === '后台任务 job-1');
  await f.expand('查看结果');
  const resultCard = f.nodes().find((node) => node.type === 'article' && node.props['aria-label'] === '后台任务 job-1');
  assert.ok(f.text(resultCard).includes('结果已确认')); assert.equal(f.text(card).includes('执行说明：'), false);
  assert.equal(f.nodes(card).some((node) => node.props.role === 'alert' || node.props.className?.includes('dfy-error')), false);
});

test('workspace protection requires an unchecked manual confirmation and can be lifted while other tasks are queued without rerunning work', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.state.runtime.busy = true;
  Object.assign(f.state.runtime.backgroundTasks, { queued: 1, tasks: [task({ status: 'unknown', statusText: '结果待核实', canCancel: false, requiresVerification: true })] });
  await f.flush(); await f.click('后台任务');
  assert.ok(f.text().includes('该工作区暂停后续写任务；先核实旧执行器已停止。确认只解除保护，不会重做此任务。'));
  assert.ok(f.text().includes('我已核实旧执行器已停止'));
  assert.equal(f.verification('job-1').props.checked, false); assert.equal(f.acknowledge('job-1').props.disabled, true);
  f.acknowledge('job-1').props.onClick(); await f.flush(); assert.equal(f.calls.some((call) => call.route === 'tasks/acknowledge'), false);
  f.verification('job-1').props.onChange({ target: { checked: true } }); await f.flush();
  assert.equal(f.acknowledge('job-1').props.disabled, false);
  f.acknowledge('job-1').props.onClick(); await f.flush();
  assert.deepEqual(f.calls.filter((call) => call.route === 'tasks/acknowledge').map((call) => call.payload),
    [{ taskId: 'job-1', qq: '123', identityId: 'default', confirmedStopped: true }]);
  assert.equal(f.state.runtime.backgroundTasks.tasks[0].status, 'unknown');
  assert.equal(f.state.runtime.backgroundTasks.queued, 1); assert.equal(f.acknowledge('job-1'), undefined);
  assert.ok(f.text().includes('工作区保护已解除；未重新执行此任务。'));
  assert.equal(f.calls.some((call) => ['tasks/test', 'tasks/cancel', 'apply', 'config'].includes(call.route)), false);
});

test('workspace acknowledgment locks duplicate clicks, clears confirmation after failure, and never automatically retries', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.backgroundTasks.tasks = [task({ status: 'unknown', canCancel: false, requiresVerification: true })];
  await f.flush(); await f.click('后台任务');
  f.verification('job-1').props.onChange({ target: { checked: true } }); await f.flush();
  let release; f.setAcknowledgeGate(new Promise((resolve) => { release = resolve; })); f.setAcknowledgeFailure(true);
  const button = f.acknowledge('job-1'); button.props.onClick(); button.props.onClick(); await f.flush();
  assert.equal(f.calls.filter((call) => call.route === 'tasks/acknowledge').length, 1);
  assert.equal(f.verification('job-1').props.disabled, true); release(); await f.flush();
  assert.ok(f.text().includes('解除保护未得到确认')); assert.equal(f.text().includes('PRIVATE_ACKNOWLEDGE_INTERNAL_ERROR'), false);
  assert.equal(f.verification('job-1').props.checked, false); assert.equal(f.acknowledge('job-1').props.disabled, true);
  await f.click('刷新后台任务');
  assert.equal(f.calls.filter((call) => call.route === 'tasks/acknowledge').length, 1);
  f.acknowledge('job-1').props.onClick(); await f.flush();
  assert.equal(f.calls.filter((call) => call.route === 'tasks/acknowledge').length, 1);
});

test('workspace confirmation is scoped to one task identity and stale handlers cannot acknowledge after configuration application begins', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.backgroundTasks.tasks = [task({ status: 'unknown', canCancel: false, requiresVerification: true })];
  await f.flush(); await f.click('后台任务');
  f.verification('job-1').props.onChange({ target: { checked: true } }); await f.flush();
  const oldHandler = f.acknowledge('job-1').props.onClick;
  f.state.runtime.backgroundTasks.tasks[0].scope.identityId = 'alternate'; await f.click('刷新后台任务');
  assert.equal(f.verification('job-1').props.checked, false); assert.equal(f.acknowledge('job-1').props.disabled, true);
  oldHandler(); await f.flush(); assert.equal(f.calls.some((call) => call.route === 'tasks/acknowledge'), false);
  f.verification('job-1').props.onChange({ target: { checked: true } }); await f.flush();
  const beforeApplyHandler = f.acknowledge('job-1').props.onClick;
  f.state.runtime.applying = true; await f.click('刷新后台任务');
  assert.equal(f.verification('job-1').props.disabled, true); assert.equal(f.acknowledge('job-1').props.disabled, true);
  beforeApplyHandler(); await f.flush(); assert.equal(f.calls.some((call) => call.route === 'tasks/acknowledge'), false);
});
