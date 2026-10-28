import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { AutonomyEngine } from '../packages/dsh-dafeiyu/src/autonomy-engine.js';
import { lifeOperation } from '../packages/dsh-dafeiyu/src/life-panel.js';
import { TokenBudget } from '../packages/dsh-dafeiyu/src/token-budget.js';

// Execute the shipped component, its hooks and handlers against the actual
// owner service and private store; this is not a second UI implementation.
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'life-ui-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const memory = new LifeMemory({ directory }), scope = { accountId: '20002', identityId: 'default' }, calls = [], replies = [];
  const engine = new AutonomyEngine({ memory, run: async () => {}, send: async () => {}, scopes: () => [scope] });
  t.after(() => engine.dispose()); const runtime = { lifeMemory: memory, autonomy: engine };
  let hooks = [], index = 0, effects = [], dirty = false, tree, rootDirty = false, failure = false;
  let afterCommitFailure = false, failReadback = false, failNextRead = false, readGate, writeGate, serial = 0, previewOverride = null;
  const props = { active: true, refreshKey: 0, writeBlocked: false, accounts: [{ qq: scope.accountId, name: '测试账号', enabled: true, activeIdentityId: scope.identityId }],
    onDirtyChange: (value) => { rootDirty = value; }, ...options };
  const React = { Fragment: Symbol('fragment'), createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState(initial) { const slot = index++; hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, (value) => { const next = typeof value === 'function' ? value(hooks[slot].value) : value; if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; } }]; },
    useRef(initial) { const slot = index++; return hooks[slot] ||= { current: initial }; },
    useEffect(effect, deps) { const slot = index++, old = hooks[slot];
      if (!old || !deps || deps.some((value, at) => !Object.is(value, old.deps?.[at]))) {
        hooks[slot] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); hooks[slot].cleanup = effect(); });
      }
    } };
  t.after(() => { for (const hook of hooks) hook.cleanup?.(); });
  const api = { alive: { current: true }, cancel() {}, async call(route, method = 'GET', payload, timeoutMs, signal) {
    // Match fetch's JSON boundary, so later draft edits cannot mutate a sent request.
    payload = payload === undefined ? undefined : structuredClone(payload);
    calls.push({ route, method, payload, timeoutMs });
    if (method === 'GET' && readGate) await readGate;
    if (method === 'POST' && writeGate) await writeGate;
    if (method === 'GET' && failNextRead) { failNextRead = false; throw new Error('FIXTURE_READBACK_FAILURE'); }
    if (failure) throw new Error('FIXTURE_FAILURE');
    if (route.startsWith('life?')) {
      assert.equal(method, 'GET'); const query = Object.fromEntries(new URLSearchParams(route.split('?')[1])); query.offset = Number(query.offset); query.limit = Number(query.limit);
      const life = await lifeOperation(() => runtime, 'snapshot', query, { authorize: () => true });
      if (previewOverride) life.preview = { ...life.preview, ...previewOverride };
      return { ok: true, life };
    }
    assert.equal(route, 'life/action'); assert.equal(method, 'POST', 'the shipped component must use the actual usePanelApi signature');
    const life = await lifeOperation(() => runtime, payload.action, payload.input, { authorize: () => !signal?.aborted, signal });
    replies.push(structuredClone(life));
    if (failReadback) { failReadback = false; failNextRead = true; }
    if (afterCommitFailure) { afterCommitFailure = false; throw new Error('FIXTURE_NETWORK_AFTER_COMMIT'); }
    return { ok: true, life };
  } };
  const source = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('    function LifePanel('), end = source.indexOf('    function MemoryPanel(', start);
  const Component = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', { React, ...React, h: React.createElement, TokenPanel: () => null,
    SectionHeading: ({ title, children }) => ({ type: 'div', props: { className: 'dfy-section-heading', children: [title, ...(children || [])] } }),
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b), usePanelApi: () => api, URLSearchParams, AbortController,
    crypto: { randomUUID: () => '00112233-4455-4677-8899-' + (++serial).toString().padStart(12, '0') } });
  const flatten = (node) => node == null || node === false ? [] : typeof node === 'object' ? [node, ...(node.props?.children || []).flatMap(flatten)] : [];
  const content = (node) => node == null || node === false ? '' : typeof node === 'object' ? (node.props?.children || []).map(content).join('') : String(node);
  // Mini renderer must instantiate function components like real React,
  // otherwise h(SomeComponent) elements only expose their spread children.
  const resolve = (node) => {
    if (node == null || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return resolve(node.type(node.props));
    const children = node.props?.children;
    return { ...node, props: { ...node.props, children: Array.isArray(children) ? children.map(resolve) : children } };
  };
  async function reload() { props.refreshKey++; await flush(); }
  async function flush() { for (let round = 0; round < 20; round++) {
    dirty = false; index = 0; effects = [];
    tree = resolve(Component(props));
    for (const effect of effects) effect();
    await new Promise((resolve) => setImmediate(resolve)); if (!dirty) break;
  } }
  const findButton = (label) => flatten(tree).find((node) => node.type === 'button' && content(node) === label);
  const findInput = (label) => {
    const node = flatten(tree).find((node) => node.type === 'label' && content(node).trimStart().startsWith(label)); assert.ok(node, label);
    const input = flatten(node).find((item) => ['input', 'textarea', 'select'].includes(item.type)); assert.ok(input, label); return input;
  };
  return { memory, engine, calls, replies, scope, flush, get text() { return content(tree); }, get rootDirty() { return rootDirty; },
    get uuidCount() { return serial; }, get posts() { return calls.filter((call) => call.method === 'POST'); },
    fail(value) { failure = value; }, failAfterCommit() { afterCommitFailure = true; }, failReadbackOnce() { failReadback = true; },
    readOnly(value) { memory.lastError = value ? { code: 'STORAGE', message: '生活记录待核实，当前只读' } : null; },
    async simulateGate(value) { props.writeBlocked = value; await flush(); },
    async setProps(patch) { Object.assign(props, patch); await flush(); },
    setPreview(value) { previewOverride = value; },
    async simulateCancelGate(value) { props.cancelBlocked = value; await flush(); },
    async setAlive(value) { api.alive.current = value; await flush(); },
    hold(method) { let release; const gate = new Promise((resolve) => { release = resolve; });
      if (method === 'GET') readGate = gate; else writeGate = gate;
      return () => { if (method === 'GET') readGate = null; else writeGate = null; release(); }; },
    async click(label) { const node = findButton(label); assert.ok(node, label); assert.ok(!node.props.disabled, label + ' is disabled'); await node.props.onClick(); await flush(); },
    async invoke(node) { assert.ok(node); await node.props.onClick(); await flush(); },
    async input(label, value) { const input = findInput(label); await input.props.onChange({ target: { value, checked: value } }); await flush(); },
    inputNode: findInput, value: (label) => findInput(label).props.value, checked: (label) => findInput(label).props.checked,
    nodes: () => flatten(tree), textOf: content, reload,
    section: (label) => flatten(tree).find((node) => node.type === 'section' && node.props.children.some((child) =>
      child?.type === 'h3' && content(child) === label
      || child?.type === 'div' && child.props?.className === 'dfy-section-heading' && child.props.children[0] === label)),
    details: (label) => flatten(tree).find((node) => node.type === 'details' && node.props.children.some((child) => child?.type === 'summary' && content(child) === label)),
    recordTitles: () => flatten(tree).filter((node) => node.type === 'strong').map(content),
    alerts: () => flatten(tree).filter((node) => node.props?.role === 'alert').map(content).join('\n'), button: findButton };
}
test('actual life UI reads without running work and saves each settings form using the current CAS revision', async (t) => {
  const f = fixture(t); await f.flush(); assert.match(f.text, /生活与成长/); assert.equal(f.calls.length, 1);
  await f.input('自动整理日常聊天', true); assert.equal(f.rootDirty, true);
  await f.click('保存记忆与成长设置'); assert.equal(f.memory.policy().learningEnabled, true); assert.equal(f.rootDirty, false);
  await f.input('每日基础分钟', '20'); await f.input('每月零花分钟', '120'); await f.input('启用娱乐时间额度', true);
  await f.click('保存时间额度'); assert.equal(f.engine.wallet.snapshot().dailyRemainingSeconds, 1200); assert.equal(f.engine.wallet.snapshot().balance, 7200);
  await f.input('额外发放分钟', '5'); await f.click('发放零花时间'); assert.equal(f.engine.wallet.snapshot().balance, 7500);
  assert.equal(f.engine.snapshot().activities.length, 0);
});
test('actual life UI places independent Douyin interaction switches in advanced settings and saves without running work', async t => {
  const f = fixture(t); await f.flush();
  const advanced = f.details('高级设置'); assert.ok(advanced);
  assert.match(f.textOf(advanced), /抖音自主互动/);
  assert.match(f.textOf(advanced), /仍受额度与频率限制/);
  for (const label of ['允许自主点赞', '允许自主关注', '允许自主评论']) {
    assert.equal(f.checked(label), false);
    assert.ok(f.nodes().includes(f.inputNode(label)));
  }
  await f.input('允许自主点赞', true); await f.input('允许自主评论', true);
  await f.input('普通经历保留细节的天数', '7');
  await f.click('保存自主活动范围');
  assert.deepEqual(f.engine.snapshot().policy.douyinInteractions, { like: true, follow: false, comment: true });
  assert.equal(f.engine.snapshot().policy.enabled, false);
  assert.equal(f.engine.snapshot().policy.browse, false);
  assert.equal(f.engine.snapshot().activities.length, 0);
  assert.equal(f.value('普通经历保留细节的天数'), '7', 'saving interactions retains a different settings draft');
  await f.input('允许自主点赞', false); await f.click('保存自主活动范围');
  assert.deepEqual(f.engine.snapshot().policy.douyinInteractions, { like: false, follow: false, comment: true });
  assert.deepEqual(f.posts.map(call => call.payload.action), ['autonomy-policy', 'autonomy-policy']);
});
test('actual life interaction drafts survive refresh and external grant changes refuse a stale save', async t => {
  const f = fixture(t); await f.flush();
  await f.input('允许自主关注', true);
  await f.reload(); assert.equal(f.checked('允许自主关注'), true);
  f.engine.configure({ douyinInteractions: { comment: true } }, { authorize: () => true });
  await f.reload();
  assert.equal(f.checked('允许自主关注'), true);
  const before = f.posts.length; await f.invoke(f.button('保存自主活动范围'));
  assert.equal(f.posts.length, before);
  assert.match(f.alerts(), /别处更新/);
  assert.deepEqual(f.engine.snapshot().policy.douyinInteractions, { like: false, follow: false, comment: true });
  await f.click('撤销未保存修改');
  assert.equal(f.checked('允许自主关注'), false); assert.equal(f.checked('允许自主评论'), true);
});
test('a busy runtime permits only saved interaction revocations and preserves unrelated drafts', async t => {
  const f = fixture(t); await f.flush();
  f.engine.configure({ douyinInteractions: { like: true, follow: true } }, { authorize: () => true });
  await f.reload();
  await f.input('每日自主活动总次数上限', '7');
  await f.setProps({ writeBlocked: true, revokeBlocked: false });
  assert.equal(f.inputNode('允许自主点赞').props.disabled, false);
  assert.equal(f.inputNode('允许自主评论').props.disabled, true);
  await f.input('允许自主评论', true);
  assert.equal(f.checked('允许自主评论'), false, 'a handler bypass cannot escalate during a busy activity');
  await f.input('允许自主点赞', false);
  assert.equal(f.button('保存自主活动范围').props.disabled, true);
  const stale = f.button('仅保存关闭的抖音互动');
  await f.click('仅保存关闭的抖音互动');
  assert.deepEqual(f.posts.at(-1).payload.input.patch, { douyinInteractions: { like: false } });
  assert.deepEqual(f.engine.snapshot().policy.douyinInteractions, { like: false, follow: true, comment: false });
  assert.equal(f.engine.snapshot().policy.maxActivities, 4);
  assert.equal(f.value('每日自主活动总次数上限'), '7'); assert.equal(f.rootDirty, true);
  const count = f.posts.length;
  await f.invoke(stale); assert.equal(f.posts.length, count, 'stale revocation is not sent twice');
  await f.input('允许自主关注', false);
  const pending = f.button('仅保存关闭的抖音互动');
  await f.setProps({ revokeBlocked: true });
  await f.invoke(pending); assert.equal(f.posts.length, count, 'maintenance still blocks a stale revocation');
});
test('actual life UI preserves failed drafts and supports inspect, correct and explicit delete', async (t) => {
  const f = fixture(t); await f.flush();
  await f.input('自动整理日常聊天', true); f.fail(true); await f.click('保存记忆与成长设置'); assert.match(f.text, /(?:草稿|输入)仍保留/); assert.equal(f.rootDirty, true);
  f.fail(false); await f.click('保存记忆与成长设置');
  f.memory.capture({ phase: 'received', messageId: '1', selfId: '10001', scope: f.scope, userText: 'UI_DELETE_SECRET_CANARY' }, { authorize: () => true });
  await f.reload(); await f.click('查看与管理这条经历'); await f.input('纠正经历内容', '用户纠正后的内容');
  await f.click('保存经历纠正'); assert.equal(f.memory.snapshot().items[0].detail, '用户纠正后的内容');
  await f.click('查看与管理这条经历'); assert.equal(f.button('删除这条生活记忆').props.disabled, true);
  await f.input('确认删除此条受管记忆', true); await f.click('删除这条生活记忆'); assert.equal(f.memory.snapshot().total, 0);
});

