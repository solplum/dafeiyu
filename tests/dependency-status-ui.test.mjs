import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shipped = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
const flatten = node => node == null || node === false || typeof node !== 'object' ? []
  : [node, ...(node.props?.children || []).flatMap(flatten)];
const content = node => node == null || node === false ? '' : typeof node === 'object'
  ? (node.props?.children || []).map(content).join('') : String(node);
const hasClass = (node, className) => node.props?.className?.split(' ').includes(className);
const badges = node => flatten(node).filter(item => hasClass(item, 'dfy-resource-status'));
const badgeLabels = node => badges(node).map(item => item.props['aria-label']);
const component = (id, health = 'ready', extra = {}) => ({ id, name: id, installed: true, health,
  updateState: 'not-checked', actions: [], ...extra });

// Render the actual shipped DependencyPanel. Only React hooks and its owner API
// boundary are isolated; tests do not install software or contact any service.
function fixture(t, { items, job = null, scope = 'all' }) {
  const snapshot = { checkedAt: '2026-10-27T01:00:00.000Z', busy: job?.state === 'running', items, job };
  let hooks = [], cursor = 0, effects = [], dirty = false, tree;
  const calls = [], timers = [];
  const api = { alive: { current: true }, cancel() {}, async call(route, method = 'GET', payload) {
    calls.push({ route, method, payload });
    assert.equal(route, 'dependencies', 'status rendering must not dispatch an operation');
    assert.equal(method, 'GET');
    return { dependencies: structuredClone(snapshot) };
  } };
  const React = { Fragment: Symbol('fragment'), createElement(type, props, ...children) {
    return { type, props: { ...props, children: children.flat(Infinity) } };
  }, useState(initial) {
    const i = cursor++; hooks[i] ||= { value: typeof initial === 'function' ? initial() : initial };
    return [hooks[i].value, next => { next = typeof next === 'function' ? next(hooks[i].value) : next;
      if (!Object.is(next, hooks[i].value)) { hooks[i].value = next; dirty = true; }
    }];
  }, useRef(initial) { return hooks[cursor++] ||= { current: initial }; }, useEffect(effect, deps) {
    const i = cursor++, old = hooks[i];
    if (!old || deps.some((value, at) => !Object.is(value, old.deps?.[at]))) {
      hooks[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = effect(); });
    }
  } };
  const start = shipped.indexOf('    function DependencyPanel('), end = shipped.indexOf('    const capabilityCatalog =', start);
  assert.ok(start > 0 && end > start);
  const Panel = vm.runInNewContext('(' + shipped.slice(start, end).trim() + ')', {
    React, ...React, h: React.createElement, usePanelApi: () => api,
    resourceError: error => error.message, displayTime: value => value || '尚未检查', URL,
    HelpTip: () => null, Advanced: () => null, SectionHeading: () => null,
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {},
  });
  t.after(() => { api.alive.current = false; hooks.forEach(hook => hook.cleanup?.()); });
  return { calls, timers, async render() {
    for (let round = 0; round < 15; round++) {
      cursor = 0; effects = []; dirty = false; tree = Panel({ active: true, scope });
      effects.splice(0).forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve));
      if (!dirty) return tree;
    }
    assert.fail('DependencyPanel did not settle');
  } };
}

test('component status distinguishes installation, verification and availability with readable text and a non-color symbol', async t => {
  const states = [
    ['ready', '已就绪', 'ready'], ['not-verified', '待核验', 'neutral'], ['missing', '未安装', 'warning'],
    ['blocked', '需处理', 'danger'], ['offline', '未连接', 'warning'], ['unsupported', '暂不支持', 'neutral'],
    ['unknown', '待检查', 'neutral'], ['future-state', '待检查', 'neutral'],
  ];
  const f = fixture(t, { items: states.map(([health], i) => component('resource-' + i, health)) });
  const tree = await f.render(), articles = flatten(tree).filter(node => node.type === 'article');
  assert.equal(articles.length, states.length);
  states.forEach(([, label, tone], i) => {
    const pills = badges(articles[i]); assert.equal(pills.length, 1);
    assert.equal(pills[0].props['aria-label'], '组件状态：' + label);
    assert.ok(hasClass(pills[0], 'dfy-resource-status--' + tone));
    const icon = flatten(pills[0]).find(node => hasClass(node, 'dfy-resource-status-icon'));
    assert.ok(content(icon).length > 0); assert.equal(icon.props['aria-hidden'], true);
    assert.ok(content(pills[0]).includes(label));
  });
  assert.equal(f.calls.length, 1); assert.equal(f.timers.length, 0);
});

