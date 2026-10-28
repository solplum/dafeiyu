import { faceText, oneBotFace } from './qq-face.js';

const scalar = (value) => typeof value === 'string' ? value
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const decodeCQ = (value) => value.replace(/&#44;/g, ',').replace(/&#91;/g, '[')
  .replace(/&#93;/g, ']').replace(/&amp;/g, '&');
const MAX_SEGMENTS = 1024;
const MAX_CQ_SOURCE_CHARS = 65536;

// Prefer the canonical array, including an empty array. The raw rendering must
// never replace it or turn a literal CQ string inside a text segment into media.
function inspectSegments(raw) {
  if (Array.isArray(raw?.message)) return raw.message.length <= MAX_SEGMENTS
    ? { segments: raw.message, issue: '' } : { segments: [], issue: 'too-many-segments' };
  if (raw?.message !== undefined && raw?.message !== null && typeof raw.message !== 'string') {
    return { segments: [], issue: 'unsupported-segment' };
  }
  const message = typeof raw === 'string' ? raw : typeof raw?.message === 'string' ? raw.message
    : typeof raw?.raw_message === 'string' ? raw.raw_message : '';
  if (message.length > MAX_CQ_SOURCE_CHARS) return { segments: [], issue: 'source-too-large' };
  const segments = []; let offset = 0;
  for (const match of message.matchAll(/\[CQ:([A-Za-z_][A-Za-z0-9_-]*)((?:,[^\]]*)?)\]/g)) {
    if (match.index > offset) segments.push({ type: 'text', data: { text: decodeCQ(message.slice(offset, match.index)) } });
    const data = Object.create(null);
    for (const field of match[2].split(',').slice(1)) {
      const equals = field.indexOf('=');
      if (equals > 0) data[field.slice(0, equals)] = decodeCQ(field.slice(equals + 1));
    }
    segments.push({ type: match[1], data }); offset = match.index + match[0].length;
    if (segments.length > MAX_SEGMENTS) return { segments: [], issue: 'too-many-segments' };
  }
  if (offset < message.length) segments.push({ type: 'text', data: { text: decodeCQ(message.slice(offset)) } });
  return segments.length > MAX_SEGMENTS ? { segments: [], issue: 'too-many-segments' } : { segments, issue: '' };
}

export const oneBotMessageSegments = (raw) => inspectSegments(raw).segments;

// This is input semantics, not a media read. Paths/URLs remain opaque until the
// admitted native preparation step validates the current message and transport.
export function normalizeOneBotInput(raw) {
  const { segments, issue } = inspectSegments(raw);
  const faces = [], images = [], references = [], kinds = new Set(), text = [];
  let inputIssue = issue;
  for (const [index, part] of segments.entries()) {
    const data = part?.data || {};
    if (part?.type === 'text') {
      const value = scalar(data.text); text.push(value);
      if (value.trim()) kinds.add('text');
    } else if (part?.type === 'at') {
      const id = scalar(data.qq);
      if (/^(all|[1-9]\d{0,19})$/.test(id)) text.push('@' + id);
      kinds.add('at');
    } else if (part?.type === 'face') {
      const face = { index, ...oneBotFace(data) };
      faces.push(face); text.push(faceText(face)); kinds.add('face');
    } else if (part?.type === 'image' || part?.type === 'mface') {
      const type = part.type === 'mface' || data.file === 'marketface' ? 'mface' : 'image';
      images.push({ index, type, file: scalar(data.file), url: scalar(data.url),
        subType: scalar(data.sub_type), fileSize: scalar(data.file_size), summary: scalar(data.summary),
        emojiId: scalar(data.emoji_id), emojiPackageId: scalar(data.emoji_package_id), key: scalar(data.key) });
      text.push(type === 'mface' ? '[图片表情]' : '[图片]'); kinds.add(type);
    } else if (part?.type === 'record' || part?.type === 'audio') {
      text.push('[语音]'); kinds.add('record');
    } else if (part?.type === 'file') kinds.add('file');
    else if (part?.type === 'reply') {
      const id = scalar(data.id);
      if (/^-?[1-9]\d{0,19}$/.test(id)) references.push({ index, id });
    } else if (part?.type) {
      kinds.add('unsupported'); inputIssue ||= 'unsupported-segment';
    } else inputIssue ||= 'unsupported-segment';
  }
  // Never execute the text half or fetch the images of a partially understood
  // message. Consumers must reject inputIssue inside the admitted task queue.
  if (inputIssue) return { text: '', inputKind: 'unsupported', inputIssue, faces: [], images: [], references: [], socialOnly: false };
  const inputKind = kinds.size === 0 ? 'empty' : kinds.size === 1 ? [...kinds][0] : 'mixed';
  return { text: text.join('').trim(), inputKind, inputIssue: '', faces, images, references,
    socialOnly: kinds.size > 0 && [...kinds].every((kind) => ['face', 'image', 'mface'].includes(kind)) };
}
