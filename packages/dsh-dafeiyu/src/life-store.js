import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validTokenBudgetState } from './token-budget-state.js';

export class LifeError extends Error {
  constructor(code, message) { super(message); this.name = 'LifeError'; this.code = code; }
}
export const fail = (code, message) => { throw new LifeError(code, message); };
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const authorized = (check) => { if (typeof check !== 'function' || check() !== true) fail('FORBIDDEN', '当前授权已失效'); };
export const validScope = (scope) => scope && /^[1-9]\d{0,19}$/.test(scope.accountId || '')
  && /^[A-Za-z0-9_-]{1,48}$/.test(scope.identityId || '');
export const sameScope = (a, b) => validScope(a) && validScope(b) && a.accountId === b.accountId && a.identityId === b.identityId;
export const text = (value, max = 12000) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max) : '';
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function validate(state) {
  if (state?.tokenBudget !== undefined && !validTokenBudgetState(state.tokenBudget)) fail('STORAGE', 'Token 账本结构或收支无效，已停止读写');
  if (state?.version !== 1 || !object(state.policy) || typeof state.policy.learningEnabled !== 'boolean'
    || !Array.isArray(state.memories) || state.memories.length > 5000 || !Array.isArray(state.seen) || !Array.isArray(state.growth)
    || state.seen.some((id) => !/^[a-f0-9]{64}$/.test(id))
    || state.memories.some((row) => !/^[a-f0-9]{64}$/.test(row?.id || '') || !validScope(row.scope)
      || !['active', 'inactive'].includes(row.status) || !['user_statement', 'browser_summary'].includes(row.source?.type)
      || typeof row.detail !== 'string' || row.detail.length > 12000 || typeof row.summary !== 'string' || row.summary.length > 160
      || !Number.isFinite(Date.parse(row.at)) || !Array.isArray(row.history) || row.history.length > 10
      || typeof row.pinned !== 'boolean' || typeof row.pending !== 'boolean')) fail('STORAGE', '生活记忆结构无效，已停止读写');
  const byId = new Map(state.memories.map((row) => [row.id, row])), ids = new Set(byId.keys());
  if (ids.size !== state.memories.length || new Set(state.seen).size !== state.seen.length
    || state.growth.some((row) => !validScope(row.scope) || !Array.isArray(row.evidence)
      || row.evidence.some((id) => !sameScope(byId.get(id)?.scope, row.scope))
      || !['candidate', 'applied', 'reverted'].includes(row.status))) fail('STORAGE', '成长来源或去重记录无效');
  if (state.wallet && (!object(state.wallet.policy) || !integer(state.wallet.balance)
    || !integer(state.wallet.policy.dailySeconds) || !integer(state.wallet.policy.monthlySeconds)
    || !object(state.wallet.days) || Object.values(state.wallet.days).some((value) => !integer(value))
    || !object(state.wallet.grants) || Object.values(state.wallet.grants).some((value) => !integer(value))
    || !Array.isArray(state.wallet.transactions) || state.wallet.transactions.some((row) => !integer(row.seconds))
    || !Array.isArray(state.wallet.sessions) || state.wallet.sessions.some((row) => !integer(row.charged) || !integer(row.baseSeconds) || !integer(row.allowanceSeconds)
      || row.charged !== row.baseSeconds + row.allowanceSeconds || !['running', 'finished', 'unknown', 'interrupted'].includes(row.status)))) fail('STORAGE', '时间账本结构或收支无效');
  if (state.autonomy && (!object(state.autonomy.policy) || !Array.isArray(state.autonomy.activities) || state.autonomy.activities.length > 1000
    || !Array.isArray(state.autonomy.awaitingReply) || state.autonomy.activities.some((row) => !validScope(row.scope)
      || !['scheduled', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'skipped', 'interrupted'].includes(row.status)))) fail('STORAGE', '自主活动记录无效');
}

/** One private transaction boundary for memory, growth and allowance. Reads never create files. */
export class LifeStore {
  constructor({ directory, now = () => Date.now() }) {
    this.file = path.join(directory, 'life.json'); this.lock = path.join(directory, '.life.lock'); this.now = now;
  }
  read() {
    let bytes;
    try { const stat = fs.lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) fail('STORAGE', '生活记录不是受管普通文件'); bytes = fs.readFileSync(this.file); } catch (error) { if (error.code !== 'ENOENT') fail('STORAGE', '生活记录读取失败'); }
    let state;
    try { state = bytes ? JSON.parse(bytes) : { version: 1, policy: { learningEnabled: false, detailedDays: 3, summaryDays: 30 }, memories: [], seen: [], growth: [] }; }
    catch { fail('STORAGE', '生活记录已损坏，已停止读写，未回退旧内容'); }
    if (bytes?.length > 16 * 1024 * 1024) fail('STORAGE', '生活记录超过容量上限');
    validate(state);
    return { state, revision: digest(bytes || 'empty-life-v1') };
  }
  update(change, { revision, authorize = () => false } = {}) {
    authorized(authorize);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(this.lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('BUSY', '生活记录正在保存，请稍后重试'); throw error; }
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    try {
      const before = this.read();
      if (revision !== undefined && revision !== before.revision) fail('CONFLICT', '记录已变化，请刷新核对');
      const result = change(before.state);
      validate(before.state);
      const bytes = Buffer.from(JSON.stringify(before.state, null, 2) + '\n');
      if (bytes.length > 16 * 1024 * 1024) fail('LIMIT', '生活记录已达容量上限，请整理后重试');
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      authorized(authorize);
      if (this.read().revision !== before.revision) fail('CONFLICT', '保存前记录被修改，未覆盖');
      fs.renameSync(tmp, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } catch { fail('SAVE_UNCERTAIN', '已替换记录，但持久化结果需重新读取核对'); } finally { fs.closeSync(directory); }
      return { ok: true, revision: digest(bytes), result: clone(result ?? null) };
    } finally { fs.rmSync(tmp, { force: true }); fs.rmdirSync(this.lock); }
  }
}
