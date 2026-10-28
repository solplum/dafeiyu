/** Session-scoped bridge between the companion model and explicitly enabled executors. */
import fs from 'node:fs';
import path from 'node:path';
import { validateToolArguments } from '../../companion/src/tool-loop.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const EMPTY_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const PHONE_METHODS = {
  phone_screenshot: 'screenshot', phone_get_ui_tree: 'getUiTree', phone_key: 'key', phone_listen: 'listen',
  phone_tap: 'tap', phone_swipe: 'swipe', phone_type: 'typeText', phone_steal_meme: 'stealMeme',
};
const tool = (name, description, properties = {}, required = []) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const checkAbort = (signal) => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('工具会话已取消'); };

export class CompanionToolRegistry {
  constructor({ phoneTools, voiceProcessor, memoryBridge, memeManager, ownerQq = '', ownerOpenId = '',
    phoneEnabled = false, allowedPhoneTools = ['phone_screenshot', 'phone_get_ui_tree', 'phone_key', 'phone_listen'],
    allowedKeys = ['back'], maxListenSeconds = 3, sendImage, allowMemoryWrites = false,
    allowMemeSync = false, memeImportRoots = [] } = {}) {
    if (!Array.isArray(allowedPhoneTools) || !allowedPhoneTools.every((name) => Object.hasOwn(PHONE_METHODS, name))) throw new Error('手机工具白名单含未知工具');
    if (!Array.isArray(allowedKeys) || !allowedKeys.every((key) => typeof key === 'string' && key.length)) throw new Error('手机按键白名单无效');
    if (!Number.isInteger(maxListenSeconds) || maxListenSeconds < 1 || maxListenSeconds > 30) throw new Error('录音上限必须在 1 到 30 秒之间');
    if (sendImage !== undefined && typeof sendImage !== 'function') throw new Error('sendImage 必须是已授权的发送函数');
    Object.assign(this, { phoneTools, voiceProcessor, memoryBridge, memeManager, sendImage });
    this.ownerQq = String(ownerQq || ''); this.ownerOpenId = String(ownerOpenId || '');
    this.phoneEnabled = phoneEnabled === true;
    this.allowedPhoneTools = new Set(allowedPhoneTools);
    this.allowedKeys = new Set(allowedKeys.map((key) => key.toLowerCase()));
    this.maxListenSeconds = maxListenSeconds;
    this.allowMemoryWrites = allowMemoryWrites === true;
    this.allowMemeSync = allowMemeSync === true;
    if (!Array.isArray(memeImportRoots) || memeImportRoots.some((root) => typeof root !== 'string')) throw new Error('图片导入目录配置无效');
    this.memeImportRoots = memeImportRoots.map((root) => path.resolve(root));
    this.closed = false;
  }

  isAuthorized(context) {
    if (this.closed || !context || context.isGroup === true) return false;
    const id = String(context.userId || '');
    return Boolean(this.ownerQq && id === this.ownerQq && context.key === `private:${this.ownerQq}`) ||
      Boolean(this.ownerOpenId && id === this.ownerOpenId && context.key === `official:c2c:${this.ownerOpenId}`);
  }

