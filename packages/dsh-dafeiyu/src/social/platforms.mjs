export const PLATFORMS = Object.freeze({
  bilibili: Object.freeze({ name: 'B站', login: 'https://passport.bilibili.com/login', home: 'https://www.bilibili.com/',
    hosts: ['www.bilibili.com', 'space.bilibili.com', 'member.bilibili.com', 'message.bilibili.com', 'passport.bilibili.com'], qr: true,
    reads: ['profile', 'search', 'posts', 'comments', 'replies', 'inbox', 'messages', 'notifications'],
    writes: ['comment', 'reply', 'message', 'video', 'like', 'follow', 'bookmark'] }),
  douyin: Object.freeze({ name: '抖音', login: 'https://creator.douyin.com/', home: 'https://www.douyin.com/',
    hosts: ['www.douyin.com', 'creator.douyin.com'], qr: true,
    reads: ['profile', 'search', 'posts', 'comments', 'replies', 'inbox', 'messages', 'notifications', 'comment-management', 'message-management'],
    writes: ['comment', 'reply', 'message', 'video', 'like', 'follow', 'bookmark'] }),
  x: Object.freeze({ name: 'X', login: 'https://x.com/i/flow/login', signup: 'https://x.com/i/flow/signup', home: 'https://x.com/home',
    hosts: ['x.com'], qr: false,
    reads: ['profile', 'search', 'posts', 'comments', 'replies', 'inbox', 'messages', 'notifications'],
    writes: ['post', 'comment', 'reply', 'message', 'video', 'like', 'follow', 'bookmark'] }),
});
export class SocialAccountError extends Error {
  constructor(code, message = '平台账号操作未完成，请核对当前状态。') { super(message); this.code = code; }
}
export const deny = (code, message) => { throw new SocialAccountError(code, message); };
export const allowed = callback => { try { return callback?.() === true; } catch { return false; } };
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export const platform = key => Object.hasOwn(PLATFORMS, key) ? PLATFORMS[key] : deny('INVALID_PLATFORM');
export const accountId = value => typeof value === 'string' && /^[A-Za-z0-9_@.-]{1,128}$/.test(value);
export function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) deny('INVALID_REQUEST');
}
export function safeUrl(key, value) {
  const p = platform(key); let url;
  try { url = new URL(value); } catch { deny('INVALID_TARGET'); }
  if (url.protocol !== 'https:' || !p.hosts.includes(url.hostname) || url.username || url.password || url.hash || url.port
    || value.length > 2000) deny('INVALID_TARGET');
  return url.href;
}
export function readRequest(key, value) {
  exactKeys(value, ['operation', 'target', 'query', 'cursor', 'limit']);
  if (!platform(key).reads.includes(value.operation)) deny('INVALID_OPERATION');
  const result = { operation: value.operation, limit: value.limit ?? 10 };
  if (!Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 20) deny('INVALID_REQUEST');
  if (value.target !== undefined) {
    if (typeof value.target !== 'string' || !value.target || value.target.length > 2000 || /[\x00-\x1f\x7f]/.test(value.target)) deny('INVALID_TARGET');
    result.target = value.target.startsWith('https://') ? safeUrl(key, value.target) : value.target;
  }
  for (const field of ['query', 'cursor']) if (value[field] !== undefined) {
    if (typeof value[field] !== 'string' || value[field].length > (field === 'query' ? 200 : 500) || /[\x00-\x1f\x7f]/.test(value[field])) deny('INVALID_REQUEST');
    result[field] = value[field];
  }
  if (value.operation === 'search' && !result.query?.trim()) deny('INVALID_REQUEST');
  if (['comments', 'messages'].includes(value.operation) && !result.target) deny('INVALID_TARGET');
  return result;
}
export function browseRequest(key, value) {
  platform(key); if (key !== 'douyin') deny('INVALID_OPERATION');
  exactKeys(value, ['action', 'expectedVideoId']);
  if (!['open', 'current', 'next', 'stop', 'history'].includes(value.action)) deny('INVALID_OPERATION');
  if (value.action === 'next') {
    if (typeof value.expectedVideoId !== 'string' || !/^media-[a-f0-9]{64}$/.test(value.expectedVideoId)) deny('INVALID_TARGET');
  } else if (value.expectedVideoId !== undefined) deny('INVALID_REQUEST');
  return { action: value.action, ...(value.action === 'next' ? { expectedVideoId: value.expectedVideoId } : {}) };
}
export function writeRequest(key, value) {
  exactKeys(value, ['operation', 'target', 'parentId', 'rootId', 'text', 'title', 'video', 'cover', 'tags', 'declaration', 'category']);
  if (!platform(key).writes.includes(value.operation)) deny('INVALID_OPERATION');
  const result = { operation: value.operation };
  for (const field of ['target', 'parentId', 'rootId', 'title', 'video', 'cover', 'category']) if (value[field] !== undefined) {
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > (['video', 'cover'].includes(field) ? 4096 : 2000)
      || /[\x00-\x1f\x7f]/.test(value[field])) deny('INVALID_REQUEST');
    result[field] = field === 'target' && value[field].startsWith('https://') ? safeUrl(key, value[field]) : value[field];
  }
  if (value.text !== undefined) {
    if (typeof value.text !== 'string' || !value.text.trim() || [...value.text].length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text)) deny('INVALID_REQUEST');
    result.text = value.text;
  }
  if (['comment', 'reply', 'message', 'like', 'follow', 'bookmark'].includes(value.operation) && !result.target) deny('INVALID_TARGET');
  if (['post', 'comment', 'reply', 'message'].includes(value.operation) && !result.text) deny('INVALID_REQUEST');
  if (value.operation !== 'reply' && ['parentId', 'rootId'].some(key => value[key] !== undefined)) deny('INVALID_REQUEST');
  if (value.operation === 'reply' && !result.parentId) deny('INVALID_TARGET');
  if (value.operation === 'video' && (!result.video || !result.title || !['none', 'ai-generated'].includes(value.declaration))) deny('INVALID_MEDIA');
  if (value.declaration !== undefined) {
    if (!['none', 'ai-generated'].includes(value.declaration)) deny('INVALID_REQUEST'); result.declaration = value.declaration;
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > 10 || value.tags.some(v => typeof v !== 'string' || !/^[\p{L}\p{N}_]{1,30}$/u.test(v))) deny('INVALID_REQUEST');
    result.tags = [...value.tags];
  }
  if (value.operation !== 'video' && ['video', 'cover', 'title', 'tags', 'declaration', 'category'].some(k => value[k] !== undefined)) deny('INVALID_REQUEST');
  return result;
}
