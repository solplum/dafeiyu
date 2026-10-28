/**
 * 传输层 · OneBot v11 适配
 * ─────────────────────────────────────────────────────────────
 * OneBot v11 是一个被广泛实现的机器人协议：
 *   NapCat / Lagrange / LLOneBot / go-cqhttp / SnowLuma 都实现了它。
 *
 * 这一层负责：
 *   - 连上 OneBot 的 WebSocket，收消息
 *   - 把 OneBot 的原始事件翻译成统一格式
 *   - 提供「发消息」「发图」「正在输入」等动作
 *
 * 如果你想接别的平台（微信/Telegram/自研），照着这个接口再写一个就行。
 */

/** 把 OneBot 消息段数组拼成纯文本 */
function segsToText(segs) {
  if (!Array.isArray(segs)) return String(segs || '');
  const out = [];
  for (const s of segs) {
    if (!s) continue;
    switch (s.type) {
      case 'text': out.push(s.data?.text || ''); break;
      case 'at': out.push('@' + (s.data?.qq || '')); break;
      case 'image': out.push('[图片]'); break;
      case 'face': out.push('[表情]'); break;
      case 'reply': break;   // 引用单独处理
      default: break;
    }
  }
  return out.join('').trim();
}

/** 从消息段里找引用 */
function findReply(segs) {
  if (!Array.isArray(segs)) return null;
  for (const s of segs) if (s?.type === 'reply') return String(s.data?.id || '');
  return null;
}

export class OneBot {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl       例如 ws://127.0.0.1:3001
   * @param {string} [opts.httpUrl]   例如 http://127.0.0.1:3000（发消息用）
   * @param {string} [opts.accessToken]
   * @param {(msg:object)=>void} [opts.onMessage]
   */
  constructor({ wsUrl, httpUrl, accessToken = '', onMessage, WebSocketImpl }) {
    this.wsUrl = wsUrl;
    this.httpUrl = (httpUrl || '').replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.onMessage = onMessage;
    this.selfId = '';
    this.ws = null;
    this.connected = false;
    this.stopped = false;
    this.reconnectTimer = null;
    this.WebSocketImpl = WebSocketImpl;
    this.#connect();
  }

