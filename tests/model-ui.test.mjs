import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ModelPanel } from '../packages/dsh-dafeiyu/src/model-panel.js';

// Run the shipped component and its real owner service; only React and the
// HTTP/settings boundary are isolated fixtures. No model, browser or network.
function fixture(t, { emptySelection = false, apiProvider = 'api', emptyApiCatalog = false,
  connectionStatus = { available: true, busy: false, blocked: false } } = {}) {
  let selection = emptySelection ? {} : { provider: 'deepseek-account', model: 'account-current' };
  let selectionRevision = 10, providerRevision = 2, accountCatalogCalls = 0, apiCatalogCalls = 0;
  let hooks = [], cursor = 0, effects = [], dirty = false, tree, pageDirty = false;
  const calls = [], mutations = [], selections = [], schema = fields => ({ type: 'object', dict: Object.fromEntries(fields.map(field => [field, { type: 'string' }])) });
  const apiProfile = { baseURL: 'https://api.example.invalid/v1', models: [] };
  const services = {
    settings: { writable: true, describe: () => [
      { ns: 'owner-default-model', revision: selectionRevision, value: { ...selection }, schema: schema(['provider', 'model', 'reasoningEffort']) },
      { ns: 'account-provider', revision: providerRevision, value: {}, schema: schema([]) },
      { ns: 'api-provider', revision: providerRevision, value: { ...apiProfile }, schema: schema(['baseURL', 'apiKeyEnv']) },
    ], async mutate(ns, ops, revision) {
      mutations.push({ ns, ops, revision }); assert.equal(ns, 'owner-default-model'); assert.equal(revision, selectionRevision);
      for (const op of ops) { if (op.op === 'set') selection[op.path[0]] = op.value; else delete selection[op.path[0]]; }
      selectionRevision++; selections.push({ ...selection });
    } },
    agentDefaultModel: { ownerContext: { fiber: { entry: { options: { id: 'owner-default-model' } } } }, currentSelection: () => ({ ...selection }) },
    llm: { listProviders: () => [{ id: 'deepseek-account' }, { id: apiProvider }],
      listConfigurableProviders: () => [
        { provider: 'deepseek-account', displayName: '账号服务', settingsNs: 'account-provider', settingsPath: [] },
        { provider: apiProvider, displayName: 'API 服务', settingsNs: 'api-provider', settingsPath: [] },
      ],
      async listModels(provider) {
        if (provider === 'deepseek-account') { accountCatalogCalls++; return ['account-current', 'account-other'].map(id => ({ provider, id, name: id })); }
        apiCatalogCalls++; return (emptyApiCatalog ? [] : ['api-one', 'api-two']).map(id => ({ provider, id, name: id }));
      },
      discoverModels(_ns, request) { assert.notEqual(request.provider, 'deepseek-account'); return ['api-one', 'api-two'].map(id => ({ id })); },
      prepareCall() { assert.fail('catalog and selection never call a paid model'); },
    },
    credentials: { describe: async () => ({ configured: false, writable: true }) },
  };
  const service = new ModelPanel({ getService: name => services[name], getConnectionTestStatus: () => connectionStatus,
    runConnectionTest() { assert.fail('UI tests must not dispatch a real or simulated model request'); } });
  const api = { alive: { current: true }, async call(route, method = 'GET', payload) {
    payload = payload === undefined ? undefined : structuredClone(payload); calls.push({ route, method, payload });
    if (route === 'model/status') return { ok: true, model: await service.snapshot() };
    assert.equal(method, 'POST');
    if (route === 'model/probe') return service.probe(payload, { authorize: () => true });
    if (route === 'model/selection') return { ok: true, model: await service.saveSelection(payload, { authorize: () => true }) };
    assert.fail('Unexpected API ' + route);
  } };
  const React = { Fragment: Symbol('fragment'), createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useState(initial) { const i = cursor++; hooks[i] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, next => { next = typeof next === 'function' ? next(hooks[i].value) : next; if (!Object.is(next, hooks[i].value)) { hooks[i].value = next; dirty = true; } }]; },
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++, old = hooks[i]; if (!old || !deps || deps.some((value, at) => !Object.is(value, old.deps?.[at]))) {
      hooks[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = effect(); });
    } },
  };
  const shipped = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
  const start = shipped.indexOf('    function ModelPanel('), end = shipped.indexOf('    function SpeechInputPanel(', start);
  assert.ok(start > 0 && end > start);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const Component = vm.runInNewContext('(' + shipped.slice(start, end).trim() + ')', { React, ...React, h: React.createElement, usePanelApi: () => api,
    own: (object, key) => Object.hasOwn(object, key), equal,
    sameModelSelection: (a, b) => Boolean(a && b && a.provider === b.provider && a.model === b.model),
    selectionLabel: value => value ? value.provider + '/' + value.model : '尚未选择',
    errorText: error => error.message, displayTime: value => value || '',
    HelpTip: () => null, SectionHeading: () => null, Advanced: () => null });
  t.after(() => { api.alive.current = false; hooks.forEach(hook => hook.cleanup?.()); });
  const flatten = node => node == null || node === false || typeof node !== 'object' ? [] : [node, ...(node.props?.children || []).flatMap(flatten)];
  const content = node => node == null || node === false ? '' : typeof node === 'object' ? (node.props?.children || []).map(content).join('') : String(node);
  const props = { active: true, onDirtyChange: value => { pageDirty = value; }, canRebind: false };
  async function flush() { for (let round = 0; round < 30; round++) { dirty = false; cursor = 0; effects = []; tree = Component(props);
    effects.splice(0).forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve)); if (!dirty) return;
  } assert.fail('component did not settle'); }
  const field = suffix => flatten(tree).find(node => node.props?.id?.endsWith(suffix)
    && (suffix !== '-provider' || !node.props.id.endsWith('-default-provider')));
  const button = label => flatten(tree).find(node => node.type === 'button' && content(node) === label);
  return { calls, mutations, selections, service, flush, field, button, text: () => content(tree),
    get accountCatalogCalls() { return accountCatalogCalls; }, get apiCatalogCalls() { return apiCatalogCalls; }, get pageDirty() { return pageDirty; },
    async change(suffix, value) { const node = field(suffix); assert.ok(node, suffix); assert.equal(Boolean(node.props.disabled), false); node.props.onChange({ target: { value } }); await flush(); },
    async click(label) { const node = button(label); assert.ok(node, label); assert.equal(Boolean(node.props.disabled), false); await node.props.onClick(); await flush(); },
    changeExternalSelection(value) { selection = value; selectionRevision++; },
  };
}

