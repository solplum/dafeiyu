import { randomUUID } from 'node:crypto';
import { clone, digest, sameScope, validScope, fail, text } from './life-store.js';
import { TimeWallet, calendar } from './time-wallet.js';

const defaults = () => ({ enabled: false, proactive: false, browse: false, quietEnabled: true, greetingEnabled: false, quietStart: 23, quietEnd: 9,
  minGapMinutes: 90, maxContacts: 2, maxActivities: 4, sessionSeconds: 600, platforms: [], targets: [] });
const data = (state) => state.autonomy ||= { policy: defaults(), activities: [], awaitingReply: [], nextAt: null };
const policyView = (policy) => ({ ...policy, enabled: policy.enabled === true, proactive: policy.proactive === true, browse: policy.browse === true,
  quietEnabled: typeof policy.quietEnabled === 'boolean' ? policy.quietEnabled : policy.quietStart !== policy.quietEnd,
  greetingEnabled: policy.greetingEnabled === true });
const quiet = (policy, at) => { const hour = calendar(at).hour;
  return !policyView(policy).quietEnabled || policy.quietStart === policy.quietEnd ? false : policy.quietStart < policy.quietEnd
    ? hour >= policy.quietStart && hour < policy.quietEnd : hour >= policy.quietStart || hour < policy.quietEnd; };
// A candidate borrows a particular effective source version. The digest is
// metadata only: it never retains text removed by correction or forgetting.
const sourceFingerprint = (row) => digest(JSON.stringify([row.id, row.scope, row.status, row.source,
  row.summary, row.detail, row.compacted === true, row.correctedAt || null]));
const staleSource = '来源记忆已变化或不再可用，未执行旧话题';
const GREETING_TOPIC = '首次主动问候：只简短打招呼，不声称记得任何经历或先前联系。';
const COUNTER_POLICY = Object.freeze({ contacts: 'account-identity-delivered-local-day', activities: 'created-local-day-non-scheduled' });

