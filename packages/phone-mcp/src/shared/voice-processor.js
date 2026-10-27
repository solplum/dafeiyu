/** Voice ingestion and transcription. A real STT provider must be configured. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSttProvider } from './stt-provider.js';
export { createSttProvider, createNativeSttProvider } from './stt-provider.js';

export class VoiceProcessor {
  constructor({ tempDir = path.join(os.tmpdir(), 'dsh-dafeiyu-voice'), sttProvider, stt, providerOptions = {}, fetchImpl = fetch, maxAudioBytes = 20 * 1024 * 1024 } = {}) {
    this.tempDir = tempDir;
    if (sttProvider !== undefined && typeof sttProvider !== 'function') throw new Error('sttProvider 必须为函数，配置文件请使用 stt 对象');
    this.sttProvider = sttProvider || createSttProvider(stt, { fetchImpl, ...providerOptions });
    this.fetchImpl = fetchImpl;
    this.maxAudioBytes = maxAudioBytes;
    this.active = 0;
    this.lastResult = null;
    fs.mkdirSync(this.tempDir, { recursive: true });
  }

  hasVoice(msg) {
    if (!msg) return false;
    const text = typeof msg === 'string' ? msg : msg.text || (typeof msg.message === 'string' ? msg.message : '');
    return text.includes('[CQ:record') || text.includes('[语音]') ||
      (Array.isArray(msg.message) && msg.message.some((seg) => seg.type === 'record' || seg.type === 'audio'));
  }

  async #transcribe(audioPath, options) {
    this.active++;
    try {
    options?.signal?.throwIfAborted();
    if (typeof this.sttProvider !== 'function') throw new Error('未配置语音识别服务（STT）');
    if (!fs.existsSync(audioPath) || !fs.statSync(audioPath).isFile() || !fs.statSync(audioPath).size) {
      throw new Error('语音文件不存在或为空');
    }
    if (fs.statSync(audioPath).size > this.maxAudioBytes) throw new Error('语音文件超过大小上限');
    const text = await this.sttProvider(audioPath, options);
    options?.signal?.throwIfAborted();
    if (typeof text !== 'string' || !text.trim()) throw new Error('语音识别未返回文字');
    this.lastResult = { ok: true, at: new Date().toISOString(), note: '最近音频转写返回了实际文字' };
    return text.trim();
    } catch (error) {
      this.lastResult = { ok: false, at: new Date().toISOString(), note: '最近音频转写失败或没有文字' };
      throw error;
    } finally { this.active--; }
  }

  get status() { return { configured: typeof this.sttProvider === 'function', active: this.active,
    readiness: this.lastResult ? this.lastResult.ok ? 'ready' : 'failed' : 'not-verified', lastResult: this.lastResult }; }

  async #download(url, file, { signal } = {}) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('语音下载超时')), 30000);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`语音下载失败（HTTP ${response.status}）`);
      if (Number(response.headers?.get('content-length')) > this.maxAudioBytes) throw new Error('语音文件超过大小上限');
      const chunks = [];
      let size = 0;
      if (response.body?.[Symbol.asyncIterator]) {
        for await (const chunk of response.body) {
          controller.signal.throwIfAborted();
          size += chunk.length;
          if (size > this.maxAudioBytes) throw new Error('语音文件超过大小上限');
          chunks.push(Buffer.from(chunk));
        }
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > this.maxAudioBytes) throw new Error('语音文件超过大小上限');
        chunks.push(bytes);
      }
      controller.signal.throwIfAborted();
      fs.writeFileSync(file, Buffer.concat(chunks));
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  async processInboundVoice(rawEvent, { signal, resolveRecord } = {}) {
    let downloadedFile, transcriptionStarted = false;
    try {
      signal?.throwIfAborted();
      if (typeof this.sttProvider !== 'function') throw new Error('未配置语音识别服务（STT）');
      const rec = Array.isArray(rawEvent?.message) && rawEvent.message.find((seg) => seg.type === 'record' || seg.type === 'audio');
      let recordData = rec?.data;
      let source = recordData?.url || recordData?.file || '';
      if (!source) {
        const cq = (typeof rawEvent === 'string' ? rawEvent : rawEvent?.message || rawEvent?.text || '');
        const record = typeof cq === 'string' && cq.match(/\[CQ:record,([^\]]+)\]/);
        if (record) {
          const attrs = Object.fromEntries(record[1].split(',').map((part) => {
            const equals = part.indexOf('=');
            return [part.slice(0, equals), part.slice(equals + 1).replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&')];
          }));
          recordData = attrs;
          source = attrs.url || attrs.file || '';
        }
      }
      if (!source || typeof source !== 'string') throw new Error('无法解析语音文件');
      if (typeof resolveRecord === 'function') {
        // NapCat's paths live inside its Linux container, and QQ's SILK
        // recordings need its decoder. Never treat a container path as a Mac file.
        const bytes = await resolveRecord(recordData, { signal });
        signal?.throwIfAborted();
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > this.maxAudioBytes) throw new Error('QQ 语音转换未返回有效音频');
        downloadedFile = path.join(this.tempDir, `voice_${randomUUID()}.wav`);
        fs.writeFileSync(downloadedFile, bytes, { mode: 0o600 });
        source = downloadedFile;
      } else if (/^https?:\/\//i.test(source)) {
        downloadedFile = path.join(this.tempDir, `voice_${randomUUID()}.audio`);
        await this.#download(source, downloadedFile, { signal });
        source = downloadedFile;
      } else if (source.startsWith('file:')) {
        source = fileURLToPath(source);
      }
      transcriptionStarted = true;
      return { ok: true, text: `[语音转写]: ${await this.#transcribe(source, { signal })}` };
    } catch (error) {
      if (!transcriptionStarted) {
        const note = '最近语音读取或转换失败，未开始转写';
        this.lastResult = { ok: false, at: new Date().toISOString(), note };
        return { ok: false, text: `[语音处理失败]: ${note}` };
      }
      return { ok: false, text: `[语音处理失败]: ${error.message}` };
    } finally {
      if (downloadedFile) fs.rmSync(downloadedFile, { force: true });
    }
  }

  async transcribeFile(audioPath, options) {
    return this.#transcribe(audioPath, options);
  }

  async analyzePhoneAudio(audioPath) {
    try {
      return `【真机听力感知】${await this.#transcribe(audioPath)}`;
    } catch (error) {
      return `真机听音处理失败：${error.message}`;
    }
  }
}

export default VoiceProcessor;
