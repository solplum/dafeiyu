import { randomUUID } from 'node:crypto';

const SKILL = 'dsh-computer-use';
const BUNDLE = 'com.deepseek.dsh';
const INPUT = '大肥鱼电脑控制测试输入';
const BUTTON = '验证电脑输入';
const RESULT = '电脑控制回读：';
const REQUIRED = ['computer_observe', 'computer_click', 'computer_press_key', 'computer_type_text'];
const validPid = (value) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const error = (code) => Object.assign(new Error({ CANCELLED: '能力验证已取消', UNAVAILABLE: '已注册的控制工具不可用',
  UNCONFIRMED: '控制操作结果未确认', ACCESSIBILITY_REQUIRED: '请先授予辅助功能权限',
  DESKTOP_TARGET_UNCONFIRMED: '未确认大肥鱼电脑控制测试框' }[code]), { code });
const service = (ctx, name) => { try { return ctx?.get?.(name); } catch { return undefined; } };
const visible = (tools, name, agent) => { try { return tools?.get?.(name, agent) !== undefined; } catch { return false; } };
const validSignal = (signal) => signal === undefined || typeof signal?.aborted === 'boolean'
  && typeof signal?.addEventListener === 'function' && typeof signal?.removeEventListener === 'function';
function authorized(ctx, agent, signal, authorize) {
  try { return !signal?.aborted && typeof authorize === 'function' && authorize() === true
    && typeof agent?.id === 'string' && agent.id.length > 0 && agent.session?.id === agent.id
    && service(ctx, 'agents')?.get?.(agent.id) === agent; } catch { return false; }
}
function check(options) {
  if (!authorized(options.ctx, options.agent, options.signal, options.authorize)) throw error('CANCELLED');
}
function toolError(result) {
  const code = result?.error?.info?.code;
  if (code === 'UNKNOWN_TOOL') return 'UNAVAILABLE';
  if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') return 'CANCELLED';
  // ComputerUseError is not a HarnessError in DSH 0.2.1-rc.2. Match only its
  // fixed leading code; no provider/UI text or native stderr is returned.
  const message = typeof result?.error?.message === 'string' ? result.error.message.slice(0, 256) : '';
  if (/^COMPUTER_PERMISSION_REQUIRED:/.test(message)) return 'ACCESSIBILITY_REQUIRED';
  if (/^COMPUTER_CANCELLED:/.test(message)) return 'CANCELLED';
  if (/^COMPUTER_(?:APP_NOT_FOUND|STALE_OBSERVATION|ELEMENT_UNAVAILABLE|TARGET_UNAVAILABLE|TARGET_AMBIGUOUS):/.test(message)) return 'DESKTOP_TARGET_UNCONFIRMED';
  return 'UNCONFIRMED';
}

/** Call the real ToolRuntime, including policy/guard/dispatch/finalization.
 * A PTC scope needs its genuine enclosing ToolRunContext, or must use the real
 * run_code transport. This adapter never fabricates a parent or calls a raw
 * ToolDefinition.execute. The caller owns the shared desktop resource lease. */
