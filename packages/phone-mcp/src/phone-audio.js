import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceProcessor } from './shared/voice-processor.js';

// Only explicitly named STT configuration is read. No account/model config discovery.
export function readPhoneSttConfig(env = process.env) {
  if (env.PHONE_STT_CONFIG && env.PHONE_STT_CONFIG_FILE) throw new Error('PHONE_STT_CONFIG 与 PHONE_STT_CONFIG_FILE 只能设置一个');
  if (env.PHONE_STT_CONFIG) return JSON.parse(env.PHONE_STT_CONFIG);
  if (env.PHONE_STT_CONFIG_FILE) {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(env.PHONE_STT_CONFIG_FILE), 'utf8'));
    if (!Object.hasOwn(parsed, 'stt')) throw new Error('显式 STT 配置文件必须包含 stt 对象');
    return parsed.stt;
  }
  return undefined;
}

export async function transcribeCapturedAudio(audioPath, {
  hasAudio = true, env = process.env, sttProvider, providerOptions = {}, signal,
  tempDir = path.join(os.tmpdir(), 'phone-mcp-stt'),
} = {}) {
  if (signal?.aborted) return { status: 'cancelled', error: '语音识别已取消' };
  if (!hasAudio) return { status: 'unavailable', error: '本次仅采集画面，没有可识别音轨' };
  try {
    const stt = readPhoneSttConfig(env);
    if (!sttProvider && (stt === undefined || stt === null || stt === false)) return { status: 'not-configured', error: '录音已保存；未显式配置 STT，尚未识别声音内容' };
    const voice = new VoiceProcessor({ tempDir, stt, sttProvider, providerOptions: { env, ...providerOptions } });
    const text = await voice.transcribeFile(audioPath, { signal });
    signal?.throwIfAborted();
    return { status: 'succeeded', text };
  } catch (error) {
    return { status: signal?.aborted ? 'cancelled' : 'failed', error: error.message };
  }
}

export function audioStatusText(result) {
  return result.status === 'succeeded' ? `语音识别成功：${result.text}` : `语音识别状态 ${result.status}：${result.error}`;
}
