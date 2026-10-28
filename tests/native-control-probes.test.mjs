import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalToolCall, nativeControlMetadata, probeNativeDesktop } from '../packages/dsh-dafeiyu/src/native-control-probes.js';

const nonce = 'DFY-CAP-' + 'a'.repeat(24), pid = 1234;
const input = '大肥鱼电脑控制测试输入', button = '验证电脑输入';
const names = ['computer_observe', 'computer_click', 'computer_press_key', 'computer_type_text'];
const immediate = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function fixture({ active = false } = {}) {
  const calls = [], visible = new Set(active ? names : ['skill', 'computer_use_activate']);
  const agent = { id: 'actual-probe-agent', session: { id: 'actual-probe-agent', header: { cwd: '/owned-fixture' } } };
  const state = { authorized: true, registered: agent, value: 'previous test', focused: false, result: '', seq: 0, current: null,
    status: { provider: 'macos-ax', ready: true, accessibility: 'granted', screenRecording: 'granted', helperVersion: '0.3.4', helperPath: '/PRIVATE/HELPER', lastError: 'PRIVATE_DIAGNOSTIC' } };
  const observe = () => {
    state.seq++;
    const value = { observationId: 'observation-' + state.seq, app: { bundleId: 'com.deepseek.dsh', pid },
      window: { id: 900 }, tree: { mode: 'full', text: 'fixed fixture', truncated: false }, permissions: { accessibility: 'granted' },
      elements: [{ index: state.seq * 10, role: 'AXTextField', label: input, enabled: true, focused: state.focused, value: state.value },
        { index: state.seq * 10 + 1, role: 'AXButton', title: button, enabled: true },
        { index: state.seq * 10 + 2, role: 'AXStaticText', value: state.result }] };
    state.modify?.(value); state.current = value; return value;
  };
  const tools = {
    get(name, scope) { assert.ok(scope === undefined || scope === agent); return visible.has(name) ? { name, execute: () => assert.fail('raw definition bypass') } : undefined; },
    async execute(exec) {
      calls.push(exec); assert.equal(exec.agent, agent); assert.ok(exec.signal instanceof AbortSignal); assert.match(exec.callId, /^dfy-control-/);
      if (state.intercept) { const value = await state.intercept(exec); if (value !== undefined) return value; }
      const args = exec.arguments;
      if (exec.name === 'skill') { assert.deepEqual(args, { name: 'dsh-computer-use' }); for (const name of names) visible.add(name); return { isError: false, value: { name: 'dsh-computer-use', content: 'actual scoped Skill result' } }; }
      if (exec.name === 'computer_observe') { assert.deepEqual(args, { app: { bundleId: 'com.deepseek.dsh', ...(state.discoverPid && state.seq === 0 ? {} : { pid }) }, full: true, screenshot: 'none' }); return { isError: false, value: observe() }; }
      assert.equal(args.observationId, state.current.observationId, 'every action must bind its fresh observation');
      if (exec.name === 'computer_click') {
        if (args.elementIndex === state.current.elements[0].index) { assert.equal(args.allowCoordinateFallback, true); state.focused = true; }
        else { assert.equal(args.elementIndex, state.current.elements[1].index); assert.equal(args.allowCoordinateFallback, false); state.result = '电脑控制回读：' + state.value; }
      } else if (exec.name === 'computer_press_key') { assert.equal(state.focused, true); assert.equal(args.key, 'a'); assert.deepEqual(args.modifiers, ['command']); }
      else if (exec.name === 'computer_type_text') { assert.equal(state.focused, true); state.value = args.text; }
      else assert.fail('unexpected tool');
      return { isError: false, value: { observation: { ignored: true } } };
    },
  };
  const ctx = { get: (name) => ({ tools, agents: { get: (id) => id === agent.id ? state.registered : undefined }, computerUse: { status: () => state.status } })[name] };
  return { ctx, agent, state, calls, tools, visible, options: { ctx, agent, authorize: () => state.authorized, nonce, pid } };
}

