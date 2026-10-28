import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const client = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
const primaryIdentity = () => ({ id: 'default', name: '默认身份', relationType: 'existing', userRole: '',
  companionRole: '', userTitle: '', companionTitle: '', description: '' });
const primaryAccount = () => ({ qq: '123', name: '主要使用者', enabled: true,
  activeIdentityId: 'default', identities: [primaryIdentity()] });

// Executes the shipped native module and its actual event handlers with isolated
// hooks and API fixtures; no host/profile, QQ login, model or device is accessed.
function fixture({ model = { providers: [], writable: false, speech: { providers: [], selection: null, available: false } } } = {}) {
  let component, hookIndex, root, tree, effects = [], dirty = false, serial = 1, revision = 1;
  const instances = new Map(), calls = [], timers = new Map();
  const documentListeners = new Map();
  const captures = (options) => options === true || options?.capture === true;
  const documentFixture = { hidden: false,
    addEventListener(type, listener, options) {
      const entries = documentListeners.get(type) || [];
      if (!entries.some((entry) => entry.listener === listener && entry.capture === captures(options))) {
        entries.push({ listener, capture: captures(options) }); documentListeners.set(type, entries);
      }
    },
    removeEventListener(type, listener, options) {
      documentListeners.set(type, (documentListeners.get(type) || []).filter((entry) =>
        entry.listener !== listener || entry.capture !== captures(options)));
    },
  };
  const state = { ok: true, canApply: true, pendingReload: false,
    config: { revision: 'fixture-1', saved: { ownerQq: '123', onebotSelfId: '456', onebotEngine: 'native' },
      effective: { ownerQq: '123', onebotSelfId: '456', onebotEngine: 'native', qqAccounts: [primaryAccount()] },
      running: { ownerQq: '123', qqAccounts: [primaryAccount()] }, overriddenFields: [], secretConfigured: { effective: {} } },
    runtime: { ready: true, busy: false, personalQQ: { enabled: true, configured: true, connected: false },
      companion: { pending: 0 }, phone: { state: 'not-probed' }, model: {} }, paths: {} };
  let login = { isLogin: false, phase: 'waiting_qrcode', qrcodeRevision: 'a'.repeat(64), issue: null };
  const dependencies = { checkedAt: '2026-10-23T09:00:00Z', busy: false, items: ['napcat', 'linux-qq'].map((id) => ({
    id, name: id === 'napcat' ? 'NapCat QQ 接入' : '容器内 Linux QQ', installed: true, health: 'ready',
    actions: [{ id: 'restart', label: '重启 QQ 服务', enabled: true }],
  })) };
  let nextQrRevision = null, failSave = false, failStatus = false, stateReadGate = null, conversationFailure = null, conversationGate = null, napcatOverrides = {};
  let memoryRevision = 'a'.repeat(64), memorySerial = 10, failMemory = false;
  const memoryItems = [{ id: 'fact-fixture', kind: 'fact', summary: '喜欢热茶', detail: '日常喜欢喝热茶。', source: 'memory/facts.json',
    scope: { type: 'account', accountId: '123' }, provenance: { type: 'legacy', confirmed: null }, status: 'active', history: [], canRestore: false }];
  const memoryUndo = [];
  const life = { memory: { revision: 'a'.repeat(64), policy: { learningEnabled: false, growthEnabled: false, detailedDays: 3, summaryDays: 30 }, items: [], total: 0, offset: 0, limit: 50, growth: [] },
    autonomy: { policy: { enabled: false, proactive: false, browse: false, quietStart: 23, quietEnd: 9, minGapMinutes: 90, maxContacts: 2, maxActivities: 4, sessionSeconds: 600, platforms: [], targets: [] },
      wallet: { policy: { enabled: false, dailySeconds: 0, monthlySeconds: 0 }, balance: 0, dailyRemainingSeconds: 0, transactions: [], sessions: [] }, activities: [], running: false },
    preview: { eligible: false, reason: '自主活动未开启' } };
  const persona = { text: '性格温柔，喜欢聊海洋。', editable: true, configured: true, revision: 'persona-1',
    sourceLabel: 'fixture/persona.md', injectionMaxChars: 10000 };
  const tokens = { revision: 'tokens-1', policy: { enabled: false, dailyTokens: 0, monthlyTokens: 0, requestReserveTokens: 16384 },
    balanceTokens: 0, dailyRemainingTokens: 0, reservedTokens: 0, availableTokens: 0, unmeteredCount: 0, pendingUnknownCount: 0, overdrawnTokens: 0,
    today: { userTaskTokens: 0, autonomyTokens: 0, freeTokens: 0, pocketTokens: 0 }, requests: [], transactions: [] };
  const meme = { id: 'meme-fixture', title: '晚安小鲸鱼', file: 'fixture-whale.png', tags: ['晚安'],
    description: '小鲸鱼缩在被子里，表示困了想休息。', aiDescription: '', descriptionStatus: 'ready', revision: 'meme-1' };
  const React = {
    Fragment: Symbol('fragment'),
    createElement(type, props, ...children) { return { type, props: { ...(props || {}), children: children.flat(Infinity) } }; },
    useState(initial) {
      const instance = component, index = hookIndex++;
      if (!instance.hooks[index]) instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      const hook = instance.hooks[index];
      hook.set ||= (next) => { const value = typeof next === 'function' ? next(hook.value) : next;
        if (!Object.is(value, hook.value)) { hook.value = value; dirty = true; } };
      return [hook.value, hook.set];
    },
    useRef(initial) { return component.hooks[hookIndex++] ||= { current: initial }; },
    useEffect(effect, deps) {
      const instance = component, index = hookIndex++, old = instance.hooks[index];
      if (!old || !deps || deps.some((value, item) => !Object.is(value, old.deps?.[item]))) {
        instance.hooks[index] = { deps, cleanup: old?.cleanup };
        effects.push(() => { old?.cleanup?.(); instance.hooks[index].cleanup = effect(); });
      }
    },
  };
  const context = {
    window: { __ModuleLoader__: { load({ factory }) {
      factory((name) => { assert.equal(name, 'react'); return React; }).apply({ slots: {
        inject(_name, callback) { callback(); }, register(_definition, render) { root = render(); },
      } });
    } } },
    document: documentFixture, AbortController, TextEncoder, URLSearchParams, Date, Math,
    setTimeout(fn, ms) { const id = serial++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => {
      const route = url.split('/api/')[1], method = options.method || 'GET';
      const payload = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ route, method, payload });
      let value, status = 200;
      if (route === 'state') { if (stateReadGate) await stateReadGate; value = state; }
      else if (route === 'tokens/status') value = { ok: true, tokens };
      else if (route.startsWith('life?')) value = { ok: true, life };
      else if (route === 'life/action') {
        assert.equal(method, 'POST'); assert.equal(payload.action, 'memory-policy'); assert.equal(payload.input.revision, life.memory.revision);
        Object.assign(life.memory.policy, payload.input.patch); life.memory.revision = 'b'.repeat(64); value = { ok: true, life };
      }
      else if (route === 'persona') {
        if (method === 'POST') {
          assert.equal(payload.revision, persona.revision);
          Object.assign(persona, { text: payload.text, revision: 'persona-2' });
        }
        value = { ok: true, persona, appliesNextTurn: true };
      } else if (route.startsWith('memes?')) value = { ok: true, gallery: { items: [meme], total: 1, offset: 0, limit: 24, warnings: [] } };
      else if (route.startsWith('meme-detail?')) value = { ok: true, meme };
      else if (route.startsWith('meme-image?')) { status = 503; value = { ok: false }; }
      else if (route === 'meme-metadata') {
        assert.equal(payload.id, meme.id); assert.equal(payload.revision, meme.revision);
        Object.assign(meme, payload.patch, { revision: 'meme-2' }); value = { ok: true, meme };
      }
      else if (route === 'model/status') value = { ok: true, model };
      else if (route === 'voice/status') value = { ok: true, voice: { config: { revision: 'voice-1',
        saved: { ttsProvider: 'macos', voiceReplyEnabled: false } }, runtime: { enabled: false } } };
      else if (route.startsWith('memory?')) {
        const params = new URLSearchParams(route.split('?')[1]);
        const items = memoryItems.filter((item) => !params.get('query') || (item.summary + item.detail).includes(params.get('query')));
        value = { ok: true, memory: { revision: memoryRevision, items, total: items.length, offset: 0, limit: 50 } };
      } else if (route.startsWith('memory/')) {
        if (failMemory) { status = 500; value = { ok: false, error: 'fixture memory save failure' }; }
        else if (payload.revision !== memoryRevision) { status = 409; value = { ok: false, code: 'CONFLICT', error: 'fixture memory revision conflict' }; }
        else {
          const record = memoryItems.find((item) => item.id === payload.id); assert(record);
          if (route.endsWith('/restore')) Object.assign(record, memoryUndo.pop());
          else {
            memoryUndo.push(structuredClone(record));
            if (route.endsWith('/forget')) record.status = 'forgotten';
            else Object.assign(record, { summary: payload.summary, detail: payload.detail,
              provenance: { type: payload.sourceType, confirmed: payload.confirmed }, status: payload.confirmed ? 'active' : 'unconfirmed' });
          }
          record.canRestore = memoryUndo.length > 0; record.history = [{ at: '2026-10-23T09:00:00Z', action: route.split('/')[1] }];
          memoryRevision = (++memorySerial).toString(16).padStart(64, '0');
          value = { ok: true, memory: { saved: true, record, revision: memoryRevision } };
        }
      }
      else if (route === 'config') {
        if (failSave) { status = 500; value = { ok: false, error: 'fixture save failure' }; }
        else if (payload.revision !== state.config.revision) { status = 409; value = { ok: false, code: 'CONFLICT', error: 'fixture revision conflict' }; }
        else {
          state.config.saved = { ...state.config.saved, ...payload.patch };
          state.config.effective = { ...state.config.effective, ...payload.patch };
          state.config.revision = 'fixture-' + (++revision); state.pendingReload = true; value = state;
        }
      } else if (route === 'apply') {
        state.config.running = structuredClone(state.config.effective); state.pendingReload = false;
        value = { ok: true };
      } else if (route === 'phone/check') value = { ok: true, state };
      else if (route === 'dependencies') value = { ok: true, dependencies };
      else if (route === 'dependencies/action') value = { ok: true, dependencies, result: { accepted: true } };
      else if (route.startsWith('conversations/')) {
        if (conversationGate) await conversationGate;
        const item = state.runtime.companion.conversations.find((candidate) => candidate.qq === payload.qq && candidate.identityId === payload.identityId);
        assert(item); assert(!payload.text, 'conversation controls never replay a body');
        if (conversationFailure) { status = 409; value = { ok: false, ...conversationFailure }; }
        else {
          if (route === 'conversations/stop') Object.assign(item, { state: 'blocked', running: false, queued: 0,
            canStop: false, canRecover: true, requiresUncertainAcknowledgement: true, failureType: 'stopped' });
          else {
            if (item.requiresUncertainAcknowledgement) assert.equal(payload.acknowledgeUncertain, true);
            if (item.controlVersion) assert.equal(payload.controlVersion, item.controlVersion);
            if (payload.freshSession) assert(['context_required', 'context_compaction_failed', 'context_guard_unavailable'].includes(item.failureType));
            Object.assign(item, { state: 'idle', canRecover: false, requiresUncertainAcknowledgement: false });
          }
          value = { ok: true, result: { freshSession: payload.freshSession === true, message: 'fixture raw detail must not display' }, state };
        }
      }
      else if (route === 'napcat/status') {
        if (failStatus) { status = 503; value = { ok: false, error: 'fixture status failure' }; }
        else value = { ok: true, napcat: { configured: true, container: { available: true, running: true },
          webui: { reachable: true, authenticated: true }, ...napcatOverrides, login } };
      } else if (route === 'napcat/qrcode') {
        if (payload.refresh) login = { ...login, phase: 'waiting_qrcode', issue: null,
          qrcodeRevision: nextQrRevision || 'b'.repeat(64) };
        value = { ok: true, qrcode: { available: true, image: { mime: 'image/png', base64: 'fixture-png' },
          revision: login.qrcodeRevision, checkedAt: '2026-10-23T09:00:00Z' } };
      } else assert.fail('Unexpected API: ' + route);
      return { ok: status === 200, status, json: async () => structuredClone(value) };
    },
  };
  vm.runInNewContext(client, context);
  function render(node, path = 'root') {
    if (node == null || node === false) return null;
    if (typeof node !== 'object') return String(node);
    if (typeof node.type === 'function') {
      const key = path + ':' + node.type.name;
      let instance = instances.get(key);
      if (!instance) { instance = { hooks: [] }; instances.set(key, instance); }
      const previous = component; component = instance; hookIndex = 0;
      const child = node.type(node.props); component = previous;
      return render(child, path + 'f');
    }
    return { ...node, props: { ...node.props, children: node.props.children.map((child, index) =>
      render(child, path + '.' + (child?.props?.key ?? index))) } };
  }
  async function flush() {
    for (let iteration = 0; iteration < 30; iteration++) {
      dirty = false; tree = render(root); const pending = effects; effects = [];
      for (const effect of pending) effect();
      await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve));
      if (!dirty && !effects.length) return;
    }
    assert.fail('UI did not settle');
  }
  const nodes = (node = tree, visible = true) => !node || typeof node !== 'object' || (visible && node.props.hidden) ? []
    : [node, ...node.props.children.flatMap((child) => nodes(child, visible))];
  const text = (node = tree) => typeof node === 'string' ? node : node?.props?.hidden ? '' : node?.props?.children.map((child) => text(child)).join('') || '';
  const aliases = { 'QQ 连接': 'QQ账号', '当前状态': '首页', '账号与身份': '聊天对象',
    '管理用户账号与身份': '聊天对象', '管理账号与关系': '聊天对象', '依赖与更新': '安装与更新', '手机权限': '手机',
    '仅保存': '保存', '保存并生效': '保存', '保存并应用': '保存', '刷新': '刷新状态', '停用 / 遗忘此条': '不再记住',
    '打开 QQ 服务维护': '管理 QQ 服务', '获取当前二维码': '显示二维码', '检测手机连接': '检查连接' };
  const button = (label) => nodes().find((node) => ['button', 'summary'].includes(node.type) && [label, aliases[label]].includes(text(node)));
  const groupOf = { 'QQ账号': '聊天', '聊天对象': '聊天', '任务': '聊天', '性格': '她', '记忆': '她',
    '表情包': '她', '生活与成长': '她', '模型服务': '高级', '声音': '高级', '手机': '高级',
    '安装与更新': '高级', '视频平台': '高级', '功能': '高级' };
  async function click(label) {
    let target = button(label);
    if (!target && groupOf[aliases[label] || label]) {
      await click(groupOf[aliases[label] || label]); target = button(label);
    }
    assert(target, 'Missing button: ' + label); assert(!target.props.disabled, 'Disabled button: ' + label);
    if (target.props.onClick) target.props.onClick();
    else if (target.props.type === 'submit') nodes().find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
    else assert.fail('Missing handler: ' + label);
    await flush();
  }
  const field = (suffix) => nodes().find((node) => ['input', 'textarea', 'select'].includes(node.type) && node.props.id?.endsWith(suffix));
  async function change(suffix, value, checked) {
    const target = field(suffix); assert(target, 'Missing field: ' + suffix); assert(!target.props.disabled, 'Disabled field: ' + suffix);
    target.props.onChange({ target: { value, ...(checked === undefined ? {} : { checked }) } }); await flush();
  }
  return { state, calls, flush, nodes, text, button, click, field, change,
    addDocumentListener(type, listener, options) {
      documentFixture.addEventListener(type, listener, options);
      return () => documentFixture.removeEventListener(type, listener, options);
    },
    documentListenerCount(type) { return (documentListeners.get(type) || []).length; },
    dispatchDocumentKey(key) {
      const event = { key, defaultPrevented: false, cancelBubble: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } };
      const entries = [...(documentListeners.get('keydown') || [])];
      for (const capture of [true, false]) {
        if (!capture && event.cancelBubble) break;
        for (const entry of entries.filter((entry) => entry.capture === capture)) entry.listener(event);
      }
      return event;
    },
    setFailSave(value) { failSave = value; }, setLogin(patch) { login = { ...login, ...patch }; },
    setNapcat(patch) { napcatOverrides = { ...napcatOverrides, ...patch }; },
    setStateReadGate(value) { stateReadGate = value; },
    setConversationFailure(value) { conversationFailure = value; }, setConversationGate(value) { conversationGate = value; },
    setFailStatus(value) { failStatus = value; }, setNextQrRevision(value) { nextQrRevision = value; },
    memoryItems, setFailMemory(value) { failMemory = value; }, externalMemoryChange(patch) { Object.assign(memoryItems[0], patch); memoryRevision = 'b'.repeat(64); },
    async tickTimers(ms) { const pending = [...timers.entries()].filter(([, timer]) => timer.ms === ms);
      for (const [id, timer] of pending) { timers.delete(id); await timer.fn(); } await flush(); },
    async tickPolls() { const pending = [...timers.entries()].filter(([, timer]) => timer.ms === 5000);
      for (const [id, timer] of pending) { timers.delete(id); await timer.fn(); } await flush(); },
    externalChange(patch = {}) { Object.assign(state.config.effective, patch); Object.assign(state.config.saved, patch);
      state.config.revision = 'fixture-' + (++revision); },
    dispose() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); },
  };
}