test('explicit account catalog check updates the rendered model dropdown and can select the newly returned model', async t => {
  const f = fixture(t); await f.flush();
  assert.equal(f.accountCatalogCalls, 0); assert.equal(f.field('-default-model').props.children.length, 1);
  await f.click('检查模型列表');
  assert.equal(f.accountCatalogCalls, 1);
  assert.deepEqual(f.field('-default-model').props.children.map(option => option.props.value), ['account-current', 'account-other']);
  assert.equal(f.mutations.length, 0, 'catalog metadata never switches the current model');
  await f.change('-default-model', 'account-other'); assert.equal(f.pageDirty, true);
  await f.click('使用此模型');
  assert.equal(f.field('-default-model').props.value, 'account-other'); assert.equal(f.pageDirty, false);
  assert.equal(f.mutations.length, 1); assert.equal(f.mutations[0].ns, 'owner-default-model');
});

test('an empty default chooses a usable local catalog in the form and persists only after the owner clicks use', async t => {
  const f = fixture(t, { emptySelection: true }); await f.flush();
  assert.equal(f.field('-default-provider').props.value, 'api'); assert.equal(f.field('-default-model').props.value, 'api-one');
  assert.equal(f.mutations.length, 0); assert.equal(f.accountCatalogCalls, 0);
  await f.click('使用此模型');
  assert.deepEqual(f.calls.find(call => call.route === 'model/selection').payload, { provider: 'api', model: 'api-one', expectedSelection: null });
  assert.deepEqual(f.selections, [{ provider: 'api', model: 'api-one' }]);
});