export async function canonicalToolCall({ ctx, agent, parent, signal, authorize, name, arguments: args = {},
  callId, timeoutMs = 30000, trace } = {}) {
  if (!validSignal(signal) || typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(name)
    || args === null || typeof args !== 'object' || Array.isArray(args)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw error('UNAVAILABLE');
  const options = { ctx, agent, signal, authorize }; check(options);
  const tools = service(ctx, 'tools');
  if (typeof tools?.execute !== 'function' || !visible(tools, name, agent)) throw error('UNAVAILABLE');
  // ToolRuntime owns its lossless JSON snapshot; do not round-trip arguments
  // here and silently turn NaN/undefined into a different request.
  try { const serialized = JSON.stringify(args); if (serialized.length > 1024 * 1024) throw new Error(); }
  catch { throw error('UNAVAILABLE'); }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    check(options);
    trace?.({ phase: 'start', name });
    const result = await tools.execute({ name, arguments: args, agent, signal: controller.signal,
      callId: typeof callId === 'string' && callId.length > 0 && callId.length <= 200 ? callId : `dfy-control-${randomUUID()}`,
      ...(parent === undefined ? {} : { parent }) });
    trace?.({ phase: 'result', name, isError: result?.isError, errorCode: result?.error?.info?.code,
      error: result?.isError ? String(result.error?.message || '').slice(0, 768) : undefined });
    check(options);
    if (controller.signal.aborted) throw error(signal?.aborted ? 'CANCELLED' : 'UNCONFIRMED');
    if (result?.isError === true) throw error(toolError(result));
    if (result?.isError !== false || !Object.hasOwn(result, 'value')) throw error('UNCONFIRMED');
    return result.value;
  } catch (cause) {
    check(options);
    if (controller.signal.aborted) throw error(signal?.aborted ? 'CANCELLED' : 'UNCONFIRMED');
    if (['UNAVAILABLE', 'UNCONFIRMED', 'CANCELLED', 'ACCESSIBILITY_REQUIRED', 'DESKTOP_TARGET_UNCONFIRMED'].includes(cause?.code))
      throw error(cause.code);
    throw error('UNCONFIRMED');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Pure discovery. No Skill load, helper health refresh or app observation. */
export function nativeControlMetadata(ctx, { agent } = {}) {
  const tools = service(ctx, 'tools'), provider = service(ctx, 'computerUse');
  let status;
  try { status = provider?.status?.(); } catch {}
  const present = status?.provider === 'macos-ax';
  const executionVisible = REQUIRED.every((name) => visible(tools, name, agent));
  const activationVisible = visible(tools, 'computer_use_activate', agent);
  const canLoad = visible(tools, 'skill', agent) && activationVisible;
  const accessibilityGranted = status?.accessibility === 'granted' ? true : status?.accessibility === 'denied' ? false : null;
  // A host-level snapshot has no Agent composition. Progressive tools being
  // absent there says nothing about an authorized Agent's ability to load them.
  const callable = typeof tools?.execute === 'function' && (agent === undefined || executionVisible || canLoad);
  const available = !present || !callable || status?.ready === false || accessibilityGranted === false ? false
    : status?.ready === true && accessibilityGranted === true ? true : null;
  return { desktop: { present, available,
    executionVisible, activationVisible, accessibilityGranted,
    screenRecordingGranted: status?.screenRecording === 'granted' ? true : status?.screenRecording === 'denied' ? false : null,
    ...(typeof status?.helperVersion === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(status.helperVersion) ? { version: status.helperVersion } : {}),
    reason: !present ? '未检测到已启用的 Anionex 电脑控制插件' : accessibilityGranted === false
      ? '请在系统设置中允许辅助功能，再验证' : '插件入口已检测，实际输入点击须单独验证' } };
}

function observation(value, pid, windowId) {
  if (!value || value.app?.bundleId !== BUNDLE || !validPid(value.app?.pid) || pid !== undefined && value.app.pid !== pid || typeof value.observationId !== 'string'
    || !value.observationId || value.observationId.length > 256 || !Array.isArray(value.elements) || value.elements.length > 5000
    || value.tree?.mode !== 'full' || typeof value.tree.text !== 'string' || value.tree.text.length > 1024 * 1024
    || value.tree.truncated !== false || !Number.isSafeInteger(value.window?.id) || value.window.id <= 0
    || windowId !== undefined && value.window.id !== windowId) throw error('DESKTOP_TARGET_UNCONFIRMED');
  if (value.permissions?.accessibility !== 'granted') throw error('ACCESSIBILITY_REQUIRED');
  return value;
}
function element(observed, label, roles) {
  const matches = observed.elements.filter((item) => roles.includes(item?.role) && (item.label === label || item.title === label));
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].index) || matches[0].index < 0 || matches[0].enabled === false)
    throw error('DESKTOP_TARGET_UNCONFIRMED');
  return matches[0];
}
const hasResult = (observed, nonce) => observed.elements.some((item) => [item?.title, item?.label, item?.value].includes(RESULT + nonce));

