import { clone, fail } from './life-store.js';

export function calendar(at, timeZone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}-${parts.month}`, hour: Number(parts.hour) };
}
const monthIndex = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
const monthAt = (index) => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
const wallet = (state) => state.wallet ||= { policy: { enabled: false, dailySeconds: 0, monthlySeconds: 0, timeZone: 'Asia/Shanghai' },
  balance: 0, days: {}, grants: {}, transactions: [], sessions: [], lastMonth: null };

/** Global companion allowance: concurrent platforms cannot mint parallel time. */
export class TimeWallet {
  constructor({ store, now = () => Date.now() }) { this.store = store; this.now = now; }
  sync(state) {
    const value = wallet(state), current = calendar(this.now(), value.policy.timeZone);
    if (value.policy.enabled) {
      const first = value.lastMonth ? monthIndex(value.lastMonth) : monthIndex(current.month);
      const last = monthIndex(current.month);
      if (last - first > 1200) fail('CLOCK', '日期变化过大，请核对时间设置');
      for (let index = first; index <= last; index++) {
        const month = monthAt(index);
        if (Object.hasOwn(value.grants, month)) continue;
        value.grants[month] = value.policy.monthlySeconds; value.balance += value.policy.monthlySeconds;
        value.transactions.push({ id: 'month:' + month, kind: 'monthly', month, seconds: value.policy.monthlySeconds });
      }
      value.lastMonth = current.month;
    }
    return { value, current };
  }
  snapshot() {
    const { state, revision } = this.store.read(), { value, current } = this.sync(state);
    const used = value.days[current.day] || 0;
    return { revision, ...clone(value), day: current.day, dailyRemainingSeconds: Math.max(0, value.policy.dailySeconds - used),
      availableSeconds: value.policy.enabled ? Math.max(0, value.policy.dailySeconds - used) + value.balance : 0 };
  }
  configure(patch, options) {
    if (!patch || Object.keys(patch).some((key) => !['enabled', 'dailySeconds', 'monthlySeconds'].includes(key))
      || patch.enabled !== undefined && typeof patch.enabled !== 'boolean'
      || ['dailySeconds', 'monthlySeconds'].some((key) => patch[key] !== undefined && (!Number.isSafeInteger(patch[key]) || patch[key] < 0 || patch[key] > 31536000))) fail('INVALID_PATCH', '娱乐时间额度无效');
    return this.store.update((state) => {
      const value = wallet(state);
      if (value.sessions.some((session) => ['running', 'unknown'].includes(session.status))) fail('BUSY', '请先停止或核实当前娱乐活动');
      this.sync(state);
      if (value.policy.enabled && patch.enabled === false) value.lastMonth = null;
      Object.assign(value.policy, patch); this.sync(state); return value.policy;
    }, options);
  }
  add({ requestId, seconds }, options) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId || '') || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 31536000) fail('INVALID_PATCH', '额外时间参数无效');
    return this.store.update((state) => {
      const value = wallet(state), id = 'bonus:' + requestId, prior = value.transactions.find((row) => row.id === id);
      if (prior) {
        if (prior.kind !== 'bonus' || prior.seconds !== seconds) fail('CONFLICT', '这笔时间发放编号已绑定其他金额，请先核对原申请');
        return { duplicate: true, added: prior.seconds, requestId };
      }
      this.sync(state);
      value.balance += seconds; value.transactions.push({ id, kind: 'bonus', seconds }); return { added: seconds, requestId };
    }, options);
  }
  start(id, { maxSeconds, authorize } = {}) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id || '') || !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 3600) fail('INVALID_PATCH', '娱乐活动参数无效');
    return this.store.update((state) => {
      const { value, current } = this.sync(state);
      const existing = value.sessions.find((session) => session.id === id);
      if (existing) return { duplicate: true, session: existing };
      if (!value.policy.enabled) fail('DISABLED', '娱乐时间钱包未启用');
      if (value.sessions.some((session) => ['running', 'unknown'].includes(session.status))) fail('BUSY', '已有娱乐活动或待核实记录');
      const available = Math.max(0, value.policy.dailySeconds - (value.days[current.day] || 0)) + value.balance;
      if (!available) fail('LIMIT', '今日基础时间和零花时间均已用完');
      const session = { id, status: 'running', mode: 'waiting', lastAt: this.now(), activeMs: 0, charged: 0,
        baseSeconds: 0, allowanceSeconds: 0, maxSeconds: Math.min(available, maxSeconds) };
      value.sessions.push(session); return { session };
    }, { authorize });
  }
  meter(id, mode, { authorize, finish = false } = {}) {
    if (!['playing', 'waiting', 'paused'].includes(mode)) fail('INVALID_PATCH', '娱乐计时状态无效');
    return this.store.update((state) => {
      const { value, current } = this.sync(state), session = value.sessions.find((row) => row.id === id);
      if (!session || session.status !== 'running') return { stopped: true };
      const now = this.now();
      if (now < session.lastAt) fail('CLOCK', '时钟回退，已暂停计时');
      // A checkpoint is short-lived. A sleeping/disconnected process cannot
      // turn hours of elapsed wall time into charged entertainment.
      const elapsed = now - session.lastAt, previousActive = session.activeMs;
      if (session.mode === 'playing' && elapsed <= 5000) session.activeMs += elapsed;
      const desired = Math.min(session.maxSeconds, finish ? Math.ceil(session.activeMs / 1000) : Math.floor(session.activeMs / 1000));
      const requested = desired - session.charged;
      let base = 0, allowance = 0;
      for (let index = 0; index < requested; index++) {
        const endpoint = Math.min(now, session.lastAt + 1000 - previousActive % 1000 + index * 1000);
        const day = calendar(Math.max(session.lastAt, endpoint - 1), value.policy.timeZone).day;
        if ((value.days[day] || 0) < value.policy.dailySeconds) { value.days[day] = (value.days[day] || 0) + 1; base++; }
        else if (value.balance > 0) { value.balance--; allowance++; } else break;
      }
      session.baseSeconds += base; session.allowanceSeconds += allowance; session.charged += base + allowance;
      session.lastAt = now; session.mode = elapsed > 5000 ? 'paused' : mode;
      const exhausted = session.charged >= session.maxSeconds || base + allowance < requested;
      if (finish || exhausted) { session.status = 'finished'; session.mode = 'paused';
        value.transactions.push({ id: 'spend:' + id, kind: 'spend', seconds: session.charged, baseSeconds: session.baseSeconds, allowanceSeconds: session.allowanceSeconds }); }
      return { session, exhausted };
    }, { authorize });
  }
  recover(options) {
    return this.store.update((state) => { const value = wallet(state);
      for (const session of value.sessions) if (session.status === 'running') { session.status = 'unknown'; session.mode = 'paused'; }
      return { replayed: false };
    }, options);
  }
  acknowledge(id, { confirmedStopped, ...options }) {
    if (confirmedStopped !== true) fail('INVALID_PATCH', '需要明确核实旧活动已停止');
    return this.store.update((state) => {
      const session = wallet(state).sessions.find((row) => row.id === id && row.status === 'unknown');
      if (!session) fail('NOT_FOUND', '没有待核实的娱乐活动');
      session.status = 'interrupted'; return { replayed: false };
    }, options);
  }
}
