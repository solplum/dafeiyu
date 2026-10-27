import { AsyncLocalStorage } from 'node:async_hooks';

// Each tool invocation keeps its own device even while another call changes selection.
export class DeviceBinding {
  constructor(serial = '') {
    this.selected = String(serial).trim();
    this.context = new AsyncLocalStorage();
    this.actionTail = Promise.resolve();
  }
  run(callback, { exclusive = false, signal } = {}) {
    const snapshot = { serial: this.selected, signal };
    const invoke = () => this.context.run(snapshot, callback);
    if (!exclusive) return invoke();
    // Shared temporary UI files and multi-step GUI actions must not interleave.
    const operation = this.actionTail.catch(() => {}).then(invoke);
    this.actionTail = operation.catch(() => {});
    return operation;
  }
  current() { return this.context.getStore()?.serial ?? this.selected; }
  signal() { return this.context.getStore()?.signal; }
  select(serial) {
    const value = String(serial || '').trim();
    if (!value || /\s/.test(value)) throw new Error('设备序列号无效');
    this.selected = value;
    const current = this.context.getStore();
    if (current) current.serial = value;
    return value;
  }
  pin(serial) {
    const current = this.context.getStore();
    if (current) current.serial = serial;
    if (!this.selected) this.selected = serial;
    return serial;
  }
}
