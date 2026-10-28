import { createHash, randomUUID } from 'node:crypto';
import { createTokenUsageBridge } from './token-usage-bridge.js';
import { attachTokenSubagents } from './token-subagents.js';
import { normalizeOpenAiTokenUsage } from './legacy-token-meter.js';

const scopeOf = (identity, ownerQq) => {
  const profile = identity?.accountProfile;
  const accountId = identity?.isOwner ? ownerQq : identity?.channel === 'onebot' && identity.scope === 'c2c'
    && profile?.account?.qq === identity.peerId ? identity.peerId : '';
  const identityId = profile?.identity?.id;
  return /^[1-9]\d{0,19}$/.test(accountId || '') && /^[A-Za-z0-9_-]{1,48}$/.test(identityId || '')
    ? { accountId, identityId } : null;
};
const same = (a, b) => a?.accountId === b?.accountId && a?.identityId === b?.identityId;
const error = () => Object.assign(new Error('Token 用量归属或记账未确认，未开始新的调用'), { code: 'TOKEN_ACCOUNTING_UNAVAILABLE' });

/** Only actual host Agents can stage a binding. Context previews do not write. */
export function createTokenAccounting({ ctx, budget, ownerQq, ownerOpenId = '', getExecutionContext, contextGuard, isOpen = () => true }) {
  const staged = new Map(), known = new Set(), active = new Set();
  const ledgerIdFor = (sessionId, scope) => {
    const direct = budget.resolveBinding(sessionId);
    if (direct && direct.scope.accountId !== scope.accountId) throw error();
    // A trusted desktop session may survive a same-account identity change.
    // Preserve its old immutable scope and route the new identity to a stable
    // separate ledger session. Existing requests keep their frozen target.
    return !direct || same(direct.scope, scope) ? sessionId : 'dafeiyu-identity:'
      + createHash('sha256').update(JSON.stringify([sessionId, scope])).digest('hex');
  };
  const lookup = (id) => {
    if (staged.has(id)) {
      const agent = staged.get(id), scope = scopeOf(getExecutionContext({ agent }), ownerQq);
      if (!scope || agent.session?.id !== id) throw error();
      return budget.resolveBinding(ledgerIdFor(id, scope));
    }
    return known.has(id) ? budget.resolveBinding(id) : null;
  };
  const descendantBudget = Object.create(budget);
  descendantBudget.resolveBinding = lookup;
  descendantBudget.bindSession = (id, ...args) => {
    const result = budget.bindSession(id, ...args); known.add(id); return result;
  };
  const descendants = typeof ctx.get === 'function' ? attachTokenSubagents({ ctx, tokenBudget: descendantBudget }) : null;
  const persist = (event) => {
    if (event.status === 'started' && !isOpen()) throw error();
    // Once admitted, late consumption is a fact even after cancellation or
    // permission revocation. Never erase it by reusing the execution guard.
    try {
      const result = budget.observe(event, { authorize: () => true });
      if (event.status === 'started' && result.result?.allowed !== false) active.add(event.requestId);
      return result;
    } finally {
      // A failed durable settlement remains pending in storage. Do not retain
      // a phantom live provider forever and prevent recovery after it exits.
      if (['completed', 'failed', 'cancelled', 'unknown'].includes(event.status)) active.delete(event.requestId);
    }
  };
  const bridge = createTokenUsageBridge({ ctx,
    resolveBinding(sessionId) {
      if (!staged.has(sessionId) && !known.has(sessionId)) return descendants?.resolveChild(sessionId) || null;
      const agent = staged.get(sessionId);
      const identity = agent ? getExecutionContext({ agent }) : null;
      const scope = agent ? scopeOf(identity, ownerQq) : null;
      if (agent && (!isOpen() || agent.session?.id !== sessionId || !scope)) throw error();
      if (!agent && known.has(sessionId)) {
        const agents = ctx.get?.('agents'), actual = agents?.get?.(sessionId);
        if (!actual || agents.get(actual.id) !== actual || actual.session?.id !== sessionId || actual.session?.header?.id !== sessionId) throw error();
        // Recheck a known descendant on every new provider dispatch, too. A
        // completed/cancelled parent cannot leave an orphan spending allowance.
        if (actual.session.header.origin === 'subagent' && !descendants?.resolveChild(sessionId)) throw error();
      }
      const ledgerSessionId = agent ? ledgerIdFor(sessionId, scope) : sessionId;
      const existing = budget.resolveBinding(ledgerSessionId);
      if (existing) {
        if (agent && (!same(scope, existing.scope) || existing.origin !== 'user-task')) throw error();
        return ledgerSessionId === sessionId ? existing : { ...existing, ledgerSessionId };
      }
      if (!agent) return null;
      budget.bindSession(ledgerSessionId, { origin: 'user-task', scope,
        userTaskId: 'conversation:' + createHash('sha256').update(sessionId).digest('hex').slice(0, 32) },
      { authorize: () => isOpen() && same(scope, scopeOf(getExecutionContext({ agent }), ownerQq)) });
      const bound = budget.resolveBinding(ledgerSessionId);
      return ledgerSessionId === sessionId ? bound : { ...bound, ledgerSessionId };
    }, onEvent: persist,
    beforeDispatch: contextGuard && ((options) => contextGuard.beforeDispatch(options)),
    onAdmissionAborted: contextGuard && ((options) => contextGuard.onAdmissionAborted?.(options)),
    onDispatch: contextGuard && ((options) => contextGuard.onDispatch(options)),
    onSettlement: contextGuard && ((options, receipt) => contextGuard.onSettlement(options, receipt)),
    usageIsAuthoritative: contextGuard && ((options) => contextGuard.usageIsAuthoritative(options)) });
  return {
    get active() { return active.size; },
    markSession(sessionId) { known.add(sessionId); },
    trackAgent(agent) {
      const identity = getExecutionContext({ agent }), scope = scopeOf(identity, ownerQq);
      if (scope && typeof agent?.session?.id === 'string') staged.set(agent.session.id, agent);
    },
    executionFor(agent) {
      const agents = ctx.get?.('agents'), seen = new Set();
      let current = agent;
      while (current && agents?.get?.(current.id) === current && current.session?.id === current.id
        && current.session?.header?.id === current.id && !seen.has(current.id) && seen.size < 32) {
        seen.add(current.id);
        const binding = lookup(current.id);
        if (binding && !binding.retiredAt && ['autonomy', 'user-task'].includes(binding.origin)) {
          return current !== agent || agent.session.header.origin === 'subagent' || binding.origin === 'autonomy'
            ? { origin: binding.origin } : null;
        }
        if (current.session.header.origin !== 'subagent') return null;
        current = agents.get(current.session.header.parentSession);
      }
      return null;
    },
    async runExternal(executor, input, run) {
      const identity = getExecutionContext({ agent: input.parent }), scope = scopeOf(identity, ownerQq);
      if (!isOpen() || input.signal?.aborted || !identity.isOwner || !scope
        || !same(scope, { accountId: input.scope?.peerId, identityId: input.scope?.identityId })) throw error();
      const sessionId = `dafeiyu-external:${executor}:${input.id}`;
      // A task ID is one dispatch, even if its executor changes. Read durable
      // bindings rather than the capped panel history so old random-ID
      // requests and crashes before retirement remain protected after reload.
      if (budget.read().state.tokenBudget?.sessions.some(row => row.sessionId.startsWith('dafeiyu-external:')
        && row.origin === 'user-task' && row.userTaskId === input.id)) throw error();
      budget.bindSession(sessionId, { scope, origin: 'user-task', userTaskId: input.id }, { authorize: isOpen });
      // The deterministic request also arbitrates two dispatchers racing to
      // bind the same task. Unknown results never authorize a second call.
      const requestId = 'external:' + createHash('sha256').update(input.id).digest('hex');
      const meta = { sessionId, scope, origin: 'user-task', userTaskId: input.id, requestId,
        provider: 'external-' + executor, model: 'unreported', purpose: 'main' };
      const admitted = persist({ ...meta, status: 'started' });
      if (admitted.result?.allowed === false) throw error();
      try { return await run(); }
      finally {
        // CLI success does not provide a token receipt. Preserve the gap and
        // charge neither autonomous allowance nor an invented amount.
        persist({ ...meta, status: 'unknown', finishReason: 'stream-ended' });
        budget.retireSession(sessionId, { authorize: () => true });
      }
    },
    async runLegacy(input, execute) {
      const peer = String(input.userId || '');
      const boundOwner = peer === ownerQq || Boolean(ownerOpenId && peer === ownerOpenId);
      const keys = [`private:${peer}`, `official:c2c:${peer}`];
      if (!isOpen() || input.signal?.aborted || input.isGroup || !input.isOwner || !boundOwner
        || !keys.includes(input.key) || !/^[1-9]\d{0,19}$/.test(ownerQq)) throw error();
      const workId = 'legacy:' + createHash('sha256').update(input.sessionId || input.key).digest('hex').slice(0, 32);
      const sessionId = 'dafeiyu-' + workId, scope = { accountId: ownerQq, identityId: 'default' };
      budget.bindSession(sessionId, { scope, origin: 'user-task', userTaskId: workId }, { authorize: isOpen });
      const meta = { sessionId, scope, origin: 'user-task', userTaskId: workId, requestId: randomUUID(),
        provider: 'legacy-openai-compatible', model: input.model, purpose: 'main' };
      const admitted = persist({ ...meta, status: 'started' });
      if (admitted.result?.allowed === false) throw error();
      let terminal = false;
      const settle = (status, raw) => {
        terminal = true;
        const usage = normalizeOpenAiTokenUsage(raw);
        persist({ ...meta, status: usage ? status : 'unknown', ...(usage ? { usage } : {}) });
      };
      try { const data = await execute(); settle('completed', data?.usage); return data; }
      catch (failure) {
        if (!terminal) settle(input.signal?.aborted ? 'cancelled' : 'failed', failure?.rawUsage);
        throw failure;
      }
    },
    dispose() { bridge.dispose(); descendants?.dispose(); staged.clear(); },
  };
}

