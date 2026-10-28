/** Explicit owner audio test; never enters the chat queue or sends a message. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStoreError } from './config-store.js';

export const MAX_SPEECH_TEST_BYTES = 5 * 1024 * 1024;
export const MAX_SPEECH_TEST_BODY = 4 * Math.ceil(MAX_SPEECH_TEST_BYTES / 3) + 8192;
const extensions = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.opus', '.flac', '.webm', '.mp4', '.amr', '.silk']);
export async function testSpeechAudio(body, { voiceProcessor, authorize = () => false, busy = false } = {}) {
  const verifyOwner = () => { if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '语音测试权限已失效'); };
  verifyOwner();
  if (busy) throw new ConfigStoreError('BUSY', '当前有任务，请稍后测试识别');
  if (typeof voiceProcessor?.sttProvider !== 'function') throw new ConfigStoreError('UNAVAILABLE', '请先准备语音识别服务');
  const audio = body?.audio;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['audio', 'fileName'].includes(key))
    || !audio || typeof audio !== 'object' || Array.isArray(audio) || Object.keys(audio).some((key) => !['mime', 'base64'].includes(key))
    || typeof audio.base64 !== 'string' || audio.base64.length > 4 * Math.ceil(MAX_SPEECH_TEST_BYTES / 3)
    || audio.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.base64)
    || audio.mime !== undefined && (typeof audio.mime !== 'string' || audio.mime.length > 100
      || !/^(audio\/[a-z0-9.+-]+|video\/(mp4|webm)|application\/octet-stream)$/i.test(audio.mime))
    || body.fileName !== undefined && (typeof body.fileName !== 'string' || body.fileName.length > 255)) {
    throw new ConfigStoreError('INVALID_PATCH', '请选择有效音频，文件最大 5 MiB');
  }
  const bytes = Buffer.from(audio.base64, 'base64');
  if (!bytes.length || bytes.length > MAX_SPEECH_TEST_BYTES || bytes.toString('base64') !== audio.base64) {
    throw new ConfigStoreError('INVALID_PATCH', '请选择有效音频，文件最大 5 MiB');
  }
  let directory;
  try {
    verifyOwner();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-speech-test-')); fs.chmodSync(directory, 0o700);
    const extension = path.extname(body.fileName || '').toLowerCase();
    const file = path.join(directory, 'input' + (extensions.has(extension) ? extension : '.audio'));
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const text = await voiceProcessor.transcribeFile(file);
    verifyOwner();
    if (typeof text !== 'string' || !text.trim() || text.length > 32768) throw new Error('No bounded transcript');
    return { ok: true, text: text.trim(), source: 'uploaded-audio', sentToQQ: false,
      note: '识别完成，音频未作为聊天消息处理' };
  } catch (error) {
    if (error instanceof ConfigStoreError) throw error;
    verifyOwner();
    return { ok: false, source: 'uploaded-audio', sentToQQ: false, note: '识别未完成，请检查音频内容和识别服务。' };
  } finally { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
}
