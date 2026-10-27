const attached = new WeakMap();
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[\x00-\x1f\x7f]/.test(value);
const sameScope = (a, b) => a?.accountId === b?.accountId && a?.identityId === b?.identityId;
const fault = () => Object.assign(new Error('子任务 Token 归属尚未确认，未开始新的模型调用'), { code: 'TOKEN_SUBAGENT_BINDING_UNCONFIRMED' });

/**
 * Inherit only the installed host's live parent/child registry and durable
 * SessionHeader lineage. Optional carrierKeyOf must come from its real
 * @deepseek-ai/dsh-scope instance; model arguments never choose the payer.
 * The synchronous resolver is also the pre-provider fallback: lifecycle emit
 * contains listener failures and does not await their returned Promises.
 */
export function attachTokenSubagents({ ctx, tokenBudget, carrierKeyOf } = {}) {
  if (!ctx || typeof ctx.get !== 'function' || !tokenBudget || typeof tokenBudget.resolveBinding !== 'function'
    || typeof tokenBudget.bindSession !== 'function' || carrierKeyOf !== undefined && typeof carrierKeyOf !== 'function') throw fault();
  if (attached.has(ctx)) throw fault();
  let closed = false, stop;
  const live = (id) => {
    const agents = ctx.get('agents'), agent = agents?.get?.(id);
    if (!agent || agent.id !== id || agent.session?.id !== id || agent.session?.header?.id !== id
      || agents.get(agent.id) !== agent) return null;
    return agent;
  };
  function inherit(sessionId, expectedParent, seen) {
    if (closed || !identifier(sessionId)) return null;
    const child = live(sessionId);
    if (!child) return null;
    const header = child.session.header, parentId = header.parentSession;
    if (header.origin !== 'subagent' || !identifier(parentId) || parentId === sessionId) return null;
    if (seen.has(sessionId) || seen.size >= 32) throw fault();
    seen.add(sessionId);
    const parent = live(parentId);
    if (!parent || expectedParent && parent !== expectedParent) return null;
    let source = tokenBudget.resolveBinding(parentId);
    if (!source) source = inherit(parentId, undefined, seen);
    if (!source) return null;
    if (source.retiredAt || !['user-task', 'autonomy'].includes(source.origin)
      || !/^[1-9]\d{0,19}$/.test(source.scope?.accountId || '') || !/^[A-Za-z0-9_-]{1,48}$/.test(source.scope?.identityId || '')) throw fault();
    const value = { scope: { accountId: source.scope.accountId, identityId: source.scope.identityId }, origin: source.origin,
      ...(source.origin === 'autonomy' ? { activityId: source.activityId } : { userTaskId: source.userTaskId }) };
    if (!identifier(source.origin === 'autonomy' ? value.activityId : value.userTaskId)) throw fault();
    const prior = tokenBudget.resolveBinding(sessionId);
    if (prior) {
      // A manager may have assigned a more specific user-task ID before
      // activation. Preserve that proof; do not overwrite it from its parent.
      if (!sameScope(prior.scope, value.scope) || prior.origin !== value.origin
        || value.origin === 'autonomy' && prior.activityId !== value.activityId) throw fault();
      return prior;
    }
    const authorize = () => !closed && live(sessionId) === child && live(parentId) === parent
      && child.session.header.origin === 'subagent' && child.session.header.parentSession === parentId
      && (() => { const current = tokenBudget.resolveBinding(parentId);
        return current && !current.retiredAt && sameScope(current.scope, source.scope) && current.origin === source.origin
          && current.activityId === source.activityId && current.userTaskId === source.userTaskId; })();
    const persisted = tokenBudget.bindSession(sessionId, value, { authorize });
    // The real ledger is synchronous. An asynchronous facade must not race the
    // first provider dispatch: reject it instead of treating it as unbound.
    if (persisted && typeof persisted.then === 'function') { Promise.resolve(persisted).catch(() => {}); throw fault(); }
    if (!authorize()) throw fault();
    const result = tokenBudget.resolveBinding(sessionId);
    if (!result || !sameScope(result.scope, value.scope) || result.origin !== value.origin
      || result.userTaskId !== value.userTaskId || result.activityId !== value.activityId) throw fault();
    return result;
  }
  if (carrierKeyOf) {
    if (typeof ctx.on !== 'function') throw fault();
    stop = ctx.on('subagent/start', function (info) {
      if (closed || info?.local !== true || !identifier(info.id)) return;
      const parent = carrierKeyOf(this);
      if (!parent || !identifier(parent.id) || live(parent.id) !== parent) return;
      inherit(info.id, parent, new Set());
    }, { global: true });
  }
  const result = Object.freeze({
    resolveChild(sessionId) { return inherit(sessionId, undefined, new Set()); },
    dispose() {
      if (closed) return;
      closed = true;
      try { if (typeof stop === 'function') stop(); }
      finally { if (attached.get(ctx) === result) attached.delete(ctx); }
    },
  });
  attached.set(ctx, result);
  return result;
}
