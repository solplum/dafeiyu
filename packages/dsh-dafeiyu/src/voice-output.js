/** Bounded TTS for the verified owner's current OneBot conversation. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateToolArguments } from '../../companion/src/tool-loop.js';
import { buildVoiceCatalog, voiceSettings } from './voice-catalog.js';

const exec = promisify(execFile);
const MAX_AUDIO = 5 * 1024 * 1024;
const abortable = async (task, signal) => {
  signal.throwIfAborted(); let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(new Error('语音合成已取消')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([task, cancelled]); } finally { signal.removeEventListener('abort', abort); }
};
const mp3 = (data) => {
  if (data.length < 64) return false;
  let at = 0;
  if (data.subarray(0, 3).toString() === 'ID3') {
    if (data.length < 10 || data.subarray(6, 10).some((byte) => byte & 128)) return false;
    at = 10 + ((data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]) + (data[5] & 16 ? 10 : 0);
  }
  let frames = 0, rate;
  while (at + 4 <= data.length && frames < 3) {
    if (data[at] !== 255 || (data[at + 1] & 0xe0) !== 0xe0) return false;
    const version = (data[at + 1] >> 3) & 3, layer = (data[at + 1] >> 1) & 3;
    const bitrateIndex = data[at + 2] >> 4, sampleIndex = (data[at + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || sampleIndex === 3) return false;
    const sampleRate = [44100, 48000, 32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex] * 1000;
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((data[at + 2] >> 1) & 1);
    if (length < 4 || at + length > data.length || rate && sampleRate !== rate) return false;
    rate = sampleRate; at += length; frames++;
  }
  return frames >= 2;
};
export const voiceBinary = (name) => {
  const directories = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...(process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute)];
  return directories.map((directory) => path.join(directory, name)).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  }) || '';
};
export class VoiceOutput {
  constructor({ config = {}, fetchImpl = globalThis.fetch, execFileImpl = exec, platform = process.platform,
    binaries = {}, timeoutMs = 120000 } = {}) {
    this.enabled = config.voiceReplyEnabled === true;
    this.provider = config.ttsProvider || 'openai-compatible';
    this.baseURL = config.ttsBaseURL || 'https://api.openai.com/v1';
    this.model = config.ttsModel || 'tts-1'; this.voice = config.ttsVoice || 'alloy';
    this.language = config.ttsLanguage || ''; this.autoVoice = config.ttsAutoVoice === true;
    const catalog = buildVoiceCatalog({ ...config, ttsVoice: this.voice });
    this.voices = catalog.voices; this.defaultVoiceId = catalog.defaultVoiceId;
    this.configurationFingerprint = JSON.stringify(voiceSettings(config));
    this.key = config.ttsApiKey || '';
    this.fetchImpl = fetchImpl; this.exec = execFileImpl; this.platform = platform; this.timeoutMs = timeoutMs;
    this.say = binaries.say ?? (platform === 'darwin' && fs.existsSync('/usr/bin/say') ? '/usr/bin/say' : '');
    this.ffmpeg = binaries.ffmpeg ?? voiceBinary('ffmpeg'); this.ffprobe = binaries.ffprobe ?? voiceBinary('ffprobe');
    this.closed = false; this.controllers = new Set(); this.lastResult = null; this.active = 0;
  }
  get configured() {
    if (this.provider === 'macos') return this.platform === 'darwin' && Boolean(this.say && this.ffmpeg && this.ffprobe);
    if (this.provider !== 'openai-compatible' || !this.model || !this.voice) return false;
    try {
      const url = new URL(this.baseURL), local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      return (url.protocol === 'https:' || url.protocol === 'http:' && local) && !url.username && !url.password && !url.search && !url.hash
        && Boolean(this.key || local);
    } catch { return false; }
  }
  get status() {
    return { supported: true, enabled: this.enabled && !this.closed, configured: this.configured,
      provider: this.provider, protocol: this.provider === 'macos' ? 'macos-say' : 'openai-audio', active: this.active,
      defaultVoiceId: this.defaultVoiceId, autoVoice: this.autoVoice,
      readiness: this.lastResult?.ok ? (this.lastResult.delivered ? 'ready' : 'synthesis-verified')
        : this.lastResult ? 'failed' : 'not-verified', lastResult: this.lastResult,
      local: { sayInstalled: Boolean(this.say), ffmpegInstalled: Boolean(this.ffmpeg), ffprobeInstalled: Boolean(this.ffprobe) } };
  }
  selectVoice(voiceId, { automatic = false } = {}) {
    const id = voiceId === undefined || voiceId === '' ? this.defaultVoiceId : voiceId;
    const selected = this.voices.find((item) => item.id === id);
    if (!selected) throw new Error('请选择目录中的有效音色');
    if (automatic && !this.autoVoice && id !== this.defaultVoiceId) throw new Error('自动选择音色未开启，请使用默认声音');
    return selected;
  }
  matchesConfig(config) { return this.configurationFingerprint === JSON.stringify(voiceSettings(config)); }
  async synthesize(text, { signal, voiceId, automatic = false } = {}) {
    if (this.closed || signal?.aborted) throw new Error('语音合成已停止');
    if (typeof text !== 'string' || !text.trim() || text.length > 300) throw new Error('语音正文须为 1–300 字符');
    if (!this.configured) throw new Error('语音合成服务或本机依赖未配置完整');
    const selectedVoice = this.selectVoice(voiceId, { automatic });
    const controller = new AbortController(); this.controllers.add(controller);
    this.active++;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    let directory;
    try {
      let bytes;
      if (this.provider === 'macos') {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-tts-')); fs.chmodSync(directory, 0o700);
        const input = path.join(directory, 'input.txt'), aiff = path.join(directory, 'speech.aiff'), output = path.join(directory, 'speech.mp3');
        fs.writeFileSync(input, text, { mode: 0o600 });
        const options = { signal: controller.signal, timeout: this.timeoutMs, maxBuffer: 65536, windowsHide: true };
        await abortable(this.exec(this.say, [...(selectedVoice.voice ? ['-v', selectedVoice.voice] : []), '-f', input, '-o', aiff], options), controller.signal);
        const probe = await abortable(this.exec(this.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', aiff], options), controller.signal);
        const duration = Number(JSON.parse(String(probe.stdout)).format?.duration);
        if (!Number.isFinite(duration) || duration <= 0 || duration > 90) throw new Error();
        await abortable(this.exec(this.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', aiff, '-vn', '-ac', '1', '-ar', '24000', '-codec:a', 'libmp3lame', output], options), controller.signal);
        if (fs.statSync(output).size > MAX_AUDIO) throw new Error();
        bytes = fs.readFileSync(output);
      } else {
        const response = await abortable(this.fetchImpl(this.baseURL.replace(/\/+$/, '') + '/audio/speech', {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) },
          body: JSON.stringify({ model: this.model, input: text.trim(), voice: selectedVoice.voice, response_format: 'mp3',
            ...(this.language ? { lang_code: this.language } : {}) }),
        }), controller.signal);
        if (!response.ok || Number(response.headers?.get('content-length')) > MAX_AUDIO || !response.body?.[Symbol.asyncIterator]) throw new Error();
        const chunks = []; let size = 0;
        const iterator = response.body[Symbol.asyncIterator]();
        while (true) {
          const next = await abortable(iterator.next(), controller.signal);
          if (next.done) break;
          const chunk = next.value;
          controller.signal.throwIfAborted(); size += chunk.length;
          if (size > MAX_AUDIO) throw new Error();
          chunks.push(Buffer.from(chunk));
        }
        bytes = Buffer.concat(chunks);
      }
      controller.signal.throwIfAborted();
      if (this.closed || !mp3(bytes)) throw new Error();
      this.lastResult = { ok: true, generated: true, delivered: false, voiceId: selectedVoice.id, at: new Date().toISOString(), note: '合成成功，QQ 送达尚未验证' };
      return bytes;
    } catch {
      this.lastResult = { ok: false, at: new Date().toISOString(), note: '语音合成未完成，请检查配置、音频格式与依赖' };
      throw new Error(this.lastResult.note);
    } finally {
      controller.abort();
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.controllers.delete(controller);
      this.active--;
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  dispose() { this.closed = true; this.key = ''; for (const controller of this.controllers) controller.abort(); }
}

export function registerVoiceOutputTool(ctx, { voiceOutput, qqGateway, getExecutionContext }) {
  if (!voiceOutput.enabled) return () => {};
  let closed = false; const uncertain = new Set(), inFlight = new Set();
  const catalog = (voiceOutput.voices || []).map(({ voice: _voice, ...item }) => item);
  const parameters = { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 300 },
    voiceId: { type: 'string', minLength: 1, maxLength: 80, ...(catalog.length ? { enum: catalog.map((item) => item.id) } : {}),
      description: '可选，来自dafeiyu_voice_list的音色ID。省略使用默认声音；关闭自动选声时仅能使用默认音色。' } }, required: ['text'], additionalProperties: false };
  const listStop = ctx.tools.register({ name: 'dafeiyu_voice_list',
    description: '读取已启用的语音音色目录及默认声音，不合成、不播放、不发送，也不修改任何配置。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: (_args, execution) => {
      validateToolArguments(_args, { type: 'object', properties: {}, additionalProperties: false });
      const identity = getExecutionContext(execution);
      if (closed || execution?.signal?.aborted || voiceOutput.closed || !voiceOutput.enabled || !identity?.isOwner) throw new Error('仅已核验的主要使用者可读取音色目录');
      return { ok: true, defaultVoiceId: voiceOutput.defaultVoiceId || '', autoVoice: voiceOutput.autoVoice === true, voices: catalog };
    }, output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] } });
  const stop = ctx.tools.register({ name: 'dafeiyu_voice_send',
    description: '主人明确要语音时，将最多300字符合成为AI语音并发送到当前已验证的个人QQ私聊；以回执为准，不重试未知送达。', parameters,
    execute: async (args, execution) => {
      validateToolArguments(args, parameters);
      const current = () => {
        const identity = getExecutionContext(execution);
        if (closed || execution?.signal?.aborted || voiceOutput.closed || !voiceOutput.enabled || !identity?.isOwner
          || identity.channel !== 'onebot' || identity.scope !== 'c2c' || !qqGateway.connected || qqGateway.online !== true
          || qqGateway.loginVerified !== true || qqGateway.identityConflict || String(qqGateway.selfId) !== identity.selfId) throw new Error('仅在线且已验证的主人个人 QQ 私聊可发送语音');
        if (uncertain.has(identity.sessionId)) throw new Error('此前语音送达结果未知，需先核实，禁止自动重发');
        return identity;
      };
      const identity = { ...current() };
      if (inFlight.has(identity.sessionId)) throw new Error('本会话有语音正在处理，请等待实际结果后再发送');
      if (args.voiceId !== undefined) voiceOutput.selectVoice?.(args.voiceId, { automatic: true });
      inFlight.add(identity.sessionId);
      let dispatched = false;
      try {
        const bytes = await voiceOutput.synthesize(args.text, { signal: execution?.signal, voiceId: args.voiceId, automatic: true });
        const latest = current();
        if (latest.selfId !== identity.selfId || latest.peerId !== identity.peerId || latest.sessionId !== identity.sessionId) throw new Error('语音目标已变化，未发送');
        dispatched = true;
        const result = await qqGateway.sendRecord(`private:${identity.peerId}`, bytes, { selfId: identity.selfId });
        if (result?.uncertain || result?.ok !== true && result?.ok !== false) uncertain.add(identity.sessionId);
        const cancelled = closed || execution?.signal?.aborted || voiceOutput.closed;
        voiceOutput.lastResult = { ok: result?.ok === true, delivered: result?.ok === true,
          ...(args.voiceId || voiceOutput.defaultVoiceId ? { voiceId: args.voiceId || voiceOutput.defaultVoiceId } : {}), at: new Date().toISOString(),
          note: result?.ok === true ? 'QQ 已确认语音消息回执' : '语音发送未确认，请核实原会话' };
        return { ok: result?.ok === true && !cancelled, delivered: result?.ok === true, ...(cancelled ? { cancelled: true } : {}),
          ...(result?.data?.message_id != null ? { messageId: String(result.data.message_id) } : {}),
          ...(result?.uncertain ? { uncertain: true } : {}), ...(result?.ok === true ? {} : { error: voiceOutput.lastResult.note }) };
      } catch {
        if (dispatched) uncertain.add(identity.sessionId);
        return { ok: false, ...(dispatched ? { uncertain: true } : {}), error: dispatched ? '语音送达结果未知，禁止自动重试' : '语音合成或授权检查未通过，未发送' };
      } finally { inFlight.delete(identity.sessionId); }
    }, output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] } });
  return () => { closed = true; listStop?.(); stop?.(); };
}
