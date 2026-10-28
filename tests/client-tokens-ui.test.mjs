import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shipped = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
assert.equal(shipped.split('() => h(Panel),').length, 2);
const source = shipped.replace('() => h(Panel),', '() => h(TokenPanel, { active: window.__active, writeBlocked: window.__writeBlocked, onDirtyChange: window.__dirty }),');

// Executes the shipped component and handlers; the owner HTTP boundary is a fixture.
// No host, model, provider, QQ, device, wallet file or account is accessed.
function fixture() {
  let component, hookIndex, rootRender, tree, dirty = false, effects = [], serial = 0, timerId = 0, revision = 1;
  let rootDirty = false, readGate, writeGate, failure;
  const instances = new Map(), calls = [], timers = new Map();
  const tokens = { revision: 'tokens-1', policy: { enabled: true, dailyTokens: 50000, monthlyTokens: 200000, requestReserveTokens: 16384 },
    balanceTokens: 200000, dailyRemainingTokens: 49000, reservedTokens: 16384, availableTokens: 232616,
    unmeteredCount: 1, pendingUnknownCount: 1, overdrawnTokens: 0,
    today: { userTaskTokens: 4000, autonomyTokens: 1000, freeTokens: 1000, pocketTokens: 0 },
    requests: [{ requestId: 'unknown-request', origin: 'autonomy', activityId: 'activity-1', status: 'unknown', startedAt: '2026-10-25T06:00:00Z',
      usage: null, settledTokens: null, freeTokens: null, pocketTokens: null, reservedTokens: 16384, unmetered: true, acknowledgedUnmetered: false },
    { requestId: 'user-request', origin: 'user-task', userTaskId: 'task-1', status: 'failed', startedAt: '2026-10-25T05:00:00Z',
      usage: { totalTokens: 4000 }, freeTokens: 0, pocketTokens: 0, unmetered: false }], transactions: [] };
  const bump = () => { tokens.revision = 'tokens-' + (++revision); };
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
  const host = { __active: true, __writeBlocked: false, __dirty: (value) => { rootDirty = value; }, __ModuleLoader__: { load({ factory }) {
    factory((name) => { assert.equal(name, 'react'); return React; }).apply({ slots: { inject(_name, callback) { callback(); }, register(_definition, render) { rootRender = render; } } });
  } } };
  vm.runInNewContext(source, { window: host, document: {}, AbortController, URL, URLSearchParams, TextEncoder, Date, Math,
    crypto: { randomUUID: () => '12345678-1234-4234-8234-' + (++serial).toString().padStart(12, '0') },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => {
      const route = url.split('/api/')[1], method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ route, method, payload });
      if (method === 'GET') { assert.equal(route, 'tokens/status'); if (readGate) await readGate; }
      else {
        if (writeGate) await writeGate;
        if (failure) return { ok: false, status: 503, json: async () => failure };
        assert.equal(payload.revision, tokens.revision, 'actual handler must send the exact current CAS revision');
        if (route === 'tokens/config') Object.assign(tokens.policy, payload.patch);
        else if (route === 'tokens/bonus') {
          if (!tokens.transactions.some((row) => row.requestId === payload.requestId)) {
            tokens.balanceTokens += payload.tokens;
            tokens.transactions.push({ id: 'bonus:' + payload.requestId, kind: 'bonus', tokens: payload.tokens, requestId: payload.requestId });
          }
        } else if (route === 'tokens/acknowledge') {
          assert.equal(payload.confirmedStopped, true); assert.equal(payload.acknowledgedUnmetered, true);
          const row = tokens.requests.find((item) => item.requestId === payload.requestId); assert(row);
          row.acknowledgedUnmetered = true; tokens.pendingUnknownCount--;
          tokens.reservedTokens -= row.reservedTokens;
          tokens.transactions.push({ id: 'release:' + row.requestId, kind: 'unmetered-release', tokens: row.reservedTokens, requestId: row.requestId });
        } else assert.fail('Unexpected API: ' + route);
        bump();
      }
      return { ok: true, status: 200, json: async () => structuredClone({ ok: true, tokens }) };
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
    assert.fail('Token UI did not settle');
  }
  const nodes = (node = tree) => !node || typeof node !== 'object' || node.props.hidden ? [] : [node, ...node.props.children.flatMap((child) => nodes(child))];
  const text = (node = tree) => typeof node === 'string' ? node : node?.props?.hidden ? '' : node?.props?.children.map((child) => text(child)).join('') || '';
  const button = (label) => nodes().find((node) => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
  const field = (suffix) => nodes().find((node) => node.type === 'input' && node.props.id?.endsWith('-' + suffix));
  async function click(label) { const node = button(label); assert(node, 'Missing button: ' + label); assert.equal(Boolean(node.props.disabled), false); node.props.onClick(); await flush(); }
  async function change(suffix, value) { const node = field(suffix); assert(node, suffix); assert.equal(Boolean(node.props.disabled), false);
    node.props.onChange({ target: { value, checked: value } }); await flush(); }
  async function expand(title) { const node = nodes().find((item) => item.type === 'summary' && text(item) === title); assert(node, title);
    node.props.onClick({ preventDefault() {} }); await flush(); }
  return { tokens, calls, timers, nodes, text, button, field, flush, click, change, expand, get rootDirty() { return rootDirty; },
    bump, setReadGate(value) { readGate = value; }, setWriteGate(value) { writeGate = value; }, setError(value) { failure = value; },
    async active(value) { host.__active = value; await flush(); }, async blocked(value) { host.__writeBlocked = value; await flush(); },
    dispose() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); },
  };
}

