import fs from 'node:fs';
import { activeQQIdentity, normalizeQQAccounts, validateQQAccounts } from './account-identities.js';

/**
 * qq-gateway.js — QQ 双通道统一路由网关
 * ─────────────────────────────────────────────────────────────
 * 作用：
 * 1. 统一接入 OneBot v11 协议（NapCat 小号）与 QQ 官方开放平台机器人
 * 2. 统一身份鉴权：仅匹配配置中指定通道的精确 QQ / OpenID
 * 3. 消息归一化：将双通道消息转换为统一的事件流，交由大肥鱼大脑统一应答
 */

function messageText(message) {
  if (!Array.isArray(message)) return String(message || '');
  return message.map((part) => part?.type === 'text' ? String(part.data?.text || '')
    : part?.type === 'at' ? '@' + String(part.data?.qq || '')
    : part?.type === 'image' ? '[图片]' : part?.type === 'record' ? '[语音]' : '').join('').trim();
}
const qqId = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ? String(value) : typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : '';
const isReadOnlyAction = (action) => /^get_/.test(action);
const oneBotId = (value) => {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric !== 0 ? numeric : value;
};
const ACCOUNT_OFFLINE_ERROR = 'QQ 网关报告账号离线，请核对登录状态';
const CLOSE_REASONS = Object.freeze({
  1000: 'normal-closure', 1001: 'going-away', 1002: 'protocol-error', 1003: 'unsupported-data',
  1005: 'no-status', 1006: 'abnormal-closure', 1007: 'invalid-payload', 1008: 'policy-violation',
  1009: 'message-too-big', 1010: 'missing-extension', 1011: 'server-error',
  1012: 'service-restart', 1013: 'retry-later', 1014: 'bad-gateway', 1015: 'tls-failure',
});
function disconnectDiagnostic(eventOrCode) {
  // Node ws passes (code, reason); browser WebSocket passes CloseEvent. Never
  // inspect the remote reason, which may contain arbitrary messages or secrets.
  let value;
  try { value = typeof eventOrCode === 'number' ? eventOrCode : eventOrCode?.code; } catch {}
  const closeCode = Number.isInteger(value) && value >= 1000 && value <= 4999 ? value : null;
  return Object.freeze({ at: new Date().toISOString(), closeCode,
    reason: closeCode === null ? 'unknown-closure' : CLOSE_REASONS[closeCode] || 'other-closure' });
}

export class QQGateway {
  /**
   * @param {object} opts
   * @param {string} opts.ownerOpenId 主人开放平台 OpenID
   * @param {string} opts.ownerQq 主人 QQ 号
   * @param {string} [opts.onebotWs] OneBot WebSocket 地址
   * @param {string} [opts.onebotHttp] OneBot HTTP 地址
   * @param {Function} [opts.onMessage] 统一消息回调
   * @param {Function} [opts.onConnect] 连通就绪回调
   */
  constructor({
    ownerOpenId = '',
    ownerQq = '',
    qqAccounts,
    onebotWs = 'ws://127.0.0.1:3001',
    onebotHttp = 'http://127.0.0.1:3000',
    appId = process.env.QQ_BOT_APP_ID || '',
    appSecret = process.env.QQ_BOT_APP_SECRET || '',
    accessToken = '',
    expectedSelfId = '',
    WebSocketImpl,
    onMessage,
    onConnect,
  } = {}) {
    this.ownerOpenId = String(ownerOpenId || '');
    this.ownerQq = String(ownerQq || '');
    const accountsConfig = { ownerQq: this.ownerQq, qqAccounts, onebotSelfId: expectedSelfId };
    if (validateQQAccounts(accountsConfig).length) throw new Error('QQ 账号与身份配置无效');
    this.accountsConfig = { ...accountsConfig, qqAccounts: normalizeQQAccounts(accountsConfig) };
    this.onebotWs = onebotWs;
    this.onebotHttp = onebotHttp.replace(/\/+$/, '');
    this.appId = String(appId || '');
    this.appSecret = String(appSecret || '');
    this.accessToken = accessToken;
    if (expectedSelfId !== '' && !qqId(expectedSelfId)) throw new Error('expectedSelfId 必须是明确的小号 QQ 号');
    this.expectedSelfId = expectedSelfId === '' ? '' : qqId(expectedSelfId);
    if (this.expectedSelfId && this.expectedSelfId === this.ownerQq) throw new Error('主人 QQ 不能填为接入小号自己的 QQ');
    this.selfId = this.expectedSelfId;
    this.identitySource = this.selfId ? 'configured' : '';
    this.identityConflict = false;
    this.loginVerified = false;
    this.online = null;
    this.lastError = '';
    this.lastDisconnect = null;
    this.lastAccountOffline = null;
    this.WebSocketImpl = WebSocketImpl;
    this.officialToken = '';
    this.tokenExpiresAt = 0;
    this.onMessage = onMessage;
    this.onConnect = onConnect;
    this.wsClient = null;
    this.connected = false;
    this.connectedAtMs = 0;
    this.stopped = false;
    this.pendingReqs = new Map();
    this.onebotRequestSequence = 0;
    this.httpControllers = new Set();
    this.reconnectTimer = null;
    this.connecting = false;
  }

