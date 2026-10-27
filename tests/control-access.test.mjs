import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlAccess } from '../packages/dsh-dafeiyu/src/control-access.js';
import { createNativeTaskExecutor } from '../packages/dsh-dafeiyu/src/native-task-executor.js';

const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((yes) => setImmediate(yes));
const success = () => ({ isError: false, value: { ok: true }, content: [] });
function fixture() {
  const registry = new Map(), owners = new WeakSet(), parents = new WeakMap(), handlers = new Map(), eventOptions = new Map(), guards = [];
  let current = {}, serial = 0;
  const names = ['computer_use_activate', 'computer_observe', 'computer_list_apps', 'computer_click', 'computer_set_value',
    'ego_space_open', 'ego_space_close', 'ego_snapshot', 'ego_fill', 'ego_click', 'ego_help', 'ego_script', 'ego_cli', 'ego_js',
    'ego_cdp', 'ego_http', 'ego_login_import', 'ego_upload', 'ego_download', 'dafeiyu_control_context', 'structured_output', 'skill', 'bash', 'read', 'write',
    'edit', 'dafeiyu_memory', 'phone_screenshot', 'qq_send', 'spawn_agent', 'unrelated'];
  const services = { agents: { get: (id) => registry.get(id), isOwnedBy: (id, parent) => parents.get(registry.get(id)) === parent },
    tools: { guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1); } } };
  const ctx = { get: (name) => services[name], on(name, fn, options) {
    eventOptions.set(name, options);
    const rows = handlers.get(name) || []; rows.push(fn); handlers.set(name, rows);
    return () => rows.splice(rows.indexOf(fn), 1);
  } };
  const access = createControlAccess({ ctx, getRuntime: () => current, resolveOwner: (agent) => ({ isOwner: owners.has(agent) }) });
  access.attach();
  const addAgent = ({ id = 'agent-' + (++serial), owner = false, parent, mode, ownMode } = {}) => {
    const inheritedMode = mode ?? parent?.ctx.get('tools').modeFor(parent) ?? 'native';
    let ownPresentation = ownMode;
    const tools = { modeFor: () => ownPresentation ?? inheritedMode,
      presentAs(value) {
        if (ownPresentation !== undefined) throw new Error('real host: one presentation declaration per own scope');
        ownPresentation = value;
        return () => { ownPresentation = undefined; };
      },
      schemas: () => [...names, ...(tools.modeFor() === 'ptc' ? ['run_code'] : [])].map((name) => ({ name })),
      wireSchemas: () => ({ schemas: tools.modeFor() === 'ptc' ? [{ name: 'run_code' }] : tools.schemas() }),
      restrict(filter) {
      if (filter.allow.includes('structured_output')) throw new Error('real host: own-layer structured_output is not restrictable');
      tools.restriction = filter;
    } };
    const agent = { id, session: { id }, ctx: { get: (name) => name === 'tools' ? tools : services[name] } };
    registry.set(id, agent); if (owner) owners.add(agent); if (parent) parents.set(agent, parent);
    return agent;
  };
  const fire = async (name, ...args) => { for (const fn of handlers.get(name) || []) await fn(...args); };
  const turn = (agent, number = 1, type = 'turn/start', seq = number * 10 + (type === 'turn/end' ? 1 : 0)) =>
    fire('session/event', agent.session, { type, seq, data: { turn: number, reason: { kind: 'completed' } } });
  const execute = async (agent, name, args = {}, { body = async () => success(), signal = new AbortController().signal, callId } = {}) => {
    const exec = { agent, name, arguments: args, signal, callId: callId || 'call-' + (++serial) };
    for (const guard of guards) { const reason = guard(exec); if (reason) throw Object.assign(new Error(reason), { code: 'DENIED' }); }
    let next = body;
    for (const fn of [...(handlers.get('tools/execute') || [])].reverse()) { const previous = next; next = () => fn(exec, previous); }
    return next();
  };
  return { access, ctx, services, eventOptions, registry, owners, parents, guards, handlers, addAgent, fire, turn, execute,
    get runtime() { return current; }, changeRuntime() { current = {}; },
    probeCurrent(agent, options = {}) { return { agent, runtime: current, authorize: () => true, ...options }; } };
}

const readSpace = (suffix = '1') => 'dfy-douyin-12345678-1234-4234-8234-' + suffix.padStart(12, '0');
const readScript = (space) => 'const ownedSpace=' + JSON.stringify(space) + ';console.log("fixed public read");';
const cleanedValue = () => ({ ok: true, result: { ok: true, cleanupConfirmed: true } });

