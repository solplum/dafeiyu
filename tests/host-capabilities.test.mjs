import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostCapabilityAdapter } from '../packages/dsh-dafeiyu/src/host-capabilities.js';

const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const calls = [], skillsCalls = [];
  let runtime = {}, owner = true;
  const successful = (text) => ({ isError: false, value: { exitCode: 0, signal: null, timedOut: false, aborted: false,
    stdout: { text, truncated: false }, stderr: { text: 'PRIVATE-STDERR', truncated: false } } });
  const tools = { schemas: (scope) => { assert.equal(scope, agent); return ['bash', 'read', 'web_search', 'web_fetch'].map((name) => ({ name,
    description: 'PRIVATE-DESCRIPTION' })); },
  execute: async (exec) => { calls.push(exec); return successful(exec.arguments.command.startsWith('printf')
    ? 'DSH_CAPABILITY_TERMINAL_OK\n' : 'tool 1.2.3\n'); }, ...overrides.tools };
  const skills = { snapshot: async (opts) => { skillsCalls.push(opts); return { skills: ['computer-use', 'ego-browser', 'PRIVATE-ROLE'].map((name) => ({ name,
    content: 'PRIVATE-CONTENT', description: 'PRIVATE-DESCRIPTION', invocation: { modelInvocable: true } })), complete: true }; },
  ...overrides.skills };
  const jobs = overrides.jobs;
  const agents = new Map(), agent = { id: 'capability:1', session: { id: 'capability:1' }, ctx: { get: (key) => ({ tools, skills, jobs })[key] } };
  agents.set(agent.id, agent);
  const ctx = { get: (key) => key === 'agents' ? agents : undefined };
  const authorize = () => owner;
  const adapter = createHostCapabilityAdapter({ ctx, getRuntime: () => runtime,
    resolveContext: async () => ({ agent, cwd: '/owned/probe', isOwner: true }),
    now: () => 1234, ...overrides.adapter });
  return { adapter, tools, skills, jobs, agents, agent, calls, skillsCalls, authorize, successful,
    setRuntime: (value) => { runtime = value; }, setOwner: (value) => { owner = value; } };
}

test('snapshot is cache-only and has no CLI/service or private data side effects', () => {
  const f = fixture();
  assert.equal(f.adapter.snapshot().computer.available, null);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.skillsCalls, []);
  const first = f.adapter.snapshot(); first.tools.push('fake');
  assert.deepEqual(f.adapter.snapshot().tools, []);
});

test('discovery uses the real registered Agent scope and lists metadata, never skill bodies', async () => {
  const f = fixture();
  const result = await f.adapter.discover({ authorize: f.authorize });
  assert.equal(f.skillsCalls[0].scope, f.agent); assert.equal(f.skillsCalls[0].cwd, '/owned/probe');
  assert.equal(result.desktop.present, true); assert.equal(result.browser.available, null);
  assert.equal(result.computer.available, null); assert.equal(result.web.present, true);
  assert.deepEqual(result.skills, ['computer-use', 'ego-browser']);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(f.calls.length, 0);
});

test('refresh goes through standard tool runtime with agent/signal/callId, but metadata never proves GUI', async () => {
  const f = fixture();
  const result = await f.adapter.refresh({ authorize: f.authorize });
  assert.equal(f.calls.length, 3); assert.equal(result.computer.available, true);
  assert.equal(result.desktop.available, null); assert.equal(result.browser.available, null);
  assert.equal(result.browser.version, '1.2.3'); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  for (const call of f.calls) {
    assert.equal(call.name, 'bash'); assert.equal(call.agent, f.agent); assert.ok(call.callId.startsWith('dafeiyu-capability-'));
    assert.equal(typeof call.signal.addEventListener, 'function'); assert.equal(call.parent, undefined);
    assert.equal(call.arguments.sandbox_permissions, undefined); assert.equal(call.arguments.workdir, '/owned/probe');
  }
});