test('ordinary navigation exposes four groups and every page without dispatching writes', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  const main = () => f.nodes().find((node) => node.props.role === 'tablist' && node.props['aria-label'] === '大肥鱼');
  assert.deepEqual(main().props.children.map((node) => f.text(node)), ['首页', '她', '聊天', '高级']);
  assert.equal(f.nodes().filter((node) => node.props.role === 'tab').length, 4, 'the home view has no secondary tabs');
  const openingCalls = f.calls.length; await f.click('高级');
  assert.equal(f.calls.slice(openingCalls).filter((call) => call.method === 'POST').length, 0,
    'opening a group may read its first page but never writes');
  for (const [label, key, group] of [['QQ账号', 'qq', '聊天'], ['聊天对象', 'accounts', '聊天'], ['模型服务', 'model', '高级'], ['声音', 'voice', '高级'],
    ['性格', 'persona', '她'], ['手机', 'phone', '高级'], ['安装与更新', 'dependencies', '高级']]) {
    await f.click(group); await f.click(label);
    assert(f.nodes().some((node) => node.props.role === 'tabpanel' && node.props.id?.endsWith('-content-' + key)), label + ' opens its own page');
    assert(f.nodes().some((node) => node.props.role === 'tab' && f.text(node) === label && node.props['aria-selected'] === true));
    assert(!f.text().includes('Unexpected API'), label + ' is backed by the expected read-only fixtures');
  }
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0, 'category browsing never installs, logs in, tests, connects, saves or applies');
});

test('receiving voice refresh reads the current parent runtime without starting recognition, preparation or a probe', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.voiceInput = { configured: true, receiveEnabled: true, readiness: 'not-verified', active: 0 };
  await f.flush(); await f.click('声音');
  const section = () => f.nodes().find((node) => node.type === 'section'
    && f.nodes(node).some((child) => child.type === 'h3' && f.text(child) === '接收语音'));
  assert.ok(f.text(section()).includes('尚未实际验证'));
  Object.assign(f.state.runtime.voiceInput, { readiness: 'ready', lastResult: { ok: true, at: '2026-10-25T06:20:00Z' } });
  const before = f.calls.length;
  await f.click('刷新状态');
  assert.ok(f.text(section()).includes('最近识别成功'));
  assert.deepEqual(f.calls.slice(before).filter((call) => call.route === 'state'), [{ route: 'state', method: 'GET', payload: undefined }]);
  assert.ok(f.calls.slice(before).every((call) => call.method === 'GET' && ['state', 'voice/status'].includes(call.route)),
    'refresh only reads snapshots; no recognition, model, dependency, download or connection probe runs');
});

test('receiving voice refresh retains both the parent switch draft and the independent voice-output draft', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('声音');
  await f.change('-voiceTranscription', true, true);
  await f.change('-auto-voice', true, true);
  const before = f.calls.length;
  await f.click('刷新状态');
  assert.equal(f.field('-voiceTranscription').props.checked, true);
  assert.equal(f.field('-auto-voice').props.checked, true);
  assert.equal(f.state.config.saved.voiceTranscription, undefined);
  assert.ok(f.text().includes('未保存的草稿已保留'));
  assert.ok(f.button('放弃语音草稿'));
  assert.ok(f.calls.slice(before).every((call) => call.method === 'GET'));
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('receiving voice refresh follows the parent operation lock and cannot overlap duplicate refresh clicks', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('声音');
  let release; f.setStateReadGate(new Promise((resolve) => { release = resolve; }));
  const before = f.calls.length, staleClick = f.button('刷新状态').props.onClick;
  staleClick(); staleClick(); await f.flush();
  assert.equal(f.calls.slice(before).filter((call) => call.route === 'state').length, 1);
  assert.equal(f.button('刷新中…').props.disabled, true);
  release(); await f.flush();
  assert.equal(f.button('刷新状态').props.disabled, false);
  assert.equal(f.calls.slice(before).filter((call) => call.route === 'state').length, 1);
});

test('life panel integrates with consumer navigation and retains its unsaved-draft badge until its own save', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('生活与成长');
  assert(f.text().includes('娱乐时间钱包')); assert(f.calls.some((call) => call.route.startsWith('life?') && call.method === 'GET'));
  const label = f.nodes().find((node) => node.type === 'label' && f.text(node).includes('自动整理日常聊天'));
  const checkbox = f.nodes(label).find((node) => node.type === 'input');
  checkbox.props.onChange({ target: { checked: true } }); await f.flush();
  const tab = () => f.nodes().find((node) => node.props.role === 'tab' && f.text(node) === '生活与成长');
  const herTab = () => f.nodes().find((node) => node.props.role === 'tab' && f.text(node) === '她');
  assert.equal(tab().props['data-dirty'], true);
  await f.click('首页'); assert.equal(herTab().props['data-dirty'], true, 'navigation preserves the child draft on the group tab');
  await f.click('生活与成长'); await f.click('保存记忆与成长设置');
  assert.equal(tab().props['data-dirty'], undefined);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(f.calls.find((call) => call.method === 'POST').route, 'life/action');
});