test('trusted browser read permits only one exact nested call, leaving general scripts denied', async () => {
  const f = fixture(), agent = f.addAgent({ owner: true }); await f.turn(agent); const space = readSpace(); let captured, bodies = 0;
  await assert.rejects(f.execute(agent, 'ego_script', { script: readScript(space) }), { code: 'DENIED' });
  const result = await f.access.executeTrustedBrowserRead({ agent, space, script: readScript(space) }, async (grant) => {
    captured = grant;
    const result = await f.execute(agent, 'ego_script', grant.arguments, { callId: grant.callId, signal: grant.signal,
      body: async () => { bodies++; return { isError: false, value: cleanedValue() }; } });
    return result.value;
  });
  assert.equal(result.result.cleanupConfirmed, true); assert.equal(bodies, 1);
  await assert.rejects(f.execute(agent, 'ego_script', captured.arguments, { callId: captured.callId }), { code: 'DENIED' });
  await f.turn(agent, 1, 'turn/end'); assert.equal(f.access.snapshot().busy, false);
});

test('trusted read proofs reject changed code, extra arguments, another agent and unowned spaces before dispatch', async () => {
  const f = fixture(), owner = f.addAgent({ owner: true }), other = f.addAgent({ owner: true }); await f.turn(owner); await f.turn(other);
  for (const mutation of ['script', 'extra', 'agent']) {
    const space = readSpace(mutation === 'script' ? '2' : mutation === 'extra' ? '3' : '4'); let body = false;
    await assert.rejects(f.access.executeTrustedBrowserRead({ agent: owner, space, script: readScript(space) }, async (grant) => {
      await f.execute(mutation === 'agent' ? other : owner, 'ego_script', { ...grant.arguments,
        ...(mutation === 'script' ? { script: grant.arguments.script + '\n// changed' } : mutation === 'extra' ? { space: 'default' } : {}) },
      { callId: grant.callId, body: async () => { body = true; return success(); } });
    }), { code: 'DENIED' }); assert.equal(body, false);
  }
  await assert.rejects(f.access.executeTrustedBrowserRead({ agent: owner, space: 'default', script: 'arbitrary' }, async () => success()), { code: 'CONTROL_INVALID_OPERATION' });
  await f.turn(owner, 1, 'turn/end'); await f.turn(other, 1, 'turn/end'); await f.access.dispose();
});

test('trusted read needs a real owner and live browser scope and retains the shared lease through its actual body', async () => {
  const f = fixture(), agent = f.addAgent({ owner: true }), guest = f.addAgent(), other = f.addAgent({ owner: true });
  await assert.rejects(f.access.executeTrustedBrowserRead({ agent, space: readSpace(), script: readScript(readSpace()) }, async () => success()));
  await f.turn(agent); await f.turn(other); const pending = gate(); let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const operation = f.access.executeTrustedBrowserRead({ agent, space: readSpace(), script: readScript(readSpace()) }, async (grant) => {
    const result = await f.execute(agent, 'ego_script', grant.arguments, { callId: grant.callId, signal: grant.signal,
      body: async () => { entered(); await pending.promise; return { isError: false, value: cleanedValue() }; } }); return result.value;
  });
  await started; assert.equal(f.access.snapshot().busy, true);
  await assert.rejects(f.access.executeTrustedBrowserRead({ agent: other, space: readSpace('8'), script: readScript(readSpace('8')) }, async () => success()), { code: 'CONTROL_BUSY' });
  await assert.rejects(f.access.executeTrustedBrowserRead({ agent: guest, space: readSpace('9'), script: readScript(readSpace('9')) }, async () => success()));
  await f.turn(agent, 1, 'turn/end'); assert.equal(f.access.snapshot().busy, true); pending.resolve();
  await assert.rejects(operation, { code: 'CONTROL_SCOPE_REVOKED' }); assert.equal(f.access.snapshot().busy, false);
  await f.turn(other, 1, 'turn/end');
});

