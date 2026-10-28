import { createHash, randomUUID } from 'node:crypto';

const CAPABILITIES = new Set(['desktop', 'browser']);
const EGO_ACTIONS = new Set(['ego_space_open', 'ego_space_close', 'ego_snapshot', 'ego_navigate', 'ego_click', 'ego_fill',
  'ego_screenshot', 'ego_page_info', 'ego_wait', 'ego_wait_for_selector', 'ego_wait_for_url', 'ego_key', 'ego_hover',
  'ego_read_element', 'ego_select', 'ego_drag', 'ego_scroll', 'ego_upload', 'ego_download', 'ego_check', 'ego_dialog']);
const OBSERVATIONS = new Set(['computer_use_activate', 'computer_list_apps', 'computer_observe', 'ego_space_open',
  'ego_snapshot', 'ego_page_info', 'ego_screenshot']);
const fail = (code) => Object.assign(new Error(code), { code });
const permitted = (check) => { try { return check() === true; } catch { return false; } };
const validTask = (id) => typeof id === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(id);

/** Only the selected DSH plugins, never arbitrary shell/JS, are this guard's surface. */
export function controlToolKind(name) {
  if (typeof name !== 'string') return null;
  if (name.startsWith('computer_')) return 'desktop';
  if (name.startsWith('ego_') || name === 'dafeiyu_autonomous_douyin') return 'browser';
  return null;
}

/** Task-local GUI authority. This never changes owner identity or memory access.
 *
 * Installed host contract: monotonic tools.guard runs after pre-execute;
 * tools/execute awaits the actual body; tools/result observers are NOT awaited.
 * agent/created is serial, before the factory starts the loop. Reserved local
 * child IDs plus agents.isOwnedBy bind a grant before any child model/tool call.
 */