  /** 获取官方 QQ 机器人 Access Token (自带过期自动刷新) */
  async getOfficialToken() {
    if (this.stopped) return '';
    if (this.officialToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.officialToken;
    }
    if (!this.appId || !this.appSecret) return '';
    try {
      const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        signal: AbortSignal.timeout(6000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.access_token) {
        this.officialToken = data.access_token;
        const expiresIn = Number(data.expires_in) || 7200;
        this.tokenExpiresAt = Date.now() + expiresIn * 1000;
        return this.officialToken;
      }
    } catch (e) {
      console.warn('[qq-gateway] 官方 AccessToken 获取失败:', e?.message || e);
    }
    return '';
  }

  /** 发送官方 QQBot 私聊消息 (C2C) */
  async sendOfficialDirectMsg(openid, text, msgId) {
    const targetOpenid = String(openid || '');
    if (this.stopped || !targetOpenid) return { ok: false, error: '官方通道已停止或缺少接收方' };
    const token = await this.getOfficialToken();
    if (!token || this.stopped) return { ok: false, error: '官方通道不可用' };
    try {
      const payload = {
        content: text,
        msg_type: 0,
      };
      if (msgId) payload.msg_id = msgId;

      const res = await fetch(`https://api.sgroup.qq.com/v2/users/${encodeURIComponent(targetOpenid)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        return { ok: true, data };
      }
      return { ok: false, ...(res.status >= 500 ? { uncertain: true } : {}), error: data?.message || `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, uncertain: true, error: e?.message || String(e) };
    }
  }

  /** 发送官方 QQBot 群聊消息 */
  async sendOfficialGroupMsg(groupOpenid, text, msgId) {
    if (this.stopped || !groupOpenid) return { ok: false, error: '官方通道已停止或缺少接收方' };
    const token = await this.getOfficialToken();
    if (!token || this.stopped) return { ok: false, error: '官方通道不可用' };
    try {
      const payload = {
        content: text,
        msg_type: 0,
      };
      if (msgId) payload.msg_id = msgId;

      const res = await fetch(`https://api.sgroup.qq.com/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        return { ok: true, data };
      }
      return { ok: false, ...(res.status >= 500 ? { uncertain: true } : {}), error: data?.message || `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, uncertain: true, error: e?.message || String(e) };
    }
  }

