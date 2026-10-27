import { validScope, sameScope, fail } from './life-store.js';
export const EXPERIENCE_TOOL_NAMES = Object.freeze(['dafeiyu_experience_search', 'dafeiyu_experience_update']);

export function experienceScope(identity, owner) {
  const accountId = identity?.peerId || (identity?.isOwner ? owner : '');
  const scope = { accountId, identityId: identity?.accountProfile?.identity?.id || (identity?.isOwner ? 'default' : '') };
  const trusted = identity?.isOwner && (identity.scope === 'c2c' || identity.scope === 'desktop' && identity.trusted)
    || identity?.channel === 'onebot' && identity.scope === 'c2c' && identity.accountProfile?.account?.qq === accountId;
  return trusted && validScope(scope) ? scope : null;
}
export function experienceTools({ memory, getExecutionContext, owner, enabled = true, isClosed }) {
  const canWrite = () => typeof enabled === 'function' ? enabled() : enabled;
  const scopeFor = (exec) => experienceScope(getExecutionContext(exec), owner);
  const options = (exec) => { const scope = scopeFor(exec); return { scope, authorize: () => canWrite() && !isClosed() && !exec?.signal?.aborted && sameScope(scope, scopeFor(exec)) }; };
  return [
    { name: EXPERIENCE_TOOL_NAMES[0], description: '检索本人当前身份的近期经历及概要；只能看到本账号本身份。用offset/limit翻页，nextOffset为null表示末页。需要完整条目时，带已查到的id与recallRevision读取；过期内容仍只返回概要，停用条目不可读取。recallRevision只反映本身份记忆变化，不受Token记账影响；检索不会强化记忆。',
      parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 200 },
        offset: { type: 'integer', minimum: 0, maximum: 5000 }, limit: { type: 'integer', minimum: 1, maximum: 20 },
        id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, recallRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        revision: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, additionalProperties: false },
      execute: async (args, exec) => {
        const scope = scopeFor(exec); if (!scope) return { ok: false, error: '当前身份未验证' };
        return { ok: true, ...memory.recall(scope, args) };
      } },
    { name: EXPERIENCE_TOOL_NAMES[1], description: '仅在本人明确纠正、要求忘掉/删除、固定保留、更新约定或撤销时管理已检索的经历。先核对稳定ID，优先带搜索返回的recallRevision；兼容旧revision。recallRevision不因Token记账变化失效，记忆或策略变化仍须重新检索。delete会清除受管经历及派生内容，但不清除DSH聊天和外部备份。不能把临时扮演或引用资料写成真实事实。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['correct', 'forget', 'delete', 'restore', 'pin', 'pending'] },
        id: { type: 'string', minLength: 64, maxLength: 64 }, revision: { type: 'string', minLength: 64, maxLength: 64 },
        recallRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        detail: { type: 'string', minLength: 1, maxLength: 12000 }, value: { type: 'boolean' } }, required: ['action', 'id'], additionalProperties: false },
      execute: async ({ action, revision, recallRevision, ...input }, exec) => {
        const scope = scopeFor(exec); if (!scope || !canWrite()) return { ok: false, error: '当前身份记忆写入未启用' };
        if (revision === undefined && recallRevision === undefined) fail('INVALID_PATCH', '经历操作需要检索返回的版本');
        const result = memory.manage(action, input, { ...options(exec), revision, recallRevision });
        if (result.result?.history) {
          const { history, assistantText, ...current } = result.result;
          const clarity = memory.clarity(current, memory.policy());
          result.result = current.status !== 'active' ? { id: current.id, status: current.status }
            : { ...current, clarity, detail: clarity === 'clear' ? current.detail.slice(0, 1200) : current.summary,
              detailOmitted: clarity !== 'clear' || current.detail.length > 1200 };
        }
        return result;
      } },
  ];
}