test('token opening only reads its independent status and keeps settings and accounting explanations on demand', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  assert.deepEqual(f.calls, [{ route: 'tokens/status', method: 'GET', payload: undefined }]);
  for (const label of ['Token 与零花钱', '今日用户安排', '今日自主使用', '今日免扣剩余', '零花 Token 余额', '1 笔用量待核实']) assert.ok(f.text().includes(label), label);
  assert.equal(f.field('dailyTokens'), undefined); assert.equal(f.button('保存 Token 额度'), undefined);
  assert.equal(f.text().includes('人民币'), false); assert.equal(f.rootDirty, false); assert.equal(f.timers.size, 0);
  await f.click('Token 与零花钱说明');
  for (const phrase of ['用户交办', '失败但实际发生的消耗仍计入', '点击和等待不会按次数编造 Token', '不是人民币', '另一个钱包']) assert.ok(f.text().includes(phrase), phrase);
  assert.equal(f.calls.length, 1);
});

test('token refresh preserves edited policy and CAS version until an explicit adoption, then saves only the changed field', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置');
  await f.change('dailyTokens', '60000'); assert.equal(f.rootDirty, true);
  f.tokens.policy.monthlyTokens = 300000; f.bump(); await f.click('刷新 Token 状态');
  assert.equal(f.field('dailyTokens').props.value, '60000'); assert.equal(f.field('monthlyTokens').props.value, 200000);
  assert.equal(f.button('保存 Token 额度').props.disabled, true);
  assert.ok(f.text().includes('草稿已保留')); assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0);
  await f.click('采用最新版本，保留 Token 草稿');
  assert.equal(f.field('monthlyTokens').props.value, 300000);
  await f.click('保存 Token 额度');
  assert.deepEqual(f.calls.filter((row) => row.method === 'POST'), [{ route: 'tokens/config', method: 'POST', payload: { revision: 'tokens-2', patch: { dailyTokens: 60000 } } }]);
  assert.equal(f.rootDirty, false); assert.equal(f.tokens.policy.enabled, true);
});

test('invalid Token policy fields explain their actual range beside the field and cannot submit a write', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置');
  for (const [key, label, values, minimum] of [
    ['dailyTokens', '每日免扣 Token', ['-1', '', '1.5', '1e3', '1000000000001'], 0],
    ['monthlyTokens', '每月零花 Token', ['-1', '1000000000001'], 0],
    ['requestReserveTokens', '每次请求预留 Token', ['0', '-1', '1000000000001'], 1],
  ]) {
    const previous = f.field(key).props.value;
    for (const value of values) {
      await f.change(key, value);
      const field = f.field(key), error = f.nodes().find((node) => node.props.id === field.props['aria-describedby']);
      assert.equal(field.props['aria-invalid'], true, key + '=' + value);
      assert.equal(field.props.min, minimum); assert.equal(field.props.max, 1000000000000);
      assert.ok(error, 'the field links its visible error for assistive technology');
      assert.equal(error.props.role, 'alert');
      assert.ok(f.text(error).includes(label)); assert.ok(f.text(error).includes(minimum + ' 到 1,000,000,000,000 之间的整数'));
      assert.equal(f.button('保存 Token 额度').props.disabled, true);
    }
    await f.change(key, previous); assert.equal(f.field(key).props['aria-invalid'], false);
  }
  assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0);
  assert.equal(f.tokens.policy.dailyTokens, 50000); assert.equal(f.tokens.balanceTokens, 200000);
});

