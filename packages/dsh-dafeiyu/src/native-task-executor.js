import path from 'node:path';
import { randomUUID } from 'node:crypto';

const providerName = (value) => value === 'native' ? 'spawn' : value;
const routeKeys = ['provider', 'model', 'reasoningEffort'];
const safeDepth = (value) => value === undefined || Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const isPromise = (value) => value && typeof value.then === 'function';
const CODEX_STAGES = new Set(['initialize', 'thread-start', 'turn-start', 'turn', 'teardown', 'process']);
const CODEX_CATEGORIES = new Set(['unknown', 'transport', 'product-error', 'limit', 'service', 'access-policy', 'invalid-result', 'process']);
const CONTEXT_FAILURES = Object.freeze({ CONTEXT_CAPACITY_REQUIRED: 'context-required',
  CONTEXT_COMPACTION_FAILED: 'context-compaction-failed', CONTEXT_GUARD_UNAVAILABLE: 'context-guard-unavailable' });
// Only the installed Codex provider's fixed failure-facts line is accepted.
// Provider messages, process details and any following permission diagnostic
// are deliberately not returned, even when a recognized facts line precedes them.
function codexDiagnosticFacts(value) {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  const first = value.split('\n', 1)[0];
  const match = /^Product subagent failure \(product: Codex; stage: ([a-z-]+); category: ([a-z-]+)(?:; HTTP status: ([0-9]{1,5}))?(?:; exit code: -?[0-9]{1,10})?(?:; signal: SIG[A-Z0-9]{1,24})?\)$/.exec(first);
  if (!match || !CODEX_STAGES.has(match[1]) || !CODEX_CATEGORIES.has(match[2])) return undefined;
  const httpStatus = match[3] === undefined ? undefined : Number(match[3]);
  // This matches numericHttpStatus() in the installed provider, including a
  // transport's zero status, without accepting strings or arbitrary metadata.
  if (httpStatus !== undefined && (!Number.isInteger(httpStatus) || httpStatus > 65535)) return undefined;
  return { stage: match[1], category: match[2], ...(httpStatus === undefined ? {} : { httpStatus }) };
}
function codexFailureCode(facts) {
  if (!facts) return 'execution';
  if (facts.httpStatus === 401) return 'login-required';
  if (facts.httpStatus === 403) return 'access-policy';
  if (facts.httpStatus === 429 || facts.category === 'limit') return 'quota';
  if (facts.category === 'access-policy') return 'access-policy';
  if (facts.category === 'service' || facts.httpStatus >= 500 && facts.httpStatus <= 599) return 'service';
  if (facts.category === 'transport') return 'transport';
  if (facts.category === 'product-error') return 'product-error';
  if (facts.category === 'invalid-result') return 'no-result';
  return 'execution';
}
const outputText = (output) => {
  if (!Array.isArray(output) || output.some((part) => part?.type === 'tool-call' || part?.type === 'tool-result')) return null;
  const text = output.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n').trim();
  return text.length <= 64000 ? text : null;
};

/** Actual DSH subagent service adapter. The caller owns the job and its signal;
 * no parent inbox delivery, direct CLI spawning, or QQ sending occurs here. */