test('life numeric inputs retain an empty string while editing and invalid drafts never POST', async (t) => {
  const f = fixture(t); await f.flush();
  await f.input('普通经历保留细节的天数', '');
  assert.equal(f.value('普通经历保留细节的天数'), '', 'clearing a number must not immediately turn into zero');
  assert.equal(f.rootDirty, true);
  const before = f.posts.length;
  await f.invoke(f.button('保存记忆与成长设置'));
  assert.equal(f.posts.length, before, 'handler must also reject an empty draft');
  assert.match(f.alerts(), /普通经历保留细节的天数/, 'saving an invalid draft names the field');
  await f.input('普通经历保留细节的天数', '12');
  assert.equal(f.value('普通经历保留细节的天数'), '12');
  await f.click('保存记忆与成长设置');
  assert.equal(f.memory.policy().detailedDays, 12);
  assert.equal(f.value('普通经历保留细节的天数'), '12');
});

test('life forms validate actual day, minute, hour and session boundaries before sending', async (t) => {
  const f = fixture(t); await f.flush(); await f.input('允许自主浏览视频平台', true);
  const cases = [
    ['普通经历保留细节的天数', '保存记忆与成长设置', ['', '-1', '0', '3651', '1.5']],
    ['普通概要参与主动回忆的天数', '保存记忆与成长设置', ['', '-1', '0', '3651', '1.5', '2']],
    ['每日基础分钟', '保存时间额度', ['', '-1', '525601', '0.001']],
    ['每月零花分钟', '保存时间额度', ['', '-1', '525601', '0.001']],
    ['免打扰开始时间', '保存自主活动范围', ['', '-1', '24', '0.5']],
    ['免打扰结束时间', '保存自主活动范围', ['', '-1', '24', '0.5']],
    ['每个聊天身份每日主动联系上限', '保存自主活动范围', ['', '0', '-1', '21', '1.5']],
    ['每日自主活动总次数上限', '保存自主活动范围', ['', '0', '-1', '21', '1.5']],
    ['主动聊天最小间隔分钟', '保存自主活动范围', ['', '0', '-1', '1441', '1.5']],
    ['单次娱乐最多分钟', '保存自主活动范围', ['', '0', '-1', '60.1', '0.001']],
  ];
  for (const [label, save, invalid] of cases) {
    const stored = String(f.value(label));
    for (const value of invalid) {
      await f.input(label, value);
      assert.equal(f.value(label), value, label + ': invalid input remains editable');
      const before = f.posts.length;
      await f.invoke(f.button(save));
      assert.equal(f.posts.length, before, label + ': bypassing disabled must still not POST');
      assert.ok(f.alerts().trim(), label + ': saving an invalid draft needs a visible error');
    }
    await f.input(label, stored);
  }
  assert.equal(f.posts.length, 0);
  assert.equal(f.engine.snapshot().activities.length, 0);
});

