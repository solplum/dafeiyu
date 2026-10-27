import { ConfigStoreError } from './config-store.js';
import { publicVoiceCatalog } from './voice-catalog.js';
const FIELDS = ['voiceReplyEnabled', 'ttsProvider', 'ttsProtocol', 'ttsBaseURL', 'ttsModel', 'ttsVoice', 'ttsAutoVoice', 'ttsLanguage', 'ttsVoiceProfiles'];
export class VoicePanel {
  constructor({ store, getRuntime, getBusy }) { Object.assign(this, { store, getRuntime, getBusy }); this.testing = false; this.savedOutput = null; this.pending = false; }
  snapshot() {
    const state = this.store.snapshot(), output = this.getRuntime()?.voiceOutput;
    return { config: { revision: state.revision, saved: Object.fromEntries(FIELDS.map((key) => [key, state.saved[key] ?? state.effective[key]])),
      effective: Object.fromEntries(FIELDS.map((key) => [key, state.effective[key]])), overriddenFields: state.overriddenFields.filter((key) => FIELDS.includes(key) || key === 'ttsApiKey'),
      secretConfigured: { ttsApiKey: state.secretConfigured.saved.ttsApiKey === true } },
      ...publicVoiceCatalog(state.effective),
      pendingReload: Boolean(state.requiresReload || this.pending && this.savedOutput === output
        || typeof output?.matchesConfig === 'function' && !output.matchesConfig(state.effective)),
      runtime: output?.status || { enabled: false, configured: false, provider: '', readiness: 'not-verified', lastResult: null } };
  }
  save(body) {
    if (this.getBusy?.() || this.testing) throw new ConfigStoreError('BUSY', '当前有任务，请稍后保存语音配置');
    if (!body || Object.keys(body).some((key) => !['patch', 'revision', 'clearSecrets'].includes(key))
      || !body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)
      || Object.keys(body.patch).some((key) => ![...FIELDS, 'ttsApiKey'].includes(key))
      || body.clearSecrets !== undefined && (!Array.isArray(body.clearSecrets) || body.clearSecrets.some((key) => key !== 'ttsApiKey'))) throw new ConfigStoreError('INVALID_PATCH', '语音配置字段无效');
    const saved = this.store.save(body.patch, { revision: body.revision, clearSecrets: body.clearSecrets });
    if (saved.requiresReload) { this.pending = true; this.savedOutput = this.getRuntime()?.voiceOutput; }
    const snapshot = this.snapshot();
    return { ...snapshot, pendingReload: snapshot.pendingReload || saved.requiresReload === true, backupCreated: saved.backupCreated === true };
  }
  async test(body = {}, { authorize = () => false } = {}) {
    // Existing voice/check passes authorization as its first argument.
    if (typeof body.authorize === 'function' && Object.keys(body).every((key) => ['authorize'].includes(key))) { authorize = body.authorize; body = {}; }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['voiceId', 'text'].includes(key))
      || body.voiceId !== undefined && (typeof body.voiceId !== 'string' || !body.voiceId || body.voiceId.length > 80)
      || body.text !== undefined && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 300)) throw new ConfigStoreError('INVALID_PATCH', '试听请求格式无效');
    if (this.getBusy?.() || this.testing) throw new ConfigStoreError('BUSY', '当前有任务，请稍后试听语音');
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '主人权限已失效');
    const output = this.getRuntime()?.voiceOutput;
    if (!output?.configured) throw new ConfigStoreError('UNAVAILABLE', '请先保存并生效完整语音配置');
    if (this.snapshot().pendingReload) throw new ConfigStoreError('CONFLICT', '声音设置尚未生效，请先保存并生效');
    let selected;
    try { selected = output.selectVoice?.(body.voiceId, { automatic: false }); }
    catch { throw new ConfigStoreError('INVALID_PATCH', '请选择运行中的有效音色'); }
    this.testing = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
    try {
      const bytes = await output.synthesize(body.text || '你好，我是大肥鱼。这是我的中文声音试听。', { signal: controller.signal, voiceId: body.voiceId });
      if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '主人权限已失效');
      if (this.getRuntime()?.voiceOutput !== output) throw new ConfigStoreError('CONFLICT', '声音服务已变化，请检查当前状态');
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error();
      return { ok: true, generated: true, delivered: false, bytes: bytes.length, voiceId: selected?.id || output.defaultVoiceId || '',
        audio: { mime: 'audio/mpeg', base64: bytes.toString('base64') }, note: '试听音频已生成，未发送 QQ；请播放后确认音色' };
    } catch (error) {
      if (error instanceof ConfigStoreError) throw error;
      return { ok: false, generated: false, delivered: false, note: '合成试听未完成，请检查服务配置与依赖' };
    } finally { clearTimeout(timer); this.testing = false; }
  }
}