test('pending monthly tokens are disclosed separately without manufacturing balance or transactions on read', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  Object.assign(f.tokens, { pendingMonthlyTokens: 200000, projectedAvailableTokens: 250000, balanceTokens: 0, availableTokens: 50000 });
  await f.flush();
  const balance = () => f.nodes().find((node) => node.props.className === 'dfy-state-cell' && f.text(node).startsWith('零花 Token 余额'));
  assert.equal(f.text(balance()), '零花 Token 余额0');
  assert.ok(f.text().includes('本月待入账 ' + (200000).toLocaleString() + ' Token'));
  assert.equal(f.text().includes('查看和刷新只读取状态'), false);
  await f.click('本月待入账说明');
  assert.ok(f.text().includes('下次实际调用或保存时同步入账'));
  assert.ok(f.text().includes('查看和刷新只读取状态'));
  await f.click('刷新 Token 状态');
  assert.equal(f.tokens.balanceTokens, 0); assert.deepEqual(f.tokens.transactions, []);
  assert.equal(f.text(balance()), '零花 Token 余额0');
  assert.ok(f.calls.every((row) => row.route === 'tokens/status' && row.method === 'GET'));
});

test('monthly synchronization keeps the policy draft and adopts only its new ledger revision when the policy itself is unchanged', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.tokens.pendingMonthlyTokens = 200000; f.tokens.balanceTokens = 0;
  await f.flush(); await f.expand('高级设置'); await f.change('dailyTokens', '60000');
  f.tokens.pendingMonthlyTokens = 0; f.tokens.balanceTokens = 200000;
  f.tokens.transactions.push({ kind: 'monthly', id: 'month:2026-10', tokens: 200000 }); f.bump();
  await f.click('刷新 Token 状态');
  assert.equal(f.text().includes('本月待入账'), false);
  assert.equal(f.field('dailyTokens').props.value, '60000'); assert.equal(f.rootDirty, true);
  assert.equal(f.button('保存 Token 额度').props.disabled, false, 'a ledger-only change cannot invent a policy conflict');
  assert.equal(f.button('采用最新版本，保留 Token 草稿'), undefined);
  assert.equal(f.tokens.balanceTokens, 200000); assert.equal(f.tokens.transactions.length, 1);
  assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0);
  await f.click('保存 Token 额度');
  assert.deepEqual(f.calls.find((row) => row.route === 'tokens/config').payload, { revision: 'tokens-2', patch: { dailyTokens: 60000 } });
  assert.equal(f.tokens.transactions.length, 1, 'saving the draft does not create another monthly grant');
});

test('normal chat usage updates the CAS revision while preserving policy edits and cannot overwrite unedited policy fields', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置'); await f.change('dailyTokens', '60000');
  f.tokens.today.userTaskTokens += 1234;
  f.tokens.requests.push({ requestId: 'new-chat-request', origin: 'user-task', status: 'completed', usage: { totalTokens: 1234 }, freeTokens: 0, pocketTokens: 0 });
  f.bump(); await f.click('刷新 Token 状态');
  assert.equal(f.field('dailyTokens').props.value, '60000'); assert.equal(f.rootDirty, true);
  assert.equal(f.button('采用最新版本，保留 Token 草稿'), undefined);
  assert.equal(f.button('保存 Token 额度').props.disabled, false);
  assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0);
  await f.click('保存 Token 额度');
  assert.deepEqual(f.calls.find((row) => row.route === 'tokens/config').payload, { revision: 'tokens-2', patch: { dailyTokens: 60000 } });
  assert.equal(f.tokens.today.userTaskTokens, 5234); assert.equal(f.tokens.policy.monthlyTokens, 200000);
  assert.equal(f.rootDirty, false);
});

test('negative balances remain visible as debt with an explicit overdraw warning rather than zero or unknown', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.tokens.balanceTokens = -350; delete f.tokens.overdrawnTokens;
  await f.flush();
  const balance = f.nodes().find((node) => node.props.className === 'dfy-state-cell' && f.text(node).startsWith('零花 Token 余额'));
  assert.equal(f.text(balance), '零花 Token 余额' + (-350).toLocaleString());
  assert.ok(f.text().includes('超支 350 Token，需要处理。'));
  assert.equal(f.text(balance).includes('—'), false);
  assert.equal(f.text().includes('本月待入账'), false, 'older responses without projections remain compatible');
  assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0);
});