  /** 停止监听与重连 */
  stop() {
    this.stopped = true;
    this.connected = false;
    this.connectedAtMs = 0;
    this.loginVerified = false;
    this.online = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const finish of this.pendingReqs.values()) {
      finish({ ok: false, uncertain: true, error: 'QQ 网关已停止，发送结果未确认' });
    }
    this.pendingReqs.clear();
    for (const controller of this.httpControllers) controller.abort();
    this.httpControllers.clear();
    const socket = this.wsClient;
    this.wsClient = null;
    try { socket?.close?.(); } catch {}
  }

  /** 发送结果不明时禁止重复执行消息发送等有副作用的动作。 */
  async api(action, params = {}, { signal } = {}) {
    if (this.stopped) return { ok: false, error: 'QQ 网关已停止' };
    const cancelled = () => ({ ok: false, ...(!isReadOnlyAction(action) ? { uncertain: true } : {}), error: 'OneBot 请求已取消' });
    if (signal?.aborted) return cancelled();
    if (this.identityConflict && !isReadOnlyAction(action)) return { ok: false, error: 'OneBot 小号身份冲突，已阻止发送' };
    if (this.wsClient && this.connected && this.wsClient.readyState === 1) {
      const echo = 'echo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          this.pendingReqs.delete(echo);
          resolve(result);
        };
        const abort = () => finish(cancelled());
        finish.action = action;
        finish.requestSequence = ++this.onebotRequestSequence;
        const timer = setTimeout(() => {
          // A first recording lookup may download and decode QQ's SILK audio.
          // Wait for that one request rather than abandoning it at the chat
          // send deadline or replaying the conversion through HTTP.
          if (action === 'get_record') {
            finish({ ok: false, error: 'QQ 语音下载或转换超时，未自动重试' });
          } else if (isReadOnlyAction(action) && !this.stopped) {
            this.pendingReqs.delete(echo);
            this.#httpApi(action, params, { signal }).then(finish);
          } else {
            finish({ ok: false, uncertain: true, error: 'OneBot 响应超时，操作可能已执行，请先核实结果' });
          }
        }, action === 'get_record' ? 30000 : 3000);
        this.pendingReqs.set(echo, finish);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        try { this.wsClient.send(JSON.stringify({ action, params, echo })); }
        catch (error) {
          finish({ ok: false, uncertain: true, error: 'OneBot 发送未确认：' + (error?.message || error) });
        }
      });
    }
    return this.#httpApi(action, params, { signal });
  }

  async #httpApi(action, params = {}, { signal } = {}) {
    if (!this.onebotHttp) return { ok: false, error: '未配置 onebotHttp' };
    const controller = new AbortController();
    this.httpControllers.add(controller);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), action === 'get_record' ? 30000 : 5000);
    timer.unref?.();
    try {
      const res = await fetch(`${this.onebotHttp}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.accessToken ? { Authorization: 'Bearer ' + this.accessToken } : {}) },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => null);
      if (res.ok) return this.#oneBotResult(json, action);
      return { ok: false, ...(!isReadOnlyAction(action) && res.status >= 500 ? { uncertain: true } : {}),
        error: json?.message || `OneBot 返回 HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, ...(!/^get_/.test(action) ? { uncertain: true } : {}), error: e?.message || String(e) };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.httpControllers.delete(controller); }
  }

  #bindSelfId(value, source) {
    const id = qqId(value);
    if (!id) return false;
    if (id === this.ownerQq || (this.selfId && id !== this.selfId)) {
      this.identityConflict = true;
      this.loginVerified = false;
      this.lastError = 'OneBot 返回的小号身份与已绑定身份不一致，或主人 QQ 填成了小号';
      return false;
    }
    this.selfId = id;
    this.identitySource = source;
    this.identityConflict = false;
    return true;
  }

  #oneBotResult(json, action) {
    if (this.stopped) return { ok: false, ...(!isReadOnlyAction(action) ? { uncertain: true } : {}), error: 'QQ 网关已停止' };
    const object = json && typeof json === 'object' && !Array.isArray(json);
    const hasCode = object && Object.hasOwn(json, 'retcode');
    const validCode = hasCode && (typeof json.retcode === 'number' && Number.isInteger(json.retcode)
      || typeof json.retcode === 'string' && /^-?\d+$/.test(json.retcode));
    const completed = object && (json.status === 'ok' || json.status === undefined && validCode)
      && (!hasCode || validCode && Number(json.retcode) === 0);
    const rejected = object && (json.status === 'failed' || validCode && Number(json.retcode) !== 0 && json.status !== 'async');
    if (!completed) return { ok: false, ...(!isReadOnlyAction(action) && !rejected ? { uncertain: true } : {}),
      error: json?.message || json?.wording || 'OneBot 尚未提供有效的完成回执' };
    const data = Object.hasOwn(json, 'data') ? json.data : json;
    if (action === 'get_login_info') {
      if (!this.#bindSelfId(data?.user_id, 'get_login_info')) {
        this.loginVerified = false;
        return { ok: false, error: this.lastError || 'OneBot 登录查询缺少有效小号身份' };
      }
      this.loginVerified = true;
    }
    if (action === 'get_status' && typeof data?.online === 'boolean') this.online = data.online;
    if (action === 'send_private_msg' || action === 'send_group_msg') {
      const id = data?.message_id;
      if (!(typeof id === 'number' && Number.isFinite(id) || typeof id === 'string' && id.trim())) {
        return { ok: false, uncertain: true, error: 'OneBot 发送回执缺少 message_id，发送结果未确认' };
      }
    }
    return { ok: true, data };
  }

  /** 发送私聊消息 */
  async getRecordAudio(record, { signal, selfId, maxBytes = 20 * 1024 * 1024 } = {}) {
    const verify = () => {
      signal?.throwIfAborted();
      if (this.stopped || !this.connected || this.online !== true || this.loginVerified !== true || this.identityConflict
        || !selfId || String(selfId) !== String(this.selfId)) throw new Error('QQ 语音所属的连接已变化');
    };
    verify();
    // Only an admitted incoming segment supplies this reference. Prefer the
    // OneBot file identifier over its expiring media URL.
    const file = record?.file || record?.file_id;
    if (typeof file !== 'string' || !file.trim() || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file)) throw new Error('QQ 语音文件标识无效');
    const result = await this.api('get_record', { file, out_format: 'wav' }, { signal });
    verify();
    if (!result.ok) throw new Error('QQ 语音下载或转换失败');
    const base64 = result.data?.base64;
    if (typeof base64 !== 'string' || base64.length % 4 || base64.length > 4 * Math.ceil(maxBytes / 3)
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('QQ 语音转换没有返回有界音频');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 44 || bytes.length > maxBytes || bytes.toString('base64') !== base64
      || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('QQ 语音转换返回的 WAV 无效');
    return bytes;
  }

  /** 发送私聊消息 */
  async sendPrivateMsg(userId, message) {
    const uid = oneBotId(userId);
    return this.api('send_private_msg', { user_id: uid, message });
  }

  /** 发送群聊消息 */
  async sendGroupMsg(groupId, message) {
    const gid = oneBotId(groupId);
    return this.api('send_group_msg', { group_id: gid, message });
  }

  /** OneBot image segments carry bytes so the bridge need not share our filesystem. */
  async sendImage(key, localPath) {
    if (this.stopped) return { ok: false, error: 'QQ 网关已停止' };
    if (!/^private:[^:]+$/.test(String(key || ''))) return { ok: false, error: '独立图库发送只支持明确的 OneBot 私聊' };
    try {
      const stat = fs.statSync(localPath);
      if (!stat.isFile() || stat.size < 1 || stat.size > 8 * 1024 * 1024) throw new Error('图片为空或超过 8 MiB');
      const message = [{ type: 'image', data: { file: 'base64://' + fs.readFileSync(localPath).toString('base64') } }];
      return this.sendPrivateMsg(key.slice('private:'.length), message);
    } catch (error) { return { ok: false, error: error.message }; }
  }

  /** 统一发送（双通道智能容灾：OneBot 优先，官方 Bot 兜底） */
  async sendRecord(key, bytes, { selfId } = {}) {
    if (this.stopped || !this.connected || this.online !== true || this.loginVerified !== true || this.identityConflict
      || !selfId || String(selfId) !== String(this.selfId)) return { ok: false, error: '语音发送的小号连接与登录身份未确认' };
    if (!/^private:[1-9]\d{0,19}$/.test(String(key || '')) || !Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > 5 * 1024 * 1024) {
      return { ok: false, error: '语音目标或音频内容无效' };
    }
    return this.sendPrivateMsg(key.slice('private:'.length), [{ type: 'record', data: { file: 'base64://' + bytes.toString('base64') } }]);
  }

  /** 统一发送（双通道智能容灾：OneBot 优先，官方 Bot 兜底） */
  async sendMessage(key, text, { messageId, selfId } = {}) {
    if (this.stopped) return { ok: false, error: 'QQ 网关已停止' };
    if (typeof key !== 'string' || !key) return { ok: false, error: '未指定消息接收方' };
    if ((key.startsWith('private:') || key.startsWith('group:')) && selfId !== undefined
      && (!this.selfId || this.identityConflict || String(selfId) !== this.selfId)) return { ok: false, error: 'OneBot 出站小号身份不匹配，未发送' };
    if (key.startsWith('official:group:')) {
      const id = key.slice('official:group:'.length);
      return id ? this.sendOfficialGroupMsg(id, text, messageId) : { ok: false, error: '缺少官方群接收方' };
    }
    if (key.startsWith('official:c2c:') || key.startsWith('official:')) {
      const id = key.replace(/^official:(?:c2c:)?/, '');
      return id ? this.sendOfficialDirectMsg(id, text, messageId) : { ok: false, error: '缺少官方私聊接收方' };
    }
    if (key.startsWith('group:')) return this.sendGroupMsg(key.slice('group:'.length), text);
    if (key.startsWith('private:')) return this.sendPrivateMsg(key.slice('private:'.length), text);
    return { ok: false, error: '不支持的消息接收方格式' };
  }

  /**
   * 拉取与指定好友的历史消息（用于开机未读补回）
   * @param {string|number} userId
   * @param {number} [count=10]
   */
  async fetchFriendHistory(userId, count = 10, { beforeSeq } = {}) {
    const uid = oneBotId(userId);
    if (!Number.isInteger(count) || count < 1 || count > 640) return { ok: false, error: '历史条数必须为 1 到 640 的整数', messages: [] };
    if (beforeSeq !== undefined && !/^\d+$/.test(String(beforeSeq))) return { ok: false, error: '历史游标必须来自接口的数字 message_seq', messages: [] };
    // 优先调用 NapCat/OneBot 扩展接口 get_friend_msg_history
    const res = await this.api('get_friend_msg_history', { user_id: uid, count,
      ...(beforeSeq !== undefined ? { message_seq: beforeSeq } : {}) });
    if (!res.ok) return { ok: false, error: res.error || '历史消息查询失败', messages: [] };
    let list = [];
    if (res.ok && Array.isArray(res.data?.messages)) {
      list = res.data.messages;
    } else if (res.ok && Array.isArray(res.data)) {
      list = res.data;
    }

    const messages = list.map((m) => {
      let text = '';
      if (typeof m.message === 'string') {
        text = m.message;
      } else if (Array.isArray(m.message)) {
        text = m.message.map((s) => s.data?.text || '').join('').trim();
      } else if (m.raw_message) {
        text = m.raw_message;
      }
      return {
        messageId: String(m.message_id || ''),
        userId: String(m.user_id || m.sender?.user_id || ''),
        userName: String(m.sender?.nickname || m.sender?.card || ''),
        text,
        time: Number(m.time) > 0 ? (Number(m.time) < 1e12 ? Number(m.time) * 1000 : Number(m.time)) : 0,
        isSelf: String(m.user_id || m.sender?.user_id || '') !== String(uid),
      };
    });

    const envelope = res.data && !Array.isArray(res.data) ? res.data : {};
    const rawCursor = envelope.next_message_seq ?? envelope.nextMessageSeq
      ?? list.map((msg) => msg.message_seq).filter((seq) => /^\d+$/.test(String(seq))).sort((a, b) => Number(a) - Number(b))[0];
    return { ok: true, messages, coverage: {
      complete: envelope.has_more === false || envelope.hasMore === false || envelope.complete === true,
      ...(rawCursor !== undefined && /^\d+$/.test(String(rawCursor)) ? { nextCursor: rawCursor } : {}),
    } };
  }

  /**
   * 启动 OneBot WebSocket 监听
   */
  async startOneBot() {
    if (this.stopped || this.connecting || this.wsClient || !this.onebotWs) return;
    this.connecting = true;
    try {
      const { WebSocket: NodeWebSocket } = this.WebSocketImpl ? {} : await import('ws').catch(() => ({}));
      if (this.stopped) return;
      const WebSocket = this.WebSocketImpl || NodeWebSocket || globalThis.WebSocket;
      if (!WebSocket) throw new Error('未安装 ws，且当前 Node 不支持 WebSocket');
      const nodeStyle = typeof WebSocket.prototype?.on === 'function';
      if (!nodeStyle && this.accessToken) throw new Error('带令牌的 OneBot WebSocket 需要安装 ws');
      const ws = nodeStyle
        ? new WebSocket(this.onebotWs, { headers: this.accessToken ? { Authorization: 'Bearer ' + this.accessToken } : {} })
        : new WebSocket(this.onebotWs);
      this.wsClient = ws;
      // Only a successful login-info response on this exact socket proves its
      // account. Configuration, lifecycle events and HTTP reads do not.
      let verifiedSocketSelfId = '';
      let accountOfflineReported = false;
      let offlineRequestFloor = 0;
      let recoveryLoginSequence = 0;
      const onOpen = () => {
        if (this.stopped || this.wsClient !== ws) { ws.close(); return; }
        this.connected = true;
        this.connectedAtMs = Date.now();
        this.lastError = '';
        console.log('[qq-gateway] OneBot 通道已连接');
        Promise.resolve().then(() => this.onConnect?.()).catch((error) => console.warn('[qq-gateway] 就绪回调失败:', error?.message || error));
      };
      const onMsg = (eventOrData) => {
        if (this.stopped || this.wsClient !== ws) return;
        try {
          const rawData = eventOrData?.data !== undefined ? eventOrData.data : eventOrData;
          const payload = JSON.parse(String(rawData));
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
          if (this.pendingReqs.has(payload.echo)) {
            const finish = this.pendingReqs.get(payload.echo);
            const result = this.#oneBotResult(payload, finish.action);
            if (finish.action === 'get_login_info') {
              verifiedSocketSelfId = result.ok && this.loginVerified && this.selfId === this.expectedSelfId
                ? this.selfId : '';
              recoveryLoginSequence = accountOfflineReported && verifiedSocketSelfId
                && finish.requestSequence > offlineRequestFloor ? finish.requestSequence : 0;
            } else if (finish.action === 'get_status' && result.ok && result.data?.online === true
              && accountOfflineReported && recoveryLoginSequence > 0 && finish.requestSequence > recoveryLoginSequence
              && verifiedSocketSelfId === this.expectedSelfId && this.loginVerified && !this.identityConflict) {
              // A new episode needs fresh, ordered reads. Late responses to
              // pre-offline or pre-verification requests cannot acknowledge it.
              accountOfflineReported = false;
              recoveryLoginSequence = 0;
              if (this.lastError === ACCOUNT_OFFLINE_ERROR) this.lastError = '';
            }
            finish(result);
            return;
          }
          if (payload.post_type === 'meta_event' && (payload.meta_event_type === 'heartbeat'
            || payload.meta_event_type === 'lifecycle' && ['connect', 'enable', 'disable'].includes(payload.sub_type))) {
            if (this.#bindSelfId(payload.self_id, payload.meta_event_type)) {
              if (typeof payload.status?.online === 'boolean') this.online = payload.status.online;
              if (payload.sub_type === 'disable') { this.online = false; this.loginVerified = false; }
            } else { verifiedSocketSelfId = ''; recoveryLoginSequence = 0; }
            return;
          }
          if (payload.post_type === 'notice' && payload.notice_type === 'bot_offline') {
            if (!this.connected || ws.readyState !== 1 || !this.expectedSelfId || this.identityConflict
              || this.selfId !== this.expectedSelfId
              || verifiedSocketSelfId !== this.expectedSelfId || qqId(payload.self_id) !== this.expectedSelfId) return;
            this.online = false;
            this.loginVerified = false;
            offlineRequestFloor = this.onebotRequestSequence;
            recoveryLoginSequence = 0;
            // NapCat forwards remote tips in tag/message, not typed cause codes.
            // Proven socket identity survives ordinary disable for diagnostics
            // only. Ignore remote text and record the first event in this episode.
            if (!accountOfflineReported) {
              accountOfflineReported = true;
              this.lastAccountOffline = Object.freeze({ at: new Date().toISOString(), source: 'onebot',
                event: 'bot_offline', reason: 'account-offline' });
              this.lastError = ACCOUNT_OFFLINE_ERROR;
              console.warn('[qq-gateway] ' + ACCOUNT_OFFLINE_ERROR, this.lastAccountOffline);
            }
            return;
          }
          if (payload.post_type === 'message') this.#handleOneBotMessage(payload);
        } catch (error) { console.warn('[qq-gateway] 无效入站消息:', error?.message || error); }
      };
      const onClose = (eventOrCode) => {
        if (this.stopped || this.wsClient !== ws) return;
        this.lastDisconnect = disconnectDiagnostic(eventOrCode);
        this.lastError = 'OneBot 传输连接已断开，QQ 登录状态需另行核实';
        console.warn('[qq-gateway] OneBot 传输连接已断开，QQ 登录状态需另行核实', this.lastDisconnect);
        this.wsClient = null;
        this.connected = false;
        this.connectedAtMs = 0;
        this.loginVerified = false;
        this.online = false;
        for (const finish of [...this.pendingReqs.values()]) finish({ ok: false, uncertain: true, error: 'OneBot 连接断开，操作结果未确认' });
        if (!this.stopped) {
          this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.startOneBot(); }, 5000);
          this.reconnectTimer.unref?.();
        }
      };
      const onError = () => {
        if (!this.stopped && this.wsClient === ws) this.lastError = 'OneBot 传输连接发生错误，QQ 登录状态需另行核实';
      };
      if (typeof ws.on === 'function') {
        ws.on('open', onOpen);ws.on('message', onMsg);ws.on('close', onClose);ws.on('error', onError);
      } else {
        ws.addEventListener('open', onOpen);ws.addEventListener('message', onMsg);ws.addEventListener('close', onClose);ws.addEventListener('error', onError);
      }
    } catch {
      this.lastError = 'OneBot 传输连接启动失败，请核对本机服务与连接配置';
      console.warn('[qq-gateway]', this.lastError);
    }
    finally { this.connecting = false; }
  }

  #handleOneBotMessage(raw) {
    if (!['private', 'group'].includes(raw.message_type) || !this.selfId || this.identityConflict
      || qqId(raw.self_id) !== this.selfId) return;
    const userId = qqId(raw.user_id);
    if (!userId || userId === this.selfId || raw.message_type === 'group' && !qqId(raw.group_id)) return;
    if (raw.message_type === 'private' && !activeQQIdentity(this.accountsConfig, userId)) return;
    const senderName = raw.sender?.nickname || raw.sender?.card || userId;
    const isOwner = Boolean(this.ownerQq) && userId === this.ownerQq;
    const text = messageText(raw.message || raw.raw_message);

    const norm = {
      channel: 'onebot',
      selfId: this.selfId,
      messageType: raw.message_type,
      messageId: String(raw.message_id || ''),
      time: (Number(raw.time) || Math.floor(Date.now() / 1000)) * 1000,
      atMention: Array.isArray(raw.message) && raw.message.some((part) => part?.type === 'at' && String(part.data?.qq) === String(raw.self_id)),
      isGroup: raw.message_type === 'group',
      groupId: raw.group_id ? String(raw.group_id) : null,
      userId,
      userName: senderName,
      isOwner,
      text,
      raw,
    };

    Promise.resolve().then(() => this.onMessage?.(norm)).catch((error) => console.warn('[qq-gateway] 消息处理失败:', error?.message || error));
  }

  /**
   * 拦截官方 QQBot 消息
   * @param {object} ctx DSH / QQBot 上下文
   */
  handleOfficialInbound(ctx) {
    const sender = String(ctx.sender || '');
    const senderName = String(ctx.senderName || '');
    const isOwner = Boolean(this.ownerOpenId) && sender === this.ownerOpenId;

    return {
      channel: 'official',
      messageId: String(ctx.messageId || ctx.msg_id || ctx.id || ''),
      atMention: ctx.atMention === true || ctx.eventType === 'AT_MESSAGE_CREATE' || ctx.eventType === 'GROUP_AT_MESSAGE_CREATE',
      isGroup: ctx.scope !== 'c2c',
      groupId: ctx.groupId || null,
      userId: sender,
      userName: senderName,
      isOwner,
      text: ctx.text || '',
      raw: ctx,
    };
  }

  /**
   * 判断一条入站消息是否属于主人
   */
  isMaster(normMsg) {
    if (!normMsg) return false;
    const id = String(normMsg.userId || '');
    if (normMsg.channel === 'official') return Boolean(this.ownerOpenId) && id === this.ownerOpenId;
    if (normMsg.channel === 'onebot') return Boolean(this.ownerQq) && id === this.ownerQq;
    return false;
  }
}

export default QQGateway;