export function createNativeTaskExecutor({ ctx, provider = 'spawn', controlAccess, tokenBudget, contextGuard } = {}) {
  const executor = providerName(provider);
  const outcome = (status, errorCode, text, diagnosticFacts) => ({ status, executor,
    ...(errorCode ? { errorCode } : {}), ...(typeof text === 'string' ? { text } : {}),
    ...(diagnosticFacts ? { diagnosticFacts } : {}) });
  const service = (name) => typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  const resolve = () => {
    if (typeof executor !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(executor)) return null;
    const subagents = service('subagents');
    if (typeof subagents?.startActivation !== 'function' || typeof subagents?.getProvider !== 'function') return null;
    const selected = subagents.getProvider(executor);
    return selected && (typeof selected.start === 'function' || typeof selected.prepareContinuable === 'function')
      ? { subagents, selected } : null;
  };

  const runNative = async ({ id, prompt, cwd, parent, signal, onProgress, childId, onCleanupUnknown, scope } = {}) => {
      if (typeof id !== 'string' || !id.trim() || id.length > 160 || typeof prompt !== 'string' || !prompt.trim()
        || prompt.length > 64000 || cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0'))
        || signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function'
          || typeof signal.aborted !== 'boolean')) return outcome('failed', 'invalid-input');
      if (signal?.aborted) return outcome('cancelled', 'cancelled');
      let resolved;
      try {
        resolved = resolve();
        if (!resolved) return outcome('failed', 'unavailable');
        if (!parent || typeof parent.id !== 'string' || parent.session?.id !== parent.id
          || service('agents')?.get?.(parent.id) !== parent) return outcome('failed', 'parent-unavailable');
      } catch { return outcome('failed', 'unavailable'); }

      const { subagents, selected } = resolved;
      const meterLocalChild = tokenBudget && executor === 'spawn';
      if (meterLocalChild && (typeof selected.prepareContinuable !== 'function'
        || !/^[1-9]\d{0,19}$/.test(scope?.peerId || '') || !/^[A-Za-z0-9_-]{1,48}$/.test(scope?.identityId || '')))
        return outcome('failed', 'usage-unavailable');
      const request = { parent, prompt: [{ type: 'text', text: prompt }], ...(cwd === undefined ? {} : { cwd }) };
      try {
        if (selected.capabilities?.depthLimit === true) {
          const persisted = parent.session.header?.delegationDepth, runtime = parent.options?.subagentDepth;
          if (!safeDepth(persisted) || !safeDepth(runtime)) return outcome('failed', 'invalid-parent-depth');
          const depth = Math.max(persisted ?? 0, runtime ?? 0) + 1;
          if (!Number.isSafeInteger(depth)) return outcome('failed', 'invalid-parent-depth');
          request.maxDepth = depth;
        }
        if (selected.capabilities?.agentOptions === true) {
          const current = parent.session.requestHeader?.()?.config;
          const route = current ?? parent.options;
          if (typeof route?.provider !== 'string' || !route.provider || typeof route?.model !== 'string' || !route.model)
            return outcome('failed', 'model-unavailable');
          request.agentOptions = Object.fromEntries(routeKeys.filter((key) => route[key] !== undefined).map((key) => [key, route[key]]));
        }
      } catch { return outcome('failed', 'invalid-parent'); }

      // This controller deliberately does not use the parent turn's cancellation
      // signal. Only this independent job's supplied signal can cancel startup.
      const controller = new AbortController();
      let notifyAbort;
      const aborted = new Promise((resolveAbort) => { notifyAbort = resolveAbort; });
      const forwardAbort = () => { controller.abort(); notifyAbort({ cancelled: true }); };
      signal?.addEventListener('abort', forwardAbort, { once: true });
      if (signal?.aborted) forwardAbort();
      let receipt, settledResult, boundChild = false, retiredChild = false, guardedChild;
      const contextFailure = () => {
        if (executor !== 'spawn' || !guardedChild || typeof contextGuard?.failureFor !== 'function') return null;
        let diagnostic;
        try { diagnostic = contextGuard.failureFor(guardedChild); }
        catch { return outcome('unknown', 'context-guard-unavailable'); }
        return Object.hasOwn(CONTEXT_FAILURES, diagnostic?.code)
          ? outcome(diagnostic.providerStarted === false ? 'failed' : 'unknown', CONTEXT_FAILURES[diagnostic.code]) : null;
      };
      const retire = async () => {
        if (boundChild && !retiredChild) {
          await tokenBudget.retireSession(childId, { authorize: () => true });
          retiredChild = true;
        }
      };
      const clean = async () => {
        if (typeof receipt?.dispose !== 'function') return false;
        try {
          // The service's result can resolve just before its close transaction.
          // Exact receipt.dispose is memoized by DSH and proves cleanup finished.
          await receipt.dispose();
          if (settledResult) await settledResult;
          await retire();
          return true;
        } catch { return false; }
      };
      try {
        if (meterLocalChild) {
          // Installed DSH's continuable activation uses spec.childId verbatim
          // as prepareContinuable.sessionId and agents.create.sessionId.
          // The scope comes from the manager's frozen, admitted job envelope.
          childId ||= randomUUID();
          try {
            await tokenBudget.bindSession(childId, { origin: 'user-task',
              scope: { accountId: scope.peerId, identityId: scope.identityId }, userTaskId: id },
            { authorize: () => !controller.signal.aborted && service('agents')?.get?.(parent.id) === parent });
            boundChild = true;
          } catch { return outcome('failed', 'usage-unavailable'); }
          if (controller.signal.aborted) {
            try { await retire(); } catch { return outcome('unknown', 'usage-unavailable'); }
            return outcome('cancelled', 'cancelled');
          }
        }
        try {
          receipt = await subagents.startActivation({ provider: executor, label: `后台任务 ${id}`, request,
            ...(childId ? { childId } : {}),
            signal: controller.signal, delivery: 'caller' });
        } catch (error) {
          if (error?.code === 'ACTIVATION_TEARDOWN_FAILED') { onCleanupUnknown?.(); return outcome('unknown', 'cleanup-unconfirmed'); }
          if (controller.signal.aborted) return outcome('cancelled', 'cancelled');
          const code = error?.code === 'ACTIVATION_LIMIT_REACHED' ? 'capacity'
            : error?.code === 'UNAUTHORIZED' ? 'parent-unavailable'
              : error?.code === 'NO_PROVIDER' ? 'unavailable' : 'start-failed';
          return outcome('failed', code);
        }
        if (isPromise(receipt?.result)) settledResult = Promise.resolve(receipt.result)
          .then((value) => ({ value }), () => ({ rejected: true }));
        if (!settledResult || typeof receipt?.dispose !== 'function' || typeof receipt?.childId !== 'string' || !receipt.childId
          || boundChild && receipt.childId !== childId) {
          if (!await clean()) onCleanupUnknown?.(); return outcome('unknown', 'invalid-receipt');
        }
        if (executor === 'spawn' && contextGuard) {
          const candidate = service('agents')?.get?.(receipt.childId);
          if (candidate?.id === receipt.childId && candidate.session?.id === receipt.childId
            && service('agents')?.get?.(candidate.id) === candidate) guardedChild = candidate;
        }
        if (controller.signal.aborted) { if (await clean()) return outcome('cancelled', 'cancelled'); onCleanupUnknown?.(); return outcome('unknown', 'cleanup-unconfirmed'); }
        if (typeof onProgress === 'function') {
          try { Promise.resolve(onProgress({ text: '子任务已受理，正在后台执行。', childId: receipt.childId, executor })).catch(() => {}); }
          catch {}
        }
        const terminal = await Promise.race([settledResult, aborted]);
        // An abort after acceptance must dispose the actual activation, not just
        // stop waiting. A late start receipt takes this same cleanup path.
        if (controller.signal.aborted || terminal.cancelled) {
          if (await clean()) return outcome('cancelled', 'cancelled');
          onCleanupUnknown?.(); return outcome('unknown', 'cleanup-unconfirmed');
        }
        const guardedFailure = contextFailure();
        if (!await clean()) { onCleanupUnknown?.(); return outcome('unknown', 'cleanup-unconfirmed'); }
        if (controller.signal.aborted) return outcome('cancelled', 'cancelled');
        if (guardedFailure) return guardedFailure;
        if (terminal.rejected) return outcome('failed', 'execution');
        const result = terminal.value;
        if (!result || typeof result !== 'object') return outcome('unknown', 'invalid-result');
        const facts = executor === 'codex' && result.stopReason !== 'completed' ? codexDiagnosticFacts(result.diagnostic) : undefined;
        if (result.stopReason === 'aborted') return outcome('cancelled', 'cancelled', undefined, facts);
        if (['error', 'refusal', 'max-tokens'].includes(result.stopReason))
          return outcome('failed', result.stopReason === 'error' ? codexFailureCode(facts) : result.stopReason, undefined, facts);
        if (result.stopReason !== 'completed') return outcome('unknown', 'invalid-result', undefined, facts);
        const text = outputText(result.output);
        return text ? outcome('succeeded', undefined, text) : outcome('failed', 'no-result');
      } finally { signal?.removeEventListener('abort', forwardAbort); }
  };
  return Object.freeze({
    available() {
      try { return { available: Boolean(resolve()) }; }
      catch { return { available: false }; }
    },
    async run(input = {}) {
      if (input.control === undefined) return runNative(input);
      if (!['desktop', 'browser'].includes(input.control)) return outcome('failed', 'invalid-input');
      if (executor !== 'spawn' || typeof controlAccess?.runChild !== 'function') return outcome('failed', 'control-unavailable');
      if (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 160 || typeof input.prompt !== 'string'
        || !input.prompt.trim() || input.prompt.length > 64000) return outcome('failed', 'invalid-input');
      try {
        return await controlAccess.runChild({ parent: input.parent, taskId: input.id, signal: input.signal, capabilities: [input.control] },
          ({ childId, signal, onCleanupUnknown }) => runNative({ ...input, childId, signal, onCleanupUnknown,
            prompt: input.prompt + '\n\n本任务只有明确委派的' + (input.control === 'desktop' ? '电脑界面' : '浏览器')
              + '权限。先调用 dafeiyu_control_context 获取本任务上下文；浏览器工具每次必须传该工具返回的 browserSpace，不能使用默认或其他任务空间。'
              + (input.control === 'desktop' ? '需要工具时仅加载 dsh-computer-use 技能。' : '仅使用明确任务空间的结构化 ego_* 工具。')
              + '不继承主人身份、私人记忆、QQ发送、手机、终端或文件权限。取消或拒绝后不要自行换工具重做，按实际结果回报。' }));
      } catch (error) {
        if (['CONTROL_CLEANUP_UNCONFIRMED', 'cleanup-unconfirmed'].includes(error?.code)) return outcome('unknown', 'cleanup-unconfirmed');
        return outcome(input.signal?.aborted ? 'cancelled' : 'failed', input.signal?.aborted ? 'cancelled' : 'control-unavailable');
      }
    },
  });
}

export default createNativeTaskExecutor;
