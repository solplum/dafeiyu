/** Owner-only settings routes. Device checks require explicit POST actions; credentials never appear in responses. */
import fs from 'node:fs';
import { SOCIAL_ACCOUNT_ROUTES, SOCIAL_ACCOUNT_ERRORS, socialAccountRoute } from './social/account-routes.mjs';
import { SocialAccountError } from './social/platforms.mjs';
import { lifeOperation, lifeError } from './life-panel.js';
import { tokenOperation, tokenError } from './token-panel.js';
import { ConfigStoreError } from './config-store.js';
import { NapCatPanelError } from './napcat-panel.js';
import { PanelLibraryError } from './panel-library.js';
import { ModelPanelError } from './model-panel.js';
import { DependencyPanelError } from './dependency-panel.js';
import { testSpeechAudio, MAX_SPEECH_TEST_BODY } from './speech-test.js';

const PREFIX = '/dafeiyu-panel/api/';
const MAX_BODY = 32768;
// Account identities are structured settings; keep their request bounded by
// the private store's file limit without widening ordinary action requests.
const MAX_CONFIG_BODY = 1024 * 1024;
const MAX_IMPORT_BODY = 12 * 1024 * 1024;
const CONVERSATION_FAILURES = new Set(['queue_full', 'queue_expired', 'prepare_failed', 'model_failed', 'timeout',
  'stopped', 'send_failed', 'delivery_unknown', 'session_failed', 'identity_changed', 'voice_input_failed', 'voice_disabled',
  'connection_changed', 'cancelled', 'dedup_full', 'context_required', 'context_compaction_failed', 'context_guard_unavailable']);
const conversationTimestamp = (value) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
export function safeConversations(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 240).filter((item) => item && /^[1-9]\d{0,19}$/.test(item.qq || '')
    && /^[A-Za-z0-9_-]{1,48}$/.test(item.identityId || '')).map((item) => ({
    qq: String(item.qq), identityId: String(item.identityId), identityName: typeof item.identityName === 'string'
      ? item.identityName.slice(0, 80).replace(/[\x00-\x1f\x7f]/g, '') : '',
    state: ['idle', 'queued', 'running', 'failed', 'blocked'].includes(item.state) ? item.state : 'idle',
    queued: Number.isSafeInteger(item.queued) ? Math.max(0, Math.min(64, item.queued)) : 0, running: item.running === true, recovering: item.recovering === true,
    lastEventAt: conversationTimestamp(item.lastEventAt), lastReplyAt: conversationTimestamp(item.lastReplyAt),
    failedAt: conversationTimestamp(item.failedAt), failureType: CONVERSATION_FAILURES.has(item.failureType) ? item.failureType : null,
    canStop: item.canStop === true, canRecover: item.canRecover === true,
    requiresUncertainAcknowledgement: item.requiresUncertainAcknowledgement === true,
    controlVersion: typeof item.controlVersion === 'string' && /^\d{1,20}:\d{1,20}$/.test(item.controlVersion) ? item.controlVersion : null,
  }));
}
const json = (res, status, data) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};

export function ownerRequestRejection(connection, req) {
  try {
    if (typeof connection?.admit !== 'function') return 403;
    const admission = connection.admit(req);
    if (!admission || typeof admission !== 'object') return 403;
    if ('rejection' in admission) return admission.rejection === 401 ? 401 : 403;
    if (!admission.peer || admission.peer.signal?.aborted === true
      || admission.peer.principal?.kind !== 'owner') return 403;
    return null;
  } catch { return 403; }
}

async function readJson(req, maxBody = MAX_BODY) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type'] || ''))) {
    throw new ConfigStoreError('INVALID_PATCH', '请使用 JSON 提交配置');
  }
  const declared = req.headers?.['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > maxBody)) {
    throw new ConfigStoreError('INVALID_PATCH', '配置请求过大');
  }
  const parts = [];
  let length = 0;
  for await (const part of req) {
    const bytes = Buffer.from(part);
    length += bytes.length;
    if (length > maxBody) throw new ConfigStoreError('INVALID_PATCH', '配置请求过大');
    parts.push(bytes);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new ConfigStoreError('INVALID_PATCH', '配置不是有效 JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ConfigStoreError('INVALID_PATCH', '配置请求必须是对象');
  }
  return result;
}

export class ConfigurationPanelController {
  constructor({ store, getRuntime, getAppliedRevision, getAppliedSettings, apply, getApplying, getRuntimeError, paths, napcat, library,
    model, dependencies, voice, social, diagnostics, memory, capabilities, getModelInfo, getMaintenanceBusy }) {
    Object.assign(this, { store, getRuntime, getAppliedRevision, applyRuntime: apply,
      getAppliedSettings, getApplying, getRuntimeError, getPaths: paths, napcat, library,
      model, dependencies, voice, social, diagnostics, memory, capabilities, getModelInfo, getMaintenanceBusy });
  }

