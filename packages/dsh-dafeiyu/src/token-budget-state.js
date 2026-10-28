export const DEFAULT_TOKEN_BUDGET_POLICY = Object.freeze({ enabled: true, dailyTokens: 50000,
  monthlyTokens: 200000, requestReserveTokens: 16384, timeZone: 'Asia/Shanghai' });
export const TOKEN_BUDGET_LIMITS = Object.freeze({ sessions: 10000, requests: 10000, transactions: 30000 });
export const TOKEN_FINISH_REASONS = Object.freeze(['stop', 'tool-calls', 'max-tokens', 'aborted', 'error', 'stream-ended', 'consumer-closed']);
export const tokenObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
  && [Object.prototype, null].includes(Object.getPrototypeOf(x));
export const tokenInteger = (x) => Number.isSafeInteger(x) && x >= 0;
export const tokenId = (x, max = 160) => typeof x === 'string' && x.length <= max && /^[A-Za-z0-9_-][A-Za-z0-9:._-]*$/.test(x);
export const tokenLabel = (x, max = 160) => typeof x === 'string' && x.length > 0 && x.length <= max && /^[A-Za-z0-9_./:@+-]+$/.test(x);
export const tokenScope = (x) => tokenObject(x) && Object.keys(x).length === 2
  && typeof x.accountId === 'string' && /^[1-9]\d{0,19}$/.test(x.accountId)
  && typeof x.identityId === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(x.identityId);
export const tokenSameScope = (a, b) => tokenScope(a) && tokenScope(b) && a.accountId === b.accountId && a.identityId === b.identityId;
export const tokenKeys = (x, allowed) => tokenObject(x) && Object.keys(x).every((key) => allowed.includes(key));
const iso = (x) => typeof x === 'string' && x.length === 24 && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const day = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && Number.isFinite(Date.parse(x + 'T00:00:00Z'))
  && new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) === x;
const month = (x) => typeof x === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(x);
export function tokenPolicy(x) {
  if (!tokenKeys(x, Object.keys(DEFAULT_TOKEN_BUDGET_POLICY)) || Object.keys(x).length !== 5 || typeof x.enabled !== 'boolean'
    || !['dailyTokens', 'monthlyTokens', 'requestReserveTokens'].every((key) => tokenInteger(x[key]) && x[key] <= 1e12)
    || x.requestReserveTokens < 1 || typeof x.timeZone !== 'string' || x.timeZone.length > 80) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: x.timeZone }).format(0); return true; } catch { return false; }
}
const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
/** Absence is unknown. A provider aggregate is authoritative; reasoning is already output. */
export function normalizeTokenUsage(input) {
  if (!tokenKeys(input, usageKeys)) return null;
  const counts = {};
  for (const key of usageKeys.filter((key) => key !== 'totalTokens')) {
    if (input[key] === undefined) continue;
    if (!tokenInteger(input[key])) return null;
    counts[key] = input[key];
  }
  if (Object.hasOwn(input, 'totalTokens')) {
    if (!tokenInteger(input.totalTokens) || input.totalTokens < Math.max(counts.inputTokens || 0, counts.outputTokens || 0,
      counts.cacheReadTokens || 0, counts.cacheWriteTokens || 0)) return null;
    return { ...counts, totalTokens: input.totalTokens, source: 'provider-total' };
  }
  if (!tokenInteger(counts.inputTokens) || !tokenInteger(counts.outputTokens)) return null;
  const total = counts.inputTokens + counts.outputTokens + (counts.cacheReadTokens || 0) + (counts.cacheWriteTokens || 0);
  return Number.isSafeInteger(total) ? { ...counts, totalTokens: total, source: 'bucket-sum' } : null;
}
const validUsage = (x) => {
  if (!tokenKeys(x, [...usageKeys, 'source']) || !['provider-total', 'bucket-sum'].includes(x.source)) return false;
  const { source, ...counts } = x;
  if (source === 'bucket-sum') delete counts.totalTokens;
  const normalized = normalizeTokenUsage(counts);
  return normalized && normalized.totalTokens === x.totalTokens && normalized.source === source;
};
const bindingKeys = ['sessionId', 'scope', 'origin', 'userTaskId', 'activityId', 'boundAt', 'retiredAt'];
export const validTokenBinding = (x) => tokenKeys(x, bindingKeys) && tokenId(x.sessionId, 512) && tokenScope(x.scope)
  && ['user-task', 'autonomy'].includes(x.origin) && iso(x.boundAt) && (x.retiredAt === null || iso(x.retiredAt))
  && (x.userTaskId === undefined || tokenId(x.userTaskId)) && (x.activityId === undefined || tokenId(x.activityId))
  && (x.origin === 'user-task' ? x.activityId === undefined : x.userTaskId === undefined);