test('zero time allowances and valid display-unit boundaries save as exact underlying seconds', async (t) => {
  const f = fixture(t); await f.flush(); await f.input('允许自主浏览视频平台', true);
  await f.input('每日基础分钟', '0'); await f.input('每月零花分钟', '0');
  await f.click('保存时间额度');
  assert.equal(f.posts.at(-1).payload.input.patch.dailySeconds, 0);
  assert.equal(f.posts.at(-1).payload.input.patch.monthlySeconds, 0);
  assert.equal(f.value('每日基础分钟'), '0');
  await f.input('每日基础分钟', '0.5'); await f.input('每月零花分钟', '525600');
  await f.click('保存时间额度');
  assert.equal(f.engine.wallet.snapshot().policy.dailySeconds, 30);
  assert.equal(f.engine.wallet.snapshot().policy.monthlySeconds, 31536000);
  await f.input('普通概要参与主动回忆的天数', '3650'); await f.input('普通经历保留细节的天数', '3650');
  await f.click('保存记忆与成长设置'); assert.equal(f.memory.policy().detailedDays, 3650);
  await f.input('免打扰开始时间', '0'); await f.input('免打扰结束时间', '23');
  await f.input('每个聊天身份每日主动联系上限', '20'); await f.input('每日自主活动总次数上限', '20');
  await f.input('主动聊天最小间隔分钟', '1440'); await f.input('单次娱乐最多分钟', '0.5');
  await f.click('保存自主活动范围');
  const policy = f.engine.snapshot().policy;
  assert.equal(policy.quietStart, 0); assert.equal(policy.quietEnd, 23);
  assert.equal(policy.maxContacts, 20); assert.equal(policy.maxActivities, 20);
  assert.equal(policy.minGapMinutes, 1440); assert.equal(policy.sessionSeconds, 30);
  await f.input('单次娱乐最多分钟', '60'); await f.click('保存自主活动范围');
  assert.equal(f.engine.snapshot().policy.sessionSeconds, 3600);
  assert.equal(f.engine.snapshot().activities.length, 0, 'saving ranges cannot trigger autonomous work');
});

test('each life section saves and reads back without erasing another section draft', async (t) => {
  const f = fixture(t); await f.flush(); await f.input('允许自主浏览视频平台', true);
  await f.input('普通经历保留细节的天数', '7');
  await f.input('每日基础分钟', '45'); await f.input('每月零花分钟', '180');
  await f.input('免打扰开始时间', '22'); await f.input('单次娱乐最多分钟', '5');
  await f.click('保存记忆与成长设置');
  assert.equal(f.memory.policy().detailedDays, 7); assert.equal(f.value('普通经历保留细节的天数'), '7');
  assert.equal(f.value('每日基础分钟'), '45'); assert.equal(f.value('免打扰开始时间'), '22'); assert.equal(f.rootDirty, true);
  await f.input('普通概要参与主动回忆的天数', '90');
  await f.click('保存时间额度');
  assert.equal(f.engine.wallet.snapshot().policy.dailySeconds, 2700); assert.equal(f.value('每日基础分钟'), '45');
  assert.equal(f.value('每月零花分钟'), '180'); assert.equal(f.value('普通概要参与主动回忆的天数'), '90');
  assert.equal(f.value('单次娱乐最多分钟'), '5'); assert.equal(f.rootDirty, true);
  await f.input('每日基础分钟', '46'); await f.click('保存自主活动范围');
  assert.equal(f.engine.snapshot().policy.quietStart, 22); assert.equal(f.engine.snapshot().policy.sessionSeconds, 300);
  assert.equal(f.value('免打扰开始时间'), '22'); assert.equal(f.value('单次娱乐最多分钟'), '5');
  assert.equal(f.value('普通概要参与主动回忆的天数'), '90'); assert.equal(f.value('每日基础分钟'), '46');
  assert.equal(f.memory.policy().summaryDays, 30, 'a save in another section cannot persist the unsaved memory draft');
  assert.equal(f.engine.wallet.snapshot().policy.dailySeconds, 2700);
  assert.equal(f.rootDirty, true);
  assert.deepEqual(f.posts.map((row) => row.payload.action), ['memory-policy', 'wallet-policy', 'autonomy-policy']);
});

test('refresh retains all unsaved life drafts and explicit undo restores the latest saved values', async (t) => {
  const f = fixture(t); await f.flush();
  await f.input('普通经历保留细节的天数', '7'); await f.click('保存记忆与成长设置');
  await f.input('普通经历保留细节的天数', '8'); await f.input('每日基础分钟', '25');
  await f.input('免打扰开始时间', '21'); await f.input('额外发放分钟', '5');
  const before = f.posts.length;
  await f.reload();
  assert.equal(f.value('普通经历保留细节的天数'), '8'); assert.equal(f.value('每日基础分钟'), '25');
  assert.equal(f.value('免打扰开始时间'), '21'); assert.equal(f.value('额外发放分钟'), '5');
  assert.equal(f.rootDirty, true); assert.equal(f.posts.length, before, 'refresh is read only');
  await f.click('撤销未保存修改');
  assert.equal(f.value('普通经历保留细节的天数'), '7'); assert.equal(f.value('每日基础分钟'), '0');
  assert.equal(f.value('免打扰开始时间'), '23'); assert.equal(f.value('额外发放分钟'), '');
  assert.equal(f.rootDirty, false); assert.equal(f.posts.length, before, 'discarding drafts does not save');
});

test('a successful time bonus retains its amount and needs an explicit new grant before another UUID', async (t) => {
  const f = fixture(t); await f.flush(); await f.input('额外发放分钟', '5');
  await f.click('发放零花时间');
  assert.equal(f.value('额外发放分钟'), '5'); assert.equal(f.engine.wallet.snapshot().balance, 300);
  assert.match(f.text, /(?:已发放|发放成功|已到账)[^。\n]*5[^。\n]*分钟/);
  assert.equal(f.uuidCount, 1); const first = f.posts.at(-1).payload.input.requestId;
  const send = f.button('已发放'); assert.ok(send); assert.equal(send.props.disabled, true);
  await f.invoke(send); assert.equal(f.posts.length, 1); assert.equal(f.engine.wallet.snapshot().balance, 300);
  await f.reload();
  assert.equal(f.value('额外发放分钟'), '5'); assert.equal(f.uuidCount, 1);
  assert.equal(f.button('已发放').props.disabled, true);
  await f.click('再发一笔'); assert.equal(f.value('额外发放分钟'), '5');
  await f.click('发放零花时间');
  assert.equal(f.engine.wallet.snapshot().balance, 600); assert.equal(f.uuidCount, 2);
  assert.notEqual(f.posts.at(-1).payload.input.requestId, first);
  assert.equal(f.engine.wallet.snapshot().transactions.filter((row) => row.kind === 'bonus').length, 2);
});

test('a failed bonus retains amount and UUID, and a same-request retry cannot mint twice', async (t) => {
  const f = fixture(t); await f.flush(); await f.input('额外发放分钟', '7'); f.fail(true);
  await f.click('发放零花时间');
  assert.equal(f.value('额外发放分钟'), '7'); assert.equal(f.uuidCount, 1);
  assert.equal(f.engine.wallet.snapshot().balance, 0); assert.match(f.text, /(?:草稿|输入)仍保留|保留.*草稿/);
  const first = f.posts[0].payload.input.requestId;
  f.fail(false); await f.reload();
  assert.equal(f.value('额外发放分钟'), '7');
  await f.click('继续本次发放');
  assert.equal(f.posts[1].payload.input.requestId, first); assert.equal(f.uuidCount, 1);
  assert.equal(f.engine.wallet.snapshot().balance, 420);
  await f.invoke(f.button('已发放'));
  assert.equal(f.engine.wallet.snapshot().balance, 420); assert.equal(f.posts.length, 2);
});

test('refresh verifies a bonus committed before a lost response and does not submit a replacement grant', async (t) => {
  const f = fixture(t); await f.flush(); await f.input('额外发放分钟', '9'); f.failAfterCommit();
  await f.click('发放零花时间');
  assert.equal(f.engine.wallet.snapshot().balance, 540); assert.equal(f.value('额外发放分钟'), '9');
  const first = f.posts[0].payload.input.requestId; assert.equal(f.uuidCount, 1);
  await f.reload();
  assert.equal(f.posts.length, 1); assert.equal(f.value('额外发放分钟'), '9'); assert.equal(f.uuidCount, 1);
  assert.match(f.text, /(?:已发放|发放成功|已到账|已核对)[^。\n]*9[^。\n]*分钟/);
  assert.equal(f.button('已发放').props.disabled, true);
  await f.invoke(f.button('已发放'));
  assert.equal(f.posts.length, 1); assert.equal(f.engine.wallet.snapshot().balance, 540);
  assert.equal(f.engine.wallet.snapshot().transactions.filter((row) => row.id === 'bonus:' + first).length, 1);
});

