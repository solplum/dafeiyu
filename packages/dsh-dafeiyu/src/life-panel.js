import { LifeError, fail } from './life-store.js';

/** Local owner administration. Account and identity for a record come from storage. */
export async function lifeOperation(getRuntime, action, body = {}, { authorize = () => false, runtime = getRuntime() } = {}) {
  const current = () => authorize() === true && runtime === getRuntime();
  if (!current()) fail('FORBIDDEN', '需要当前本机主人权限');
  const memory = runtime?.lifeMemory, autonomy = runtime?.autonomy;
  if (!memory || !autonomy) fail('UNAVAILABLE', '生活与成长服务尚未就绪');
  const read = () => {
    const snapshot = memory.snapshot(body);
    const value = autonomy.snapshot();
    value.wallet.transactions = value.wallet.transactions.slice(-100);
    value.wallet.sessions = value.wallet.sessions.slice(-50);
    value.activities = value.activities.slice(-100);
    return { memory: snapshot, autonomy: value, preview: autonomy.preview() };
  };
  if (action === 'snapshot') {
    if (Object.keys(body).some((key) => !['accountId', 'identityId', 'query', 'offset', 'limit'].includes(key))
      || Object.values(body).some((value) => typeof value !== 'string' && !Number.isInteger(value))) fail('INVALID_PATCH', '生活记录筛选无效');
    const result = read(); if (!current()) fail('CONFLICT', '运行实例已变化'); return result;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['revision', 'patch', 'id', 'value', 'detail', 'requestId', 'seconds', 'confirmedStopped'].includes(key))
    || action !== 'cancel' && !/^[a-f0-9]{64}$/.test(body.revision || '')) fail('INVALID_PATCH', '生活记录操作参数无效');
  const options = { authorize: current, revision: body.revision };
  if (!['cancel', 'autonomy-policy'].includes(action) && (runtime.nativeOneBot?.status?.pending > 0 || runtime.incomingPending > 0 || autonomy.active)) fail('BUSY', '请先完成对话或暂停自主活动');
  let result;
  if (action === 'memory-policy') result = memory.configure(body.patch, options);
  else if (action === 'wallet-policy') result = autonomy.wallet.configure(body.patch, options);
  else if (action === 'autonomy-policy') result = autonomy.configure(body.patch, options);
  else if (action === 'bonus') result = autonomy.wallet.add(body, options);
  else if (action === 'cancel') result = await autonomy.cancel();
  else if (action === 'acknowledge') {
    if (body.confirmedStopped !== true) fail('INVALID_PATCH', '请先核实旧活动已停止');
    if (autonomy.wallet.snapshot().sessions.some((row) => row.id === body.id && row.status === 'unknown'))
      result = autonomy.wallet.acknowledge(body.id, { ...options, confirmedStopped: true });
    else if (!autonomy.snapshot().activities.some((row) => row.id === body.id && row.status === 'unknown')) fail('NOT_FOUND', '待核实活动不存在');
    memory.store.update((state) => {
      const row = state.autonomy?.activities.find((item) => item.id === body.id && item.status === 'unknown');
      if (row) row.status = 'interrupted';
    }, { authorize: current });
  } else if (action.startsWith('growth-')) {
    const row = memory.snapshot().growth.find((item) => item.id === body.id);
    if (!row) fail('NOT_FOUND', '成长记录不存在');
    result = memory.growth.manage(action.slice(7), body, { ...options, scope: row.scope });
  } else if (['correct', 'pin', 'pending', 'forget', 'restore', 'delete'].includes(action)) {
    const row = memory.snapshot({ limit: 5000 }).items.find((item) => item.id === body.id);
    if (!row) fail('NOT_FOUND', '记忆记录不存在');
    result = memory.manage(action, body, { ...options, scope: row.scope });
  } else fail('INVALID_PATCH', '生活记录操作不支持');
  if (!current()) fail('CONFLICT', '授权或运行实例已变化，请重新读取核对保存结果');
  return { result, ...readSnapshot(memory, autonomy) };
}
function readSnapshot(memory, autonomy) {
  const snapshot = autonomy.snapshot(); snapshot.activities = snapshot.activities.slice(-100);
  snapshot.wallet.transactions = snapshot.wallet.transactions.slice(-100); snapshot.wallet.sessions = snapshot.wallet.sessions.slice(-50);
  return { memory: memory.snapshot(), autonomy: snapshot, preview: autonomy.preview() };
}
export const lifeError = (error) => error instanceof LifeError ? error : new LifeError('UNAVAILABLE', '生活操作未确认，请刷新核对；未返回私人文件内容');