export const emptyTokenBudget = () => ({ version: 1, policy: { ...DEFAULT_TOKEN_BUDGET_POLICY }, balanceTokens: 0,
  days: {}, grants: {}, lastMonth: null, sessions: [], requests: [], transactions: [] });

/** Optional LifeStore state is fail-closed, including ledger sums and references. */
export function validTokenBudgetState(x) {
  if (!tokenKeys(x, ['version', 'policy', 'balanceTokens', 'days', 'grants', 'lastMonth', 'sessions', 'requests', 'transactions'])
    || x.version !== 1 || !tokenPolicy(x.policy) || !Number.isSafeInteger(x.balanceTokens)
    || !tokenObject(x.days) || !tokenObject(x.grants) || !(x.lastMonth === null || month(x.lastMonth))
    || !Array.isArray(x.sessions) || x.sessions.length > TOKEN_BUDGET_LIMITS.sessions || !x.sessions.every(validTokenBinding)
    || !Array.isArray(x.requests) || x.requests.length > TOKEN_BUDGET_LIMITS.requests
    || !Array.isArray(x.transactions) || x.transactions.length > TOKEN_BUDGET_LIMITS.transactions
    || !Object.entries(x.days).every(([key, value]) => day(key) && tokenInteger(value))
    || !Object.entries(x.grants).every(([key, value]) => month(key) && tokenInteger(value))) return false;
  const sessions = new Map(x.sessions.map((row) => [row.sessionId, row]));
  if (sessions.size !== x.sessions.length) return false;
  const ids = new Set(), days = {}, requests = new Map();
  for (const row of x.requests) {
    const binding = sessions.get(row?.sessionId);
    if (!tokenKeys(row, ['requestId', 'sessionId', 'scope', 'origin', 'userTaskId', 'activityId', 'provider', 'model', 'purpose',
      'startedAt', 'updatedAt', 'finishedAt', 'day', 'status', 'usage', 'reservedTokens', 'settledTokens', 'freeTokens', 'pocketTokens',
      'unmetered', 'acknowledgedUnmetered', 'acknowledgedAt', 'finishReason']) || !tokenId(row.requestId) || ids.has(row.requestId)
      || !binding || !tokenSameScope(row.scope, binding.scope) || row.origin !== binding.origin
      || (row.userTaskId !== undefined && !tokenId(row.userTaskId)) || (row.activityId !== undefined && !tokenId(row.activityId))
      || (row.origin === 'autonomy' ? row.userTaskId !== undefined || row.activityId !== binding.activityId : row.activityId !== undefined)
      || !tokenLabel(row.provider) || !tokenLabel(row.model) || !tokenLabel(row.purpose, 80)
      || !iso(row.startedAt) || !iso(row.updatedAt) || row.updatedAt < row.startedAt || !day(row.day)
      || !['started', 'usage', 'completed', 'failed', 'cancelled', 'unknown'].includes(row.status)
      || !tokenInteger(row.reservedTokens) || !(row.usage === null || validUsage(row.usage))
      || typeof row.unmetered !== 'boolean' || typeof row.acknowledgedUnmetered !== 'boolean'
      || !(row.acknowledgedAt === null || iso(row.acknowledgedAt))
      || row.finishReason !== undefined && !TOKEN_FINISH_REASONS.includes(row.finishReason)) return false;
    const pending = ['started', 'usage'].includes(row.status), settled = row.settledTokens !== null;
    if (pending && (row.finishedAt !== null || settled || row.unmetered || row.acknowledgedUnmetered || row.acknowledgedAt !== null)
      || !pending && (!iso(row.finishedAt) || row.finishedAt < row.startedAt)
      || row.status === 'usage' && !row.usage
      || row.unmetered !== (!pending && !settled)
      || row.unmetered && row.status !== 'unknown'
      || row.acknowledgedUnmetered !== (row.acknowledgedAt !== null)
      || row.acknowledgedUnmetered && !row.unmetered
      || settled && (!row.usage || row.settledTokens !== row.usage.totalTokens || !tokenInteger(row.freeTokens) || !tokenInteger(row.pocketTokens))
      || !settled && (row.freeTokens !== null || row.pocketTokens !== null)
      || (settled || row.acknowledgedUnmetered || row.origin === 'user-task') && row.reservedTokens !== 0
      || row.origin === 'autonomy' && !settled && !row.acknowledgedUnmetered && row.reservedTokens < 1
      || settled && (row.origin === 'autonomy' ? row.freeTokens + row.pocketTokens !== row.settledTokens : row.freeTokens !== 0 || row.pocketTokens !== 0)) return false;
    if (settled && row.origin === 'autonomy') days[row.day] = (days[row.day] || 0) + row.freeTokens;
    ids.add(row.requestId); requests.set(row.requestId, row);
  }
  if (JSON.stringify(Object.entries(days).filter(([, value]) => value !== 0).sort()) !== JSON.stringify(Object.entries(x.days).filter(([, value]) => value !== 0).sort())) return false;
  let balance = 0; const transactionIds = new Set(), spends = new Set(), releases = new Set(), months = new Set();
  for (const row of x.transactions) {
    if (!tokenKeys(row, ['id', 'kind', 'at', 'tokens', 'requestId', 'scope', 'month', 'freeTokens', 'pocketTokens'])
      || !tokenId(row.id, 180) || transactionIds.has(row.id) || !iso(row.at) || !tokenInteger(row.tokens)) return false;
    transactionIds.add(row.id);
    if (row.kind === 'monthly') {
      if (!month(row.month) || row.id !== 'month:' + row.month || x.grants[row.month] !== row.tokens || months.has(row.month)
        || ['requestId', 'scope', 'freeTokens', 'pocketTokens'].some((key) => row[key] !== undefined)) return false;
      months.add(row.month); balance += row.tokens;
    } else if (row.kind === 'bonus') {
      if (!tokenId(row.requestId) || row.id !== 'bonus:' + row.requestId || row.tokens < 1
        || ['scope', 'month', 'freeTokens', 'pocketTokens'].some((key) => row[key] !== undefined)) return false;
      balance += row.tokens;
    } else {
      const request = requests.get(row.requestId);
      if (!request || !tokenSameScope(row.scope, request.scope) || row.month !== undefined) return false;
      if (['spend', 'user-task'].includes(row.kind)) {
        if (request.settledTokens === null || row.tokens !== request.settledTokens || row.freeTokens !== request.freeTokens
          || row.pocketTokens !== request.pocketTokens || row.id !== 'spend:' + row.requestId || spends.has(row.requestId)
          || row.kind !== (request.origin === 'autonomy' ? 'spend' : 'user-task')) return false;
        spends.add(row.requestId); balance -= row.pocketTokens;
      } else if (row.kind === 'unmetered-release') {
        if (!request.acknowledgedUnmetered || row.id !== 'release:' + row.requestId || releases.has(row.requestId)
          || row.freeTokens !== undefined || row.pocketTokens !== undefined) return false;
        releases.add(row.requestId);
      } else return false;
    }
    if (!Number.isSafeInteger(balance)) return false;
  }
  return balance === x.balanceTokens && months.size === Object.keys(x.grants).length
    && [...requests.values()].every((row) => (row.settledTokens !== null) === spends.has(row.requestId)
      && row.acknowledgedUnmetered === releases.has(row.requestId));
}