test('scoped Skill/ToolRuntime fixtures bind one DSH window and require typing, click and fresh readback', async () => {
  const f = fixture();
  assert.deepEqual(await probeNativeDesktop(f.options), { ok: true, evidence: { kind: 'readback', matched: true, backend: '@anionex/dsh-computer-use', scope: 'dsh-window' } });
  assert.deepEqual(f.calls.map((exec) => exec.name), ['skill', 'computer_observe', 'computer_click', 'computer_observe',
    'computer_press_key', 'computer_observe', 'computer_type_text', 'computer_observe', 'computer_click', 'computer_observe']);
  assert.equal(f.calls.filter((exec) => exec.name === 'computer_type_text').length, 1);
  assert.equal(f.calls.filter((exec) => exec.name === 'computer_set_value').length, 0);
});

test('metadata remains pure, does not activate tools, refresh health or expose paths/diagnostics, and preserves unknown readiness', () => {
  const f = fixture(); const before = [...f.visible];
  assert.equal(nativeControlMetadata(f.ctx, { agent: f.agent }).desktop.available, true);
  assert.equal(f.calls.length, 0); assert.deepEqual([...f.visible], before);
  assert.equal(JSON.stringify(nativeControlMetadata(f.ctx, { agent: f.agent })).includes('PRIVATE'), false);
  f.visible.clear(); assert.equal(nativeControlMetadata(f.ctx).desktop.available, true, 'host metadata must not confuse unloaded Agent tools with a missing backend');
  f.visible.add('skill'); f.visible.add('computer_use_activate');
  f.state.status.ready = undefined; assert.equal(nativeControlMetadata(f.ctx, { agent: f.agent }).desktop.available, null);
  f.state.status.accessibility = 'denied'; assert.equal(nativeControlMetadata(f.ctx, { agent: f.agent }).desktop.available, false);
});

test('the GUI PID is uniquely resolved by the native provider and fenced on every later observation without listing other apps', async () => {
  const f = fixture({ active: true }); f.state.discoverPid = true; delete f.options.pid;
  assert.equal((await probeNativeDesktop(f.options)).ok, true);
  const observations = f.calls.filter(exec => exec.name === 'computer_observe');
  assert.deepEqual(observations[0].arguments.app, { bundleId: 'com.deepseek.dsh' });
  assert.ok(observations.slice(1).every(exec => exec.arguments.app.pid === pid));
  assert.equal(f.calls.some(exec => exec.name === 'computer_list_apps'), false);
  const changed = fixture({ active: true }); changed.state.discoverPid = true; delete changed.options.pid;
  changed.state.modify = value => { if (changed.state.seq > 1) value.app.pid++; };
  await assert.rejects(probeNativeDesktop(changed.options), { code: 'DESKTOP_TARGET_UNCONFIRMED' });
  assert.equal(changed.calls.some(exec => exec.name === 'computer_type_text'), false);
});

test('untrusted, replaced or cancelled agents cannot load a Skill or start a desktop observation', async () => {
  for (const mode of ['denied', 'missing-authorize', 'replaced', 'cancelled']) {
    const f = fixture(), controller = new AbortController();
    if (mode === 'denied') f.state.authorized = false;
    if (mode === 'missing-authorize') delete f.options.authorize;
    if (mode === 'replaced') f.state.registered = { ...f.agent };
    if (mode === 'cancelled') { controller.abort(); f.options.signal = controller.signal; }
    await assert.rejects(probeNativeDesktop(f.options), { code: 'CANCELLED' }); assert.equal(f.calls.length, 0);
  }
});

test('wrong app, missing or duplicate fixture, truncation and pre-existing proof prevent all mutation', async () => {
  const mutations = [value => { value.app.pid++; }, value => { value.app.bundleId = 'other.app'; },
    value => { value.elements[0].label = 'another field'; }, value => { value.elements.push({ ...value.elements[0], index: 100 }); },
    value => { value.tree.truncated = true; }, value => { delete value.window.id; },
    value => { value.elements[2].value = '电脑控制回读：' + nonce; }];
  for (const modify of mutations) {
    const f = fixture({ active: true }); f.state.modify = modify;
    await assert.rejects(probeNativeDesktop(f.options), { code: 'DESKTOP_TARGET_UNCONFIRMED' });
    assert.deepEqual(f.calls.map(exec => exec.name), ['computer_observe']);
  }
});