test('maintenance and disposed UI gates reject life saves even when a handler bypasses disabled', async (t) => {
  const f = fixture(t); await f.flush();
  await f.input('普通经历保留细节的天数', '8'); await f.input('每日基础分钟', '20');
  await f.input('免打扰开始时间', '22'); await f.input('额外发放分钟', '5');
  const saveLabels = ['保存记忆与成长设置', '保存时间额度', '保存自主活动范围', '发放零花时间'];
  const stale = saveLabels.map(f.button);
  await f.simulateGate(true);
  for (const label of saveLabels) { assert.equal(f.button(label).props.disabled, true, label); await f.invoke(f.button(label)); }
  for (const node of stale) await f.invoke(node);
  assert.equal(f.posts.length, 0); assert.equal(f.uuidCount, 0, 'blocked grants do not allocate a request');
  await f.simulateGate(false); await f.setAlive(false);
  for (const label of saveLabels) await f.invoke(f.button(label));
  assert.equal(f.posts.length, 0); assert.equal(f.rootDirty, true);
  assert.equal(f.memory.policy().detailedDays, 3); assert.equal(f.engine.wallet.snapshot().balance, 0);
});

test('each settings failure keeps the exact draft and retries against the actual saved revision', async (t) => {
  const f = fixture(t); await f.flush();
  const cases = [
    ['普通经历保留细节的天数', '9', '保存记忆与成长设置', () => f.memory.policy().detailedDays, 9],
    ['每日基础分钟', '12.5', '保存时间额度', () => f.engine.wallet.snapshot().policy.dailySeconds, 750],
    ['单次娱乐最多分钟', '2.5', '保存自主活动范围', () => f.engine.snapshot().policy.sessionSeconds, 150],
  ];
  for (const [label, value, save, stored, expected] of cases) {
    if (label === '单次娱乐最多分钟') await f.input('允许自主浏览视频平台', true);
    await f.input(label, value); f.fail(true); const before = stored();
    await f.click(save); assert.equal(stored(), before); assert.equal(f.value(label), value);
    assert.equal(f.rootDirty, true); assert.match(f.alerts(), /(?:输入|草稿)仍保留/);
    f.fail(false); await f.click(save); assert.equal(stored(), expected); assert.equal(f.value(label), value);
    assert.equal(f.rootDirty, false);
  }
});

test('bonus boundaries reject invalid values without changing the actual wallet', async (t) => {
  const f = fixture(t); await f.flush();
  for (const value of ['', '0', '-1', '525601', '0.001']) {
    await f.input('额外发放分钟', value); const before = f.posts.length;
    await f.invoke(f.button('发放零花时间'));
    assert.equal(f.posts.length, before, 'invalid bonus ' + JSON.stringify(value));
    assert.equal(f.value('额外发放分钟'), value); assert.match(f.alerts(), /额外发放分钟/);
    assert.equal(f.engine.wallet.snapshot().balance, 0);
  }
  await f.input('额外发放分钟', '0.5'); await f.click('发放零花时间');
  assert.equal(f.engine.wallet.snapshot().balance, 30); assert.equal(f.value('额外发放分钟'), '0.5');
});

test('rapid repeat bonus handlers share one pending grant and keep the amount locked for verification', async (t) => {
  const f = fixture(t); await f.flush(); await f.input('额外发放分钟', '11');
  const release = f.hold('POST'), button = f.button('发放零花时间');
  const pending = f.invoke(button); await f.flush();
  assert.equal(f.posts.length, 1); assert.equal(f.uuidCount, 1);
  assert.equal(f.inputNode('额外发放分钟').props.disabled, true);
  await f.invoke(button); await f.input('额外发放分钟', '99');
  assert.equal(f.posts.length, 1); assert.equal(f.value('额外发放分钟'), '11');
  release(); await pending;
  assert.equal(f.engine.wallet.snapshot().balance, 660); assert.equal(f.value('额外发放分钟'), '11');
  assert.equal(f.uuidCount, 1); assert.equal(f.button('已发放').props.disabled, true);
});

test('a read-only life snapshot blocks all writes and stale handlers while refresh stays available', async (t) => {
  const f = fixture(t); await f.flush();
  await f.input('普通经历保留细节的天数', '8'); await f.input('每日基础分钟', '20');
  await f.input('免打扰开始时间', '22'); await f.input('额外发放分钟', '5');
  const labels = ['保存记忆与成长设置', '保存时间额度', '保存自主活动范围', '发放零花时间'];
  const stale = labels.map(f.button); f.readOnly(true); await f.reload();
  assert.match(f.alerts(), /当前只读/);
  assert.equal(f.button('刷新生活记录'), undefined, 'the standalone refresh button is gone; the global refresh drives reloads');
  assert.equal(f.value('普通经历保留细节的天数'), '8'); assert.equal(f.value('每日基础分钟'), '20');
  for (const label of labels) { assert.equal(f.button(label).props.disabled, true, label); await f.invoke(f.button(label)); }
  for (const node of stale) await f.invoke(node);
  assert.equal(f.posts.length, 0); assert.equal(f.uuidCount, 0);
  assert.equal(f.rootDirty, true); assert.equal(f.engine.snapshot().activities.length, 0);
});

test('refreshing records also preserves the currently edited experience and its independent settings drafts', async (t) => {
  const f = fixture(t); await f.flush();
  await f.input('自动整理日常聊天', true); await f.click('保存记忆与成长设置');
  f.memory.capture({ phase: 'received', messageId: '2', selfId: '10001', scope: f.scope, userText: 'LIFE_EDIT_REFRESH_CANARY' }, { authorize: () => true });
  await f.reload(); await f.click('查看与管理这条经历');
  await f.input('纠正经历内容', '刷新后仍应保留的修改'); await f.input('每日基础分钟', '15');
  const before = f.posts.length; await f.reload();
  assert.equal(f.value('纠正经历内容'), '刷新后仍应保留的修改'); assert.equal(f.value('每日基础分钟'), '15');
  assert.equal(f.rootDirty, true); assert.equal(f.posts.length, before);
  await f.click('保存经历纠正');
  assert.equal(f.memory.snapshot().items[0].detail, '刷新后仍应保留的修改');
  assert.equal(f.value('每日基础分钟'), '15'); assert.equal(f.engine.wallet.snapshot().policy.dailySeconds, 0);
  await f.click('撤销未保存修改'); assert.equal(f.value('每日基础分钟'), '0'); assert.equal(f.rootDirty, false);
});

function seedExperience(f) {
  const authorize = () => true;
  f.memory.configure({ learningEnabled: true }, { authorize });
  const capture = f.memory.capture({ phase: 'received', messageId: '3', selfId: '10001', scope: f.scope,
    userText: 'LIFE_SOURCE_VERSION_CANARY' }, { authorize });
  const id = capture.result.id;
  // Make every managed experience action, including restore, available before
  // the independent writer changes the source.
  f.memory.manage('pin', { id, value: true }, { scope: f.scope, authorize });
  f.memory.manage('pin', { id, value: false }, { scope: f.scope, authorize });
  return id;
}