test('life token draft is independent from legacy life responses and both forms survive a read-only token refresh', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  assert.equal(f.calls.some((row) => row.route === 'tokens/status'), false);
  await f.click('生活与成长');
  assert.ok(f.text().includes('Token 与零花钱')); assert.ok(f.text().includes('娱乐时间钱包'));
  const learning = () => f.nodes().find((node) => node.type === 'label' && f.text(node).trim().endsWith('自动整理日常聊天'));
  f.nodes(learning()).find((node) => node.type === 'input').props.onChange({ target: { checked: true } }); await f.flush();
  await f.click('高级设置'); await f.change('-dailyTokens', '100');
  await f.click('刷新 Token 状态');
  assert.equal(f.field('-dailyTokens').props.value, '100');
  assert.equal(f.nodes(learning()).find((node) => node.type === 'input').props.checked, true);
  assert.equal(f.button('生活与成长').props['data-dirty'], true);
  await f.click('刷新');
  assert.equal(f.nodes(learning()).find((node) => node.type === 'input').props.checked, true, 'refresh preserves unsaved life settings');
  await f.click('撤销未保存修改');
  assert.equal(f.nodes(learning()).find((node) => node.type === 'input').props.checked, false);
  assert.equal(f.field('-dailyTokens').props.value, '100', 'refreshing legacy life data cannot discard the token draft');
  assert.equal(f.button('生活与成长').props['data-dirty'], true);
  await f.click('放弃 Token 设置草稿');
  assert.equal(f.button('生活与成长').props['data-dirty'], undefined);
  assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0);
});

test('boss and female-underling relation is an explicit ordinary choice without exposing role fields or switching identities', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('聊天对象');
  assert.equal(f.field('-relation').props.value, 'existing');
  const before = structuredClone(f.state.config.effective.qqAccounts);
  const option = f.nodes().find((node) => node.type === 'option' && node.props.value === 'boss-underling');
  assert.equal(f.text(option), '老大和小弟'); assert.deepEqual(f.state.config.effective.qqAccounts, before);
  await f.change('-relation', 'boss-underling');
  for (const label of ['你的角色', '大肥鱼的角色', '大肥鱼怎么称呼你', '你怎么称呼大肥鱼', '交换关系方向']) assert.equal(f.text().includes(label), false);
  assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0);
  await f.click('保存');
  const saved = f.calls.find((row) => row.route === 'config').payload.patch.qqAccounts[0];
  assert.equal(saved.activeIdentityId, 'default');
  const identity = saved.identities[0];
  assert.equal(identity.relationType, 'boss-underling'); assert.equal(identity.userRole, '老大');
  assert.equal(identity.companionRole, '女小弟'); assert.equal(identity.userTitle, '老大'); assert.equal(identity.companionTitle, '大肥鱼');
});

test('information tips support tap toggle, keyboard focus and Escape, and retain a focused tip when the pointer leaves', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('聊天对象');
  const label = '你的 QQ说明';
  const trigger = () => f.nodes().find((node) => node.type === 'button' && node.props['aria-label'] === label);
  const container = () => f.nodes().find((node) => node.props.className === 'dfy-help'
    && node.props.children.some((child) => child?.props?.['aria-label'] === label));
  const tooltip = () => container().props.children.find((node) => node?.props?.role === 'tooltip');
  assert.equal(trigger().props['aria-expanded'], false); assert.equal(tooltip().props.hidden, true);
  trigger().props.onClick(); await f.flush();
  assert.equal(trigger().props['aria-expanded'], true); assert.equal(tooltip().props.hidden, false);
  assert(f.text(tooltip()).includes('私人记忆')); assert.equal(trigger().props['aria-describedby'], tooltip().props.id);
  trigger().props.onClick(); await f.flush(); assert.equal(tooltip().props.hidden, true, 'a second tap dismisses the explanation');
  trigger().props.onFocus(); await f.flush(); assert.equal(tooltip().props.hidden, false);
  container().props.onMouseLeave(); await f.tickTimers(180);
  assert.equal(tooltip().props.hidden, false, 'keyboard focus keeps the explanation open after the pointer leaves');
  let prevented = false, propagationStopped = false;
  trigger().props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; },
    stopPropagation() { propagationStopped = true; } }); await f.flush();
  assert(prevented); assert(propagationStopped); assert.equal(tooltip().props.hidden, true);
  container().props.onBlur({ currentTarget: { contains() { return false; } }, relatedTarget: null }); await f.flush();
  container().props.onMouseEnter(); await f.flush(); assert.equal(tooltip().props.hidden, false);
  container().props.onMouseLeave(); await f.tickTimers(180);
  assert.equal(tooltip().props.hidden, true, 'an unfocused hover tip closes after the pointer leaves');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('Escape dismisses an unfocused hover tip before the host can close its window and removes its listener afterward', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('聊天对象');
  let hostKeyEvents = 0;
  const removeHostListener = f.addDocumentListener('keydown', () => { hostKeyEvents++; }); t.after(removeHostListener);
  const container = () => f.nodes().find((node) => node.props.className === 'dfy-help'
    && node.props.children.some((child) => child?.props?.['aria-label'] === '你的 QQ说明'));
  const tooltip = () => container().props.children.find((node) => node?.props?.role === 'tooltip');
  assert.equal(f.documentListenerCount('keydown'), 1);
  container().props.onMouseEnter(); await f.flush();
  assert.equal(tooltip().props.hidden, false, 'hover opens the tip without focusing its button');
  assert.equal(f.documentListenerCount('keydown'), 2);
  const ordinaryKey = f.dispatchDocumentKey('ArrowRight'); await f.flush();
  assert.equal(ordinaryKey.defaultPrevented, false); assert.equal(ordinaryKey.cancelBubble, false);
  assert.equal(hostKeyEvents, 1, 'other keys remain available to the host'); assert.equal(tooltip().props.hidden, false);
  const escape = f.dispatchDocumentKey('Escape'); await f.flush();
  assert.equal(escape.defaultPrevented, true); assert.equal(escape.cancelBubble, true);
  assert.equal(hostKeyEvents, 1, 'the host Escape handler does not receive the dismissal');
  assert.equal(tooltip().props.hidden, true); assert.equal(f.documentListenerCount('keydown'), 1, 'closing removes the temporary listener');
  const afterClosing = f.dispatchDocumentKey('Escape');
  assert.equal(afterClosing.defaultPrevented, false); assert.equal(afterClosing.cancelBubble, false); assert.equal(hostKeyEvents, 2);
  container().props.onMouseEnter(); await f.flush(); assert.equal(f.documentListenerCount('keydown'), 2);
  f.dispose(); assert.equal(f.documentListenerCount('keydown'), 1, 'unmounting an open tip also removes its listener');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('startup failure offers one explicit retry without configuration changes and rejects retry while busy or drafts remain', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  Object.assign(f.state.runtime, { ready: false, error: 'fixture startup failure' });
  await f.flush(); assert(f.text().includes('伴侣启动失败'));
  assert(f.button('重试启动')); assert(!f.button('重试启动').props.disabled);
  assert.equal(f.button('仅保存'), undefined, 'retry is available even without a configuration footer');
  await f.click('重试启动');
  assert.deepEqual(f.calls.filter((call) => call.method === 'POST').map((call) => ({ route: call.route, payload: call.payload })),
    [{ route: 'apply', payload: {} }], 'one deliberate retry reloads once without saving, testing or connecting a device');
  for (const reason of ['busy', 'draft']) {
    const blocked = fixture(); t.after(() => blocked.dispose());
    Object.assign(blocked.state.runtime, { ready: false, error: 'fixture startup failure', busy: reason === 'busy' });
    await blocked.flush();
    if (reason === 'draft') { await blocked.click('手机'); await blocked.change('-phoneDevice', 'fixture-phone:5555'); await blocked.click('首页'); }
    assert(blocked.button('重试启动').props.disabled, reason + ' blocks startup retry');
    blocked.button('重试启动').props.onClick(); await blocked.flush();
    assert.equal(blocked.calls.filter((call) => call.method === 'POST').length, 0, reason + ' is also rejected by the handler');
  }
});

test('parent configuration drafts mark their own page tab and the group tab across navigation', async (t) => {
  for (const [category, suffix, nextValue, group] of [['手机', '-phoneDevice', 'fixture-phone:5555', '高级'],
    ['QQ账号', '-onebotSelfId', '457', '聊天'], ['聊天对象', '-account-name', '新的账号备注', '聊天']]) {
    const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click(category); await f.change(suffix, nextValue);
    const tab = (label) => f.nodes().find((node) => node.props.role === 'tab' && f.text(node) === label);
    assert.equal(tab(category).props['data-dirty'], true, category + ' marks its own page tab');
    assert.equal(tab(group).props['data-dirty'], true, category + ' marks its group tab');
    await f.click('首页'); assert.equal(tab(group).props['data-dirty'], true, 'the marker survives leaving the group');
    await f.click(group);
    assert.equal(tab(category).props['data-dirty'], true, category + ' keeps its draft marker inside the group');
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0, 'draft marking and navigation are passive');
  }
});

test('single save keeps drafts across refresh, unblocks after the child draft is saved, and resyncs the revision automatically', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('性格');
  const personaEditor = () => f.nodes().find((node) => node.type === 'textarea' && node.props.id?.startsWith('dfy-persona-'));
  personaEditor().props.onChange({ target: { value: 'fixture independent personality draft' } }); await f.flush();
  await f.click('聊天对象'); await f.change('-identity-name', 'fixture unsaved identity');
  const externalAccount = primaryAccount(); externalAccount.identities[0].name = '外部已保存身份';
  f.externalChange({ qqAccounts: [externalAccount] }); await f.click('刷新');
  assert.equal(f.field('-identity-name').props.value, 'fixture unsaved identity', 'refresh still preserves the local draft');
  assert.equal(f.button('放弃未保存修改'), undefined, 'the single-save footer no longer offers a discard action');
  assert.equal(f.field('-identity-name').props.value, 'fixture unsaved identity', 'without discard the draft simply stays');
  await f.click('性格'); assert.equal(personaEditor().props.value, 'fixture independent personality draft');
  assert.equal(f.button('保存性格').props.disabled, false, 'the independent draft remains editable and unsaved');
  await f.click('保存性格');
  await f.click('聊天对象'); await f.change('-identity-name', 'fixture new identity');
  assert.equal(f.button('保存').props.disabled, false, 'saving the child draft unblocks the global save');
  await f.click('保存');
  const write = f.calls.filter((call) => call.method === 'POST' && call.route === 'config').at(-1).payload;
  assert.equal(write.revision, 'fixture-2', 'the single save auto-resyncs to the externally refreshed revision');
  assert.equal(write.patch.qqAccounts[0].identities[0].name, 'fixture new identity');
  assert.equal(f.calls.filter((call) => call.method === 'POST' && call.route === 'apply').length >= 1, true, 'save applies immediately');
});

