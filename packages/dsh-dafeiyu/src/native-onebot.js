import { randomUUID } from 'node:crypto';
import { EXPERIENCE_TOOL_NAMES } from './experience-tools.js';
import { normalizeQQAccounts, validateQQAccounts, activeQQIdentity } from './account-identities.js';

const qqId = (value) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const text = String(value ?? '');
  return /^[1-9]\d{0,19}$/.test(text) ? text : '';
};
const messageId = (value) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const text = String(value ?? '');
  return /^-?[1-9]\d{0,39}$/.test(text) ? text : '';
};
const positive = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
const FAILURE_MESSAGES = Object.freeze({ queue_full: 'OneBot 原生队列已满，请稍后再试',
  dedup_full: 'OneBot 去重容量暂满，请稍后重试；未确认任务不会被自动重放',
  queue_expired: '排队消息已过期，未执行；请重新发送当前请求', prepare_failed: '入站预处理失败，未调用模型',
  voice_input_failed: '语音识别失败，未调用模型', voice_disabled: '语音接收未启用，未调用模型',
  connection_changed: 'QQ 连接已改变，未执行当前消息', cancelled: '入站准备已取消，未调用模型',
  model_failed: '宿主模型回合失败', timeout: '原生回合超时，执行结果需先核实', stopped: '当前会话已停止，未自动重试',
  send_failed: 'QQ 未确认送达，请核实原消息', delivery_unknown: 'QQ 送达结果未知，未自动重试',
  context_required: '上下文接近上限，需要先压缩；当前会话已暂停，原请求未自动重跑',
  context_compaction_failed: '上下文压缩未完成；当前会话已暂停，原请求未自动重跑',
  context_guard_unavailable: '上下文保护暂不可用；当前会话已暂停，原请求未自动重跑',
  session_failed: '原生会话未能完成创建', identity_changed: 'QQ 回复目标或机器人身份已改变',
  blocked: '此前回合结果待核实，当前会话已暂停', unavailable: 'OneBot 原生适配已停止' });
const PREPARE_FAILURES = Object.freeze({ VOICE_INPUT_FAILED: 'voice_input_failed', VOICE_DISABLED: 'voice_disabled',
  CONNECTION_CHANGED: 'connection_changed', CANCELLED: 'cancelled' });
const CONTEXT_FAILURES = Object.freeze({ CONTEXT_CAPACITY_REQUIRED: 'context_required',
  CONTEXT_COMPACTION_FAILED: 'context_compaction_failed', CONTEXT_GUARD_UNAVAILABLE: 'context_guard_unavailable' });
const contextFailureType = value => Object.values(CONTEXT_FAILURES).includes(value);
const TASK_STATUS_TEXT = Object.freeze({
  progress: '已收到，正在处理；完成后会回复结果。',
  voice_input_failed: '这条语音没有识别成功，尚未执行你的请求。请重新录音或发送文字。',
  no_result: '本轮已结束，但没有生成结果说明。操作结果仍需核实，请勿直接重复执行。',
  failed: '本轮未能正常结束，部分操作可能已执行，结果尚未确认。请先核实，避免重复执行。',
  timeout: '本轮处理超时，部分操作可能已执行，结果尚未确认。请先核实，避免重复执行。',
  context_required: '上下文接近上限，需要先压缩。当前会话已暂停，原请求未自动重跑。请先处理上下文，再明确恢复；恢复只接收以后发来的新消息。',
  context_compaction_failed: '上下文压缩未完成。当前会话已暂停，原请求未自动重跑。请先处理上下文，再明确恢复；恢复只接收以后发来的新消息。',
  context_guard_unavailable: '上下文保护暂不可用。当前会话已暂停，原请求未自动重跑。请先核对宿主状态，再明确恢复；恢复只接收以后发来的新消息。',
});
const failure = (failureType, { uncertain = false, rejected = false, ...extra } = {}) => ({ ok: false,
  error: FAILURE_MESSAGES[failureType] || FAILURE_MESSAGES.model_failed, failureType, ...(uncertain ? { uncertain: true } : {}),
  ...(rejected ? { rejected: true } : {}), ...extra });
const controlError = (code, message) => Object.assign(new Error(message), { code });
const taskError = (failureType, uncertain = false) => Object.assign(new Error(FAILURE_MESSAGES[failureType]), { failureType, uncertain });

/** Installed-host adapter. Each account/identity is FIFO; independent conversations
 * share bounded, round-robin execution slots. No model client or history replay. */
export class NativeOneBotBridge {
  constructor({ ctx, qqGateway, ownerQq, qqAccounts, expectedSelfId = '', logger = console, preset = 'standard', cwd,
    setupAgent, createMessage, backgroundTasks, contextGuard, onExperience, onUserActivity, rejectBeforeConnection = false, maxConcurrent = 3, maxPending = 64,
    maxConversationPending = 12, queueTimeoutMs = 60000, dedupWindowMs = 15 * 60 * 1000,
    maxSeen = 2048, maxUncertain = 256, maxReplyChars = 20000, chunkChars = 2000,
    turnTimeoutMs = 600000, createTimeoutMs = 15000, disposeTimeoutMs = 5000, progressDelayMs = 3000,
    statusTimeoutMs = 5000, now = () => Date.now() } = {}) {
    if (!ctx || typeof ctx.on !== 'function') throw new Error('NativeOneBotBridge 需要宿主 session/event 服务');
    if (typeof qqGateway?.sendMessage !== 'function') throw new Error('NativeOneBotBridge 需要 QQGateway');
    if (!qqId(ownerQq)) throw new Error('NativeOneBotBridge 需要明确的主人 QQ 号');
    if (expectedSelfId && !qqId(expectedSelfId)) throw new Error('expectedSelfId 必须是明确的机器人 QQ 号');
    if (typeof now !== 'function') throw new Error('now 必须是受信任的时钟函数');
    Object.assign(this, { ctx, qqGateway, expectedSelfId: qqId(expectedSelfId), logger, preset, cwd, setupAgent, createMessage, backgroundTasks, contextGuard, onExperience, onUserActivity, now });
    this.ownerQq = qqId(ownerQq);
    const accountConfig = { ownerQq: this.ownerQq, onebotSelfId: expectedSelfId, qqAccounts };
    if (validateQQAccounts(accountConfig).length) throw new Error('个人 QQ 账号与身份配置无效');
    this.accountConfig = JSON.parse(JSON.stringify({ ...accountConfig, qqAccounts: normalizeQQAccounts(accountConfig) }));
    this.accounts = this.accountConfig.qqAccounts;
    this.rejectBeforeConnection = rejectBeforeConnection === true;
    this.maxConcurrent = positive(maxConcurrent, 3, 8);
    this.maxPending = positive(maxPending, 64, 256);
    this.maxConversationPending = positive(maxConversationPending, 12, 64);
    this.queueTimeoutMs = positive(queueTimeoutMs, 60000, 300000);
    this.dedupWindowMs = positive(dedupWindowMs, 15 * 60 * 1000, 24 * 60 * 60 * 1000);
    this.maxSeen = positive(maxSeen, 2048, 10000);
    this.maxUncertain = positive(maxUncertain, 256, 2048);
    this.maxReplyChars = positive(maxReplyChars, 20000, 100000);
    this.chunkChars = positive(chunkChars, 2000, 4000);
    this.turnTimeoutMs = positive(turnTimeoutMs, 600000, 600000);
    this.createTimeoutMs = positive(createTimeoutMs, 15000, 60000);
    this.disposeTimeoutMs = positive(disposeTimeoutMs, 5000, 15000);
    this.progressDelayMs = positive(progressDelayMs, 3000, 60000);
    this.statusTimeoutMs = positive(statusTimeoutMs, 5000, 10000);
    this.lifetime = new AbortController();
    this.records = new Map();
    this.agentRecords = new WeakMap();
    this.conversations = new Map();
    for (const account of this.accounts) {
      const identity = account.identities.find((item) => item.id === account.activeIdentityId);
      const key = `${account.qq}:${identity.id}`;
      this.conversations.set(key, { key, qq: account.qq, identityId: identity.id, identityName: identity.name,
        queue: [], task: null, epoch: 0, record: null, blocked: false, recovering: false, requiresAck: false,
        failureType: null, failedAt: null, failureVersion: 0, lastEventAt: null, lastReplyAt: null });
    }
    this.ready = [];
    this.readySet = new Set();
    this.scheduled = false;
    this.running = 0;
    this.seen = new Map();
    this.pending = 0;
    this.record = null; // primary-account compatibility view, never a routing source
    this.closed = false;
    this.lastError = '';
    this.startedAt = this.iso();
    this.lastEventAt = null;
    this.lastReplyAt = null;
    this.creating = null;
    this.disposePromise = null;
    this.pruneTimer = null;
    this.unregister = [];
    try {
      this.unregister.push(ctx.on('session/event', (session, event) => this.onSessionEvent(session, event), { global: true }));
      this.unregister.push(ctx.on('agent/inbox/claimed', (payload) => this.onClaimed(payload), { global: true }));
    } catch (error) {
      for (const stop of this.unregister) if (typeof stop === 'function') stop();
      throw error;
    }
  }

