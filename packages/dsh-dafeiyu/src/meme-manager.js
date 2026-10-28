/** Shared library. Descriptions are user/model content, never execution authority. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeMemeDescription } from '../../phone-mcp/src/shared/meme-description.js';
export { normalizeMemeDescription } from '../../phone-mcp/src/shared/meme-description.js';
const EXTENSION = /\.(png|jpe?g|gif|webp)$/i;
const OTHER_IMAGE_EXTENSION = /\.(avif|bmp|heic|heif|ico|svg|tiff?)$/i;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_WARNINGS = 20;
const MAX_WARNING_CHARS = 8000;
const CLASSIFICATION_SOURCE = 'descriptions-and-user-labels';
const CATEGORIES = {
  food: ['food', '饭', 'token', '饿', '吃'],
  tsundere: ['tsundere', '哼', '撇嘴', '不理', '笨', '嫌弃', '傲娇'],
  slacking: ['slacking', '摸鱼', '睡', '躺', '游', '困'],
  self: ['self', '本鱼', '看什么看', '鲸鱼', '大肥鱼', 'deepseek'],
};
const within = (root, file) => file.startsWith(root + path.sep);
const categoriesFor = (value) => Object.entries(CATEGORIES).filter(([, words]) => words.some((word) => value.toLowerCase().includes(word))).map(([key]) => key);
const fail = (message, code = 'INVALID_METADATA') => { throw Object.assign(new Error(message), { code }); };
const descriptionText = (value, required = false) => normalizeMemeDescription(value, { required });
const normalizedTags = (tags) => {
  if (!Array.isArray(tags) || tags.length > 30 || tags.some((tag) => typeof tag !== 'string' || tag.length > 80)) fail('图片标签必须是最多 30 项、每项最多 80 字符的字符串数组');
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
};
const normalizedTitle = (title) => {
  if (typeof title !== 'string' || title.length > 160 || title.includes('\u0000')) fail('表情名称必须是最多 160 字符的文字');
  return title.trim();
};
const imageFormat = (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
  : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg'
  : /GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii')) ? 'gif'
  : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'webp' : '';
export class MemeManager {
  constructor({ desktopMemeDir = path.join(os.homedir(), '.dsh/profiles/desktop/dshqqbot/表情包'), phoneTools } = {}) {
    this.desktopMemeDir = path.resolve(desktopMemeDir);
    this.phoneTools = phoneTools;
    this.libDir = path.join(this.desktopMemeDir, 'lib/library');
    this.metadataDir = path.join(this.desktopMemeDir, 'dafeiyu-metadata');
    fs.mkdirSync(this.libDir, { recursive: true });
    fs.mkdirSync(this.metadataDir, { recursive: true, mode: 0o700 });
  }
  #metadataPath(filename) { return path.join(this.metadataDir, createHash('sha256').update(filename).digest('hex') + '.json'); }
  #metadata(filename) {
    try {
      const target = this.#metadataPath(filename);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('标签文件类型或大小无效');
      const bytes = fs.readFileSync(target), value = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.tags)
        || value.tags.some((tag) => typeof tag !== 'string')
        || (value.title !== undefined && typeof value.title !== 'string')) throw new Error('标签格式无效');
      const description = descriptionText(value.description === undefined ? '' : value.description), aiDescription = descriptionText(value.aiDescription === undefined ? '' : value.aiDescription);
      return { title: normalizedTitle(value.title || ''), tags: normalizedTags(value.tags), description, aiDescription,
        descriptionStatus: description ? 'ready' : 'missing', revision: createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      if (error.code === 'ENOENT') return { title: '', tags: [], description: '', aiDescription: '', descriptionStatus: 'missing', revision: 'missing' };
      throw Object.assign(new Error(`表情标签读取失败 ${filename}: ${error.message}`), { code: 'METADATA_UNREADABLE' });
    }
  }
  #withWriteLock(action) {
    const lock = path.join(this.metadataDir, '.write-lock');
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') fail('图库正在写入，请稍后重试；未覆盖任何内容', 'BUSY'); throw error; }
    try { return action(); }
    finally { fs.rmdirSync(lock); }
  }
  #writeMetadata(filename, metadata) {
    const target = this.#metadataPath(filename), temporary = `${target}.${randomUUID()}.tmp`;
    const { title, tags, description, aiDescription } = metadata;
    const serialized = Buffer.from(JSON.stringify({ title, tags, description, aiDescription }));
    try {
      // Backups contain content only and have the same private permissions as the sidecar.
      if (fs.existsSync(target)) fs.writeFileSync(`${target}.${Date.now()}-${randomUUID()}.bak`, fs.readFileSync(target), { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
    return { title, tags, description, aiDescription, descriptionStatus: description ? 'ready' : 'missing', revision: createHash('sha256').update(serialized).digest('hex') };
  }
  getMetadata(filename) {
    this.readImage(filename, { headerOnly: true });
    return this.#metadata(filename);
  }
  updateMetadata(filename, { revision, patch } = {}) {
    try {
      if (typeof revision !== 'string' || !/^(missing|[a-f0-9]{64})$/.test(revision)) fail('缺少有效的图库版本，请刷新后重试', 'CONFLICT');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
        || Object.keys(patch).some((key) => !['title', 'tags', 'description', 'aiDescription'].includes(key))) fail('只能修改名称、标签、含义描写与 AI 选图补充');
      return this.#withWriteLock(() => {
        this.readImage(filename);
        const current = this.#metadata(filename);
        if (current.revision !== revision) fail('表情信息已被其他操作修改，请刷新后重试；未覆盖内容', 'CONFLICT');
        const metadata = { title: normalizedTitle(Object.hasOwn(patch, 'title') ? patch.title : current.title), tags: normalizedTags(Object.hasOwn(patch, 'tags') ? patch.tags : current.tags),
          description: descriptionText(Object.hasOwn(patch, 'description') ? patch.description : current.description, true),
          aiDescription: descriptionText(Object.hasOwn(patch, 'aiDescription') ? patch.aiDescription : current.aiDescription) };
        return { ok: true, ...this.#writeMetadata(filename, metadata) };
      });
    } catch (error) { return { ok: false, code: error.code || 'INVALID_METADATA', error: error.message }; }
  }
  listMemes() { return this.scanMemes().memes; }
  scanMemes() {
    // A library-level failure must remain an error, rather than an empty result.
    const root = fs.realpathSync(this.libDir);
    const filenames = fs.readdirSync(root).sort(), memes = [], warnings = [];
    let warningCount = 0;
    const warn = (filename, stage, error) => {
      warningCount++;
      const warning = { filename, stage, code: error.code || 'INVALID_IMAGE_ENTRY', error: error.message.slice(0, 200) };
      if (warnings.length < MAX_WARNINGS && JSON.stringify([...warnings, warning]).length <= MAX_WARNING_CHARS) warnings.push(warning);
    };
    for (const filename of filenames) {
      if (!EXTENSION.test(filename)) {
        if (OTHER_IMAGE_EXTENSION.test(filename)) warn(filename, 'image', new Error('不支持的图片格式'));
        continue;
      }
      let stage = 'image';
      try {
        const file = fs.realpathSync(path.join(root, filename));
        if (!within(root, file)) throw new Error('图片不在表情库内');
        this.#readImage(file, { headerOnly: true });
        stage = 'metadata';
        const metadata = this.#metadata(filename), text = [filename, metadata.title, ...metadata.tags, metadata.description, metadata.aiDescription].join(' ');
        memes.push({ filename, path: file, ...metadata, categories: categoriesFor(text),
          isWhaleMeme: this.isSelfWhaleMeme(text), classificationSource: CLASSIFICATION_SOURCE });
      } catch (error) { warn(filename, stage, error); }
    }
    return { memes, warnings, partial: warningCount > 0, warningCount, warningsTruncated: warningCount > warnings.length };
  }
  isSelfWhaleMeme(value = '') { return ['鲸鱼', '抹香鲸', '大肥鱼', '肥鱼', 'deepseek', 'ds娘', '蓝白'].some((word) => String(value).toLowerCase().includes(word)); }
  searchMemes(query = '', { limit = 30, category = '', describedOnly = false } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('图库查询 limit 必须为 1–100');
    if (category && !Object.hasOwn(CATEGORIES, category)) throw new Error('未知表情分类');
    const terms = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
    const { memes: entries, ...health } = this.scanMemes();
    const rows = entries.map((row) => {
      const text = [row.filename, row.title, ...row.tags, row.description, row.aiDescription].join(' ').toLowerCase();
      return { ...row, score: terms.reduce((score, term) => score + Number(text.includes(term)), 0) };
    }).filter((row) => (!describedOnly || row.descriptionStatus === 'ready') && (!category || row.categories.includes(category)) && (!terms.length || row.score > 0))
      .sort((a, b) => b.score - a.score || Number(b.isWhaleMeme) - Number(a.isWhaleMeme) || a.filename.localeCompare(b.filename));
    const memes = rows.slice(0, limit);
    const result = { ok: true, memes, total: rows.length, truncated: rows.length > limit,
      ...health, classificationSource: CLASSIFICATION_SOURCE };
    while (JSON.stringify(result).length > 24000 && memes.length) { memes.pop(); result.truncated = true; }
    return result;
  }
  matchMemeForReply(replyText = '') { return this.matchMemeForReplyResult(replyText).match; }
  matchMemeForReplyResult(replyText = '') {
    const category = categoriesFor(String(replyText))[0];
    const result = this.searchMemes('', { category, limit: 1, describedOnly: true });
    return { ok: true, match: category && result.memes.length ? { category, meme: result.memes[0] } : null,
      warnings: result.warnings, partial: result.partial, warningCount: result.warningCount,
      warningsTruncated: result.warningsTruncated, classificationSource: result.classificationSource };
  }
  resolveImage(filename) { return this.readImage(filename).path; }
  readImage(filename, { headerOnly = false } = {}) {
    if (typeof filename !== 'string' || path.basename(filename) !== filename || /[\\/]/.test(filename) || !EXTENSION.test(filename)) throw new Error('必须选择图库中的精确图片文件名');
    const root = fs.realpathSync(this.libDir), file = fs.realpathSync(path.join(root, filename));
    if (!within(root, file)) throw new Error('图片不在表情库内');
    return { path: file, ...this.#readImage(file, { headerOnly }) };
  }
  #readImage(file, { headerOnly = false } = {}) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 8 || stat.size > MAX_IMAGE_BYTES || !EXTENSION.test(file)) throw new Error('图片为空、格式不支持或超过 8 MiB');
    let bytes;
    if (headerOnly) {
      const fd = fs.openSync(file, 'r');
      try { const header = Buffer.alloc(12); bytes = header.subarray(0, fs.readSync(fd, header, 0, header.length, 0)); }
      finally { fs.closeSync(fd); }
    } else bytes = fs.readFileSync(file);
    const format = imageFormat(bytes);
    if (!format) throw new Error('文件不是受支持的实际图片');
    return { bytes, format, mediaType: `image/${format === 'jpg' ? 'jpeg' : format}` };
  }
  #findDuplicate(bytes, prefix, filenames) {
    const candidates = [];
    for (const filename of filenames) {
      if (!EXTENSION.test(filename)) continue;
      let stat;
      try { stat = fs.statSync(path.join(this.libDir, filename)); }
      catch (error) {
        if (filename.startsWith(prefix)) fail('同内容索引对应图片不可读取，需先修复；未覆盖原条目', 'IMAGE_INDEX_MISMATCH');
        continue;
      }
      if (!stat.isFile() || stat.size !== bytes.length) {
        if (filename.startsWith(prefix)) fail('同内容索引与实际图片不一致，需先检查原条目；未覆盖内容', 'IMAGE_INDEX_MISMATCH');
        continue;
      }
      candidates.push(filename);
    }
    // Full reads happen only on explicit collection. Daily scans inspect headers.
    if (candidates.length > 128 || candidates.length * bytes.length > 64 * 1024 * 1024) {
      fail('同大小图片的查重超过 128 张或 64 MiB，请先排查同图后重试；本次未导入', 'DEDUPLICATION_LIMIT');
    }
    const matches = [];
    for (const filename of candidates) {
      let image;
      try { image = this.readImage(filename); }
      catch (error) {
        if (filename.startsWith(prefix)) fail('同内容索引对应图片不可读取，需先修复；未覆盖原条目', 'IMAGE_INDEX_MISMATCH');
        continue;
      }
      if (!image.bytes.equals(bytes)) {
        if (filename.startsWith(prefix)) fail('同内容索引与实际图片不一致，需先检查原条目；未覆盖内容', 'IMAGE_INDEX_MISMATCH');
        continue;
      }
      // Check every same-content sidecar before selecting any match. A damaged
      // legacy sidecar must not be bypassed by cloning or choosing another name.
      matches.push({ filename, path: image.path, ...this.#metadata(filename) });
    }
    return matches.find((row) => row.descriptionStatus === 'ready') || matches[0];
  }
  collectMeme(sourcePath, title = '', options = {}) {
    try {
      // Validate the required description before reading even the source image.
      descriptionText(options.description, true);
      const { bytes } = this.#readImage(fs.realpathSync(sourcePath));
      return this.collectImage(bytes, title, options);
    } catch (error) { return { ok: false, code: error.code || 'INVALID_IMAGE', error: error.message }; }
  }
  collectImage(bytes, title = '', options = {}) {
    let health;
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)) fail('图片信息必须是对象');
      const { tags = [], description, aiDescription = '' } = options;
      const metadata = { title: normalizedTitle(title), tags: normalizedTags(tags), description: descriptionText(description, true), aiDescription: descriptionText(aiDescription) };
      if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('必须上传实际图片字节', 'INVALID_IMAGE');
      if (bytes.byteLength < 8 || bytes.byteLength > MAX_IMAGE_BYTES) fail('图片为空、格式不支持或超过 8 MiB', 'INVALID_IMAGE');
      bytes = Buffer.from(bytes);
      const format = imageFormat(bytes);
      if (bytes.length < 8 || bytes.length > MAX_IMAGE_BYTES || !format) fail('图片为空、格式不支持或超过 8 MiB', 'INVALID_IMAGE');
      return this.#withWriteLock(() => {
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
        const { memes, ...scanHealth } = this.scanMemes();
        health = scanHealth;
        const prefix = `dafeiyu_${hash}_`, healthyNames = new Set(memes.map((row) => row.filename));
        const filenames = fs.readdirSync(this.libDir);
        if (filenames.some((filename) => filename.startsWith(prefix) && !healthyNames.has(filename))) throw new Error('同一图片的现有图库条目损坏，需先修复；未覆盖原文件或标签');
        const existing = this.#findDuplicate(bytes, prefix, filenames);
        const cleanTitle = String(title || 'meme').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 60);
        const filename = existing?.filename || `dafeiyu_${hash}_${cleanTitle}.${format}`;
        const destination = path.join(this.libDir, filename);
        const current = this.#metadata(filename); // Validate an orphaned sidecar before creating an image.
        // Re-import is not editing authority. Preserve curated meaning until a CAS edit.
        if (existing && current.descriptionStatus === 'ready') return { ok: true, imported: false, duplicate: true, filename, path: destination,
          metadata: current, note: '图库已存在相同图片，保留已有描写；如需修改请在详情中编辑', ...health };
        let created = false;
        try {
          if (!existing) { fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 }); created = true; }
          const saved = this.#writeMetadata(filename, { ...metadata, title: metadata.title || existing?.title || '',
            tags: [...new Set([...(existing?.tags || []), ...metadata.tags])].slice(0, 30) });
          return { ok: true, imported: !existing, filename, path: destination, metadata: saved, ...health };
        } catch (error) { if (created) fs.rmSync(destination, { force: true }); throw error; }
      });
    } catch (error) { return { ok: false, code: error.code || 'INVALID_IMAGE', error: error.message, ...health }; }
  }
  async syncFromPhone(options = {}) {
    if (typeof this.phoneTools?.pull !== 'function') return { ok: false, imported: 0, error: '未配置真机文件传输' };
    let temporary;
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'descriptions')) fail('手机同步参数只能包含逐图描写 descriptions');
      const { descriptions } = options;
      if (descriptions === undefined || (Array.isArray(descriptions) && descriptions.length === 0)) fail('手机同步必须提供每张图片的具体含义与适用语境，至少填写一项描写', 'DESCRIPTION_REQUIRED');
      if (!Array.isArray(descriptions) || descriptions.length > 1000) fail('手机同步描写必须是 1–1000 项的数组');
      const byPath = new Map();
      for (const item of descriptions) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['filename', 'description', 'aiDescription'].includes(key))
          || typeof item.filename !== 'string' || !item.filename || item.filename.length > 2000 || item.filename.includes('\0')
          || item.filename.includes('\\') || path.posix.isAbsolute(item.filename) || item.filename.split('/').some((part) => !part || part === '.' || part === '..')) fail('同步描写必须使用拉取目录内的精确相对文件名');
        if (byPath.has(item.filename)) fail('手机同步的相对文件名重复；不能猜测对应描写');
        byPath.set(item.filename, { filename: item.filename,
          description: normalizeMemeDescription(item.description, { required: true }),
          aiDescription: normalizeMemeDescription(item.aiDescription) });
      }
      temporary = fs.mkdtempSync(path.join(this.desktopMemeDir, 'tmp_pull-'));
      const pulled = await this.phoneTools.pull('/sdcard/Pictures/大肥鱼表情包', temporary);
      if (pulled?.ok === false) throw new Error(pulled.error || '手机图库读取失败');
      let imported = 0; const errors = [];
      const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(file);
          else if (entry.isFile() && EXTENSION.test(entry.name)) {
            const relative = path.relative(temporary, file).split(path.sep).join('/'), item = byPath.get(relative);
            const result = this.collectMeme(file, path.parse(entry.name).name, { description: item?.description, aiDescription: item?.aiDescription });
            if (!result.ok) errors.push({ filename: relative, code: result.code, error: result.error });
            else if (result.imported) imported++;
          }
        }
      };
      walk(temporary);
      return { ok: errors.length === 0, imported, errors, partial: errors.length > 0 };
    } catch (error) { return { ok: false, imported: 0, code: error.code || 'SYNC_FAILED', error: error.message }; }
    finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}
export default MemeManager;
