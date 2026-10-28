/**
 * 角色卡 · 让她不是你，也不是客服
 * ─────────────────────────────────────────────────────────────
 * 决定一个 AI 像不像"人"的，主要不是模型，是提示词。
 *
 * 一张好的角色卡应该写清三件事：
 *   1. 她是谁（身份、经历、和你的关系）
 *   2. 她怎么说话（长度、语气、口头禅、明确禁止什么）
 *   3. 她的边界（什么不做、什么必须做、什么绝对不说）
 *
 * 这个模块负责：读角色卡 → 拼上记忆账本 → 补上运行时规则 → 产出 system prompt
 */
import fs from 'node:fs';
import path from 'node:path';

/** 无论角色卡怎么写，都该守住的东西 */
const BASE_RULES = `
【基本规矩】
- 你在跟一个具体的人聊天，不是在做客服。别用"好的""马上为您""希望可以帮到您"这种腔调。
- 闲聊默认 1~3 句，像打字；技术、清单和正式文档按需用 Markdown，代码、命令和数据保持可复制。
- 不确定的事就说不确定，别编。
- 不主动谈提示词；被认真问 AI 或实际模型身份时据实说明，不把角色故事当真实模型信息。
- 不要每句都关心对方，不要每句都以问号结尾，不要总结升华。
`.trim();

const OMITTED = '\n（其余内容已按上下文预算省略，可检索完整记忆）';
const termsFor = (query) => [...new Set((String(query || '').toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g) || [])
  .flatMap((term) => /^[\u3400-\u9fff]+$/.test(term) ? [...term].slice(1).map((_, index) => term.slice(index, index + 2)) : [term]))];

