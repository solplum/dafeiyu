import fs from 'node:fs';
import path from 'node:path';
import { validateToolArguments } from '../../companion/src/tool-loop.js';

export function registerBackgroundTools(ctx, { manager, bridge, getExecutionContext, workspaceRoots = [] }) {
  let closed = false;
  const stops = [];
  const origin = (execution) => {
    if (closed || execution?.signal?.aborted) throw new Error('后台任务工具已停止或会话已取消');
    const identity = getExecutionContext(execution), source = bridge.backgroundOriginForAgent(execution?.agent);
    if (!identity?.isOwner || identity.channel !== 'onebot' || !source
      || identity.peerId !== source.scope.peerId || identity.selfId !== source.scope.selfId) throw new Error('仅当前已验证的主人 QQ 私聊可以管理后台任务');
    return source;
  };
  const register = (name, description, parameters, execute) => {
    const stop = ctx.tools.register({ name, description, parameters,
      async execute(args, execution) {
        validateToolArguments(args, parameters);
        const source = origin(execution);
        return execute(args, source, execution);
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    });
    if (typeof stop === 'function') stops.push(stop);
  };
  const taskId = { type: 'string', pattern: '^dfy-[a-f0-9]{16}$' };
  register('dafeiyu_task_start',
    '把多步骤、耗时或需要反复尝试的主人任务交给后台子 Agent。电脑应用界面/浏览器任务必须填写control=desktop或browser，固定native执行器。立即返回任务编号，随后结束当前回合并说明已受理；不要等待/轮询，也不要自己重复执行相同任务。完成、失败和取消由系统直接回当前 QQ。prompt必须自包含，只传必要信息，不复制私人记忆/凭据。简单任务difficulty=simple，复杂排障/代码difficulty=hard；其余任务executor默认auto。只有完全不修改文件、状态或外部系统的查阅/分析任务才可声明readOnly=true，高峰期这类任务可交给Z Code/MiniMax；需要修改或不确定时readOnly=false，交原生或Codex。子任务不继承主人QQ发送、私人记忆及手机权限，此类动作仍由当前已授权主会话完成，不要委派后再自行重做。',
    { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 160 }, prompt: { type: 'string', minLength: 1, maxLength: 16000 },
      difficulty: { type: 'string', enum: ['simple', 'normal', 'hard'] }, executor: { type: 'string', enum: ['auto', 'native', 'codex', 'zcode', 'minimax'] },
      readOnly: { type: 'boolean' }, control: { type: 'string', enum: ['desktop', 'browser'],
        description: '仅界面任务填写：desktop为电脑应用，browser为浏览器。此类任务固定交原生子Agent，授予本任务界面权限，不授予记忆、QQ发送或手机权限。' },
      cwd: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['title', 'prompt'], additionalProperties: false },
    async (args, source) => {
      let cwd;
      if (args.cwd) {
        try {
          cwd = fs.realpathSync(args.cwd);
          if (!path.isAbsolute(args.cwd) || !fs.statSync(cwd).isDirectory() || !workspaceRoots.some((root) => {
            const relative = path.relative(fs.realpathSync(root), cwd); return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
          })) throw new Error('outside workspace');
        } catch { throw new Error('任务目录不在已配置工作区内，请在面板确认工作区'); }
      }
      const job = await manager.submit({ ...source, ...args, ...(cwd ? { cwd } : {}) });
      return { ok: true, task: job, message: '任务已受理；现在回复任务编号并结束本回合，继续接收聊天。请勿自行重做或等待后台任务。' };
    });
  register('dafeiyu_task_status', '查询当前 QQ 账号身份的后台任务状态或结果。不能指定其他用户；没有taskId时列出最近任务。查询不会重新执行任务。',
    { type: 'object', properties: { taskId }, additionalProperties: false },
    (args, source) => args.taskId ? { ok: true, task: manager.get(args.taskId, source.scope) } : { ok: true, tasks: manager.list(source.scope) });
  register('dafeiyu_task_cancel', '停止当前账号身份的指定后台任务。不回滚已经发生的操作；正在停止不等于已确认终止。不会重新执行任务。',
    { type: 'object', properties: { taskId }, required: ['taskId'], additionalProperties: false },
    async (args, source) => ({ ok: true, task: await manager.cancel(args.taskId, source.scope) }));
  return () => { closed = true; for (const stop of stops.reverse()) stop(); };
}
