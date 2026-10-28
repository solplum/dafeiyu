/** Serializable STT adapters. Creating a provider performs no process or network calls. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const AUDIO_TYPES = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm', '.flac': 'audio/flac',
};

function positiveInteger(value, fallback, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error(`${name} 配置无效`);
  return result;
}

function commandConfig(config) {
  if (typeof config.command !== 'string' || !config.command.trim()) throw new Error('STT command 不能为空');
  if (!Array.isArray(config.args) || !config.args.every((arg) => typeof arg === 'string') || !config.args.some((arg) => arg.includes('{audio}'))) {
    throw new Error('STT args 必须为字符串数组，且包含 {audio} 占位符');
  }
}

function httpConfig(config) {
  let url;
  try { url = new URL(config.endpoint); } catch { throw new Error('STT endpoint 必须为完整 HTTP 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('STT endpoint 协议或身份信息无效');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程 STT endpoint 必须使用 HTTPS');
  if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('HTTP STT 必须配置 model');
  if (config.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) throw new Error('STT apiKeyEnv 名称无效');
}

function abortScope(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('STT 执行超时')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
  };
}

/**
 * config.type = 'command': command + args (literal argv with {audio}); stdout is transcription.
 * config.type = 'http': endpoint accepts multipart file/model and returns JSON { text }.
 * Optional convertToWav uses configured/local ffmpeg, never downloads an engine or model.
 */
export function createSttProvider(config, {
  runCommand = execFileAsync, fetchImpl = globalThis.fetch, env = process.env,
  baseDir = process.cwd(), tempDir = path.join(os.tmpdir(), 'dsh-stt'),
} = {}) {
  if (config === undefined || config === null || config === false) return undefined;
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('STT 配置必须为对象');
  if (config.type === 'command') commandConfig(config);
  else if (config.type === 'http') httpConfig(config);
  else throw new Error('STT type 仅支持 command 或 http');
  const timeoutMs = positiveInteger(config.timeoutMs, 120000, 600000, 'STT timeoutMs');
  const maxAudioBytes = positiveInteger(config.maxAudioBytes, 20 * 1024 * 1024, 100 * 1024 * 1024, 'STT maxAudioBytes');
  if (config.convertToWav !== undefined && typeof config.convertToWav !== 'boolean') throw new Error('STT convertToWav 必须为布尔值');
  if (config.ffmpegPath !== undefined && (typeof config.ffmpegPath !== 'string' || !config.ffmpegPath.trim())) throw new Error('STT ffmpegPath 无效');
  const cwd = path.resolve(baseDir, config.cwd || '.');

  return async function transcribe(audioPath, { signal } = {}) {
    if (typeof audioPath !== 'string' || !fs.existsSync(audioPath) || !fs.statSync(audioPath).isFile()) throw new Error('STT 输入音频不存在');
    const size = fs.statSync(audioPath).size;
    if (!size || size > maxAudioBytes) throw new Error('STT 输入音频为空或超过大小上限');
    const scope = abortScope(signal, timeoutMs);
    let conversionDir;
    try {
      scope.signal.throwIfAborted();
      let input = path.resolve(audioPath);
      if (config.convertToWav) {
        fs.mkdirSync(tempDir, { recursive: true });
        conversionDir = fs.mkdtempSync(path.join(tempDir, 'convert-'));
        const wav = path.join(conversionDir, 'audio.wav');
        try {
          await runCommand(config.ffmpegPath || 'ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav,
          ], { cwd, timeout: timeoutMs, signal: scope.signal, maxBuffer: 1024 * 1024, windowsHide: true });
        } catch { throw new Error('STT 音频解码失败；请确认本机 ffmpeg 及输入格式可用（QQ SILK 可能需要独立解码器）'); }
        if (!fs.existsSync(wav) || !fs.statSync(wav).size || fs.statSync(wav).size > maxAudioBytes) throw new Error('STT 音频转换未生成有效文件或超过大小上限');
        input = wav;
      }
      let text;
      if (config.type === 'command') {
        try {
          const result = await runCommand(config.command, config.args.map((arg) => arg.replaceAll('{audio}', input)), {
            cwd, timeout: timeoutMs, signal: scope.signal, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
          });
          text = String(result.stdout || '').trim();
        } catch { throw new Error('本地 STT 命令执行失败；请检查引擎、模型路径和超时配置'); }
      } else {
        const headers = {};
        if (config.apiKeyEnv) {
          const apiKey = env[config.apiKeyEnv];
          if (!apiKey) throw new Error(`未设置 STT 凭据环境变量 ${config.apiKeyEnv}`);
          headers.Authorization = `Bearer ${apiKey}`;
        }
        const form = new FormData();
        const extension = path.extname(input).toLowerCase();
        form.append('file', new Blob([fs.readFileSync(input)], { type: AUDIO_TYPES[extension] || 'application/octet-stream' }), `audio${AUDIO_TYPES[extension] ? extension : '.audio'}`);
        form.append('model', config.model);
        form.append('response_format', 'json');
        if (config.language) form.append('language', String(config.language));
        const response = await fetchImpl(config.endpoint, { method: 'POST', headers, body: form, signal: scope.signal });
        if (!response.ok) throw new Error(`HTTP STT 返回 HTTP ${response.status}`);
        const result = await response.json().catch(() => { throw new Error('HTTP STT 返回无效 JSON'); });
        text = result?.text;
      }
      if (typeof text !== 'string' || !text.trim()) throw new Error('STT 未返回识别文字');
      return text.trim();
    } finally {
      scope.dispose();
      if (conversionDir) fs.rmSync(conversionDir, { recursive: true, force: true });
    }
  };
}

