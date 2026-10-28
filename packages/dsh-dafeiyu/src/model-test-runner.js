import { randomUUID } from 'node:crypto';

const fail = code => Object.assign(new Error('模型测试的执行或用量尚未核实；没有自动重试'), { code });
const validScope = value => /^[1-9]\d{0,19}$/.test(value?.accountId || '') && /^[A-Za-z0-9_-]{1,48}$/.test(value?.identityId || '');
const sameScope = (a, b) => validScope(a) && validScope(b) && a.accountId === b.accountId && a.identityId === b.identityId;
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const PREFIX = 'dafeiyu-model-test:';
const settleWithin = (promise, milliseconds) => {
  let timer;
  return Promise.race([Promise.resolve(promise).then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })])
    .finally(() => clearTimeout(timer));
};

/** A new, fixed owner diagnostic. It never resumes or copies a conversation.
 * The registered real Agent gives the existing global stream bridge an exact
 * ledger owner and a complete request for the existing context guard. */
export function createModelTestRunner({ ctx, tokenBudget, getScope, isOpen = () => true, timeoutMs = 15000, cleanupTimeoutMs = 1000 } = {}) {
  let active = null, closed = false, cleanupUnknown = false;
  const pending = () => {
    try { const value = tokenBudget.read().state.tokenBudget;
      return value?.sessions.some(row => row.sessionId.startsWith(PREFIX) && !row.retiredAt) === true
        || value?.requests.some(row => row.sessionId.startsWith(PREFIX)
          && (['started', 'usage'].includes(row.status) || row.unmetered && !row.acknowledgedUnmetered)) === true; }
    catch { return true; }
  };
  const runner = {
    get busy() { return active !== null || cleanupUnknown; },
    get blocked() { return cleanupUnknown || pending(); },
    async run(body, { authorize, signal } = {}) {
      if (!body || Object.keys(body).sort().join(',') !== 'model,provider' || !label(body.provider) || !label(body.model)) throw fail('INVALID_PATCH');
      if (closed || !isOpen() || authorize?.() !== true || signal?.aborted) throw fail('FORBIDDEN');
      if (active || cleanupUnknown) throw fail('MODEL_TEST_BUSY');
      if (pending()) throw fail('MODEL_TEST_UNCONFIRMED');
      const scope = structuredClone(getScope?.());
      if (!validScope(scope)) throw fail('TOKEN_ACCOUNTING_UNAVAILABLE');
      const controller = new AbortController(), sessionId = PREFIX + randomUUID();
      const job = { controller, sessionId, promise: null };
      active = job;
      const valid = () => !closed && isOpen() && !controller.signal.aborted && authorize?.() === true && sameScope(scope, getScope?.());
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      let timer, timedOut = false;
      const work = (async () => {
        const agents = ctx?.get?.('agents'), llm = ctx?.get?.('llm');
        if (!agents?.create || !agents?.get || typeof llm?.prepareCall !== 'function' || !tokenBudget?.bindSession || !tokenBudget?.retireSession) throw fail('UNAVAILABLE');
        let handle, iterator, iteratorComplete = false, bound = false, creating = false, streamInvoked = false, admissionRefused = false;
        const real = agent => Boolean(agent && agent.id === sessionId && agent.session?.id === sessionId && agent.session?.header?.id === sessionId && agents.get(sessionId) === agent);
        try {
          if (!valid()) throw fail('FORBIDDEN');
          tokenBudget.bindSession(sessionId, { origin: 'user-task', scope, userTaskId: 'model-test:' + randomUUID() }, { authorize: valid });
          bound = true;
          const create = () => { creating = true; return agents.create({ sessionId, meta: {},
            agentOptions: { provider: body.provider, model: body.model, maxTokens: 16 },
            setup(agentCtx) {
              if (!valid()) throw fail('FORBIDDEN');
              const tools = agentCtx.get?.('tools');
              if (!tools?.restrict || !tools?.guard) throw fail('UNAVAILABLE');
              tools.restrict({ allow: [] }); tools.presentAs?.('native');
              tools.guard(() => '模型连接测试不允许调用任何工具');
            } }); };
          handle = await (agents.withoutInitiator ? agents.withoutInitiator(create) : create());
          if (!valid()) throw fail('FORBIDDEN');
          if (!real(handle?.agent) || typeof handle.dispose !== 'function') throw fail('TOKEN_ACCOUNTING_UNAVAILABLE');
          const prepared = await llm.prepareCall({ provider: body.provider, model: body.model, maxTokens: 16 }, controller.signal, (controls, model) => {
            const effort = model?.reasoning?.efforts?.[0];
            return { ...controls, maxTokens: 16, ...(label(effort?.id) ? { reasoningEffort: effort.id } : {}) };
          });
          if (!valid() || !real(handle.agent)) throw fail('FORBIDDEN');
          if (prepared?.config?.provider !== body.provider || prepared.config.model !== body.model || prepared.config.maxTokens !== 16 || typeof prepared.stream !== 'function') throw fail('INVALID_RECEIPT');
          // No history, system context, private memory or caller supplied text.
          const options = { ...prepared.config, sessionId, purpose: 'main',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }], tools: [], signal: controller.signal };
          const stream = prepared.stream(options); streamInvoked = true;
          if (typeof stream?.[Symbol.asyncIterator] !== 'function') throw fail('INVALID_RECEIPT');
          iterator = stream[Symbol.asyncIterator]();
          let visible = false, terminal = '', chunks = 0, characters = 0;
          for (;;) {
            if (!valid() || !real(handle.agent)) throw fail('FORBIDDEN');
            const next = await iterator.next();
            if (next.done) { iteratorComplete = true; break; }
            if (++chunks > 128) throw fail('INVALID_RECEIPT');
            const chunk = next.value;
            if (['text-delta', 'reasoning-delta'].includes(chunk?.type) && typeof chunk.text === 'string') { visible ||= Boolean(chunk.text.trim()); characters += chunk.text.length; }
            else if (chunk?.type === 'block-end' && ['text', 'reasoning'].includes(chunk.block?.type) && typeof chunk.block.text === 'string') { visible ||= Boolean(chunk.block.text.trim()); characters += chunk.block.text.length; }
            if (characters > 8192) throw fail('INVALID_RECEIPT');
            if (chunk?.type === 'finish') { terminal = chunk.reason?.kind || ''; if (!['stop', 'max-tokens'].includes(terminal)) throw fail('INVALID_RECEIPT'); }
          }
          const requests = tokenBudget.read().state.tokenBudget?.requests.filter(row => row.sessionId === sessionId) || [];
          if (requests.length !== 1 || ['started', 'usage'].includes(requests[0].status)) throw fail('TOKEN_ACCOUNTING_UNAVAILABLE');
          const row = requests[0];
          return { visible, terminal, accounting: { origin: 'user-task', state: row.unmetered ? 'unknown' : 'measured',
            ...(Number.isSafeInteger(row.settledTokens) ? { totalTokens: row.settledTokens } : {}) } };
        } catch (error) {
          // These failures are raised by the owned bridge before started and
          // before its provider callback. A local capacity refusal is not an
          // unknown paid request or a reason to clear any old conversation.
          if (['CONTEXT_CAPACITY_REQUIRED', 'CONTEXT_GUARD_UNAVAILABLE', 'USAGE_REQUEST_ABORTED', 'USAGE_START_REJECTED', 'INVALID_USAGE_BINDING', 'INVALID_USAGE_REQUEST'].includes(error?.code)) {
            try { admissionRefused = !tokenBudget.read().state.tokenBudget?.requests.some(row => row.sessionId === sessionId); } catch {}
          }
          throw error;
        } finally {
          controller.abort();
          let cleanupConfirmed = true;
          if (iterator && !iteratorComplete) {
            try { cleanupConfirmed = typeof iterator.return === 'function' && await settleWithin(iterator.return(), cleanupTimeoutMs); }
            catch { cleanupConfirmed = false; }
          }
          if (handle) {
            try { if (!await settleWithin(handle.dispose(), cleanupTimeoutMs)) cleanupConfirmed = false; }
            catch { cleanupConfirmed = false; }
          } else if (creating) cleanupConfirmed = false;
          // A started stream with no durable ledger row means the bridge was
          // unavailable, not evidence of zero provider consumption.
          if (streamInvoked) {
            try { const requests = tokenBudget.read().state.tokenBudget?.requests.filter(row => row.sessionId === sessionId) || [];
              if (!(admissionRefused && requests.length === 0) && (requests.length !== 1 || ['started', 'usage'].includes(requests[0].status))) cleanupConfirmed = false;
            } catch { cleanupConfirmed = false; }
          }
          if (!cleanupConfirmed) { cleanupUnknown = true; throw fail('MODEL_TEST_UNCONFIRMED'); }
          if (bound) tokenBudget.retireSession(sessionId, { authorize: () => true });
        }
      })();
      job.promise = work.finally(() => { signal?.removeEventListener('abort', abort); if (active === job && !cleanupUnknown) active = null; });
      // Observe late completion even when the HTTP timeout already returned.
      job.promise.catch(() => {});
      try {
        return await Promise.race([job.promise, new Promise((_resolve, reject) => {
          timer = setTimeout(() => { timedOut = true; controller.abort(); reject(fail('PANEL_CONNECTION_TIMEOUT')); }, Math.min(15000, Math.max(1, timeoutMs)));
        })]);
      } finally { clearTimeout(timer); if (!timedOut) controller.abort(); }
    },
    dispose() {
      closed = true; active?.controller.abort();
      // Preserve the plugin's synchronous idle-unregistration contract. Only
      // a genuinely live diagnostic needs asynchronous stream teardown.
      if (active?.promise) return active.promise.catch(() => {});
    },
  };
  return runner;
}