  #headers() {
    const h = {};
    if (this.accessToken) h.authorization = 'Bearer ' + this.accessToken;
    return h;
  }

  async #connect() {
    if (this.stopped) return;
    try {
      const WebSocket = this.WebSocketImpl || (await import('ws').catch(() => ({}))).WebSocket || globalThis.WebSocket;
      if (this.stopped) return;
      if (!WebSocket) throw new Error('请安装 ws 依赖，或使用支持 WebSocket 的 Node 版本');
      const nodeStyle = typeof WebSocket.prototype?.on === 'function';
      if (!nodeStyle && this.accessToken) throw new Error('带令牌的 OneBot WebSocket 需要安装 ws 依赖');
      const sock = nodeStyle ? new WebSocket(this.wsUrl, { headers: this.#headers() }) : new WebSocket(this.wsUrl);
      this.ws = sock;
      const listen = (event, fn) => nodeStyle ? sock.on(event, fn) : sock.addEventListener(event, fn);
      listen('open', () => { if (!this.stopped && this.ws === sock) { this.connected = true; console.log('[onebot] 已连接'); } });
      listen('close', () => {
      if (this.stopped || this.ws !== sock) return;
      this.connected = false;
      this.ws = null;
      console.log('[onebot] 断开，5 秒后重连');
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.#connect(); }, 5000);
      this.reconnectTimer.unref?.();
    });
    listen('error', (e) => console.log('[onebot] 出错 ' + (e?.message || 'WebSocket 错误')));
    listen('message', (data) => {
      if (this.stopped || this.ws !== sock) return;
      let ev;
      try { ev = JSON.parse(String(data?.data !== undefined ? data.data : data)); } catch { return; }
      this.#handle(ev);
    });
    } catch (error) {
      this.lastError = error?.message || String(error);
      console.error('[onebot] 连接失败 ' + this.lastError);
    }
  }

  close() {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.ws;
    this.ws = null;
    try { socket?.close?.(); } catch {}
  }

  #handle(ev) {
    if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
      this.selfId = String(ev.self_id || '');
      return;
    }
    if (ev.post_type !== 'message') return;
    if (ev.self_id) this.selfId = String(ev.self_id);
    if (String(ev.user_id) === this.selfId) return;

    const isGroup = ev.message_type === 'group';
    const segs = ev.message;
    const replyId = findReply(segs);
    // 有没有 @ 我
    const atMe = Array.isArray(segs) && segs.some((s) => s?.type === 'at' && String(s.data?.qq) === this.selfId);

    const msg = {
      key: isGroup ? 'group:' + ev.group_id : 'private:' + ev.user_id,
      isGroup,
      groupId: isGroup ? String(ev.group_id) : '',
      userId: String(ev.user_id),
      name: String(ev.sender?.card || ev.sender?.nickname || ev.user_id),
      text: segsToText(segs),
      raw: segs,
      isAtMe: atMe,
      isQuoteMe: false,   // 需要额外查询被引用消息的发送者，见 resolveQuote
      replyTo: replyId,
      messageId: String(ev.message_id || ''),
      time: (ev.time || Math.floor(Date.now() / 1000)) * 1000,
    };
    Promise.resolve().then(async () => {
      // A reply segment identifies a message, not its sender. Resolve only this
      // read-only lookup before the waker decides whether the quote addresses us.
      if (isGroup && replyId && !atMe && this.selfId) msg.isQuoteMe = (await this.whoSent(replyId)) === this.selfId;
      if (!this.stopped) return this.onMessage?.(msg);
    }).catch((e) => console.error('[onebot] 消息处理失败 ' + (e?.message || e)));
  }

  /** 调 OneBot 的 HTTP API */
  async api(action, params = {}) {
    if (this.stopped) return { ok: false, error: 'OneBot 已停止' };
    if (!this.httpUrl) return { ok: false, error: '没配 httpUrl' };
    try {
      const r = await fetch(this.httpUrl + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#headers() },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30000),
      });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { return { ok: false, error: 'OneBot 返回无效 JSON' }; }
      const valid = j && typeof j === 'object' && !Array.isArray(j) && ('status' in j || 'retcode' in j);
      const ok = Boolean(r.ok && valid && j.status !== 'failed' && Number(j.retcode ?? 0) === 0);
      return { ok, data: j, error: ok ? undefined : j?.message || j?.wording || 'OneBot 请求失败' };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  /** 发一条纯文本 */
  send(key, text, { atUserId } = {}) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    let message = String(text);
    if (atUserId) message = '[CQ:at,qq=' + atUserId + '] ' + message;
    return isGroup
      ? this.api('send_group_msg', { group_id: id, message, auto_escape: !atUserId })
      : this.api('send_private_msg', { user_id: id, message, auto_escape: !atUserId });
  }

  /** 发一张图（本地文件或 URL） */
  sendImage(key, file) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    const message = '[CQ:image,file=' + file + ']';
    return isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message });
  }

  /**
   * 「正在输入…」
   * OneBot 扩展接口，部分实现支持（SnowLuma 是 set_input_status）
   */
  async setTyping(key, on) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    return this.api('set_input_status', isGroup
      ? { group_id: id, event_type: on ? 1 : 0 }
      : { user_id: id, event_type: on ? 1 : 0 });
  }

  /** 查一条消息是谁发的（用来判断引用的是不是我） */
  async whoSent(messageId) {
    const r = await this.api('get_msg', { message_id: messageId });
    return r.ok ? String(r.data?.data?.user_id || '') : '';
  }
}

export { segsToText };
export default OneBot;