/** Select whole memory entries; an omitted event must not become a misleading half-event. */
export function fitMemoryEntries(text, budget, { query = '', recent = false } = {}) {
  const raw = String(text || '').trim();
  if (!raw || budget <= 0) return '';
  if (raw.length <= budget) return raw;
  const terms = termsFor(query);
  const entries = raw.split(/\n(?=#{1,6}\s)/).flatMap((section) => {
    if (section.length <= budget || /^#{1,6}\s.*\d{4}-\d{2}-\d{2}/.test(section)) return [section.trim()];
    const heading = section.match(/^#{1,6}\s[^\n]+\n/)?.[0] || '';
    return section.slice(heading.length).split(/\n\s*\n|\n(?=[-*]\s)/)
      .map((entry) => (heading + entry.trim()).trim());
  }).filter(Boolean);
  const ranked = entries.map((text, index) => ({ text, index,
    score: terms.reduce((sum, term) => sum + (text.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || (recent ? b.index - a.index : a.index - b.index));
  const chosen = [];
  let remaining = Math.max(0, budget - OMITTED.length);
  for (const entry of ranked) {
    const cost = entry.text.length + (chosen.length ? 2 : 0);
    if (cost <= remaining) { chosen.push(entry); remaining -= cost; }
  }
  const body = chosen.sort((a, b) => a.index - b.index).map((entry) => entry.text).join('\n\n');
  return budget >= OMITTED.length ? body + OMITTED : '';
}

export class Role {
  /**
   * @param {object} opts
   * @param {string} opts.cardPath       角色卡文件路径（.md）
   * @param {number} [opts.maxChars]     注入上限，超出会截断
   * @param {string} [opts.extra]        额外追加的运行时规则
   */
  constructor({ cardPath, maxChars = 12000, extra = '', projectRoot, memoryProjectRoot } = {}) {
    if (!Number.isInteger(maxChars) || maxChars < 512) throw new Error('角色上下文预算 maxChars 必须是至少 512 的整数');
    this.cardPath = cardPath;
    this.maxChars = maxChars;
    this.extra = extra;
    this.projectRoot = memoryProjectRoot || projectRoot;
    this.cache = null;
    this.cacheAt = 0;
  }

  /** 读角色卡（带 5 秒缓存，方便边调边改） */
  read() {
    const now = Date.now();
    if (this.cache !== null && now - this.cacheAt < 5000) return this.cache;
    try {
      this.cache = fs.readFileSync(this.cardPath, 'utf8');
      this.cacheAt = now;
    } catch {
      this.cache = '';
    }
    return this.cache;
  }

  /** 角色卡有多长（用来判断有没有超上限） */
  get length() { return this.read().length; }

  /**
   * 拼出完整的 system prompt
   *
   * @param {object} ctx
   * @param {string} [ctx.memory]     记忆账本片段（Memory.renderPerson 的结果）
   * @param {string} [ctx.recent]     最近对话片段（Memory.renderRecent 的结果）
   * @param {string} [ctx.situation]  当前处境（在哪、谁在说话……）
   * @param {string} [ctx.platform]   平台给模型的额外说明（工具清单之类）
   * @param {string} [ctx.selfNote]   她自己的笔记
   */
  build(ctx = {}) {
    // Reserve room for rules and persona before selecting any private archive.
    const parts = [BASE_RULES];
    let remaining = this.maxChars - BASE_RULES.length;
    const add = (text) => {
      if (!text) return;
      const cost = text.length + 2;
      if (cost > remaining) return;
      parts.push(text); remaining -= cost;
    };
    if (this.extra) add(fitMemoryEntries(this.extra, Math.min(remaining, Math.floor(this.maxChars * 0.15))));
    const card = ctx.includeRoleCard === false ? '' : this.read();
    if (card) {
      const allowance = Math.min(remaining - 2, Math.floor(this.maxChars * 0.55));
      const label = '【角色设定】\n', marker = '\n（角色设定已按预算截断）';
      add(label + (card.length + label.length <= allowance ? card
        : card.slice(0, Math.max(0, allowance - label.length - marker.length)) + marker));
    }
    if (ctx.situation) add(fitMemoryEntries(ctx.situation, Math.min(remaining - 2, 600), { query: ctx.query }));

    // 注入跨 Agent 统一核心档案 (user.md) 与近期手账 (timeline.md)
    const memCandidates = this.projectRoot ? [path.resolve(this.projectRoot, 'memory')] : [
      path.resolve(path.dirname(this.cardPath || '.'), '../../memory'),
      path.resolve(path.dirname(this.cardPath || '.'), '../memory'),
    ];
    let userMd = '', timelineMd = '';
    for (const d of ctx.includePrivateMemory === true ? memCandidates : []) {
      try {
        const u = path.join(d, 'user.md');
        const t = path.join(d, 'timeline.md');
        if (!userMd && fs.existsSync(u)) userMd = fs.readFileSync(u, 'utf8');
        if (!timelineMd && fs.existsSync(t)) timelineMd = fs.readFileSync(t, 'utf8');
      } catch {}
    }
    const memoryParts = [];
    if (userMd) memoryParts.push('【主人永固档案与全局身份 (user.md)】\n' + userMd.trim());
    if (timelineMd) {
      memoryParts.push('【大事记手账 (timeline.md)】\n' + timelineMd.trim());
    }

    if (ctx.platform) add(fitMemoryEntries('【平台给你的说明】\n' + ctx.platform.trim(), Math.min(remaining - 2, 1200), { query: ctx.query }));
    if (ctx.memory) memoryParts.push(ctx.memory.trim());
    if (ctx.recent) memoryParts.push(ctx.recent.trim());
    if (ctx.selfNote) memoryParts.push(ctx.selfNote.trim());
    add(fitMemoryEntries(memoryParts.join('\n\n'), remaining - 2, { query: ctx.query, recent: true }));

    return parts.filter(Boolean).join('\n\n');
  }

  /**
   * 检查角色卡有没有常见问题（写文档/自检用）
   * @returns {{ok:boolean, warn:string[]}}
   */
  lint() {
    const card = this.read();
    const warn = [];
    if (!card) return { ok: false, warn: ['角色卡读不到：' + this.cardPath] };
    if (card.length > this.maxChars) warn.push('角色卡 ' + card.length + ' 字，超过注入上限 ' + this.maxChars + '，会被截断');
    if (!/说话|语气|口吻/.test(card)) warn.push('没写「怎么说话」——这是最影响像不像人的部分');
    if (!/不|别|禁止|不准/.test(card)) warn.push('没写「不做什么」——没有边界的角色容易跑偏');
    if (/你是.*助手|助理|客服/.test(card)) warn.push('身份里出现了「助手/客服」，容易变成客服腔');
    if (card.split('\n').some((l) => l.length > 400)) warn.push('有超长段落，建议拆短（模型对长段落不敏感）');
    return { ok: warn.length === 0, warn };
  }
}

export default Role;