/** Persistent candidate times and one independently cancellable activity. No replay or send retry. */
export class AutonomyEngine {
  constructor({ memory, run, send, scopes, greetingScopes = () => [], contactReady = () => true, tokenBudget, isBusy = () => false, now = () => Date.now(), random = Math.random }) {
    Object.assign(this, { memory, run, send, scopes, greetingScopes, contactReady, tokenBudget, isBusy, now, random });
    this.store = memory.store; this.wallet = new TimeWallet({ store: this.store, now }); this.active = null; this.closed = false;
  }
  snapshot() { const { state, revision } = this.store.read(), value = data(state); return { revision, ...clone(value), policy: policyView(value.policy), wallet: this.wallet.snapshot(), running: Boolean(this.active) }; }
  configure(patch, options) {
    const allowed = Object.keys(defaults());
    if (!patch || Object.keys(patch).some((key) => !allowed.includes(key))
      || ['enabled', 'proactive', 'browse', 'quietEnabled', 'greetingEnabled'].some((key) => patch[key] !== undefined && typeof patch[key] !== 'boolean')
      || ['quietStart', 'quietEnd'].some((key) => patch[key] !== undefined && (!Number.isInteger(patch[key]) || patch[key] < 0 || patch[key] > 23))
      || ['minGapMinutes', 'maxContacts', 'maxActivities', 'sessionSeconds'].some((key) => patch[key] !== undefined
        && (!Number.isInteger(patch[key]) || patch[key] < 1 || patch[key] > (key === 'sessionSeconds' ? 3600 : key === 'minGapMinutes' ? 1440 : 20)))
      || patch.platforms !== undefined && (!Array.isArray(patch.platforms) || patch.platforms.length > 2 || patch.platforms.some((item) => !['bilibili', 'douyin'].includes(item)))
      || patch.targets !== undefined && (!Array.isArray(patch.targets) || patch.targets.length > 100 || patch.targets.some((scope) => !validScope(scope) || !this.scopes().some((known) => sameScope(scope, known))))) fail('INVALID_PATCH', '自主活动设置无效或目标账号未绑定');
    const result = this.store.update((state) => {
      const policy = data(state).policy, next = { ...policyView(policy), ...patch };
      if (patch.quietEnabled === true && next.quietStart === next.quietEnd) fail('INVALID_PATCH', '开启免打扰时，开始和结束小时不能相同');
      Object.assign(policy, patch);
      // Legacy clients used equal hours to disable quiet time. An unrelated
      // save never migrates that field; an explicit hours edit keeps its meaning.
      if (patch.quietEnabled === undefined && (patch.quietStart !== undefined || patch.quietEnd !== undefined))
        policy.quietEnabled = next.quietStart !== next.quietEnd;
      return policyView(policy);
    }, options);
    if (this.active) {
      const activity = data(this.store.read().state).activities.find(row => row.id === this.active.id);
      if (!activity || !this.permitted(activity)) this.active.controller.abort();
    }
    return result;
  }
  permitted(activity) {
    return this.#permitted(activity, true);
  }
  #permitted(activity, checkReadiness) {
    if (this.closed || !['chat', 'browse'].includes(activity?.kind)) return false;
    const { state } = this.store.read(), value = data(state), policy = policyView(value.policy);
    const stored = value.activities.find((row) => row.id === activity.id);
    return policy.enabled && (!checkReadiness || !quiet(policy, this.now())) && policy.targets.some((scope) => sameScope(scope, activity.scope))
      && this.scopes().some((scope) => sameScope(scope, activity.scope))
      && (!checkReadiness || activity.kind !== 'chat' || this.canContact(activity.scope))
      && (activity.kind === 'chat' ? policy.proactive : policy.browse && policy.platforms.includes(activity.platform))
      && stored && ['scheduled', 'running'].includes(stored.status) && sameScope(stored.scope, activity.scope)
      && stored.kind === activity.kind && stored.platform === activity.platform
      && stored.sourceId === activity.sourceId && stored.topic === activity.topic
      && stored.origin === activity.origin
      && stored.sourceFingerprint === activity.sourceFingerprint && this.sourceCurrent(activity, state);
  }
  topicRows(state, scope) {
    return state.memories.filter(row => sameScope(row.scope, scope) && row.status === 'active'
      && this.memory.clarity(row, state.policy) !== 'faded' && text(row.summary, 160).trim()).reverse();
  }
  greetingScope(scope) {
    try { return this.greetingScopes().some(known => sameScope(known, scope)); } catch { return false; }
  }
  canContact(scope) { try { return this.contactReady(scope) === true; } catch { return false; } }
  sourceCurrent(activity, state = this.store.read().state) {
    if (activity?.origin === 'greeting') {
      const value = data(state), policy = policyView(value.policy);
      const stored = value.activities.find(row => row.id === activity.id);
      return Boolean(stored && /^auto-[a-f0-9-]{36}$/.test(activity.id) && ['scheduled', 'running'].includes(stored.status)
        && stored.origin === 'greeting' && stored.kind === 'chat' && activity.kind === 'chat'
        && stored.platform === undefined && activity.platform === undefined
        && sameScope(stored.scope, activity.scope) && stored.topic === GREETING_TOPIC && activity.topic === GREETING_TOPIC
        && stored.sourceId === undefined && stored.sourceFingerprint === undefined
        && activity.sourceId === undefined && activity.sourceFingerprint === undefined
        && policy.enabled && policy.proactive && policy.greetingEnabled && this.greetingScope(activity.scope)
        && policy.targets.some(scope => sameScope(scope, activity.scope)) && this.scopes().some(scope => sameScope(scope, activity.scope))
        && !this.topicRows(state, activity.scope).length
        && !value.activities.some(row => row.kind === 'chat' && row.delivery === 'sent' && sameScope(row.scope, activity.scope))
        && !value.activities.some(row => row.status === 'unknown' || row.delivery === 'unknown' && row.status !== 'interrupted')
        && !this.greetingUnconfirmed(value, activity.scope)
        && !value.awaitingReply.some(scope => sameScope(scope, activity.scope)));
    }
    if (activity?.origin !== undefined && activity.origin !== 'memory') return false;
    if (!/^[a-f0-9]{64}$/.test(activity?.sourceFingerprint || '')) return false;
    const row = state.memories.find((item) => item.id === activity.sourceId && sameScope(item.scope, activity.scope));
    return Boolean(row && row.status === 'active' && this.memory.clarity(row, state.policy) !== 'faded'
      && text(row.summary, 160).trim() && row.summary === activity.topic
      && sourceFingerprint(row) === activity.sourceFingerprint);
  }
  skipStale(activity) {
    return this.store.update((state) => {
      const value = data(state), row = value.activities.find((item) => item.id === activity.id);
      // Unknown execution/delivery evidence is immutable to this admission
      // check. It must never be cleared or made eligible for replay.
      if (row && ['scheduled', 'running'].includes(row.status)) {
        row.status = 'skipped'; row.topic = ''; row.reason = activity.origin === 'greeting'
          ? '首次问候条件已变化，未执行旧问候' : staleSource;
        value.nextAt = Math.max(value.nextAt || 0, this.now() + (30 + Math.floor(this.random() * 91)) * 60000);
        value.nextAtPurpose = 'assessment';
      }
    }, { authorize: () => !this.closed });
  }
  userActivity(scope) {
    this.active?.controller.abort();
    if (!validScope(scope)) return;
    const value = data(this.store.read().state);
    if (!value.awaitingReply.some((row) => sameScope(row, scope))) return;
    this.store.update((state) => { const value = data(state); value.awaitingReply = value.awaitingReply.filter((row) => !sameScope(row, scope)); }, { authorize: () => !this.closed });
  }
  greetingUnconfirmed(value, scope) {
    return value.activities.some(row => row.kind === 'chat' && sameScope(row.scope, scope)
      && (row.delivery === 'unknown' || row.origin === 'greeting' && ['unknown', 'interrupted'].includes(row.status)));
  }
  tokenBudgetReason() {
    if (!this.tokenBudget) return null;
    try {
      const value = this.tokenBudget.snapshot();
      const available = value.projectedAvailableTokens ?? value.availableTokens;
      const overdrawn = value.projectedOverdrawnTokens ?? value.overdrawnTokens;
      if (value.policy?.enabled !== true) return '自主活动的 Token 额度尚未开启';
      if ((value.pendingAutonomyUnknownCount ?? value.pendingUnknownCount) > 0) return '有一笔自主 Token 用量尚未核清，请先核实';
      if (overdrawn > 0) return 'Token 零花额度已超出，请先补充额度';
      if (!Number.isSafeInteger(value.policy.requestReserveTokens) || value.policy.requestReserveTokens < 1
        || !Number.isSafeInteger(available)) return '暂时无法确认 Token 额度';
      if (available < value.policy.requestReserveTokens) return '剩余 Token 不足以开始一次自主活动';
      return null;
    } catch { return '暂时无法确认 Token 额度'; }
  }
  #admission(state, activity, randomizePlatform = false) {
    const value = data(state), policy = policyView(value.policy);
    const blocked = (reasonCode, reason) => ({ eligible: false, reasonCode, reason });
    if (!policy.enabled) return blocked('DISABLED', '自主活动未开启');
    if (quiet(policy, this.now())) return blocked('QUIET_HOURS', '当前为免打扰时段');
    if (this.active) return blocked('RUNNING', '已有自主活动正在进行或等待清理');
    if (this.isBusy()) return blocked('USER_TASK_BUSY', '优先处理用户任务');
    if (value.activities.some((row) => row.status === 'unknown' || row.delivery === 'unknown' && row.status !== 'interrupted'))
      return blocked('UNKNOWN_ACTIVITY', '有旧活动待核实，未自动重做');
    const tokenReason = this.tokenBudgetReason();
    if (tokenReason) return blocked('TOKEN_UNAVAILABLE', tokenReason);
    const today = calendar(this.now()).day;
    const todayRows = value.activities.filter((row) => row.status !== 'scheduled' && calendar(row.createdAt).day === today);
    if (todayRows.length >= policy.maxActivities) return blocked('ACTIVITY_LIMIT', '今日自主活动次数已达上限（按创建日计，含失败和跳过）');
    if (!policy.proactive && !policy.browse) return blocked('NO_ACTION', '尚未允许主动聊天或自主浏览');
    if (!policy.targets.length) return blocked('NO_TARGETS', '尚未选择自主活动的聊天对象和身份');
    const targets = policy.targets.filter(scope => this.scopes().some(known => sameScope(scope, known))
      && (!activity || sameScope(scope, activity.scope)));
    if (!targets.length) return blocked('TARGET_UNAVAILABLE', '所选账号或身份已不再启用，请核对活动对象');
    if (activity && (!['chat', 'browse'].includes(activity.kind)
      || activity.kind === 'chat' && !policy.proactive
      || activity.kind === 'browse' && (!policy.browse || !policy.platforms.includes(activity.platform))))
      return blocked('CANDIDATE_PERMISSION_CHANGED', '已计划活动的权限范围已变化，等待安全跳过旧活动');
    let reason = blocked('NO_TOPIC', '所选身份暂无可用的近期话题；新的 QQ 聊天记录后可再判断');
    for (const scope of targets) {
      const rows = this.topicRows(state, scope);
      const motive = activity && activity.origin !== 'greeting' ? rows.find(row => row.id === activity.sourceId)
        : rows.find(row => row.pending || row.pinned) || rows[0];
      const last = value.activities.filter((row) => row.kind === 'chat' && row.delivery === 'sent' && sameScope(row.scope, scope)).at(-1);
      const recent = last && this.now() - Date.parse(last.finishedAt) < policy.minGapMinutes * 60000;
      const count = value.activities.filter((row) => row.kind === 'chat' && row.delivery === 'sent' && row.finishedAt && calendar(Date.parse(row.finishedAt)).day === today && sameScope(row.scope, scope)).length;
      const awaiting = value.awaitingReply.some(row => sameScope(row, scope));
      const greetingUnconfirmed = this.greetingUnconfirmed(value, scope);
      const greeting = !rows.length && policy.greetingEnabled && this.greetingScope(scope) && !last && !greetingUnconfirmed;
      if (policy.proactive && (!activity || activity.kind === 'chat')) {
        if (awaiting) reason = blocked('WAITING_REPLY', '正在等待该身份上次主动消息的回复，不连续打扰');
        else if (count >= policy.maxContacts) reason = blocked('CONTACT_LIMIT', '该账号当前身份今日主动聊天次数已达上限');
        else if (recent) reason = blocked('MIN_GAP', '距该身份上次主动消息送达的间隔尚未结束');
        else if (!motive && policy.greetingEnabled && greetingUnconfirmed)
          reason = blocked('GREETING_UNCONFIRMED', '旧首次问候的结果仍未确认，未再次生成或发送问候');
        else if (!this.canContact(scope)) reason = blocked('CONTACT_NOT_READY', 'QQ 聊天连接或该身份尚未就绪，请等待连接确认');
        else if (motive && activity?.origin !== 'greeting')
          return { eligible: true, reasonCode: 'TOPIC_READY', kind: 'chat', origin: 'memory', scope,
            reason: '可接续该身份已聊过的话题', topic: motive.summary, sourceId: motive.id, sourceFingerprint: sourceFingerprint(motive) };
        else if (greeting && (!activity || activity.origin === 'greeting'))
          return { eligible: true, reasonCode: 'GREETING_READY', kind: 'chat', origin: 'greeting', scope,
            reason: '已允许向主要使用者当前身份发送首次简短问候', topic: GREETING_TOPIC };
      }
      if (!motive || activity?.origin === 'greeting') continue;
      if (policy.browse && (!activity || activity.kind === 'browse')) {
        if (!policy.platforms.length) { reason = blocked('NO_PLATFORM', '尚未选择可自主浏览的平台'); continue; }
        const wallet = this.wallet.snapshot();
        if (!wallet.policy.enabled) { reason = blocked('TIME_WALLET_DISABLED', '自主浏览的娱乐时间额度尚未开启'); continue; }
        if (wallet.availableSeconds <= 0) { reason = blocked('TIME_UNAVAILABLE', '自主浏览的娱乐时间已用完'); continue; }
        return { eligible: true, reasonCode: 'BROWSE_READY', kind: 'browse', origin: 'memory', scope,
          platform: activity?.platform || policy.platforms[randomizePlatform ? Math.floor(this.random() * policy.platforms.length) : 0],
          reason: '可在已授权平台了解相关内容', topic: motive.summary,
          sourceId: motive.id, sourceFingerprint: sourceFingerprint(motive) };
      }
    }
    return reason;
  }
  preview() {
    const { state } = this.store.read(), value = data(state);
    const candidate = value.activities.find(row => row.status === 'scheduled');
    const nextCheckAt = !candidate && Number.isFinite(value.nextAt) ? value.nextAt : null;
    const scheduledAt = Number.isFinite(candidate?.dueAt) ? candidate.dueAt : null;
    const meta = { nextCheckAt, scheduledAt, counterPolicy: { ...COUNTER_POLICY } };
    const result = this.#admission(state, candidate);
    if (!result.eligible && ['DISABLED', 'QUIET_HOURS', 'RUNNING', 'USER_TASK_BUSY', 'UNKNOWN_ACTIVITY', 'TOKEN_UNAVAILABLE', 'ACTIVITY_LIMIT'].includes(result.reasonCode))
      return { ...meta, ...result, readiness: result.reasonCode === 'RUNNING' ? 'running' : 'blocked' };
    if (candidate && !this.sourceCurrent(candidate, state)) return { ...meta, eligible: false, readiness: 'blocked',
      reasonCode: 'CANDIDATE_INVALID', reason: candidate.origin === 'greeting' ? '首次问候条件已变化，等待安全跳过旧问候' : staleSource };
    if (!result.eligible) return { ...meta, ...result, readiness: result.reasonCode === 'RUNNING' ? 'running' : 'blocked' };
    if (candidate && scheduledAt > this.now()) return { ...meta, eligible: false, readiness: 'waiting',
      reasonCode: 'SCHEDULED_WAIT', reason: '已有活动计划，正在等待计划时间' };
    if (!candidate && nextCheckAt > this.now()) return { ...meta, eligible: false, readiness: 'waiting',
      reasonCode: 'NEXT_CHECK_WAIT', reason: '触发条件已具备，正在等待下次检查时间' };
    return { ...meta, ...result, readiness: 'ready' };
  }
  async tick() {
    if (this.closed) return;
    if (this.active) {
      const activity = data(this.store.read().state).activities.find(row => row.id === this.active.id);
      if (!activity || !this.permitted(activity) || this.isBusy()) this.active.controller.abort();
      return;
    }
    const now = this.now(), snapshot = this.snapshot();
    const candidate = snapshot.activities.find((row) => row.status === 'scheduled');
    if (!candidate) {
      if (snapshot.nextAt && now < snapshot.nextAt) return;
      const preview = this.#admission(this.store.read().state, undefined, true);
      this.store.update((state) => {
        const value = data(state); value.nextAt = now + (30 + Math.floor(this.random() * 91)) * 60000;
        const dueAt = snapshot.nextAtPurpose === 'assessment' && snapshot.nextAt && snapshot.nextAt <= now ? now : value.nextAt;
        value.nextAtPurpose = preview.eligible ? 'candidate' : 'assessment';
        if (preview.eligible) value.activities.push({ ...preview, id: 'auto-' + randomUUID(), status: 'scheduled', delivery: 'none',
          createdAt: new Date(now).toISOString(), dueAt });
      }, { authorize: () => !this.closed });
      return;
    }
    if (now < candidate.dueAt) return;
    if (!this.sourceCurrent(candidate)) { this.skipStale(candidate); return; }
    const expired = now - candidate.dueAt > 86400000;
    // Quiet time and a temporarily unavailable connection defer this exact
    // unstarted candidate. They never authorize a replacement or a retry.
    if (!expired && this.#permitted(candidate, false)
      && (quiet(snapshot.policy, now) || candidate.kind === 'chat' && !this.canContact(candidate.scope))) return;
    if (!this.permitted(candidate) || expired) {
      this.store.update((state) => {
        const value = data(state), row = value.activities.find(item => item.id === candidate.id);
        row.status = 'skipped'; row.reason = '计划活动的授权或有效期已变化，未执行旧活动';
        value.nextAt = Math.max(value.nextAt || 0, now + (30 + Math.floor(this.random() * 91)) * 60000);
        value.nextAtPurpose = 'assessment';
      }, { authorize: () => !this.closed }); return;
    }
    if (!this.#admission(this.store.read().state, candidate).eligible) return;
    const controller = new AbortController();
    this.store.update((state) => { data(state).activities.find((row) => row.id === candidate.id).status = 'running'; }, { authorize: () => this.permitted(candidate) });
    const active = { id: candidate.id, controller, promise: null }; this.active = active;
    active.promise = this.execute(candidate, controller).finally(() => { if (this.active === active) this.active = null; });
    return active.promise;
  }
  async execute(activity, controller) {
    const stored = data(this.store.read().state).activities.find((row) => row.id === activity.id);
    if (!stored || !['scheduled', 'running'].includes(stored.status)) return;
    if (!this.sourceCurrent(activity)) { this.skipStale(activity); return; }
    let metering, mode = 'waiting', started = false, outcome = 'failed'; const authorize = () => !this.closed;
    const valid = () => !controller.signal.aborted && this.permitted(activity) && !this.isBusy();
    const save = (patch) => this.store.update((state) => { const row = data(state).activities.find((item) => item.id === activity.id); Object.assign(row, patch); }, { authorize });
    const timeout = setTimeout(() => controller.abort(), (this.snapshot().policy.sessionSeconds + 120) * 1000); timeout.unref?.();
    try {
      if (!valid()) { outcome = 'skipped'; return; }
      const tokenReason = this.tokenBudgetReason();
      if (tokenReason) { outcome = 'skipped'; save({ reason: tokenReason }); return; }
      if (activity.kind === 'browse') {
        const receipt = this.wallet.start(activity.id, { maxSeconds: this.snapshot().policy.sessionSeconds, authorize: valid });
        if (receipt.result.duplicate) return;
        started = true;
        metering = setInterval(() => {
          try { if (!valid()) controller.abort();
            if (this.wallet.meter(activity.id, mode, { authorize }).result.exhausted) controller.abort();
          } catch { controller.abort(); }
        }, 1000); metering.unref?.();
      }
      const result = await this.run(activity, { signal: controller.signal, authorize: valid,
        context: this.memory.context(activity.scope, { maxChars: 2000, query: activity.topic }),
        onUsage: (next) => { if (started) { this.wallet.meter(activity.id, next, { authorize }); mode = next; } } });
      if (result?.status === 'unknown') { outcome = 'unknown'; return; }
      if (!valid()) { outcome = 'cancelled'; return; }
      if (result?.status !== 'succeeded' || !text(result.text, 4000).trim()) { outcome = result?.status === 'unknown' ? 'unknown' : 'failed'; return; }
      if (activity.kind === 'chat') {
        save({ delivery: 'sending' });
        let receipt;
        try { receipt = await this.send({ id: activity.id, scope: activity.scope, text: text(result.text, 2000) }, { signal: controller.signal, authorize: valid }); }
        catch { outcome = 'unknown'; save({ delivery: 'unknown' }); return; }
        if (receipt?.ok !== true) { outcome = receipt?.uncertain === false ? 'failed' : 'unknown'; save({ delivery: outcome === 'unknown' ? 'unknown' : 'failed' }); return; }
        save({ delivery: 'sent' });
        this.store.update((state) => data(state).awaitingReply.push(clone(activity.scope)), { authorize });
      } else {
        try { const remembered = this.memory.recordObservation(activity, result.text, { authorize: valid }); save({ memorySaved: remembered.result?.saved === true }); }
        catch { this.memory.lastError = { code: 'STORAGE', message: '浏览已结束，但相关记忆未确认保存' }; save({ memorySaved: false }); }
      }
      outcome = 'completed';
    } catch (error) { outcome = ['CONTROL_CLEANUP_UNCONFIRMED', 'TOKEN_ACCOUNTING_UNCONFIRMED'].includes(error?.code)
      ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed'; }
    finally {
      clearTimeout(timeout); clearInterval(metering);
      if (started) {
        try { this.wallet.meter(activity.id, 'paused', { authorize, finish: true }); } catch { outcome = 'unknown'; }
      }
      save({ status: outcome, finishedAt: new Date(this.now()).toISOString() });
    }
  }
  start() {
    if (this.timer || this.closed) return;
    const value = this.snapshot();
    if (value.activities.some((row) => row.status === 'running' || row.delivery === 'sending')) {
      this.wallet.recover({ authorize: () => !this.closed });
      this.store.update((state) => { for (const row of data(state).activities) {
        if (row.status === 'running' || row.delivery === 'sending') { row.status = 'unknown'; if (row.delivery === 'sending') row.delivery = 'unknown'; }
      } }, { authorize: () => !this.closed });
    }
    this.timer = setInterval(() => { try { if (this.snapshot().policy.enabled) void this.tick().catch(() => {}); } catch {} }, 30000); this.timer.unref?.();
  }
  async cancel() { const active = this.active; active?.controller.abort(); if (active?.promise) await active.promise; return { cancelled: Boolean(active) }; }
  async dispose() { clearInterval(this.timer); await this.cancel(); this.closed = true; }
}