  getState() {
    const config = this.store.snapshot();
    const runtime = this.getRuntime();
    config.running = runtime ? this.getAppliedSettings?.() || null : null;
    const applying = Boolean(this.getApplying());
    const pendingReload = !runtime || config.revision !== this.getAppliedRevision();
    config.requiresReload = pendingReload;
    const personalQQ = runtime?.nativeTools?.getPersonalQQStatus?.() || {
      configured: Boolean(config.effective.ownerQq && config.effective.onebotSelfId && config.effective.onebotWs),
      enabled: false, engine: config.effective.onebotEngine, connected: false, loginVerified: false,
      online: null, identityConflict: false, sessionCreated: false,
    };
    const phoneEnabled = runtime?.phoneTools?.enabled === true;
    const activity = runtime?.nativeOneBot?.status;
    let modelInfo = {}; try { modelInfo = this.getModelInfo?.() || {}; } catch {}
    return { ok: true, config, pendingReload, canApply: typeof this.applyRuntime === 'function',
      runtime: { ready: Boolean(runtime), applying,
        error: this.getRuntimeError() ? '伴侣未能启动，请检查配置后重新应用' : '',
        personalQQ, phone: this.diagnostics?.phone?.() || { enabled: phoneEnabled, state: phoneEnabled ? 'not-probed' : 'offline',
          device: String(runtime?.phoneTools?.device || '') },
        model: { managedByHost: true, ...modelInfo },
        voiceInput: { ...(runtime?.voiceProcessor?.status || { configured: false, active: 0, readiness: 'not-verified', lastResult: null }),
          receiveEnabled: runtime?.configuration?.voiceTranscription === true },
        companion: { active: activity?.active === true || Number(runtime?.incomingPending || 0) > 0 || Number(runtime?.backgroundTasks?.status?.active || 0) > 0,
          foregroundActive: activity?.active === true || Number(runtime?.incomingPending || 0) > 0,
          backgroundActive: Number(runtime?.backgroundTasks?.status?.active || 0),
          pending: Math.max(Number(activity?.pending || 0), Number(runtime?.incomingPending || 0)) + Number(runtime?.backgroundTasks?.status?.active || 0),
          sessionCreated: activity?.sessionCreated === true, blocked: Boolean(activity?.blocked),
          lastError: Boolean(activity?.lastError), startedAt: activity?.startedAt || null,
          lastEventAt: runtime?.lastReceivedAt || activity?.lastEventAt || null, lastReplyAt: activity?.lastReplyAt || null,
          conversations: safeConversations(activity?.conversations) },
        backgroundTasks: runtime?.backgroundTasks ? { ...runtime.backgroundTasks.status,
          executors: runtime.backgroundTasks.executorStatus?.() || [] } : { ready: false, active: 0, running: 0, queued: 0,
          pendingDelivery: 0, deliveryUnknown: 0, tasks: [], executors: [] },
        capabilities: this.capabilities?.snapshot() || { busy: false, checkedAt: null, items: [] },
        contextProtection: runtime?.contextGuard?.snapshot() || { enabled: false },
        busy: runtime?.socialAccounts?.busy === true || Boolean(runtime?.autonomy?.active) || Number(runtime?.tokenAccounting?.active || 0) > 0 || applying || this.getMaintenanceBusy?.() === true || Number(runtime?.incomingPending || 0) > 0 || Number(runtime?.nativeOneBot?.status?.pending || 0) > 0
          || this.capabilities?.snapshot().busy === true
          || runtime?.backgroundTasks?.status?.busy === true
          || Number(runtime?.phoneTools?.active || 0) > 0
          || Number(runtime?.voiceProcessor?.active || 0) > 0 || Number(runtime?.voiceOutput?.active || 0) > 0 || Number(this.diagnostics?.active || 0) > 0
          || Number(runtime?.biliBrowser?.status?.active || 0) > 0 || runtime?.biliBrowser?.cleanupPending === true || this.social?.checking === true
          || Number(runtime?.douyinBrowser?.active || 0) > 0 || runtime?.douyinBrowser?.cleanupPending === true },
      paths: this.getPaths() };
  }

  save(body) {
    if (this.getApplying()) throw new ConfigStoreError('BUSY', '正在应用配置，请稍后保存');
    if (this.capabilities?.snapshot().busy) throw new ConfigStoreError('BUSY', '正在验证能力，请等验证结束后保存');
    if (Object.keys(body).some((key) => !['patch', 'revision', 'clearSecrets'].includes(key))) {
      throw new ConfigStoreError('INVALID_PATCH', '配置请求包含未知字段');
    }
    this.store.save(body.patch, { revision: body.revision, clearSecrets: body.clearSecrets });
    return this.getState();
  }

