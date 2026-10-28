import { randomUUID } from 'node:crypto';
import { normalizeTokenUsage } from './token-budget-state.js';

const activeBridges = new WeakMap();
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const FINISH_REASONS = new Set(['stop', 'tool-calls', 'max-tokens', 'aborted', 'error']);
const label = (value, maximum = 200) => typeof value === 'string' && value.length > 0 && value.length <= maximum
  && !/[\x00-\x1f\x7f]/.test(value);
const fault = (code) => Object.assign(new Error('Token usage accounting could not be confirmed'), { code });

function bindingSnapshot(value) {
  if (value === null || value === undefined) return null;
  const scope = value.scope;
  if (!scope || !/^[1-9]\d{0,19}$/.test(scope.accountId || '')
    || !/^[A-Za-z0-9_-]{1,48}$/.test(scope.identityId || '')
    || !['user-task', 'autonomy'].includes(value.origin)) throw fault('INVALID_USAGE_BINDING');
  const key = value.origin === 'autonomy' ? 'activityId' : 'userTaskId';
  if (!label(value[key])) throw fault('INVALID_USAGE_BINDING');
  if (value.ledgerSessionId !== undefined && !label(value.ledgerSessionId, 500)) throw fault('INVALID_USAGE_BINDING');
  return { scope: Object.freeze({ accountId: scope.accountId, identityId: scope.identityId }),
    origin: value.origin, [key]: value[key], workId: value[key],
    ...(value.ledgerSessionId === undefined ? {} : { ledgerSessionId: value.ledgerSessionId }) };
}