/** Wrap decoded PCM into the exact 44-byte WAV header required by DSH's native service. */
function canonicalWave(pcm) {
  if (!pcm.length || pcm.length % 2) throw new Error('音频解码没有生成完整的 PCM16 采样');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Reuse the host's selected speech service. Never prepares/downloads/reconfigures providers. */
export function createNativeSttProvider(service, {
  runCommand = execFileAsync, ffmpegPath = 'ffmpeg', cwd = process.cwd(),
  tempDir = path.join(os.tmpdir(), 'dsh-native-stt'), timeoutMs = 120000,
  maxAudioBytes = 20 * 1024 * 1024, maxDurationSeconds = 120, providerId, language,
} = {}) {
  if (typeof service?.resolve !== 'function' || typeof service?.transcribe !== 'function') throw new Error('DSH 原生语音识别服务不可用');
  positiveInteger(timeoutMs, 120000, 600000, 'STT timeoutMs');
  positiveInteger(maxAudioBytes, 20 * 1024 * 1024, 100 * 1024 * 1024, 'STT maxAudioBytes');
  positiveInteger(maxDurationSeconds, 120, 600, 'STT maxDurationSeconds');
  if (typeof ffmpegPath !== 'string' || !ffmpegPath) throw new Error('STT ffmpegPath 无效');
  return async (audioPath, { signal } = {}) => {
    if (typeof audioPath !== 'string' || !fs.existsSync(audioPath) || !fs.statSync(audioPath).isFile()) throw new Error('STT 输入音频不存在');
    const inputBytes = fs.statSync(audioPath).size;
    if (!inputBytes || inputBytes > maxAudioBytes) throw new Error('STT 输入音频为空或超过大小上限');
    const scope = abortScope(signal, timeoutMs);
    let directory;
    try {
      scope.signal.throwIfAborted();
      fs.mkdirSync(tempDir, { recursive: true });
      directory = fs.mkdtempSync(path.join(tempDir, 'decode-'));
      const pcmPath = path.join(directory, 'audio.pcm');
      try {
        await runCommand(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.resolve(audioPath),
          '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-t', String(maxDurationSeconds + 1), '-f', 's16le', pcmPath],
        { cwd, timeout: timeoutMs, signal: scope.signal, maxBuffer: 1024 * 1024, windowsHide: true });
      } catch { throw new Error('原生 STT 音频解码失败；请检查 ffmpeg 及输入格式（QQ SILK 可能需要独立解码器）'); }
      if (!fs.existsSync(pcmPath)) throw new Error('原生 STT 解码未生成音频');
      const pcmBytes = fs.statSync(pcmPath).size;
      if (pcmBytes + 44 > maxAudioBytes || pcmBytes / 32000 > maxDurationSeconds) throw new Error('原生 STT 音频超过大小或时长上限');
      const audio = canonicalWave(fs.readFileSync(pcmPath));
      const spec = service.resolve({ audio, ...(providerId ? { providerId } : {}), ...(language ? { language } : {}) });
      const result = await service.transcribe(spec, scope.signal);
      scope.signal.throwIfAborted();
      if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('DSH 原生 STT 未返回识别文字');
      return result.text.trim();
    } finally {
      scope.dispose();
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}