test('secret drafts have no discard action and are only written by the explicit single save', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('QQ账号');
  const advanced = f.nodes().filter((node) => node.type === 'summary' && f.text(node) === '高级设置').at(-1);
  advanced.props.onClick({ preventDefault() {} }); await f.flush();
  await f.change('-token', 'fixture-secret-draft');
  assert.equal(f.button('放弃未保存修改'), undefined, 'no discard action exists in the single-save model');
  assert.equal(f.field('-token').props.value, 'fixture-secret-draft', 'the secret draft is kept until an explicit save');
  const before = f.calls.filter((call) => call.method === 'POST').length;
  assert.equal(before, 0, 'nothing is written until the user saves');
  await f.click('保存');
  const config = f.calls.filter((call) => call.method === 'POST' && call.route === 'config').at(-1).payload;
  assert.equal(config.patch.onebotAccessToken, 'fixture-secret-draft', 'the secret only reaches disk on the explicit save');
});

test('applying a fresh configuration draft shows the temporary QQ interruption beside the action before any save', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('手机');
  await f.change('-phoneDevice', 'fixture-phone:5555');
  assert(!f.state.pendingReload); assert(!f.button('保存并生效').props.disabled);
  const footer = f.nodes().find((node) => node.type === 'footer' && node.props.className === 'dfy-footer');
  assert(f.text(footer).includes('QQ') && f.text(footer).includes('短暂'), 'the consequence is visible without opening the saving tip');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('saving with a child draft defers the apply; it fires automatically once the child draft is saved', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('手机');
  await f.change('-phoneDevice', 'fixture-phone:5555'); await f.click('记忆');
  f.nodes().find((node) => node.props['data-memory-id'] === 'fact-fixture').props.onClick(); await f.flush();
  await f.change('-detail', '自动生效前的记忆草稿。');
  await f.click('保存');
  assert(f.text().includes('自动生效'), 'the deferred apply intent is visible');
  assert.equal(f.calls.some((call) => call.route === 'apply'), false, 'nothing applies while the child draft remains');
  await f.click('保存纠正');
  assert.equal(f.calls.filter((call) => call.route === 'apply').length, 1,
    'the deferred apply fires automatically after the child draft is saved');
  assert.equal(f.state.pendingReload, false);
  assert.equal(f.text().includes('自动生效'), false, 'the deferral notice clears once applied');
});

test('implicit root form submission preserves unrelated drafts and only the explicit save action persists connection settings', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('手机');
  await f.change('-phoneDevice', 'fixture-phone:5555'); await f.click('记忆');
  f.nodes().find((node) => node.props['data-memory-id'] === 'fact-fixture').props.onClick(); await f.flush();
  await f.change('-detail', '当前记忆纠正仍未保存。');
  let prevented = false;
  f.nodes().find((node) => node.type === 'form').props.onSubmit({ preventDefault() { prevented = true; } }); await f.flush();
  assert(prevented); assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0, 'Enter in a separate editor cannot save another page');
  assert.equal(f.field('-detail').props.value, '当前记忆纠正仍未保存。');
  assert.equal(f.button('仅保存').props.type, 'button', 'the global save is never an implicit form submit target');
  assert.equal(f.button('仅保存').props.disabled, false, 'an independent memory draft never disables the global save');
  await f.click('仅保存');
  const writes = f.calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].route, 'config', 'the connection draft is written by the single save');
  assert(f.text().includes('独立草稿'), 'with a child draft present the save writes but defers the apply');
  assert.deepEqual(writes[0].payload.patch, { phoneDevice: 'fixture-phone:5555' });
  assert.equal(f.field('-detail').props.value, '当前记忆纠正仍未保存。', 'explicit connection save does not discard the independent memory draft');
});

test('native account and relationship editor preserves independent drafts and submits complete multi-user configuration', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  await f.click('QQ 连接'); assert.equal(f.field('-owner'), undefined, 'primary field has its own account panel');
  await f.click('管理用户账号与身份'); assert(f.nodes().find((node) => node.props['aria-label'] === '主要账号'));
  assert.equal(f.field('-owner').props.value, '123'); assert(f.button('删除此账号').props.disabled);
  await f.click('添加用户账号'); assert(f.button('保存').props.disabled, 'blank new QQ cannot be saved');
  await f.change('-account-qq', '789'); await f.change('-account-name', '朋友账号');
  await f.click('添加身份'); await f.change('-identity-name', '船长'); await f.change('-relation', 'mother-daughter');
  await f.change('-relation', 'custom');
  assert(f.button('保存').props.disabled, 'custom relation needs its description instead of hidden role inputs');
  await f.change('-identity-description', '我是船长，大肥鱼是领航员，一同航海，喜欢轻松地聊见闻。');
  await f.click('使用此身份');
  await f.click('当前状态'); await f.click('刷新'); await f.click('管理账号与关系');
  assert.equal(f.field('-identity-name').props.value, '船长', 'account draft survives navigation and parent refresh');
  f.setFailSave(true); await f.click('保存'); assert(f.text().includes('fixture save failure'));
  assert.equal(f.field('-identity-description').props.value, '我是船长，大肥鱼是领航员，一同航海，喜欢轻松地聊见闻。', 'save failure preserves relationship draft');
  f.setFailSave(false); await f.click('保存');
  const saved = f.calls.filter((call) => call.route === 'config').at(-1).payload;
  assert.equal(saved.revision, 'fixture-1'); assert.deepEqual(Object.keys(saved.patch), ['qqAccounts']);
  assert.equal(saved.patch.qqAccounts.length, 2);
  const account = saved.patch.qqAccounts[1], identity = account.identities.find((item) => item.id === account.activeIdentityId);
  assert.equal(account.qq, '789'); assert.equal(account.identities.length, 2);
  assert.equal(identity.name, '船长'); assert.equal(identity.relationType, 'custom');
  assert.equal(identity.userRole, ''); assert.equal(identity.companionRole, '');
  assert.equal(identity.userTitle, ''); assert.equal(identity.companionTitle, '');
  assert.equal(identity.description, '我是船长，大肥鱼是领航员，一同航海，喜欢轻松地聊见闻。');
  assert.equal(f.state.config.running.qqAccounts.length, 2, 'the single save writes and applies in one action');
  await f.click('当前状态'); assert(f.text().includes('船长')); assert(f.text().includes('自定义'));
  assert.equal(f.calls.filter((call) => call.route === 'apply').length, 1);
  assert.equal(f.calls.filter((call) => ['napcat/qrcode', 'phone/check', 'phone/connect', 'model/test', 'voice/check'].includes(call.route)).length, 0);
});

test('primary QQ edits are atomic, users may be disabled, identity deletion retains a valid active selection, and duplicate or receiver QQ is rejected', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('账号与身份');
  await f.change('-owner', '124'); assert.equal(f.field('-account-qq').props.value, '124');
  await f.change('-enabled', undefined, false); assert(!f.button('保存').props.disabled, 'primary incoming can be disabled');
  await f.click('保存'); let payload = f.calls.filter((call) => call.route === 'config').at(-1).payload;
  assert.equal(payload.patch.ownerQq, '124'); assert.equal(payload.patch.qqAccounts[0].qq, '124');
  assert.equal(payload.patch.qqAccounts[0].enabled, false);
  await f.click('添加用户账号'); await f.change('-account-qq', '124');
  assert(f.text().includes('QQ 号重复')); assert(f.button('保存').props.disabled);
  await f.change('-account-qq', '456'); assert(f.text().includes('不能与接收小号相同')); assert(f.button('保存').props.disabled);
  await f.change('-account-qq', '789'); await f.click('添加身份'); await f.change('-identity-name', '日常');
  await f.click('使用此身份'); await f.click('删除此身份'); assert(f.button('删除此身份').props.disabled);
  await f.click('设为主要账号'); assert.equal(f.field('-owner').props.value, '789'); assert(f.button('删除此账号').props.disabled);
  const oldPrimary = f.nodes().find((node) => node.type === 'button' && node.props.className?.includes('dfy-account-choice') && f.text(node).includes('124'));
  oldPrimary.props.onClick(); await f.flush(); assert(!f.button('删除此账号').props.disabled);
  await f.click('删除此账号'); await f.click('保存');
  payload = f.calls.filter((call) => call.route === 'config').at(-1).payload;
  assert.equal(payload.patch.ownerQq, '789'); assert.equal(payload.patch.qqAccounts.length, 1);
  assert.equal(payload.patch.qqAccounts[0].activeIdentityId, payload.patch.qqAccounts[0].identities[0].id);
});

test('relationship drafts survive an external change; one save auto-resyncs and keeps unrelated external settings', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('账号与身份');
  await f.change('-relation', 'partners'); await f.change('-identity-description', '自定义相处说明');
  f.externalChange({ voiceTranscription: true }); await f.click('保存');
  const configs = f.calls.filter((call) => call.method === 'POST' && call.route === 'config');
  assert.equal(configs.length, 2, 'a revision conflict is retried exactly once after an automatic resync');
  assert.equal(f.calls.filter((call) => call.route === 'config')[0].method, 'POST');
  assert.equal(configs[1].payload.revision, 'fixture-2', 'the retry adopts the external revision without user action');
  assert.deepEqual(Object.keys(configs[1].payload.patch), ['qqAccounts']);
  assert.equal(f.field('-identity-description').props.value, '自定义相处说明', 'a successful save shows the persisted value as the new base');
  assert.equal(f.state.config.effective.voiceTranscription, true, 'unrelated external saved setting survives');
});

test('legacy engine account editor clearly states identities and custom relations require native', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.state.config.effective.onebotEngine = 'legacy';
  await f.flush(); await f.click('账号与身份');
  assert(f.nodes().some((node) => node.props.role === 'alert'
    && f.text(node).includes('当前聊天服务不支持多用户和自定义关系')));
  assert(!f.text().includes('改为 native'), 'engine diagnostics stay out of the default account view');
  await f.click('高级设置'); assert(f.text().includes('改为 native'));
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0, 'warning does not alter saved engine or config');
});