test('a refreshed external experience change preserves the edit and blocks every stale record write', async (t) => {
  const changes = [
    ['correction', (f, id) => f.memory.manage('correct', { id, detail: '另一处明确纠正后的事实' }, { scope: f.scope, authorize: () => true })],
    ['deletion', (f, id) => f.memory.manage('delete', { id }, { scope: f.scope, authorize: () => true })],
    ...[
      ['summary', (row) => { row.summary = '另一处更新的概要'; }],
      ['scope', (row) => { row.scope = { accountId: '20003', identityId: 'other' }; }],
      ['history', (row) => { row.history = row.history.slice(1); }],
      ['pinned', (row) => { row.pinned = true; }],
      ['pending', (row) => { row.pending = true; }],
      ['status', (row) => { row.status = 'inactive'; }],
      ['source', (row) => { row.source = { ...row.source, sessionId: 'updated-source-session' }; }],
    ].map(([label, change]) => [label, (f, id) => f.memory.store.update((state) => change(state.memories.find((row) => row.id === id)), { authorize: () => true })]),
  ];
  for (const [label, change] of changes) await t.test(label, async (st) => {
    const f = fixture(st), id = seedExperience(f); await f.flush();
    await f.click('查看与管理这条经历'); await f.input('纠正经历内容', '尚未保存的本地修改');
    await f.input('确认删除此条受管记忆', true);
    const labels = ['保存经历纠正', '固定保留', '标为未完成约定', '停止召回这条经历', '撤销最近经历修改', '删除这条生活记忆'];
    const stale = labels.map(f.button);
    for (let i = 0; i < labels.length; i++) assert.equal(stale[i].props.disabled, false, labels[i] + ' starts usable');
    change(f, id); const saved = fs.readFileSync(f.memory.store.file, 'utf8');
    await f.reload();
    assert.equal(f.value('纠正经历内容'), '尚未保存的本地修改'); assert.equal(f.rootDirty, true);
    assert.match(f.alerts(), /当前记录已变化或暂时无法核对/);
    assert.equal(f.inputNode('确认删除此条受管记忆').props.disabled, true);
    for (const buttonLabel of labels) {
      const node = f.button(buttonLabel); assert.equal(node.props.disabled, true, label + ': ' + buttonLabel);
      await f.invoke(node);
    }
    for (const node of stale) await f.invoke(node);
    assert.equal(f.posts.length, 0, 'a stale handler may not adopt the fresh CAS revision to overwrite a changed experience');
    assert.equal(fs.readFileSync(f.memory.store.file, 'utf8'), saved);
    assert.equal(f.value('纠正经历内容'), '尚未保存的本地修改');
  });
});

test('unrelated Token and policy updates refresh the CAS revision without conflicting with an experience edit', async (t) => {
  const f = fixture(t), id = seedExperience(f); await f.flush(); await f.click('查看与管理这条经历');
  await f.input('纠正经历内容', '在其他账本更新后保存的本地纠正');
  const budget = new TokenBudget({ store: f.memory.store }), authorize = () => true;
  budget.configure({ dailyTokens: 50001 }, { authorize, revision: budget.snapshot().revision });
  f.memory.configure({ summaryDays: 31 }, { authorize });
  f.engine.wallet.configure({ dailySeconds: 1200 }, { authorize });
  f.engine.configure({ quietStart: 20 }, { authorize });
  const refreshedRevision = f.memory.store.read().revision;
  await f.reload();
  assert.equal(f.value('纠正经历内容'), '在其他账本更新后保存的本地纠正');
  assert.equal(f.value('普通概要参与主动回忆的天数'), '31'); assert.equal(f.value('每日基础分钟'), '20');
  assert.equal(f.value('免打扰开始时间'), '20'); assert.doesNotMatch(f.alerts(), /当前记录已变化或暂时无法核对/);
  assert.equal(f.button('保存经历纠正').props.disabled, false);
  await f.click('保存经历纠正');
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].payload.input.revision, refreshedRevision);
  assert.equal(f.memory.snapshot().items.find((row) => row.id === id).detail, '在其他账本更新后保存的本地纠正');
  assert.equal(budget.snapshot().policy.dailyTokens, 50001); assert.equal(f.engine.wallet.snapshot().policy.dailySeconds, 1200);
});

test('busy runtime blocks policy and bonus writes while allowing a separately authorized autonomy stop', async (t) => {
  const f = fixture(t); await f.flush();
  await f.input('普通经历保留细节的天数', '8'); await f.input('每日基础分钟', '20');
  await f.input('免打扰开始时间', '22'); await f.input('额外发放分钟', '5');
  // A controllable in-flight fixture exercises the real AutonomyEngine.cancel;
  // no scheduler, provider or outgoing-message path runs.
  const controller = new AbortController(); let stops = 0;
  f.engine.active = { controller, promise: Promise.resolve() };
  controller.signal.addEventListener('abort', () => { stops++; f.engine.active = null; }, { once: true });
  await f.reload();
  const staleStop = f.button('停止当前自主活动');
  await f.simulateGate(true); await f.simulateCancelGate(true);
  assert.equal(f.button('停止当前自主活动').props.disabled, true);
  await f.invoke(f.button('停止当前自主活动')); await f.invoke(staleStop);
  assert.equal(stops, 0); assert.equal(f.posts.length, 0);
  await f.simulateCancelGate(false);
  for (const label of ['保存记忆与成长设置', '保存时间额度', '保存自主活动范围', '发放零花时间']) {
    assert.equal(f.button(label).props.disabled, true, label); await f.invoke(f.button(label));
  }
  assert.equal(f.posts.length, 0); assert.equal(f.uuidCount, 0);
  assert.equal(f.button('停止当前自主活动').props.disabled, false);
  await f.click('停止当前自主活动');
  assert.equal(stops, 1); assert.equal(f.posts.length, 1); assert.equal(f.posts[0].payload.action, 'cancel');
  assert.equal(f.engine.snapshot().running, false);
  assert.equal(f.button('停止当前自主活动'), undefined, 'the stop control disappears once no activity is running');
  assert.equal(f.value('普通经历保留细节的天数'), '8'); assert.equal(f.value('每日基础分钟'), '20');
  assert.equal(f.value('免打扰开始时间'), '22'); assert.equal(f.value('额外发放分钟'), '5');
  assert.equal(f.rootDirty, true); assert.equal(f.engine.wallet.snapshot().balance, 0);
});

test('matching durable bonus proof confirms an old grant beyond the returned transaction window', async (t) => {
  const f = fixture(t); await f.flush(); await f.input('额外发放分钟', '5'); f.failAfterCommit();
  await f.click('发放零花时间');
  const requestId = f.posts[0].payload.input.requestId;
  assert.equal(f.engine.wallet.snapshot().balance, 300);
  // Real wallet writes by another local owner push the old grant outside the
  // owner API's last-100 view, while its durable deduplication record remains.
  for (let i = 0; i < 101; i++) f.engine.wallet.add({ requestId: 'fixture-other-grant-' + i, seconds: 60 }, { authorize: () => true });
  const before = f.engine.wallet.snapshot(); assert.equal(before.transactions.length, 102);
  await f.reload();
  assert.equal(f.posts.length, 1); assert.equal(f.button('继续本次发放').props.disabled, false);
  await f.click('继续本次发放');
  const response = f.replies.at(-1);
  assert.equal(response.autonomy.wallet.transactions.length, 100);
  assert.equal(response.autonomy.wallet.transactions.some((row) => row.id === 'bonus:' + requestId), false);
  assert.deepEqual(response.result.result, { duplicate: true, added: 300, requestId });
  assert.equal(f.posts.length, 2); assert.equal(f.posts[1].payload.input.requestId, requestId); assert.equal(f.uuidCount, 1);
  assert.equal(f.engine.wallet.snapshot().balance, before.balance);
  assert.equal(f.engine.wallet.snapshot().transactions.length, before.transactions.length);
  assert.equal(f.value('额外发放分钟'), '5'); assert.equal(f.button('已发放').props.disabled, true);
  assert.match(f.text, /已发放[^。\n]*5[^。\n]*分钟/);
  await f.invoke(f.button('已发放')); assert.equal(f.posts.length, 2);
});

function seedRecentRecords(f, texts) {
  const authorize = () => true;
  f.memory.configure({ learningEnabled: true }, { authorize });
  return texts.map((userText, index) => f.memory.capture({ phase: 'received', messageId: String(10 + index),
    selfId: '10001', scope: f.scope, userText }, { authorize }).result.id);
}
function lastLifeRead(f) {
  const call = f.calls.filter((row) => row.method === 'GET').at(-1);
  return Object.fromEntries(new URLSearchParams(call.route.split('?')[1]));
}

test('an empty recent-chat section explains its state without exposing search or pagination', async (t) => {
  const f = fixture(t); await f.flush();
  const section = f.section('最近聊过的事'); assert.ok(section);
  assert.match(f.textOf(section), /还没有记录/); assert.match(f.textOf(section), /自动整理日常聊天/);
  assert.equal(f.details('查找记录'), undefined); assert.equal(f.button('查找'), undefined);
  assert.equal(f.nodes().some((node) => node.type === 'label' && f.textOf(node).startsWith('搜索经历')), false);
  assert.equal(f.button('上一页生活记忆'), undefined); assert.equal(f.button('下一页生活记忆'), undefined);
  assert.equal(f.posts.length, 0); assert.equal(f.memory.policy().learningEnabled, false);
  assert.equal(f.engine.snapshot().policy.enabled, false);
});

