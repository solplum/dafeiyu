/**
 * phone-tools.js — DSH 桌面端真机控制与感官工具集 (Phone-MCP Bridge)
 * ─────────────────────────────────────────────────────────────
 * 作用：
 * 封装通过 ADB 物理操控 Android 手机的所有关键能力，并注册进 DSH Tool Manager：
 * 1. 物理视觉：真机截屏 (phone_screenshot)
 * 2. 物理操作：点击 (phone_tap)、滑动 (phone_swipe)、按键 (phone_key)、打字 (phone_type)
 * 3. 听力感知：短视频音频与环境录音 (phone_listen)
 * 4. 专属神技：盗表情包 (phone_steal_meme)
 * 5. 界面感知：获取当前 UI 控件树 (phone_get_ui_tree)
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { probeCaptureDuration } from '../../phone-mcp/src/shared/media-probe.js';
import { normalizeMemeDescription } from '../../phone-mcp/src/shared/meme-description.js';

const execFileAsync = promisify(execFile);
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";

export class PhoneTools {
  /**
   * @param {object} opts
   * @param {string} [opts.device] 设备 IP:Port 或序列号，如 10.208.222.128:5555
   * @param {string} [opts.adbPath]
   */
  constructor({ device = process.env.PHONE_SERIAL || '', adbPath, scrcpyPath = process.env.PHONE_SCRCPY || 'scrcpy', ffprobePath = process.env.PHONE_FFPROBE || 'ffprobe', shotDir, runCommand = execFileAsync,
    enabled = false, getExecutionContext, allowDesktop = false,
    allowedTools = ['phone_screenshot', 'phone_get_ui_tree', 'phone_key', 'phone_listen'],
    allowedKeys = ['back'], maxListenSeconds = 3, transcribeAudio } = {}) {
    if (typeof device !== 'string') throw new Error('设备序列号必须是字符串');
    this.device = device.trim();
    this.adbPath = adbPath || this.#detectAdb();
    this.shotDir = shotDir || path.join(os.tmpdir(), 'dsh-dafeiyu-shots');
    this.scrcpyPath = scrcpyPath;
    this.ffprobePath = ffprobePath;
    this.runCommand = runCommand;
    this.disposers = [];
    this.lastToolResult = null;
    this.actionTail = Promise.resolve();
    this.active = 0;
    this.enabled = enabled === true;
    this.getExecutionContext = getExecutionContext;
    this.allowDesktop = allowDesktop === true;
    if (!Array.isArray(allowedTools) || !allowedTools.every((name) => typeof name === 'string')) throw new Error('手机工具白名单无效');
    if (!Array.isArray(allowedKeys) || !allowedKeys.every((key) => typeof key === 'string')) throw new Error('手机按键白名单无效');
    if (!Number.isInteger(maxListenSeconds) || maxListenSeconds < 1 || maxListenSeconds > 30) throw new Error('手机录音时长上限无效');
    this.allowedTools = new Set(allowedTools);
    this.allowedKeys = new Set(allowedKeys.map((key) => key.toLowerCase()));
    this.maxListenSeconds = maxListenSeconds;
    if (transcribeAudio !== undefined && typeof transcribeAudio !== 'function') throw new Error('transcribeAudio 必须为函数');
    this.transcribeAudio = transcribeAudio;
    fs.mkdirSync(this.shotDir, { recursive: true });
  }

  #detectAdb() {
    if (process.env.PHONE_ADB) return process.env.PHONE_ADB;
    const candidates = [
      '/usr/local/bin/adb',
      '/opt/homebrew/bin/adb',
      '/usr/bin/adb',
      path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return 'adb';
  }

  #assertActive(signal) {
    signal?.throwIfAborted();
    if (!this.device) throw new Error('未配置 phoneDevice，已取消真机操作');
    if (!this.enabled) throw new Error('手机运行时已设为离线或已停止，已取消后续操作');
  }

  async #withDeviceLock(callback, signal) {
    this.#assertActive(signal);
    if (this.active >= 8) throw new Error('手机操作队列已满，请等待当前操作结束');
    this.active++;
    const operation = this.actionTail.catch(() => {}).then(async () => {
      this.#assertActive(signal);
      return callback();
    });
    this.actionTail = operation.catch(() => {});
    try { return await operation; }
    finally { this.active--; }
  }

  async #adb(args, timeout = 30000, { signal } = {}) {
    this.#assertActive(signal);
    // adb shell joins arguments on the device; quote each literal there too.
    const command = args[0] === 'shell' ? ['shell', args.slice(1).map(shellQuote).join(' ')] : args;
    const fullArgs = this.device ? ['-s', this.device, ...command] : command;
    try {
      const { stdout, stderr } = await this.runCommand(this.adbPath, fullArgs, {
        timeout, signal,
        maxBuffer: 20 * 1024 * 1024,
      });
      this.#assertActive(signal);
      return { stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
    } catch (e) {
      this.#assertActive(signal);
      throw new Error(`ADB 执行失败 [${fullArgs.join(' ')}]: ${e?.stderr || e?.message || e}`);
    }
  }

  getRuntimeStatus() {
    return { enabled: this.enabled, configured: Boolean(this.device), allowedTools: [...this.allowedTools],
      allowedKeys: [...this.allowedKeys], maxListenSeconds: this.maxListenSeconds,
      authorizationConfigured: typeof this.getExecutionContext === 'function', transcriptionConfigured: typeof this.transcribeAudio === 'function' };
  }

  /** 获取设备连接状态与屏幕几何 */
  async getDeviceState() {
    if (!this.enabled) return { online: false, disabled: true, device: this.device, error: '手机运行时离线，未探测设备' };
    try {
      const sizeRes = await this.#adb(['shell', 'wm', 'size']);
      const focusRes = await this.#adb(['shell', 'dumpsys', 'window'], 5000);
      const focusMatch = focusRes.stdout.match(/mCurrentFocus=Window\{[^\s]+ [^\s]+ ([^\}]+)\}/);
      return {
        online: true,
        device: this.device,
        screenSize: sizeRes.stdout.replace('Physical size: ', ''),
        currentApp: focusMatch ? focusMatch[1] : 'unknown',
      };
    } catch (err) {
      return {
        online: false,
        device: this.device,
        error: err.message,
      };
    }
  }

  /** 截屏并返回本地图片路径 */
  async screenshot({ signal } = {}) {
    this.#assertActive(signal);
    const id = randomUUID();
    const filename = `screen_${id}.png`;
    const localPath = path.join(this.shotDir, filename);
    const remotePath = `/sdcard/_dsh_shot_${id}.png`;

    await this.#adb(['shell', 'screencap', '-p', remotePath], 30000, { signal });
    await this.#adb(['pull', remotePath, localPath], 30000, { signal });
    await this.#adb(['shell', 'rm', '-f', remotePath], 30000, { signal });

    if (!fs.existsSync(localPath) || !fs.statSync(localPath).size) throw new Error('截图文件不存在或为空');
    return { path: localPath, filename };
  }

  /** 点击指定坐标 */
  async tap(x, y) {
    if (![x, y].every((value) => Number.isFinite(value) && value >= 0)) throw new Error('点击坐标必须是非负数字');
    await this.#adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
    return { ok: true, x, y };
  }

  /** 滑动屏幕 */
  async swipe(x1, y1, x2, y2, durationMs = 300) {
    if (![x1, y1, x2, y2].every((value) => Number.isFinite(value) && value >= 0) || !Number.isFinite(durationMs) || durationMs < 1 || durationMs > 60000) throw new Error('滑动坐标或时长无效');
    await this.#adb([
      'shell',
      'input',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(Math.round(durationMs)),
    ]);
    return { ok: true };
  }

  /** 模拟按键 (BACK, HOME, POWER, VOLUME_UP, VOLUME_DOWN) */
  async key(keycode, { signal } = {}) {
    this.#assertActive(signal);
    const keyMap = {
      back: '4',
      home: '3',
      power: '26',
      menu: '82',
      volup: '24',
      voldown: '25',
      volume_up: '24',
      volume_down: '25',
      enter: '66',
      recent: '187',
      delete: '67',
    };
    const code = keyMap[String(keycode).toLowerCase()] || String(keycode);
    if (!/^\d{1,3}$/.test(code)) throw new Error('不支持的安卓按键');
    await this.#adb(['shell', 'input', 'keyevent', code], 30000, { signal });
    return { ok: true, keycode: code };
  }

  /** Pull through the same configured device as all other phone operations. */
  async pull(remotePath, localPath) {
    await this.#adb(['pull', remotePath, localPath]);
    return { path: localPath };
  }

  /** 输入文本；中文使用 ADBKeyboard，结束或失败时还原输入法。 */
  async typeText(text) {
    if (typeof text !== 'string' || !text.length) throw new Error('输入文字不能为空');
    if (/^[\x20-\x7e]*$/.test(text)) {
      await this.#adb(['shell', 'input', 'text', text]);
      return { ok: true };
    }
    const methods = await this.#adb(['shell', 'ime', 'list', '-a']);
    if (!methods.stdout.includes('com.android.adbkeyboard')) throw new Error('中文输入需要安装 ADBKeyboard');
    const previous = (await this.#adb(['shell', 'settings', 'get', 'secure', 'default_input_method'])).stdout;
    const enabled = (await this.#adb(['shell', 'settings', 'get', 'secure', 'enabled_input_methods'])).stdout;
    const ime = 'com.android.adbkeyboard/.AdbIME';
    if (!previous || previous === 'null') throw new Error('无法读取当前输入法，已取消输入');
    try {
      await this.#adb(['shell', 'ime', 'enable', ime]);
      await this.#adb(['shell', 'settings', 'put', 'secure', 'default_input_method', ime]);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await this.#adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', Buffer.from(text).toString('base64')]);
    } finally {
      await this.#adb(['shell', 'settings', 'put', 'secure', 'default_input_method', previous]);
      if (enabled && enabled !== 'null') await this.#adb(['shell', 'settings', 'put', 'secure', 'enabled_input_methods', enabled]);
    }
    return { ok: true };
  }

  /** 录制手机播放声音。这里只产出录音，识别内容需要配置 STT。 */
  async listen(durationSeconds = 3, { signal } = {}) {
    this.#assertActive(signal);
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > this.maxListenSeconds) {
      throw new Error(`录音时长必须为 1–${this.maxListenSeconds} 秒的整数`);
    }
    const localAudio = path.join(this.shotDir, `listen_${randomUUID()}.m4a`);
    const args = [
      ...(this.device ? ['-s', this.device] : []),
      '--no-video', '--no-playback', '--no-control', '--require-audio',
      '--audio-source=playback', `--record=${localAudio}`, `--time-limit=${durationSeconds}`,
    ];
    try {
      await this.runCommand(this.scrcpyPath, args, { timeout: (durationSeconds + 15) * 1000, signal, maxBuffer: 1024 * 1024 });
      this.#assertActive(signal);
      if (!fs.existsSync(localAudio) || fs.statSync(localAudio).size <= 100) {
        throw new Error('未捕获到有效手机音频');
      }
    } catch (error) {
      fs.rmSync(localAudio, { force: true });
      return { ok: false, ...(signal?.aborted || !this.enabled ? { cancelled: true } : {}), error: `录音失败：${error.message}` };
    }
    let timing;
    try {
      timing = await probeCaptureDuration(localAudio, { requestedSeconds: durationSeconds, signal,
        runCommand: this.runCommand, ffprobePath: this.ffprobePath });
      this.#assertActive(signal);
    } catch (error) {
      return { ok: false, path: localAudio, requestedSeconds: durationSeconds, actualDurationSeconds: null,
        duration: null, durationStatus: 'unknown', partial: null, cancelled: signal?.aborted === true || !this.enabled,
        error: `录音已保存，后续处理已取消：${error.message}` };
    }
    const capture = { path: localAudio, ...timing, duration: timing.actualDurationSeconds };
    if (this.transcribeAudio) {
      try {
        this.#assertActive(signal);
        const text = await this.transcribeAudio(localAudio, { signal });
        this.#assertActive(signal);
        if (typeof text !== 'string' || !text.trim()) throw new Error('未返回识别文字');
        return { ok: true, ...capture, text: text.trim(), note: '已保存录音并完成语音识别' };
      } catch (error) {
        return { ok: false, ...capture, ...(signal?.aborted || !this.enabled ? { cancelled: true } : {}), error: `录音已保存，但语音识别${signal?.aborted || !this.enabled ? '已取消' : '失败'}：${error.message}` };
      }
    }
    this.#assertActive(signal);
    return { ok: true, ...capture, note: '已保存录音，尚未配置语音识别' };
  }

  /**
   * 盗表情包技能 (phone_steal_meme)
   * 截取当前屏幕并保存至相册 /sdcard/Pictures/大肥鱼表情包/
   */
  async stealMeme(name = '大肥鱼表情包', { signal, description, aiDescription } = {}) {
    // Missing meaning is rejected before a screenshot or any other device command.
    const meaning = normalizeMemeDescription(description, { required: true });
    const aiMeaning = normalizeMemeDescription(aiDescription);
    if (typeof name !== 'string' || name.length > 160 || name.includes('\0')) throw new Error('表情名称最多 160 字符');
    this.#assertActive(signal);
    const device = this.device;
    const run = async (args) => {
      if (this.device !== device) throw new Error('手机设备配置已变化，已取消保存');
      const result = await this.#adb(args, 30000, { signal });
      if (this.device !== device) throw new Error('手机设备配置已变化，已取消保存');
      return result;
    };
    const id = randomUUID(), filename = `meme_${id}.png`;
    const remoteDir = '/sdcard/Pictures/大肥鱼表情包';
    const remotePath = `${remoteDir}/${filename}`, remotePending = `${remoteDir}/.${id}.pending`;
    const remoteMetadataPath = remotePath + '.json';
    const localPath = path.join(this.shotDir, filename), metadataPath = localPath + '.json';
    const metadata = { title: name.trim(), tags: [], description: meaning, aiDescription: aiMeaning };
    let completed = false;
    try {
      fs.writeFileSync(metadataPath, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      await run(['shell', 'mkdir', '-p', remoteDir]);
      await run(['shell', 'screencap', '-p', remotePending]);
      await run(['pull', remotePending, localPath]);
      const stat = fs.lstatSync(localPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 8 || stat.size > 8 * 1024 * 1024) throw new Error('手机截图不是有效 PNG');
      const bytes = fs.readFileSync(localPath);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('手机截图不是有效 PNG');
      fs.chmodSync(localPath, 0o600);
      // Publish the image only after its corresponding description is on the phone.
      await run(['push', metadataPath, remoteMetadataPath]);
      await run(['shell', 'mv', remotePending, remotePath]);
      await run(['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
        '-d', `file://${remotePath}`]).catch(() => { this.#assertActive(signal); if (this.device !== device) throw new Error('手机设备配置已变化，已取消保存'); });
      this.#assertActive(signal);
      completed = true;
      return { ok: true, path: localPath, filename, remotePath, metadataPath, remoteMetadataPath,
        description: meaning, aiDescription: aiMeaning, message: '表情截图与具体描写已一同保存至手机相册。' };
    } finally {
      if (!completed) {
        fs.rmSync(localPath, { force: true });
        fs.rmSync(metadataPath, { force: true });
        // Cancellation/offline state takes precedence over best-effort cleanup.
        if (!signal?.aborted && this.enabled && this.device === device) await run(['shell', 'rm', '-f', remotePending, remotePath, remoteMetadataPath]).catch(() => {});
      }
    }
  }

  /** 获取 UI 树 (uiautomator dump) */
  async getUiTree({ signal } = {}) {
    this.#assertActive(signal);
    const remoteXml = `/sdcard/_dsh_dump_${Date.now()}.xml`;
    const localXml = path.join(this.shotDir, `ui_${Date.now()}.xml`);

    await this.#adb(['shell', 'uiautomator', 'dump', remoteXml], 30000, { signal });
    await this.#adb(['pull', remoteXml, localXml], 30000, { signal });
    await this.#adb(['shell', 'rm', '-f', remoteXml], 30000, { signal });

    const content = fs.readFileSync(localXml, 'utf8');
    return { ok: true, xmlPath: localXml, xml: content, length: content.length };
  }

  /**
   * 注册到 DSH / Cordis 上下文
   */
  registerToCordis(ctx) {
    const logger = ctx.logger || console;
    logger.info?.(`[phone-tools] 正在注册大肥鱼真机控制工具 (${this.device})...`);

    const tools = [
      {
        name: 'phone_screenshot',
        description: '截取安卓手机当前屏幕画面，大肥鱼可用它看屏幕、刷抖音、看微信',
        parameters: { type: 'object', properties: {} },
        execute: async (_args, execution = {}) => {
          const result = await this.screenshot({ signal: execution.signal });
          this.#assertActive(execution.signal);
          const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : ctx.attachments;
          if (typeof attachments?.saveImage !== 'function') return { ...result, note: '仅已保存截图路径，未将图片注入模型上下文' };
          const image = await attachments.saveImage({ data: fs.readFileSync(result.path), mediaType: 'image/png', name: result.filename });
          this.#assertActive(execution.signal);
          return { ...result, image };
        },
      },
      {
        name: 'phone_tap',
        description: '在安卓手机屏幕指定坐标 (x, y) 处执行物理点击',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: '横坐标' },
            y: { type: 'number', description: '纵坐标' },
          },
          required: ['x', 'y'],
        },
        execute: async ({ x, y }) => this.tap(x, y),
      },
      {
        name: 'phone_swipe',
        description: '在安卓手机屏幕上从 (x1, y1) 滑动到 (x2, y2)，如上滑刷视频',
        parameters: {
          type: 'object',
          properties: {
            x1: { type: 'number' },
            y1: { type: 'number' },
            x2: { type: 'number' },
            y2: { type: 'number' },
            durationMs: { type: 'number', default: 300 },
          },
          required: ['x1', 'y1', 'x2', 'y2'],
        },
        execute: async (p) => this.swipe(p.x1, p.y1, p.x2, p.y2, p.durationMs),
      },
      {
        name: 'phone_listen',
        description: this.transcribeAudio ? '录制手机当前播放的声音并返回实际语音识别文字' : '录制手机当前播放的声音并返回音频路径；当前尚未配置 STT',
        parameters: {
          type: 'object',
          properties: {
            seconds: { type: 'integer', minimum: 1, maximum: this.maxListenSeconds, default: Math.min(3, this.maxListenSeconds), description: '收听时长（秒）' },
          },
        },
        execute: async ({ seconds = Math.min(3, this.maxListenSeconds) } = {}, execution = {}) => this.listen(seconds, { signal: execution.signal }),
      },
      {
        name: 'phone_steal_meme',
        description: '截取表情并连同具体含义和适用场景一同保存至手机相册；名称不能代替描写',
        parameters: { type: 'object', properties: {
          name: { type: 'string', maxLength: 160 },
          description: { type: 'string', minLength: 1, maxLength: 1200, description: '画面内容、具体意思与适用场景；必须根据实际图片填写' },
          aiDescription: { type: 'string', maxLength: 1200, description: '可选的 AI 选图补充或避免使用的场景' },
        }, required: ['description'] },
        execute: async ({ name = '大肥鱼表情包', description, aiDescription } = {}, execution = {}) => this.stealMeme(name, { description, aiDescription, signal: execution.signal }),
      },
    ];

    tools.push(
      {
        name: 'phone_key', description: `按允许的安卓系统键：${[...this.allowedKeys].join('、')}`,
        parameters: { type: 'object', properties: { key: { type: 'string', enum: [...this.allowedKeys] } }, required: ['key'] },
        execute: async ({ key }, execution = {}) => this.key(key, { signal: execution.signal }),
      },
      {
        name: 'phone_type', description: '向当前输入框输入文字；中文需要 ADBKeyboard',
        parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] },
        execute: async ({ text }) => this.typeText(text),
      },
      {
        name: 'phone_get_ui_tree', description: '读取手机当前界面控件与文字',
        parameters: { type: 'object', properties: {} },
        execute: async (_args, execution = {}) => this.getUiTree({ signal: execution.signal }),
      },
    );
    if (!ctx.tools?.register) throw new Error('DSH tools 服务不可用，无法注册手机工具');
    const registeredTools = tools.filter((tool) => this.allowedTools.has(tool.name));
    for (const tool of registeredTools) {
      const execute = tool.execute;
      tool.execute = async (args = {}, execution = {}) => {
        const authorize = async () => {
          if (!this.enabled) throw new Error('手机运行时已设为离线，未执行真机操作');
          if (typeof this.getExecutionContext !== 'function') throw new Error('未配置真机工具身份校验，已取消操作');
          const context = await this.getExecutionContext(execution);
          const ownerPrivate = context?.isOwner === true && context?.scope === 'c2c';
          const trustedDesktop = this.allowDesktop && context?.scope === 'desktop' && context?.trusted === true;
          if (!ownerPrivate && !trustedDesktop) throw new Error('真机工具仅允许已绑定主人的私聊，已取消操作');
          if (execution.signal?.aborted) throw new Error('工具调用已取消');
          if (tool.name === 'phone_key') {
            const key = String(args.key || '').toLowerCase();
            const normalized = key === '4' ? 'back' : key;
            if (!this.allowedKeys.has(normalized)) throw new Error('当前只允许白名单中的手机按键');
          }
        };
        await authorize();
        return this.#withDeviceLock(async () => {
          // Authority can change while this conversation waits for the device.
          await authorize();
          try {
            const result = await execute(args, execution);
            this.#assertActive(execution.signal);
            this.lastToolResult = { name: tool.name, ok: result?.ok !== false, at: new Date().toISOString() };
            return result;
          } catch (error) {
            this.lastToolResult = { name: tool.name, ok: false, at: new Date().toISOString() };
            throw error;
          }
        }, execution.signal);
      };
      tool.output = {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value) },
          ...(value?.image ? [{ type: 'image', attachment: value.image }] : []),
        ],
      };
      const dispose = ctx.tools.register(tool);
      if (typeof dispose === 'function') this.disposers.push(dispose);
    }
    return registeredTools;
  }

  dispose() {
    this.enabled = false;
    const errors = [];
    for (const dispose of this.disposers.splice(0).reverse()) {
      try { dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '部分手机工具注销失败');
  }
}

export default PhoneTools;