test('simplified relationships keep presets and custom descriptions functional without exposing role, title or direction controls', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('账号与身份');
  const choices = f.field('-relation').props.children;
  assert(choices.some((choice) => choice.props.value === 'father-daughter' && f.text(choice) === '父女'));
  assert(choices.some((choice) => choice.props.value === 'mother-daughter' && f.text(choice) === '母女'));
  assert(!choices.some((choice) => choice.props.value === 'parent-child'));
  for (const suffix of ['userRole', 'companionRole', 'userTitle', 'companionTitle']) assert.equal(f.field('-identity-' + suffix), undefined);
  assert.equal(f.button('交换关系方向'), undefined);
  assert(!f.text().includes('大肥鱼默认是女性'));
  assert(!f.nodes().some((node) => node.props['aria-label'] === '关系预览'));
  for (const [preset, userRole, title] of [['father-daughter', '父亲', '爸爸'], ['mother-daughter', '母亲', '妈妈']]) {
    await f.change('-relation', preset); await f.click('保存');
    const payload = f.calls.filter((call) => call.route === 'config').at(-1).payload;
    const identity = payload.patch.qqAccounts[0].identities[0];
    assert.equal(identity.relationType, preset); assert.equal(identity.userRole, userRole);
    assert.equal(identity.companionRole, '女儿'); assert.equal(identity.userTitle, title);
  }
  await f.change('-relation', 'custom'); assert(f.button('保存').props.disabled);
  await f.change('-identity-description', '同船搭档，我负责航行，她负责领航。'); await f.click('保存');
  const payload = f.calls.filter((call) => call.route === 'config').at(-1).payload;
  assert.equal(payload.patch.qqAccounts[0].identities[0].relationType, 'custom');
  assert.equal(payload.patch.qqAccounts[0].identities[0].description, '同船搭档，我负责航行，她负责领航。');
  for (const [userRole, companionRole, expectedValue] of [
    ['父亲', '女儿', 'father-daughter'], ['母亲', '女儿', 'mother-daughter'],
    ['女儿', '母亲', 'mother-daughter'], ['女儿', '父亲', 'custom'],
  ]) {
    const legacy = fixture(); t.after(() => legacy.dispose());
    const stored = { relationType: 'parent-child', userRole, companionRole, userTitle: '旧称呼', companionTitle: '小鱼' };
    Object.assign(legacy.state.config.effective.qqAccounts[0].identities[0], stored);
    await legacy.flush(); await legacy.click('账号与身份');
    assert.equal(legacy.field('-relation').props.value, expectedValue);
    await legacy.change('-identity-name', '旧身份改名'); await legacy.click('保存');
    const saved = legacy.calls.filter((call) => call.route === 'config').at(-1).payload.patch.qqAccounts[0].identities[0];
    for (const [key, value] of Object.entries(stored)) assert.equal(saved[key], value, 'hidden legacy data survives unrelated edits');
  }
});

test('QQ restart is one deliberate suite action and both button and handler reject maintenance while account drafts are dirty', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('QQ 连接');
  assert.equal(f.button('管理 QQ 服务'), undefined, 'service diagnostics are collapsed in the ordinary login view');
  await f.click('高级设置');
  await f.click('打开 QQ 服务维护');
  assert.equal(f.nodes().filter((node) => node.type === 'button' && f.text(node) === '重启 QQ 服务').length, 1,
    'NapCat and Linux QQ share one recovery action');
  assert(f.text().includes('保留配置和登录资料；重启会短暂断开 QQ'));
  assert.equal(f.calls.filter((call) => call.route === 'dependencies/action').length, 0, 'opening maintenance is read-only');
  await f.click('账号与身份'); await f.change('-identity-name', '未保存身份'); await f.click('依赖与更新');
  assert(f.button('重启 QQ 服务').props.disabled, 'draft blocks recovery mutation');
  f.button('重启 QQ 服务').props.onClick(); await f.flush();
  assert.equal(f.calls.filter((call) => call.route === 'dependencies/action').length, 0, 'handler also rejects bypassed disabled button');
  await f.click('账号与身份'); await f.change('-identity-name', '默认身份'); await f.click('依赖与更新');
  assert(!f.button('重启 QQ 服务').props.disabled); await f.click('重启 QQ 服务');
  const actions = f.calls.filter((call) => call.route === 'dependencies/action');
  assert.equal(actions.length, 1); assert.deepEqual(actions[0].payload, { id: 'napcat', action: 'restart' });
  assert.equal(f.calls.filter((call) => ['config', 'apply', 'napcat/qrcode', 'phone/check', 'model/test'].includes(call.route)).length, 0);
});

test('per-identity controls stop with drafts, recover only an acknowledged idle target, and never block unrelated users or replay messages', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.busy = true;
  f.state.runtime.companion.conversations = [
    { qq: '123', identityId: 'default', identityName: '默认身份', state: 'running', queued: 2, running: true, canStop: true, canRecover: false },
    { qq: '789', identityId: 'guest', identityName: '朋友', state: 'blocked', queued: 0, running: false,
      canStop: false, canRecover: true, requiresUncertainAcknowledgement: true, failureType: 'delivery_unknown', failedAt: '2026-10-23T09:00:00Z' },
  ];
  await f.flush(); assert(f.text().includes('QQ 送达结果未知')); assert(f.text().includes('排队 2 项'));
  await f.click('账号与身份'); await f.change('-account-name', '未保存备注'); await f.click('当前状态');
  const byAria = (label) => f.nodes().find((node) => node.props['aria-label'] === label);
  assert(!byAria('停止会话 主要使用者 / 默认身份').props.disabled, 'stop remains available while another page has drafts and runtime is busy');
  assert(byAria('恢复会话 789 / 朋友').props.disabled);
  byAria('恢复会话 789 / 朋友').props.onClick(); await f.flush();
  assert.equal(f.calls.filter((call) => call.route === 'conversations/recover').length, 0);
  byAria('停止会话 主要使用者 / 默认身份').props.onClick(); await f.flush();
  assert.deepEqual(f.calls.find((call) => call.route === 'conversations/stop').payload, { qq: '123', identityId: 'default' });
  assert(!f.text().includes('fixture raw detail must not display'));
  await f.click('账号与身份'); await f.change('-account-name', '主要使用者'); await f.click('当前状态');
  assert(byAria('恢复会话 789 / 朋友').props.disabled, 'unknown outcome requires explicit acknowledgement');
  byAria('确认恢复未知结果会话 789 / 朋友').props.onChange({ target: { checked: true } }); await f.flush();
  assert(!byAria('恢复会话 789 / 朋友').props.disabled, 'unrelated runtime activity does not block idle target recovery');
  byAria('恢复会话 789 / 朋友').props.onClick(); await f.flush();
  assert.deepEqual(f.calls.find((call) => call.route === 'conversations/recover').payload,
    { qq: '789', identityId: 'guest', acknowledgeUncertain: true });
  assert.equal(f.state.runtime.companion.conversations[0].state, 'blocked', 'recovering guest did not reset another identity');
  assert.equal(f.calls.filter((call) => ['config', 'apply', 'model/test', 'phone/check', 'napcat/qrcode'].includes(call.route)).length, 0);
});

const homeIssue = (patch = {}) => ({ qq: '123', identityId: 'default', identityName: '默认身份', state: 'failed', queued: 0,
  running: false, canStop: false, canRecover: true, requiresUncertainAcknowledgement: false,
  failureType: 'prepare_failed', failedAt: '2026-10-27T10:54:08Z', controlVersion: '0:1', ...patch });

test('home exception title and details open the matching safe reason and time without dispatching or duplicating controls', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.companion.conversations = [homeIssue()];
  f.state.runtime.companion.lastError = false;
  await f.flush();
  const trigger = () => f.nodes().find(node => node.props.className?.split(' ').includes('dfy-home-status-trigger'));
  assert.equal(trigger().type, 'button'); assert.equal(trigger().props.type, 'button');
  assert.ok(f.text(trigger()).includes('最近处理异常'));
  assert.equal(trigger().props['aria-expanded'], false);
  const detailsId = trigger().props['aria-controls'];
  assert.ok(f.nodes(undefined, false).some(node => node.props.id === detailsId && node.props.hidden === true));
  const callsBefore = f.calls.length;
  trigger().props.onClick(); await f.flush();
  const details = f.nodes().find(node => node.props.id === detailsId);
  assert.ok(details); assert.equal(trigger().props['aria-expanded'], true);
  assert.ok(f.text(details).includes('主要使用者 / 默认身份'));
  assert.ok(f.text(details).includes('原因：消息准备失败，尚未调用模型'));
  assert.ok(f.text(details).includes('发生时间：' + new Date('2026-10-27T10:54:08Z').toLocaleString()));
  assert.equal(f.nodes().filter(node => node.props['aria-label'] === '逐账号会话状态').length, 1);
  assert.equal(f.nodes().filter(node => node.props['aria-label'] === '恢复会话 主要使用者 / 默认身份').length, 1);
  await f.click('查看聊天状态');
  const targetId = f.button('查看聊天状态').props['aria-controls'];
  assert.ok(f.nodes().some(node => node.props.id === targetId && node.props['data-highlighted'] === 'true'));
  assert.ok(f.nodes().some(node => node.props.role === 'tabpanel' && node.props.id.endsWith('-content-overview')));
  assert.equal(f.calls.length, callsBefore, 'opening and locating read-only details does not request a model, recovery or service check');
  await f.click('收起异常详情');
  assert.equal(trigger().props['aria-expanded'], false);
  assert.equal(f.nodes().some(node => node.props.id === detailsId), false);
});