test('an available update is a separate badge and never hides an unhealthy or unverified component', async t => {
  const f = fixture(t, { items: [component('adb', 'blocked', { updateState: 'available' }),
    component('ffmpeg', 'not-verified', { updateState: 'available' })] });
  const articles = flatten(await f.render()).filter(node => node.type === 'article');
  assert.deepEqual(badgeLabels(articles[0]), ['组件状态：需处理', '更新状态：可更新']);
  assert.deepEqual(badgeLabels(articles[1]), ['组件状态：待核验', '更新状态：可更新']);
  assert.ok(hasClass(badges(articles[0])[1], 'dfy-resource-status--info'));
});

test('a failed update belongs to its real componentId and preserves the last detected health', async t => {
  const f = fixture(t, { items: [component('adb'), component('ffmpeg', 'blocked', { updateState: 'available' })],
    job: { id: 'adb', componentId: 'ffmpeg', action: 'update', state: 'failed', message: '更新未完成' } });
  const tree = await f.render(), articles = flatten(tree).filter(node => node.type === 'article');
  assert.deepEqual(badgeLabels(articles[0]), ['组件状态：已就绪']);
  assert.deepEqual(badgeLabels(articles[1]), ['最近操作：更新失败', '组件状态：需处理', '更新状态：可更新']);
  const summary = flatten(tree).find(node => hasClass(node, 'dfy-dependency-job'));
  assert.ok(content(summary).includes('音频处理')); assert.ok(content(summary).includes('更新未完成'));
});

test('a failed update remains explicit even when the existing component is ready and a new version is available', async t => {
  const f = fixture(t, { items: [component('adb', 'ready', { updateState: 'available' })],
    job: { componentId: 'adb', action: 'update', state: 'failed' } });
  const tree = await f.render(), article = flatten(tree).find(node => node.type === 'article');
  assert.deepEqual(badgeLabels(article), ['最近操作：更新失败', '组件状态：已就绪', '更新状态：可更新']);
  assert.ok(hasClass(badges(article)[0], 'dfy-resource-status--danger'));
  const summary = flatten(tree).find(node => hasClass(node, 'dfy-dependency-job'));
  assert.ok(hasClass(summary, 'dfy-error')); assert.ok(content(summary).includes('本次操作未完成'));
});