/** Preserve provider buckets; normalization and allowance allocation belong to the ledger. */
function usageSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.hasOwn(value, 'inputTokens') || !Object.hasOwn(value, 'outputTokens')) return null;
  const result = {};
  for (const key of USAGE_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
    result[key] = value[key];
  }
  if (!normalizeTokenUsage(result)) return null;
  // The installed adapter may synthesize all-zero defaults when an upstream
  // service omitted usage. Do not turn that ambiguous receipt into free work.
  // Reasoning is already part of output; it is not a separate billed bucket.
  if (!['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .some(key => (result[key] ?? 0) > 0)) return null;
  return Object.freeze(result);
}

/**
 * Observe exactly one installed-host llm/stream invocation at a time. The
 * caller persists session ownership before dispatch and makes onEvent durable.
 * No prompt, tools, content, prices or provider failure text enter the ledger.
 */
export function createTokenUsageBridge({ ctx, resolveBinding, onEvent, beforeDispatch, onAdmissionAborted, onDispatch, onSettlement, usageIsAuthoritative, now = () => Date.now(), idFactory = randomUUID } = {}) {
  if (!ctx || typeof ctx.on !== 'function' || typeof resolveBinding !== 'function' || typeof onEvent !== 'function'
    || typeof now !== 'function' || typeof idFactory !== 'function') throw fault('INVALID_USAGE_BRIDGE');
  if (activeBridges.has(ctx)) throw fault('USAGE_BRIDGE_ALREADY_REGISTERED');
  let closed = false;

  async function* observe(options, next) {
    const sessionId = options?.sessionId;
    // Resolve on iteration, immediately before dispatch. A previously built
    // stream must not retain ownership that has since been revoked or changed.
    const binding = label(sessionId, 500) ? bindingSnapshot(await resolveBinding(sessionId, options)) : null;
    if (!binding) { yield* next(); return; }
    if (closed) throw fault('USAGE_BRIDGE_CLOSED');
    if (options.signal?.aborted) throw fault('USAGE_REQUEST_ABORTED');
    const purpose = options.purpose === undefined ? 'main' : options.purpose;
    if (!['main', 'compaction', 'session-title'].includes(purpose)
      || !label(options.provider, 160) || !label(options.model, 160)) throw fault('INVALID_USAGE_REQUEST');
    let admissionChecked = false, started = false;
    try {
    // Capacity refusal precedes the durable provider-start event. It must not
    // create unknown usage or an allowance reservation.
    if (beforeDispatch) { await beforeDispatch(options, binding); admissionChecked = true; }
    if (closed || options.signal?.aborted) throw fault('USAGE_REQUEST_ABORTED');
    if (beforeDispatch) {
      const current = bindingSnapshot(await resolveBinding(sessionId, options));
      if (JSON.stringify(current) !== JSON.stringify(binding)) throw fault('INVALID_USAGE_BINDING');
    }
    if (closed || options.signal?.aborted) throw fault('USAGE_REQUEST_ABORTED');
    const requestId = idFactory();
    if (!label(requestId)) throw fault('INVALID_USAGE_REQUEST_ID');
    const { ledgerSessionId, ...ownership } = binding;
    const meta = { requestId, ...ownership, sessionId: ledgerSessionId || sessionId, provider: options.provider, model: options.model, purpose };
    let terminal = false, latestUsage, invalidUsage = false, finishReason = 'consumer-closed', failureCode;
    const emit = async (status, extra = {}) => {
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0 || !Number.isFinite(new Date(at).getTime())) throw fault('INVALID_USAGE_CLOCK');
      return await onEvent(Object.freeze({ ...meta, status, at: new Date(at).toISOString(), ...extra }));
    };
    const settle = async () => {
      if (!started || terminal) return;
      // Claim terminal before awaiting storage. A rejected write is surfaced;
      // it is never reissued as a second accounting event from finally.
      terminal = true;
      const status = !latestUsage || invalidUsage ? 'unknown'
        : finishReason === 'aborted' || finishReason === 'consumer-closed' ? 'cancelled'
          : finishReason === 'error' ? 'failed'
            : ['stop', 'tool-calls', 'max-tokens'].includes(finishReason) ? 'completed' : 'unknown';
      onSettlement?.(options, { status, finishReason, failureCode });
      await emit(status, { finishReason, ...(latestUsage ? { usage: latestUsage } : {}) });
    };
    try {
      // A refused reservation/storage write must prevent the provider call.
      const admission = await emit('started');
      if (admission?.allowed === false || admission?.result?.allowed === false) throw fault('USAGE_START_REJECTED');
      started = true;
      if (options.signal?.aborted) {
        finishReason = 'aborted';
        throw fault('USAGE_REQUEST_ABORTED');
      }
      onDispatch?.(options, binding);
      for await (const chunk of next()) {
        if (!terminal && chunk?.type === 'usage') {
          const sample = !usageIsAuthoritative || usageIsAuthoritative(options) === true ? usageSnapshot(chunk.usage) : null;
          if (!sample) invalidUsage = true;
          else {
            invalidUsage = false;
            if (JSON.stringify(sample) !== JSON.stringify(latestUsage)) {
              latestUsage = sample;
              await emit('usage', { usage: latestUsage });
            }
          }
        }
        if (!terminal && chunk?.type === 'finish' && FINISH_REASONS.has(chunk.reason?.kind)) {
          finishReason = chunk.reason.kind;
          if (chunk.reason?.failure?.code === 'CONTEXT_WINDOW_EXCEEDED') failureCode = 'CONTEXT_WINDOW_EXCEEDED';
          await settle();
        }
        // Keep original objects and sequence, including malformed/late chunks.
        // The host's own invariant checker owns stream protocol validation.
        yield chunk;
      }
      if (!terminal) finishReason = options.signal?.aborted ? 'aborted' : 'stream-ended';
    } catch (error) {
      if (error?.code === 'CONTEXT_WINDOW_EXCEEDED') failureCode = error.code;
      if (!terminal) finishReason = options.signal?.aborted ? 'aborted' : 'error';
      throw error;
    } finally {
      if (!terminal && options.signal?.aborted) finishReason = 'aborted';
      await settle();
    }
    } finally {
      // A completed local guard check can still be followed by revocation,
      // cancellation or a refused started write. No provider has run in these
      // branches, so release only this request's provisional admission intent.
      if (admissionChecked && !started) await onAdmissionAborted?.(options);
    }
  }

  const stop = ctx.on('llm/stream', (options, next) => observe(options, next), { global: true });
  const bridge = Object.freeze({
    dispose() {
      if (closed) return;
      closed = true;
      try { if (typeof stop === 'function') stop(); }
      finally { if (activeBridges.get(ctx) === bridge) activeBridges.delete(ctx); }
    },
  });
  activeBridges.set(ctx, bridge);
  return bridge;
}