test('exception details list each failed identity by its own fixed reason and time; normal navigation is outside the warning', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.companion.conversations = [homeIssue({ failedAt: '2026-10-27T10:50:00Z' }),
    homeIssue({ qq: '789', identityId: 'guest', identityName: '朋友', state: 'blocked', failureType: 'delivery_unknown',
      failedAt: '2026-10-27T10:55:00Z', requiresUncertainAcknowledgement: true })];
  await f.flush(); await f.click('查看异常详情');
  const status = f.nodes().find(node => node.props['aria-label'] === '大肥鱼当前状态');
  assert.equal(f.nodes(status).some(node => node.type === 'button' && ['查看功能', '查看任务'].includes(f.text(node))), false);
  assert.equal(f.nodes().find(node => node.props['aria-label'] === '常用入口'), undefined, 'the shortcut row is gone');
  const details = f.nodes().find(node => node.props['aria-label'] === '异常详情');
  const issues = f.nodes(details).filter(node => node.props.className === 'dfy-home-issue');
  assert.equal(issues.length, 2);
  assert.ok(f.text(issues[0]).includes('QQ 789 / 朋友')); assert.ok(f.text(issues[0]).includes('QQ 送达结果未知'));
  assert.ok(f.text(issues[1]).includes('主要使用者 / 默认身份')); assert.ok(f.text(issues[1]).includes('消息准备失败'));
  const recovery = f.nodes().find(node => node.props['aria-label'] === '恢复会话 789 / 朋友');
  assert.equal(recovery.props.disabled, true, 'viewing details never acknowledges an unknown outcome');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('viewing an exception preserves account drafts and recovery guards, and refresh removes a resolved issue despite a stale legacy flag', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.companion.conversations = [homeIssue()]; f.state.runtime.companion.lastError = true;
  await f.flush(); await f.click('账号与身份'); await f.change('-account-name', '未保存的备注'); await f.click('当前状态');
  await f.click('查看异常详情');
  assert.equal(f.nodes().find(node => node.props['aria-label'] === '恢复会话 主要使用者 / 默认身份').props.disabled, true);
  await f.click('查看聊天状态'); await f.click('账号与身份');
  assert.equal(f.field('-account-name').props.value, '未保存的备注');
  await f.click('当前状态');
  Object.assign(f.state.runtime.companion.conversations[0], { state: 'idle', failureType: null, failedAt: null, canRecover: false });
  await f.click('刷新状态');
  assert.equal(f.button('查看异常详情'), undefined); assert.equal(f.button('收起异常详情'), undefined);
  assert.equal(f.text().includes('最近处理异常'), false);
  assert.equal(f.nodes().some(node => node.props['aria-label'] === '异常详情'), false);
  await f.click('账号与身份'); assert.equal(f.field('-account-name').props.value, '未保存的备注');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('an unlocated legacy error offers an honest local explanation without raw text or an invented task destination', async t => {
  for (const conversations of [undefined, []]) {
    const f = fixture(); t.after(() => f.dispose());
    f.state.runtime.companion.conversations = conversations;
    f.state.runtime.companion.lastError = 'PRIVATE_LEGACY_FAILURE_DO_NOT_RENDER';
    await f.flush(); await f.click('查看异常详情');
    const details = f.nodes().find(node => node.props['aria-label'] === '异常详情');
    assert.ok(f.text().includes('处理记录待核对'));
    assert.ok(f.text(details).includes('无法确认对象、原因或发生时间'));
    assert.equal(f.text().includes('PRIVATE_LEGACY_FAILURE_DO_NOT_RENDER'), false);
    assert.equal(f.button('查看聊天状态'), undefined);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(f.calls.some(call => call.route.startsWith('tasks/')), false);
  }
});

test('known unhandled inputs explain the next new message neutrally without offering unnecessary recovery or performing work', async t => {
  for (const [failureType, reason] of [
    ['unsupported_input', '当前 QQ 文件读取尚未接入，未读取附件、未调用模型；请直接发送需要处理的文字。'],
    ['empty_input', '消息没有可处理的文字内容，尚未调用模型；请补充内容后发送一条新消息。'],
  ]) {
    const f = fixture(); t.after(() => f.dispose());
    const item = homeIssue({ failureType }); f.state.runtime.companion.conversations = [item];
    const original = structuredClone(item);
    await f.flush();
    const status = f.nodes().find(node => node.props['aria-label'] === '大肥鱼当前状态');
    const title = f.nodes(status).find(node => node.props.className?.includes('dfy-home-status-title'));
    assert.ok(f.text(title).includes('消息需要补充')); assert.ok(title.props.className.split(' ').includes('dfy-neutral'));
    assert.equal(f.nodes(status).some(node => node.props.role === 'alert'), false);
    await f.click('查看消息详情');
    const details = f.nodes().find(node => node.props['aria-label'] === '消息详情');
    assert.ok(f.text(details).includes(reason)); assert.ok(f.text(details).includes('主要使用者 / 默认身份'));
    assert.ok(f.text(details).includes('发生时间：' + new Date(item.failedAt).toLocaleString()));
    assert.ok(f.text().includes('聊天未暂停，可直接发送一条新的文字消息；原消息不会自动重跑。'));
    assert.equal(f.nodes().some(node => node.props['aria-label']?.startsWith('恢复会话 ')), false);
    assert.equal(f.nodes().some(node => node.props['aria-label']?.startsWith('新会话继续 ')), false);
    await f.click('查看聊天状态'); await f.click('收起消息详情');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    assert.deepEqual(item, original, 'viewing a refused input never changes its recorded cause or time');
  }
});

test('internal and uncertain failures retain warning priority and their guarded controls alongside newer input notices', async t => {
  for (const protectedIssue of [
    homeIssue({ failureType: 'prepare_failed' }),
    homeIssue({ failureType: 'delivery_unknown', requiresUncertainAcknowledgement: true }),
    homeIssue({ state: 'blocked', failureType: 'context_required' }),
    homeIssue({ failureType: 'unsupported_input', requiresUncertainAcknowledgement: true }),
  ]) {
    const f = fixture(); t.after(() => f.dispose());
    f.state.runtime.companion.conversations = [homeIssue({ qq: '789', identityId: 'new', identityName: '新消息',
      failureType: 'empty_input', failedAt: '2026-10-27T11:10:00Z' }), protectedIssue];
    await f.flush(); await f.click('查看异常详情');
    const status = f.nodes().find(node => node.props['aria-label'] === '大肥鱼当前状态');
    const title = f.nodes(status).find(node => node.props.className?.includes('dfy-home-status-title'));
    assert.ok(title.props.className.split(' ').includes('dfy-warn'));
    const details = f.nodes().find(node => node.props['aria-label'] === '异常详情');
    const first = f.nodes(details).find(node => node.props.className === 'dfy-home-issue');
    assert.ok(f.text(first).includes('主要使用者 / 默认身份'), 'an input notice cannot hide a protected or internal failure even when it is newer');
    const recovery = f.nodes().find(node => node.props['aria-label'] === '恢复会话 主要使用者 / 默认身份');
    assert.ok(recovery);
    if (protectedIssue.requiresUncertainAcknowledgement) {
      assert.equal(recovery.props.disabled, true); recovery.props.onClick(); await f.flush();
      assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    }
    assert.equal(f.nodes().some(node => node.props['aria-label'] === '恢复会话 789 / 新消息'), false);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('an input notice does not remove a valid stop control for an associated active background task', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.companion.conversations = [homeIssue({ failureType: 'empty_input', canStop: true })];
  await f.flush(); await f.click('查看消息详情');
  const stop = f.nodes().find(node => node.props['aria-label'] === '停止会话 主要使用者 / 默认身份');
  assert.ok(stop); assert.equal(stop.props.disabled, false);
  assert.equal(f.nodes().some(node => node.props['aria-label'] === '恢复会话 主要使用者 / 默认身份'), false);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('new input classifications do not relabel or recover old prepare failures and viewing remains available with drafts', async t => {
  const f = fixture(); t.after(() => f.dispose());
  const oldFailure = homeIssue({ inputKind: 'file', file: { name: 'DO_NOT_RENDER_PRIVATE_FILE' } });
  f.state.runtime.companion.conversations = [oldFailure];
  const original = structuredClone(oldFailure);
  await f.flush(); await f.click('账号与身份'); await f.change('-account-name', '未保存备注'); await f.click('当前状态');
  await f.click('查看异常详情');
  assert.ok(f.text().includes('原因：消息准备失败，尚未调用模型'));
  assert.equal(f.text().includes('当前 QQ 文件读取尚未接入'), false, 'an old prepare_failed record is not silently attributed to the new file classifier');
  assert.equal(f.text().includes('DO_NOT_RENDER_PRIVATE_FILE'), false);
  assert.equal(f.nodes().find(node => node.props['aria-label'] === '恢复会话 主要使用者 / 默认身份').props.disabled, true);
  await f.click('账号与身份'); assert.equal(f.field('-account-name').props.value, '未保存备注');
  assert.deepEqual(oldFailure, original); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

const contextConversation = (patch = {}) => ({ qq: '123', identityId: 'default', identityName: '默认身份', state: 'blocked', queued: 0, running: false,
  canStop: false, canRecover: true, requiresUncertainAcknowledgement: false, failureType: 'context_required', failedAt: '2026-10-26T03:00:00Z', controlVersion: '0:1', ...patch });

test('context pause classifications and protection status are visible while fresh-session controls appear only for context failures', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.contextProtection = { enabled: true, strategy: 'conservative-host-request', automaticReplay: false };
  f.state.runtime.companion.conversations = [contextConversation(),
    contextConversation({ qq: '789', identityId: 'a', identityName: 'A', failureType: 'context_compaction_failed' }),
    contextConversation({ qq: '790', identityId: 'b', identityName: 'B', failureType: 'context_guard_unavailable' }),
    contextConversation({ qq: '791', identityId: 'c', identityName: 'C', failureType: 'delivery_unknown' })];
  await f.flush();
  for (const text of ['聊得太长，先自动暂停了；去首页「长对话恢复」可让她继续', '上下文压缩未完成，已暂停', '上下文容量暂时无法确认，已暂停', '原请求与排队消息都不会重跑']) {
    assert.ok(f.text().includes(text), text);
  }
  const fresh = f.nodes().filter(node => node.props['aria-label']?.startsWith('新会话继续 '));
  assert.equal(fresh.length, 3); assert.equal(fresh.some(node => node.props['aria-label'].includes('791')), false);
  await f.click('高级设置'); assert.ok(f.text().includes('上下文保护')); assert.ok(f.text().includes('已加载 · 容量不足时暂停'));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('context recovery errors remain sanitized and explicit fresh-session submission shares one guarded POST without replaying content', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.state.runtime.companion.conversations = [contextConversation({ requiresUncertainAcknowledgement: true })];
  await f.flush(); const byAria = label => f.nodes().find(node => node.props['aria-label'] === label);
  const freshLabel = '新会话继续 主要使用者 / 默认身份', restoreLabel = '恢复会话 主要使用者 / 默认身份';
  for (const label of [freshLabel, restoreLabel]) {
    assert.equal(byAria(label).props.disabled, true); byAria(label).props.onClick(); await f.flush();
  }
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  byAria('确认恢复未知结果会话 主要使用者 / 默认身份').props.onChange({ target: { checked: true } }); await f.flush();
  f.setConversationFailure({ code: 'CONTEXT_RECOVERY_REQUIRED', error: '上下文仍需处理，原请求不会自动重跑。', diagnostic: 'PRIVATE_RECOVERY_DETAIL' });
  byAria(restoreLabel).props.onClick(); await f.flush();
  assert.ok(f.text().includes('上下文仍需处理')); assert.equal(f.text().includes('PRIVATE_RECOVERY_DETAIL'), false);
  assert.equal(f.text().includes('fixture raw detail must not display'), false);
  const failed = f.calls.find(call => call.route === 'conversations/recover');
  assert.deepEqual(failed.payload, { qq: '123', identityId: 'default', acknowledgeUncertain: true, controlVersion: '0:1' });
  f.setConversationFailure(null); let release; f.setConversationGate(new Promise(resolve => { release = resolve; }));
  const handler = byAria(freshLabel).props.onClick; handler(); handler(); await f.flush();
  assert.equal(f.calls.filter(call => call.route === 'conversations/recover').length, 2, 'a double click adds only one fresh-session request');
  release(); await f.flush();
  const writes = f.calls.filter(call => call.method === 'POST');
  assert.deepEqual(writes[1], { route: 'conversations/recover', method: 'POST', payload: { qq: '123', identityId: 'default', acknowledgeUncertain: true, controlVersion: '0:1', freshSession: true } });
  assert.ok(writes.every(call => call.route === 'conversations/recover'));
  assert.ok(f.text().includes('下一条新消息将使用新会话，原请求未重跑'));
  assert.equal(f.text().includes('fixture raw detail must not display'), false);
});

test('fresh-session controls and direct current handlers respect account drafts, pending apply and active maintenance', async t => {
  for (const mode of ['draft', 'pending', 'applying']) {
    const f = fixture(); t.after(() => f.dispose()); f.state.runtime.companion.conversations = [contextConversation()];
    if (mode === 'pending') f.state.pendingReload = true;
    if (mode === 'applying') f.state.runtime.applying = true;
    await f.flush();
    if (mode === 'draft') { await f.click('账号与身份'); await f.change('-account-name', '尚未保存'); await f.click('当前状态'); }
    const button = f.nodes().find(node => node.props['aria-label'] === '新会话继续 主要使用者 / 默认身份');
    assert.equal(button.props.disabled, true, mode); button.props.onClick(); await f.flush();
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0, mode);
  }
});

test('retained fresh-session handlers cannot bypass newer account drafts or a newly unacknowledged failure', async t => {
  for (const mode of ['draft', 'new-failure']) {
    const f = fixture(); t.after(() => f.dispose()); f.state.runtime.companion.conversations = [contextConversation({ requiresUncertainAcknowledgement: true })];
    await f.flush(); const byAria = label => f.nodes().find(node => node.props['aria-label'] === label);
    byAria('确认恢复未知结果会话 主要使用者 / 默认身份').props.onChange({ target: { checked: true } }); await f.flush();
    const stale = byAria('新会话继续 主要使用者 / 默认身份').props.onClick;
    if (mode === 'draft') { await f.click('账号与身份'); await f.change('-account-name', '新的未保存草稿'); await f.click('当前状态'); }
    else { Object.assign(f.state.runtime.companion.conversations[0], { failedAt: '2026-10-26T03:01:00Z', controlVersion: '0:2' }); await f.click('刷新状态'); }
    assert.equal(byAria('新会话继续 主要使用者 / 默认身份').props.disabled, true);
    stale(); await f.flush(); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0, mode);
  }
});

test('phone page explains a classified failure and next action with its check time without automatically connecting or touching the device', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  const checkedAt = '2026-10-23T09:00:00Z';
  f.state.runtime.phone = { enabled: true, device: 'fixture-phone:5555', state: 'offline', checking: false, canConnect: true,
    reasonCode: 'network_unreachable', note: '配置设备地址的网络不可达', nextStep: '先确认电脑和手机当前网络可以互通，再核对当前连接端口。', checkedAt };
  await f.flush(); await f.click('手机权限');
  assert(f.text().includes('设备网络不可达')); assert(f.text().includes('配置设备地址的网络不可达'));
  assert(f.text().includes('下一步')); assert(f.text().includes('网络可以互通'));
  assert(!f.text().includes(new Date(checkedAt).toLocaleString()), 'check timestamp belongs to advanced diagnostics');
  await f.click('高级设置');
  assert(f.nodes().some((node) => node.props.className === 'dfy-readonly'
    && f.text(node).includes('最近检查') && f.text(node).includes(new Date(checkedAt).toLocaleString())));
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0, 'opening the page is passive');
  f.state.runtime.phone = { ...f.state.runtime.phone, reasonCode: 'unauthorized', note: 'ADB 已发现设备，但设备尚未授权',
    nextStep: '查看手机上的调试授权提示；无线调试请核对已配对设备列表。' };
  await f.click('检测手机连接'); assert(f.text().includes('设备待授权')); assert(f.text().includes('查看手机上的调试授权提示'));
  assert.deepEqual(f.calls.filter((call) => call.method === 'POST').map((call) => ({ route: call.route, payload: call.payload })),
    [{ route: 'phone/check', payload: {} }], 'only deliberate check dispatches; no connect, phone operation or configuration change');
});

test('memory editor reads provenance and scope, preserves CAS drafts, and explicitly corrects, forgets and undoes without applying or calling a model', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('记忆');
  assert(!f.text().includes('memory/facts.json')); assert(!f.text().includes('账号 123'), 'raw provenance and scope stay out of the memory list');
  assert(!f.text().includes('主要使用者 · 所有身份'), 'a single-scope list hides the repeated ownership line before opening');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  const open = () => f.nodes().find((node) => node.props['data-memory-id'] === 'fact-fixture');
  assert(!f.text().includes('主要使用者 · 所有身份'), 'a single-scope list hides the repeated ownership line');
  assert.equal(open().props['aria-label'], '查看与纠正记忆：喜欢热茶');
  open().props.onClick(); await f.flush();
  assert(f.button('不再记住'), 'the forget action stays one click away; its consequence copy was removed by design');
  assert(!f.text().includes('memory/facts.json'), 'raw provenance paths stay out of the editor');
  await f.change('-detail', '现在更喜欢喝温水。');
  open().props.onClick(); await f.flush(); open().props.onClick(); await f.flush();
  assert.equal(f.field('-detail').props.value, '现在更喜欢喝温水。', 'collapsing and reopening the row cannot discard its draft');
  await f.click('账号与身份'); await f.change('-account-name', '尚未保存');
  assert.equal(f.button('保存并应用').props.disabled, false, 'a memory draft defers rather than disables the single save');
  await f.change('-account-name', '主要使用者'); await f.click('依赖与更新'); assert(f.button('重启 QQ 服务').props.disabled);
  await f.click('记忆'); f.setFailMemory(true); await f.click('保存纠正');
  assert.equal(f.field('-detail').props.value, '现在更喜欢喝温水。'); f.setFailMemory(false);
  f.externalMemoryChange({ summary: '外部更新的摘要' }); await f.click('保存纠正'); assert(f.text().includes('草稿已保留'));
  await f.click('刷新'); assert.equal(f.field('-detail').props.value, '现在更喜欢喝温水。');
  await f.click('采用最新版本，保留我修改的字段');
  assert.equal(f.field('-summary').props.value, '外部更新的摘要'); assert.equal(f.field('-detail').props.value, '现在更喜欢喝温水。');
  await f.click('保存纠正'); let payload = f.calls.filter((call) => call.route === 'memory/correct').at(-1).payload;
  assert.equal(payload.revision, 'b'.repeat(64)); assert.equal(payload.confirmed, false); assert.equal(payload.sourceType, 'user_explicit', 'provenance editing is no longer exposed; the stored value passes through');
  assert.equal(f.memoryItems[0].status, 'unconfirmed'); await f.click('不再记住'); assert.equal(f.memoryItems[0].status, 'forgotten');
  assert(f.text().includes('历史聊天和备份仍会保留')); await f.click('撤销修改'); assert.equal(f.memoryItems[0].status, 'unconfirmed');
  await f.click('撤销修改'); assert.equal(f.memoryItems[0].summary, '外部更新的摘要'); assert.equal(f.memoryItems[0].detail, '日常喜欢喝热茶。');
  assert(f.nodes().some((node) => node.type === 'button' && f.text(node) === '撤销修改' && node.props.disabled), 'restore disables once history is empty');
  assert.equal(f.calls.filter((call) => ['config', 'apply', 'dependencies/action', 'model/test', 'phone/check'].includes(call.route)).length, 0);
});

test('memory list distinguishes named chat identities and unknown owners without exposing raw identifiers', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.memoryItems.push({ ...structuredClone(f.memoryItems[0]), id: 'identity-memory',
    scope: { type: 'identity', accountId: '123', identityId: 'default' } },
  { ...structuredClone(f.memoryItems[0]), id: 'unknown-memory',
    scope: { type: 'identity', accountId: 'unknown-qq-fixture', identityId: 'unknown-identity-fixture' } });
  await f.flush(); await f.click('记忆');
  assert(f.text().includes('主要使用者 · 默认身份')); assert(f.text().includes('其他聊天对象 · 其他身份'));
  assert(!f.text().includes('unknown-qq-fixture')); assert(!f.text().includes('unknown-identity-fixture'));
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('gallery keeps meaning visible and preserves optional AI guidance while advanced settings are collapsed', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('表情包');
  assert(f.text().includes('小鲸鱼缩在被子里，表示困了想休息。'));
  assert(!f.text().includes('fixture-whale.png'), 'technical filename does not replace the user-facing meaning');
  await f.click('查看 / 编辑含义');
  assert(f.field('-edit-description')); assert.equal(f.field('-edit-ai'), undefined);
  await f.click('高级设置'); await f.change('-edit-ai', '适合晚安和撒娇，不要用于严肃争执。');
  await f.click('高级设置'); assert.equal(f.field('-edit-ai'), undefined);
  await f.change('-edit-description', '小鲸鱼缩在被子里，表达困意和想被关心。');
  await f.click('保存表情描写');
  const writes = f.calls.filter((call) => call.route === 'meme-metadata'); assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.patch.description, '小鲸鱼缩在被子里，表达困意和想被关心。');
  assert.equal(writes[0].payload.patch.aiDescription, '适合晚安和撒娇，不要用于严肃争执。', 'collapsing advanced fields preserves their drafts');
  assert.equal(f.calls.filter((call) => ['config', 'apply', 'memes/import'].includes(call.route)).length, 0);
});

test('personality editing hides file diagnostics, preserves a draft across navigation, and saves independently from connection settings', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('性格');
  assert(!f.text().includes('fixture/persona.md')); assert(!f.text().includes('UTF-8'));
  const editor = () => f.nodes().find((node) => node.type === 'textarea' && node.props.id?.startsWith('dfy-persona-'));
  editor().props.onChange({ target: { value: '性格温柔，喜欢聊海洋，也会直接表达自己的想法。' } }); await f.flush();
  await f.click('首页'); await f.click('性格'); assert.equal(editor().props.value, '性格温柔，喜欢聊海洋，也会直接表达自己的想法。');
  await f.click('高级设置'); assert(f.text().includes('fixture/persona.md'));
  await f.click('高级设置'); await f.click('保存性格');
  assert.equal(f.calls.filter((call) => call.route === 'persona' && call.method === 'POST').length, 1);
  assert(f.text().includes('下一轮对话生效'));
  assert.equal(f.calls.filter((call) => ['config', 'apply'].includes(call.route)).length, 0);
});

test('QR login automatically invalidates old image when revision rotates, is scanned, rejected or logged in without automatically refreshing', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('QQ 连接');
  const qrImages = () => f.nodes().filter((node) => node.type === 'img' && node.props.alt === '接收小号的 QQ 登录二维码');
  await f.click('获取当前二维码'); assert.equal(qrImages().length, 1);
  f.setLogin({ qrcodeRevision: 'c'.repeat(64) }); await f.tickPolls(); assert.equal(qrImages().length, 0);
  assert(f.text().includes('二维码已经失效或更新')); await f.click('获取当前二维码'); assert.equal(qrImages().length, 1);
  f.setLogin({ phase: 'qrcode_scanned', qrcodeRevision: null }); await f.tickPolls();
  assert.equal(qrImages().length, 0); assert(f.text().includes('已扫码，等待手机确认')); assert(f.button('刷新二维码').props.disabled);
  f.setLogin({ phase: 'waiting_qrcode', issue: { code: 'LOGIN_REJECTED', note: 'QQ 登录被拒绝，请在手机查看原因后重试。' } });
  await f.tickPolls(); assert(f.text().includes('登录被拒绝')); assert(f.button('获取当前二维码').props.disabled);
  f.setNextQrRevision('d'.repeat(64)); await f.click('刷新二维码'); assert.equal(qrImages().length, 1);
  f.setLogin({ isLogin: true, phase: 'ready', qrcodeRevision: null, coreReady: true, selfMatches: true });
  await f.tickPolls(); assert.equal(qrImages().length, 0);
  assert(f.nodes().some((node) => node.type === 'strong' && f.text(node) === '已登录'));
  f.setLogin({ coreReady: false }); await f.tickPolls(); assert(f.text().includes('已登录，正在连接'), 'login is distinguished from the core becoming ready');
  const requests = f.calls.filter((call) => call.route === 'napcat/qrcode');
  assert.deepEqual(requests.map((call) => call.payload.refresh), [false, false, true]);
  assert.equal(f.calls.filter((call) => ['config', 'apply', 'phone/check', 'model/test'].includes(call.route)).length, 0);
});

