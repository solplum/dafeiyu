/** Private configuration storage only. No reload, service, process or network calls. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeQQAccounts, validateQQAccounts } from './account-identities.js';
import { validateVoiceProfiles } from './voice-catalog.js';

const PHONE_TOOLS = Object.freeze(['phone_screenshot', 'phone_get_ui_tree', 'phone_key', 'phone_listen']);
const PHONE_KEYS = Object.freeze(['back']);
const SECRETS = Object.freeze(['onebotAccessToken', 'ttsApiKey']);
const DEFAULTS = Object.freeze({
  autoStartOneBot: false, onebotEngine: 'native', ownerQq: '', onebotSelfId: '', onebotWs: '', onebotHttp: '',
  phoneEnabled: false, autoConnectPhone: false, phoneDevice: '', allowedPhoneTools: PHONE_TOOLS,
  allowedPhoneKeys: PHONE_KEYS, maxListenSeconds: 3, voiceTranscription: false,
  allowMemoryWrites: false, allowMemeSync: false, catchUpUnread: false,
  backgroundTasksEnabled: true, externalTaskRouting: true,
  voiceReplyEnabled: false, ttsProvider: 'openai-compatible', ttsProtocol: 'openai-audio',
  ttsBaseURL: 'https://api.openai.com/v1', ttsModel: 'tts-1', ttsVoice: 'alloy',
  ttsAutoVoice: false, ttsLanguage: '', ttsVoiceProfiles: Object.freeze([]),
  biliEnabled: false, biliPythonPath: '', biliScriptPath: '', biliStateDir: '', biliScriptSha256: '', douyinEnabled: false,
});
const FIELDS = new Set([...Object.keys(DEFAULTS), ...SECRETS, 'qqAccounts']);
const BOOLEANS = new Set(['autoStartOneBot', 'phoneEnabled', 'autoConnectPhone', 'voiceTranscription',
  'allowMemoryWrites', 'allowMemeSync', 'catchUpUnread', 'voiceReplyEnabled', 'backgroundTasksEnabled', 'externalTaskRouting', 'ttsAutoVoice', 'biliEnabled', 'douyinEnabled']);
const MAX_BYTES = 1024 * 1024;
const own = (object, key) => Object.hasOwn(object, key);
const clone = (value) => JSON.parse(JSON.stringify(value));
const revisionOf = (bytes) => createHash('sha256').update(bytes === null ? 'missing\0' : 'present\0').update(bytes || '').digest('hex');
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export class ConfigStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConfigStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

function safeObject(value, message, code = 'INVALID_PATCH') {
  if (!plainObject(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
    || !own(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new ConfigStoreError(code, message);
}

function selected(config) {
  return Object.fromEntries([...FIELDS].filter((key) => own(config, key)).map((key) => [key, config[key]]));
}

function validate(config, { relationships = true } = {}) {
  const errors = validateQQAccounts(config, { relationships });
  const invalid = (field, message, code = 'INVALID_VALUE') => errors.push({ field, code, message });
  for (const [field, value] of Object.entries(selected(config))) {
    if (BOOLEANS.has(field)) {
      if (typeof value !== 'boolean') invalid(field, '必须为布尔值');
    } else if (['ownerQq', 'onebotSelfId'].includes(field)) {
      if (typeof value !== 'string' || (value !== '' && !/^[1-9]\d{0,19}$/.test(value))) invalid(field, '必须为数字组成的 QQ 字符串');
    } else if (field === 'onebotEngine') {
      if (!['native', 'legacy'].includes(value)) invalid(field, '仅支持 native 或 legacy');
    } else if (['onebotWs', 'onebotHttp'].includes(field)) {
      let url;
      try { url = typeof value === 'string' && value !== '' ? new URL(value) : null; } catch {}
      const protocols = field === 'onebotWs' ? ['ws:', 'wss:'] : ['http:', 'https:'];
      if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value || /[\x00-\x20\x7f]/.test(value)
        || (value !== '' && (!url || !protocols.includes(url.protocol)
          || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password
          || url.search || url.hash))) invalid(field, '仅允许无身份信息、查询参数或片段的本机回环地址');
    } else if (SECRETS.includes(field)) {
      if (typeof value !== 'string' || value.length > 8192 || /[\r\n\x00]/.test(value)) invalid(field, '令牌格式无效');
    } else if (field === 'ttsProvider') {
      if (!['openai-compatible', 'macos'].includes(value)) invalid(field, '请选择受支持的语音合成服务');
    } else if (field === 'ttsProtocol') {
      if (value !== 'openai-audio') invalid(field, '当前远程语音仅支持 OpenAI Audio 协议');
    } else if (field === 'ttsBaseURL') {
      let url; try { if (typeof value === 'string') url = new URL(value); } catch {}
      if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value) || !url
        || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        || url.username || url.password || url.search || url.hash) invalid(field, '语音 URL 仅支持 HTTPS 或本机 HTTP，不能包含身份、查询或片段');
    } else if (['ttsModel', 'ttsVoice'].includes(field)) {
      if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_.:/-]+$/.test(value)) invalid(field, '语音模型或音色标识无效');
    } else if (field === 'ttsLanguage') {
      if (typeof value !== 'string' || value.length > 32 || !/^[A-Za-z_-]*$/.test(value)) invalid(field, '语音语言标识无效');
    } else if (field === 'ttsVoiceProfiles') {
      if (!validateVoiceProfiles(value)) invalid(field, '音色目录最多32项，需包含唯一id、名称和服务音色标识');
    } else if (['biliPythonPath', 'biliScriptPath', 'biliStateDir'].includes(field)) {
      if (typeof value !== 'string' || value.length > 1024 || value !== '' && (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value))) invalid(field, 'B站受管路径须为本机绝对路径');
    } else if (field === 'biliScriptSha256') {
      if (typeof value !== 'string' || value !== '' && !/^[a-f0-9]{64}$/.test(value)) invalid(field, 'B站读取组件校验值无效');
    } else if (field === 'phoneDevice') {
      if (typeof value !== 'string' || value.length > 256 || (value !== '' && !/^[A-Za-z0-9_.:[\]-]+$/.test(value))) invalid(field, '设备序列号格式无效');
    } else if (field === 'maxListenSeconds') {
      if (!Number.isInteger(value) || value < 1 || value > 3) invalid(field, '录音时长必须为 1–3 秒的整数');
    } else if (field === 'allowedPhoneTools' || field === 'allowedPhoneKeys') {
      const allowed = field === 'allowedPhoneTools' ? PHONE_TOOLS : PHONE_KEYS;
      if (!Array.isArray(value) || value.length > allowed.length || new Set(value).size !== value.length
        || !value.every((item) => typeof item === 'string' && allowed.includes(item))) invalid(field, '超出已授权的手机白名单');
    }
  }
  if (!relationships) return errors;
  if (config.ownerQq && config.onebotSelfId && config.ownerQq === config.onebotSelfId) invalid('onebotSelfId', '接收小号必须与主人 QQ 不同');
  if (config.onebotEngine === 'native' && config.catchUpUnread === true) invalid('catchUpUnread', '原生模式不允许补回历史消息');
  if (config.autoStartOneBot === true) {
    for (const key of ['ownerQq', 'onebotSelfId', 'onebotWs']) if (!config[key]) invalid(key, '启用个人 QQ 前必须填写');
  }
  if ((config.phoneEnabled === true || config.autoConnectPhone === true) && !config.phoneDevice) invalid('phoneDevice', '启用手机前必须填写明确的设备序列号');
  if (config.voiceReplyEnabled === true && config.ttsProvider === 'openai-compatible') {
    let local = false; try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.ttsBaseURL).hostname); } catch {}
    if (!local && !config.ttsApiKey) invalid('ttsApiKey', '启用远程语音合成前必须填写密钥');
  }
  if (Array.isArray(config.ttsVoiceProfiles) && config.ttsVoiceProfiles.length && validateVoiceProfiles(config.ttsVoiceProfiles)
    && config.ttsVoice && !config.ttsVoiceProfiles.some((item) => item.id === config.ttsVoice || item.voice === config.ttsVoice)) invalid('ttsVoice', '默认声音必须来自当前音色目录');
  return errors;
}

/** Only fixed, host-owned configFile paths belong here; never accept a browser-supplied path. */
export class PrivateConfigStore {
  #configFile;
  #overrides;
  #fs;

