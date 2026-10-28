import { validateToolArguments } from '../../companion/src/tool-loop.js';
import { CAPABILITY_IDS } from './capabilities.js';

export function registerCapabilityTools(ctx, { registry, getExecutionContext, prepareDesktop }) {
  let closed = false;
  const parameters = { type: 'object', properties: { id: { type: 'string', enum: [...CAPABILITY_IDS] } }, additionalProperties: false };
  const stop = ctx.tools.register({ name: 'dafeiyu_capabilities',
    description: '只读查看当前电脑、浏览器、QQ、手机等能力的真实检测与验证状态。可选id筛选。存在、已配置、已实测是不同状态；本工具不启动验证、不操作设备，也不授予新权限。只有当前已验证的主人会话可查询。',
    parameters, async execute(args, execution) {
      validateToolArguments(args, parameters);
      let identity;
      try { identity = getExecutionContext(execution); } catch {}
      if (closed || execution?.signal?.aborted || !execution?.agent || identity?.isOwner !== true) throw new Error('仅当前已验证的主人会话可以查询能力状态');
      const state = registry.snapshot({ agent: execution.agent });
      return { ok: true, ...state, items: args.id ? state.items.filter((item) => item.id === args.id) : state.items };
    }, output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  });
  const stopPreparation = typeof prepareDesktop === 'function' ? ctx.tools.register({
    name: 'dafeiyu_desktop_prepare',
    description: '只在主人明确要求电脑界面操作时使用。为当前唯一运行的 DSH 自身初始化 Electron 辅助功能树，供 computer-use 工具读取。不会点击、输入、截屏或申请系统权限；初始化成功不等于桌面控制已实测。无参数，不能指定其他应用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, execution) {
      validateToolArguments(args, { type: 'object', properties: {}, additionalProperties: false });
      const allowed = () => {
        try { return !closed && !execution?.signal?.aborted && Boolean(execution?.agent)
          && getExecutionContext(execution)?.isOwner === true; } catch { return false; }
      };
      if (!allowed()) throw new Error('仅当前已验证的主人会话可以初始化电脑界面支持');
      if (registry.snapshot().busy) throw new Error('能力检测仍在执行，请等结束后再初始化');
      let receipt;
      try { receipt = await prepareDesktop({ signal: execution.signal, authorize: allowed }); }
      catch { receipt = { ok: false, code: 'UNCONFIRMED' }; }
      if (!allowed()) throw new Error('当前授权已撤销或初始化已取消');
      const code = receipt?.ok === true && receipt.code === 'READY' ? 'READY'
        : ['UNAVAILABLE', 'UNTRUSTED', 'UNCONFIRMED'].includes(receipt?.code) ? receipt.code : 'UNCONFIRMED';
      return { ok: code === 'READY', code, verified: false, message: code === 'READY'
        ? 'DSH 辅助树初始化请求已接受；请使用当前已授权的 computer-use 工具操作，并读取结果确认。尚未据此通过能力实测。'
        : code === 'UNTRUSTED' ? '当前执行应用尚无辅助功能授权；没有自动申请权限，请主人核对系统设置后再试。'
          : '初始化未确认，不会自动重试；没有据此确认桌面控制可用。' };
    }, output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  }) : undefined;
  return () => { closed = true; if (typeof stopPreparation === 'function') stopPreparation(); if (typeof stop === 'function') stop(); };
}