test('no authorization means no scope discovery or execution', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.refresh(), { code: 'unauthorized' });
  f.setOwner(false);
  await assert.rejects(f.adapter.executeCommand('fixed', { authorize: f.authorize }), { code: 'unauthorized' });
  assert.equal(f.calls.length, 0); assert.equal(f.skillsCalls.length, 0);
});

test('lookalike unregistered Agent cannot acquire host tool authority', async () => {
  const f = fixture(); f.agents.delete(f.agent.id);
  await assert.rejects(f.adapter.discover({ authorize: f.authorize }), { code: 'scope-unavailable' });
  assert.equal(f.calls.length, 0);
});

test('runtime replacement or permission revocation during await does not publish stale results', async () => {
  for (const mutate of [(f) => f.setRuntime({}), (f) => f.setOwner(false)]) {
    const pending = gate();
    const f = fixture({ skills: { snapshot: () => pending.promise } });
    const run = f.adapter.discover({ authorize: f.authorize }); await new Promise((r) => setImmediate(r));
    mutate(f); pending.resolve({ skills: [], complete: true });
    await assert.rejects(run, (error) => ['unauthorized', 'runtime-changed'].includes(error.code));
    assert.equal(f.adapter.snapshot().checkedAt, null); assert.equal(f.calls.length, 0);
  }
});

test('hidden or PTC-restricted bash is not bypassed through body or forged parent', async () => {
  const f = fixture({ tools: { schemas: () => [{ name: 'run_code' }] } });
  await assert.rejects(f.adapter.executeCommand('fixed', { authorize: f.authorize }), { code: 'bash-unavailable' });
  assert.equal(f.calls.length, 0);
});

test('host policy rejection never exposes raw errors, stderr, or tool content', async () => {
  const f = fixture({ tools: { execute: async () => ({ isError: true, error: { message: 'PRIVATE-KEY' },
    content: [{ type: 'text', text: 'PRIVATE-CONTENT' }] }) } });
  const result = await f.adapter.executeCommand('fixed', { authorize: f.authorize });
  assert.deepEqual(result, { ok: false, stdout: '', exitCode: null, code: 'host-denied' });
  assert.equal(JSON.stringify(f.adapter.snapshot()).includes('PRIVATE'), false);
});

test('internal fixed proof reader returns only bounded successful stdout and exit code', async () => {
  const f = fixture();
  const result = await f.adapter.executeCommand('fixed nonce script', { authorize: f.authorize });
  assert.deepEqual(result, { ok: true, stdout: 'tool 1.2.3\n', exitCode: 0 });
  assert.equal(result.stderr, undefined);
  f.tools.execute = async () => ({ ...f.successful('PRIVATE-LONG'), value: { ...f.successful('').value,
    stdout: { text: 'PRIVATE-LONG', truncated: true } } });
  assert.equal((await f.adapter.executeCommand('fixed', { authorize: f.authorize })).stdout, '');
});

test('unknown CLI/version failure is not reported as absent or actual GUI failure', async () => {
  const f = fixture();
  f.tools.execute = async (exec) => exec.arguments.command.startsWith('printf') ? f.successful('DSH_CAPABILITY_TERMINAL_OK\n')
    : { isError: false, value: { ...f.successful('').value, exitCode: 1 } };
  const result = await f.adapter.refresh({ authorize: f.authorize });
  assert.equal(result.browser.present, true); assert.equal(result.browser.cliPresent, null); assert.equal(result.browser.available, null);
});

test('incomplete skill discovery retains unknown, and disabled invocation never implies availability', async () => {
  const f = fixture({ skills: { snapshot: async () => ({ complete: false, skills: [{ name: 'ego-browser', invocation: { modelInvocable: false } }] }) } });
  const result = await f.adapter.discover({ authorize: f.authorize });
  assert.equal(result.desktop.present, null); assert.equal(result.browser.present, null); assert.equal(result.skillsComplete, false);
});