/** Owner sees shared allowance plus only their own request metadata. */
export function ownerTokenView(budget, scope) {
  const global = budget.snapshot(), personal = budget.snapshot({ scope });
  return { ...personal, sharedBudgetVisible: true, policy: global.policy, balanceTokens: global.balanceTokens,
    pendingMonthlyTokens: global.pendingMonthlyTokens, projectedAvailableTokens: global.projectedAvailableTokens,
    dailyRemainingTokens: global.dailyRemainingTokens, availableTokens: global.availableTokens,
    overdrawnTokens: global.overdrawnTokens, reservedTokens: global.reservedTokens,
    sharedPendingUnknownCount: global.pendingAutonomyUnknownCount };
}

export function tokenPrompt(budget, identity, ownerQq) {
  if (!identity?.isOwner) return '';
  const scope = scopeOf(identity, ownerQq);
  if (!scope) return '';
  try {
    const view = ownerTokenView(budget, scope);
    return '【本轮 Token 归属】当前是用户安排的对话或任务，消耗归用户，不扣你的零花 Token。'
      + '模型思考、回复及处理工具结果以真实用量记账；点击、等待不能按次数猜费，也不重复计工具消耗。'
      + '自主活动先用每日免扣额度，超出部分扣自己的零花 Token；余额不足或用量待确认时停止新的自主调用。'
      + 'Token 是此处零花额度的计量单位，实际人民币费用未提供，不自行估价。以下仅为本轮开始前快照，开始调用会同步本月额度；本轮消费尚未结算。未实时查询dafeiyu_token_status不要报“当前余额”或本轮最终用量。'
      + JSON.stringify({ dailyFreeTokens: view.policy.dailyTokens, dailyRemainingTokens: view.dailyRemainingTokens,
        pocketTokensBeforeRequest: view.balanceTokens, monthlyTokensPendingBeforeRequest: view.pendingMonthlyTokens,
        ownUserTaskTokensToday: view.today.userTaskTokens,
        ownAutonomyTokensToday: view.today.autonomyTokens, pendingUnknown: view.sharedPendingUnknownCount });
  } catch { return '【Token 账本暂不可读】不能声称免费、已经扣款或知道余额；用户安排不改成你的自主消费。'; }
}

export function registerTokenStatusTool(ctx, { budget, getExecutionContext, ownerQq, isOpen }) {
  return ctx.tools.register({ name: 'dafeiyu_token_status',
    description: '只读查看当前已验证主人本人的 Token 用量和大肥鱼的共享免扣额度、零花 Token。没有权威用量保持未计量；不能发放、改额度或指定其他用户。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(_args, exec) {
      const identity = getExecutionContext(exec), scope = scopeOf(identity, ownerQq);
      if (!isOpen() || exec.signal?.aborted || !identity.isOwner || !scope) throw error();
      return { ok: true, tokens: ownerTokenView(budget, scope), origin: 'user-task' };
    } });
}
