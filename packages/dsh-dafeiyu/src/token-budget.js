import { LifeError, clone, fail } from './life-store.js';
import { DEFAULT_TOKEN_BUDGET_POLICY, TOKEN_BUDGET_LIMITS, TOKEN_FINISH_REASONS, emptyTokenBudget,
  tokenId, tokenLabel, tokenKeys, tokenInteger, tokenPolicy, tokenScope, tokenSameScope, normalizeTokenUsage } from './token-budget-state.js';
export { DEFAULT_TOKEN_BUDGET_POLICY, normalizeTokenUsage } from './token-budget-state.js';

const terminal = (row) => !['started', 'usage'].includes(row.status);
const safe = (value) => { if (!Number.isSafeInteger(value)) fail('LIMIT', 'Token 账本数值超过安全上限'); return value; };
const sum = (values) => values.reduce((total, value) => safe(total + value), 0);
const authorizeWith = (authorize) => () => { try { return typeof authorize === 'function' && authorize() === true; } catch { return false; } };
const iso = (at) => {
  const value = typeof at === 'string' ? Date.parse(at) : at;
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail('INVALID_EVENT', 'Token 事件时间无效');
  const result = new Date(value).toISOString(); if (result.length !== 24) fail('INVALID_EVENT', 'Token 事件时间无效'); return result;
};
const scopeOf = (scope) => {
  const result = tokenKeys(scope, ['accountId', 'identityId']) ? { accountId: String(scope.accountId ?? ''), identityId: scope.identityId } : null;
  if (!tokenScope(result) || typeof scope.accountId === 'number' && !Number.isSafeInteger(scope.accountId)) fail('INVALID_SCOPE', 'Token 归属无效');
  return result;
};
const calendar = (at, timeZone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}-${parts.month}` };
};
const monthIndex = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
const monthAt = (index) => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
const bindingFields = (binding) => ({ scope: clone(binding.scope), origin: binding.origin,
  ...(binding.userTaskId === undefined ? {} : { userTaskId: binding.userTaskId }),
  ...(binding.activityId === undefined ? {} : { activityId: binding.activityId }) });
const sameWork = (a, b) => tokenSameScope(a.scope, b.scope) && a.origin === b.origin
  && a.userTaskId === b.userTaskId && a.activityId === b.activityId;

/** Token units only. This ledger never changes the separate time allowance. */
export class TokenBudget {
  constructor({ store, now = () => Date.now() } = {}) {
    if (typeof store?.read !== 'function' || typeof store?.update !== 'function' || typeof now !== 'function') fail('INVALID_CONFIG', 'Token 账本需要受管生活存储');
    this.store = store; this.now = now;
  }
  read() {
    try { return this.store.read(); } catch (error) {
      if (error instanceof LifeError) throw error;
      fail('STORAGE', 'Token 账本读取失败');
    }
  }
  update(change, { revision, authorize } = {}) {
    const at = iso(this.now());
    try { return this.store.update((state) => {
      const value = state.tokenBudget ||= emptyTokenBudget();
      const result = change(value, at);
      safe(Math.max(0, value.balanceTokens) + value.policy.dailyTokens);
      return result;
    }, { revision, authorize: authorizeWith(authorize) }); }
    catch (error) { if (error instanceof LifeError) throw error; fail('STORAGE', 'Token 账本保存失败'); }
  }
  transaction(value, row) {
    if (value.transactions.length >= TOKEN_BUDGET_LIMITS.transactions) fail('LIMIT', 'Token 收支记录已达容量上限');
    value.transactions.push(row);
  }
  sync(value, at) {
    const current = calendar(at, value.policy.timeZone);
    if (value.policy.enabled) {
      const first = value.lastMonth ? monthIndex(value.lastMonth) : monthIndex(current.month), last = monthIndex(current.month);
      if (last < first || last - first > 1200) fail('CLOCK', 'Token 账本日期异常，请核对时间');
      for (let index = first; index <= last; index++) {
        const month = monthAt(index);
        if (Object.hasOwn(value.grants, month)) continue;
        value.balanceTokens = safe(value.balanceTokens + value.policy.monthlyTokens);
        value.grants[month] = value.policy.monthlyTokens;
        this.transaction(value, { id: 'month:' + month, kind: 'monthly', at, month, tokens: value.policy.monthlyTokens });
      }
      value.lastMonth = current.month;
    }
    return current;
  }
  resources(value, day) {
    const holds = new Map();
    for (const row of value.requests) if (row.origin === 'autonomy' && row.reservedTokens > 0) {
      holds.set(row.day, safe((holds.get(row.day) || 0) + row.reservedTokens));
    }
    const dailyRemainingTokens = Math.max(0, value.policy.dailyTokens - (value.days[day] || 0));
    let pocketReserved = 0;
    for (const [startedDay, reserved] of holds) {
      pocketReserved = safe(pocketReserved + Math.max(0, reserved - Math.max(0, value.policy.dailyTokens - (value.days[startedDay] || 0))));
    }
    const todayReserved = Math.min(holds.get(day) || 0, dailyRemainingTokens);
    const available = safe(dailyRemainingTokens - todayReserved + value.balanceTokens - pocketReserved);
    return { dailyRemainingTokens, reservedTokens: sum([...holds.values()]),
      availableTokens: value.policy.enabled ? Math.max(0, available) : 0,
      overdrawnTokens: Math.max(0, -value.balanceTokens, -available) };
  }
  bindSession(sessionId, binding, options = {}) {
    if (!tokenId(sessionId, 512) || !tokenKeys(binding, ['scope', 'origin', 'userTaskId', 'activityId'])
      || !['user-task', 'autonomy'].includes(binding.origin)
      || binding.userTaskId !== undefined && !tokenId(binding.userTaskId)
      || binding.activityId !== undefined && !tokenId(binding.activityId)
      || binding.origin === 'user-task' && binding.activityId !== undefined
      || binding.origin === 'autonomy' && binding.userTaskId !== undefined) fail('INVALID_BINDING', 'Token 会话归属无效');
    const normalized = { ...binding, scope: scopeOf(binding.scope) };
    return this.update((value, at) => {
      const existing = value.sessions.find((row) => row.sessionId === sessionId);
      if (existing) {
        if (!tokenSameScope(existing.scope, normalized.scope) || existing.origin !== normalized.origin
          || existing.origin === 'autonomy' && existing.activityId !== normalized.activityId) fail('BINDING_CONFLICT', 'Token 会话归属不可替换');
        if (existing.userTaskId === normalized.userTaskId) return { duplicate: true, binding: existing };
        if (normalized.userTaskId === undefined) delete existing.userTaskId; else existing.userTaskId = normalized.userTaskId;
        return { binding: existing };
      }
      if (value.sessions.length >= TOKEN_BUDGET_LIMITS.sessions) fail('LIMIT', 'Token 会话记录已达容量上限');
      const row = { sessionId, ...bindingFields(normalized), boundAt: at, retiredAt: null };
      value.sessions.push(row); return { binding: row };
    }, options);
  }
  resolveBinding(sessionId) {
    if (!tokenId(sessionId, 512)) return null;
    return clone(this.read().state.tokenBudget?.sessions.find((row) => row.sessionId === sessionId) || null);
  }
  retireSession(sessionId, options = {}) {
    if (!tokenId(sessionId, 512)) fail('INVALID_BINDING', 'Token 会话归属无效');
    return this.update((value, at) => {
      const row = value.sessions.find((binding) => binding.sessionId === sessionId);
      if (!row) fail('NOT_FOUND', '没有受管 Token 会话');
      if (row.retiredAt) return { duplicate: true, binding: row };
      row.retiredAt = at; return { binding: row };
    }, options);
  }
  observe(event, options = {}) {
    if (!tokenKeys(event, ['requestId', 'sessionId', 'scope', 'origin', 'userTaskId', 'activityId', 'workId', 'provider', 'model', 'purpose', 'usage', 'status', 'at', 'finishReason'])
      || !tokenId(event.requestId) || !tokenId(event.sessionId, 512) || !['user-task', 'autonomy'].includes(event.origin)
      || !['started', 'usage', 'completed', 'failed', 'cancelled', 'unknown'].includes(event.status)
      || ['userTaskId', 'activityId', 'workId'].some((key) => event[key] !== undefined && !tokenId(event[key]))
      || event.finishReason !== undefined && !TOKEN_FINISH_REASONS.includes(event.finishReason)
      || ['provider', 'model'].some((key) => event[key] !== undefined && !tokenLabel(event[key]))
      || event.purpose !== undefined && !tokenLabel(event.purpose, 80)) fail('INVALID_EVENT', 'Token 用量事件无效');
    const scope = scopeOf(event.scope), at = iso(event.at ?? this.now());
    if (event.workId !== undefined && event.workId !== (event.origin === 'user-task' ? event.userTaskId : event.activityId)) fail('INVALID_EVENT', 'Token 任务归属不一致');
    return this.update((value, now) => {
      const binding = value.sessions.find((row) => row.sessionId === event.sessionId);
      if (!binding || !tokenSameScope(binding.scope, scope) || binding.origin !== event.origin) fail('UNBOUND', 'Token 请求没有有效会话归属');
      let row = value.requests.find((item) => item.requestId === event.requestId);
      const metadata = { scope, origin: event.origin, ...(event.userTaskId === undefined ? {} : { userTaskId: event.userTaskId }),
        ...(event.activityId === undefined ? {} : { activityId: event.activityId }) };
      if (row) {
        if (row.sessionId !== event.sessionId || !sameWork(row, metadata)
          || ['provider', 'model', 'purpose'].some((key) => event[key] !== undefined && event[key] !== row[key])) fail('BINDING_CONFLICT', 'Token 请求编号已属于其他调用');
        if (terminal(row) || event.status === 'started') return { allowed: event.status !== 'started', duplicate: true, request: row };
        if (at < row.updatedAt) return { allowed: true, ignored: true, request: row };
      } else {
        if (event.status !== 'started') fail('NOT_STARTED', 'Token 请求尚未登记开始');
        if (!sameWork(binding, metadata)) fail('BINDING_CONFLICT', 'Token 请求与会话任务归属不一致');
        if (binding.retiredAt) fail('RETIRED', 'Token 会话已结束，不能开始新调用');
        if (value.requests.length >= TOKEN_BUDGET_LIMITS.requests) fail('LIMIT', 'Token 请求记录已达容量上限');
        const current = this.sync(value, now), startedDay = calendar(at, value.policy.timeZone).day;
        if (event.origin === 'autonomy') {
          if (!value.policy.enabled) fail('DISABLED', '自主 Token 额度未启用');
          if (value.requests.some((item) => item.origin === 'autonomy' && item.unmetered && !item.acknowledgedUnmetered)) fail('UNMETERED', '有未核实的自主用量，请先确认旧调用已停止');
          if (value.balanceTokens < 0 || this.resources(value, startedDay).availableTokens < value.policy.requestReserveTokens) fail('LIMIT', '自主 Token 可用额度不足');
        }
        row = { requestId: event.requestId, sessionId: event.sessionId, ...bindingFields(metadata),
          provider: event.provider || 'unknown', model: event.model || 'unknown', purpose: event.purpose || 'unknown',
          startedAt: at, updatedAt: at, finishedAt: null, day: startedDay, status: 'started', usage: null,
          reservedTokens: event.origin === 'autonomy' ? value.policy.requestReserveTokens : 0,
          settledTokens: null, freeTokens: null, pocketTokens: null, unmetered: false, acknowledgedUnmetered: false, acknowledgedAt: null };
        value.requests.push(row); return { allowed: true, request: row };
      }
      const usage = normalizeTokenUsage(event.usage);
      if (event.status === 'usage') {
        if (!usage) return { allowed: true, ignored: true, request: row };
        row.usage = usage; row.status = 'usage'; row.updatedAt = at;
        if (row.origin === 'autonomy') row.reservedTokens = Math.max(row.reservedTokens, usage.totalTokens);
        return { allowed: true, request: row };
      }
      this.sync(value, now);
      if (usage) {
        row.usage = usage;
        if (row.origin === 'autonomy') row.reservedTokens = Math.max(row.reservedTokens, usage.totalTokens);
      }
      row.updatedAt = at; row.finishedAt = at;
      if (event.finishReason !== undefined) row.finishReason = event.finishReason;
      if (event.status === 'unknown' || (Object.hasOwn(event, 'usage') && !usage) || !row.usage) {
        row.status = 'unknown'; row.unmetered = true; return { allowed: true, request: row };
      }
      row.status = event.status; row.settledTokens = row.usage.totalTokens;
      row.freeTokens = row.origin === 'autonomy' ? Math.min(row.settledTokens, Math.max(0, value.policy.dailyTokens - (value.days[row.day] || 0))) : 0;
      row.pocketTokens = row.origin === 'autonomy' ? row.settledTokens - row.freeTokens : 0;
      row.reservedTokens = 0;
      if (row.origin === 'autonomy') {
        value.days[row.day] = safe((value.days[row.day] || 0) + row.freeTokens);
        value.balanceTokens = safe(value.balanceTokens - row.pocketTokens);
      }
      this.transaction(value, { id: 'spend:' + row.requestId, kind: row.origin === 'autonomy' ? 'spend' : 'user-task',
        at: now, requestId: row.requestId, scope: clone(row.scope), tokens: row.settledTokens, freeTokens: row.freeTokens, pocketTokens: row.pocketTokens });
      return { allowed: true, request: row };
    }, options);
  }
  configure(patch, { revision, authorize } = {}) {
    if (!tokenKeys(patch, Object.keys(DEFAULT_TOKEN_BUDGET_POLICY)) || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) fail('INVALID_PATCH', 'Token 设置需要有效版本与白名单字段');
    return this.update((value, at) => {
      if (value.requests.some((row) => !terminal(row) || row.origin === 'autonomy' && row.unmetered && !row.acknowledgedUnmetered))
        fail('BUSY', '请先结束当前调用或核实自主 Token 用量');
      const policy = { ...value.policy, ...patch };
      if (!tokenPolicy(policy)) fail('INVALID_PATCH', 'Token 额度设置无效');
      if (Object.keys(value.grants).length) this.sync(value, at);
      if (!value.policy.enabled && policy.enabled) value.lastMonth = null;
      value.policy = policy; this.sync(value, at); return { policy };
    }, { revision, authorize });
  }
  add(input, options = {}) {
    if (!tokenKeys(input, ['requestId', 'tokens']) || !tokenId(input.requestId) || !tokenInteger(input.tokens) || input.tokens < 1) fail('INVALID_PATCH', 'Token 发放参数无效');
    return this.update((value, at) => {
      const id = 'bonus:' + input.requestId, prior = value.transactions.find((row) => row.id === id);
      if (prior) {
        if (prior.tokens !== input.tokens) fail('BINDING_CONFLICT', 'Token 发放编号已用于其他额度');
        return { duplicate: true, addedTokens: prior.tokens };
      }
      this.sync(value, at); value.balanceTokens = safe(value.balanceTokens + input.tokens);
      this.transaction(value, { id, kind: 'bonus', at, requestId: input.requestId, tokens: input.tokens });
      return { addedTokens: input.tokens };
    }, options);
  }
  acknowledgeUnknown(id, { confirmedStopped, acknowledgedUnmetered, ...options } = {}) {
    if (!tokenId(id) || confirmedStopped !== true || acknowledgedUnmetered !== true) fail('INVALID_PATCH', '需要明确核实调用已停止且用量无法计量');
    return this.update((value, at) => {
      const row = value.requests.find((item) => item.requestId === id);
      if (!row?.unmetered || row.status !== 'unknown') fail('NOT_FOUND', '没有对应的未计量 Token 记录');
      if (row.acknowledgedUnmetered) return { duplicate: true, request: row, replayed: false };
      const released = row.reservedTokens;
      row.acknowledgedUnmetered = true; row.acknowledgedAt = at; row.reservedTokens = 0;
      this.transaction(value, { id: 'release:' + id, kind: 'unmetered-release', at, requestId: id, scope: clone(row.scope), tokens: released });
      return { request: row, releasedTokens: released, replayed: false };
    }, options);
  }
  recoverStartup(options = {}) {
    return this.update((value, at) => {
      let recovered = 0;
      for (const row of value.requests) if (!terminal(row)) {
        row.status = 'unknown'; row.unmetered = true; row.updatedAt = at; row.finishedAt = at; recovered++;
      }
      return { recovered, replayed: false };
    }, options);
  }
  snapshot({ scope } = {}) {
    const checked = scope === undefined ? null : scopeOf(scope);
    const { state, revision } = this.read(), value = clone(state.tokenBudget || emptyTokenBudget()), at = iso(this.now());
    const current = calendar(at, value.policy.timeZone);
    const requests = value.requests.filter((row) => !checked || tokenSameScope(row.scope, checked));
    const transactions = value.transactions.filter((row) => !checked || tokenSameScope(row.scope, checked));
    const today = { userTaskTokens: 0, autonomyTokens: 0, freeTokens: 0, pocketTokens: 0 };
    for (const row of requests) if (row.day === current.day && row.settledTokens !== null) {
      const key = row.origin === 'user-task' ? 'userTaskTokens' : 'autonomyTokens';
      today[key] = safe(today[key] + row.settledTokens); today.freeTokens = safe(today.freeTokens + row.freeTokens); today.pocketTokens = safe(today.pocketTokens + row.pocketTokens);
    }
    const resources = this.resources(value, current.day);
    // An unresolved autonomous receipt must stay actionable even after newer
    // user work fills the history. Acknowledging a page reveals the next one.
    const pending = requests.filter(row => row.origin === 'autonomy' && row.unmetered && !row.acknowledgedUnmetered).slice(-100);
    const pendingIds = new Set(pending.map(row => row.requestId));
    const remaining = 100 - pending.length;
    const recent = remaining ? requests.filter(row => !pendingIds.has(row.requestId)).slice(-remaining) : [];
    const visible = new Set([...pendingIds, ...recent.map(row => row.requestId)]);
    const visibleRequests = requests.filter(row => visible.has(row.requestId)).slice(-100).reverse();
    // Projection is admission information, never a persisted grant or balance.
    const projected = clone(value); this.sync(projected, at);
    const projectedResources = this.resources(projected, current.day);
    return { revision, sharedBudgetVisible: !checked,
      policy: checked ? null : clone(value.policy), balanceTokens: checked ? null : value.balanceTokens,
      pendingMonthlyTokens: checked ? null : safe(projected.balanceTokens - value.balanceTokens),
      projectedAvailableTokens: checked ? null : projectedResources.availableTokens,
      projectedOverdrawnTokens: checked ? null : projectedResources.overdrawnTokens,
      ...resources, ...(checked ? { dailyRemainingTokens: null, availableTokens: null, overdrawnTokens: null,
        reservedTokens: sum(requests.map((row) => row.reservedTokens)) } : {}),
      unmeteredCount: requests.filter((row) => row.unmetered).length,
      pendingUnknownCount: requests.filter((row) => row.unmetered && !row.acknowledgedUnmetered).length,
      pendingAutonomyUnknownCount: requests.filter((row) => row.origin === 'autonomy' && row.unmetered && !row.acknowledgedUnmetered).length,
      today, requests: clone(visibleRequests), transactions: clone(transactions.slice(-100).reverse()) };
  }
  context({ scope, origin } = {}) {
    if (!tokenScope(scope) || origin !== undefined && !['user-task', 'autonomy'].includes(origin)) return null;
    return this.snapshot({ scope });
  }
}