test('focus or window change fails before keyboard input instead of guessing another field', async () => {
  for (const mode of ['window', 'focus']) {
    const f = fixture({ active: true });
    f.state.modify = value => { if (f.state.seq > 1) { if (mode === 'window') value.window.id++; else value.elements[0].focused = false; } };
    await assert.rejects(probeNativeDesktop(f.options), { code: 'DESKTOP_TARGET_UNCONFIRMED' });
    assert.equal(f.calls.some(exec => exec.name === 'computer_type_text' || exec.name === 'computer_press_key'), false);
  }
});

test('a failed or unknown dispatched action is never retried and its diagnostic is sanitized', async () => {
  const f = fixture({ active: true });
  f.state.intercept = (exec) => exec.name === 'computer_type_text' ? { isError: true, error: { message: 'COMPUTER_TIMEOUT: PRIVATE_UI_CONTENT' } } : undefined;
  await assert.rejects(probeNativeDesktop(f.options), (failure) => failure.code === 'UNCONFIRMED' && !failure.message.includes('PRIVATE'));
  assert.equal(f.calls.filter(exec => exec.name === 'computer_type_text').length, 1);
  assert.equal(f.calls.filter(exec => exec.name === 'computer_click').length, 1);
});

test('successful input without the React/button readback cannot become a verified result', async () => {
  const f = fixture({ active: true });
  f.state.modify = value => { if (f.state.seq === 5) value.elements[2].value = 'no result'; };
  await assert.rejects(probeNativeDesktop(f.options), { code: 'UNCONFIRMED' });
  assert.equal(f.calls.filter(exec => exec.name === 'computer_type_text').length, 1);
  assert.equal(f.calls.filter(exec => exec.name === 'computer_click').length, 2);
});

test('ToolRuntime permission failures map to a fixed code and a denied Skill never unlocks desktop tools', async () => {
  const f = fixture(); f.state.intercept = () => ({ isError: true, error: { message: 'COMPUTER_PERMISSION_REQUIRED: PRIVATE_PERMISSION_DETAIL' } });
  await assert.rejects(probeNativeDesktop(f.options), (failure) => failure.code === 'ACCESSIBILITY_REQUIRED' && !failure.message.includes('PRIVATE'));
  assert.deepEqual(f.calls.map(exec => exec.name), ['skill']);
});

test('cancellation or a timeout aborts the real execution signal but still awaits its cleanup and rejects late success', async () => {
  for (const mode of ['cancel', 'timeout']) {
    const f = fixture({ active: true }), started = deferred(), finish = deferred(), controller = new AbortController(); let settled = false, execSignal;
    f.state.intercept = async exec => { execSignal = exec.signal; started.resolve(); await finish.promise; return { isError: false, value: 'late' }; };
    const pending = canonicalToolCall({ ...f.options, name: 'computer_observe', signal: controller.signal, ...(mode === 'timeout' ? { timeoutMs: 1 } : {}) }).finally(() => { settled = true; });
    const rejected = assert.rejects(pending, { code: mode === 'cancel' ? 'CANCELLED' : 'UNCONFIRMED' });
    await started.promise; if (mode === 'cancel') controller.abort(); else await new Promise(resolve => setTimeout(resolve, 10));
    await immediate(); assert.equal(execSignal.aborted, true); assert.equal(settled, false);
    finish.resolve(); await rejected; assert.equal(f.calls.length, 1);
  }
});

test('canonical calls preserve supplied parent identity and do not bypass a rejected host policy', async () => {
  const f = fixture({ active: true }), parent = { name: 'actual-parent-tool', callId: 'parent' };
  f.state.intercept = exec => { assert.equal(exec.parent, parent); return { isError: true, error: { info: { code: 'UNKNOWN_TOOL' }, message: 'PRIVATE_POLICY' } }; };
  await assert.rejects(canonicalToolCall({ ...f.options, name: 'computer_observe', parent }), { code: 'UNAVAILABLE' });
  assert.equal(f.calls.length, 1);
});
