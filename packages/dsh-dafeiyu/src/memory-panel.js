/** Owner management facade. It never accepts a path or grants model permissions. */
import { MemoryStoreError } from './memory-ledger.js';

export class MemoryPanelError extends Error {
  constructor(code, message) { super(message); this.name = 'MemoryPanelError'; this.code = code; }
}
const fail = (code, message) => { throw new MemoryPanelError(code, message); };

export class MemoryPanelController {
  constructor({ getRuntime, isBusy = (runtime) => Number(runtime?.incomingPending || 0) > 0
    || Number(runtime?.nativeOneBot?.status?.pending || 0) > 0 || Number(runtime?.voiceProcessor?.active || 0) > 0 } = {}) {
    if (typeof getRuntime !== 'function' || typeof isBusy !== 'function') fail('INVALID_CONFIG', '记忆面板运行接口无效');
    this.getRuntime = getRuntime; this.isBusy = isBusy;
  }
  #allowed(authorize) { try { return typeof authorize === 'function' && authorize() === true; } catch { return false; } }
  #runtime(authorize) {
    if (!this.#allowed(authorize)) fail('FORBIDDEN', '需要本机主人管理权限');
    const runtime = this.getRuntime();
    if (!runtime?.memoryBridge || typeof runtime.memoryBridge.snapshot !== 'function') fail('UNAVAILABLE', '伴侣记忆服务尚未就绪');
    return runtime;
  }
  #safe(task) {
    try { return task(); }
    catch (error) {
      if (error instanceof MemoryPanelError) throw error;
      if (error instanceof MemoryStoreError) throw new MemoryPanelError(error.code, error.message);
      fail('MEMORY_IO_ERROR', '记忆操作未得到确认，请重新读取核对；未返回私人文件内容');
    }
  }
  snapshot(query = {}, { authorize = () => true } = {}) {
    return this.#safe(() => {
      const runtime = this.#runtime(authorize), bridge = runtime.memoryBridge;
      const value = bridge.snapshot(query);
      if (!this.#allowed(authorize)) fail('FORBIDDEN', '当前主人授权已失效');
      if (this.getRuntime() !== runtime || runtime.memoryBridge !== bridge) fail('CONFLICT', '记忆运行实例已变化，请刷新');
      return value;
    });
  }
  #mutate(action, input, { authorize = () => true } = {}) {
    return this.#safe(() => {
      const runtime = this.#runtime(authorize), bridge = runtime.memoryBridge;
      if (this.isBusy(runtime)) fail('BUSY', '当前有对话或语音任务，请完成后再修改记忆');
      const current = () => this.#allowed(authorize) && this.getRuntime() === runtime && runtime.memoryBridge === bridge && !this.isBusy(runtime);
      if (typeof bridge[action] !== 'function') fail('UNAVAILABLE', '记忆管理接口尚未就绪');
      const value = bridge[action](input, { authorize: current, actor: 'panel' });
      if (!this.#allowed(authorize)) fail('FORBIDDEN', '当前主人授权已失效，请重新读取核对保存结果');
      if (this.getRuntime() !== runtime || runtime.memoryBridge !== bridge) fail('CONFLICT', '记忆运行实例已变化，请重新读取核对保存结果');
      return value;
    });
  }
  correct(input, options) { return this.#mutate('correct', input, options); }
  forget(input, options) { return this.#mutate('forget', input, options); }
  resumeDelete(input, options) { return this.#mutate('resumeDelete', input, options); }
  delete(input, options) { return this.#mutate('delete', input, options); }
  restore(input, options) { return this.#mutate('restore', input, options); }
}