test('uncertain management and recovery states explain their limits without prompting a scan or exposing raw details', async (t) => {
  const raw = 'UNTRUSTED_QQ_STATUS_DETAIL_CANARY';
  const cases = [
    { name: 'unknown login', login: { isLogin: null, phase: 'unknown' }, label: '登录状态未确认', refresh: false },
    { name: 'unconfirmed management authentication', login: { isLogin: null, phase: 'unknown' },
      webui: { reachable: true, authenticated: false }, label: '管理状态未确认', refresh: false },
    { name: 'unreachable management endpoint', login: { isLogin: null, phase: 'unknown' },
      webui: { reachable: false, authenticated: false }, label: '管理状态未确认', refresh: false },
    { name: 'reconnecting', login: { isLogin: false, phase: 'reconnecting', issue: { code: 'LOGIN_NETWORK_UNAVAILABLE', note: raw } },
      label: '正在恢复连接', refresh: true },
    { name: 'self offline', login: { isLogin: false, phase: 'waiting_qrcode', issue: { code: 'LOGIN_SELF_OFFLINE', note: raw } },
      label: 'QQ 暂时离线', refresh: true },
    { name: 'kicked offline', login: { isLogin: false, phase: 'waiting_qrcode', issue: { code: 'LOGIN_KICKED_OFFLINE', note: raw } },
      label: 'QQ 登录已断开', refresh: true },
  ];
  for (const item of cases) await t.test(item.name, async (st) => {
    const f = fixture(); st.after(() => f.dispose());
    f.setLogin(item.login); f.setNapcat({ error: { message: raw }, ...(item.webui ? { webui: item.webui } : {}) });
    await f.flush(); await f.click('QQ账号');
    assert(f.nodes().some((node) => node.type === 'strong' && f.text(node) === item.label));
    assert.equal(f.text().includes('请使用接收小号'), false);
    assert.equal(f.text().includes(raw), false, 'unknown management details and native reasons are not user-facing prose');
    assert.equal(f.text().includes('登录网络异常'), false, 'recovery presentation does not diagnose the underlying network');
    assert.equal(f.text().includes('风控'), false);
    assert.equal(f.button('显示二维码').props.disabled, true);
    assert.equal(Boolean(f.button('刷新二维码').props.disabled), !item.refresh, 'existing manual QR admission is unchanged');
    await f.tickPolls();
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0, 'presentation and polling do not authenticate, refresh QR or run work');
  });
});

