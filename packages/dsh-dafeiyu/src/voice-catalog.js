/** A bounded owner-configured voice catalogue; reading it never probes a service. */
const QWEN_VOICES = Object.freeze([
  ['vivian', '薇薇安', '明亮自然的中文女声'],
  ['serena', '瑟琳娜', '温柔舒缓的中文女声'],
  ['uncle_fu', '傅叔', '沉稳醇厚的中文男声'],
  ['dylan', '迪伦', '年轻自然的北京口音男声'],
  ['eric', '埃里克', '爽朗的四川口音男声'],
  ['ryan', '瑞安', '自然清晰的英语男声'],
  ['aiden', '艾登', '年轻明亮的英语男声'],
  ['ono_anna', '安娜', '轻盈自然的日语女声'],
  ['sohee', '素熙', '温柔自然的韩语女声'],
]);
const OPENAI_VOICES = Object.freeze([
  ['alloy', '自然'], ['echo', '沉稳'], ['fable', '叙述'], ['onyx', '浑厚'], ['nova', '明亮'], ['shimmer', '柔和'],
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);

export function validateVoiceProfiles(value) {
  if (!Array.isArray(value) || value.length > 32) return false;
  const ids = new Set();
  return value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(item))
      || Reflect.ownKeys(item).some((key) => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key), 'value'))
      || Object.keys(item).some((key) => !['id', 'name', 'voice', 'description'].includes(key))
      || !ID.test(item.id || '') || ids.has(item.id) || !validText(item.name, 80)
      || !validText(item.voice, 128) || item.voice.startsWith('-') || /[\\/]/.test(item.voice)
      || item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 400 || /[\x00-\x1f\x7f]/.test(item.description))) return false;
    ids.add(item.id); return true;
  });
}

export function voiceSettings(config = {}) {
  return { voiceReplyEnabled: config.voiceReplyEnabled === true, ttsProvider: config.ttsProvider || 'openai-compatible',
    ttsProtocol: config.ttsProtocol || 'openai-audio', ttsBaseURL: config.ttsBaseURL || 'https://api.openai.com/v1',
    ttsModel: config.ttsModel || 'tts-1', ttsVoice: config.ttsVoice || 'alloy', ttsAutoVoice: config.ttsAutoVoice === true,
    ttsLanguage: config.ttsLanguage || '', ttsVoiceProfiles: config.ttsVoiceProfiles || [] };
}

export function buildVoiceCatalog(config = {}) {
  const qwen = /qwen3[-_]?tts/i.test(config.ttsModel || '');
  const nativeVoice = (value) => qwen && typeof value === 'string'
    && QWEN_VOICES.some(([voice]) => voice === value.toLowerCase()) ? value.toLowerCase() : value;
  const configuredVoice = nativeVoice(config.ttsVoice);
  let entries;
  if (Array.isArray(config.ttsVoiceProfiles) && config.ttsVoiceProfiles.length) {
    if (!validateVoiceProfiles(config.ttsVoiceProfiles)) throw new Error('音色目录格式无效');
    entries = config.ttsVoiceProfiles.map((item) => ({ ...item, description: item.description || '' }));
  } else if (config.ttsProvider === 'macos') {
    entries = [{ id: 'system-default', voice: '', name: '系统默认声音', description: '使用 macOS 当前默认声音' }];
  } else if (qwen) {
    entries = QWEN_VOICES.map(([voice, name, description]) => ({ id: voice, voice, name, description }));
  } else if (/^(?:tts-1(?:-hd)?|gpt-4o-mini-tts)$/.test(config.ttsModel || '')) {
    entries = OPENAI_VOICES.map(([voice, description]) => ({ id: voice, voice, name: voice, description }));
  } else {
    const voice = typeof config.ttsVoice === 'string' && config.ttsVoice ? config.ttsVoice : 'alloy';
    entries = [{ id: ID.test(voice) ? voice : 'configured', voice, name: '当前配置声音', description: '由当前语音服务提供的声音' }];
  }
  // Compatible services may reuse a standard model name with their own speaker
  // identifiers. Preserve that explicit legacy choice instead of silently
  // switching the user to the first built-in speaker.
  if (!config.ttsVoiceProfiles?.length && config.ttsProvider !== 'macos'
    && typeof config.ttsVoice === 'string' && config.ttsVoice
    && !entries.some((item) => item.id === config.ttsVoice || nativeVoice(item.voice) === configuredVoice)) {
    entries.push({ id: ID.test(config.ttsVoice) ? config.ttsVoice : 'configured', voice: config.ttsVoice,
      name: '原配置声音', description: '保留原来配置的服务音色；以实际试听结果为准' });
  }
  entries = entries.map((item) => ({ ...item, voice: nativeVoice(item.voice) }));
  const current = entries.find((item) => item.id === config.ttsVoice) || entries.find((item) => item.voice === configuredVoice) || entries[0];
  return { defaultVoiceId: current?.id || '', voices: entries.map((item) => ({ ...item, language: config.ttsLanguage || 'auto', available: true })) };
}

export function publicVoiceCatalog(config = {}) {
  const catalog = buildVoiceCatalog(config);
  return { defaultVoiceId: catalog.defaultVoiceId, autoVoice: config.ttsAutoVoice === true,
    voices: catalog.voices.map(({ voice: _voice, ...item }) => item) };
}