  definitions(context) {
    if (!this.isAuthorized(context)) return [];
    const description = { type: 'string', minLength: 1, maxLength: 1200, description: '实际画面、具体含义和适用语境；先看实际图片，名称和标签不能代替描写' };
    const aiDescription = { type: 'string', maxLength: 1200, description: '可选 AI 选图补充，空则沿用共同描写' };
    const descriptions = { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'object', properties: { filename: { type: 'string', minLength: 1, maxLength: 2000 }, description, aiDescription }, required: ['filename', 'description'], additionalProperties: false } };
    const result = [tool('companion_status', '读取已配置能力状态 不探测手机 不执行设备命令')];
    if (this.allowMemoryWrites && typeof this.memoryBridge?.appendTimeline === 'function') {
      result.push(tool('remember_event', '将实际发生的事件写入手账；长期事实或偏好使用 remember_fact', {
        summary: { type: 'string', minLength: 1, maxLength: 80 }, detail: { type: 'string', minLength: 1, maxLength: 1000 },
      }, ['summary', 'detail']));
    }
    if (this.allowMemoryWrites && typeof this.memoryBridge?.remember === 'function') result.push(tool('remember_fact', '保存或更新长期事实与偏好；更新同一事实时复用 key', {
      key: { type: 'string', minLength: 1, maxLength: 160 }, summary: { type: 'string', minLength: 1, maxLength: 160 },
      detail: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['summary', 'detail']));
    if (typeof this.memoryBridge?.searchMemories === 'function') result.push(tool('memory_search', '检索共享长期事实、档案与完整旧手账，找不到时不得编造', {
      query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20 },
      kind: { type: 'string', enum: ['all', 'fact', 'event'] },
    }, ['query']));
    if (typeof this.memeManager?.listMemes === 'function') {
      result.push(tool('meme_list', '列出本地表情的真实文件名、含义和适用语境；missing 描写的旧图仅供预览补写，勿猜含义。AI 补充为空时沿用 description', { limit: { type: 'integer', minimum: 1, maximum: 100 } }));
      if (typeof this.sendImage === 'function') result.push(tool('meme_send', '将表情库中精确选择的一张图片发送到当前主人私聊', {
        filename: { type: 'string', minLength: 1, maxLength: 255 },
      }, ['filename']));
    }
    if (typeof this.memeManager?.searchMemes === 'function') result.push(tool('meme_search', '按含义、适用语境、名称和标签检索；情绪推荐仅挑选有描写的图库候选。不是视觉识别，勿猜缺描写旧图的含义；AI 补充为空时沿用 description', {
      query: { type: 'string', maxLength: 160 }, replyText: { type: 'string', maxLength: 2000 }, limit: { type: 'integer', minimum: 1, maximum: 30 },
    }));
    if (typeof this.memeManager?.readImage === 'function') result.push(tool('meme_preview', '查看图库中实际图片内容；不会发送图片', {
      filename: { type: 'string', minLength: 1, maxLength: 255 },
    }, ['filename']));
    if (this.memeImportRoots.length && typeof this.memeManager?.collectMeme === 'function') result.push(tool('meme_collect', '先看实际图片，再收藏已授权目录的图片；每次必须写画面、具体含义和适用语境，不能从文件名编造；不发送图片', {
      path: { type: 'string', minLength: 1, maxLength: 2000 }, title: { type: 'string', maxLength: 160 },
      tags: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 30 }, description, aiDescription,
    }, ['path', 'description']));
    if (this.phoneEnabled && this.allowMemeSync && this.phoneTools?.enabled !== false && typeof this.memeManager?.syncFromPhone === 'function') result.push(tool('meme_sync', '按授权同步手机图片；逐图给出已确认含义与语境，filename 用拉取目录相对路径精确匹配，缺描写逐项拒绝；不发送图片', { descriptions }, ['descriptions']));
    if (this.phoneEnabled && this.phoneTools && this.phoneTools.enabled !== false) {
      const coordinates = Object.fromEntries(['x', 'y', 'x1', 'y1', 'x2', 'y2'].map((key) => [key, { type: 'integer', minimum: 0, maximum: 100000 }]));
      const candidates = [
        tool('phone_screenshot', '读取手机当前实际截图 返回图片供视觉模型查看'),
        tool('phone_get_ui_tree', '读取当前手机界面实际控件文字 超长内容明确标记截断'),
        tool('phone_key', '只执行配置白名单中的安卓按键', { key: { type: 'string', enum: [...this.allowedKeys] } }, ['key']),
        tool('phone_listen', '短时录制手机播放声音 有语音识别服务才返回听到的文字 否则仅保存录音', { seconds: { type: 'integer', minimum: 1, maximum: this.maxListenSeconds } }),
        tool('phone_tap', '点击手机当前屏幕中指定坐标', { x: coordinates.x, y: coordinates.y }, ['x', 'y']),
        tool('phone_swipe', '在手机当前屏幕中滑动', { x1: coordinates.x1, y1: coordinates.y1, x2: coordinates.x2, y2: coordinates.y2,
          durationMs: { type: 'integer', minimum: 1, maximum: 10000 } }, ['x1', 'y1', 'x2', 'y2']),
        tool('phone_type', '向手机当前输入框输入文字', { text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['text']),
        tool('phone_steal_meme', '查看当前实际截图后保存到手机表情相册；每次必填画面、含义与适用语境，不从文件名编造', { description, aiDescription }, ['description']),
      ];
      for (const candidate of candidates) {
        const name = candidate.function.name;
        if (this.allowedPhoneTools.has(name) && typeof this.phoneTools[PHONE_METHODS[name]] === 'function' && (name !== 'phone_key' || this.allowedKeys.size)) result.push(candidate);
      }
    }
    return result;
  }

  async execute(name, args = {}, context, { signal } = {}) {
    checkAbort(signal);
    if (!this.isAuthorized(context)) throw new Error('工具仅允许已绑定主人的原路私聊');
    // Recompute current permissions; an earlier model-visible definition is not authority.
    const definition = this.definitions(context).find((entry) => entry.function.name === name);
    if (!definition) throw new Error('未知、未启用或已撤销的工具：' + name);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
    validateToolArguments(args, definition.function.parameters || EMPTY_ARGS);
    checkAbort(signal);
    if (name === 'companion_status') return { output: this.#status() };
    if (name === 'remember_event') {
      const summary = args.summary.replace(/\s+/g, ' ').trim(), detail = args.detail.replace(/\s+/g, ' ').trim();
      if (!summary || !detail) throw new Error('记忆标题和内容不能为空');
      const result = typeof this.memoryBridge.remember === 'function'
        ? await this.memoryBridge.remember({ kind: 'event', summary, detail }) : undefined;
      const saved = result ? result.ok === true && result.saved === true : await this.memoryBridge.appendTimeline({ summary, detail });
      checkAbort(signal);
      return { output: saved === true ? { ok: true, source: 'memory/timeline.md', saved: true, summary }
        : { ok: false, source: 'memory/timeline.md', saved: false, error: '手账写入未成功' } };
    }
    if (name === 'remember_fact') return { output: await this.memoryBridge.remember({ ...args, kind: 'fact' }) };
    if (name === 'memory_search') return { output: this.memoryBridge.searchMemories(args.query, { limit: args.limit || 10, kind: args.kind || 'all', maxChars: 16000 }) };
    if (name === 'meme_search') return { output: args.replyText
      ? this.memeManager.matchMemeForReplyResult(args.replyText)
      : this.memeManager.searchMemes(args.query || '', { limit: args.limit || 10 }) };
    if (name === 'meme_preview') {
      const { bytes, mediaType } = this.memeManager.readImage(args.filename);
      return { output: { ok: true, filename: args.filename, ...this.memeManager.getMetadata?.(args.filename), imageAttached: true }, content: [{ type: 'image_url',
        image_url: { url: `data:${mediaType};base64,${bytes.toString('base64')}` } }] };
    }
    if (name === 'meme_collect') {
      const file = fs.realpathSync(args.path);
      const allowed = this.memeImportRoots.some((root) => {
        try { return file.startsWith(fs.realpathSync(root) + path.sep); } catch { return false; }
      });
      if (!allowed) throw new Error('图片不在已授权的导入目录');
      return { output: this.memeManager.collectMeme(file, args.title || '', { tags: args.tags || [], description: args.description, aiDescription: args.aiDescription }) };
    }
    if (name === 'meme_sync') return { output: await this.memeManager.syncFromPhone({ descriptions: args.descriptions }) };
    if (name === 'meme_list') {
      const scan = this.memeManager.scanMemes?.();
      const rows = scan ? scan.memes : this.#memes();
      const { memes: _entries, ...health } = scan || {};
      const output = { ok: true, source: 'local_meme_library', total: rows.length, truncated: rows.length > (args.limit || 30),
        ...health,
        memes: rows.slice(0, args.limit || 30).map((row) => ({ filename: row.filename, title: row.title || '', tags: row.tags || [], description: row.description || '', aiDescription: row.aiDescription || '', descriptionStatus: row.descriptionStatus || 'missing', isWhaleMeme: row.isWhaleMeme === true })) };
      while (JSON.stringify(output).length > 24000 && output.memes.length) {
        output.memes.pop(); output.truncated = true;
      }
      return { output };
    }
    if (name === 'meme_send') return this.#sendMeme(args.filename, context, signal);
    return this.#phone(name, args, signal);
  }

  #status() {
    // This method deliberately never calls getDeviceState, adb, scrcpy, or STT.
    const runtime = typeof this.phoneTools?.getRuntimeStatus === 'function' ? this.phoneTools.getRuntimeStatus() : {};
    return { ok: true, source: 'local_configuration', phone: { enabled: Boolean(this.phoneEnabled && this.phoneTools && this.phoneTools.enabled !== false),
      configured: Boolean(this.phoneTools?.device || runtime.configured), probed: false, allowedTools: [...this.allowedPhoneTools],
      allowedKeys: [...this.allowedKeys], maxListenSeconds: this.maxListenSeconds },
      stt: { configured: typeof this.voiceProcessor?.sttProvider === 'function', readiness: 'not-verified' },
      memoryWritesEnabled: this.allowMemoryWrites, memeLibraryConfigured: Boolean(this.memeManager), imageSendingConfigured: typeof this.sendImage === 'function' };
  }

  #memes() {
    const rows = this.memeManager.listMemes();
    if (!Array.isArray(rows)) throw new Error('表情库没有返回有效列表');
    return rows.filter((row) => typeof row?.filename === 'string' && row.filename.length <= 255 && path.basename(row.filename) === row.filename && !/[\\/]/.test(row.filename));
  }

  async #sendMeme(filename, context, signal) {
    if (path.basename(filename) !== filename || /[\\/]/.test(filename)) throw new Error('只能选择表情库中的精确文件名');
    const selected = this.#memes().find((row) => row.filename === filename);
    if (!selected || !/\.(png|jpe?g|gif|webp)$/i.test(filename)) throw new Error('指定表情不在本地库中');
    if (!this.memeManager.libDir) throw new Error('表情库根目录未配置');
    const root = fs.realpathSync(this.memeManager.libDir);
    const candidate = path.resolve(this.memeManager.libDir, filename);
    const file = fs.realpathSync(candidate);
    if (!within(root, file) || !fs.statSync(file).isFile() || fs.statSync(file).size < 1 || fs.statSync(file).size > MAX_IMAGE_BYTES) throw new Error('表情文件不在库内或超过大小上限');
    checkAbort(signal);
    const sent = await this.sendImage(context.key, file, { signal, filename });
    checkAbort(signal);
    if (sent?.ok !== true) return { output: { ok: false, uncertain: sent?.uncertain === true, error: sent?.error || '表情发送未确认' } };
    return { output: { ok: true, source: 'local_meme_library', sent: true, filename } };
  }

  async #phone(name, args, signal) {
    if (!this.phoneEnabled || this.phoneTools?.enabled === false || !this.allowedPhoneTools.has(name)) throw new Error('手机功能已禁用或未授权');
    let result;
    if (name === 'phone_screenshot') {
      result = await this.phoneTools.screenshot({ signal });
      checkAbort(signal);
      if (result?.ok === false) return { output: result };
      if (!result?.path) throw new Error('截屏没有返回实际文件');
      const stat = fs.statSync(result.path);
      if (!stat.isFile() || stat.size < 8 || stat.size > MAX_IMAGE_BYTES) throw new Error('实际截图为空或超过大小上限');
      const bytes = fs.readFileSync(result.path);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('实际截图不是 PNG 文件');
      return { output: { ok: true, source: 'adb_screencap', captured: true, bytes: bytes.length, imageAttached: true },
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + bytes.toString('base64') } }] };
    }
    if (name === 'phone_get_ui_tree') {
      result = await this.phoneTools.getUiTree({ signal });
      checkAbort(signal);
      if (result?.ok === false) return { output: result };
      if (typeof result?.xml !== 'string' || !result.xml.trim()) throw new Error('未读取到实际 UI 控件树');
      const output = { ok: true, source: 'adb_uiautomator_dump', fullLength: result.xml.length, truncated: result.xml.length > 24000, xml: result.xml.slice(0, 24000) };
      while (JSON.stringify(output).length > 30000) { output.xml = output.xml.slice(0, Math.floor(output.xml.length * 0.9)); output.truncated = true; }
      return { output };
    }
    if (name === 'phone_listen') return this.#listen(args.seconds ?? Math.min(3, this.maxListenSeconds), signal);
    if (name === 'phone_key') {
      if (!this.allowedKeys.has(args.key.toLowerCase())) throw new Error('该手机按键不在白名单');
      result = await this.phoneTools.key(args.key.toLowerCase(), { signal });
    } else if (name === 'phone_tap') result = await this.phoneTools.tap(args.x, args.y, { signal });
    else if (name === 'phone_swipe') result = await this.phoneTools.swipe(args.x1, args.y1, args.x2, args.y2, args.durationMs ?? 300, { signal });
    else if (name === 'phone_type') result = await this.phoneTools.typeText(args.text, { signal });
    else if (name === 'phone_steal_meme') result = await this.phoneTools.stealMeme(undefined, { signal, description: args.description, aiDescription: args.aiDescription });
    else throw new Error('不支持的手机操作');
    checkAbort(signal);
    return { output: result && typeof result === 'object' ? { source: name, ...result }
      : { ok: false, uncertain: true, error: '手机操作没有返回确认结果' } };
  }

  async #listen(seconds, signal) {
    const capture = await this.phoneTools.listen(seconds, { signal });
    checkAbort(signal);
    const actual = Number.isFinite(capture?.actualDurationSeconds) && capture.actualDurationSeconds > 0
      ? capture.actualDurationSeconds : null;
    const timing = { requestedSeconds: seconds, actualDurationSeconds: actual, duration: actual,
      durationStatus: actual === null ? 'unknown' : 'measured',
      partial: actual === null ? null : actual < seconds - 0.05,
      ...(capture?.durationProbeError ? { durationProbeError: capture.durationProbeError } : {}) };
    if (capture?.ok !== true) return { output: { ok: false, source: 'scrcpy_playback_capture', transcribed: false,
      ...timing, ...(capture?.path ? { path: capture.path } : {}),
      audioSaved: Boolean(capture?.path && fs.existsSync(capture.path)), error: capture?.error || '录音未成功' } };
    if (!capture.path || !fs.existsSync(capture.path) || !fs.statSync(capture.path).isFile() || !fs.statSync(capture.path).size) throw new Error('录音文件不存在或为空');
    const base = { ok: true, source: 'scrcpy_playback_capture', audioSaved: true, path: capture.path, ...timing };
    if (typeof capture.text === 'string' && capture.text.trim()) return { output: { ...base, transcribed: true, text: capture.text.trim() } };
    if (typeof this.voiceProcessor?.sttProvider !== 'function') return { output: { ...base, transcribed: false, note: '录音已保存 未配置语音识别 尚不知道录音中的内容' } };
    try {
      const text = await this.voiceProcessor.transcribeFile(capture.path, { signal });
      checkAbort(signal);
      if (typeof text !== 'string' || !text.trim()) throw new Error('语音识别没有返回文字');
      return { output: { ...base, transcribed: true, text: text.trim() } };
    } catch (error) {
      checkAbort(signal);
      return { output: { ...base, ok: false, transcribed: false, error: '录音已保存 但语音识别失败：' + (error?.message || error) } };
    }
  }

  dispose() { this.closed = true; }
}

export default CompanionToolRegistry;
