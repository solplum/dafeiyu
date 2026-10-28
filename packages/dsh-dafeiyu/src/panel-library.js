/** Owner panel data only: local image previews and the current role card. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_PERSONA = 128 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_RESPONSE = 24000;
const MAX_DESCRIPTION = 1200;
const EXTENSION = /\.(png|jpe?g|gif|webp)$/i;
const own = (object, key) => Object.hasOwn(object, key);
const bytesForJson = (value) => Buffer.byteLength(JSON.stringify(value));
const digest = (...parts) => { const hash = createHash('sha256'); for (const part of parts) hash.update(part); return hash.digest('hex'); };
const within = (root, file) => file.startsWith(root + path.sep);
const filename = (value) => typeof value === 'string' && value.length > 0
  && path.basename(value) === value && !/[\\/\x00]/.test(value) && EXTENSION.test(value);
function display(value, maxBytes) {
  if (typeof value !== 'string') return '';
  let result = '';
  for (const character of value) {
    if (bytesForJson(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}
const imageMime = (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
  : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) ? 'image/gif'
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : '';

export class PanelLibraryError extends Error {
  constructor(code, message) { super(message); this.name = 'PanelLibraryError'; this.code = code; }
}
const fail = (code, message) => { throw new PanelLibraryError(code, message); };

export class PanelLibrary {
  #getRuntime;
  #instances = new WeakMap();
  constructor({ getRuntime, paths } = {}) {
    if (typeof getRuntime !== 'function') throw new TypeError('PanelLibrary requires getRuntime');
    this.#getRuntime = getRuntime;
    // Paths are deliberately not a fallback: only the running role/library is authoritative.
    void paths;
  }

  #scan() {
    try {
      const runtime = this.#getRuntime(), manager = runtime?.memeManager;
      if (!manager || typeof manager.scanMemes !== 'function' || typeof manager.libDir !== 'string') {
        fail('UNAVAILABLE', '图库服务尚未就绪');
      }
      const root = fs.realpathSync(manager.libDir);
      if (!fs.statSync(root).isDirectory()) fail('UNAVAILABLE', '图库服务尚未就绪');
      const scan = manager.scanMemes();
      if (!scan || !Array.isArray(scan.memes)) fail('LIBRARY_UNREADABLE', '无法读取本地图库');
      const warnings = [];
      const warn = (code, file = '') => {
        if (warnings.length < 8) warnings.push({ code, file: filename(file) ? display(file, 160) : '', message: '部分图库条目不可用或已缩短显示' });
      };
      for (const warning of (Array.isArray(scan.warnings) ? scan.warnings : []).slice(0, 8)) {
        warn(warning?.stage === 'metadata' ? 'INVALID_METADATA' : 'INVALID_IMAGE', warning?.filename);
      }
      let partial = scan.partial === true;
      const seen = new Set(), entries = [];
      for (const row of scan.memes) {
        const file = row?.filename;
        try {
          if (!filename(file) || seen.has(file)) throw new Error();
          const candidate = path.join(root, file), stat = fs.lstatSync(candidate);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 8 || stat.size > MAX_IMAGE
            || !within(root, fs.realpathSync(candidate))) throw new Error();
          seen.add(file);
          const title = typeof row.title === 'string' ? row.title : '';
          const tags = Array.isArray(row.tags) ? row.tags.filter((tag) => typeof tag === 'string') : [];
          const description = typeof row.description === 'string' ? row.description : '';
          const aiDescription = typeof row.aiDescription === 'string' ? row.aiDescription : '';
          entries.push({ id: digest('meme\0', root, '\0', file), filename: file, title, tags, description, aiDescription,
            descriptionStatus: description.trim() ? 'ready' : 'missing',
            search: [file, title.slice(0, 4096), description.slice(0, MAX_DESCRIPTION), aiDescription.slice(0, MAX_DESCRIPTION),
              ...tags.slice(0, 30).map((tag) => tag.slice(0, 512))].join(' ').toLowerCase() });
        } catch { partial = true; warn('UNSAFE_ENTRY', file); }
      }
      entries.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
      return { runtime, manager, root, entries, warnings, partial };
    } catch (error) {
      if (error instanceof PanelLibraryError) throw error;
      fail('LIBRARY_UNREADABLE', '无法读取本地图库');
    }
  }

  async listMemes({ query = '', offset = 0, limit = 24 } = {}) {
    if (typeof query !== 'string' || query.length > 256 || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isInteger(limit) || limit < 1 || limit > 24) fail('INVALID_QUERY', '图库查询参数无效');
    const scan = this.#scan(), terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = scan.entries.filter((row) => terms.every((term) => row.search.includes(term)));
    const result = { items: matches.slice(offset, offset + limit).map((row) => ({ id: row.id,
      file: display(row.filename, 300), title: display(row.title, 220), tags: row.tags.slice(0, 4).map((tag) => display(tag, 48)),
      description: display(row.description, 300), descriptionStatus: row.descriptionStatus })),
    total: matches.length, offset, limit, partial: scan.partial, warnings: scan.warnings };
    const selected = matches.slice(offset, offset + limit);
    if (selected.some((row, index) => row.filename !== result.items[index].file || row.title !== result.items[index].title
      || row.description !== result.items[index].description || row.tags.length !== result.items[index].tags.length || row.tags.some((tag, i) => tag !== result.items[index].tags[i]))) {
      result.partial = true;
      if (result.warnings.length < 8) result.warnings.push({ code: 'DISPLAY_TRUNCATED', file: '', message: '部分标签、标题或描写已缩短显示，详情可查看全文' });
    }
    // Keep pagination stable: trim display fields rather than silently skipping rows.
    if (bytesForJson(result) > MAX_RESPONSE) {
      result.partial = true;
      result.warnings = [{ code: 'DISPLAY_TRUNCATED', file: '', message: '部分标签或标题已缩短显示' }];
      for (const item of result.items) { item.title = display(item.title, 120); item.tags = []; item.description = display(item.description, 120); }
    }
    return result;
  }

  #current(source) {
    try { return this.#getRuntime() === source.runtime && source.runtime?.memeManager === source.manager
      && fs.realpathSync(source.manager.libDir) === source.root; } catch { return false; }
  }

  #admit(source, { authorize = () => true, getBusy = () => false } = {}, writing = false) {
    if (!authorize()) fail('FORBIDDEN', '需要本机主人登录权限');
    if (!this.#current(source)) fail('CONFLICT', '图库运行实例已变化，请重新读取');
    if (writing && getBusy()) fail('BUSY', '正在处理任务，请稍后修改图库');
  }

  #instance(source) {
    let value = this.#instances.get(source.runtime);
    if (!value || value.manager !== source.manager) {
      value = { manager: source.manager, token: randomUUID() };
      this.#instances.set(source.runtime, value);
    }
    return value.token;
  }

  #metadata(source, entry) {
    if (typeof source.manager.getMetadata !== 'function') fail('UNAVAILABLE', '表情描述服务尚未就绪');
    let metadata;
    try { metadata = source.manager.getMetadata(entry.filename); }
    catch { fail('LIBRARY_UNREADABLE', '无法读取此表情的描述，请检查图库后重试'); }
    if (!metadata || typeof metadata.revision !== 'string') fail('LIBRARY_UNREADABLE', '无法读取此表情的描述');
    const description = typeof metadata.description === 'string' ? metadata.description : '';
    return { metadata, view: { id: entry.id, file: entry.filename,
      title: typeof metadata.title === 'string' ? metadata.title : '',
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag) => typeof tag === 'string') : [],
      description, aiDescription: typeof metadata.aiDescription === 'string' ? metadata.aiDescription : '',
      descriptionStatus: description.trim() ? 'ready' : 'missing',
      revision: digest('meme-metadata\0', this.#instance(source), '\0', source.root, '\0', entry.filename, '\0', metadata.revision) } };
  }

  #find(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('INVALID_ID', '图片标识无效');
    const source = this.#scan(), entry = source.entries.find((row) => row.id === id);
    if (!entry) fail('NOT_FOUND', '图片不存在或已不可用');
    return { source, entry };
  }

  #patch(patch, complete = false) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
      || Object.keys(patch).some((key) => !['title', 'tags', 'description', 'aiDescription'].includes(key))) {
      fail('INVALID_METADATA', '表情描述包含无效字段');
    }
    const text = (key, maximum, required = false) => {
      if (!own(patch, key)) { if (required) fail('INVALID_DESCRIPTION', '请填写表情的具体意思和使用场景'); return; }
      if (typeof patch[key] !== 'string' || patch[key].includes('\0') || patch[key].length > maximum
        || required && !patch[key].trim()) fail('INVALID_METADATA', key === 'description' ? '表情描写不能为空且最多 1200 字符' : '标题或 AI 描写超出长度限制');
    };
    if (complete && !own(patch, 'title')) fail('INVALID_METADATA', '表情标题字段缺失');
    text('title', 160); text('description', MAX_DESCRIPTION, complete || own(patch, 'description'));
    text('aiDescription', MAX_DESCRIPTION);
    if (own(patch, 'tags') && (!Array.isArray(patch.tags) || patch.tags.length > 30
      || patch.tags.some((tag) => typeof tag !== 'string' || tag.length > 80 || tag.includes('\0')))) {
      fail('INVALID_METADATA', '标签最多 30 个，每个最多 80 字符');
    }
    return { ...patch, ...(own(patch, 'description') ? { description: patch.description.trim() } : {}),
      ...(own(patch, 'aiDescription') ? { aiDescription: patch.aiDescription.trim() } : {}) };
  }

  #result(result) {
    if (result?.ok === true) return result;
    const code = result?.code;
    if (code === 'CONFLICT') fail('CONFLICT', '表情描述已被其他操作修改，请重新读取');
    if (code === 'BUSY') fail('BUSY', '另一个图库操作正在进行，请稍后重试');
    if (code === 'DESCRIPTION_REQUIRED') fail('INVALID_DESCRIPTION', '请填写表情的具体意思和使用场景');
    if (code === 'NOT_FOUND') fail('NOT_FOUND', '表情已不存在，请刷新图库');
    if (typeof code === 'string' && code.startsWith('INVALID_')) fail('INVALID_METADATA', '图片或描述格式无效，请检查后重试');
    fail('LIBRARY_WRITE_FAILED', '图库保存未完成，请重新读取确认');
  }

  async memeDetail(id, options = {}) {
    const { source, entry } = this.#find(id);
    this.#admit(source, options);
    const { view } = this.#metadata(source, entry);
    this.#admit(source, options);
    return view;
  }

  async saveMemeMetadata(input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['id', 'revision', 'patch'].includes(key))) fail('INVALID_METADATA', '表情编辑请求无效');
    const patch = this.#patch(input.patch), { source, entry } = this.#find(input.id);
    this.#admit(source, options, true);
    const before = this.#metadata(source, entry);
    if (typeof input.revision !== 'string' || before.view.revision !== input.revision) fail('CONFLICT', '表情描述已变化，请重新读取');
    // Legacy entries must gain a real description even when only their title/tags were changed.
    if (!(own(patch, 'description') ? patch.description : before.view.description).trim()) fail('INVALID_DESCRIPTION', '请补充表情的具体意思和使用场景');
    if (typeof source.manager.updateMetadata !== 'function') fail('UNAVAILABLE', '表情描述编辑服务尚未就绪');
    this.#admit(source, options, true);
    let result;
    try { result = source.manager.updateMetadata(entry.filename, { revision: before.metadata.revision, patch }); }
    catch { fail('LIBRARY_WRITE_FAILED', '表情描述保存未完成，请重新读取确认'); }
    this.#result(result);
    this.#admit(source, options);
    return this.#metadata(source, entry).view;
  }

  async importMeme(input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['filename', 'title', 'tags', 'description', 'aiDescription', 'imageBase64'].includes(key))) {
      fail('INVALID_METADATA', '图片导入请求无效');
    }
    if (!filename(input.filename) || input.filename.length > 255 || /[\x00-\x1f\x7f]/.test(input.filename)) fail('INVALID_IMAGE', '请选择 PNG、JPEG、GIF 或 WebP 文件');
    const patch = this.#patch({ title: input.title, tags: input.tags ?? [], description: input.description, aiDescription: input.aiDescription ?? '' }, true);
    const encoded = input.imageBase64;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_IMAGE / 3) * 4
      || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail('INVALID_IMAGE', '图片编码无效或超过 8 MiB');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE || bytes.toString('base64') !== encoded || !imageMime(bytes)) fail('INVALID_IMAGE', '图片内容无效或超过 8 MiB');
    const source = this.#scan();
    this.#admit(source, options, true);
    if (typeof source.manager.collectImage !== 'function') fail('UNAVAILABLE', '图片导入服务尚未就绪');
    let result;
    try { result = source.manager.collectImage(bytes, patch.title, { tags: patch.tags, description: patch.description, aiDescription: patch.aiDescription }); }
    catch { fail('LIBRARY_WRITE_FAILED', '图片导入未完成，请刷新图库确认'); }
    this.#result(result);
    this.#admit(source, options);
    const current = this.#scan();
    if (current.manager !== source.manager || current.runtime !== source.runtime || current.root !== source.root) fail('CONFLICT', '图库运行实例已变化，请重新读取');
    const entry = current.entries.find((row) => row.filename === result.filename);
    if (!entry) fail('LIBRARY_WRITE_FAILED', '图片导入结果尚未确认，请刷新图库');
    return { ...this.#metadata(source, entry).view, imported: result.imported === true,
      ...(result.duplicate === true ? { duplicate: true, note: '图库已存在这张表情，已保留原有描写；如需调整，请编辑该表情。' } : {}) };
  }

  async memeImage(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('INVALID_ID', '图片标识无效');
    const scan = this.#scan(), entry = scan.entries.find((row) => row.id === id);
    if (!entry) fail('NOT_FOUND', '图片不存在或已不可用');
    let fd;
    try {
      const file = path.join(scan.root, entry.filename), before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(file) !== file) throw new Error();
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size < 8 || stat.size > MAX_IMAGE) throw new Error();
      const bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) {
        const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
        if (!count) break;
        read += count;
      }
      if (read !== bytes.length || fs.fstatSync(fd).size !== stat.size || fs.realpathSync(file) !== file) throw new Error();
      const mime = imageMime(bytes);
      if (!mime) throw new Error();
      return { mime, bytes };
    } catch { fail('INVALID_IMAGE', '图片不是可读取的受支持格式'); }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }

  #role() {
    const role = this.#getRuntime()?.brain?.role;
    return role && typeof role.cardPath === 'string' && path.isAbsolute(role.cardPath)
      ? { role, file: path.resolve(role.cardPath) } : null;
  }

  #readRole(source) {
    let fd;
    try {
      const stat = fs.lstatSync(source.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PERSONA) fail('PERSONA_UNREADABLE', '角色卡不是可编辑的文本文件');
      fd = fs.openSync(source.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_PERSONA) fail('PERSONA_UNREADABLE', '角色卡不是可编辑的文本文件');
      const buffer = Buffer.alloc(MAX_PERSONA + 1);
      let read = 0;
      while (read < buffer.length) {
        const count = fs.readSync(fd, buffer, read, buffer.length - read, read);
        if (!count) break;
        read += count;
      }
      const bytes = buffer.subarray(0, read);
      if (bytes.length > MAX_PERSONA || fs.fstatSync(fd).size !== read
        || !Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('PERSONA_UNREADABLE', '角色卡不是可编辑的文本文件');
      return { bytes, revision: digest('persona\0', source.file, '\0present\0', bytes) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { bytes: null, revision: digest('persona\0', source.file, '\0missing') };
      if (error instanceof PanelLibraryError) throw error;
      fail('PERSONA_UNREADABLE', '无法读取当前角色卡');
    } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }

  #personaView(source, state) {
    return { text: state.bytes?.toString('utf8') || '', revision: state.revision,
      configured: state.bytes !== null, sourceLabel: display(path.basename(source.file), 240),
      editable: true, appliesNextTurn: true,
      ...(Number.isInteger(source.role.maxChars) && source.role.maxChars > 0 ? { injectionMaxChars: source.role.maxChars } : {}) };
  }

  async persona() {
    const source = this.#role();
    if (!source) return { text: '', revision: null, configured: false, sourceLabel: '', editable: false, appliesNextTurn: false };
    return this.#personaView(source, this.#readRole(source));
  }

  async savePersona(input) {
    // All operations after admission are synchronous; no awaited preparation can outlive owner revocation.
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['text', 'revision'].includes(key))
      || !own(input, 'text') || typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX_PERSONA || input.text.includes('\0')) {
      fail('INVALID_PERSONA', '角色卡必须为不超过 128 KiB 的文本');
    }
    if (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) fail('CONFLICT', '请先读取当前角色卡后再保存');
    const source = this.#role();
    if (!source) fail('UNAVAILABLE', '当前角色卡尚未就绪');
    const before = this.#readRole(source);
    if (before.revision !== input.revision) fail('CONFLICT', '角色卡已被其他操作修改，请重新读取');
    const bytes = Buffer.from(input.text);
    if (before.bytes?.equals(bytes)) return { ...this.#personaView(source, before), backupCreated: false };
    const directory = path.dirname(source.file), lockPath = source.file + '.panel.lock';
    let lock, temporary, committed = false, backupCreated = false;
    const write = (file, content) => {
      const handle = fs.openSync(file, 'wx', 0o600);
      try { fs.fchmodSync(handle, 0o600); fs.writeFileSync(handle, content); fs.fsyncSync(handle); }
      finally { fs.closeSync(handle); }
    };
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { lock = fs.openSync(lockPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('BUSY', '另一个角色卡保存正在进行'); throw error; }
      const current = this.#readRole(source);
      if (current.revision !== input.revision) fail('CONFLICT', '角色卡已被其他操作修改，请重新读取');
      if (current.bytes !== null) {
        write(source.file + `.bak-${Date.now()}-${randomUUID()}`, current.bytes);
        backupCreated = true;
      }
      temporary = path.join(directory, `.${path.basename(source.file)}.${randomUUID()}.tmp`);
      write(temporary, bytes);
      if (this.#readRole(source).revision !== input.revision) fail('CONFLICT', '角色卡已被其他操作修改，请重新读取');
      fs.renameSync(temporary, source.file);
      temporary = undefined;
      committed = true;
      try {
        const prefix = path.basename(source.file) + '.bak-';
        const stale = fs.readdirSync(directory)
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(5);
        for (const entry of stale) fs.unlinkSync(path.join(directory, entry.name));
      } catch {}
      source.role.cache = null;
      source.role.cacheAt = 0;
      const dirFd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      return { ...this.#personaView(source, { bytes, revision: digest('persona\0', source.file, '\0present\0', bytes) }), backupCreated };
    } catch (error) {
      if (committed) fail('SAVE_UNCERTAIN', '角色卡可能已保存，请重新读取确认');
      if (error instanceof PanelLibraryError) throw error;
      fail('PERSONA_WRITE_FAILED', '角色卡保存未完成，原文件未替换');
    } finally {
      if (temporary) try { fs.unlinkSync(temporary); } catch {}
      if (lock !== undefined) { try { fs.closeSync(lock); } catch {} try { fs.unlinkSync(lockPath); } catch {} }
    }
  }
}
