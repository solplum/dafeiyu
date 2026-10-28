import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class PublishError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

/** Reusable per-account journal. A process crash never grants another submit. */
export class PublishJournal {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.root).isSymbolicLink() || !fs.statSync(this.root).isDirectory()) throw new PublishError('INVALID_JOURNAL', '日志目录必须为专用本地目录');
    fs.chmodSync(this.root, 0o700);
  }
  file(id) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new PublishError('INVALID_ID', '稿件编号无效');
    return path.join(this.root, id + '.json');
  }
  read(id) {
    const file = this.file(id);
    if (fs.lstatSync(file).isSymbolicLink()) throw new PublishError('INVALID_JOURNAL', '日志文件不能为链接');
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (result.version !== 1 || result.id !== id || result.integrity !== hash(canonical(result.record))) throw new PublishError('INVALID_JOURNAL', '发布日志损坏，请人工核对');
    return structuredClone(result.record);
  }
  #write(id, record, initial = false) {
    const file = this.file(id), temporary = file + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, id, integrity: hash(canonical(record)), record }, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try {
      if (initial) fs.linkSync(temporary, file); else fs.renameSync(temporary, file);
      const directory = fs.openSync(this.root, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  create(id, record) {
    if (fs.existsSync(this.file(id))) return this.read(id);
    try { this.#write(id, record, true); return this.read(id); }
    catch (error) { if (error.code === 'EEXIST') return this.read(id); throw error; }
  }
  update(id, state, patch = {}) {
    const current = this.read(id);
    const next = { ...current, ...patch, state, updatedAt: new Date().toISOString(), history: [...current.history, { state, at: new Date().toISOString() }] };
    this.#write(id, next); return structuredClone(next);
  }
  async accountLock(platform, accountId, action) {
    const file = path.join(this.root, 'account-' + hash(platform + ':' + accountId) + '.lock');
    const token = randomUUID(); let fd, retain = false;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new PublishError('BUSY_OR_UNKNOWN', '该账号有操作或未确认的旧进程，请先人工核对'); throw error; }
    try {
      fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() })); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      const directory = fs.openSync(this.root, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      const result = await action();
      retain = result?.state === 'unknown';
      return result;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      // Never removes another process's lock and never expires a crash lock.
      if (!retain) { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch {} }
    }
  }
  claimFile(id) { this.file(id); return path.join(this.root, id + '.submit-once'); }
  uploadClaimFile(id) { this.file(id); return path.join(this.root, id + '.upload-once'); }
}
