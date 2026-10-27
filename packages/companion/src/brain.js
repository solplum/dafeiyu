/**
 * 大脑 · 把消息变成回复
 * ─────────────────────────────────────────────────────────────
 * 这一层只做三件事：
 *   1. 组装上下文（角色卡 + 记忆 + 最近的对话 + 当前处境）
 *   2. 调模型
 *   3. 把这一轮写回记忆
 *
 * 它不关心消息从哪来（QQ / 微信 / 命令行都行），
 * 也不关心怎么发出去（那是 transport 的事）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Memory } from './memory.js';
import { Role } from './role.js';
import { runToolLoop } from './tool-loop.js';

export class Brain {
  /**
   * @param {object} opts
   * @param {string}  opts.apiKey
   * @param {string}  [opts.baseUrl]   默认 https://api.deepseek.com/v1
   * @param {string}  [opts.model]     默认 deepseek-chat
   * @param {number}  [opts.timeoutMs] 默认 120000
   * @param {Role}    opts.role
   * @param {Memory}  opts.memory
   * @param {function} [opts.wrapModelRequest] Wrap each single HTTP request; execute returns the original JSON or throws the original failure.
   */
  constructor({ apiKey, baseUrl = 'https://api.deepseek.com/v1', model = 'deepseek-chat', timeoutMs = 120000, role, memory, memoryBridge, ownerIds = [], toolRegistry = null, maxToolRounds = 4, maxToolCalls = 12, wrapModelRequest }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.role = role || new Role({ cardPath: 'role.md' });
    this.memory = memory || new Memory({ dir: './data' });
    this.memoryBridge = memoryBridge;
    this.ownerIds = ownerIds.map(String);
    this.toolRegistry = toolRegistry;
    this.maxToolRounds = maxToolRounds;
    this.maxToolCalls = maxToolCalls;
    if (wrapModelRequest != null && typeof wrapModelRequest !== 'function') throw new TypeError('wrapModelRequest must be a function');
    this.wrapModelRequest = wrapModelRequest;
  }

  /**
   * 生成一条回复
   *
   * @param {object} input
   * @param {string} input.key         会话标识
   * @param {string} input.userId      对方 id
   * @param {string} [input.userName]
   * @param {string} input.text        对方说的话（可以是合并后的一批）
   * @param {string} [input.situation] 处境描述（"你在群里，刚才在聊……"）
   * @param {Array}  [input.history]   该会话最近的消息（可选，通常靠 memory 就够）
   * @param {boolean}[input.record=true] 是否把这一轮写回记忆
   * @returns {Promise<{text:string, reasoning?:string, raw:any}>}
   */
  async reply(input) {
    const { key, userId, text, situation = '', record = true } = input;
    const isGroup = input.isGroup === true || /^(?:official:)?group:/.test(key || '');
    const isOwner = input.isOwner === true || this.ownerIds.includes(String(userId));
    const includePrivateMemory = isOwner && !isGroup;
    const allowedWhere = [`private:${userId}`, `official:c2c:${userId}`];
    if (includePrivateMemory) {
      for (const id of this.ownerIds) allowedWhere.push(`private:${id}`, `official:c2c:${id}`);
    }

    const memLine = isGroup ? '' : this.memory.renderPerson(userId);
    const recent = isGroup ? '' : this.memory.renderRecent(20, { excludeWhere: key, allowedWhere });
    const rolePrompt = this.role.build({
      situation,
      memory: memLine,
      recent,
      platform: input.platform || '',
      query: text,
      // Configured role cards can contain relationship details and owner IDs.
      includeRoleCard: includePrivateMemory,
      includePrivateMemory: includePrivateMemory && !this.memoryBridge,
    });
    const sys = this.memoryBridge ? this.memoryBridge.buildSystemPrompt('', {
      isOwner: includePrivateMemory, roleText: rolePrompt, roleCardText: includePrivateMemory ? this.role.read?.() || '' : '',
      query: text, maxChars: this.role.maxChars || 12000,
    }) : rolePrompt;

    const messages = [{ role: 'system', content: sys }];
    const history = input.history ?? (this.memory.recentTurns?.(20, { allowedWhere: [key] }) || [])
      .flatMap((turn) => [
        ...(turn.text ? [{ text: turn.text, isSelf: false }] : []),
        ...(turn.reply ? [{ text: turn.reply, isSelf: true }] : []),
      ]);
    for (const h of history.slice(-20)) {
      messages.push({ role: h.isSelf ? 'assistant' : 'user', content: String(h.text || '') });
    }
    messages.push({ role: 'user', content: String(text || '') });

    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('模型请求超时')), this.timeoutMs);
    let result;
    try {
      result = await runToolLoop({
        messages,
        registry: this.toolRegistry,
        context: { key, sessionId: input.sessionId || key, userId: String(userId || ''),
          userName: input.userName || '', isOwner, isGroup, includePrivateMemory, platform: input.platform || '' },
        signal: controller.signal,
        maxToolRounds: this.maxToolRounds,
        maxToolCalls: this.maxToolCalls,
        request: async (conversation, tools) => {
          let executed = false;
          const execute = async () => {
            if (executed) throw new Error('模型请求已执行，禁止重复执行');
            executed = true;
            if (this.wrapModelRequest) controller.signal.throwIfAborted();
            const res = await fetch(this.baseUrl + '/chat/completions', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
              body: JSON.stringify({ model: this.model, messages: conversation, temperature: 1.1, stream: false,
                ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
              signal: controller.signal,
            });
            const raw = await res.text();
            if (!res.ok) {
              const error = new Error('模型返回 ' + res.status + '：' + raw.slice(0, 300));
              if (this.wrapModelRequest) {
                try {
                  const data = JSON.parse(raw);
                  if (data && typeof data === 'object' && Object.hasOwn(data, 'usage')) {
                    Object.defineProperty(error, 'rawUsage', { value: data.usage });
                  }
                } catch {}
              }
              throw error;
            }
            try { return JSON.parse(raw); } catch { throw new Error('模型返回不是 JSON：' + raw.slice(0, 200)); }
          };
          if (!this.wrapModelRequest) return execute();
          // Only caller-owned metadata crosses this boundary; prompt and credentials stay in execute's closure.
          return this.wrapModelRequest({ input: Object.freeze({ key, sessionId: input.sessionId || key,
            userId: String(userId || ''), isOwner, isGroup, platform: input.platform || '',
            model: this.model, signal: controller.signal }), execute });
        },
      });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
    }
    if (record) this.recordReply(input, result.text);
    return result;
  }

  /** 调用方使用 record:false 时，仅在确认送达后写入这一轮。 */
  recordReply({ key, userId, userName, text }, out) {
    if (!out) return;
    this.memory.remember(userId, { name: userName, topic: (text || '').slice(0, 40) + ' → ' + out.slice(0, 40) });
    this.memory.logTurn({ where: key, who: userName || userId, text, reply: out });
  }

  /**
   * 让它自己写一条记忆（对应暴露给 AI 的 remember 工具）
   */
  remember(userId, { trait, fact, topic, pending, name }) {
    return this.memory.remember(userId, { trait, fact, topic, pending, name });
  }

  /**
   * 追加一条手账大事记至统一记忆库 (memory/timeline.md)
   */
  appendTimeline({ summary, detail, date = new Date() }) {
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const candidates = [
      path.resolve(process.cwd(), 'memory/timeline.md'),
      path.resolve(path.dirname(this.role?.cardPath || '.'), '../../memory/timeline.md'),
      path.resolve(path.dirname(this.role?.cardPath || '.'), '../memory/timeline.md'),
    ];
    for (const target of candidates) {
      if (fs.existsSync(target)) {
        const entry = `\n---\n\n### [${day}] ${summary}\n- **详情**：${detail}\n`;
        fs.appendFileSync(target, entry, 'utf8');
        return true;
      }
    }
    return false;
  }
}

export default Brain;