  async capabilityOperation(action, body, { authorize = () => false, runtime = this.getRuntime(), capabilities = this.capabilities } = {}) {
    const keys = action === 'probe' ? ['id', 'requestId'] : [];
    if (!['check', 'probe'].includes(action) || !body || Object.keys(body).some((key) => !keys.includes(key))
      || action === 'probe' && (typeof body.id !== 'string' || typeof body.requestId !== 'string'))
      throw new ConfigStoreError('INVALID_REQUEST', '能力检测请求无效');
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要当前主人权限');
    if (!capabilities || !runtime) throw new ConfigStoreError('UNAVAILABLE', '能力检测尚未就绪，请先启动伴侣');
    if (runtime !== this.getRuntime() || capabilities !== this.capabilities)
      throw new ConfigStoreError('CONFLICT', '能力运行实例已变化，请刷新后再试');
    if (this.getState().runtime.busy) throw new ConfigStoreError('BUSY', '请等当前任务或能力验证结束后再试');
    const stillAuthorized = () => authorize() && runtime === this.getRuntime() && capabilities === this.capabilities;
    let result;
    try { result = await (action === 'probe' ? capabilities.probe(body.id, { requestId: body.requestId, authorize: stillAuthorized })
      : capabilities.detect({ authorize: stillAuthorized })); }
    catch (error) {
      const messages = { FORBIDDEN: '需要当前主人权限', INVALID_REQUEST: '能力或验证编号无效', BUSY: '已有能力验证正在执行',
        UNAVAILABLE: '当前没有可用的验证入口', DISABLED: '请先启用并应用相关配置', STORAGE_UNAVAILABLE: '能力验证记录不可用，请检查本地存储',
        LIMIT: '近期验证记录已满，请稍后再试', CANCELLED: '能力验证已取消' };
      const code = Object.hasOwn(messages, error?.code) ? error.code : 'UNAVAILABLE';
      throw new ConfigStoreError(code, messages[code]);
    }
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '当前主人权限已撤销');
    if (runtime !== this.getRuntime() || capabilities !== this.capabilities)
      throw new ConfigStoreError('CONFLICT', '能力运行实例已变化，请刷新后再试');
    const { state: snapshot, ...response } = result;
    return { ...response, capabilities: snapshot || capabilities.snapshot(), state: this.getState() };
  }

  async desktopContextOperation(action, body, { authorize = () => false, runtime = this.getRuntime(), signal } = {}) {
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new ConfigStoreError('INVALID_PATCH', '桌面会话请求无效');
    const keys = action === 'status' ? [] : action === 'preview' ? ['sessionId', 'maxTokens', 'expectedSeq']
      : action === 'recover' ? ['sessionId', 'previewId', 'acknowledgeNoReplay'] : null;
    if (!keys || Object.keys(body).some(key => !keys.includes(key))
      || action !== 'status' && (typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.sessionId))
      || action === 'preview' && (body.maxTokens !== 8192 || !Number.isSafeInteger(body.expectedSeq) || body.expectedSeq < 0)
      || action === 'recover' && (typeof body.previewId !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/.test(body.previewId) || body.acknowledgeNoReplay !== true)) {
      throw new ConfigStoreError('INVALID_PATCH', '请刷新桌面会话，再预览容量并明确确认不重跑旧请求');
    }
    const manager = runtime?.desktopContext;
    const authorized = () => authorize() === true && !signal?.aborted;
    const current = () => runtime === this.getRuntime() && manager === runtime?.desktopContext;
    const ready = () => {
      if (!authorized()) throw new ConfigStoreError('FORBIDDEN', '当前主人权限或请求已撤销');
      if (!current()) throw new ConfigStoreError('CONFLICT', '桌面会话运行实例已变化，请刷新核对');
      if (!manager || typeof manager.snapshot !== 'function') throw new ConfigStoreError('UNAVAILABLE', '桌面会话容量管理尚未就绪');
      if (action !== 'status' && (this.getApplying?.() || this.getMaintenanceBusy?.() || this.getState().runtime.busy))
        throw new ConfigStoreError('BUSY', '请等当前任务或服务维护完成后再检查恢复');
    };
    ready();
    let result;
    try { result = action === 'status' ? manager.snapshot() : await manager[action](body, {
      authorize: () => authorized() && current() && !this.getApplying?.() && !this.getMaintenanceBusy?.()
        && this.getState().runtime.busy !== true, signal }); }
    catch (error) {
      const messages = { FORBIDDEN: '当前主人权限或请求已撤销', CONFLICT: '会话或容量检查已变化，请刷新并重新预览',
        BUSY: '该会话仍在处理或有排队消息，请先停止并核对', INVALID_REQUEST: '桌面会话请求无效',
        NOT_FOUND: '当前可信桌面会话不存在，请刷新核对', CONTEXT_RECOVERY_REQUIRED: '请先重新预览完整请求容量，确认后再恢复',
        CONTEXT_CAPACITY_REQUIRED: '调整输出上限后仍超出容量保护线，请先处理上下文',
        STORAGE_UNAVAILABLE: '容量保护记录不可用，已保持暂停，请检查本地存储',
        UNAVAILABLE: '桌面会话容量暂时无法确认，已保持暂停' };
      const code = Object.hasOwn(messages, error?.code) ? error.code : 'UNAVAILABLE';
      throw new ConfigStoreError(code, messages[code]);
    }
    ready();
    return { ok: true, desktopContext: result };
  }

  async controlConversation(action, body, { authorize = () => false, runtime = this.getRuntime() } = {}) {
    const keys = action === 'stop' ? ['qq', 'identityId'] : ['qq', 'identityId', 'acknowledgeUncertain', 'freshSession', 'controlVersion'];
    if (Object.keys(body).some((key) => !keys.includes(key)) || typeof body.qq !== 'string' || !/^[1-9]\d{0,19}$/.test(body.qq)
      || typeof body.identityId !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(body.identityId)
      || body.acknowledgeUncertain !== undefined && typeof body.acknowledgeUncertain !== 'boolean'
      || body.freshSession !== undefined && typeof body.freshSession !== 'boolean'
      || body.controlVersion !== undefined && (typeof body.controlVersion !== 'string' || !/^\d{1,20}:\d{1,20}$/.test(body.controlVersion))) {
      throw new ConfigStoreError('INVALID_CONVERSATION', '会话操作参数无效');
    }
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要本机主人登录权限');
    if (this.getRuntime() !== runtime) throw new ConfigStoreError('CONFLICT', '会话运行实例已变化，请刷新后重试');
    if (this.getApplying?.() || this.getMaintenanceBusy?.()) throw new ConfigStoreError('BUSY', '服务正在重载或维护，请稍后操作会话');
    const bridge = runtime?.nativeOneBot, method = action === 'stop' ? 'stopConversation' : 'recoverConversation';
    if (typeof bridge?.[method] !== 'function') throw new ConfigStoreError('UNAVAILABLE', '当前会话管理尚未就绪');
    let result;
    try { result = await bridge[method](body); }
    catch (error) {
      const messages = { INVALID_CONVERSATION: '会话不存在或参数无效，请刷新后重试', BUSY: '该会话仍在处理，请先停止后再恢复',
        CONFLICT: '会话结果已变化，请刷新并重新核对。',
        UNCERTAIN_ACK_REQUIRED: '此前执行或送达结果未知，请先明确确认恢复风险',
        CONTEXT_RECOVERY_REQUIRED: '上下文仍需处理：压缩后可检查恢复，也可明确选择新会话接收后续消息；原请求不会自动重跑。',
        UNAVAILABLE: '当前会话管理尚未就绪' };
      const code = Object.hasOwn(messages, error?.code) ? error.code : 'UNAVAILABLE';
      throw new ConfigStoreError(code, messages[code]);
    }
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要本机主人登录权限');
    if (this.getRuntime() !== runtime || runtime?.nativeOneBot !== bridge) throw new ConfigStoreError('CONFLICT', '会话运行实例已变化，请刷新后重试');
    return { ok: true, result: { action, stopped: action === 'stop' && result?.stopped === true,
      recovered: action === 'recover' && result?.recovered === true, freshSession: result?.freshSession === true, message: action === 'stop'
        ? '已处理此会话的停止请求；不会重放消息，请核对最新状态。' : result?.freshSession === true
          ? '已结束旧上下文；下一条新消息将使用新会话，原请求未重跑。'
          : '此会话已恢复接收后续新消息；未重新执行此前请求。' }, state: this.getState() };
  }

  async cancelBackgroundTask(body, { authorize = () => false, runtime = this.getRuntime() } = {}) {
    if (!body || Object.keys(body).some((key) => !['taskId', 'qq', 'identityId'].includes(key))
      || !/^dfy-[a-f0-9]{16}$/.test(body.taskId || '') || !/^[1-9]\d{0,19}$/.test(body.qq || '')
      || !/^[A-Za-z0-9_-]{1,48}$/.test(body.identityId || '')) throw new ConfigStoreError('INVALID_PATCH', '后台任务参数无效');
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要本机主人登录权限');
    if (runtime !== this.getRuntime()) throw new ConfigStoreError('CONFLICT', '运行实例已变化，请刷新后重试');
    const manager = runtime?.backgroundTasks;
    if (!manager) throw new ConfigStoreError('UNAVAILABLE', '后台任务尚未就绪');
    let task;
    try { task = await manager.cancel(body.taskId, { selfId: runtime.nativeOneBot?.expectedSelfId, peerId: body.qq, identityId: body.identityId }); }
    catch { throw new ConfigStoreError('UNAVAILABLE', '当前账号身份的任务不可用或不存在，未重复执行'); }
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要本机主人登录权限');
    if (runtime !== this.getRuntime() || runtime.backgroundTasks !== manager) throw new ConfigStoreError('CONFLICT', '运行实例已变化，请刷新后重试');
    return { ok: true, task, state: this.getState() };
  }

  async testBackgroundTask(body, { authorize = () => false, runtime = this.getRuntime() } = {}) {
    if (Object.keys(body).some((key) => !['executor', 'requestId'].includes(key))
      || !['native', 'codex', 'zcode', 'minimax'].includes(body.executor) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.requestId || '')) throw new ConfigStoreError('INVALID_PATCH', '连通测试参数无效');
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要本机主人登录权限');
    if (runtime !== this.getRuntime()) throw new ConfigStoreError('CONFLICT', '运行实例已变化，请刷新后重试');
    if (!runtime?.probeBackgroundTask || this.getApplying?.() || this.getState().runtime.busy) throw new ConfigStoreError('BUSY', '请等当前任务结束或应用完成后再测试');
    let task;
    try { task = await runtime.probeBackgroundTask(body, { authorize }); }
    catch { throw new ConfigStoreError('UNAVAILABLE', '连通测试未能受理，请核对QQ登录及执行器状态；未自动重试'); }
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要本机主人登录权限');
    if (runtime !== this.getRuntime()) throw new ConfigStoreError('CONFLICT', '运行实例已变化，请刷新后重试');
    return { ok: true, task, state: this.getState() };
  }

  async acknowledgeBackgroundTask(body, { authorize = () => false, runtime = this.getRuntime() } = {}) {
    if (!body || Object.keys(body).some((key) => !['taskId', 'qq', 'identityId', 'confirmedStopped'].includes(key))
      || body.confirmedStopped !== true || !/^dfy-[a-f0-9]{16}$/.test(body.taskId || '')
      || !/^[1-9]\d{0,19}$/.test(body.qq || '') || !/^[A-Za-z0-9_-]{1,48}$/.test(body.identityId || '')) throw new ConfigStoreError('INVALID_PATCH', '请先明确确认旧执行器已停止');
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要本机主人登录权限');
    if (runtime !== this.getRuntime()) throw new ConfigStoreError('CONFLICT', '运行实例已变化，请刷新后重试');
    if (this.getApplying?.() || this.getMaintenanceBusy?.()) throw new ConfigStoreError('BUSY', '服务正在重载或维护');
    const manager = runtime?.backgroundTasks;
    if (!manager?.acknowledge) throw new ConfigStoreError('UNAVAILABLE', '后台任务尚未就绪');
    let task;
    try { task = await manager.acknowledge(body.taskId, { selfId: runtime.nativeOneBot?.expectedSelfId, peerId: body.qq, identityId: body.identityId }); }
    catch { throw new ConfigStoreError('UNAVAILABLE', '当前账号身份的任务不可用或不存在，未重复执行'); }
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要本机主人登录权限');
    if (runtime !== this.getRuntime() || runtime.backgroundTasks !== manager) throw new ConfigStoreError('CONFLICT', '运行实例已变化，请刷新后重试');
    return { ok: true, task, state: this.getState() };
  }

  async memoryOperation(method, body, { authorize = () => false, runtime = this.getRuntime(), memory = this.memory } = {}) {
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要本机主人登录权限');
    if (method === 'resumeDelete') {
      if (!body || Object.keys(body).some((key) => key !== 'confirmed') || body.confirmed !== true) throw new ConfigStoreError('INVALID_PATCH', '请先确认完成中断删除');
    } else if (method !== 'snapshot') {
      const allowed = method === 'correct' ? ['id', 'revision', 'summary', 'detail', 'sourceType', 'confirmed', 'reason'] : ['id', 'revision', 'reason'];
      if (!['correct', 'forget', 'restore', 'delete'].includes(method) || Object.keys(body).some((key) => !allowed.includes(key))
        || typeof body.id !== 'string' || !body.id || body.id.length > 100 || !/^[a-f0-9]{64}$/.test(body.revision || '')
        || body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)
        || method === 'correct' && (typeof body.summary !== 'string' || !body.summary.trim() || body.summary.length > 160
          || typeof body.detail !== 'string' || !body.detail.trim() || body.detail.length > 2000
          || !['user_explicit', 'inference'].includes(body.sourceType) || typeof body.confirmed !== 'boolean'
          || body.sourceType === 'inference' && body.confirmed)) throw new ConfigStoreError('INVALID_PATCH', '记忆操作参数无效');
    }
    if (runtime !== this.getRuntime() || memory !== this.memory) throw new ConfigStoreError('CONFLICT', '记忆运行实例已变化，请刷新后重试');
    if (typeof memory?.[method] !== 'function') throw new ConfigStoreError('UNAVAILABLE', '记忆管理尚未就绪，请启动伴侣后重试');
    if (method !== 'snapshot' && this.getState().runtime.busy) throw new ConfigStoreError('BUSY', '正在处理任务，请完成后再修改记忆');
    let result;
    try { result = await memory[method](body, { authorize }); }
    catch (error) {
      const messages = { CONFLICT: '记忆已被其他操作修改，请读取最新版本；草稿应保留后再核对',
        INVALID_MEMORY: '记忆数据无法安全读取，未改写原文件', DELETE_PENDING: '记忆删除未完成，已停止召回，请核对本地删除事务', INVALID_PATCH: '记忆操作参数无效',
        INVALID_QUERY: '记忆筛选参数无效', FORBIDDEN: '需要本机主人登录权限', BUSY: '正在处理任务，请完成后再修改记忆',
        MEMORY_IO_ERROR: '记忆操作未得到确认，请读取最新记忆核对；未返回私人文件内容',
        SAVE_UNCERTAIN: '记忆保存结果未确认，请读取最新记忆核对后再操作', NOT_UNDOABLE: '此条记忆没有可撤销的修改或停用',
        NOT_FOUND: '这条记忆已不存在，请刷新列表', UNAVAILABLE: '记忆管理尚未就绪，请启动伴侣后重试' };
      const code = Object.hasOwn(messages, error?.code) ? error.code : 'UNAVAILABLE';
      throw new ConfigStoreError(code, messages[code]);
    }
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '需要本机主人登录权限');
    if (runtime !== this.getRuntime() || memory !== this.memory) throw new ConfigStoreError('CONFLICT', '记忆运行实例已变化，请刷新后重试');
    return result;
  }

  async apply() {
    const state = this.getState();
    if (state.runtime.busy) throw new ConfigStoreError('BUSY', '正在回复 QQ 或应用配置，请稍后再试');
    if (state.config.validationErrors.length) throw new ConfigStoreError('INVALID_CONFIG', '请先修正配置错误',
      { validationErrors: state.config.validationErrors });
    if (!state.canApply) throw new ConfigStoreError('UNAVAILABLE', '当前宿主不支持局部重载，请重启 DSH');
    await this.applyRuntime();
    return this.getState();
  }
}