test('SDK-managed ADB explains its disabled update in the ordinary view and its source in advanced details', async t => {
  const reason = '当前 ADB 由 Android SDK 管理，请使用 Android Studio 的 SDK 管理器更新 Platform-Tools；不会另装 Homebrew 副本';
  for (const updateState of ['unknown', 'available']) {
    const f = fixture(t, { items: [component('adb', 'ready', { managedBy: 'android-sdk', updateState, updateReason: reason,
      actions: [{ id: 'check', enabled: true, label: '检测' },
        { id: 'update', enabled: false, label: '通过 Android SDK 更新', reason }] })] });
    const tree = await f.render(), article = flatten(tree).find(node => node.type === 'article');
    const ordinary = { ...article, props: { ...article.props,
      children: article.props.children.filter(node => node?.props?.title !== '高级设置') } };
    assert.ok(content(ordinary).includes(reason), 'the reason must not depend on expanding advanced settings');
    assert.equal(content(ordinary).split(reason).length - 1, 1, 'do not duplicate a primary disabled-action reason');
    const advanced = article.props.children.find(node => node?.props?.title === '高级设置');
    assert.ok(content(advanced).includes('更新来源：Android SDK'));
    const update = flatten(article).find(node => node.type === 'button' && content(node) === '更新');
    assert.equal(update.props.disabled, true); assert.equal(update.props.title, reason);
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
});

test('QQ suite and advanced children share status semantics while an operation is bound only to its target', async t => {
  const f = fixture(t, { items: [component('napcat', 'ready', { updateState: 'available' }),
    component('linux-qq', 'not-verified')], job: { componentId: 'linux-qq', action: 'install', state: 'failed' } });
  const tree = await f.render(), suite = flatten(tree).find(node => node.props?.['aria-label'] === 'QQ 接入套件');
  const heading = suite.props.children[0];
  assert.deepEqual(badgeLabels(heading), ['最近操作：安装失败', '组件状态：已就绪', '更新状态：可更新']);
  const children = flatten(suite).filter(node => hasClass(node, 'dfy-suite-component'));
  assert.equal(children.length, 2);
  assert.deepEqual(badgeLabels(children[0]), ['组件状态：已就绪', '更新状态：可更新']);
  assert.deepEqual(badgeLabels(children[1]), ['最近操作：安装失败', '组件状态：待核验']);
});

test('running, stopping, stopped and unknown results are not mislabeled as failures or retried', async t => {
  const states = [['running', '正在更新'], ['cancelling', '正在停止'], ['cancelled', '已停止'],
    ['interrupted', '已停止'], ['unknown', '结果待核实'], ['future-state', '结果待核实']];
  for (const [state, label] of states) {
    const f = fixture(t, { items: [component('adb')], job: { componentId: 'adb', action: 'update', state } });
    const tree = await f.render(), summary = flatten(tree).find(node => hasClass(node, 'dfy-dependency-job'));
    assert.deepEqual(badgeLabels(summary), ['最近操作：' + label]);
    assert.equal(hasClass(summary, 'dfy-error'), false);
    assert.equal(f.calls.length, 1); assert.equal(f.calls.some(call => call.method !== 'GET'), false);
    assert.equal(f.timers.length, state === 'running' ? 1 : 0);
    if (state === 'unknown') assert.ok(content(summary).includes('请勿重复执行'));
  }
});

test('a completed operation does not promote an unverified component to ready and voice scope stays filtered', async t => {
  const f = fixture(t, { scope: 'voice', items: [component('ffmpeg', 'not-verified'), component('adb')],
    job: { componentId: 'ffmpeg', action: 'install', state: 'succeeded' } });
  const tree = await f.render(), articles = flatten(tree).filter(node => node.type === 'article');
  assert.equal(articles.length, 1); assert.deepEqual(badgeLabels(articles[0]), ['组件状态：待核验']);
  const summary = flatten(tree).find(node => hasClass(node, 'dfy-dependency-job'));
  assert.deepEqual(badgeLabels(summary), ['最近操作：安装完成']);
  assert.ok(content(summary).includes('以组件检测状态为准'));
});

test('dependency pills are scoped, wrap on narrow screens and keep readable light and dark contrast', () => {
  const start = shipped.indexOf('.dfy-panel .dfy-dependency-panel .dfy-resource-statuses{');
  const end = shipped.indexOf('\n`;', start), css = shipped.slice(start, end);
  assert.ok(start > 0 && end > start);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const pillRule = rules.find(([, selector]) => selector === '.dfy-panel .dfy-dependency-panel .dfy-resource-status');
  assert.ok(pillRule[2].includes('font-size:12px')); assert.ok(pillRule[2].includes('font-weight:650'));
  assert.ok(pillRule[2].includes('border:1px solid')); assert.ok(css.includes('@media(prefers-color-scheme:dark)'));
  assert.ok(css.includes('.dfy-dependency-panel .dfy-resource-statuses{justify-content:flex-start}'));
  assert.ok(rules.find(([, selector, body]) => selector.endsWith('.dfy-resource-statuses') && body.includes('flex-wrap:wrap')));
  const luminance = hex => {
    const channels = hex.match(/../g).map(value => parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const palettes = rules.map(([, , body]) => [body.match(/--dfy-status-ink:#([a-f0-9]{6})/i)?.[1],
    body.match(/--dfy-status-bg:#([a-f0-9]{6})/i)?.[1]]).filter(([ink, bg]) => ink && bg);
  palettes.push(['526173', 'f0f3f7']);
  assert.equal(palettes.length, 10, 'all light/dark neutral and semantic palettes are measured');
  for (const [ink, bg] of palettes) {
    const a = luminance(ink), b = luminance(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(ratio >= 4.5, ink + ' on ' + bg + ': ' + ratio.toFixed(2));
  }
});