  time() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('会话时钟无效');
    return value;
  }
  iso() { return new Date(this.time()).toISOString(); }
  service(name) { return typeof this.ctx.get === 'function' ? this.ctx.get(name) : this.ctx[name]; }

  contextFailure(record, task) {
    if (!record?.agent || typeof this.contextGuard?.failureFor !== 'function') return null;
    let diagnostic;
    try { diagnostic = this.contextGuard.failureFor(record.agent); }
    catch { return failure('context_guard_unavailable', { uncertain: true }); }
    if (!Object.hasOwn(CONTEXT_FAILURES, diagnostic?.code)) return null;
    // A refused dispatch does not prove earlier model/tool steps were absent.
    // Only an explicit whole-turn proof can remove execution uncertainty.
    return failure(CONTEXT_FAILURES[diagnostic.code], { uncertain: diagnostic.providerStarted !== false || task.providerObserved === true });
  }

  conversationStatus(conversation) {
    const c = conversation;
    const backgroundActive = this.backgroundTasks?.status?.tasks?.some((job) => job.scope?.peerId === c.qq
      && job.scope?.identityId === c.identityId && ['queued', 'running', 'cancelling'].includes(job.status)) === true;
    return { qq: c.qq, identityId: c.identityId, identityName: c.identityName,
      state: c.task ? 'running' : c.blocked ? 'blocked' : c.queue.length ? 'queued' : c.failureType ? 'failed' : 'idle',
      queued: c.queue.length, running: Boolean(c.task), recovering: c.recovering,
      lastEventAt: c.lastEventAt, lastReplyAt: c.lastReplyAt, failedAt: c.failedAt, failureType: c.failureType,
      controlVersion: `${c.epoch}:${c.failureVersion}`,
      canStop: !this.closed && !c.recovering && Boolean(c.task || c.queue.length || backgroundActive),
      canRecover: !this.closed && !c.recovering && !c.task && !c.queue.length && Boolean(c.failureType || c.blocked),
      requiresUncertainAcknowledgement: c.requiresAck };
  }

  get status() {
    const conversations = [...this.conversations.values()].map((c) => this.conversationStatus(c));
    return Object.freeze({ enabled: !this.closed, connected: this.qqGateway.connected === true,
      identityVerified: !this.closed && this.qqGateway.connected === true && this.qqGateway.online !== false
        && !this.qqGateway.identityConflict && ['get_login_info', 'heartbeat', 'lifecycle'].includes(this.qqGateway.identitySource)
        && Boolean(qqId(this.qqGateway.selfId)) && (!this.expectedSelfId || qqId(this.qqGateway.selfId) === this.expectedSelfId),
      identitySource: this.qqGateway.identitySource || '', sessionCreated: [...this.records.values()].some((r) => Boolean(r.agent)),
      pending: this.pending, queued: this.pending - this.running, running: this.running, maxConcurrent: this.maxConcurrent, dedupEntries: this.seen.size,
      uncertainEntries: [...this.seen.values()].filter((entry) => entry.uncertain && !entry.acknowledged).length,
      blocked: conversations.some((c) => c.state === 'blocked') ? FAILURE_MESSAGES.blocked : '', lastError: this.lastError,
      active: this.running > 0, startedAt: this.startedAt, modelSelection: this.record?.modelSelection || [...this.records.values()][0]?.modelSelection || null,
      lastEventAt: this.lastEventAt, lastReplyAt: this.lastReplyAt, conversations,
      enabledAccounts: this.accounts.filter((account) => account.enabled).length,
      accounts: this.accounts.map((account) => {
        const identity = account.identities.find((item) => item.id === account.activeIdentityId);
        const record = this.records.get(`${account.qq}:${identity.id}`);
        return { qq: account.qq, enabled: account.enabled, activeIdentityId: identity.id, identityName: identity.name,
          relationType: identity.relationType, sessionCreated: Boolean(record?.agent), active: Boolean(this.conversations.get(`${account.qq}:${identity.id}`)?.task) };
      }) });
  }
  getStatus() { return this.status; }

  isBackgroundScopeAuthorized(scope) {
    const profile = activeQQIdentity(this.accountConfig, scope?.peerId);
    return !this.closed && scope?.peerId === this.ownerQq && scope?.selfId === (this.expectedSelfId || qqId(this.qqGateway.selfId))
      && profile?.identity.id === scope?.identityId;
  }

  backgroundOriginForAgent(agent) {
    const publicRecord = this.findByAgent(agent), record = this.recordForAgent(agent), active = record?.active;
    if (!publicRecord || !active?.claimed || active.turnEnded || active.task?.stopRequested) return null;
    const scope = { selfId: record.selfId, peerId: record.peerId, identityId: record.identityId };
    if (!this.isBackgroundScopeAuthorized(scope)) return null;
    return { scope, originId: active.incoming.id, parent: record.agent };
  }

  /** Background results have their own receipt. They never create a parent
   * model turn, claim a new QQ message, or reuse another turn's text buffer. */
  async sendBackgroundResult(scope, text, { connection } = {}) {
    const gateway = this.qqGateway;
    const ready = () => this.isBackgroundScopeAuthorized(scope) && gateway.connected === true && gateway.online === true
      && gateway.loginVerified === true && gateway.identityConflict !== true && qqId(gateway.selfId) === scope.selfId
      && ['get_login_info', 'heartbeat', 'lifecycle'].includes(gateway.identitySource)
      && (!connection || gateway.wsClient === connection.socket && gateway.connectedAtMs === connection.connectedAtMs);
    if (!ready() || typeof text !== 'string' || !text.trim() || text.length > 16000) return { ok: false, attempted: false, uncertain: false };
    const generation = { socket: gateway.wsClient, connectedAtMs: gateway.connectedAtMs };
    let receipt;
    try { receipt = await this.wait(gateway.sendMessage(`private:${scope.peerId}`, text, { selfId: scope.selfId }),
      10000, taskError('delivery_unknown', true)); }
    catch { return { ok: false, attempted: true, uncertain: true }; }
    if (!ready() || generation.socket !== gateway.wsClient || generation.connectedAtMs !== gateway.connectedAtMs) return { ok: false, attempted: true, uncertain: true };
    if (receipt?.ok === true) {
      this.lastReplyAt = this.iso();
      const c = this.conversations.get(`${scope.peerId}:${scope.identityId}`); if (c) c.lastReplyAt = this.lastReplyAt;
      return { ...receipt, attempted: true };
    }
    return { ok: false, attempted: true, uncertain: receipt?.ok !== false || receipt?.uncertain !== false };
  }

  backgroundCommand(text) {
    if (/^(?:任务列表|后台任务|查询后台任务)$/.test(text)) return { action: 'list' };
    const acknowledged = /^确认已核实任务\s+(dfy-[a-f0-9]{16})$/.exec(text);
    if (acknowledged) return { action: 'acknowledge', id: acknowledged[1] };
    const match = /^(查询任务|任务状态|取消任务)\s+(dfy-[a-f0-9]{16})$/.exec(text);
    return match ? { action: match[1] === '取消任务' ? 'cancel' : 'get', id: match[2] } : null;
  }
  async runBackgroundCommand(incoming, command) {
    const scope = { selfId: incoming.selfId, peerId: incoming.peerId, identityId: incoming.identityId };
    const connection = { socket: this.qqGateway.wsClient, connectedAtMs: this.qqGateway.connectedAtMs };
    let text;
    try {
      if (command.action === 'list') {
        const jobs = this.backgroundTasks.list(scope);
        text = jobs.length ? jobs.slice(0, 10).map((j) => `${j.id}｜${j.title}｜${j.statusText}`).join('\n')
          + '\n可发送“查询任务 编号”或“取消任务 编号”。' : '当前身份还没有后台任务。';
      } else {
        const job = command.action === 'cancel' ? await this.backgroundTasks.cancel(command.id, scope)
          : command.action === 'acknowledge' ? await this.backgroundTasks.acknowledge(command.id, scope) : this.backgroundTasks.get(command.id, scope);
        text = `${job.id}｜${job.title}\n${job.statusText}${job.progress ? '\n' + job.progress : ''}${job.text ? '\n' + job.text : ''}${job.error ? '\n' + job.error : ''}`;
        if (command.action === 'cancel') text += '\n取消仅停止后续执行，不会撤销已经发生的操作。';
        if (command.action === 'acknowledge') text += '\n已按你的明确确认解除此任务的工作区保护；没有重做此任务，也不改变此前结果未知的记录。';
      }
    } catch { text = '当前账号身份的任务不可用或不存在；没有重新执行任务。'; }
    const result = await this.sendBackgroundResult(scope, text.slice(0, 14000), { connection });
    return { ...result, delivered: result.ok === true, command: command.action };
  }

  /** Weak provenance survives stop/recovery/disposal without retaining an unbounded agent history. */
  registerAgent(record, agent) {
    if (!agent?.session || agent.session.id !== record.sessionId) return;
    record.agent = agent;
    this.agentRecords.set(agent, record);
    this.agentRecords.set(agent.session, record);
  }
  recordForAgent(agent) {
    if (!agent || typeof agent !== 'object') return undefined;
    const record = this.agentRecords.get(agent) || (agent.session && this.agentRecords.get(agent.session));
    const real = record?.agent;
    return real?.session && (agent === real || agent.session === real.session)
      && agent.session?.id === record.sessionId && real.session.id === record.sessionId ? record : undefined;
  }
  knowsAgent(agent) { return Boolean(this.recordForAgent(agent)); }
  findByAgent(agent) {
    const record = this.recordForAgent(agent), c = record && this.conversations.get(record.key);
    if (this.closed || !record?.agent || record.revoked || record.blocked || !c || c.record !== record || c.epoch !== record.epoch
      || this.qqGateway.identityConflict === true || qqId(this.qqGateway.selfId) !== record.selfId) return undefined;
    return { channel: 'onebot', scope: 'private', selfId: record.selfId, peerId: record.peerId,
      senderId: record.peerId, sessionId: record.sessionId, agent: record.agent,
      accountProfile: JSON.parse(JSON.stringify(record.accountProfile)), identityId: record.identityId,
      replyTarget: { scope: 'private', targetId: record.peerId, selfId: record.selfId } };
  }

  validateConnectionTime(sourceSeconds, normalizedMs) {
    if (!this.rejectBeforeConnection) return { ok: true };
    const connectedAtMs = this.qqGateway.connectedAtMs;
    if (!Number.isSafeInteger(connectedAtMs) || connectedAtMs <= 0) return failure('connection_changed', { rejected: true });
    if (!Number.isSafeInteger(sourceSeconds) || sourceSeconds <= 0 || !Number.isSafeInteger(sourceSeconds * 1000)
      || normalizedMs !== sourceSeconds * 1000) return { ok: false, rejected: true, error: '消息源时间缺失、无效或与归一化时间不一致，未接收消息', failureType: 'connection_changed' };
    if (normalizedMs < Math.floor(connectedAtMs / 1000) * 1000) return { ok: false, rejected: true, error: '连接前的历史消息不会自动执行', failureType: 'connection_changed' };
    const now = this.time();
    if (normalizedMs < now - this.dedupWindowMs || normalizedMs > now + 30000) return { ok: false, rejected: true,
      error: '消息已超出有效接收时间窗，未执行', failureType: 'queue_expired' };
    return { ok: true };
  }

  validateIncoming(msg, { allowEmpty = false } = {}) {
    if (this.closed) return failure('unavailable');
    const raw = msg?.raw;
    const selfId = qqId(raw?.self_id), peerId = qqId(raw?.user_id), id = messageId(raw?.message_id);
    if (msg?.channel !== 'onebot' || raw?.post_type !== 'message' || raw?.message_type !== 'private'
      || msg.isGroup !== false || (msg.messageType !== undefined && msg.messageType !== 'private')
      || raw.group_id !== undefined || msg.groupId) return { ok: false, rejected: true, error: '只接收配置账号的 OneBot 私聊' };
    const accountProfile = activeQQIdentity(this.accountConfig, peerId);
    if (!selfId || !peerId || !id || selfId === peerId || !accountProfile
      || String(msg.userId ?? '') !== peerId || String(msg.messageId ?? '') !== id
      || (msg.selfId !== undefined && String(msg.selfId) !== selfId)
      || (this.expectedSelfId && selfId !== this.expectedSelfId) || this.qqGateway.identityConflict === true
      || qqId(this.qqGateway.selfId) !== selfId) return { ok: false, rejected: true, error: 'OneBot 账号、消息或机器人身份未验证' };
    if (typeof msg.text !== 'string' || (!allowEmpty && !msg.text.trim()) || msg.text.length > 16000) return { ok: false, rejected: true, error: '入站文本为空或超过 16000 字符' };
    const checked = this.validateConnectionTime(raw.time, msg.time);
    if (!checked.ok) return checked;
    return { ok: true, selfId, peerId, id, accountProfile, identityId: accountProfile.identity.id, text: msg.text.trim(),
      sourceSeconds: raw.time, sourceTimeMs: msg.time };
  }

  pruneSeen() {
    const cutoff = this.time() - this.dedupWindowMs;
    for (const [key, entry] of this.seen) {
      if (!entry.pending && (!entry.uncertain || entry.acknowledged) && entry.acceptedAt < cutoff
        && (!Number.isSafeInteger(entry.sourceTimeMs) || entry.sourceTimeMs < cutoff)) this.seen.delete(key);
    }
    clearTimeout(this.pruneTimer); this.pruneTimer = null;
    if (this.closed) return;
    const expirations = [...this.seen.values()].filter((entry) => !entry.pending && (!entry.uncertain || entry.acknowledged))
      .map((entry) => Math.max(entry.acceptedAt, Number.isSafeInteger(entry.sourceTimeMs) ? entry.sourceTimeMs : 0) + this.dedupWindowMs + 1);
    if (expirations.length) {
      this.pruneTimer = setTimeout(() => this.pruneSeen(), Math.max(1000, Math.min(...expirations) - this.time()));
      this.pruneTimer.unref?.();
    }
  }

  rememberFailure(c, type, { uncertain = false, blocked = false } = {}) {
    c.failureVersion++;
    c.failureType = Object.hasOwn(FAILURE_MESSAGES, type) ? type : 'model_failed';
    c.failedAt = this.iso(); this.lastError = c.failureType;
    if (blocked || uncertain) c.blocked = true;
    if (uncertain) c.requiresAck = true;
  }

  handleIncoming(msg, { prepare } = {}) {
    const incoming = this.validateIncoming(msg, { allowEmpty: typeof prepare === 'function' });
    if (!incoming.ok) return Promise.resolve(incoming);
    const c = this.conversations.get(`${incoming.peerId}:${incoming.identityId}`);
    const key = `${incoming.selfId}:${incoming.peerId}:${incoming.id}`;
    this.pruneSeen();
    if (this.seen.has(key)) return this.seen.get(key).promise;
    try { this.onUserActivity?.({ accountId: incoming.peerId, identityId: incoming.identityId }); } catch {}
    const command = this.backgroundTasks && incoming.peerId === this.ownerQq ? this.backgroundCommand(incoming.text) : null;
    if (command) {
      if (this.seen.size >= this.maxSeen) return Promise.resolve(failure('dedup_full'));
      const entry = { pending: true, acceptedAt: this.time(), sourceTimeMs: incoming.sourceTimeMs, conversationKey: c.key };
      // Install the proof before cancellation can synchronously complete a job.
      entry.promise = Promise.resolve().then(() => this.runBackgroundCommand(incoming, command)).then((result) => {
        entry.pending = false; entry.uncertain = result.uncertain === true; this.pruneSeen(); return result;
      }, () => { entry.pending = false; entry.uncertain = true; return failure('delivery_unknown', { uncertain: true }); });
      this.seen.set(key, entry); return entry.promise;
    }
    if (c.blocked || c.recovering) return Promise.resolve(failure('blocked'));
    if (prepare !== undefined && typeof prepare !== 'function') return Promise.resolve(failure('prepare_failed'));
    if (this.pending >= this.maxPending || c.queue.length + Number(Boolean(c.task)) >= this.maxConversationPending) {
      this.rememberFailure(c, 'queue_full'); return Promise.resolve(failure('queue_full'));
    }
    if (this.seen.size >= this.maxSeen || [...this.seen.values()].filter((entry) => entry.uncertain && !entry.acknowledged).length >= this.maxUncertain) {
      this.rememberFailure(c, 'dedup_full'); return Promise.resolve(failure('dedup_full'));
    }
    const acceptedAt = this.time();
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const entry = { promise, pending: true, uncertain: false, acknowledged: false, acceptedAt, sourceTimeMs: incoming.sourceTimeMs, conversationKey: c.key };
    const task = { incoming, msg, prepare, entry, promise, resolve, epoch: c.epoch, acceptedAt,
      connection: { socket: this.qqGateway.wsClient, connectedAtMs: this.qqGateway.connectedAtMs },
      expiresAt: acceptedAt + this.queueTimeoutMs, controller: new AbortController(), stage: 'queued', done: false,
      modelStarted: false, modelFinished: false, sendStarted: false, finalSendStarted: false, stopRequested: false,
      record: null, timer: null, progressTimer: null, progressPromise: null, progress: null, notification: null,
      endKind: null, hasFinalText: false, providerObserved: false, failureVersion: c.failureVersion };
    this.pending++; this.seen.set(key, entry); c.queue.push(task);
    c.lastEventAt = this.lastEventAt = this.iso();
    task.timer = setTimeout(() => this.expireTask(c, task), this.queueTimeoutMs); task.timer.unref?.();
    this.offer(c); this.schedule();
    return promise;
  }

  offer(c) {
    if (!this.closed && !c.blocked && !c.recovering && !c.task && c.queue.length && !this.readySet.has(c.key)) {
      this.readySet.add(c.key); this.ready.push(c.key);
    }
  }
  schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      while (!this.closed && this.running < this.maxConcurrent && this.ready.length) {
        const key = this.ready.shift(); this.readySet.delete(key);
        const c = this.conversations.get(key);
        if (!c || c.blocked || c.recovering || c.task || !c.queue.length) continue;
        const task = c.queue.shift();
        if (task.done) { this.offer(c); continue; }
        if (this.time() >= task.expiresAt) {
          this.rememberFailure(c, 'queue_expired'); this.settleTask(c, task, failure('queue_expired')); this.offer(c); continue;
        }
        clearTimeout(task.timer); task.stage = 'preparing'; c.task = task; this.running++;
        void this.executeTask(c, task);
      }
    });
  }
  expireTask(c, task) {
    if (task.done || task.stage !== 'queued') return;
    c.queue = c.queue.filter((entry) => entry !== task);
    if (!c.blocked) this.rememberFailure(c, 'queue_expired');
    this.settleTask(c, task, failure('queue_expired')); this.offer(c); this.schedule();
  }
  settleTask(c, task, result) {
    if (task.done) return;
    task.done = true; clearTimeout(task.timer); clearTimeout(task.progressTimer);
    task.entry.pending = false;
    task.entry.uncertain = result.uncertain === true || task.progress?.uncertain === true || task.notification?.uncertain === true;
    this.pending--; task.resolve(result);
    this.pruneSeen();
  }
  drainQueued(c, type) {
    for (const task of c.queue.splice(0)) this.settleTask(c, task, failure(type));
    this.readySet.delete(c.key);
    this.ready = this.ready.filter((key) => key !== c.key);
  }
  assertTask(c, task) {
    if (this.closed || this.lifetime.signal.aborted) throw taskError('unavailable', task.modelStarted || task.sendStarted);
    if (task.stopRequested || task.controller.signal.aborted || task.epoch !== c.epoch || c.blocked) throw taskError('stopped', task.modelStarted || task.sendStarted);
  }
  checkTarget(record, task) {
    const c = this.conversations.get(record.key);
    if (this.closed) throw taskError('unavailable', task?.modelStarted || task?.sendStarted);
    if (!c || c.record !== record || record.revoked || record.epoch !== c.epoch || record.blocked
      || !activeQQIdentity(this.accountConfig, record.peerId)
      || activeQQIdentity(this.accountConfig, record.peerId).identity.id !== record.identityId
      || this.qqGateway.identityConflict === true || qqId(this.qqGateway.selfId) !== record.selfId) throw taskError('identity_changed', task?.modelStarted || task?.sendStarted);
    if (task && this.rejectBeforeConnection && (this.qqGateway.connected !== true || this.qqGateway.online !== true
      || this.qqGateway.loginVerified !== true || !['get_login_info', 'heartbeat', 'lifecycle'].includes(this.qqGateway.identitySource)
      || this.qqGateway.wsClient !== task.connection.socket || this.qqGateway.connectedAtMs !== task.connection.connectedAtMs)) {
      throw taskError('connection_changed', task.modelStarted || task.sendStarted);
    }
    if (task) this.assertTask(c, task);
  }

  async wait(promise, milliseconds, label, signal = this.lifetime.signal) {
    if (signal.aborted) throw taskError('stopped');
    let timer, abort;
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => reject(typeof label === 'string' ? new Error(label) : label), milliseconds);
      abort = () => reject(taskError('stopped'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([promise, interrupted]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  async ensureRecord(incoming, task) {
    const key = `${incoming.peerId}:${incoming.identityId}`, c = this.conversations.get(key);
    if (c.record?.agent && !c.record.revoked) { this.checkTarget(c.record, task); return c.record; }
    if (c.record?.creation && !c.record.revoked) {
      const record = c.record;
      const handle = await this.wait(record.creation, this.createTimeoutMs, taskError('session_failed'), task.controller.signal);
      this.registerAgent(record, handle.agent); this.checkTarget(record, task); return record;
    }
    const agents = this.service('agents'), presets = this.service('agentPresets'), primary = incoming.peerId === this.ownerQq;
    const selection = this.service('agentDefaultModel')?.currentSelection?.();
    if (typeof agents?.create !== 'function' || (primary && typeof presets?.mount !== 'function')) throw new Error('宿主缺少 agents.create 或 agentPresets.mount');
    if (!selection?.provider || !selection?.model) throw new Error('宿主尚未设置默认模型');
    const record = { key, epoch: c.epoch, identityId: incoming.identityId, accountProfile: incoming.accountProfile,
      selfId: incoming.selfId, peerId: incoming.peerId,
      sessionId: `im:dafeiyu-onebot:${incoming.selfId}:dm:${incoming.peerId}:identity:${incoming.identityId}:${randomUUID()}`,
      observedTurn: null, active: null, agent: null, handle: null, blocked: '', revoked: false, cleanupPromise: null,
      modelSelection: { provider: String(selection.provider).slice(0, 160), model: String(selection.model).slice(0, 160) } };
    c.record = task.record = record; this.records.set(key, record);
    if (primary) this.record = record;
    this.checkTarget(record, task);
    const create = () => agents.create({ sessionId: record.sessionId,
      meta: primary ? { ...(this.cwd ? { cwd: this.cwd } : {}), agentPreset: this.preset } : {},
      agentOptions: { provider: selection.provider, model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) },
      setup: async (agentCtx, agent) => {
        this.checkTarget(record, task);
        if (!primary) {
          if (agentCtx === this.ctx || !agentCtx || agentCtx !== agent?.ctx) throw new Error('无法确认附加账号的独立工具作用域');
          const tools = agentCtx.get?.('tools');
          if (typeof tools?.restrict !== 'function' || typeof tools?.guard !== 'function') throw new Error('宿主缺少附加账号的工具隔离能力，未调用模型');
          const allow = typeof tools.schemas === 'function' ? tools.schemas(agent).map((item) => item.name).filter((name) => EXPERIENCE_TOOL_NAMES.includes(name)) : [];
          if (allow.length && tools.modeFor?.(agent) !== 'native') {
            if (typeof tools.presentAs !== 'function') throw new Error('宿主缺少本人经历工具的原生隔离展示能力');
            tools.presentAs('native');
            if (tools.modeFor?.(agent) !== 'native') throw new Error('本人经历工具展示未确认');
          }
          tools.guard((exec) => allow.includes(exec?.name) ? undefined : '当前账号仅限独立聊天及本人经历工具，未授权其他工具或主人私人记忆'); tools.restrict({ allow });
        }
        if (primary) await presets.mount(agentCtx, this.preset);
        // Provenance is held in this bridge's registry; no globally shared service is registered.
        this.checkTarget(record, task);
        await this.setupAgent?.(agentCtx, agent, { bridge: this, selfId: record.selfId, peerId: record.peerId, identityId: record.identityId, sessionId: record.sessionId });
      } });
    record.creation = Promise.resolve().then(() => agents.withoutInitiator ? agents.withoutInitiator(create) : create());
    this.creating = record.creation;
    try {
      const handle = await this.wait(record.creation, this.createTimeoutMs, taskError('session_failed'), task.controller.signal);
      record.handle = handle;
      if (!handle?.agent?.session || handle.agent.session.id !== record.sessionId || typeof handle.agent.followup !== 'function') throw taskError('session_failed');
      this.registerAgent(record, handle.agent); this.checkTarget(record, task); return record;
    } catch (error) {
      record.blocked = FAILURE_MESSAGES.session_failed;
      void this.retireRecord(record).catch(() => {});
      throw error;
    } finally { if (this.creating === record.creation) this.creating = null; }
  }

  retireRecord(record) {
    if (!record) return Promise.resolve();
    record.revoked = true;
    this.cancelRecord(record, record.agent);
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = (async () => {
      let handle = record.handle;
      if (!handle && record.creation) { try { handle = await record.creation; } catch {} }
      if (handle) {
        record.handle = handle;
        if (handle.agent?.session?.id === record.sessionId) this.registerAgent(record, handle.agent);
        this.cancelRecord(record, handle.agent);
        if (typeof handle.dispose !== 'function') throw controlError('BUSY', '原会话清理尚未确认');
        await handle.dispose();
      }
      record.disposed = true;
    })();
    record.cleanupPromise.catch(() => { record.cleanupFailed = true; });
    return record.cleanupPromise;
  }

  cancelRecord(record, agent) {
    if (!agent || record.cancelledAgent === agent) return;
    record.cancelledAgent = agent;
    try { agent.cancel?.({ kind: 'user' }); } catch {}
  }

  /** Fixed text only. Status delivery never means the requested operation succeeded. */
  async sendTaskStatus(c, task, kind) {
    if (!Object.hasOwn(TASK_STATUS_TEXT, kind)) return { attempted: false, delivered: false };
    if (this.qqGateway.connected !== true || this.qqGateway.online === false
      || !['get_login_info', 'heartbeat', 'lifecycle'].includes(this.qqGateway.identitySource)) return { attempted: false, delivered: false };
    const record = task.record;
    // Preparation precedes Agent creation. Only this fixed failure notice may
    // use the admitted envelope, under the same task and connection generation.
    const preparationFailure = kind === 'voice_input_failed' && !task.modelStarted && !record;
    const check = () => {
      if (!preparationFailure) { this.checkTarget(record, task); return record; }
      this.assertTask(c, task);
      const incoming = task.incoming, gateway = this.qqGateway;
      const profile = activeQQIdentity(this.accountConfig, incoming.peerId);
      if (this.conversations.get(c.key) !== c || c.task !== task || task.done || c.qq !== incoming.peerId
        || c.identityId !== incoming.identityId || profile?.identity.id !== incoming.identityId
        || gateway.connected !== true || gateway.online !== true || gateway.loginVerified !== true
        || gateway.identityConflict === true || qqId(gateway.selfId) !== incoming.selfId
        || !['get_login_info', 'heartbeat', 'lifecycle'].includes(gateway.identitySource)
        || gateway.wsClient !== task.connection.socket || gateway.connectedAtMs !== task.connection.connectedAtMs
        || !this.validateConnectionTime(incoming.sourceSeconds, incoming.sourceTimeMs).ok) throw taskError('connection_changed');
      return incoming;
    };
    let target;
    try { target = check(); }
    catch { return { attempted: false, delivered: false }; }
    if (c.task !== task || task.done) return { attempted: false, delivered: false };
    task.sendStarted = true;
    try {
      const receipt = await this.wait(this.qqGateway.sendMessage(`private:${target.peerId}`, TASK_STATUS_TEXT[kind],
        { messageId: task.incoming.id, selfId: target.selfId }), this.statusTimeoutMs,
      taskError('delivery_unknown', true), task.controller.signal);
      check();
      if (receipt?.ok === true) return { attempted: true, delivered: true };
      return { attempted: true, delivered: false,
        failureType: receipt?.ok === false && receipt?.uncertain !== true ? 'send_failed' : 'delivery_unknown',
        ...(receipt?.ok !== false || receipt?.uncertain === true ? { uncertain: true } : {}) };
    } catch { return { attempted: true, delivered: false, failureType: 'delivery_unknown', uncertain: true }; }
  }

  armProgress(c, task, active) {
    task.progressTimer = setTimeout(() => {
      task.progressTimer = null;
      if (task.done || task.modelFinished || task.stage !== 'running' || task.record?.active !== active) return;
      task.progressPromise = this.sendTaskStatus(c, task, 'progress').then((receipt) => {
        task.progress = receipt;
        if (receipt.uncertain) {
          this.cancelRecord(task.record, task.record?.agent);
          active.finish(failure('delivery_unknown', { uncertain: true }));
        }
        return receipt;
      });
    }, this.progressDelayMs);
    task.progressTimer.unref?.();
  }

  onClaimed(payload) {
    const record = this.recordForAgent(payload?.agent), active = record?.active;
    if (!active || !this.findByAgent(payload?.agent) || !Number.isSafeInteger(payload.turn)) return;
    if ((payload.message?.source?.rpcId ?? payload.message?.id) !== active.requestId) return;
    active.claimed = true; active.turn = payload.turn;
  }
  onSessionEvent(session, event) {
    const record = session && this.agentRecords.get(session), active = record?.active;
    if (this.closed || record?.revoked || !record?.agent || session !== record.agent.session || !active || active.turnEnded || !event) return;
    const c = this.conversations.get(record.key);
    if (!c || c.epoch !== active.task.epoch || active.task.stopRequested) return;
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) record.observedTurn = event.data.turn;
    if (event.type === 'user/message' && (event.data?.source?.rpcId ?? event.data?.id) === active.requestId) {
      const turn = event.data?.turn ?? record.observedTurn;
      if (Number.isSafeInteger(turn)) { active.claimed = true; active.turn = turn; }
    }
    if (!active.claimed || (event.data?.turn ?? record.observedTurn) !== active.turn) return;
    if (['assistant/message', 'tool/call', 'tool/result'].includes(event.type)) active.task.providerObserved = true;
    if (event.type === 'assistant/message' && event.surfaceOp === 'append' && !event.data?.interrupted) {
      const content = event.data?.message?.content;
      if (!Array.isArray(content) || content.some((part) => part?.type === 'tool-call')) return;
      const text = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n').trim();
      if (!text || active.texts.has(text)) return;
      active.chars += text.length + (active.texts.size ? 2 : 0);
      if (active.chars > this.maxReplyChars || active.texts.size >= 32) {
        active.turnEnded = true;
        active.finish(failure('model_failed', { uncertain: true, error: '宿主回复超过有界输出容量，未发送' }));
        queueMicrotask(() => this.cancelRecord(record, record.agent));
        return;
      }
      active.texts.add(text);
    }
    if (event.type === 'turn/end') {
      active.turnEnded = true;
      active.task.endKind = ['completed', 'error', 'aborted', 'blocked', 'max-tokens'].includes(event.data?.reason?.kind)
        ? event.data.reason.kind : 'unknown';
      active.finish(event.data?.reason?.kind === 'completed' ? { ok: true } : this.contextFailure(record, active.task) || failure('model_failed'));
    }
  }

  recordExperience(record, task, phase, userText, assistantText = '') {
    try {
      return this.onExperience?.({ phase, userText, assistantText, selfId: record.selfId,
        scope: { accountId: record.peerId, identityId: record.identityId }, sessionId: record.sessionId, messageId: task.incoming.id },
      { authorize: () => { try { this.checkTarget(record, task); return !this.closed; } catch { return false; } } });
    } catch { this.logger.warn?.('[dsh-dafeiyu] 记忆整理未确认，聊天继续'); }
  }

  async run(c, task) {
    this.assertTask(c, task);
    let msg = task.msg;
    if (task.prepare) {
      try { msg = await this.wait(Promise.resolve().then(() => task.prepare(task.msg, { signal: task.controller.signal })),
        this.turnTimeoutMs, taskError('prepare_failed'), task.controller.signal); }
      catch (error) {
        if (task.stopRequested || this.closed) throw taskError('stopped');
        throw taskError(Object.hasOwn(PREPARE_FAILURES, error?.code) ? PREPARE_FAILURES[error.code] : 'prepare_failed');
      }
    }
    this.assertTask(c, task);
    const incoming = this.validateIncoming(msg);
    if (!incoming.ok) return { ...incoming, failureType: incoming.failureType || 'prepare_failed' };
    if (incoming.peerId !== task.incoming.peerId || incoming.selfId !== task.incoming.selfId
      || incoming.id !== task.incoming.id || incoming.identityId !== task.incoming.identityId
      || incoming.sourceSeconds !== task.incoming.sourceSeconds || incoming.sourceTimeMs !== task.incoming.sourceTimeMs) throw taskError('identity_changed');
    task.stage = 'creating';
    const record = await this.ensureRecord(incoming, task); task.record = record;
    this.checkTarget(record, task);
    const timeCheck = this.validateConnectionTime(incoming.sourceSeconds, incoming.sourceTimeMs);
    if (!timeCheck.ok) return timeCheck;
    const requestId = randomUUID(); let finish;
    const completion = new Promise((resolve) => { finish = resolve; });
    const active = { requestId, task, incoming, claimed: false, turn: null, texts: new Set(), chars: 0, finish };
    record.active = active;
    try {
      const message = this.createMessage ? this.createMessage({ requestId, text: incoming.text })
        : { id: requestId, role: 'user', content: [{ type: 'text', text: incoming.text }], source: { kind: 'user', rpcId: requestId } };
      this.checkTarget(record, task); task.stage = 'running'; task.modelStarted = true;
      this.armProgress(c, task, active);
      this.recordExperience(record, task, 'received', incoming.text);
      const submitted = record.agent.followup(message);
      const result = await this.wait(Promise.resolve(submitted).then(() => completion), this.turnTimeoutMs, taskError('timeout', true), task.controller.signal);
      task.modelFinished = true; clearTimeout(task.progressTimer);
      if (task.progressPromise) await task.progressPromise;
      if (task.progress?.uncertain) return failure('delivery_unknown', { uncertain: true });
      if (!result.ok) return result;
      this.checkTarget(record, task);
      const text = [...active.texts].join('\n\n');
      task.hasFinalText = Boolean(text);
      if (!text) return failure('model_failed', { error: '原生回合结束但未返回可发送的助手正文' });
      const points = Array.from(text); let sentMessages = 0;
      for (let at = 0; at < points.length; at += this.chunkChars) {
        this.checkTarget(record, task); task.stage = 'sending'; task.sendStarted = true; task.finalSendStarted = true;
        let sent;
        try { sent = await this.wait(this.qqGateway.sendMessage(`private:${record.peerId}`,
          points.slice(at, at + this.chunkChars).join(''), { messageId: incoming.id, selfId: record.selfId }),
        10000, taskError('delivery_unknown', true), task.controller.signal); }
        catch (error) { if (task.stopRequested) throw taskError('stopped', true); throw taskError('delivery_unknown', true); }
        this.checkTarget(record, task);
        if (sent?.ok !== true) return failure(sent?.uncertain === true || sent?.ok !== false ? 'delivery_unknown' : 'send_failed',
          { uncertain: sent?.uncertain === true || sent?.ok !== false, sentMessages });
        sentMessages++;
      }
      this.recordExperience(record, task, 'completed', incoming.text, text);
      c.lastReplyAt = this.lastReplyAt = this.iso();
      return { ok: true, delivered: true, sessionId: record.sessionId, messageId: incoming.id, sentMessages };
    } finally {
      task.modelFinished = true; clearTimeout(task.progressTimer);
      if (task.progressPromise) await task.progressPromise;
      this.recordExperience(record, task, 'failed', incoming.text, [...active.texts].join('\n\n'));
      task.hasFinalText = active.texts.size > 0;
      if (record.active === active) record.active = null;
    }
  }

  async executeTask(c, task) {
    let result;
    try { result = await this.run(c, task); }
    catch (error) {
      const type = task.stopRequested ? 'stopped' : Object.hasOwn(FAILURE_MESSAGES, error?.failureType) ? error.failureType
        : task.stage === 'creating' ? 'session_failed' : 'model_failed';
      const uncertain = error?.uncertain === true || (task.stopRequested && (task.modelStarted || task.sendStarted));
      result = !task.stopRequested && this.contextFailure(task.record, task) || failure(type, { uncertain });
    }
    if (task.stopRequested && result.ok) result = failure('stopped', { uncertain: task.modelStarted || task.sendStarted });
    if (!result.ok && !task.modelStarted && !task.stopRequested && result.failureType === 'voice_input_failed') {
      task.stage = 'notifying';
      task.notification = await this.sendTaskStatus(c, task, 'voice_input_failed');
    }
    if (!result.ok && task.modelStarted && !task.stopRequested && !task.finalSendStarted && !task.progress?.uncertain
      && ['model_failed', 'timeout'].includes(result.failureType)) {
      if (result.uncertain) this.cancelRecord(task.record, task.record?.agent);
      task.stage = 'notifying';
      task.notification = await this.sendTaskStatus(c, task, result.failureType === 'timeout' ? 'timeout'
        : task.endKind === 'completed' && !task.hasFinalText ? 'no_result' : 'failed');
    }
    if (!result.ok && contextFailureType(result.failureType) && !task.stopRequested && !task.finalSendStarted && !task.progress?.uncertain) {
      task.stage = 'notifying';
      task.notification = await this.sendTaskStatus(c, task, result.failureType);
    }
    if (task.stopRequested) result = failure('stopped', { uncertain: task.modelStarted || task.sendStarted });
    if (task.progress) result = { ...result, progress: task.progress };
    if (task.notification) result = { ...result, notification: task.notification };
    if (!result.ok) {
      this.rememberFailure(c, result.failureType || 'model_failed', { uncertain: result.uncertain === true
        || task.progress?.uncertain === true || task.notification?.uncertain === true,
        blocked: result.failureType === 'session_failed' || contextFailureType(result.failureType) || task.stopRequested });
      if (c.blocked) {
        if (task.record) {
          task.record.blocked = FAILURE_MESSAGES[result.failureType] || FAILURE_MESSAGES.blocked;
          if (!contextFailureType(result.failureType)) void this.retireRecord(task.record).catch(() => {});
        }
        this.drainQueued(c, 'blocked');
      }
    } else if (c.failureVersion === task.failureVersion) { c.failureType = null; c.failedAt = null; this.lastError = ''; }
    this.settleTask(c, task, result);
    if (c.task === task) c.task = null;
    this.running--; this.offer(c); this.schedule();
  }

  controlConversation({ qq, identityId } = {}) {
    if (this.closed) throw controlError('UNAVAILABLE', 'OneBot 原生适配已停止');
    if (!qqId(qq) || typeof identityId !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(identityId)) throw controlError('INVALID_CONVERSATION', '请选择已配置的账号与身份');
    const c = this.conversations.get(`${qq}:${identityId}`);
    if (!c) throw controlError('INVALID_CONVERSATION', '当前运行中没有该账号与身份');
    return c;
  }
  async stopConversation(target = {}) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some((key) => !['qq', 'identityId'].includes(key))) throw controlError('INVALID_CONVERSATION', '停止会话参数无效');
    const c = this.controlConversation(target);
    if (c.recovering) throw controlError('BUSY', '该会话正在恢复');
    const backgroundActive = this.conversationStatus(c).canStop && !c.task && !c.queue.length;
    if (c.qq === this.ownerQq && this.backgroundTasks) await this.backgroundTasks.cancelScope({ selfId: this.expectedSelfId || qqId(this.qqGateway.selfId), peerId: c.qq, identityId: c.identityId });
    if (!c.task && !c.queue.length) return { ok: true, stopped: backgroundActive, conversation: this.conversationStatus(c) };
    const task = c.task;
    c.epoch++;
    this.rememberFailure(c, 'stopped', { blocked: true, uncertain: Boolean(task?.modelStarted || task?.sendStarted) });
    this.drainQueued(c, 'stopped');
    if (task) {
      task.stopRequested = true;
      task.controller.abort();
      task.record?.active?.finish(failure('stopped', { uncertain: task.modelStarted || task.sendStarted }));
    }
    if (c.record) void this.retireRecord(c.record).catch(() => {});
    if (task) await task.promise;
    return { ok: true, stopped: true, conversation: this.conversationStatus(c) };
  }
  async recoverConversation(target = {}) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some((key) => !['qq', 'identityId', 'acknowledgeUncertain', 'freshSession', 'controlVersion'].includes(key))
      || target.acknowledgeUncertain !== undefined && typeof target.acknowledgeUncertain !== 'boolean'
      || target.freshSession !== undefined && typeof target.freshSession !== 'boolean'
      || target.controlVersion !== undefined && (typeof target.controlVersion !== 'string' || !/^\d{1,20}:\d{1,20}$/.test(target.controlVersion))) throw controlError('INVALID_CONVERSATION', '恢复会话参数无效');
    const c = this.controlConversation(target);
    if (target.controlVersion !== undefined && target.controlVersion !== this.conversationStatus(c).controlVersion) throw controlError('CONFLICT', '会话结果已变化，请刷新并重新核对');
    if (c.task || c.queue.length || c.recovering) throw controlError('BUSY', '该会话仍在执行或清理，请稍后重试');
    if (target.freshSession === true && !contextFailureType(c.failureType)) throw controlError('INVALID_CONVERSATION', '只有上下文暂停的会话可明确选择换新会话');
    if (c.requiresAck && target.acknowledgeUncertain !== true) throw controlError('UNCERTAIN_ACK_REQUIRED', '请先核实此前操作或送达结果，并明确确认后恢复');
    if (!c.failureType && !c.blocked) return { ok: true, recovered: false, conversation: this.conversationStatus(c) };
    c.recovering = true;
    const record = c.record;
    try {
      const contextPaused = contextFailureType(c.failureType);
      const freshSession = target.freshSession === true;
      if (freshSession && !record?.agent) throw controlError('CONTEXT_RECOVERY_REQUIRED', '原会话尚无法核实，请先检查宿主；没有创建新会话或重放请求');
      if (contextPaused && !freshSession) {
        const guard = this.contextGuard, epoch = c.epoch;
        const unavailable = () => controlError('CONTEXT_RECOVERY_REQUIRED', '请先在宿主处理上下文压缩或保护状态，再明确恢复；原请求不会自动重跑');
        if (!record?.agent || record.revoked || typeof guard?.checkRecovery !== 'function' || typeof guard?.clear !== 'function') throw unavailable();
        let checked;
        try { checked = await this.wait(Promise.resolve(guard.checkRecovery(record.agent)), this.createTimeoutMs, unavailable()); }
        catch { if (this.closed) throw controlError('UNAVAILABLE', 'OneBot 原生适配已停止'); throw unavailable(); }
        if (this.closed) throw controlError('UNAVAILABLE', 'OneBot 原生适配已停止');
        if (c.record !== record || c.epoch !== epoch || this.contextGuard !== guard || checked?.allowed !== true) throw unavailable();
        try { await guard.clear(record.agent); }
        catch { throw unavailable(); }
        if (this.closed) throw controlError('UNAVAILABLE', 'OneBot 原生适配已停止');
        if (c.record !== record || c.epoch !== epoch) throw unavailable();
        record.blocked = '';
      }
      const keepAgent = contextPaused ? !freshSession : !c.blocked && !c.requiresAck && ['queue_full', 'dedup_full', 'queue_expired', 'prepare_failed',
        'voice_input_failed', 'voice_disabled', 'connection_changed', 'cancelled'].includes(c.failureType);
      if (record && !keepAgent) {
        try { await this.wait(this.retireRecord(record), this.disposeTimeoutMs, controlError('BUSY', '原会话清理尚未确认，请稍后重试'), new AbortController().signal); }
        catch { throw controlError('BUSY', '原会话清理尚未确认，请稍后重试'); }
        if (freshSession && record.disposed !== true) throw controlError('BUSY', '原会话清理尚未确认，没有创建新会话');
      }
      if (this.closed) throw controlError('UNAVAILABLE', 'OneBot 原生适配已停止');
      if (!keepAgent) c.epoch++;
      for (const entry of this.seen.values()) if (entry.conversationKey === c.key && entry.uncertain) entry.acknowledged = true;
      if (!keepAgent) {
        c.record = null; this.records.delete(c.key);
        if (this.record === record) this.record = null;
      }
      c.blocked = false; c.requiresAck = false; c.failureType = null; c.failedAt = null;
      this.pruneSeen();
      c.recovering = false;
      return { ok: true, recovered: true, ...(freshSession ? { freshSession: true } : {}), conversation: this.conversationStatus(c) };
    } finally { c.recovering = false; }
  }

  async dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.closed = true; this.lifetime.abort(); clearTimeout(this.pruneTimer);
    for (const stop of this.unregister.splice(0)) { try { if (typeof stop === 'function') stop(); } catch {} }
    const waits = [];
    for (const c of this.conversations.values()) {
      c.epoch++; this.drainQueued(c, 'unavailable');
      if (c.task) { c.task.stopRequested = true; c.task.controller.abort(); c.record?.active?.finish(failure('unavailable')); waits.push(c.task.promise); }
      if (c.record) waits.push(this.retireRecord(c.record));
    }
    this.disposePromise = (async () => {
      try { await this.wait(Promise.allSettled(waits), this.disposeTimeoutMs, '原生会话清理超时', new AbortController().signal); }
      catch { this.logger.warn?.('[native-onebot] 原生会话清理未在期限内确认'); }
      // Cleared only when this whole adapter is disposed, never on per-conversation recovery.
      this.seen.clear();
    })();
    return this.disposePromise;
  }
}

export default NativeOneBotBridge;