  constructor({ configFile, overrides = {}, fsImpl = fs } = {}) {
    if (typeof configFile !== 'string' || !path.isAbsolute(configFile)) throw new ConfigStoreError('INVALID_PATH', '配置路径必须为宿主指定的绝对路径');
    safeObject(overrides, '宿主覆盖配置格式无效', 'INVALID_CONFIG');
    this.#configFile = path.resolve(configFile);
    this.#overrides = clone(selected(overrides));
    this.#fs = fsImpl;
  }

  #read() {
    try {
      const stat = this.#fs.lstatSync(this.#configFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new ConfigStoreError('INVALID_CONFIG', '配置必须是大小受限的普通文件，不能使用软链接');
      const bytes = this.#fs.readFileSync(this.#configFile);
      if (bytes.length > MAX_BYTES) throw new ConfigStoreError('INVALID_CONFIG', '配置文件超过大小上限');
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); }
      catch { throw new ConfigStoreError('INVALID_CONFIG', '配置不是有效的 JSON；未改写原文件'); }
      safeObject(data, '配置必须是 JSON 对象', 'INVALID_CONFIG');
      return { data, bytes, revision: revisionOf(bytes) };
    } catch (error) {
      if (error.code === 'ENOENT') return { data: {}, bytes: null, revision: revisionOf(null) };
      if (error instanceof ConfigStoreError) throw error;
      throw new ConfigStoreError('IO_ERROR', '无法读取私有配置；未返回文件内容');
    }
  }

  #view(state, overrides) {
    safeObject(overrides, '宿主覆盖配置格式无效', 'INVALID_CONFIG');
    const configured = selected(state.data), explicit = selected(overrides);
    const effective = { ...DEFAULTS, ...configured, ...explicit };
    const effectiveView = { ...effective, qqAccounts: normalizeQQAccounts(effective) };
    const publicOnly = (object) => {
      const badFields = new Set(validate(object, { relationships: false }).map((error) => error.field));
      return clone(Object.fromEntries(Object.entries(object).filter(([key]) => !SECRETS.includes(key))
        .map(([key, value]) => [key, badFields.has(key) ? DEFAULTS[key] : value])));
    };
    return {
      revision: state.revision,
      saved: publicOnly(configured), effective: publicOnly(effectiveView),
      secretConfigured: {
        saved: Object.fromEntries(SECRETS.map((key) => [key, typeof configured[key] === 'string' && configured[key].length > 0])),
        effective: Object.fromEntries(SECRETS.map((key) => [key, typeof effective[key] === 'string' && effective[key].length > 0])),
      },
      overriddenFields: Object.keys(explicit),
      validationErrors: validate(effective), requiresReload: false,
    };
  }

  snapshot({ overrides = this.#overrides } = {}) { return this.#view(this.#read(), overrides); }

  #prepare(state, patch, clearSecrets) {
    const next = { ...state.data };
    for (const [key, value] of Object.entries(patch)) {
      if (SECRETS.includes(key) && value === '') continue;
      next[key] = clone(value);
    }
    for (const key of clearSecrets) delete next[key];
    const localErrors = validate({ ...DEFAULTS, ...selected(next) });
    const effectiveErrors = validate({ ...DEFAULTS, ...selected(next), ...this.#overrides });
    if (localErrors.length || effectiveErrors.length) throw new ConfigStoreError('INVALID_CONFIG', '配置校验失败；未保存', { validationErrors: [...localErrors, ...effectiveErrors] });
    return next;
  }

  /** Empty secret inputs preserve existing values. Clear requires clearSecrets explicitly. */
  save(patch, { revision, clearSecrets = [] } = {}) {
    safeObject(patch, '配置修改必须是普通对象');
    if (Object.keys(patch).some((key) => !FIELDS.has(key))) throw new ConfigStoreError('INVALID_PATCH', '包含不允许编辑的配置字段');
    if (!Array.isArray(clearSecrets) || clearSecrets.some((key) => !SECRETS.includes(key))
      || new Set(clearSecrets).size !== clearSecrets.length
      || clearSecrets.some((key) => own(patch, key) && patch[key] !== '')) throw new ConfigStoreError('INVALID_PATCH', '清除密钥的请求无效');
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new ConfigStoreError('CONFLICT', '请先读取配置并携带当前版本后保存');
    // Reject bad values before cloning them or creating even a lock file.
    const patchErrors = validate(patch, { relationships: false });
    if (patchErrors.length) throw new ConfigStoreError('INVALID_PATCH', '配置字段格式无效；未保存', { validationErrors: patchErrors });
    const before = this.#read();
    if (before.revision !== revision) throw new ConfigStoreError('CONFLICT', '配置已被其他操作修改，请重新读取后再保存');
    this.#prepare(before, patch, clearSecrets);
    const directory = path.dirname(this.#configFile), lockPath = this.#configFile + '.lock';
    let lock, temporary, committed = false, backupFile;
    try {
      this.#fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { lock = this.#fs.openSync(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw new ConfigStoreError('BUSY', '另一个保存正在进行，请稍后重新读取');
        throw error;
      }
      const state = this.#read();
      if (state.revision !== revision) throw new ConfigStoreError('CONFLICT', '配置已被其他操作修改，请重新读取后再保存');
      const next = this.#prepare(state, patch, clearSecrets);
      if (JSON.stringify(next) === JSON.stringify(state.data)) return this.#view(state, this.#overrides);
      const output = Buffer.from(JSON.stringify(next, null, 2) + '\n');
      if (output.length > MAX_BYTES) throw new ConfigStoreError('INVALID_CONFIG', '配置文件超过大小上限；未保存');
      if (state.bytes !== null) {
        backupFile = this.#configFile + `.bak-${Date.now()}-${randomUUID()}`;
        this.#writeExclusive(backupFile, state.bytes);
      }
      temporary = path.join(directory, `.${path.basename(this.#configFile)}.${randomUUID()}.tmp`);
      this.#writeExclusive(temporary, output);
      // Detect external editors that do not use our lock before replacing their edits.
      if (this.#read().revision !== revision) throw new ConfigStoreError('CONFLICT', '保存前检测到外部配置修改，请重新读取');
      this.#fs.renameSync(temporary, this.#configFile);
      temporary = undefined;
      committed = true;
      const dirFd = this.#fs.openSync(directory, 'r');
      try { this.#fs.fsyncSync(dirFd); } finally { this.#fs.closeSync(dirFd); }
      return { ...this.#view({ data: next, bytes: output, revision: revisionOf(output) }, this.#overrides), requiresReload: true,
        backupCreated: Boolean(backupFile) };
    } catch (error) {
      if (committed) throw new ConfigStoreError('SAVE_UNCERTAIN', '配置已替换，但持久化确认失败；请重新读取检查', { saved: true, requiresReload: true });
      if (error instanceof ConfigStoreError) throw error;
      throw new ConfigStoreError('IO_ERROR', '配置保存失败；原配置未替换');
    } finally {
      if (temporary) try { this.#fs.unlinkSync(temporary); } catch {}
      if (lock !== undefined) {
        try { this.#fs.closeSync(lock); } catch {}
        try { this.#fs.unlinkSync(lockPath); } catch {}
      }
    }
  }

  #writeExclusive(file, bytes) {
    const fd = this.#fs.openSync(file, 'wx', 0o600);
    try { this.#fs.fchmodSync(fd, 0o600); this.#fs.writeFileSync(fd, bytes); this.#fs.fsyncSync(fd); }
    finally { this.#fs.closeSync(fd); }
  }
}

export const CONFIG_PANEL_FIELDS = Object.freeze([...FIELDS]);
export const CONFIG_PANEL_DEFAULTS = DEFAULTS;