test('token bonus validates whole counts and duplicate clicks share one stable UUID and one request', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置');
  for (const value of ['', '0', '-1', '1.5', '1e3', '9007199254740992']) {
    await f.change('bonus', value); assert.equal(f.button('发放零花 Token').props.disabled, true, value);
  }
  await f.change('bonus', '100'); let release; f.setWriteGate(new Promise((resolve) => { release = resolve; }));
  const run = f.button('发放零花 Token').props.onClick; run(); run(); await f.flush();
  assert.equal(f.calls.filter((row) => row.route === 'tokens/bonus').length, 1);
  assert.equal(f.button('发放中…').props.disabled, true); release(); await f.flush();
  assert.equal(f.tokens.balanceTokens, 200100); assert.equal(f.tokens.transactions.length, 1);
  assert.match(f.tokens.transactions[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(f.field('bonus').props.value, ''); assert.equal(f.rootDirty, false);
});

test('unknown bonus delivery freezes its amount and keeps the original UUID until a matching ledger receipt is read', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置'); await f.change('bonus', '200');
  f.setError({ ok: false, error: '请求未确认', code: 'UNCONFIRMED' }); await f.click('发放零花 Token');
  const sent = f.calls.find((row) => row.route === 'tokens/bonus');
  assert.equal(f.field('bonus').props.disabled, true); assert.equal(f.button('发放零花 Token').props.disabled, true);
  assert.ok(f.text().includes('不会自动重复操作')); assert.equal(f.rootDirty, true);
  f.setError(null); await f.click('刷新 Token 状态');
  assert.equal(f.calls.filter((row) => row.route === 'tokens/bonus').length, 1); assert.equal(f.field('bonus').props.value, '200');
  f.tokens.transactions.push({ kind: 'bonus', tokens: 200, requestId: sent.payload.requestId }); f.tokens.balanceTokens += 200; f.bump();
  await f.click('刷新 Token 状态');
  assert.equal(f.field('bonus').props.value, ''); assert.equal(f.field('bonus').props.disabled, false); assert.equal(f.rootDirty, false);
  assert.equal(f.calls.filter((row) => row.route === 'tokens/bonus').length, 1);
});

test('unknown usage requires an explicit stopped-and-unmetered checkbox and remains unmetered after releasing its reserve', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置'); await f.expand('用量与变动明细');
  assert.ok(f.text().includes('实际用量：未计量')); assert.equal(f.text().includes('实际用量：0 Token'), false);
  assert.equal(f.button('确认停止并释放预留').props.disabled, true);
  const checkbox = f.nodes().find((node) => node.props['aria-label'] === '确认请求已停止并接受未计量 unknown-request');
  checkbox.props.onChange({ target: { checked: true } }); await f.flush();
  await f.click('确认停止并释放预留');
  assert.deepEqual(f.calls.find((row) => row.route === 'tokens/acknowledge').payload,
    { revision: 'tokens-1', requestId: 'unknown-request', confirmedStopped: true, acknowledgedUnmetered: true });
  assert.equal(f.tokens.requests[0].usage, null); assert.equal(f.tokens.requests[0].status, 'unknown');
  assert.equal(f.tokens.unmeteredCount, 1); assert.equal(f.tokens.pendingUnknownCount, 0);
  assert.ok(f.text().includes('未计量（已确认停止）')); assert.ok(f.text().includes('未计量请求释放预留'));
  assert.equal(f.text().includes('实际用量：0 Token'), false); assert.equal(f.button('确认停止并释放预留'), undefined);
});

test('refresh clears stale unknown-usage confirmations after real usage settles while preserving actionable confirmations', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置'); await f.expand('用量与变动明细');
  const checkbox = () => f.nodes().find((node) => node.props['aria-label'] === '确认请求已停止并接受未计量 unknown-request');
  checkbox().props.onChange({ target: { checked: true } }); await f.flush();
  assert.equal(f.rootDirty, true);
  await f.click('刷新 Token 状态');
  assert.equal(checkbox().props.checked, true, 'an unresolved request keeps the explicit user confirmation');
  const row = f.tokens.requests[0];
  Object.assign(row, { status: 'cancelled', usage: { totalTokens: 321 }, freeTokens: 321, pocketTokens: 0, unmetered: false });
  f.tokens.pendingUnknownCount = 0; f.tokens.unmeteredCount = 0; f.bump();
  await f.click('刷新 Token 状态');
  assert.equal(checkbox(), undefined); assert.equal(f.button('确认停止并释放预留'), undefined);
  assert.equal(f.rootDirty, false, 'an invisible stale checkbox cannot leave the parent page unsaved');
  assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0, 'refresh never acknowledges or releases a request');
  assert.ok(f.text().includes('实际用量：321 Token'));
});

