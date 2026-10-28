/** Optional device startup, owner-history recovery, and serialized message replies. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const messageTime = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : 0;
};

export class AutoReadyManager {
  constructor({ projectRoot, ownerQq = '', ownerOpenId = '', phoneDevice = '', qqGateway,
    phoneTools, memoryBridge, brain, humanizer, logger = console,
    enabled = true, connectPhone = false, catchUpUnread = false, catchUpLookbackMs = 0,
    privateWindowMs = 1800, groupWindowMs = 4000 } = {}) {
    Object.assign(this, { projectRoot, ownerQq: String(ownerQq), ownerOpenId: String(ownerOpenId),
      phoneDevice, qqGateway, phoneTools, memoryBridge, brain, humanizer, logger,
      connectPhone, catchUpUnread, privateWindowMs, groupWindowMs });
    this.enabled = enabled === true;
    this.stateFile = path.resolve(projectRoot, 'packages/dsh-dafeiyu/data/state.json');
    this.state = this.enabled ? this.#loadState(catchUpLookbackMs) : this.#initialState(catchUpLookbackMs);
    this.batchQueue = new Map();
    this.running = new Map();
    this.seen = new Set();
    this.stopped = false;
    this.controller = new AbortController();
    this.catchUpTask = null;
  }

  #loadState(lookbackMs) {
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (Number.isFinite(state.lastProcessedTime) && state.lastProcessedTime >= 0
        && (state.historyWatermarkTime === undefined || (Number.isFinite(state.historyWatermarkTime) && state.historyWatermarkTime >= 0))) return {
        ...state,
        historyWatermarkTime: Number.isFinite(state.historyWatermarkTime) ? state.historyWatermarkTime : state.lastProcessedTime,
        deliveryReceipts: state.deliveryReceipts && typeof state.deliveryReceipts === 'object' ? state.deliveryReceipts : {},
        outbox: state.outbox && typeof state.outbox === 'object' ? state.outbox : {},
      };
      throw new Error('state.json 无有效水位线');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`回复状态无法读取，已停止自动回复以避免重复副作用: ${error.message}`);
    }
    return this.#initialState(lookbackMs);
  }

  #initialState(lookbackMs) {
    const start = Math.floor((Date.now() - Math.max(0, Number(lookbackMs) || 0)) / 1000) * 1000;
    return { lastProcessedTime: start, historyWatermarkTime: start,
      deliveryReceipts: {}, outbox: {}, lastProcessedIds: [], lastRepliedTime: 0, totalCatchUpCount: 0 };
  }

  saveState(patch = {}) {
    if (!this.enabled) return false;
    const next = { ...this.state, ...patch };
    // Existing callers can explicitly reset the history floor. Internal live
    // acknowledgements always supply the independent floor unchanged.
    if (Object.hasOwn(patch, 'lastProcessedTime') && !Object.hasOwn(patch, 'historyWatermarkTime')) {
      next.historyWatermarkTime = patch.lastProcessedTime;
    }
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, this.stateFile);
      this.state = next;
      return true;
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      this.logger.warn?.(`[auto-ready] 保存状态失败: ${error.message}`);
      return false;
    }
  }

  async executeAutoReady() {
    if (this.stopped) return { ok: false, stopped: true };
    const status = { phone: 'not-requested', catchUp: 'not-requested' };
    if (this.connectPhone) {
      try {
        if (this.phoneDevice.includes(':')) {
          await execFileAsync(this.phoneTools.adbPath || 'adb', ['connect', this.phoneDevice],
            { timeout: 8000, signal: this.controller.signal });
        }
        const state = await this.phoneTools.getDeviceState();
        status.phone = state.online ? 'online' : 'offline';
      } catch (error) {
        status.phone = 'offline';
        this.logger.warn?.(`[auto-ready] 真机连接失败: ${error.message}`);
      }
    }
    if (this.enabled && this.catchUpUnread && !this.stopped) {
      this.qqGateway.onConnect = () => this.catchUpUnreadMessages();
      status.catchUp = await this.catchUpUnreadMessages();
    }
    if (!this.stopped) this.saveState({ lastStartupTime: new Date().toISOString() });
    return status;
  }

  /** History is read only when explicitly enabled/called, and failed reads never advance it. */
  catchUpUnreadMessages() {
    if (this.catchUpTask) return this.catchUpTask;
    this.catchUpTask = this.#catchUp().catch((error) => {
      this.logger.warn?.(`[auto-ready] 未读补回失败: ${error.message}`);
      return { ok: false, ...(error.uncertain ? { uncertain: true } : {}), error: error.message };
    }).finally(() => { this.catchUpTask = null; });
    return this.catchUpTask;
  }

  async #catchUp() {
    if (!this.enabled) return { ok: false, disabled: true, error: '独立消息回复支路未启用' };
    if (this.stopped || !this.ownerQq) return { ok: false, skipped: true };
    const floor = this.state.historyWatermarkTime;
    const history = await this.#readCoveredHistory(floor);
    if (!history.ok) return history;
    const key = `private:${this.ownerQq}`;
    return this.#serialize(key, async () => {
      if (this.stopped) return { ok: false, stopped: true };
      const currentFloor = this.state.historyWatermarkTime;
      if (history.messages.some((msg) => String(msg.userId) === this.ownerQq && !msg.isSelf
        && String(msg.text || '').trim() && (!msg.messageId || !messageTime(msg.time)))) {
        return { ok: false, incomplete: true, error: '历史消息缺少稳定 ID 或源时间，未回复或推进补回水位' };
      }
      const items = history.messages.filter((msg) => String(msg.userId) === this.ownerQq && !msg.isSelf
        && String(msg.text || '').trim() && messageTime(msg.time) >= currentFloor
        && !this.#isDelivered(key, msg));
      const latest = Math.max(currentFloor, ...history.messages.map((msg) => messageTime(msg.time)));
      if (!items.length) {
        if (!this.saveState({ historyWatermarkTime: latest })) return { ok: false, error: '历史水位保存失败' };
        return { ok: true, count: 0 };
      }
      const last = items.at(-1);
      const input = { key, userId: this.ownerQq, userName: last.userName || this.ownerQq,
        text: items.map((msg) => msg.text).join(' '), isOwner: true, isGroup: false,
        situation: '下面是离线期间尚未确认回复的消息。根据内容回复，不要编造离线原因。',
        record: false, signal: this.controller.signal };
      await this.#deliverWithReceipts(input, last, items);
      if (!this.saveState({ historyWatermarkTime: latest,
        totalCatchUpCount: (this.state.totalCatchUpCount || 0) + items.length })) {
        return { ok: false, delivered: true, error: '回复已送达，但历史水位保存失败；送达回执阻止重复回复' };
      }
      this.memoryBridge?.appendTimeline?.({ summary: '补回离线消息', detail: `已回复 ${items.length} 条离线消息` });
      return { ok: true, count: items.length };
    });
  }

  async #readCoveredHistory(floor) {
    const collected = new Map();
    let cursor, count = 20;
    const usedCursors = new Set();
    for (let page = 0; page < 25 && !this.stopped; page++) {
      const result = await this.qqGateway.fetchFriendHistory(this.ownerQq, count, { beforeSeq: cursor });
      if (!result?.ok || !Array.isArray(result.messages)) return { ok: false, error: result?.error || '历史消息查询失败' };
      for (const msg of result.messages) {
        const id = String(msg.messageId || '');
        collected.set(id || `missing:${collected.size}`, msg);
      }
      const covered = result.coverage?.complete === true
        || result.messages.some((msg) => messageTime(msg.time) > 0 && messageTime(msg.time) < floor);
      if (covered) return { ok: true,
        messages: [...collected.values()].sort((a, b) => messageTime(a.time) - messageTime(b.time)) };
      if (!result.messages.length) break;
      const next = result.coverage?.nextCursor;
      if (next !== undefined && next !== null && !usedCursors.has(String(next))) {
        cursor = next; usedCursors.add(String(next));
      } else if (cursor === undefined && count < 640) {
        // Some implementations omit sequence cursors. Expand the same window;
        // a short response alone is never evidence that older history is absent.
        count *= 2;
      } else break;
    }
    return { ok: false, incomplete: true, count: 0,
      error: '历史覆盖不足：未读取到原补回水位，且接口未确认历史结束；未回复或推进水位' };
  }

  enqueueIncomingMessage(msg) {
    if (!this.enabled || this.stopped || !msg || !String(msg.text || '').trim() || !msg.userId) return;
    const key = msg.channel === 'official'
      ? (msg.isGroup ? `official:group:${msg.groupId}` : `official:c2c:${msg.userId}`)
      : (msg.isGroup ? `group:${msg.groupId}` : `private:${msg.userId}`);
    if (msg.isGroup && !msg.groupId) return;
    const id = msg.messageId ? `${key}:${msg.messageId}` : null;
    if (id && this.seen.has(id)) return;
    if (id) {
      this.seen.add(id);
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    }
    // People in a group must not be merged into the last speaker's identity.
    const batchKey = msg.isGroup ? `${key}\0${msg.userId}` : key;
    const entry = this.batchQueue.get(batchKey) || { timer: null, items: [], key };
    entry.items.push({ ...msg, text: String(msg.text) });
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void this.flush(batchKey); },
      msg.isGroup ? this.groupWindowMs : this.privateWindowMs);
    entry.timer.unref?.();
    this.batchQueue.set(batchKey, entry);
  }

  /** Deterministic drain also lets offline tests observe the actual reply, not only enqueue. */
  async flush(batchKey) {
    const keys = batchKey === undefined ? [...this.batchQueue.keys()] : [batchKey];
    return Promise.all(keys.map((queueKey) => {
      const entry = this.batchQueue.get(queueKey);
      if (!entry) return undefined;
      this.batchQueue.delete(queueKey);
      clearTimeout(entry.timer);
      return this.#serialize(entry.key, () => this.#reply(entry)).catch((error) => {
        for (const msg of entry.items) if (msg.messageId) this.seen.delete(`${entry.key}:${msg.messageId}`);
        this.logger.warn?.(`[auto-ready] 回复失败 (${entry.key}): ${error.message}`);
        return { ok: false, ...(error.uncertain ? { uncertain: true } : {}), error: error.message };
      });
    }));
  }

  #serialize(key, task) {
    const previous = this.running.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.running.set(key, current);
    current.finally(() => { if (this.running.get(key) === current) this.running.delete(key); }).catch(() => {});
    return current;
  }

  async #reply({ key, items }) {
    if (this.stopped || !items.length) return;
    const last = items.at(-1);
    const exactOwner = (this.ownerQq && String(last.userId) === this.ownerQq)
      || (this.ownerOpenId && String(last.userId) === this.ownerOpenId);
    if (last.isGroup && !exactOwner && !items.some((msg) => msg.atMention || msg.mentioned
      || /大肥鱼|小鲸鱼/.test(msg.text))) return { ok: true, skipped: true };
    const input = { key, userId: last.userId, userName: last.userName,
      text: items.map((msg) => msg.text).join(' '), isOwner: Boolean(exactOwner && !last.isGroup),
      isGroup: Boolean(last.isGroup), situation: last.isGroup ? '你在 QQ 群聊中。'
        : (exactOwner ? '你在与已绑定主人私聊。' : '你在与一位访客私聊。不要把访客当作主人。'),
      record: false, signal: this.controller.signal };
    await this.#deliverWithReceipts(input, last, items);
    return { ok: true };
  }

  #receiptKey(key, msg) { return `${key}\0${String(msg.messageId || '')}`; }
  #isDelivered(key, msg) {
    return Boolean(msg.messageId && (this.state.deliveryReceipts[this.#receiptKey(key, msg)]?.status === 'delivered'
      || (key === `private:${this.ownerQq}` && messageTime(msg.time) === this.state.lastProcessedTime
        && this.state.lastProcessedIds?.includes(String(msg.messageId)))));
  }

  #storeDelivery(record) {
    const receipts = { ...this.state.deliveryReceipts };
    for (const msg of record.items) if (msg.messageId) receipts[this.#receiptKey(record.input.key, msg)] = {
      batchId: record.id, status: record.status, time: messageTime(msg.time),
    };
    return this.saveState({ outbox: { ...this.state.outbox, [record.id]: record }, deliveryReceipts: receipts });
  }

  async #deliverWithReceipts(input, last, items) {
    const fresh = [], replayIds = new Set();
    for (const msg of items) {
      if (this.#isDelivered(input.key, msg)) continue;
      const receipt = msg.messageId && this.state.deliveryReceipts[this.#receiptKey(input.key, msg)];
      if (!receipt) { fresh.push(msg); continue; }
      if (receipt.status === 'delivered') continue;
      if (receipt.status !== 'retryable') {
        const error = new Error('此前回复或工具操作结果未确认，已阻止自动重放；请先核实送达记录');
        error.uncertain = true; throw error;
      }
      replayIds.add(receipt.batchId);
    }
    for (const id of replayIds) {
      const record = this.state.outbox[id];
      if (!record?.text || record.status !== 'retryable') throw new Error('待续发回复记录不完整，禁止重新生成');
      await this.#generateAndSend(record);
    }
    if (!fresh.length) return;
    const actualInput = { ...input, text: fresh.map((msg) => msg.text).join(' ') };
    delete actualInput.signal;
    const id = createHash('sha256').update(input.key + '\0' + fresh.map((msg) => msg.messageId || randomUUID()).join('\0')).digest('hex');
    const record = { id, input: actualInput, last: { messageId: last.messageId },
      items: fresh.map((msg) => ({ messageId: msg.messageId, time: msg.time })),
      status: 'generating', text: '', confirmedChunks: 0, updatedAt: Date.now() };
    if (!this.#storeDelivery(record)) throw new Error('无法保存回复执行记录，未调用模型或发送消息');
    await this.#generateAndSend(record);
  }

  async #generateAndSend(initial) {
    let record = { ...initial };
    try {
      if (!record.text) {
        const reply = await this.brain.reply({ ...record.input, signal: this.controller.signal });
        if (this.stopped) throw new Error('插件已停止');
        if (!reply?.text?.trim()) throw new Error('模型未返回有效回复');
        record = { ...record, text: reply.text, status: 'ready',
          ...(typeof this.humanizer.split === 'function' ? { chunks: this.humanizer.split(reply.text) } : {}) };
        if (!this.#storeDelivery(record)) throw new Error('模型已完成但回复记录保存失败，禁止自动重跑工具');
      }
      let chunkIndex = 0;
      await this.humanizer.say(record.chunks || record.text, {
        send: async (chunk) => {
          const index = chunkIndex++;
          if (index < record.confirmedChunks) return { ok: true, previouslyDelivered: true };
          if (this.stopped) throw new Error('插件已停止');
          record = { ...record, status: 'sending', inFlightChunk: index };
          if (!this.#storeDelivery(record)) throw new Error('无法保存发送前记录，未发送下一片段');
          let result;
          try { result = await this.qqGateway.sendMessage(record.input.key, chunk, { messageId: record.last.messageId }); }
          catch (error) { error.uncertain = true; throw error; }
          if (this.stopped) { const error = new Error('插件在发送期间停止，结果需先核实'); error.uncertain = true; throw error; }
          if (!result?.ok) {
            const error = new Error(result?.error || '消息未确认送达');
            error.uncertain = result?.uncertain === true; error.knownSendFailure = result?.ok === false && !error.uncertain;
            throw error;
          }
          record = { ...record, status: 'ready', confirmedChunks: index + 1, inFlightChunk: null };
          if (!this.#storeDelivery(record)) {
            const error = new Error('片段已送达但回执保存失败，禁止自动重复发送'); error.uncertain = true; throw error;
          }
          return result;
        },
      });
      record = { ...record, status: 'delivered', updatedAt: Date.now() };
      if (!this.#storeDelivery(record)) throw new Error('回复已送达但最终回执保存失败，禁止自动重复发送');
      this.#acknowledge(record.items);
      if (!this.stopped) {
        try { this.brain.recordReply?.(record.input, record.text); }
        catch (error) { this.logger.warn?.(`[auto-ready] 回复已送达但记忆写入失败: ${error.message}`); }
      }
    } catch (error) {
      record = { ...record, status: error.knownSendFailure ? 'retryable' : 'uncertain',
        error: error.message, updatedAt: Date.now() };
      if (!this.stopped) this.#storeDelivery(record);
      error.uncertain = record.status === 'uncertain';
      throw error;
    }
  }

  #acknowledge(items) {
    const latest = Math.max(this.state.lastProcessedTime, ...items.map((msg) => messageTime(msg.time)));
    const ids = latest === this.state.lastProcessedTime ? [...(this.state.lastProcessedIds || [])] : [];
    for (const msg of items) if (messageTime(msg.time) === latest && msg.messageId) ids.push(String(msg.messageId));
    this.saveState({ lastProcessedTime: latest, historyWatermarkTime: this.state.historyWatermarkTime,
      lastProcessedIds: [...new Set(ids)].slice(-100),
      lastRepliedTime: Date.now() });
  }

  dispose() {
    this.stopped = true;
    this.controller.abort();
    for (const entry of this.batchQueue.values()) clearTimeout(entry.timer);
    this.batchQueue.clear();
    if (this.qqGateway) this.qqGateway.onConnect = undefined;
  }
}

export default AutoReadyManager;