test('only constructor-owned probe IDs can prove a capability from an actual tool receipt', async () => {
  const f = fixture({ adapter: { probeCommands: { browser_smoke: { capability: 'browser', command: 'fixed controlled browser proof',
    project: (result) => result.value?.stdout?.text === 'tool 1.2.3\n' } } } });
  await assert.rejects(f.adapter.executeNativeTool({ testId: 'arbitrary', command: 'unsafe', authorize: f.authorize }), { code: 'unknown-test' });
  assert.equal(f.calls.length, 0);
  const proof = await f.adapter.executeNativeTool({ testId: 'browser_smoke', authorize: f.authorize });
  assert.equal(proof.ok, true); assert.equal(proof.snapshot.browser.available, true);
  assert.equal(f.calls[0].arguments.command, 'fixed controlled browser proof');
});

test('concurrent probes are rejected and dispose aborts in-flight host execution without publishing late proof', async () => {
  const pending = gate(); let activeSignal;
  const f = fixture({ tools: { execute: (exec) => { activeSignal = exec.signal; return pending.promise; } } });
  const run = f.adapter.executeCommand('fixed', { authorize: f.authorize }); await new Promise((r) => setImmediate(r));
  await assert.rejects(f.adapter.discover({ authorize: f.authorize }), { code: 'busy' });
  f.adapter.dispose();
  assert.equal(activeSignal.aborted, true);
  // The actual passed tool signal is aborted; no raw-body cancellation shortcut.
  pending.resolve(f.successful('late proof'));
  await assert.rejects(run, { code: 'disposed' });
  assert.equal(f.adapter.snapshot().checkedAt, null);
});

test('Orca metadata is allowlisted and granted permissions still do not certify GUI actions', async () => {
  const f = fixture();
  f.tools.execute = async (exec) => {
    f.calls.push(exec);
    if (exec.arguments.command.includes('capabilities')) return f.successful(JSON.stringify({ ok: true, result: {
      platform: 'darwin', provider: 'orca-computer-use-macos', supports: { observation: { screenshot: true }, actions: { click: true, typeText: true } },
      helperAppPath: 'PRIVATE-PATH' }, _meta: { runtimeId: 'PRIVATE-ID' } }));
    if (exec.arguments.command.includes('permissions')) return f.successful(JSON.stringify({ ok: true, result: {
      permissions: [{ id: 'accessibility', status: 'granted' }, { id: 'screenshots', status: 'granted' }], nextStep: 'PRIVATE' } }));
    return f.successful(exec.arguments.command.startsWith('printf') ? 'DSH_CAPABILITY_TERMINAL_OK\n' : 'tool 1.2.3\n');
  };
  const result = await f.adapter.refresh({ authorize: f.authorize });
  assert.deepEqual(result.desktop.metadata, { screenshotSupported: true, clickSupported: true, typeTextSupported: true,
    accessibilityGranted: true, screenshotsGranted: true });
  assert.equal(result.desktop.available, null); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(f.calls.some((call) => /computer (?:screenshot|click|type)/.test(call.arguments.command)), false);
});