test('recent chats fold lookup away, keep a zero-result exit, and restore the actual filter after correction and deletion', async (t) => {
  const f = fixture(t); seedRecentRecords(f, ['ALPHA_FIRST', 'ALPHA_SECOND', 'OTHER_ENTRY']); await f.flush();
  const lookup = f.details('查找记录'); assert.ok(lookup); assert.equal(Boolean(lookup.props.open), false);
  assert.deepEqual(f.recordTitles(), ['OTHER_ENTRY', 'ALPHA_SECOND', 'ALPHA_FIRST']);
  assert.equal(f.button('上一页生活记忆'), undefined); assert.equal(f.button('下一页生活记忆'), undefined);
  await f.input('搜索经历', 'NO_MATCH_FOR_THIS_QUERY'); await f.click('查找');
  assert.deepEqual(lastLifeRead(f), { query: 'NO_MATCH_FOR_THIS_QUERY', offset: '0', limit: '50' });
  assert.deepEqual(f.recordTitles(), []); assert.ok(f.details('查找记录'));
  assert.match(f.textOf(f.section('最近聊过的事')), /没有找到相关记录/);
  assert.equal(f.button('查看全部记录').props.disabled, false);
  await f.click('查看全部记录');
  assert.equal(f.value('搜索经历'), ''); assert.deepEqual(f.recordTitles(), ['OTHER_ENTRY', 'ALPHA_SECOND', 'ALPHA_FIRST']);
  assert.deepEqual(lastLifeRead(f), { query: '', offset: '0', limit: '50' });
  await f.input('搜索经历', 'ALPHA'); await f.click('查找');
  assert.deepEqual(f.recordTitles(), ['ALPHA_SECOND', 'ALPHA_FIRST']);
  await f.click('查看与管理这条经历'); await f.input('纠正经历内容', '更新后的内容');
  const beforeCorrect = f.calls.length; await f.click('保存经历纠正');
  assert.deepEqual(f.calls.slice(beforeCorrect).map((row) => row.method), ['POST', 'GET']);
  assert.deepEqual(f.recordTitles(), ['ALPHA_FIRST'], 'the unfiltered POST snapshot cannot masquerade as the ALPHA view');
  assert.equal(f.value('搜索经历'), 'ALPHA'); assert.deepEqual(lastLifeRead(f), { query: 'ALPHA', offset: '0', limit: '50' });
  await f.click('查看与管理这条经历'); await f.input('确认删除此条受管记忆', true);
  const beforeDelete = f.calls.length; await f.click('删除这条生活记忆');
  assert.deepEqual(f.calls.slice(beforeDelete).map((row) => row.method), ['POST', 'GET']);
  assert.deepEqual(f.recordTitles(), []); assert.ok(f.details('查找记录')); assert.ok(f.button('查看全部记录'));
  assert.equal(f.posts.length, 2);
  await f.click('查看全部记录');
  assert.deepEqual(f.recordTitles(), ['OTHER_ENTRY', '更新后的内容']);
  assert.equal(f.posts.length, 2, 'clearing the filter cannot replay correction or deletion');
});

test('sixty real recent records preserve the applied query and second-page edit across refresh and saves', async (t) => {
  const f = fixture(t);
  const titles = Array.from({ length: 60 }, (_, index) => 'PAGE_MATCH 条目 ' + String(index).padStart(2, '0'));
  const ids = seedRecentRecords(f, titles); await f.flush();
  assert.equal(f.recordTitles().length, 50); assert.equal(f.recordTitles()[0], titles[59]);
  assert.equal(f.button('上一页生活记忆').props.disabled, true); assert.equal(f.button('下一页生活记忆').props.disabled, false);
  await f.click('下一页生活记忆'); assert.equal(f.recordTitles().length, 10); assert.equal(f.recordTitles()[0], titles[9]);
  await f.input('搜索经历', 'UNSUBMITTED_QUERY'); await f.reload();
  assert.deepEqual(lastLifeRead(f), { query: '', offset: '50', limit: '50' });
  assert.equal(f.value('搜索经历'), 'UNSUBMITTED_QUERY'); assert.equal(f.recordTitles()[0], titles[9]);
  await f.click('查看与管理这条经历'); await f.input('纠正经历内容', 'PAGE_MATCH 第二页的未保存纠正');
  await f.reload();
  assert.deepEqual(lastLifeRead(f), { query: '', offset: '50', limit: '50' });
  assert.equal(f.value('纠正经历内容'), 'PAGE_MATCH 第二页的未保存纠正');
  assert.doesNotMatch(f.alerts(), /当前记录已变化或暂时无法核对/);
  assert.equal(f.button('保存经历纠正').props.disabled, false);
  const beforeCorrect = f.calls.length; await f.click('保存经历纠正');
  assert.deepEqual(f.calls.slice(beforeCorrect).map((row) => row.method), ['POST', 'GET']);
  assert.deepEqual(lastLifeRead(f), { query: '', offset: '50', limit: '50' });
  assert.equal(f.recordTitles().length, 10); assert.equal(f.recordTitles()[0], 'PAGE_MATCH 第二页的未保存纠正');
  assert.equal(f.memory.snapshot({ limit: 100 }).items.find((row) => row.id === ids[9]).detail, 'PAGE_MATCH 第二页的未保存纠正');
  await f.input('搜索经历', 'PAGE_MATCH'); await f.click('查找');
  assert.deepEqual(lastLifeRead(f), { query: 'PAGE_MATCH', offset: '0', limit: '50' }, 'explicit lookup starts at the first page');
  assert.equal(f.recordTitles().length, 50);
  await f.input('搜索经历', 'ANOTHER_UNSUBMITTED_QUERY'); await f.reload();
  assert.deepEqual(lastLifeRead(f), { query: 'PAGE_MATCH', offset: '0', limit: '50' });
  await f.click('下一页生活记忆');
  assert.deepEqual(lastLifeRead(f), { query: 'PAGE_MATCH', offset: '50', limit: '50' });
  assert.equal(f.value('搜索经历'), 'ANOTHER_UNSUBMITTED_QUERY'); assert.equal(f.recordTitles().length, 10);
  await f.click('查看与管理这条经历');
  const beforePin = f.calls.length; await f.click('固定保留');
  assert.deepEqual(f.calls.slice(beforePin).map((row) => row.method), ['POST', 'GET']);
  assert.deepEqual(lastLifeRead(f), { query: 'PAGE_MATCH', offset: '50', limit: '50' });
  assert.equal(f.recordTitles().length, 10); assert.equal(f.button('取消固定保留').props.disabled, false);
  await f.input('每日基础分钟', '18'); const beforePolicy = f.calls.length; await f.click('保存时间额度');
  assert.deepEqual(f.calls.slice(beforePolicy).map((row) => row.method), ['POST', 'GET']);
  assert.deepEqual(lastLifeRead(f), { query: 'PAGE_MATCH', offset: '50', limit: '50' });
  assert.equal(f.engine.wallet.snapshot().policy.dailySeconds, 1080); assert.equal(f.posts.length, 3);
  assert.equal(f.value('搜索经历'), 'ANOTHER_UNSUBMITTED_QUERY'); assert.equal(f.recordTitles().length, 10);
  // If another owner removes the second page, refreshing must return to the
  // remaining valid page and hide pagination at exactly fifty records.
  for (const id of ids.slice(0, 10)) f.memory.manage('delete', { id }, { scope: f.scope, authorize: () => true });
  const beforeClamp = f.calls.length; await f.reload();
  assert.deepEqual(f.calls.slice(beforeClamp).map((row) => row.method), ['GET', 'GET']);
  assert.deepEqual(lastLifeRead(f), { query: 'PAGE_MATCH', offset: '0', limit: '50' });
  assert.equal(f.recordTitles().length, 50); assert.equal(f.posts.length, 3);
  assert.equal(f.button('上一页生活记忆'), undefined); assert.equal(f.button('下一页生活记忆'), undefined);
});