/** The only editable surface is the fixed test field in the exact DSH process.
 * No screenshots, caller-supplied coordinates, app launch, clipboard or model
 * calls. Only the input's exact observed AX element may use targeted fallback. */
export async function probeNativeDesktop({ ctx, agent, parent, signal, authorize, nonce, pid, trace } = {}) {
  if (typeof nonce !== 'string' || !/^DFY-CAP-[a-f0-9]{24}$/.test(nonce) || pid !== undefined && !validPid(pid))
    throw error('UNAVAILABLE');
  const options = { ctx, agent, parent, signal, authorize, trace };
  check(options);
  const call = (name, args) => canonicalToolCall({ ...options, name, arguments: args });
  const tools = service(ctx, 'tools');
  if (!REQUIRED.every((name) => visible(tools, name, agent))) {
    // dsh-tool-skill performs the actual scoped skills.list/get lookup; the
    // upstream tools/result listener registers execution tools on this Agent.
    const loaded = await call('skill', { name: SKILL });
    if (loaded?.name !== SKILL || typeof loaded.content !== 'string' || !loaded.content.trim()) throw error('UNAVAILABLE');
    check(options);
    if (!REQUIRED.every((name) => visible(tools, name, agent))) throw error('UNAVAILABLE');
  }
  // The plugin's Node host can have a different PID from its Electron GUI.
  // Let the native provider uniquely resolve this bundle, then bind every
  // subsequent observation to the returned exact PID. Never guess a parent PID
  // or enumerate unrelated applications to discover this one known target.
  let selectedPid = pid;
  const observe = async (windowId) => {
    const value = observation(await call('computer_observe', {
      app: { bundleId: BUNDLE, ...(selectedPid === undefined ? {} : { pid: selectedPid }) }, full: true, screenshot: 'none',
    }), selectedPid, windowId);
    selectedPid ??= value.app.pid;
    return value;
  };
  const before = await observe();
  const input = element(before, INPUT, ['AXTextField', 'AXTextArea', 'AXSearchField']);
  element(before, BUTTON, ['AXButton']);
  if (hasResult(before, nonce)) throw error('DESKTOP_TARGET_UNCONFIRMED');
  await call('computer_click', { observationId: before.observationId, elementIndex: input.index, allowCoordinateFallback: true });
  const focused = await observe(before.window.id);
  if (element(focused, INPUT, ['AXTextField', 'AXTextArea', 'AXSearchField']).focused !== true) throw error('DESKTOP_TARGET_UNCONFIRMED');
  await call('computer_press_key', { observationId: focused.observationId, key: 'a', modifiers: ['command'] });
  const selected = await observe(before.window.id);
  if (element(selected, INPUT, ['AXTextField', 'AXTextArea', 'AXSearchField']).focused !== true) throw error('DESKTOP_TARGET_UNCONFIRMED');
  await call('computer_type_text', { observationId: selected.observationId, text: nonce });
  const entered = await observe(before.window.id);
  if (element(entered, INPUT, ['AXTextField', 'AXTextArea', 'AXSearchField']).value !== nonce) throw error('UNCONFIRMED');
  const button = element(entered, BUTTON, ['AXButton']);
  await call('computer_click', { observationId: entered.observationId, elementIndex: button.index, allowCoordinateFallback: false });
  const after = await observe(before.window.id);
  if (!hasResult(after, nonce)) throw error('UNCONFIRMED');
  check(options);
  return { ok: true, evidence: { kind: 'readback', matched: true, backend: '@anionex/dsh-computer-use', scope: 'dsh-window' } };
}