test('unknown trusted read cleanup stays occupied, and revoked authority can only close that owned space', async () => {
  const f = fixture(), agent = f.addAgent({ owner: true }); await f.turn(agent); const space = readSpace('7');
  await assert.rejects(f.access.executeTrustedBrowserRead({ agent, space, script: readScript(space) }, async (grant) => {
    return f.execute(agent, 'ego_script', grant.arguments, { callId: grant.callId, body: async () => { throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' }); } });
  }), { code: 'CANCELLED' });
  assert.equal(f.access.snapshot().cleanupPending, true); f.owners.delete(agent);
  await assert.rejects(f.access.executeTrustedBrowserRead({ agent, space: readSpace('8'), cleanup: true }, async () => success()), { code: 'CONTROL_SCOPE_REVOKED' });
  await f.access.executeTrustedBrowserRead({ agent, space, cleanup: true, script: 'ignored attacker code' }, async (grant) => {
    assert.match(grant.arguments.script, /taskSpaces\.complete/); assert.equal(grant.arguments.script.includes('attacker'), false);
    const result = await f.execute(agent, 'ego_script', grant.arguments, { callId: grant.callId, body: async () => ({ isError: false, value: cleanedValue() }) }); return result.value;
  });
  assert.equal(f.access.snapshot().cleanupPending, false); await f.turn(agent, 1, 'turn/end'); assert.equal(f.access.snapshot().busy, false);
});

test('an existing live HTTP-authorized probe may use one fixed trusted read without becoming an owner', async () => {
  const f = fixture(), agent = f.addAgent(); let allowed = true, dispatched = 0;
  await f.access.runProbe(f.probeCurrent(agent, { authorize: () => allowed }), 'browser', async () => {
    assert.equal(f.access.scopeFor(agent).kind, 'probe');
    await assert.rejects(f.execute(agent, 'ego_script', { script: readScript(readSpace('a')) }), { code: 'DENIED' });
    await f.access.executeTrustedBrowserRead({ agent, space: readSpace('a'), script: readScript(readSpace('a')) }, async (grant) => {
      const result = await f.execute(agent, 'ego_script', grant.arguments, { callId: grant.callId, signal: grant.signal,
        body: async () => { dispatched++; return { isError: false, value: cleanedValue() }; } }); return result.value;
    });
    allowed = false;
    await assert.rejects(f.access.executeTrustedBrowserRead({ agent, space: readSpace('b'), script: readScript(readSpace('b')) }, async () => { dispatched++; }), { code: 'CONTROL_SCOPE_REVOKED' });
    allowed = true;
  });
  assert.equal(dispatched, 1); assert.equal(f.owners.has(agent), false); assert.equal(f.access.scopeFor(agent), null); assert.equal(f.access.snapshot().busy, false);
  await assert.rejects(f.access.executeTrustedBrowserRead({ agent, space: readSpace('c'), script: readScript(readSpace('c')) }, async () => {}), { code: 'CONTROL_SCOPE_REVOKED' });
});

test('probe runtime replacement or revoked HTTP owner suppresses a late trusted result while preserving cleanup', async () => {
  for (const reason of ['runtime', 'authorization']) {
    const f = fixture(), agent = f.addAgent(); let allowed = true, entered;
    const pending = gate(), ready = new Promise((resolve) => { entered = resolve; });
    const operation = f.access.runProbe(f.probeCurrent(agent, { authorize: () => allowed }), 'browser', async () => {
      await f.access.executeTrustedBrowserRead({ agent, space: readSpace(reason === 'runtime' ? 'd' : 'e'), script: readScript(readSpace(reason === 'runtime' ? 'd' : 'e')) }, async (grant) => {
        const result = await f.execute(agent, 'ego_script', grant.arguments, { callId: grant.callId, signal: grant.signal,
          body: async () => { entered(); await pending.promise; return { isError: false, value: cleanedValue() }; } }); return result.value;
      });
    });
    await ready; if (reason === 'runtime') f.changeRuntime(); else allowed = false;
    assert.equal(f.access.snapshot().busy, true); pending.resolve(); await assert.rejects(operation, { code: 'CONTROL_SCOPE_REVOKED' });
    assert.equal(f.access.snapshot().cleanupPending, false); assert.equal(f.access.snapshot().busy, false);
  }
});

test('standing autonomous authority cannot call the trusted script entry even with browser capability', async () => {
  const f = fixture(), agent = f.addAgent();
  await f.access.runAutonomous({ agent, taskId: 'bounded-auto-denied', hosts: ['www.douyin.com'], authorize: () => true }, async () => {
    await assert.rejects(f.access.executeTrustedBrowserRead({ agent, space: readSpace('f'), script: readScript(readSpace('f')) }, async () => success()), { code: 'CONTROL_CAPABILITY_DENIED' });
  });
});

test('standing autonomous authority is confined to one space and read-only approved video domains', async () => {
  const f = fixture(), agent = f.addAgent(); let allowed = true;
  await f.access.runAutonomous({ agent, taskId: 'auto-browser-123', hosts: ['www.bilibili.com'], authorize: () => allowed }, async ({ space }) => {
    await f.execute(agent, 'ego_space_open', { name: space, url: 'https://www.bilibili.com' });
    await f.execute(agent, 'ego_snapshot', { space });
    for (const name of ['bash', 'read', 'write', 'qq_send', 'phone_screenshot', 'ego_click', 'ego_fill', 'ego_upload', 'ego_download'])
      await assert.rejects(f.execute(agent, name, { space }), { code: 'DENIED' });
    for (const url of ['file:///private', 'https://evil.example', 'http://www.bilibili.com', 'https://www.bilibili.com.evil.example'])
      await assert.rejects(f.execute(agent, 'ego_navigate', { space, url }), { code: 'DENIED' });
    await assert.rejects(f.execute(agent, 'ego_snapshot', { space: 'default' }), { code: 'DENIED' });
    allowed = false;
    await assert.rejects(f.execute(agent, 'ego_snapshot', { space }), { code: 'DENIED' });
    await f.execute(agent, 'ego_space_close', { name: space });
    allowed = true;
  });
  assert.equal(f.access.snapshot().busy, false);
});

test('GUI context binds real owner and exact live turn without acquiring the desktop or granting owner to guests', async () => {
  const f = fixture(), owner = f.addAgent({ owner: true }), guest = f.addAgent();
  for (const name of ['tools/execute', 'session/event', 'agent/created']) assert.equal(f.eventOptions.get(name)?.global, true, name);
  assert.equal(f.access.scopeFor(owner), null, 'a missing turn-start is not guessed from a session id');
  await f.turn(owner);
  const context = f.access.contextFor(owner);
  assert.match(context.browserSpace, /^dafeiyu-task-/);
  assert.equal(context.space, context.browserSpace);
  assert.equal(context.kind, 'owner'); assert.equal(context.isOwner, undefined);
  assert.equal(f.access.snapshot().busy, false);
  assert.equal(Object.isFrozen(context.capabilities), true);
  assert.equal(f.access.scopeFor(guest), null);
  const forged = { ...owner };
  assert.equal(f.access.scopeFor(forged), null);
  await assert.rejects(f.execute(forged, 'computer_observe'), { code: 'DENIED' });
  await assert.rejects(f.execute(guest, 'ego_space_open', { name: 'default' }), { code: 'DENIED' });
  await f.turn(owner, 1, 'turn/end');
});

test('an old prepared execution cannot be reminted into the same agent new turn before its delayed body', async () => {
  const f = fixture(), agent = f.addAgent({ owner: true }); await f.turn(agent, 1);
  const prepared = { agent, name: 'computer_observe', arguments: {}, signal: new AbortController().signal };
  assert.equal(f.guards[0](prepared), undefined);
  await f.turn(agent, 1, 'turn/end'); await f.turn(agent, 2);
  let body = false;
  await assert.rejects(f.handlers.get('tools/execute')[0](prepared, async () => { body = true; return success(); }), { code: 'CONTROL_DISPATCH_DENIED' });
  assert.equal(body, false);
  await f.execute(agent, 'computer_observe'); await f.turn(agent, 2, 'turn/end');
});

test('turn/end cannot release a full observe-act-verify lease before the actual tools/execute promise settles', async () => {
  const f = fixture(), first = f.addAgent({ owner: true }), second = f.addAgent({ owner: true }), pending = gate();
  await f.turn(first); await f.turn(second);
  const operation = f.execute(first, 'computer_observe', {}, { body: () => pending.promise });
  await tick();
  assert.equal(f.access.snapshot().inflight, 1);
  await f.turn(first, 1, 'turn/end');
  assert.equal(f.access.snapshot().busy, true);
  await assert.rejects(f.execute(second, 'computer_observe'), { code: 'DENIED' });
  pending.resolve(success()); await operation;
  assert.equal(f.access.snapshot().busy, false);
  await f.execute(second, 'computer_observe'); await f.execute(second, 'computer_click');
  assert.equal(f.access.snapshot().busy, true, 'one settled tool is not a completed turn');
  await f.turn(second, 1, 'turn/end'); assert.equal(f.access.snapshot().busy, false);
});

test('a subsequent turn of the same agent cannot reuse the previous turn while an old body is still settling', async () => {
  const f = fixture(), agent = f.addAgent({ owner: true }), pending = gate();
  await f.turn(agent, 1);
  const operation = f.execute(agent, 'computer_observe', {}, { body: () => pending.promise });
  await tick(); await f.turn(agent, 1, 'turn/end'); await f.turn(agent, 2);
  await assert.rejects(f.execute(agent, 'computer_click'), { code: 'DENIED' });
  pending.resolve(success()); await operation;
  await f.execute(agent, 'computer_observe'); await f.turn(agent, 2, 'turn/end');
  assert.equal(f.access.snapshot().busy, false);
});

test('browser calls require the one generated space on every call and deny raw scripts, CDP, HTTP and login import', async () => {
  const f = fixture(), agent = f.addAgent({ owner: true }); await f.turn(agent);
  const { space } = f.access.contextFor(agent);
  for (const args of [{}, { name: 'default' }, { name: 1 }, { name: space, spaceName: 'other' }])
    await assert.rejects(f.execute(agent, 'ego_space_open', args), { code: 'DENIED' });
  assert.equal(f.access.snapshot().busy, false);
  await f.execute(agent, 'ego_space_open', { name: space });
  await f.execute(agent, 'ego_snapshot', { space });
  for (const name of ['ego_script', 'ego_cli', 'ego_js', 'ego_cdp', 'ego_http', 'ego_login_import'])
    await assert.rejects(f.execute(agent, name, { space }), { code: 'DENIED' });
  for (const args of [{}, { space: 'default' }, { space, spaceName: 'other' }])
    await assert.rejects(f.execute(agent, 'ego_fill', args), { code: 'DENIED' });
  await f.turn(agent, 1, 'turn/end');
});

test('owner browser space continues across turns while grants, task IDs and other agent identities stay isolated', async () => {
  const f = fixture(), owner = f.addAgent({ owner: true }), other = f.addAgent({ owner: true });
  await f.turn(owner, 1);
  const first = f.access.contextFor(owner);
  await f.execute(owner, 'ego_space_open', { name: first.browserSpace });
  await f.turn(owner, 1, 'turn/end');
  assert.equal(f.access.snapshot().busy, false);
  await f.turn(owner, 2); await f.turn(other, 1);
  const next = f.access.contextFor(owner), separate = f.access.contextFor(other);
  assert.equal(next.browserSpace, first.browserSpace, 'continue the same real session web task');
  assert.notEqual(next.taskId, first.taskId, 'authorization and lease are still per turn');
  assert.notEqual(separate.browserSpace, first.browserSpace, 'another QQ identity uses a different real Agent');
  assert.equal(f.access.snapshot().busy, false, 'context discovery does not reserve the interface');
  await f.execute(other, 'ego_space_open', { name: separate.browserSpace });
  await assert.rejects(f.execute(owner, 'ego_snapshot', { space: next.browserSpace }), { code: 'DENIED' });
  await f.turn(other, 1, 'turn/end'); await f.turn(owner, 2, 'turn/end');
});

test('valid browser help needs no space or desktop lease, including while a different task is controlling the interface', async () => {
  const f = fixture(), agent = f.addAgent({ owner: true }), other = f.addAgent({ owner: true }), guest = f.addAgent();
  await f.turn(agent); await f.turn(other);
  await f.execute(agent, 'ego_help', { topic: 'overview' });
  assert.equal(f.access.snapshot().busy, false);
  await f.execute(other, 'computer_observe');
  const holder = f.access.snapshot().taskId;
  await f.execute(agent, 'ego_help');
  assert.equal(f.access.snapshot().taskId, holder, 'static help does not steal another task lease');
  await assert.rejects(f.execute(agent, 'ego_help', { topic: 'script' }), { code: 'DENIED' });
  await assert.rejects(f.execute(guest, 'ego_help'), { code: 'DENIED' });
  await f.turn(agent, 1, 'turn/end'); await f.turn(other, 1, 'turn/end');
});

test('explicit probe tasks keep separate spaces even when the same real probe Agent is reused', async () => {
  const f = fixture(), agent = f.addAgent(); let first, second;
  await f.access.runProbe(f.probeCurrent(agent), 'browser', async ({ space }) => { first = space; });
  await f.access.runProbe(f.probeCurrent(agent), 'browser', async ({ space }) => { second = space; });
  assert.notEqual(first, second);
});

test('aborted and forged probe scopes never start any GUI callback', async () => {
  const f = fixture(), agent = f.addAgent(), controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(f.access.runProbe(f.probeCurrent({ ...agent }), 'desktop', async () => { calls++; }));
  await assert.rejects(f.access.runProbe(f.probeCurrent(agent, { signal: controller.signal }), 'desktop', async () => { calls++; }));
  assert.equal(calls, 0); assert.equal(f.access.snapshot().busy, false);
});

test('cancelled probe keeps its lease through the actual tool body and admits only precise owned-space cleanup', async () => {
  const f = fixture(), agent = f.addAgent(), other = f.addAgent({ owner: true }), controller = new AbortController(), pending = gate();
  let authorized = true, space, cleanup = 0;
  const operation = f.access.runProbe(f.probeCurrent(agent, { signal: controller.signal, authorize: () => authorized }), 'browser', async (scope) => {
    space = scope.space;
    await f.execute(agent, 'ego_space_open', { name: space });
    await f.execute(agent, 'ego_fill', { space }, { signal: controller.signal, body: () => pending.promise });
    await assert.rejects(f.execute(agent, 'ego_click', { space }), { code: 'DENIED' });
    await assert.rejects(f.execute(agent, 'ego_space_close', { name: 'other' }), { code: 'DENIED' });
    await f.execute(agent, 'ego_space_close', { name: space, keep: false }, { body: async () => { cleanup++; return success(); } });
  });
  await tick(); controller.abort(); authorized = false; await f.turn(other);
  assert.equal(f.access.snapshot().busy, true);
  await assert.rejects(f.execute(other, 'computer_observe'), { code: 'DENIED' });
  pending.resolve(success());
  await assert.rejects(operation, { code: 'CONTROL_SCOPE_REVOKED' });
  assert.equal(cleanup, 1); assert.equal(f.access.snapshot().busy, false);
});

test('semantic failure is not unknown process cleanup, while explicit cleanup uncertainty protects the desktop', async () => {
  const f = fixture(), agent = f.addAgent();
  await f.access.runProbe(f.probeCurrent(agent), 'desktop', async () => f.execute(agent, 'computer_observe', {}, {
    body: async () => ({ isError: true, error: { info: { code: 'TARGET_NOT_FOUND' } } }) }));
  assert.equal(f.access.snapshot().busy, false);
  const next = f.addAgent();
  await f.access.runProbe(f.probeCurrent(next), 'desktop', async ({ onCleanupUnknown }) => { onCleanupUnknown(); });
  assert.equal(f.access.snapshot().cleanupPending, true);
  assert.equal(f.access.snapshot().busy, true);
  let ran = false;
  await assert.rejects(f.access.runProbe(f.probeCurrent(f.addAgent()), 'desktop', async () => { ran = true; }), { code: 'CONTROL_BUSY' });
  assert.equal(ran, false);
});

test('explicit GUI child waits before start and cancellation of the wait never creates a child or replays work', async () => {
  const f = fixture(), probe = f.addAgent(), parent = f.addAgent({ owner: true }), pending = gate(), controller = new AbortController();
  const first = f.access.runProbe(f.probeCurrent(probe), 'desktop', async () => pending.promise);
  await tick(); let starts = 0;
  const child = f.access.runChild({ parent, taskId: 'dfy-cancelled', signal: controller.signal, capabilities: ['desktop'] }, async () => { starts++; });
  await tick(); controller.abort();
  await assert.rejects(child, { code: 'CONTROL_SCOPE_REVOKED' });
  assert.equal(starts, 0); assert.equal(f.access.snapshot().busy, true);
  pending.resolve(); await first; assert.equal(f.access.snapshot().busy, false);
  await assert.rejects(f.access.runChild({ parent, taskId: 'dfy-cancelled', capabilities: ['desktop'] }, async () => { starts++; }));
  assert.equal(starts, 0);
});

test('reserved child is bound in real creation before tools, and its inherited capability surface excludes secrets and escapes', async () => {
  const f = fixture(), parent = f.addAgent({ owner: true });
  let child, space;
  await f.access.runChild({ parent, taskId: 'dfy-desktop', capabilities: ['desktop'] }, async ({ childId }) => {
    child = f.addAgent({ id: childId, parent }); await f.fire('agent/created', { agent: child });
    const context = f.access.scopeFor(child); space = context.space;
    assert.equal(context.kind, 'child'); assert.equal(context.isOwner, undefined);
    const allow = child.ctx.get('tools').restriction.allow;
    for (const name of ['bash', 'read', 'write', 'edit', 'dafeiyu_memory', 'phone_screenshot', 'qq_send', 'spawn_agent', 'ego_script', 'ego_click'])
      assert.equal(allow.includes(name), false, name);
    assert.equal(allow.includes('structured_output'), false, 'own ending machinery must not be named as inherited');
    assert.equal(allow.includes('dafeiyu_control_context'), true);
    await f.execute(child, 'structured_output', { result: 'fixed fixture' });
    await f.execute(child, 'skill', { name: 'dsh-computer-use' });
    await assert.rejects(f.execute(child, 'skill', { name: 'other' }), { code: 'DENIED' });
    await assert.rejects(f.execute(child, 'bash', { command: 'no' }), { code: 'DENIED' });
    await assert.rejects(f.execute(child, 'ego_click', { space }), { code: 'DENIED' });
    await f.execute(child, 'computer_observe'); await f.execute(child, 'computer_click');
    f.registry.delete(child.id); // exact activation disposer may unregister before returning
  });
  assert.equal(f.access.scopeFor(child), null); assert.equal(f.access.snapshot().busy, false);
});

test('browser child cannot load desktop or arbitrary Skills, even through new own-scope registrations', async () => {
  const f = fixture(), parent = f.addAgent({ owner: true });
  await f.access.runChild({ parent, taskId: 'dfy-browser', capabilities: ['browser'] }, async ({ childId, space }) => {
    const child = f.addAgent({ id: childId, parent }); await f.fire('agent/created', { agent: child });
    const allowed = child.ctx.get('tools').restriction.allow;
    assert.equal(allowed.includes('ego_upload'), false); assert.equal(allowed.includes('ego_download'), false);
    // execute intentionally does not simulate the inherited restriction here:
    // own-layer tools bypass it in the host, so the global guard must deny too.
    for (const name of ['skill', 'computer_observe', 'unrelated', 'ego_js', 'ego_cdp', 'ego_upload', 'ego_download'])
      await assert.rejects(f.execute(child, name, { name: 'dsh-computer-use', space }), { code: 'DENIED' });
    await f.execute(child, 'ego_help', { topic: 'overview' });
    await f.execute(child, 'ego_space_open', { name: space }); await f.execute(child, 'ego_snapshot', { space });
  });
});

test('a GUI child inheriting PTC gets native scoped presentation before its loop without altering its parent or admitting run_code', async () => {
  const f = fixture(), parent = f.addAgent({ owner: true, mode: 'ptc' });
  assert.deepEqual(parent.ctx.get('tools').wireSchemas().schemas.map((item) => item.name), ['run_code']);
  await f.access.runChild({ parent, taskId: 'dfy-ptc-child', capabilities: ['browser'] }, async ({ childId, space }) => {
    const child = f.addAgent({ id: childId, parent }), tools = child.ctx.get('tools');
    assert.equal(tools.modeFor(child), 'ptc');
    await f.fire('agent/created', { agent: child });
    assert.equal(tools.modeFor(child), 'native');
    assert.equal(parent.ctx.get('tools').modeFor(parent), 'ptc');
    assert.equal(tools.wireSchemas(child).schemas.some((item) => item.name === 'ego_space_open'), true);
    assert.equal(tools.restriction.allow.includes('run_code'), false);
    await assert.rejects(f.execute(child, 'run_code', { code: 'unused fixture' }), { code: 'DENIED' });
    await f.execute(child, 'ego_space_open', { name: space });
  });
});

test('conflicting child-owned PTC mode or missing scoped presentation API fails before any GUI tool can run', async () => {
  for (const scenario of ['conflict', 'missing-api']) {
    const f = fixture(), parent = f.addAgent({ owner: true, mode: 'ptc' }); let body = 0;
    await assert.rejects(f.access.runChild({ parent, taskId: 'dfy-ptc-' + scenario, capabilities: ['desktop'] }, async ({ childId }) => {
      const child = f.addAgent({ id: childId, parent, ...(scenario === 'conflict' ? { ownMode: 'ptc' } : {}) });
      if (scenario === 'missing-api') child.ctx.get('tools').presentAs = undefined;
      await f.fire('agent/created', { agent: child });
      await f.execute(child, 'computer_observe', {}, { body: async () => { body++; return success(); } });
    }));
    assert.equal(body, 0); assert.equal(parent.ctx.get('tools').modeFor(parent), 'ptc');
    assert.equal(f.access.snapshot().busy, false);
  }
});

test('a copied child id or durable parent header cannot impersonate the reserved runtime child', async () => {
  const f = fixture(), parent = f.addAgent({ owner: true }), foreign = f.addAgent();
  await assert.rejects(f.access.runChild({ parent, taskId: 'dfy-forged', capabilities: ['desktop'] }, async ({ childId }) => {
    const child = f.addAgent({ id: childId, parent: foreign });
    child.session.header = { parentSession: parent.id };
    await f.fire('agent/created', { agent: child });
  }), { code: 'CONTROL_CHILD_UNCONFIRMED' });
  assert.equal(f.access.snapshot().busy, false);
});

test('runtime replacement revokes late tool calls and final probe success without releasing a still-live body early', async () => {
  const f = fixture(), agent = f.addAgent(), pending = gate();
  const operation = f.access.runProbe(f.probeCurrent(agent), 'desktop', async () => {
    await f.execute(agent, 'computer_observe', {}, { body: () => pending.promise });
    await assert.rejects(f.execute(agent, 'computer_click'), { code: 'DENIED' });
  });
  await tick(); f.changeRuntime(); assert.equal(f.access.snapshot().busy, true);
  pending.resolve(success()); await assert.rejects(operation, { code: 'CONTROL_SCOPE_REVOKED' });
  assert.equal(f.access.snapshot().busy, false);
});

test('the same explicit task grant cannot execute its callback twice, including after completion', async () => {
  const f = fixture(), agent = f.addAgent({ owner: true }), pending = gate();
  const grant = f.access.bindOwner({ agent, taskId: 'once', capabilities: ['desktop'] }); let count = 0;
  const first = f.access.withLease(grant, 'desktop', async () => { count++; await pending.promise; return 'receipt'; });
  const second = f.access.withLease(grant, 'desktop', async () => { count++; });
  pending.resolve(); assert.equal(await first, 'receipt'); assert.equal(await second, 'receipt');
  assert.equal(await f.access.withLease(grant, 'desktop', async () => { count++; }), 'receipt');
  assert.equal(count, 1);
});

test('module disposal waits for actual callback and tool settlement before removing its global guard', async () => {
  const f = fixture(), agent = f.addAgent(), pending = gate();
  const operation = f.access.runProbe(f.probeCurrent(agent), 'desktop', async () => f.execute(agent, 'computer_observe', {}, { body: () => pending.promise }));
  await tick(); let disposed = false;
  const disposal = f.access.dispose().then(() => { disposed = true; });
  await tick(); assert.equal(disposed, false); assert.equal(f.guards.length, 1); assert.equal(f.access.snapshot().busy, true);
  pending.resolve(success()); await assert.rejects(operation, { code: 'CONTROL_SCOPE_REVOKED' }); await disposal;
  assert.equal(disposed, true); assert.equal(f.guards.length, 0); assert.equal(f.access.snapshot().busy, false);
});

test('disposal also awaits an automatic owner turn body without mistaking its missing explicit task promise for quiescence', async () => {
  const f = fixture(), agent = f.addAgent({ owner: true }), pending = gate(); await f.turn(agent);
  const operation = f.execute(agent, 'computer_observe', {}, { body: () => pending.promise });
  await tick(); let ended = false;
  const disposal = f.access.dispose().then(() => { ended = true; });
  await tick(); assert.equal(ended, false); assert.equal(f.access.snapshot().inflight, 1); assert.equal(f.guards.length, 1);
  pending.resolve(success()); await operation; await disposal;
  assert.equal(ended, true); assert.equal(f.access.snapshot().busy, false); assert.equal(f.guards.length, 0);
});

test('actual native adapter reserves and binds only explicit GUI children and holds through result plus exact disposal', async () => {
  const f = fixture(), parent = f.addAgent({ owner: true }), cleanup = gate();
  parent.options = { provider: 'host', model: 'model' }; parent.session.header = { delegationDepth: 0 };
  const starts = []; let child, disposed = false;
  f.services.subagents = { getProvider: () => ({ capabilities: { agentOptions: true, depthLimit: true }, prepareContinuable() {} }),
    async startActivation(spec) {
      starts.push(spec); child = f.addAgent({ id: spec.childId || 'uncontrolled-child', parent });
      await f.fire('agent/created', { agent: child });
      if (spec.childId) { assert.equal(f.access.scopeFor(child).kind, 'child'); await f.execute(child, 'computer_observe'); }
      else { assert.equal(f.access.scopeFor(child), null); await assert.rejects(f.execute(child, 'computer_observe'), { code: 'DENIED' }); }
      return { childId: child.id, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'confirmed' }] }),
        async dispose() { disposed = true; await cleanup.promise; f.registry.delete(child.id); } };
    } };
  const executor = createNativeTaskExecutor({ ctx: f.ctx, controlAccess: f.access });
  const operation = executor.run({ id: 'dfy-native-gui', parent, prompt: 'fixed task', control: 'desktop' });
  await tick(); assert.equal(starts.length, 1); assert.match(starts[0].childId, /^dafeiyu-control:/);
  assert.equal(starts[0].delivery, 'caller'); assert.equal(disposed, true); assert.equal(f.access.snapshot().busy, true);
  assert.match(starts[0].request.prompt[0].text, /dafeiyu_control_context/);
  cleanup.resolve(); assert.deepEqual(await operation, { status: 'succeeded', executor: 'spawn', text: 'confirmed' });
  assert.equal(f.access.snapshot().busy, false);
  assert.equal((await executor.run({ id: 'dfy-native-ordinary', parent, prompt: 'ordinary code task' })).status, 'succeeded');
  assert.equal(starts[1].childId, undefined); assert.equal(f.access.snapshot().busy, false);
});