test('catalog adoption preserves a model selection draft and detects another window initializing the default', async t => {
  const f = fixture(t, { emptySelection: true }); await f.flush();
  await f.change('-default-model', 'api-two');
  await f.click('检查模型列表');
  assert.equal(f.field('-default-model').props.value, 'api-two'); assert.equal(f.pageDirty, true);
  f.changeExternalSelection({ provider: 'api', model: 'api-one' }); await f.click('刷新');
  assert.equal(f.field('-default-model').props.value, 'api-two'); assert.equal(f.button('使用此模型').props.disabled, true);
  assert(f.text().includes('默认模型已被其他操作改变')); assert.equal(f.mutations.length, 0);
});

test('updating the account catalog keeps another provider connection draft and its conflict baseline', async t => {
  const f = fixture(t); await f.flush();
  await f.change('-provider', 'api'); await f.change('-baseURL', 'https://draft.example.invalid/v1');
  await f.change('-provider', 'deepseek-account'); await f.click('检查模型列表');
  await f.change('-provider', 'api');
  assert.equal(f.field('-baseURL').props.value, 'https://draft.example.invalid/v1'); assert.equal(f.pageDirty, true);
  assert.equal(f.mutations.length, 0);
});

test('the official account adapter explains host login without showing API-key absence as a logged-out state', async t => {
  const f = fixture(t); await f.flush();
  assert(f.text().includes('DSH 账号登录'));
  assert(f.text().includes('账号与余额'));
  assert.equal(f.field('-apiKey'), undefined); assert.equal(f.field('-baseURL'), undefined);
  assert.equal(f.mutations.length, 0); assert.equal(f.accountCatalogCalls, 0);
  await f.change('-provider', 'api');
  assert.ok(f.field('-baseURL')); assert.ok(f.field('-apiKey'), 'ordinary API-provider editing remains available');
});

test('the two official DeepSeek routes are labeled separately and a new API key remains an unsaved editable draft', async t => {
  const f = fixture(t, { apiProvider: 'deepseek-official' }); await f.flush();
  assert(f.text().includes('DeepSeek（DSH账号）')); assert(f.text().includes('DeepSeek（API Key）'));
  assert(f.text().includes('切换“连接设置”只编辑')); assert(f.text().includes('要使用自己的 API Key'));
  await f.change('-provider', 'deepseek-official');
  assert.equal(f.field('-apiKey').props.type, 'password'); assert.equal(Boolean(f.field('-apiKey').props.disabled), false);
  await f.change('-apiKey', 'DRAFT_CANARY_NOT_REAL');
  assert.equal(f.field('-apiKey').props.value, 'DRAFT_CANARY_NOT_REAL');
  assert.equal(f.field('-default-provider').props.value, 'deepseek-account', 'editing API credentials never changes the active chat route');
  assert.equal(Boolean(f.button('测试连接').props.disabled), true);
  assert(f.text().includes('请先保存连接设置，再测试连接'));
  assert(f.text().includes('可输入新的 API Key 替换'));
  assert.equal(f.calls.some(call => call.method === 'POST'), false); assert.equal(f.mutations.length, 0);
  await f.change('-apiKey', ''); assert.equal(f.pageDirty, false); assert.equal(f.field('-apiKey').props.value, '');
});

test('a provider with no model shows the reason beside the disabled test and can explicitly check its directory', async t => {
  const f = fixture(t, { emptyApiCatalog: true }); await f.flush(); await f.change('-provider', 'api');
  assert.equal(Boolean(f.button('测试连接').props.disabled), true);
  assert(f.text().includes('尚无可用模型，请点击“检查模型列表”'));
  assert.equal(Boolean(f.button('检查模型列表').props.disabled), false);
  await f.click('检查模型列表');
  assert.equal(f.calls.filter(call => call.route === 'model/probe').length, 1);
  assert.equal(f.calls.some(call => call.route === 'model/test'), false); assert.equal(f.mutations.length, 0);
});

test('test unavailability, actual worker occupancy and unresolved usage each have an evidence-backed visible reason', async t => {
  for (const [connectionStatus, expected] of [
    [{ available: false, busy: false, blocked: false }, '模型测试入口尚未就绪'],
    [{ available: true, busy: true, blocked: false }, '上次模型测试仍在执行或收尾'],
    [{ available: true, busy: false, blocked: true }, '执行或用量仍待核实'],
  ]) {
    const f = fixture(t, { connectionStatus }); await f.flush();
    assert.equal(Boolean(f.button('测试连接').props.disabled), true); assert(f.text().includes(expected));
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
  }
});