test('a status read failure uses fixed management wording and does not turn cached login into a scan instruction', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.setLogin({ isLogin: true, phase: 'ready', coreReady: true, selfMatches: true });
  await f.flush(); await f.click('QQ账号');
  assert(f.nodes().some((node) => node.type === 'strong' && f.text(node) === '已登录'));
  f.setFailStatus(true); await f.tickPolls();
  assert(f.nodes().some((node) => node.type === 'strong' && f.text(node) === '管理状态未确认'));
  assert(f.text().includes('管理状态暂未确认'));
  assert.equal(f.text().includes('fixture status failure'), false);
  assert.equal(f.text().includes('请使用接收小号'), false);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('a recovery poll retracts an old QR using fixed wording and keeps existing logged-in and scanned admission', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('QQ账号');
  await f.click('显示二维码');
  const images = () => f.nodes().filter((node) => node.type === 'img' && node.props.alt === '接收小号的 QQ 登录二维码');
  assert.equal(images().length, 1);
  f.setLogin({ phase: 'reconnecting', qrcodeRevision: null,
    issue: { code: 'LOGIN_SELF_OFFLINE', note: 'UNTRUSTED_QQ_OFFLINE_NOTE_CANARY' } });
  await f.tickPolls();
  assert.equal(images().length, 0); assert.equal(f.text().includes('UNTRUSTED_QQ_OFFLINE_NOTE_CANARY'), false);
  assert.equal(f.text().includes('请使用接收小号'), false);
  assert.equal(f.button('显示二维码').props.disabled, true);
  f.setLogin({ phase: 'qrcode_scanned', issue: null }); await f.tickPolls();
  assert(f.text().includes('已扫码，等待手机确认')); assert.equal(f.button('刷新二维码').props.disabled, true);
  f.setLogin({ isLogin: true, isOffline: true, phase: 'ready', coreReady: true, selfMatches: true,
    issue: { code: 'LOGIN_SELF_OFFLINE', note: 'UNTRUSTED_QQ_OFFLINE_NOTE_CANARY' } });
  await f.tickPolls();
  assert(f.nodes().some((node) => node.type === 'strong' && f.text(node) === '已登录，当前离线'));
  assert.equal(f.text().includes('UNTRUSTED_QQ_OFFLINE_NOTE_CANARY'), false); assert.equal(f.button('显示二维码'), undefined);
  assert.deepEqual(f.calls.filter((call) => call.method === 'POST').map((call) => ({ route: call.route, payload: call.payload })),
    [{ route: 'napcat/qrcode', payload: { refresh: false } }]);
});

test('existing scan and generation evidence keeps its presentation when the login boolean is not yet available', async (t) => {
  for (const [phase, accepted, label] of [['qrcode_scanned', false, '已扫码，等待手机确认'],
    ['generating_qrcode', false, '正在生成二维码'], ['initializing', true, '扫码已确认，等待登录']]) {
    const f = fixture(); t.after(() => f.dispose()); f.setLogin({ isLogin: null, phase, qrLoginAccepted: accepted });
    await f.flush(); await f.click('QQ账号');
    assert(f.nodes().some((node) => node.type === 'strong' && f.text(node) === label));
    assert.equal(f.button('显示二维码').props.disabled, true); assert.equal(f.button('刷新二维码').props.disabled, true);
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  }
});

const modelFixture = () => ({ available: true, writable: true, selectionEditable: true,
  currentSelection: { provider: 'account-service', model: 'account-chat' },
  providers: [
    { provider: 'api-service', name: 'API 服务', revision: 1, modelIds: ['api-chat'],
      baseURL: 'https://api.example.invalid/v1', editable: true,
      editableFields: { baseURL: true, apiKey: true, protocol: false },
      credential: { configured: false, writable: true, known: true } },
    { provider: 'account-service', name: '账号服务', revision: 1, modelIds: ['account-chat'],
      editable: false, credential: { configured: true, writable: false, known: true } },
  ], speech: { providers: [], selection: null, available: false } });
const connectionProvider = (f) => f.nodes().find((node) => node.type === 'select'
  && node.props.id?.endsWith('-provider') && !node.props.id.endsWith('-default-provider'));

test('model connection settings initially show the active chat provider rather than an unrelated first provider', async (t) => {
  const f = fixture({ model: modelFixture() }); t.after(() => f.dispose());
  await f.flush(); await f.click('模型服务');
  assert.equal(connectionProvider(f).props.value, 'account-service');
  assert.equal(f.field('-default-provider').props.value, 'account-service');
  assert.equal(f.field('-baseURL'), undefined, 'an account-managed provider must not appear as missing API settings');
  assert(f.text().includes('此服务由 DSH 管理'));
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('model connection settings fall back to the first provider if the active chat provider is absent', async (t) => {
  const model = modelFixture(); model.currentSelection = { provider: 'removed-service', model: 'old-chat' };
  const f = fixture({ model }); t.after(() => f.dispose());
  await f.flush(); await f.click('模型服务');
  assert.equal(connectionProvider(f).props.value, 'api-service');
  assert.equal(f.field('-baseURL').props.value, 'https://api.example.invalid/v1');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('refresh preserves a manually selected provider and its URL draft instead of following the active chat provider', async (t) => {
  const model = modelFixture(), f = fixture({ model }); t.after(() => f.dispose());
  await f.flush(); await f.click('模型服务');
  connectionProvider(f).props.onChange({ target: { value: 'api-service' } }); await f.flush();
  await f.change('-baseURL', 'https://draft.example.invalid/v1');
  model.providers[0].revision = 2; model.providers[0].baseURL = 'https://updated.example.invalid/v1';
  await f.click('刷新目录');
  assert.equal(connectionProvider(f).props.value, 'api-service', 'refresh must respect the explicit connection-editor selection');
  assert.equal(f.field('-baseURL').props.value, 'https://draft.example.invalid/v1');
  assert.equal(f.field('-default-provider').props.value, 'account-service', 'editing another connection must not change the chat model');
  assert(f.text().includes('最新配置与草稿基于的版本不同'), 'refresh retains the draft revision for conflict handling');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});


test('image transport limits show a neutral truthful explanation; read errors and unknown delivery retain warning and guarded controls', async t => {
  for (const [failureType, uncertain, neutral] of [
    ['image_unavailable', false, true], ['image_input_failed', false, false], ['image_unavailable', true, false],
  ]) {
    const f = fixture(); t.after(() => f.dispose());
    f.state.runtime.companion.conversations = [homeIssue({ failureType, requiresUncertainAcknowledgement: uncertain })];
    await f.flush();
    const status = f.nodes().find(node => node.props['aria-label'] === '大肥鱼当前状态');
    const title = f.nodes(status).find(node => node.props.className?.includes('dfy-home-status-title'));
    assert.ok(f.text(title).includes(neutral ? '图片尚未处理' : '最近处理异常'));
    await f.click(neutral ? '查看消息详情' : '查看异常详情');
    const details = f.nodes().find(node => node.props['aria-label'] === (neutral ? '消息详情' : '异常详情'));
    assert.ok(f.text(details).includes('图片已到 QQ'));
    assert.ok(f.text(details).includes('不必反复重发'));
    if (neutral) assert.equal(f.nodes().some(node => node.props['aria-label']?.startsWith('恢复会话 ')), false);
    if (uncertain) {
      const recovery=f.nodes().find(node => node.props['aria-label'] === '恢复会话 主要使用者 / 默认身份');
      assert.ok(recovery); assert.equal(recovery.props.disabled,true);
    }
    assert.equal(f.calls.filter(call => call.method === 'POST').length,0);
  }
});


test('partially unsupported or oversized messages retain a visible non-execution explanation and never suggest recovery replay', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.state.runtime.companion.conversations = [homeIssue({ failureType: 'unsupported_message' })];
  await f.flush();
  assert.ok(f.text().includes('消息暂未处理'));
  await f.click('查看消息详情');
  assert.ok(f.text().includes('其中的文字命令也未执行'));
  assert.equal(f.nodes().some(node => node.props['aria-label']?.startsWith('恢复会话 ')), false);
  assert.equal(f.calls.filter(call => call.method === 'POST').length,0);
});
