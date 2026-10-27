import { validateToolArguments } from '../../companion/src/tool-loop.js';

/** Media leaves through the verified personal QQ conversation, with a receipt. */
export function registerNativeOneBotTools(ctx, { getExecutionContext, qqGateway, memeManager }) {
  const parameters = { type: 'object', properties: {
    filename: { type: 'string', minLength: 1, maxLength: 255 },
  }, required: ['filename'], additionalProperties: false };
  let closed = false;
  const unregister = ctx.tools.register({
    name: 'dafeiyu_meme_send',
    description: '在当前已验证的个人 QQ 主人私聊中发送共享图库里的实际图片。filename 必须来自图库查询；以发送回执确认，不自动重试。',
    parameters,
    execute: async (args, execution) => {
      if (closed) throw new Error('个人 QQ 工具已卸载');
      const identity = getExecutionContext(execution);
      if (!identity?.isOwner || identity.channel !== 'onebot' || identity.scope !== 'c2c') {
        throw new Error('仅当前已验证的个人 QQ 主人私聊可以发送表情');
      }
      validateToolArguments(args, parameters);
      if (execution?.signal?.aborted) throw new Error('会话已取消');
      if (!qqGateway.connected || String(qqGateway.selfId || '') !== identity.selfId) {
        return { ok: false, error: '个人 QQ 连接或小号身份尚未确认' };
      }
      let image;
      try { image = memeManager.readImage(args.filename); }
      catch (error) { return { ok: false, error: error.message }; }
      if (closed || execution?.signal?.aborted) throw new Error('会话已取消');
      const result = await qqGateway.sendImage(`private:${identity.peerId}`, image.path);
      if (closed || execution?.signal?.aborted) return { ok: false, cancelled: true,
        delivered: result?.ok === true,
        ...(result?.data?.message_id != null ? { messageId: String(result.data.message_id) } : {}),
        ...(result?.ok === true ? {} : { uncertain: result?.uncertain !== false }),
        error: '会话已取消；发送已派发，请核实回执，禁止自动重发' };
      return { ok: result?.ok === true, filename: args.filename,
        ...(result?.data?.message_id != null ? { messageId: String(result.data.message_id) } : {}),
        ...(result?.uncertain ? { uncertain: true } : {}),
        ...(result?.ok === true ? {} : { error: result?.error || '发送未确认，禁止自动重试' }) };
    },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  });
  return () => { closed = true; unregister?.(); };
}