test('failed view readback after a confirmed bonus falls back clearly without replaying the POST', async (t) => {
  const f = fixture(t); seedRecentRecords(f, ['ALPHA_FIRST', 'ALPHA_SECOND', 'OTHER_ENTRY']); await f.flush();
  await f.input('搜索经历', 'ALPHA'); await f.click('查找');
  await f.input('额外发放分钟', '5'); f.failReadbackOnce(); const before = f.calls.length;
  await f.click('发放零花时间');
  assert.deepEqual(f.calls.slice(before).map((row) => row.method), ['POST', 'GET']);
  assert.equal(f.posts.length, 1); assert.equal(f.uuidCount, 1); assert.equal(f.engine.wallet.snapshot().balance, 300);
  assert.equal(f.value('额外发放分钟'), '5'); assert.equal(f.button('已发放').props.disabled, true);
  assert.match(f.text, /原操作已保存.*原查找范围暂未读回.*最近记录/);
  assert.doesNotMatch(f.alerts(), /FIXTURE_READBACK_FAILURE|草稿仍保留|操作未确认/);
  assert.equal(f.value('搜索经历'), ''); assert.equal(f.button('查看全部记录'), undefined);
  assert.deepEqual(f.recordTitles(), ['OTHER_ENTRY', 'ALPHA_SECOND', 'ALPHA_FIRST']);
  await f.invoke(f.button('已发放')); await f.reload();
  assert.deepEqual(lastLifeRead(f), { query: '', offset: '0', limit: '50' });
  assert.equal(f.posts.length, 1); assert.equal(f.engine.wallet.snapshot().balance, 300);
});


test('autonomy settings group enabled contacts by current identity and keep owner authority separate', async (t) => {
  const accounts = [
    { qq: '20002', name: '甲', enabled: true, activeIdentityId: 'default', identities: [{ id: 'default', name: '老大和小弟' }] },
    { qq: '30003', name: '乙', enabled: true, activeIdentityId: 'friend', identities: [{ id: 'friend', name: '朋友' }] },
    { qq: '40004', name: '未启用账号', enabled: false, activeIdentityId: 'default', identities: [{ id: 'default', name: '隐藏身份' }] },
  ];
  const f = fixture(t, { accounts, ownerQq: '20002', onManageAccounts() {} }); await f.flush();
  const groups = f.nodes().filter((node) => node.type === 'div' && node.props.className === 'dfy-sub')
    .map((node) => node.props['aria-label']).filter(Boolean);
  assert.deepEqual(groups.filter((label) => ['联系谁', '允许做什么', '免打扰', '频率与额度', '当前等待原因'].includes(label)),
    ['联系谁', '允许做什么', '免打扰', '频率与额度', '当前等待原因']);
  assert.match(f.text, /甲 · 20002 · 老大和小弟主要使用者（配置）/);
  assert.match(f.text, /乙 · 30003 · 朋友/); assert.doesNotMatch(f.text, /未启用账号|隐藏身份/);
  assert.match(f.text, /这里只选择她会主动联系谁/);
  assert.equal(f.posts.length, 0); assert.equal(f.checked('没有话题时，允许首次主动问候'), false);
  const target = f.inputNode('甲 · 20002'); await f.input('甲 · 20002', true);
  assert.equal(f.rootDirty, true); assert.equal(f.posts.length, 0, 'selecting a contact is only a local draft');
  await f.input('甲 · 20002', true); await f.click('保存自主活动范围');
  assert.deepEqual(f.posts[0].payload.input.patch.targets, [f.scope], 'repeated checkbox events do not duplicate targets');
  assert.ok(!Object.hasOwn(f.posts[0].payload.input.patch, 'ownerQq'), 'a target save cannot migrate the owner');
  assert.equal(f.engine.snapshot().activities.length, 0);
  await f.setProps({ accounts: accounts.map((account) => ({ ...account, enabled: false })) });
  await target.props.onChange({ target: { checked: false } }); await f.flush();
  assert.equal(f.rootDirty, false, 'a handler retained for an account no longer enabled cannot change the target draft');
});

test('quiet hours have an explicit switch, retain disabled choices, and reject equal enabled hours before POST', async (t) => {
  const f = fixture(t); await f.flush();
  const start = f.inputNode('免打扰开始时间'); assert.equal(start.type, 'select');
  assert.equal(start.props.children.length, 24);
  assert.deepEqual(start.props.children.slice(0, 2).map(f.textOf), ['00:00', '01:00']);
  assert.equal(f.checked('启用免打扰时段'), true);
  await f.input('免打扰开始时间', '22'); await f.input('免打扰结束时间', '8');
  const stale = f.inputNode('免打扰开始时间');
  await f.input('启用免打扰时段', false);
  assert.equal(f.inputNode('免打扰开始时间').props.disabled, true);
  assert.equal(f.inputNode('免打扰结束时间').props.disabled, true);
  await stale.props.onChange({ target: { value: '4' } }); await f.flush();
  assert.equal(f.value('免打扰开始时间'), '22', 'a retained disabled hour handler cannot replace the stored draft choice');
  await f.click('保存自主活动范围');
  assert.equal(f.engine.snapshot().policy.quietEnabled, false); assert.equal(f.value('免打扰开始时间'), '22');
  assert.equal(f.value('免打扰结束时间'), '8');
  await f.input('启用免打扰时段', true); await f.input('免打扰结束时间', '22');
  const before = f.posts.length; await f.click('保存自主活动范围');
  assert.equal(f.posts.length, before); assert.match(f.alerts(), /开始与结束时间不能相同/);
  await f.input('启用免打扰时段', false); await f.click('保存自主活动范围');
  assert.equal(f.engine.snapshot().policy.quietStart, 22); assert.equal(f.engine.snapshot().policy.quietEnd, 22);
  assert.equal(f.engine.snapshot().policy.quietEnabled, false);
  await f.reload(); assert.equal(f.checked('启用免打扰时段'), false);
  assert.equal(f.engine.snapshot().activities.length, 0);
});

test('browser and greeting controls retain drafts while their parent permission is disabled', async (t) => {
  const f = fixture(t, { ownerQq: '20002' }); await f.flush();
  assert.equal(f.checked('没有话题时，允许首次主动问候'), false); assert.equal(f.inputNode('没有话题时，允许首次主动问候').props.disabled, true);
  assert.match(f.text, /默认关闭；开启后只在免打扰、间隔和次数限制内生效/);
  assert.equal(f.inputNode('抖音').props.disabled, true); assert.equal(f.inputNode('单次娱乐最多分钟').props.disabled, true);
  await f.input('允许自主浏览视频平台', true); await f.input('抖音', true); await f.input('单次娱乐最多分钟', '5');
  const platform = f.inputNode('抖音'), session = f.inputNode('单次娱乐最多分钟');
  await f.input('允许自主浏览视频平台', false);
  await platform.props.onChange({ target: { checked: false } }); await session.props.onChange({ target: { value: '7' } }); await f.flush();
  assert.equal(f.checked('抖音'), true); assert.equal(f.value('单次娱乐最多分钟'), '5');
  await f.input('允许主动找选定账号聊天', true); await f.input('没有话题时，允许首次主动问候', true);
  const greeting = f.inputNode('没有话题时，允许首次主动问候'); await f.input('允许主动找选定账号聊天', false);
  await greeting.props.onChange({ target: { checked: false } }); await f.flush();
  assert.equal(f.checked('没有话题时，允许首次主动问候'), true); assert.equal(f.inputNode('没有话题时，允许首次主动问候').props.disabled, true);
  assert.equal(f.posts.length, 0, 'none of the switches saves or schedules on its own');
  await f.click('保存自主活动范围');
  const policy = f.engine.snapshot().policy;
  assert.equal(policy.browse, false); assert.deepEqual(policy.platforms, ['douyin']); assert.equal(policy.sessionSeconds, 300);
  assert.equal(policy.proactive, false); assert.equal(policy.greetingEnabled, true); assert.equal(policy.enabled, false);
  assert.equal(f.engine.snapshot().activities.length, 0);
  await f.input('允许自主浏览视频平台', true); assert.equal(f.checked('抖音'), true); assert.equal(f.value('单次娱乐最多分钟'), '5');
  await f.reload(); assert.equal(f.checked('允许自主浏览视频平台'), true, 'a refresh preserves this unsaved browser draft');
  assert.equal(f.engine.snapshot().policy.browse, false); assert.equal(f.engine.snapshot().activities.length, 0);
});

