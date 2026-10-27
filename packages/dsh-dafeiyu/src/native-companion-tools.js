/** Small native tools; execution identity comes from the host, never tool arguments. */
import { experienceTools, experienceScope, EXPERIENCE_TOOL_NAMES } from './experience-tools.js';
import { validateToolArguments } from '../../companion/src/tool-loop.js';

export class NativeCompanionTools {
  constructor({ memoryBridge, lifeMemory, getAutonomy, memeManager, getExecutionContext, phoneEnabled = false,
    sttAvailable = false, allowMemoryWrites = false } = {}) {
    Object.assign(this, { memoryBridge, lifeMemory, getAutonomy, memeManager, getExecutionContext, phoneEnabled,
      sttAvailable, allowMemoryWrites });
    this.disposers = [];
    this.closed = false;
  }

  registerToCordis(ctx) {
    const memoryContext = (exec) => {
      const identity = this.getExecutionContext?.(exec);
      return { accountId: this.memoryBridge.accountId,
        ...(identity?.accountProfile?.identity?.id ? { identityId: identity.accountProfile.identity.id } : {}),
        ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}) };
    };
    const memoryAuthorize = (exec) => () => {
      const identity = this.getExecutionContext?.(exec);
      return !this.closed && !exec?.signal?.aborted && identity?.isOwner === true
        && (identity.scope === 'c2c' || identity.scope === 'desktop' && identity.trusted === true);
    };
    const mutationProperties = { id: { type: 'string', minLength: 1, maxLength: 100, description: '检索返回的稳定记忆 ID；不要编造' },
      revision: { type: 'string', minLength: 64, maxLength: 64, description: '本次检索返回的 revision；冲突应先重读，不能自动重试覆盖' },
      reason: { type: 'string', maxLength: 500 } };
    const definitions = [
      ...(this.lifeMemory ? experienceTools({ memory: this.lifeMemory, getExecutionContext: this.getExecutionContext, owner: this.memoryBridge.accountId, enabled: () => this.allowMemoryWrites || this.lifeMemory.policy().learningEnabled, isClosed: () => this.closed }) : []),
      {
        name: 'dafeiyu_status', description: '读取伴侣实际配置状态；不探测手机、不连接设备',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ ok: true, phone: { enabled: this.phoneEnabled,
          state: this.phoneEnabled ? 'not-probed' : 'offline',
          note: this.phoneEnabled ? '尚未探测，不能声称在线' : '手机当前不可连接，未尝试重连' },
          speechRecognitionConfigured: this.sttAvailable,
          speechRecognitionReadiness: 'not-verified',
          speechRecognitionNote: '仅表示已配置服务接口；未检查模型缓存，也未实际转写音频',
          personalQQ: this.getPersonalQQStatus?.() || { configured: false, enabled: false, connected: false },
          conversationEngine: 'native-dsh', memory: 'owner-private' }),
      },
      {
        name: 'dafeiyu_life_status', description: '读取当前账号身份的近期记忆、成长和娱乐时间额度，不安排活动或改变余额；这些状态不授予权限。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async (_args, exec) => {
          const identity = this.getExecutionContext?.(exec), scope = { accountId: identity?.peerId || this.memoryBridge.accountId, identityId: identity?.accountProfile?.identity?.id || 'default' };
          const memory = this.lifeMemory?.snapshot(scope), wallet = this.getAutonomy?.()?.wallet.snapshot();
          return { ok: true, memory: memory ? { total: memory.total, policy: memory.policy, error: memory.error, growthCount: memory.growth.length } : null,
            wallet: wallet ? { enabled: wallet.policy.enabled, balanceSeconds: wallet.balance, dailyRemainingSeconds: wallet.dailyRemainingSeconds } : null };
        },
      },
      {
        name: 'dafeiyu_remember', description: '仅在真实用户明确要求长期记住时保存，不把临时要求、角色扮演或 AI 猜测自动变成事实。account 为本人共有，identity 为当前扮演身份；来源是工具声明，不代表已核对原话。推断用 inference，待用户确认前不作为有效事实。成功回执后才可说明实际保存范围。',
        parameters: { type: 'object', properties: {
          kind: { type: 'string', enum: ['fact', 'event'], default: 'fact' },
          key: { type: 'string', minLength: 1, maxLength: 160, description: '稳定事实键，例如 favorite-drink；更新已有事实时复用同一键' },
          summary: { type: 'string', minLength: 1, maxLength: 160 },
          detail: { type: 'string', minLength: 1, maxLength: 2000 },
          scope: { type: 'string', enum: ['account', 'identity'], default: 'account' },
          sourceType: { type: 'string', enum: ['user_explicit', 'inference'], default: 'user_explicit' },
        }, required: ['summary', 'detail'], additionalProperties: false },
        execute: async (args, exec) => {
          if (!this.allowMemoryWrites) return { ok: false, error: '当前未开启共享记忆写入' };
          return this.memoryBridge.remember(args, { context: memoryContext(exec), actor: 'tool', authorize: memoryAuthorize(exec) });
        },
      },
      {
        name: 'dafeiyu_memory_index', description: '检索当前主人有效长期记忆的标题、来源和短命中片段；先查目录，再按稳定ID读取所需正文。支持关键词与分页，不是语义搜索。不包含已停用或未确认事实，不改变记忆。',
        parameters: { type: 'object', properties: {
          query: { type: 'string', maxLength: 200 }, kind: { type: 'string', enum: ['all', 'fact', 'event'], default: 'all' },
          offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
        }, additionalProperties: false },
        execute: async ({ query = '', kind = 'all', offset = 0, limit = 10 }, exec) => this.memoryBridge.indexMemories(query,
          { kind, offset, limit, maxChars: 8000, memoryContext: memoryContext(exec) }),
      },
      {
        name: 'dafeiyu_memory_read', description: '读取长期目录返回的稳定ID所指正文，必须带同次revision；正文分段返回，继续时用nextOffset。版本变化先重新检索，不凭标题猜ID，不跨账号身份；读取不会强化或写入记忆。',
        parameters: { type: 'object', properties: {
          id: mutationProperties.id, revision: mutationProperties.revision,
          offset: { type: 'integer', minimum: 0, maximum: 8388608, default: 0 },
          maxChars: { type: 'integer', minimum: 100, maximum: 12000, default: 4000 },
        }, required: ['id', 'revision'], additionalProperties: false },
        execute: async ({ id, revision, offset = 0, maxChars = 4000 }, exec) => this.memoryBridge.readMemory(id,
          { revision, offset, maxChars, memoryContext: memoryContext(exec) }),
      },
      {
        name: 'dafeiyu_memory_search', description: '按关键词检索共享长期事实、主人档案与完整旧手账；只对实际主人会话开放。truncated 表示结果尚未完整返回',
        parameters: { type: 'object', properties: {
          query: { type: 'string', minLength: 1, maxLength: 200 },
          kind: { type: 'string', enum: ['all', 'fact', 'event'], default: 'all' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
        }, required: ['query'], additionalProperties: false },
        execute: async ({ query, kind = 'all', limit = 10 }, exec) => this.memoryBridge.searchMemories(query,
          { kind, limit, maxChars: 16000, memoryContext: memoryContext(exec) }),
      },
      {
        name: 'dafeiyu_memory_correct', description: '用户明确纠正、否认或更新已保存信息时，先检索并指明稳定 ID 与 revision 后更正。不能凭同名猜对象。旧原文将退出有效记忆；保留可撤销的更正历史。',
        parameters: { type: 'object', properties: { ...mutationProperties,
          summary: { type: 'string', minLength: 1, maxLength: 160 }, detail: { type: 'string', minLength: 1, maxLength: 2000 },
          sourceType: { type: 'string', enum: ['user_explicit', 'inference'], default: 'user_explicit' } },
        required: ['id', 'revision', 'summary', 'detail'], additionalProperties: false },
        execute: async (args, exec) => {
          if (!this.allowMemoryWrites) return { ok: false, error: '当前未开启共享记忆写入' };
          return this.memoryBridge.correct(args, { context: memoryContext(exec), actor: 'tool', authorize: memoryAuthorize(exec) });
        },
      },
      ...['forget', 'restore', 'delete'].map((action) => ({
        name: `dafeiyu_memory_${action}`, description: action === 'delete' ? '仅在用户明确要求删除时调用：删除此条受管记忆的原文和更正历史，不清除DSH聊天或外部备份。先检索并核对稳定ID与revision，不可把停用当删除。' : action === 'forget'
          ? '用户明确要求忘掉/撤回一条记忆时，先检索确认稳定 ID 与 revision，再停用。停用不擦除原档案、历史聊天或备份，已有聊天中的引用仍可能存在；不可宣称已彻底删除。'
          : '用户明确要求撤销对指定记忆的最近一次更正或停用时使用；按操作顺序撤销，先核对稳定 ID 与最新 revision。',
        parameters: { type: 'object', properties: mutationProperties, required: ['id', 'revision'], additionalProperties: false },
        execute: async (args, exec) => {
          if (!this.allowMemoryWrites) return { ok: false, error: '当前未开启共享记忆写入' };
          return this.memoryBridge[action](args, { context: memoryContext(exec), actor: 'tool', authorize: memoryAuthorize(exec) });
        },
      })),
      {
        name: 'dafeiyu_meme_list', description: '列出共享表情图库；返回的是文件与标签，不代表已完成视觉识别或发送',
        parameters: { type: 'object', properties: {
          query: { type: 'string', maxLength: 200 },
        }, additionalProperties: false },
        execute: async ({ query = '' } = {}) => ({
          ...(typeof this.memeManager.searchMemes === 'function'
            ? this.memeManager.searchMemes(query, { limit: 100 })
            : { ok: true, memes: this.memeManager.listMemes().slice(0, 100) }),
          note: '文件名与标签不等于视觉识别；发送请使用当前 QQ 通道已有的媒体工具，桌面只回复当前会话，不可把路径当成已发送',
        }),
      },
    ];
    for (const definition of definitions) {
      const execute = definition.execute;
      definition.execute = async (args = {}, exec) => {
        if (this.closed) throw new Error('伴侣工具已卸载');
        const identity = this.getExecutionContext?.(exec);
        const publicStatus = definition.name === 'dafeiyu_status' && exec?.agent?.session?.id && typeof exec.agent.ctx?.get === 'function';
        const ownerPrivate = identity?.isOwner === true && identity.scope === 'c2c';
        const trustedDesktop = identity?.isOwner === true && identity.scope === 'desktop' && identity.trusted === true;
        if (!publicStatus && !ownerPrivate && !trustedDesktop && !(EXPERIENCE_TOOL_NAMES.includes(definition.name) && experienceScope(identity, this.memoryBridge.accountId))) throw new Error(identity?.reason || '仅绑定主人私聊或可信桌面会话可使用伴侣工具');
        validateToolArguments(args, definition.parameters);
        if (exec?.signal?.aborted) throw new Error('会话已取消');
        try { return await execute(args, exec); }
        catch (error) {
          if (exec?.signal?.aborted) throw error;
          return { ok: false, error: error.message || String(error) };
        }
      };
      definition.output = { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
      const dispose = ctx.tools.register(definition);
      if (typeof dispose === 'function') this.disposers.push(dispose);
    }
    return definitions;
  }

  dispose() {
    this.closed = true;
    const failures = [];
    for (const dispose of this.disposers.splice(0).reverse()) {
      try { dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, '部分伴侣工具注销失败');
  }
}
