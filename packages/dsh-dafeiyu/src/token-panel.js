import { LifeError, fail } from './life-store.js';

/** Same owner/CAS/runtime boundary as other settings, no model or probe calls. */
export function tokenOperation(getRuntime, action, body = {}, { authorize = () => false, runtime = getRuntime(), busy = () => false } = {}) {
  const current = () => authorize() === true && runtime === getRuntime();
  if (!current()) fail('FORBIDDEN', '需要当前本机主人权限');
  const budget = runtime?.tokenBudget;
  if (!budget) fail('UNAVAILABLE', 'Token 用量服务尚未就绪');
  if (action === 'status') {
    if (Object.keys(body).length) fail('INVALID_PATCH', 'Token 状态不接受其他账号或筛选参数');
    const value = budget.snapshot(); if (!current()) fail('CONFLICT', 'Token 服务已变化'); return value;
  }
  const keys = action === 'config' ? ['revision', 'patch'] : action === 'bonus' ? ['revision', 'requestId', 'tokens']
    : action === 'acknowledge' ? ['revision', 'requestId', 'confirmedStopped', 'acknowledgedUnmetered'] : [];
  if (!body || typeof body !== 'object' || Array.isArray(body) || !keys.length || Object.keys(body).some((key) => !keys.includes(key))
    || !/^[a-f0-9]{64}$/.test(body.revision || '')) fail('INVALID_PATCH', 'Token 操作需要当前版本和有效参数');
  if (busy() || Number(runtime.tokenAccounting?.active || 0) > 0 || runtime.autonomy?.active) fail('BUSY', '请先结束当前任务或自主活动，再调整 Token 额度');
  const options = { authorize: current, revision: body.revision };
  if (action === 'config') budget.configure(body.patch, options);
  else if (action === 'bonus') budget.add({ requestId: body.requestId, tokens: body.tokens }, options);
  else budget.acknowledgeUnknown(body.requestId, { ...options, confirmedStopped: body.confirmedStopped, acknowledgedUnmetered: body.acknowledgedUnmetered });
  if (!current()) fail('CONFLICT', 'Token 操作结果需刷新核对');
  return budget.snapshot();
}
export const tokenError = (error) => error instanceof LifeError ? error : new LifeError('UNAVAILABLE', 'Token 操作未确认，请刷新核对；未返回私人资料');
