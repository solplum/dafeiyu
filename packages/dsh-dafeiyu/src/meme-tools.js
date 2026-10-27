/** Explicit library actions. Media sending stays with the current host channel. */
import fs from 'node:fs';
import path from 'node:path';
import { validateToolArguments } from '../../companion/src/tool-loop.js';
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export class MemeTools {
  constructor({ memeManager, getExecutionContext, phoneEnabled = false, allowPhoneSync = false, allowedImportRoots = [] } = {}) {
    Object.assign(this, { memeManager, getExecutionContext, phoneEnabled, allowPhoneSync });
    if (!Array.isArray(allowedImportRoots) || allowedImportRoots.some((root) => typeof root !== 'string')) throw new Error('图片导入目录配置无效');
    this.allowedImportRoots = allowedImportRoots.map((root) => path.resolve(root));
    this.disposers = [];
    this.closed = false;
  }

  #checkImport(file) {
    const resolved = fs.realpathSync(file);
    const allowed = this.allowedImportRoots.some((root) => {
      let canonical;
      try { canonical = fs.realpathSync(root); } catch { return false; }
      return resolved.startsWith(canonical + path.sep);
    });
    if (!allowed) throw new Error('仅可收藏已授权图片目录中的文件');
    return resolved;
  }

  definitions() {
    const shortText = { type: 'string', maxLength: 160 };
    const description = { type: 'string', minLength: 1, maxLength: 1200, description: '实际画面、具体含义和适用语境；先查看实际图片，不能把文件名或标签当作描写' };
    const aiDescription = { type: 'string', maxLength: 1200, description: '可选的 AI 选图补充，例如适用与避免的语境；为空沿用共同描写' };
    const descriptions = { type: 'array', minItems: 1, maxItems: 1000, items: object({ filename: { type: 'string', minLength: 1, maxLength: 2000 }, description, aiDescription }, ['filename', 'description']) };
    const result = [
      { name: 'dafeiyu_meme_search', description: '按具体含义、适用语境、名称和标签检索；情绪推荐仅选有描写的图片。旧图缺描写只供预览补写，勿猜含义；AI 补充为空时沿用 description。不是视觉识别。发送须使用当前 QQ 通道媒体工具。',
        parameters: object({ query: shortText, replyText: { type: 'string', maxLength: 2000 }, limit: { type: 'integer', minimum: 1, maximum: 30 } }),
        execute: async ({ query = '', replyText, limit = 10 }) => replyText
          ? this.memeManager.matchMemeForReplyResult(replyText)
          : this.memeManager.searchMemes(query, { limit }) },
      { name: 'dafeiyu_meme_collect', description: '查看实际图片后，收藏已授权目录中的图片；每次必须写具体画面、含义与适用语境。名称和标签不能代替描写，不得从文件名编造；不会发送图片。',
        parameters: object({ path: { type: 'string', minLength: 1, maxLength: 2000 }, title: shortText,
          tags: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 30 }, description, aiDescription }, ['path', 'description']),
        execute: async (args) => this.memeManager.collectMeme(this.#checkImport(args.path), args.title, { tags: args.tags || [], description: args.description, aiDescription: args.aiDescription }) },
      { name: 'dafeiyu_meme_preview', description: '查看共享图库中的实际图片，只回传当前会话。',
        parameters: object({ filename: { type: 'string', minLength: 1, maxLength: 255 } }, ['filename']),
        execute: async ({ filename }, execution, ctx) => {
          const { bytes, mediaType } = this.memeManager.readImage(filename);
          const attachments = ctx.get?.('attachments');
          if (typeof attachments?.saveImage !== 'function') return { ok: false, error: '宿主附件服务不可用，尚未把图片交给模型' };
          const image = await attachments.saveImage({ data: bytes, mediaType, name: filename });
          return { ok: true, filename, ...this.memeManager.getMetadata?.(filename), image };
        } },
    ];
    if (this.phoneEnabled && this.allowPhoneSync) result.push({
      name: 'dafeiyu_meme_sync', description: '按显式授权导入手机表情；必须逐图给出已确认的含义与语境，filename 用拉取目录相对路径精确匹配，缺描写逐项拒绝；不发送图片。', parameters: object({ descriptions }, ['descriptions']),
      execute: async ({ descriptions }) => {
        if (!this.phoneEnabled || !this.allowPhoneSync) throw new Error('手机图库同步已禁用');
        return this.memeManager.syncFromPhone({ descriptions });
      },
    });
    return result;
  }

  registerToCordis(ctx) {
    for (const definition of this.definitions()) {
      const execute = definition.execute;
      const unregister = ctx.tools.register({ ...definition, execute: async (args = {}, execution) => {
        if (this.closed) throw new Error('表情工具已卸载');
        const identity = await this.getExecutionContext?.(execution);
        if (!identity?.isOwner || !(identity.scope === 'c2c' || identity.scope === 'desktop' && identity.trusted === true)) throw new Error('只有已验证的主人会话可访问共享图库');
        validateToolArguments(args, definition.parameters);
        if (execution?.signal?.aborted) throw new Error('会话已取消');
        return execute(args, execution, ctx);
      }, output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value) }, ...(value?.image ? [{ type: 'image', attachment: value.image }] : []),
      ] } });
      if (typeof unregister === 'function') this.disposers.push(unregister);
    }
  }

  dispose() {
    this.closed = true;
    const errors = [];
    for (const unregister of this.disposers.splice(0).reverse()) { try { unregister(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, '表情工具注销失败');
  }
}
