/** A caption is content data, shared by library import and phone collection. */
export function normalizeMemeDescription(value, { required = false } = {}) {
  if (value === undefined) value = '';
  if (typeof value !== 'string' || value.length > 1200 || value.includes('\0')) {
    throw Object.assign(new Error('表情描写必须是最多 1200 字符的文本'), { code: 'INVALID_METADATA' });
  }
  const text = value.trim();
  if (required && !text) {
    throw Object.assign(new Error('必须填写表情的具体含义和适用语境，名称或标签不能代替描写'), { code: 'DESCRIPTION_REQUIRED' });
  }
  return text;
}
