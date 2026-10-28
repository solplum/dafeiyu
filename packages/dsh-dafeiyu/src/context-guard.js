import { estimateContextRequest } from './context-request-size.js';
import { createHash } from 'node:crypto';

const COMPRESSION_TOOLS = new Set(['compress', 'mcp__bili__compress']);
const fault = code => Object.assign(new Error('上下文保护已暂停后续模型调用；原请求未自动重跑'), { code });
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Local admission for owned requests, before the durable usage-start event.
 * These are conservative capacity estimates, never usage or allowance charges.
 * Inspect the original host request: a proxy's previous compressed token count
 * cannot bound its next fail-open/direct-send payload.
 */
export function createContextGuard({ ctx, now = () => Date.now(), persistence } = {}) {
  if (!ctx) throw fault('CONTEXT_GUARD_UNAVAILABLE');
  const observations = new WeakMap(), failures = new WeakMap(), turns = new WeakMap(), recoveries = new WeakMap();
  const disposers = [], lookups = new Set();
  const admissions = new WeakMap();
  let closed = false;
  const actual = id => {
    try {
      const agents = ctx.get?.('agents'), agent = agents?.get?.(id);
      return agent && agents.get(agent.id) === agent && agent.id === id
        && agent.session?.id === id && agent.session?.header?.id === id ? agent : null;
    } catch { return null; }
  };
  const owns = agent => actual(agent?.id) === agent;
  const stamp = () => new Date(now()).toISOString();
  const restore = agent => {
    if (!persistence) return failures.get(agent) || null;
    let value;
    try { value = persistence.loadFailure(agent); }
    catch { value = { code: 'CONTEXT_GUARD_UNAVAILABLE', kind: 'storage-unavailable', at: stamp() }; }
    const old = failures.get(agent);
    if (value) {
      if (old && digest(old) === digest(value)) return old;
      const frozen = Object.freeze(value); failures.set(agent, frozen); recoveries.delete(agent); return frozen;
    }
    // A persistent file cannot silently remove a latch already observed by this runtime.
    return old || null;
  };
  const fail = (agent, code, extra = {}) => {
    const turn = turns.get(agent);
    const previous = restore(agent);
    // A later local refusal cannot erase earlier uncertainty or a failed
    // compression. Provider-started refers to the whole observed host turn.
    let value = { code: previous?.code || code, at: previous?.at || stamp(),
      ...(previous?.providerStarted === true || turn ? { providerStarted: previous?.providerStarted === true || turn.dispatches > 0 } : {}), ...extra };
    if (persistence) {
      try { value = persistence.recordFailure(agent, value); }
      catch { value = { ...value, code: 'CONTEXT_GUARD_UNAVAILABLE', kind: 'storage-unavailable' }; }
    }
    value = Object.freeze(value);
    failures.set(agent, value);
    recoveries.delete(agent);
    return fault(value.code);
  };
  const endAdmission = options => {
    const value = admissions.get(options);
    if (!value?.token) return;
    persistence.endAdmission(value.agent, value.token); admissions.delete(options);
  };
  const resolveRecoveryConfig = async proposal => {
    const llm = ctx.get?.('llm');
    if (typeof llm?.resolveCallConfig !== 'function') throw fault('CONTEXT_GUARD_UNAVAILABLE');
    const controller = new AbortController(); lookups.add(controller);
    let timer;
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(fault('CONTEXT_GUARD_UNAVAILABLE')), { once: true });
      timer = setTimeout(() => controller.abort(), 5000);
    });
    try { return await Promise.race([Promise.resolve().then(() => llm.resolveCallConfig(proposal, controller.signal)), aborted]); }
    finally { clearTimeout(timer); lookups.delete(controller); }
  };
  const measure = async (options, agent) => {
    if (closed || options.signal?.aborted || !owns(agent)) throw fault('CONTEXT_GUARD_UNAVAILABLE');
    const llm = ctx.get?.('llm');
    if (typeof llm?.resolveModelInfo !== 'function') throw fault('CONTEXT_GUARD_UNAVAILABLE');
    const controller = new AbortController();
    lookups.add(controller);
    let timer, rejectAbort;
    const onAbort = () => { controller.abort(); rejectAbort(fault('CONTEXT_GUARD_UNAVAILABLE')); };
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    controller.signal.addEventListener('abort', () => rejectAbort(fault('CONTEXT_GUARD_UNAVAILABLE')), { once: true });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(onAbort, 5000);
    let info;
    try {
      if (options.signal?.aborted) onAbort();
      info = await Promise.race([Promise.resolve().then(() => llm.resolveModelInfo(options.provider, options.model, controller.signal)), aborted]);
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); lookups.delete(controller);
    }
    if (closed || options.signal?.aborted || !owns(agent)
      || info?.provider !== options.provider || info?.id !== options.model
      || !positive(info?.context?.contextWindow)) throw fault('CONTEXT_GUARD_UNAVAILABLE');
    const result = estimateContextRequest(options, {
      outputTokens: info.defaultMaxTokens,
      imageRequestPricing: llm.imageRequestPricing?.(options.provider, options.model),
      fileRequestText: ref => llm.fileRequestText?.(ref),
    });
    const captured = agent.session.requestContext?.();
    const contextWindow = captured?.provider === options.provider && captured?.model === options.model
      && positive(captured.contextWindow) ? Math.min(info.context.contextWindow, captured.contextWindow) : info.context.contextWindow;
    const limitTokens = Math.floor(contextWindow * 0.9);
    const totalTokens = result.inputTokens + result.outputTokens;
    return Object.freeze({ ...result, totalTokens, contextWindow, limitTokens,
      pressure: totalTokens >= Math.floor(contextWindow * 0.75),
      provider: options.provider, model: options.model });
  };
  const observeTurn = (session, event) => {
    const agent = actual(session?.id);
    if (!agent || agent.session !== session || event?.type !== 'turn/start'
      || !Number.isSafeInteger(event.data?.turn) || event.data.turn < 0) return;
    if (turns.get(agent)?.id !== event.data.turn) turns.set(agent, { id: event.data.turn, dispatches: 0 });
  };
  const observeTool = (exec, result) => {
    const agent = exec?.agent;
    if (closed || !owns(agent) || !observations.has(agent)
      || !COMPRESSION_TOOLS.has(exec.name) || result?.isError !== true) return;
    // This notification is synchronous. Never start another model/tool call
    // from a result observer, and never parse an untrusted error body as code.
    fail(agent, 'CONTEXT_COMPACTION_FAILED');
  };
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('session/event', observeTurn, { global: true }));
    disposers.push(ctx.on('tools/result', observeTool, { global: true }));
  }
  return Object.freeze({
    async beforeDispatch(options) {
      const agent = actual(options?.sessionId);
      if (!agent) throw fault('CONTEXT_GUARD_UNAVAILABLE');
      // Allow an explicit native maintenance request to repair a paused
      // conversation; its own selected input still has to fit independently.
      const paused = restore(agent);
      if (paused && (options.purpose !== 'compaction'
        || ['maintenance-migration', 'unreviewed-migration', 'interrupted-admission', 'storage-unavailable'].includes(paused.kind))) throw fault(paused.code);
      let view;
      try {
        if (admissions.get(options)?.token) throw fault('CONTEXT_GUARD_UNAVAILABLE');
        persistence?.assertPolicy(agent, options);
        if (persistence) admissions.set(options, { agent, token: persistence.beginAdmission(agent) });
        view = await measure(options, agent);
        persistence?.assertPolicy(agent, options);
      }
      catch (error) {
        if (options.signal?.aborted) {
          try { endAdmission(options, agent); } catch { fail(agent, 'CONTEXT_GUARD_UNAVAILABLE'); }
          throw error;
        }
        const code = ['CONTEXT_REQUEST_CAPACITY', 'CONTEXT_CAPACITY_REQUIRED'].includes(error?.code)
          ? 'CONTEXT_CAPACITY_REQUIRED' : 'CONTEXT_GUARD_UNAVAILABLE';
        const errorToThrow = fail(agent, code);
        try { endAdmission(options, agent); } catch {}
        throw errorToThrow;
      }
      if (restore(agent) !== paused) {
        try { endAdmission(options, agent); } catch {}
        throw fault(failures.get(agent)?.code || 'CONTEXT_GUARD_UNAVAILABLE');
      }
      observations.set(agent, view);
      if (view.totalTokens > view.limitTokens) {
        const errorToThrow = fail(agent, 'CONTEXT_CAPACITY_REQUIRED');
        try { endAdmission(options, agent); } catch {}
        throw errorToThrow;
      }
      return view;
    },
    onAdmissionAborted(options) {
      const value = admissions.get(options);
      try { endAdmission(options); }
      catch {
        if (value?.agent) throw fail(value.agent, 'CONTEXT_GUARD_UNAVAILABLE');
        throw fault('CONTEXT_GUARD_UNAVAILABLE');
      }
    },
    onDispatch(options) {
      const agent = actual(options?.sessionId), turn = agent && turns.get(agent);
      if (turn) turn.dispatches++;
    },
    onSettlement(options, receipt) {
      const agent = actual(options?.sessionId);
      if (!agent) return;
      if (options.purpose === 'compaction' && receipt.finishReason !== 'stop') fail(agent, 'CONTEXT_COMPACTION_FAILED');
      else if (options.purpose === 'compaction' && receipt.status === 'unknown') fail(agent, 'CONTEXT_GUARD_UNAVAILABLE');
      else if (receipt.failureCode === 'CONTEXT_WINDOW_EXCEEDED') fail(agent, 'CONTEXT_CAPACITY_REQUIRED');
      try { endAdmission(options, agent); }
      catch { fail(agent, 'CONTEXT_GUARD_UNAVAILABLE'); }
    },
    usageIsAuthoritative(options) {
      // Billion's documented authoredCompaction may return a locally authored
      // checkpoint with synthetic chars/4 usage. A missing policy marker does
      // not prove that a request bypassed the interceptor. Until a receipt can
      // attest its source, retain owned compaction as unmetered, never a charge.
      return options.purpose !== 'compaction';
    },
    failureFor(agent) {
      return owns(agent) ? restore(agent) : null;
    },
    async checkRecovery(agent, { maxTokens, validate = () => true } = {}) {
      if (closed || !owns(agent) || !restore(agent)) return { allowed: false };
      try {
        const session = agent.session, seq = session.seq, failure = restore(agent);
        const header = session.requestHeader?.();
        if (!header?.config || typeof session.deriveMessages !== 'function' || !Number.isSafeInteger(seq)) return { allowed: false };
        if (validate() !== true || maxTokens !== undefined && (!positive(maxTokens) || !positive(header.config.maxTokens) || maxTokens > header.config.maxTokens)) return { allowed: false };
        const headerDigest = digest(header);
        let config = header.config;
        if (maxTokens !== undefined) {
          config = await resolveRecoveryConfig({ ...header.config, maxTokens });
          const keys = new Set([...Object.keys(config || {}), ...Object.keys(header.config)]);
          if (config?.provider !== header.config.provider || config?.model !== header.config.model
            || !positive(config.maxTokens) || config.maxTokens > maxTokens
            || [...keys].some(key => key !== 'maxTokens' && JSON.stringify(config[key]) !== JSON.stringify(header.config[key]))) return { allowed: false };
        }
        const view = await measure({ ...config, sessionId: session.id,
          messages: session.deriveMessages(), tools: header.tools, toolHistory: session.toolHistory?.() }, agent);
        if (session.seq !== seq || !owns(agent) || view.totalTokens > view.limitTokens
          || restore(agent) !== failure || digest(session.requestHeader?.()) !== headerDigest || validate() !== true) return { allowed: false };
        // Fresh admission always rechecks the exact frozen request. This read
        // only confirms that an explicit recovery may accept future messages.
        observations.set(agent, view);
        recoveries.set(agent, { session, seq, failure, headerDigest, validate });
        return { allowed: true, view };
      } catch { return { allowed: false }; }
    },
    clear(agent, { validate = () => true, commit } = {}) {
      const permit = recoveries.get(agent);
      recoveries.delete(agent);
      if (closed || !owns(agent) || !permit || agent.session !== permit.session
        || agent.session.seq !== permit.seq || restore(agent) !== permit.failure
        || digest(agent.session.requestHeader?.()) !== permit.headerDigest || permit.validate() !== true || validate() !== true) throw fault('CONTEXT_RECOVERY_REQUIRED');
      if (commit) commit();
      else persistence?.clearFailure(agent, permit.failure);
      failures.delete(agent);
    },
    promptFor(agent) {
      const view = owns(agent) && observations.get(agent);
      if (!view?.pressure) return '';
      return '【上下文容量提醒】本会话接近本地保守保护线。先使用当前实际可见的压缩能力整理已结束的历史，保留当前用户要求、未完成事项、权限和已执行/结果未知的操作证明；不要重新执行旧任务。压缩失败应停止并说明，不能把长期记忆全文搬进对话。此估算不是实际Token用量。';
    },
    snapshot() { return { enabled: !closed, strategy: 'conservative-host-request', warningRatio: 0.75,
      protectionRatio: 0.9, usageMeasurement: false, automaticReplay: false }; },
    dispose() {
      closed = true; for (const controller of lookups) controller.abort(); lookups.clear();
      for (const dispose of disposers.splice(0)) if (typeof dispose === 'function') dispose();
    },
  });
}