export function createControlAccess({ ctx, getRuntime, resolveOwner = () => false, classifyTool = controlToolKind } = {}) {
  let closed = false, attached = false, active = null;
  const grants = new WeakMap(), handles = new WeakMap(), turns = new WeakMap(), executions = new WeakMap(), ownerSpaces = new WeakMap(), reservations = new Map();
  const states = new Set(), tasks = new Map(), pendingBodies = new Set(), stops = [], waiting = [];
  // Only code-owned bounded readers receive these ephemeral dispatch proofs.
  // No tool/schema exposes registration or arbitrary script authority to a model.
  const trustedReads = new Map(), ownedReadSpaces = new Map();
  const readDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const agents = () => ctx?.get?.('agents');
  const real = (agent) => Boolean(agent && typeof agent.id === 'string' && agent.session?.id === agent.id
    && typeof agent.ctx?.get === 'function' && agents()?.get?.(agent.id) === agent);
  const owner = (agent) => real(agent) && permitted(() => {
    const value = resolveOwner(agent); return value === true || value?.isOwner === true;
  });
  const runtime = () => { const value = getRuntime?.(); if (!value || closed) throw fail('CONTROL_UNAVAILABLE'); return value; };
  const kinds = (value = ['desktop', 'browser']) => {
    if (!Array.isArray(value) || !value.length || value.some((id) => !CAPABILITIES.has(id))) throw fail('CONTROL_INVALID_CAPABILITIES');
    return new Set(value);
  };
  function valid(state, { cleanup = false } = {}) {
    if (!state || !states.has(state)) return false;
    if (cleanup) return ['probe', 'autonomous'].includes(state.kind) && active === state && real(state.agent);
    if (closed || state.cancelled || state.controller.signal.aborted || getRuntime?.() !== state.runtime) return false;
    if (state.agent && !real(state.agent)) return false;
    if (state.kind === 'child' && (!owner(state.parent) || state.agent && agents()?.isOwnedBy?.(state.agent.id, state.parent) !== true)) return false;
    if (state.kind === 'owner' && !owner(state.agent)) return false;
    if (['probe', 'autonomous'].includes(state.kind) && !permitted(state.authorize)) return false;
    if (state.kind === 'owner' && state.turn && turns.get(state.agent.session) !== state.turn) return false;
    return true;
  }
  function assert(state, options) { if (!valid(state, options)) throw fail('CONTROL_SCOPE_REVOKED'); }
  function cancel(state) {
    if (!state || state.finished) return;
    state.cancelled = true; state.controller.abort();
    const index = waiting.findIndex((item) => item.state === state);
    if (index >= 0) { const [item] = waiting.splice(index, 1); item.reject(fail('CONTROL_SCOPE_REVOKED')); }
    // A signal never releases a live desktop or discards its task/space proof.
  }
  function finish(state) {
    if (state.finished || state.inflight || state.blocked) return false;
    state.finished = true;
    state.outerSignal?.removeEventListener('abort', state.onAbort);
    if (state.agent && grants.get(state.agent) === state) grants.delete(state.agent);
    if (active === state) active = null;
    reservations.delete(state.childId);
    states.delete(state);
    pump();
    return true;
  }
  function maybeFinish(state) {
    if (state.mode === 'turn' ? state.turnEnded : state.operationSettled) finish(state);
  }
  function make({ kind, agent = null, parent = null, taskId, capabilities, authorize, signal, turn, childId, mode = 'task' }) {
    if (!validTask(taskId) || tasks.has(taskId) || tasks.size >= 4096) throw fail('CONTROL_TASK_CONFLICT');
    if (signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function'
      || typeof signal?.aborted !== 'boolean')) throw fail('CONTROL_INVALID_SIGNAL');
    if (agent && grants.has(agent)) throw fail('CONTROL_AGENT_BUSY');
    let space = 'dafeiyu-task-' + randomUUID();
    if (kind === 'owner' && agent) {
      const previous = ownerSpaces.get(agent);
      if (previous?.session === agent.session) space = previous.space;
      else ownerSpaces.set(agent, { session: agent.session, space });
    }
    const state = { kind, agent, parent, taskId, capabilities: kinds(capabilities), authorize, runtime: runtime(), turn, childId, mode,
      space, controller: new AbortController(), outerSignal: signal,
      cancelled: false, finished: false, blocked: false, inflight: 0, turnEnded: false, operationSettled: false, started: false };
    state.onAbort = () => cancel(state);
    signal?.addEventListener('abort', state.onAbort, { once: true });
    if (signal?.aborted) state.onAbort();
    const handle = Object.freeze({ taskId, kind, ...(childId ? { childId } : {}) });
    state.handle = handle; handles.set(handle, state); tasks.set(taskId, state); states.add(state);
    if (agent) grants.set(agent, state);
    return handle;
  }
  function stateOf(handle) { const state = handles.get(handle); if (!state) throw fail('CONTROL_INVALID_GRANT'); return state; }
  function bindOwner({ agent, taskId, capabilities, signal } = {}) {
    if (!owner(agent)) throw fail('CONTROL_OWNER_REQUIRED');
    return make({ kind: 'owner', agent, taskId, capabilities, signal });
  }
  function bindProbe({ agent, runtime: expected, taskId, authorize, capabilities, signal } = {}) {
    if (!real(agent) || expected !== undefined && expected !== runtime() || !permitted(authorize)) throw fail('CONTROL_OWNER_REQUIRED');
    return make({ kind: 'probe', agent, taskId, authorize, capabilities, signal });
  }
  function reserveChild({ parent, taskId, capabilities, signal } = {}) {
    if (!owner(parent)) throw fail('CONTROL_OWNER_REQUIRED');
    const childId = 'dafeiyu-control:' + randomUUID();
    const handle = make({ kind: 'child', parent, taskId, capabilities, signal, childId });
    reservations.set(childId, stateOf(handle));
    return handle;
  }
  function created({ agent } = {}) {
    const state = reservations.get(agent?.id);
    if (!state) return;
    assert(state);
    if (!real(agent) || agents()?.isOwnedBy?.(agent.id, state.parent) !== true || grants.has(agent)) throw fail('CONTROL_CHILD_UNCONFIRMED');
    const tools = agent.ctx.get('tools');
    if (typeof tools?.schemas !== 'function' || typeof tools?.restrict !== 'function' || typeof tools?.modeFor !== 'function') throw fail('CONTROL_CHILD_UNCONFIRMED');
    // A PTC parent exposes only run_code on the model wire. GUI delegation
    // deliberately denies that general program transport, so this exact child
    // must present its restricted end tools natively before its loop starts.
    // presentAs is scoped; a conflicting own declaration must fail closed.
    if (tools.modeFor(agent) !== 'native') {
      if (typeof tools.presentAs !== 'function') throw fail('CONTROL_CHILD_UNCONFIRMED');
      tools.presentAs('native');
      if (tools.modeFor(agent) !== 'native') throw fail('CONTROL_CHILD_UNCONFIRMED');
    }
    // The host registers structured_output on the child's OWN layer. restrict
    // names only inherited tools; own machinery is already exempt and naming
    // it here is rejected by the real ToolRuntime's restrictableNames check.
    const allow = tools.schemas(agent).map((schema) => schema?.name)
      .filter((name) => name !== 'structured_output' && childToolAllowed({ name }, state, true));
    tools.restrict({ allow });
    state.agent = agent; grants.set(agent, state); reservations.delete(agent.id);
  }
  function spaceFor(handle) {
    const state = stateOf(handle); assert(state);
    if (!state.capabilities.has('browser')) throw fail('CONTROL_CAPABILITY_DENIED');
    return state.space;
  }
  function isCleanup(exec, state) {
    return exec.name === 'ego_space_close' && exec.arguments?.name === state?.space && exec.arguments?.keep !== true;
  }
  function browserArguments(exec, state) {
    if (exec.name === 'ego_help') return exec.arguments?.topic === undefined || exec.arguments.topic === 'overview';
    if (!EGO_ACTIONS.has(exec.name)) return false;
    const args = exec.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const field = exec.name === 'ego_space_open' || exec.name === 'ego_space_close' ? 'name' : 'space';
    if (args[field] !== state.space) return false;
    // A plugin generation may add an alias; never permit conflicting aliases.
    for (const key of ['space', 'spaceName']) if (Object.hasOwn(args, key) && args[key] !== state.space) return false;
    return true;
  }
  function childToolAllowed(exec, state, visibility = false) {
    if (exec.name === 'dafeiyu_control_context' || exec.name === 'structured_output') return true;
    if (exec.name === 'skill') return state.capabilities.has('desktop') && (visibility || exec.arguments?.name === 'dsh-computer-use');
    if (exec.name?.startsWith('computer_')) return state.capabilities.has('desktop');
    // GUI delegation has no filesystem grant. These structured tools accept
    // local upload paths or download destinations/trigger scripts.
    return state.capabilities.has('browser') && !['ego_upload', 'ego_download'].includes(exec.name)
      && (EGO_ACTIONS.has(exec.name) || exec.name === 'ego_help');
  }
  function autoOwner(agent) {
    if (!owner(agent)) return null;
    const turn = turns.get(agent.session);
    if (!turn || turn.ended) return null;
    try {
      const handle = make({ kind: 'owner', agent, taskId: 'turn:' + randomUUID(), turn, mode: 'turn' });
      return stateOf(handle);
    } catch { return null; }
  }
  function guard(exec) {
    const prepared = exec && typeof exec === 'object' ? executions.get(exec) : undefined;
    let state = prepared || grants.get(exec?.agent);
    if (prepared && grants.get(exec.agent) !== prepared) return '此前回合已结束，此操作不会移交给新回合执行';
    if (exec?.name === 'dafeiyu_autonomous_douyin') {
      const args = exec.arguments, cleanup = args?.action === 'stop', interacting = ['like', 'follow', 'comment'].includes(args?.action);
      const targetsCurrent = interacting || args?.action === 'next';
      if (!state || state.kind !== 'autonomous' || state.accountPlatform !== 'douyin' || active !== state
        || !valid(state, { cleanup }) || state.blocked && !cleanup || exec.signal?.aborted
        || !args || Object.keys(args).some(key => !['action', 'expectedVideoId', 'text'].includes(key))
        || !['open', 'current', 'next', 'stop', 'history', 'like', 'follow', 'comment'].includes(args.action)
        || targetsCurrent && typeof args.expectedVideoId !== 'string' || !targetsCurrent && args.expectedVideoId !== undefined
        || (args.action === 'comment' ? typeof args.text !== 'string' || !args.text.trim() || args.text.length > 500 || /[\x00-\x1f\x7f]/.test(args.text) : args.text !== undefined)
        || interacting && !permitted(() => state.interactionAllowed?.(args.action))) return '当前抖音自主活动没有这项读取或互动权限';
      executions.set(exec, state); return;
    }
    if (state?.accountPlatform) return '当前自主活动不能调用通用浏览器或其他工具';

    if (state?.kind === 'child' && (!valid(state) || !childToolAllowed(exec, state))) return '子任务仅获明确的界面权限，不能调用终端、文件、私人资料或其他技能';
    if (state?.kind === 'autonomous' && !isCleanup(exec, state)) {
      if (!valid(state) || !['dafeiyu_control_context', 'ego_space_open', 'ego_space_close', 'ego_snapshot', 'ego_navigate', 'ego_page_info', 'ego_scroll', 'ego_read_element', 'ego_wait'].includes(exec?.name)) return '自主浏览仅允许指定平台的读取、导航和滚动';
      if (['ego_space_open', 'ego_navigate'].includes(exec.name)) {
        try { const url = new URL(exec.arguments?.url || 'about:blank');
          if (url.href !== 'about:blank' && (url.protocol !== 'https:' || !state.hosts.includes(url.hostname))) return '自主浏览目标不在已授权平台内';
        } catch { return '自主浏览目标无效'; }
      }
    }
    const kind = classifyTool(exec?.name);
    if (!CAPABILITIES.has(kind)) return;
    const trusted = exec?.name === 'ego_script' ? trustedReads.get(exec.callId) : null;
    const exactRead = trusted && trusted.agent === exec.agent && trusted.state === state
      && (!trusted.exec || trusted.exec === exec) && readDigest(exec.arguments) === trusted.digest
      && (trusted.cleanup ? active === state && real(exec.agent) && ownedReadSpaces.get(trusted.space) === state
        : valid(state) && !state.turn?.ended && ['owner', 'probe'].includes(state.kind) && state.capabilities.has('browser'));
    if (trusted && !exactRead) return '本次固定浏览读取的执行凭证不匹配';
    if (exactRead) {
      if (exec.signal?.aborted || active && active !== state || state.blocked && !trusted.cleanup) return '固定浏览读取已取消或仍有未确认清理';
      if (!active) active = state;
      trusted.exec = exec; executions.set(exec, state); return;
    }
    if (!state) state = autoOwner(exec?.agent);
    const cleanup = state && isCleanup(exec, state) && valid(state, { cleanup: true });
    if (!cleanup && (!valid(state) || !state.capabilities.has(kind))) return '当前会话没有此任务的电脑或浏览器控制权限';
    if (exec?.signal?.aborted) return '当前界面操作已取消';
    if (kind === 'browser' && !browserArguments(exec, state)) return '仅允许当前任务的明确浏览器空间；脚本、CLI、原始 CDP 和共享默认空间不可用';
    if (exec.name === 'ego_help') {
      // Package-owned static guidance cannot inspect or act on a browser space.
      // Bind the prepared call to this grant, but do not acquire a GUI lease.
      if (exec && typeof exec === 'object') executions.set(exec, state);
      return;
    }
    if (state.blocked && !cleanup) return '此前界面执行的清理尚未确认，暂停后续操作';
    if (active && active !== state) return '电脑界面正在由另一个任务使用，请待其完成后再操作';
    if (!active) {
      if (!OBSERVATIONS.has(exec.name)) return '请先在当前任务观察目标界面，再执行操作';
      active = state;
    }
    if (exec && typeof exec === 'object') executions.set(exec, state);
  }
  async function around(exec, next) {
    const kind = classifyTool(exec?.name);
    if (!CAPABILITIES.has(kind)) return next();
    const denial = guard(exec);
    if (denial) throw fail('CONTROL_DISPATCH_DENIED');
    const state = grants.get(exec.agent);
    const trusted = exec.name === 'ego_script' ? trustedReads.get(exec.callId) : null;
    if (trusted?.entered) throw fail('CONTROL_DISPATCH_REPLAY');
    if (trusted) trusted.entered = true;
    let settled;
    const completion = new Promise((resolve) => { settled = resolve; });
    pendingBodies.add(completion);
    state.inflight++;
    try { return await next(); }
    catch (error) { if (['CONTROL_CLEANUP_UNCONFIRMED', 'cleanup-unconfirmed'].includes(error?.code)) state.blocked = true; throw error; }
    finally {
      state.inflight--; pendingBodies.delete(completion); settled();
      if (closed && state.mode === 'turn') state.turnEnded = true;
      maybeFinish(state);
    }
  }
  function sessionEvent(session, event) {
    const number = event?.data?.turn;
    if (!session || !Number.isSafeInteger(number) || number < 0) return;
    if (event.type === 'turn/start') {
      const previous = turns.get(session);
      // Never let a duplicate persisted event remint the same live turn.
      if (previous && previous.number === number && previous.seq === event.seq) return;
      turns.set(session, { number, seq: event.seq, ended: false });
    } else if (event.type === 'turn/end') {
      const turn = turns.get(session);
      if (!turn || turn.number !== number) return;
      turn.ended = true;
      for (const state of states) if (state.mode === 'turn' && state.agent?.session === session && state.turn === turn) {
        state.turnEnded = true; maybeFinish(state);
      }
    }
  }
  function attach() {
    if (attached) return;
    if (closed || typeof ctx?.get?.('tools')?.guard !== 'function' || typeof ctx?.on !== 'function') throw fail('CONTROL_HOST_UNAVAILABLE');
    attached = true;
    stops.push(ctx.get('tools').guard(guard), ctx.on('tools/execute', around, { global: true }),
      ctx.on('session/event', sessionEvent, { global: true }), ctx.on('agent/created', created, { global: true }));
  }
  function withLease(handle, capability, operation) {
    const state = stateOf(handle);
    if (!CAPABILITIES.has(capability) || !state.capabilities.has(capability) || typeof operation !== 'function') return Promise.reject(fail('CONTROL_CAPABILITY_DENIED'));
    if (state.started) return state.promise;
    try { assert(state); if (active && active !== state) throw fail('CONTROL_BUSY'); }
    catch (error) { return Promise.reject(error); }
    state.started = true; active = state;
    state.promise = operate(state, operation);
    return state.promise;
  }
  function pump() {
    if (active || !waiting.length) return;
    const item = waiting.shift();
    try { assert(item.state); active = item.state; item.resolve(); }
    catch (error) { item.reject(error); pump(); }
  }
  function waitLease(state) {
    assert(state);
    if (!active) { active = state; return Promise.resolve(); }
    if (active === state) return Promise.resolve();
    if (waiting.length >= 32) return Promise.reject(fail('CONTROL_BUSY'));
    return new Promise((resolve, reject) => waiting.push({ state, resolve, reject }));
  }
  async function operate(state, operation) {
    try {
      assert(state);
      const result = await operation({ space: state.space, childId: state.childId, signal: state.controller.signal,
        assertAuthorized: () => assert(state), onCleanupUnknown: () => { state.blocked = true; } });
      // Child disposal deliberately removes that exact Agent from the registry.
      // Its parent/runtime still must be current; a completed cleanup is not a
      // reason to revive the disposed child's authority.
      if (state.kind === 'child') {
        if (closed || state.cancelled || state.controller.signal.aborted || getRuntime?.() !== state.runtime || !owner(state.parent)) throw fail('CONTROL_SCOPE_REVOKED');
      } else assert(state);
      return result;
    } finally { state.operationSettled = true; maybeFinish(state); }
  }
  async function runProbe(current, id, operation) {
    if (!CAPABILITIES.has(id)) throw fail('CONTROL_CAPABILITY_DENIED');
    const grant = bindProbe({ ...current, taskId: 'probe:' + id + ':' + randomUUID(), capabilities: [id] });
    return withLease(grant, id, operation);
  }
  async function runChild({ parent, taskId, signal, capabilities } = {}, operation) {
    if (typeof operation !== 'function') throw fail('CONTROL_INVALID_OPERATION');
    const handle = reserveChild({ parent, taskId, signal, capabilities });
    const state = stateOf(handle);
    state.started = true;
    // Only explicitly marked GUI tasks use this entry point. Wait before
    // startActivation, then hold through its actual result and receipt disposal.
    state.promise = (async () => {
      try { await waitLease(state); return await operate(state, operation); }
      finally { state.operationSettled = true; maybeFinish(state); }
    })();
    return state.promise;
  }
  async function runAutonomous({ agent, taskId, signal, authorize, hosts } = {}, operation) {
    const allowed = ['www.bilibili.com', 'search.bilibili.com', 'www.douyin.com'];
    if (!real(agent) || !permitted(authorize) || !Array.isArray(hosts) || !hosts.length || hosts.some((host) => !allowed.includes(host))) throw fail('CONTROL_OWNER_REQUIRED');
    const handle = make({ kind: 'autonomous', agent, taskId, signal, authorize, capabilities: ['browser'] });
    stateOf(handle).hosts = [...hosts];
    return withLease(handle, 'browser', operation);
  }
  async function runAutonomousAccount({ agent, taskId, signal, authorize, platform, interactionAllowed } = {}, operation) {
    if (!real(agent) || !permitted(authorize) || platform !== 'douyin') throw fail('CONTROL_OWNER_REQUIRED');
    const handle = make({ kind: 'autonomous', agent, taskId, signal, authorize, capabilities: ['browser'] });
    const state = stateOf(handle); state.accountPlatform = platform; state.interactionAllowed = interactionAllowed;
    return withLease(handle, 'browser', grant => operation({ ...grant,
      assertCleanupAuthorized: () => { if (!valid(state, { cleanup: true }) || state.finished) throw fail('CONTROL_SCOPE_REVOKED'); } }));
  }
  async function executeTrustedBrowserRead({ agent, space, script, signal, timeoutMs = 60000, cleanup = false } = {}, operation) {
    if (typeof operation !== 'function' || !/^dfy-douyin-[a-f0-9-]{36}$/.test(space || '')
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
      || signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.aborted !== 'boolean')) throw fail('CONTROL_INVALID_OPERATION');
    const state = grants.get(agent) || (!cleanup && autoOwner(agent));
    if (cleanup) {
      if (!state || ownedReadSpaces.get(space) !== state || active !== state || !real(agent)) throw fail('CONTROL_SCOPE_REVOKED');
      // Cleanup is always built here; callers cannot smuggle code into it.
      script = `const done=await taskSpaces.complete(${JSON.stringify(space)},{keep:false});if(!done.done)throw new Error('CLEANUP_UNCONFIRMED');console.log('@@DSH_RESULT@@'+JSON.stringify({ok:true,cleanupConfirmed:true}));`;
    } else {
      assert(state);
      if (!['owner', 'probe'].includes(state.kind) || state.turn?.ended || !state.capabilities.has('browser') || state.blocked
        || state.kind === 'owner' && !owner(agent) || state.kind === 'probe' && !permitted(state.authorize)) throw fail('CONTROL_CAPABILITY_DENIED');
      if (typeof script !== 'string' || !script.length || script.length > 65536 || script.includes('\0') || !script.includes(JSON.stringify(space))) throw fail('CONTROL_INVALID_OPERATION');
      if (ownedReadSpaces.has(space)) throw fail('CONTROL_TASK_CONFLICT');
      if (active && active !== state) throw fail('CONTROL_BUSY');
      ownedReadSpaces.set(space, state);
    }
    if (!active) active = state;
    const callId = 'dfy-trusted-read-' + randomUUID(), args = Object.freeze({ script, timeoutMs });
    const proof = { agent, state, space, cleanup, digest: readDigest(args), exec: null, entered: false };
    trustedReads.set(callId, proof); state.inflight++;
    const controller = new AbortController(), abort = () => controller.abort();
    if (!cleanup) {
      state.controller.signal.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true });
      if (state.controller.signal.aborted || signal?.aborted) abort();
    }
    try {
      const result = await operation({ callId, arguments: args, signal: controller.signal,
        authorize: () => cleanup ? real(agent) && ownedReadSpaces.get(space) === state && active === state : valid(state) && !state.turn?.ended && !controller.signal.aborted,
        onCleanupUnknown: () => { state.blocked = true; } });
      if (!proof.entered) throw fail('CONTROL_DISPATCH_UNCONFIRMED');
      const value = result?.result ?? result?.value ?? result;
      if (result?.ok === true && result.timedOut !== true && result.cancelled !== true && result.executionState !== 'unknown'
        && value?.ok === true && value.cleanupConfirmed === true) {
        ownedReadSpaces.delete(space);
        if (![...ownedReadSpaces.values()].includes(state)) state.blocked = false;
      } else state.blocked = true;
      if (!cleanup) { assert(state); if (state.turn?.ended) throw fail('CONTROL_SCOPE_REVOKED'); }
      return result;
    } catch (error) {
      if (!proof.entered) { ownedReadSpaces.delete(space); error.cleanupConfirmed = true; }
      else if (ownedReadSpaces.get(space) === state) state.blocked = true;
      else error.cleanupConfirmed = true;
      throw error;
    }
    finally {
      trustedReads.delete(callId); state.controller.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort);
      state.inflight--; maybeFinish(state);
    }
  }
  function scopeFor(agent) {
    const state = grants.get(agent) || autoOwner(agent);
    if (!valid(state)) return null;
    return Object.freeze({ kind: state.kind, taskId: state.taskId, capabilities: Object.freeze([...state.capabilities]),
      space: state.space, browserSpace: state.space, leaseBusy: Boolean(active && active !== state) });
  }
  return Object.freeze({ attach, bindOwner, bindProbe, reserveChild, spaceFor, withLease, runProbe, runChild, runAutonomous, runAutonomousAccount, executeTrustedBrowserRead, scopeFor, contextFor: scopeFor,
    cancel(handle) { cancel(stateOf(handle)); },
    snapshot() { return { busy: Boolean(active), cleanupPending: active?.blocked === true,
      taskId: active?.taskId || null, inflight: active?.inflight || 0 }; },
    async dispose() {
      closed = true;
      for (const state of states) {
        cancel(state);
        if (state.mode === 'turn' && state.inflight === 0) { state.turnEnded = true; maybeFinish(state); }
      }
      await Promise.allSettled([...pendingBodies, ...[...states].map((state) => state.promise).filter(Boolean)]);
      if (active) throw fail('CONTROL_CLEANUP_UNCONFIRMED');
      for (const stop of stops.reverse()) if (typeof stop === 'function') stop();
    },
  });
}

export default createControlAccess;