export function readablePaths(configFile, overrides = {}) {
  let local = {};
  try { local = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}
  const effective = { ...local, ...overrides };
  return Object.fromEntries(['memoryProjectRoot', 'companionConfigPath', 'memeDir'].map((key) =>
    [key, typeof effective[key] === 'string' ? effective[key] : ''] ).concat([['configFile', configFile]]));
}

export function registerConfigPanel(ctx, controller) {
  if (typeof ctx.inject !== 'function') return { registered: false };
  let registered = false;
  const fiber = ctx.inject(['webServer', 'connection'], (services) => {
    const connection = services.get('connection');
    const webServer = services.get('webServer');
    const disposers = [];
    let closed = false;
    const cleanup = () => {
      closed = true;
      registered = false;
      for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch {} }
    };
    services.effect(() => cleanup);
    try {
    const endpoints = { ...Object.fromEntries(Object.entries(SOCIAL_ACCOUNT_ROUTES).map(([key, value]) => [key, [value]])), state: ['GET'], life: ['GET'], 'life/action': ['POST'], 'tokens/status': ['GET'], 'tokens/config': ['POST'], 'tokens/bonus': ['POST'], 'tokens/acknowledge': ['POST'], config: ['POST'], apply: ['POST'], capabilities: ['GET'],
      'capabilities/check': ['POST'], 'capabilities/probe': ['POST'],
      'desktop-context/status': ['GET'], 'desktop-context/preview': ['POST'], 'desktop-context/recover': ['POST'],
      'conversations/stop': ['POST'], 'conversations/recover': ['POST'], 'tasks/cancel': ['POST'], 'tasks/test': ['POST'], 'tasks/acknowledge': ['POST'],
      memory: ['GET'], 'memory/correct': ['POST'], 'memory/forget': ['POST'], 'memory/restore': ['POST'], 'memory/delete': ['POST'], 'memory/resume-delete': ['POST'],
      'napcat/status': ['GET'], 'napcat/qrcode': ['POST'], memes: ['GET'], 'meme-image': ['GET'], persona: ['GET', 'POST'],
      'meme-detail': ['GET'], 'meme-metadata': ['POST'], 'memes/import': ['POST'],
      'model/status': ['GET'], 'model/config': ['POST'], 'model/probe': ['POST'], 'model/test': ['POST'], 'model/selection': ['POST'], 'model/rebind': ['POST'],
      'speech/prepare': ['POST'], 'speech/selection': ['POST'], 'speech/test': ['POST'],
      dependencies: ['GET'], 'dependencies/check': ['POST'], 'dependencies/action': ['POST'],
      'voice/status': ['GET'], 'voice/config': ['POST'], 'voice/check': ['POST'], 'voice/test': ['POST'], 'social/status': ['GET'], 'social/check': ['POST'], 'phone/check': ['POST'], 'phone/connect': ['POST'] };
    const service = (name) => {
      if (!controller[name]) throw new ConfigStoreError('UNAVAILABLE', '此功能暂未就绪，请刷新状态后重试');
      return controller[name];
    };
    for (const [endpoint, methods] of Object.entries(endpoints)) {
      const handler = (req, res) => {
        const run = async () => {
          const admitted = () => {
            if (closed) { json(res, 503, { ok: false, code: 'UNAVAILABLE', error: '设置面板已停止，请刷新 DSH' }); return false; }
            const rejection = ownerRequestRejection(connection, req);
            if (rejection) { json(res, rejection, { ok: false, code: 'FORBIDDEN', error: '需要本机主人登录权限' }); return false; }
            return true;
          };
          if (!admitted()) return;
          if (!methods.includes(req.method)) return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: '请求方式不支持' });
          if (endpoint.startsWith('desktop-context/')) {
            const runtime = controller.getRuntime(), manager = runtime?.desktopContext;
            const ownerSignal = connection.admit(req)?.peer?.signal;
            const requestController = new AbortController(), abort = () => requestController.abort();
            const responseClose = () => { if (!res.writableEnded) abort(); };
            req.once?.('aborted', abort); res.once?.('close', responseClose);
            ownerSignal?.addEventListener('abort', abort, { once: true });
            if (req.aborted || res.destroyed || ownerSignal?.aborted) abort();
            const authorize = () => !closed && !requestController.signal.aborted && ownerRequestRejection(connection, req) === null;
            try {
              if (new URL(req.url || PREFIX + endpoint, 'http://localhost').searchParams.size)
                throw new ConfigStoreError('INVALID_PATCH', '桌面会话容量接口不接受查询参数');
              const body = req.method === 'GET' ? {} : await readJson(req);
              if (!admitted()) return;
              if (controller.getRuntime() !== runtime || runtime?.desktopContext !== manager)
                throw new ConfigStoreError('CONFLICT', '桌面会话运行实例已变化，请刷新核对');
              const result = await controller.desktopContextOperation(endpoint.slice('desktop-context/'.length), body,
                { authorize, runtime, signal: requestController.signal });
              if (admitted() && authorize()) json(res, 200, result);
            } finally {
              req.removeListener?.('aborted', abort); res.removeListener?.('close', responseClose);
              ownerSignal?.removeEventListener('abort', abort);
            }
            return;
          }
          if (Object.hasOwn(SOCIAL_ACCOUNT_ROUTES, endpoint)) {
            const expected = controller.getRuntime(), manager = expected?.socialAccounts;
            const ownerSignal = connection.admit(req)?.peer?.signal;
            const requestController = new AbortController(), abort = () => requestController.abort();
            const onResponseClose = () => { if (!res.writableEnded) abort(); };
            req.once?.('aborted', abort); res.once?.('close', onResponseClose);
            ownerSignal?.addEventListener('abort', abort, { once: true });
            if (req.aborted || res.destroyed || ownerSignal?.aborted) abort();
            const authorize = () => !closed && !requestController.signal.aborted && ownerRequestRejection(connection, req) === null && ownerSignal?.aborted !== true
              && controller.getRuntime() === expected && expected?.socialAccounts === manager;
            try {
              const query = new URL(req.url || PREFIX + endpoint, 'http://localhost').searchParams;
              if (query.size) throw new ConfigStoreError('INVALID_PATCH', '平台账号接口不接受查询参数');
              const body = req.method === 'GET' ? {} : await readJson(req);
              if (!admitted()) return;
              const ownerBusinessAction = req.method === 'POST' && endpoint !== 'social/check-browser'
                && !(endpoint === 'social/browse' && body?.request?.action === 'history');
              if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '平台运行实例或授权已变化，请刷新核对');
              if (ownerBusinessAction) {
                await expected?.autonomy?.cancel?.();
                if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '平台运行实例或授权已变化，请刷新核对');
              }
              const result = await socialAccountRoute(endpoint, manager, body, { authorize, signal: requestController.signal });
              if (admitted() && authorize()) json(res, 200, result);
              else if (admitted()) throw new ConfigStoreError('CONFLICT', '平台账号运行实例已变化，请刷新核对');
            } finally {
              req.removeListener?.('aborted', abort); res.removeListener?.('close', onResponseClose);
              ownerSignal?.removeEventListener('abort', abort);
            }
            return;
          }
          if (endpoint === 'life/action') {
            const expected = controller.getRuntime(), manager = expected?.autonomy;
            const ownerSignal = connection.admit(req)?.peer?.signal;
            const requestController = new AbortController(), abort = () => requestController.abort();
            const onResponseClose = () => { if (!res.writableEnded) abort(); };
            req.once?.('aborted', abort); res.once?.('close', onResponseClose);
            ownerSignal?.addEventListener('abort', abort, { once: true });
            if (req.aborted || res.destroyed || ownerSignal?.aborted) abort();
            const authorize = () => !closed && !requestController.signal.aborted && ownerRequestRejection(connection, req) === null
              && controller.getRuntime() === expected && expected?.autonomy === manager;
            try {
              const body = await readJson(req);
              if (!admitted()) return;
              if (!body || Object.keys(body).some(key => !['action', 'input'].includes(key)) || typeof body.action !== 'string' || !body.input)
                throw new ConfigStoreError('INVALID_PATCH', '生活操作请求无效');
              const result = await lifeOperation(() => controller.getRuntime(), body.action, body.input,
                { authorize, runtime: expected, signal: requestController.signal });
              if (admitted() && authorize()) json(res, 200, { ok: true, life: result });
            } catch (error) { const safe = lifeError(error); throw new ConfigStoreError(safe.code, safe.message); }
            finally {
              req.removeListener?.('aborted', abort); res.removeListener?.('close', onResponseClose);
              ownerSignal?.removeEventListener('abort', abort);
            }
            return;
          }
          if (endpoint === 'state') return json(res, 200, controller.getState());
          if (endpoint === 'capabilities') return json(res, 200, { ok: true,
            capabilities: controller.capabilities?.snapshot() || { busy: false, checkedAt: null, items: [] } });
          const output = async (key, task, isCurrent = () => true) => {
            const value = await task;
            if (!admitted()) return;
            if (!isCurrent()) throw new ConfigStoreError('CONFLICT', '图库运行实例已变化，请刷新后重试');
            json(res, 200, { ok: true, [key]: value });
          };
          if (endpoint === 'tokens/status') {
            if (new URL(req.url || PREFIX + endpoint, 'http://localhost').searchParams.size) throw new ConfigStoreError('INVALID_PATCH', 'Token 状态不接受筛选参数');
            const currentRuntime = controller.getRuntime();
            try { return await output('tokens', tokenOperation(() => controller.getRuntime(), 'status', {},
              { runtime: currentRuntime, authorize: () => !closed && ownerRequestRejection(connection, req) === null }), () => controller.getRuntime() === currentRuntime); }
            catch (error) { const safe = tokenError(error); throw new ConfigStoreError(safe.code, safe.message); }
          }
          if (endpoint === 'life') {
            const params = new URL(req.url || PREFIX + endpoint, 'http://localhost').searchParams;
            if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) throw new ConfigStoreError('INVALID_PATCH', '重复的生活记录筛选');
            const query = Object.fromEntries(params);
            for (const key of ['offset', 'limit']) if (query[key] !== undefined) { if (!/^\d{1,4}$/.test(query[key])) throw new ConfigStoreError('INVALID_PATCH', '分页无效'); query[key] = Number(query[key]); }
            try { return await output('life', lifeOperation(() => controller.getRuntime(), 'snapshot', query, { authorize: () => !closed && ownerRequestRejection(connection, req) === null })); }
            catch (error) { const safe = lifeError(error); throw new ConfigStoreError(safe.code, safe.message); }
          }
          if (req.method === 'GET') {
            if (endpoint === 'memory') {
              const params = new URL(req.url || PREFIX + endpoint, 'http://localhost').searchParams;
              const allowed = ['query', 'kind', 'status', 'scope', 'accountId', 'identityId', 'offset', 'limit'];
              if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1)) {
                throw new ConfigStoreError('INVALID_QUERY', '记忆筛选参数不支持');
              }
              const body = Object.fromEntries(params);
              for (const name of ['offset', 'limit']) if (Object.hasOwn(body, name)) {
                if (!/^\d{1,6}$/.test(body[name])) throw new ConfigStoreError('INVALID_QUERY', '记忆分页参数无效');
                body[name] = Number(body[name]);
              }
              return output('memory', controller.memoryOperation('snapshot', body,
                { authorize: () => !closed && ownerRequestRejection(connection, req) === null }));
            }
            if (endpoint === 'model/status') return output('model', service('model').snapshot());
            if (endpoint === 'dependencies') return output('dependencies', service('dependencies').snapshot());
            if (endpoint === 'voice/status') return output('voice', service('voice').snapshot());
            if (endpoint === 'social/status') return output('social', service('social').snapshot());
            if (endpoint === 'napcat/status') return output('napcat', service('napcat').status());
            if (endpoint === 'persona') return output('persona', service('library').persona());
            const params = new URL(req.url || PREFIX + endpoint, 'http://localhost').searchParams;
            const allowed = endpoint === 'memes' ? ['query', 'offset', 'limit'] : ['id'];
            if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1)) {
              throw new ConfigStoreError('INVALID_PATCH', '请求参数不支持');
            }
            if (endpoint === 'memes') {
              const integer = (name, fallback) => {
                const value = params.get(name);
                if (value === null) return fallback;
                if (!/^\d{1,8}$/.test(value)) throw new ConfigStoreError('INVALID_PATCH', '分页参数无效');
                return Number(value);
              };
              return output('gallery', service('library').listMemes({ query: params.get('query') || '',
                offset: integer('offset', 0), limit: integer('limit', 24) }));
            }
            if (endpoint === 'meme-detail') {
              const runtime = controller.getRuntime?.(), manager = runtime?.memeManager;
              return output('meme', service('library').memeDetail(params.get('id'),
                { authorize: () => !closed && ownerRequestRejection(connection, req) === null }),
              () => controller.getRuntime?.() === runtime && runtime?.memeManager === manager);
            }
            const image = await service('library').memeImage(params.get('id'));
            if (!admitted()) return;
            res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length,
              'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
            res.end(image.bytes);
            return;
          }
          const memeWrite = endpoint === 'meme-metadata' || endpoint === 'memes/import';
          const conversationWrite = endpoint.startsWith('conversations/');
          const conversationRuntime = conversationWrite ? controller.getRuntime?.() : null;
          const taskRuntime = endpoint.startsWith('tasks/') ? controller.getRuntime?.() : null;
          const tokenRuntime = endpoint.startsWith('tokens/') ? controller.getRuntime?.() : null;
          const speechRuntime = endpoint === 'speech/test' ? controller.getRuntime?.() : null;
          const voiceRuntime = ['voice/check', 'voice/test'].includes(endpoint) ? controller.getRuntime?.() : null;
          const socialRuntime = endpoint === 'social/check' ? controller.getRuntime?.() : null;
          const capabilityRuntime = endpoint.startsWith('capabilities/') ? controller.getRuntime?.() : null;
          const capabilityRegistry = endpoint.startsWith('capabilities/') ? controller.capabilities : null;
          const memoryWrite = endpoint.startsWith('memory/');
          const memoryRuntime = memoryWrite ? controller.getRuntime?.() : null, memoryController = controller.memory;
          // Bind a slow upload to the instance that accepted it, rather than a newly applied library.
          const memeRuntime = memeWrite ? controller.getRuntime?.() : null;
          const memeManager = memeRuntime?.memeManager;
          const body = await readJson(req, endpoint === 'speech/test' ? MAX_SPEECH_TEST_BODY : endpoint === 'persona' ? 786432 : endpoint === 'memes/import' ? MAX_IMPORT_BODY
            : endpoint === 'config' ? MAX_CONFIG_BODY : MAX_BODY);
          if (!admitted()) return;
          const authorization = { authorize: () => !closed && ownerRequestRejection(connection, req) === null };
          if (endpoint.startsWith('tokens/')) {
            try { const result = tokenOperation(() => controller.getRuntime(), endpoint.slice('tokens/'.length), body,
              { ...authorization, runtime: tokenRuntime, busy: () => controller.getState().runtime.busy === true });
              if (admitted()) json(res, 200, { ok: true, tokens: result }); return;
            } catch (error) { const safe = tokenError(error); throw new ConfigStoreError(safe.code, safe.message); }
          }
          if (endpoint === 'social/check') {
            if (!socialRuntime || controller.getRuntime() !== socialRuntime) throw new ConfigStoreError('CONFLICT', '平台服务已更新，请刷新后重试');
            const ownerSignal = connection.admit(req)?.peer?.signal;
            const result = await service('social').check(body, { signal: ownerSignal,
              authorize: () => authorization.authorize() && ownerSignal?.aborted !== true && controller.getRuntime() === socialRuntime });
            if (admitted()) json(res, 200, { ok: true, ...result }); return;
          }
          if (endpoint === 'speech/test') {
            if (!speechRuntime || controller.getRuntime() !== speechRuntime) throw new ConfigStoreError('CONFLICT', '语音服务已更新，请刷新后重试');
            const test = await testSpeechAudio(body, { voiceProcessor: speechRuntime.voiceProcessor,
              busy: controller.getState().runtime.busy === true,
              authorize: () => authorization.authorize() && controller.getRuntime() === speechRuntime });
            if (admitted()) json(res, 200, { ok: true, test, speech: service('model').speechSnapshot() });
            return;
          }
          if (endpoint.startsWith('capabilities/')) {
            const result = await controller.capabilityOperation(endpoint.endsWith('/probe') ? 'probe' : 'check', body,
              { ...authorization, runtime: capabilityRuntime, capabilities: capabilityRegistry });
            if (admitted()) json(res, 200, result);
            return;
          }
          if (endpoint === 'tasks/cancel') {
            const result = await controller.cancelBackgroundTask(body, { ...authorization, runtime: taskRuntime });
            if (admitted()) json(res, 200, result);
            return;
          }
          if (endpoint === 'tasks/test') {
            const result = await controller.testBackgroundTask(body, { ...authorization, runtime: taskRuntime });
            if (admitted()) json(res, 200, result);
            return;
          }
          if (endpoint === 'tasks/acknowledge') {
            const result = await controller.acknowledgeBackgroundTask(body, { ...authorization, runtime: taskRuntime });
            if (admitted()) json(res, 200, result);
            return;
          }
          if (memoryWrite) return output('memory', controller.memoryOperation(endpoint === 'memory/resume-delete' ? 'resumeDelete' : endpoint.slice('memory/'.length), body,
            { ...authorization, runtime: memoryRuntime, memory: memoryController }));
          if (conversationWrite) {
            const result = await controller.controlConversation(endpoint.endsWith('/stop') ? 'stop' : 'recover', body,
              { ...authorization, runtime: conversationRuntime });
            if (admitted()) json(res, 200, result);
            return;
          }
          if (memeWrite) {
            if (controller.getRuntime?.() !== memeRuntime || memeRuntime?.memeManager !== memeManager) {
              throw new ConfigStoreError('CONFLICT', '图库运行实例已变化，请刷新后重试');
            }
            const getBusy = () => controller.getState().runtime.busy;
            if (getBusy()) throw new ConfigStoreError('BUSY', '正在处理任务，请稍后修改图库');
            return output('meme', service('library')[endpoint === 'memes/import' ? 'importMeme' : 'saveMemeMetadata'](body,
              { ...authorization, getBusy }),
            () => controller.getRuntime?.() === memeRuntime && memeRuntime?.memeManager === memeManager);
          }
          if (endpoint === 'model/config') return output('model', service('model').save(body, authorization));
          if (endpoint === 'model/selection') return output('model', service('model').saveSelection(body, authorization));
          if (endpoint === 'speech/selection') return output('model', service('model').saveSpeechSelection(body, authorization));
          if (endpoint === 'model/rebind') {
            if (Object.keys(body).length) throw new ConfigStoreError('INVALID_PATCH', '重建会话不接受额外参数');
            const state = await controller.apply();
            if (admitted()) json(res, 200, state);
            return;
          }
          if (endpoint === 'model/probe') {
            const result = await service('model').probe(body, authorization);
            if (admitted()) json(res, 200, result);
            return;
          }
          if (endpoint === 'model/test') {
            const result = await service('model').testConnection(body, authorization);
            if (admitted()) json(res, 200, result);
            return;
          }
          if (endpoint === 'speech/prepare') return output('model', service('model').prepareSpeech(body, authorization));
          if (endpoint === 'dependencies/check') {
            if (Object.keys(body).some((key) => key !== 'updates') || body.updates !== undefined && typeof body.updates !== 'boolean') {
              throw new ConfigStoreError('INVALID_PATCH', '组件检测参数无效');
            }
            return output('dependencies', service('dependencies').check({ updates: body.updates === true }));
          }
          if (endpoint === 'dependencies/action') {
            const result = await service('dependencies').action(body, authorization);
            if (admitted()) json(res, 200, { ok: true, result, dependencies: service('dependencies').snapshot() });
            return;
          }
          if (endpoint === 'voice/config') return output('voice', service('voice').save(body));
          if (endpoint === 'voice/test') {
            if (!voiceRuntime || controller.getRuntime() !== voiceRuntime) throw new ConfigStoreError('CONFLICT', '声音服务已更新，请刷新后重试');
            const test = await service('voice').test(body, { authorize: () => authorization.authorize() && controller.getRuntime() === voiceRuntime });
            if (admitted()) json(res, 200, { ok: true, test, voice: service('voice').snapshot() });
            return;
          }
          if (['voice/check', 'phone/check', 'phone/connect'].includes(endpoint)) {
            if (Object.keys(body).length) throw new ConfigStoreError('INVALID_PATCH', '检测不接受额外参数');
            if (endpoint.startsWith('phone/')) {
              if (controller.getState().runtime.busy) throw new ConfigStoreError('BUSY', '正在处理任务或检测手机，请稍后再试');
              await service('diagnostics')[endpoint === 'phone/connect' ? 'connectPhone' : 'checkPhone'](authorization);
              if (admitted()) json(res, 200, { ok: true, state: controller.getState() });
            } else {
              const test = await service('voice').test(authorization);
              if (admitted()) json(res, 200, { ok: true, test, voice: service('voice').snapshot() });
            }
            return;
          }
          if (endpoint === 'config') return json(res, 200, controller.save(body));
          if (endpoint === 'napcat/qrcode') {
            if (Object.keys(body).some((key) => key !== 'refresh') || (body.refresh !== undefined && typeof body.refresh !== 'boolean')) {
              throw new ConfigStoreError('INVALID_PATCH', '二维码请求参数无效');
            }
            return output('qrcode', service('napcat').qrcode({ refresh: body.refresh === true },
              { authorize: () => !closed && ownerRequestRejection(connection, req) === null }));
          }
          if (endpoint === 'persona') {
            if (controller.getState().runtime.busy) {
              throw new ConfigStoreError('BUSY', '正在回复 QQ 或应用配置，请稍后保存人设');
            }
            return output('persona', service('library').savePersona(body));
          }
          if (Object.keys(body).length) throw new ConfigStoreError('INVALID_PATCH', '应用配置不接受额外参数');
          const applied = await controller.apply();
          if (admitted()) return json(res, 200, applied);
        };
        void run().catch((error) => {
          const socialError = error instanceof SocialAccountError;
          const known = socialError || error instanceof ConfigStoreError || error instanceof NapCatPanelError || error instanceof PanelLibraryError
            || error instanceof ModelPanelError || error instanceof DependencyPanelError;
          const code = known ? error.code : 'INTERNAL_ERROR';
          const status = code === 'COOLDOWN' ? 429 : ['RISK_CONTROL', 'CONFLICT', 'BUSY', 'CHECK_REQUIRED', 'UNCERTAIN_ACK_REQUIRED', 'CONTEXT_RECOVERY_REQUIRED', 'CONTEXT_CAPACITY_REQUIRED', 'RESULT_UNKNOWN', 'NO_REPLAY', 'LOGIN_PENDING', 'STORAGE_BUSY', 'CLEANUP_UNCONFIRMED', 'ACCOUNT_REQUIRED', 'LOGIN_REQUIRED'].includes(code) ? 409 : code === 'FORBIDDEN' ? 403
            : ['UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'INSTALLER_UNAVAILABLE', 'DRIVER_UNAVAILABLE', 'OPERATION_UNAVAILABLE', 'BINDINGS_REQUIRED', 'SDK_VERSION_MISMATCH'].includes(code) ? 503 : code === 'UNSUPPORTED' ? 400
            : code.startsWith('INVALID_') ? 400 : code === 'NOT_FOUND' ? 404 : 500;
          json(res, status, { ok: false, code, error: socialError ? SOCIAL_ACCOUNT_ERRORS[code] || '平台操作未得到确认，请核对状态；不会自动重发。' : known ? error.message : '配置操作未完成，请刷新状态后重试',
            ...(known && Array.isArray(error.validationErrors) ? { validationErrors: error.validationErrors } : {}) });
        });
      };
      disposers.push(webServer.register({ kind: 'exact', path: PREFIX + endpoint, handler }));
    }
    registered = true;
    } catch (error) { cleanup(); throw error; }
  });
  return { get registered() { return registered; }, dispose: () => fiber?.dispose?.() };
}