test('autonomy waiting display uses only the saved preview and shows confirmed future times without running work', async (t) => {
  const f = fixture(t); const nextCheckAt = Date.parse('2026-10-26T10:10:00+08:00'), scheduledAt = nextCheckAt + 600000;
  f.setPreview({ reason: '已保存设置等待连接确认', readiness: 'waiting', reasonCode: 'CONTACT_NOT_READY', nextCheckAt, scheduledAt }); await f.flush();
  assert.match(f.text, /以下状态按已保存设置判断：已保存设置等待连接确认/);
  assert.match(f.text, /下次检查：/); assert.match(f.text, /已计划活动时间：/); assert.doesNotMatch(f.text, /Invalid Date/);
  assert.ok(f.text.includes(new Date(nextCheckAt).toLocaleString())); assert.ok(f.text.includes(new Date(scheduledAt).toLocaleString()));
  const before = f.calls.length; await f.input('启用自主活动', true); await f.input('允许主动找选定账号聊天', true);
  assert.match(f.text, /等待原因尚未采用这些修改/); assert.match(f.text, /已保存设置等待连接确认/);
  assert.equal(f.calls.length, before, 'a draft does not request or fabricate a new preview');
  assert.equal(f.engine.snapshot().policy.enabled, false); assert.equal(f.posts.length, 0);
  await f.click('撤销未保存修改'); assert.doesNotMatch(f.text, /等待原因尚未采用这些修改/);
  assert.equal(f.engine.snapshot().activities.length, 0);
});

test('manage-contacts navigation checks current life drafts, maintenance, and disposed callbacks without writes', async (t) => {
  let navigations = 0;
  const f = fixture(t, { ownerQq: '20002', onManageAccounts: () => { navigations++; } }); await f.flush();
  const old = f.button('管理聊天对象'); await f.click('管理聊天对象'); assert.equal(navigations, 1);
  await f.input('每日基础分钟', '15'); assert.equal(f.button('管理聊天对象').props.disabled, true);
  assert.match(f.text, /请先保存或撤销生活页未保存的修改/);
  await f.invoke(old); assert.equal(navigations, 1, 'retained navigation callback checks the latest draft');
  await f.reload(); assert.equal(f.value('每日基础分钟'), '15'); await f.invoke(old); assert.equal(navigations, 1);
  await f.click('撤销未保存修改'); await f.simulateGate(true); await f.invoke(old); assert.equal(navigations, 1);
  await f.simulateGate(false); await f.setAlive(false); await f.invoke(old); assert.equal(navigations, 1);
  assert.equal(f.posts.length, 0); assert.equal(f.engine.snapshot().activities.length, 0);
});

test('shipped life-panel parent connects manage-contacts to the existing accounts tab only', async (t) => {
  const source = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
  const start = source.indexOf(": key === 'life' ? h(LifePanel, {"); assert.ok(start >= 0);
  const end = source.indexOf(": key === 'memory'", start), expression = source.slice(start, end).split('? ').slice(1).join('? ').trim();
  const selectedTabs = [], account = { qq: '20002', name: '测试账号', enabled: true, activeIdentityId: 'default' };
  const context = { h: (_type, props) => props, LifePanel() {}, tab: 'life', refreshKey: 0, resourceRefreshKey: 0, runningAccounts: [account], editedAccounts: [],
    value: (key) => key === 'ownerQq' ? '20002' : undefined, selectTab: (key) => selectedTabs.push(key), setLifeDirty() {}, runtime: {} };
  for (const key of ['blocked', 'pendingReload', 'dirty', 'personaDirty', 'modelDirty', 'voiceDirty', 'speechDirty', 'galleryDirty', 'memoryDirty']) context[key] = false;
  const props = vm.runInNewContext('(' + expression + ')', context);
  assert.equal(props.ownerQq, '20002'); assert.equal(props.active, true);
  const f = fixture(t, props); await f.flush(); await f.click('管理聊天对象');
  assert.deepEqual(selectedTabs, ['accounts']); assert.equal(f.posts.length, 0);
  assert.equal(f.calls.filter((row) => row.route === 'config' || row.route === 'apply').length, 0);
});


async function enableOneBrowse(f) {
  f.engine.configure({ enabled: true, browse: true, proactive: false, platforms: ['douyin'], targets: [f.scope], quietEnabled: false, sessionSeconds: 180 }, { authorize: () => true });
  f.engine.wallet.configure({ enabled: true, dailySeconds: 600, monthlySeconds: 0 }, { authorize: () => true });
  await f.reload();
}
test('one new autonomy activity is explicit, uses saved policy and cannot start through a stale dirty form handler', async t => {
  const f = fixture(t); await f.flush(); let executions = 0;
  f.engine.run = async () => { executions++; return { status: 'succeeded', text: '离线页面文字观察' }; };
  assert.equal(f.button('检查并开始一次活动').props.disabled, true); assert.equal(f.posts.length, 0);
  await enableOneBrowse(f); const stale = f.button('检查并开始一次活动'); assert.equal(stale.props.disabled, false);
  assert.equal(executions, 0, 'ordinary GET refresh never starts a model or activity');
  await f.input('每日自主活动总次数上限', '2');
  assert.equal(f.button('检查并开始一次活动').props.disabled, true); await f.invoke(stale); assert.equal(f.posts.length, 0);
  await f.click('撤销未保存修改'); await f.click('检查并开始一次活动');
  assert.equal(executions, 1); assert.equal(f.posts.length, 1); assert.equal(f.posts[0].payload.action, 'autonomy-check-now');
  assert.deepEqual(Object.keys(f.posts[0].payload.input), ['revision']); assert.equal(f.posts[0].timeoutMs, 390000);
  assert.equal(f.engine.snapshot().activities[0].status, 'completed'); assert.equal(f.engine.snapshot().policy.greetingEnabled, false);
  assert.match(f.text, /手动发起一次自主活动，按已保存的额度记账/); assert.match(f.text, /按已保存的额度记账/);
});
test('a pending one-off activity keeps cancellation available despite its long request and external write gates', async t => {
  const f = fixture(t); await f.flush(); await enableOneBrowse(f);
  let entered, cancelled = 0; const started = new Promise(resolve => { entered = resolve; });
  f.engine.run = async (_activity, options) => new Promise(resolve => {
    options.signal.addEventListener('abort', () => { cancelled++; resolve({ status: 'cancelled', text: '' }); }, { once: true }); entered();
  });
  const once = f.button('检查并开始一次活动'), pending = once.props.onClick(); await started; await f.flush();
  await f.invoke(once); assert.equal(f.posts.filter(row => row.payload.action === 'autonomy-check-now').length, 1, 'double click never POSTs twice');
  const stop = f.button('停止当前自主活动'); assert.equal(stop.props.disabled, false);
  await f.simulateGate(true); await f.simulateCancelGate(true); await f.invoke(stop);
  assert.equal(cancelled, 0); assert.equal(f.posts.length, 1);
  await f.simulateCancelGate(false); assert.equal(f.button('停止当前自主活动').props.disabled, false);
  await f.click('停止当前自主活动'); await pending; await f.flush();
  assert.equal(cancelled, 1); assert.equal(f.posts.length, 2); assert.equal(f.posts[1].payload.action, 'cancel');
  assert.equal(f.engine.snapshot().running, false); assert.equal(f.engine.snapshot().activities[0].status, 'cancelled');
  assert.equal(f.button('停止当前自主活动'), undefined, 'the stop control disappears once no activity is running');
});
test('one-off activity response failure only refreshes records and an unknown activity cannot be resubmitted', async t => {
  const f = fixture(t); await f.flush(); await enableOneBrowse(f); let executions = 0;
  f.engine.run = async () => { executions++; return { status: 'succeeded', text: '离线页面文字观察' }; };
  f.failAfterCommit(); const before = f.calls.length; await f.click('检查并开始一次活动');
  assert.equal(executions, 1); assert.equal(f.posts.length, 1); assert.deepEqual(f.calls.slice(before).map(row => row.method), ['POST', 'GET']);
  assert.match(f.alerts(), /不会自动重试或重发活动/); assert.equal(f.engine.snapshot().activities[0].status, 'completed');
  f.memory.store.update(state => { state.autonomy.activities[0].status = 'unknown'; }, { authorize: () => true });
  const stale = f.button('检查并开始一次活动'); await f.reload();
  assert.equal(f.button('检查并开始一次活动').props.disabled, true); await f.invoke(stale);
  assert.equal(f.posts.length, 1); assert.equal(executions, 1);
});