test('native child teardown uncertainty protects the GUI lease and returns unknown without a replacement activation', async () => {
  const f = fixture(), parent = f.addAgent({ owner: true }); let starts = 0;
  parent.options = { provider: 'host', model: 'model' };
  f.services.subagents = { getProvider: () => ({ capabilities: { agentOptions: true }, prepareContinuable() {} }),
    async startActivation(spec) {
      starts++; const child = f.addAgent({ id: spec.childId, parent }); await f.fire('agent/created', { agent: child });
      return { childId: child.id, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'unproven' }] }),
        async dispose() { throw new Error('fixture cleanup unknown'); } };
    } };
  const executor = createNativeTaskExecutor({ ctx: f.ctx, controlAccess: f.access });
  assert.deepEqual(await executor.run({ id: 'dfy-native-unknown', parent, prompt: 'fixed task', control: 'desktop' }),
    { status: 'unknown', executor: 'spawn', errorCode: 'cleanup-unconfirmed' });
  assert.equal(starts, 1); assert.equal(f.access.snapshot().cleanupPending, true);
});

test('native account autonomy leases admit only its private Douyin tool and exact stop cleanup', async () => {
  const f = fixture(), agent = f.addAgent(), other = f.addAgent(); let allowed = true;
  await assert.rejects(f.execute(agent, 'dafeiyu_autonomous_douyin', { action: 'open' }), { code: 'DENIED' });
  await f.access.runAutonomousAccount({ agent, taskId: 'auto-native-account', platform: 'douyin', authorize: () => allowed }, async grant => {
    await f.execute(agent, 'dafeiyu_autonomous_douyin', { action: 'open' });
    for (const [name, args] of [['ego_space_open', {}], ['ego_snapshot', {}], ['dafeiyu_social_browse', {}], ['dafeiyu_autonomous_douyin', { action: 'open', platform: 'bilibili' }]])
      await assert.rejects(f.execute(agent, name, args), { code: 'DENIED' });
    await assert.rejects(f.execute(other, 'dafeiyu_autonomous_douyin', { action: 'open' }), { code: 'DENIED' });
    allowed = false;
    await assert.rejects(f.execute(agent, 'dafeiyu_autonomous_douyin', { action: 'current' }), { code: 'DENIED' });
    grant.assertCleanupAuthorized(); await f.execute(agent, 'dafeiyu_autonomous_douyin', { action: 'stop' });
    allowed = true;
  });
  assert.equal(f.access.snapshot().busy, false);
  await assert.rejects(f.access.runAutonomousAccount({ agent, taskId: 'auto-wrong-platform', platform: 'bilibili', authorize: () => true }, () => assert.fail('must not dispatch')), { code: 'CONTROL_OWNER_REQUIRED' });
});