test('explicit bonus confirmation reads the latest revision then completes only the original UUID and frozen amount', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置'); await f.change('bonus', '200');
  f.setError({ ok: false, error: '请求未确认', code: 'UNCONFIRMED' }); await f.click('发放零花 Token');
  const original = f.calls.find((row) => row.route === 'tokens/bonus').payload;
  f.setError(null); f.bump(); const before = f.calls.length;
  await f.click('确认同一笔发放');
  assert.deepEqual(f.calls.slice(before), [
    { route: 'tokens/status', method: 'GET', payload: undefined },
    { route: 'tokens/bonus', method: 'POST', payload: { revision: 'tokens-2', requestId: original.requestId, tokens: 200 } },
  ]);
  assert.equal(f.tokens.balanceTokens, 200200); assert.equal(f.tokens.transactions.length, 1);
  assert.equal(f.tokens.transactions[0].requestId, original.requestId);
  assert.equal(f.field('bonus').props.value, ''); assert.equal(f.rootDirty, false);
  assert.ok(f.text().includes('已完成原申请，没有新建一笔发放'));
});

test('bonus confirmation is read-only when the original UUID and amount are already in the ledger', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置'); await f.change('bonus', '200');
  f.setError({ ok: false, error: '请求未确认', code: 'UNCONFIRMED' }); await f.click('发放零花 Token');
  const original = f.calls.find((row) => row.route === 'tokens/bonus').payload;
  f.tokens.transactions.push({ kind: 'bonus', requestId: original.requestId, tokens: 200 }); f.tokens.balanceTokens += 200; f.bump();
  f.setError(null); const before = f.calls.length; await f.click('确认同一笔发放');
  assert.deepEqual(f.calls.slice(before), [{ route: 'tokens/status', method: 'GET', payload: undefined }]);
  assert.equal(f.calls.filter((row) => row.method === 'POST').length, 1);
  assert.equal(f.field('bonus').props.value, ''); assert.equal(f.rootDirty, false);
  assert.ok(f.text().includes('原申请的零花 Token 已到账'));
});

test('duplicate confirmation clicks share one read and hiding during that read cannot issue a new bonus write', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置'); await f.change('bonus', '200');
  f.setError({ ok: false, error: '请求未确认', code: 'UNCONFIRMED' }); await f.click('发放零花 Token'); f.setError(null);
  let release; f.setReadGate(new Promise((resolve) => { release = resolve; }));
  const before = f.calls.length, run = f.button('确认同一笔发放').props.onClick;
  run(); run(); await f.flush();
  assert.equal(f.calls.slice(before).filter((row) => row.route === 'tokens/status').length, 1);
  assert.equal(f.button('核对中…').props.disabled, true);
  await f.active(false); release(); await f.flush();
  assert.equal(f.calls.filter((row) => row.method === 'POST').length, 1);
  assert.equal(f.field('bonus').props.value, '200'); assert.equal(f.field('bonus').props.disabled, true);
});

test('token reads and writes serialize while hidden or blocked stale write handlers cannot change the wallet', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.expand('高级设置'); await f.change('dailyTokens', '100');
  const stale = f.button('保存 Token 额度').props.onClick;
  await f.blocked(true); stale(); await f.flush(); assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0);
  await f.blocked(false); await f.active(false); stale(); await f.flush(); assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0);
  await f.active(true); let release; f.setReadGate(new Promise((resolve) => { release = resolve; }));
  const run = f.button('刷新 Token 状态').props.onClick; run(); run(); await f.flush();
  assert.equal(f.calls.filter((row) => row.route === 'tokens/status').length, 2); assert.equal(f.button('刷新中…').props.disabled, true);
  stale(); await f.flush(); assert.equal(f.calls.filter((row) => row.method === 'POST').length, 0);
  release(); await f.flush(); assert.equal(f.field('dailyTokens').props.value, '100');
});