test('ego version incompatibility falls back to a complete guide metadata marker, without retaining guide content', async () => {
  const f = fixture();
  f.tools.execute = async (exec) => exec.arguments.command === 'ego-browser --version'
    ? { isError: false, value: { ...f.successful('').value, exitCode: 2 } }
    : f.successful(exec.arguments.command === 'ego-browser skill' ? 'PRIVATE-GUIDE\n[ego-browser:skill] end of guide\n'
      : exec.arguments.command.startsWith('printf') ? 'DSH_CAPABILITY_TERMINAL_OK\n' : 'tool 1.2.3\n');
  const result = await f.adapter.refresh({ authorize: f.authorize });
  assert.equal(result.browser.cliPresent, true); assert.equal(result.browser.available, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('unexpected host exceptions cannot expose raw errors to callers', async () => {
  const f = fixture({ tools: { execute: async () => { throw new Error('PRIVATE-KEY'); } } });
  await assert.rejects(f.adapter.executeCommand('fixed', { authorize: f.authorize }), (error) => error.code === 'host-unavailable' && !error.message.includes('PRIVATE'));
});

test('hot-replaced runtime cannot inherit cached successful capability proof', async () => {
  const f = fixture();
  await f.adapter.refresh({ authorize: f.authorize });
  assert.equal(f.adapter.snapshot().computer.available, true);
  const calls = f.calls.length; f.setRuntime({});
  assert.equal(f.adapter.snapshot().computer.available, null);
  assert.equal(f.adapter.snapshot().checkedAt, null); assert.equal(f.calls.length, calls);
});

test('internal command timeout is bounded while metadata probes retain the default', async () => {
  const f = fixture();
  for (const [given, expected] of [[undefined, 10000], [45000, 45000], [60000, 60000], [1, 1000], [-1, 1000],
    [60001, 60000], [45000.9, 45000], [NaN, 10000], [Infinity, 10000], ['45000', 10000]]) {
    await f.adapter.executeCommand('fixed', { authorize: f.authorize, timeoutMs: given });
    assert.equal(f.calls.at(-1).arguments.timeoutMs, expected);
  }
  const start = f.calls.length;
  await f.adapter.refresh({ authorize: f.authorize, timeoutMs: 60000 });
  assert.ok(f.calls.slice(start).every((call) => call.arguments.timeoutMs === 10000));
});

test('already-aborted internal command never resolves a scope or starts a tool', async () => {
  let resolves = 0;
  const f = fixture({ adapter: { resolveContext: async () => { resolves++; throw new Error('must not resolve'); } } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.adapter.executeCommand('fixed', { authorize: f.authorize, signal: controller.signal, timeoutMs: 45000 }), { code: 'cancelled' });
  assert.equal(resolves, 0); assert.equal(f.calls.length, 0); assert.equal(f.adapter.busy, false);
});

test('promoted Bash is cancelled through its exact owner and gate stays held until actual settlement', async () => {
  const done = gate(), trace = [];
  let status = 'running';
  const view = () => ({ id: 'bash-owned', owner: 'capability:1', kind: 'bash', status });
  const f = fixture({ jobs: {
    get: (id, owner) => { assert.equal(id, 'bash-owned'); assert.equal(owner, 'capability:1'); return view(); },
    wait: (id, timeout, owner, signal) => { trace.push('wait'); assert.equal(id, 'bash-owned'); assert.equal(timeout, 5000);
      assert.equal(owner, 'capability:1'); assert.equal(signal, undefined); return done.promise; },
    kill: (id, owner) => { trace.push('kill'); assert.equal(id, 'bash-owned'); assert.equal(owner, 'capability:1'); status = 'stopping'; },
    remove: (id, owner) => { trace.push('remove'); assert.equal(status, 'killed'); assert.equal(id, 'bash-owned'); assert.equal(owner, 'capability:1'); },
  } });
  f.tools.execute = async (exec) => { f.calls.push(exec); return { isError: false, value: { kind: 'promoted', jobId: 'bash-owned', output: 'PRIVATE-OUTPUT' } }; };
  const run = f.adapter.refresh({ authorize: f.authorize }); await new Promise((r) => setImmediate(r));
  assert.deepEqual(trace, ['wait', 'kill']); assert.equal(f.adapter.busy, true);
  await assert.rejects(f.adapter.executeCommand('must not start', { authorize: f.authorize }), { code: 'busy' });
  assert.equal(f.calls.length, 1); status = 'killed'; done.resolve(view());
  await assert.rejects(run, { code: 'command-promoted' });
  assert.equal(f.adapter.busy, false); assert.deepEqual(trace, ['wait', 'kill', 'remove']);
  assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(f.adapter.snapshot()).includes('PRIVATE'), false);
});

test('unconfirmed promoted cleanup permanently blocks another execution until that same owner job is terminal', async () => {
  let status = 'running', kills = 0;
  const view = () => ({ id: 'bash-owned', owner: 'capability:1', kind: 'bash', status });
  const f = fixture({ jobs: { get: view, wait: async () => view(), kill: () => { kills++; status = 'stopping'; }, remove: () => {} } });
  f.tools.execute = async (exec) => { f.calls.push(exec); return { isError: false, value: { kind: 'promoted', jobId: 'bash-owned' } }; };
  await assert.rejects(f.adapter.executeCommand('first', { authorize: f.authorize }), { code: 'cleanup-unconfirmed' });
  assert.equal(f.adapter.busy, true); assert.equal(f.adapter.snapshot().cleanupPending, true);
  await assert.rejects(f.adapter.refresh({ authorize: f.authorize }), { code: 'cleanup-unconfirmed' });
  assert.equal(f.calls.length, 1); assert.equal(kills, 1);
  status = 'killed'; f.tools.execute = async (exec) => { f.calls.push(exec); return f.successful('new proof'); };
  assert.equal((await f.adapter.executeCommand('explicit new check', { authorize: f.authorize })).ok, true);
  assert.equal(f.adapter.busy, false); assert.equal(f.calls.length, 2);
});

test('missing registry or mismatched owner never kills another job or releases the protection', async () => {
  for (const jobs of [undefined, { get: () => ({ id: 'bash-owned', owner: 'other-agent', kind: 'bash', status: 'completed' }),
    kill: () => assert.fail('cannot kill another owner'), wait: () => assert.fail('cannot await another owner') }]) {
    const f = fixture({ jobs });
    f.tools.execute = async (exec) => { f.calls.push(exec); return { isError: false, value: { kind: 'promoted', jobId: 'bash-owned' } }; };
    await assert.rejects(f.adapter.refresh({ authorize: f.authorize }), { code: 'cleanup-unconfirmed' });
    await assert.rejects(f.adapter.refresh({ authorize: f.authorize }), { code: 'cleanup-unconfirmed' });
    assert.equal(f.calls.length, 1); assert.equal(f.adapter.busy, true);
  }
});

test('promotion cleanup still cancels only its job after caller abort, never trusts promoted output as success', async () => {
  const controller = new AbortController(); let stopped = false;
  const view = () => ({ id: 'bash-owned', owner: 'capability:1', kind: 'bash', status: stopped ? 'killed' : 'running' });
  const done = gate();
  const f = fixture({ jobs: { get: view, wait: (_id, _timeout, _owner, signal) => { assert.equal(signal, undefined); return done.promise; },
    kill: () => { stopped = true; done.resolve(view()); }, remove: () => {} } });
  f.tools.execute = async () => { controller.abort(); return { isError: false, value: { kind: 'promoted', jobId: 'bash-owned',
    stdout: { text: 'forged proof', truncated: false }, exitCode: 0 } }; };
  await assert.rejects(f.adapter.executeCommand('fixed', { authorize: f.authorize, signal: controller.signal }), { code: 'command-promoted' });
  assert.equal(stopped, true); assert.equal(f.adapter.busy, false); assert.equal(f.adapter.snapshot().computer.available, null);
});

test('snapshot polling only observes exact owner in memory and unlocks after proven terminal without job mutations', async () => {
  let status = 'running'; const mutations = { kill: 0, wait: 0, remove: 0 }; const gets = [];
  const view = () => ({ id: 'bash-owned', owner: 'capability:1', kind: 'bash', status });
  const f = fixture({ jobs: {
    get: (id, owner) => { gets.push([id, owner]); return view(); },
    wait: async () => { mutations.wait++; return view(); },
    kill: () => { mutations.kill++; status = 'stopping'; },
    remove: () => { mutations.remove++; },
  } });
  f.tools.execute = async (exec) => { f.calls.push(exec); return { isError: false, value: { kind: 'promoted', jobId: 'bash-owned' } }; };
  await assert.rejects(f.adapter.executeCommand('fixed', { authorize: f.authorize }), { code: 'cleanup-unconfirmed' });
  const before = { ...mutations }; const calls = f.calls.length;
  assert.equal(f.adapter.snapshot().busy, true); assert.equal(f.adapter.snapshot().cleanupPending, true);
  assert.equal(f.adapter.busy, true);
  status = 'killed';
  const result = f.adapter.snapshot();
  assert.notEqual(result.busy, true); assert.notEqual(result.cleanupPending, true); assert.equal(f.adapter.busy, false);
  assert.deepEqual(mutations, before); assert.equal(f.calls.length, calls);
  assert.ok(gets.every(([id, owner]) => id === 'bash-owned' && owner === 'capability:1'));
});

test('only exact single-line fixed probe failures from a clean nonzero Bash exit retain their enum', async () => {
  const f = fixture();
  for (const code of ['UNAVAILABLE', 'UNCONFIRMED', 'FAILED', 'ACCESSIBILITY_REQUIRED', 'DESKTOP_INIT_UNCONFIRMED', 'DESKTOP_TARGET_UNCONFIRMED']) for (const suffix of ['', '\n', '\r\n']) {
    assert.ok(('DFY_CAPABILITY_FAILURE ' + code + suffix).length <= 64, 'fixed diagnostic remains within the parser bound');
    f.tools.execute = async () => ({ isError: false, value: { ...f.successful('').value, exitCode: 1,
      stdout: { text: 'DFY_CAPABILITY_FAILURE ' + code + suffix, truncated: false } } });
    assert.deepEqual(await f.adapter.executeCommand('fixed', { authorize: f.authorize }), { ok: false, stdout: '', exitCode: 1, code });
  }
  f.tools.execute = async () => ({ isError: false, value: { ...f.successful('').value, exitCode: 2,
    sandbox: { denied: false, runnerFailed: false }, stdout: { text: 'DFY_CAPABILITY_FAILURE FAILED\n', truncated: false } } });
  assert.equal((await f.adapter.executeCommand('fixed', { authorize: f.authorize })).code, 'FAILED');
});

test('timeout, cancellation, missing flags, policy denial or arbitrary text cannot forge a trusted failure enum', async () => {
  const f = fixture();
  const valid = () => ({ isError: false, value: { ...f.successful('').value, exitCode: 1,
    stdout: { text: 'DFY_CAPABILITY_FAILURE UNAVAILABLE\n', truncated: false } } });
  const variants = [
    (r) => { r.isError = true; },
    (r) => { r.value.timedOut = true; },
    (r) => { r.value.aborted = true; },
    (r) => { r.value.signal = 'SIGTERM'; },
    (r) => { delete r.value.signal; },
    (r) => { delete r.value.timedOut; },
    (r) => { delete r.value.aborted; },
    (r) => { r.value.sandbox = { denied: true }; },
    (r) => { r.value.sandbox = { denied: false, runnerFailed: true }; },
    (r) => { r.value.sandbox = {}; },
    (r) => { r.value.exitCode = null; },
    (r) => { r.value.exitCode = '1'; },
    (r) => { r.value.exitCode = 0.5; },
    (r) => { r.value.stdout.truncated = true; },
    (r) => { delete r.value.stdout.truncated; },
    (r) => { r.value.stdout.text += 'PRIVATE-RAW'; },
    (r) => { r.value.stdout.text = 'PRIVATE-RAW\n' + r.value.stdout.text; },
    (r) => { r.value.stdout.text = ' ' + r.value.stdout.text; },
    (r) => { r.value.stdout.text = 'DFY_CAPABILITY_FAILURE UNAVAILABLE\n\n'; },
    (r) => { r.value.stdout.text = 'DFY_CAPABILITY_FAILURE PRIVATE-KEY\n'; },
  ];
  for (const mutate of variants) {
    const result = valid(); mutate(result); f.tools.execute = async () => result;
    const received = await f.adapter.executeCommand('fixed', { authorize: f.authorize });
    assert.equal(received.ok, false); assert.equal(received.stdout, '');
    assert.ok(['host-denied', 'invalid-result'].includes(received.code)); assert.equal(JSON.stringify(received).includes('PRIVATE'), false);
  }
  f.tools.execute = async () => f.successful('DFY_CAPABILITY_FAILURE UNAVAILABLE\n');
  assert.deepEqual(await f.adapter.executeCommand('fixed', { authorize: f.authorize }), {
    ok: true, stdout: 'DFY_CAPABILITY_FAILURE UNAVAILABLE\n', exitCode: 0,
  });
});
