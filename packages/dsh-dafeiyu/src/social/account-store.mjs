import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deny, uuid, accountId, writeRequest } from './platforms.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
const empty = () => ({ version: 1, accounts: {}, operations: {} });

/** Metadata and one-shot dispatch proofs. Cookies/passwords belong only to the
 * platform's private driver directory and never enter this public projection. */
export class SocialAccountStore {
  constructor(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) deny('INVALID_STORAGE');
    this.directory = path.resolve(directory); this.file = path.join(this.directory, 'accounts.json');
  }
  read() {
    let bytes;
    try {
      if (fs.lstatSync(this.directory).isSymbolicLink()) deny('STORAGE_INVALID');
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) deny('STORAGE_INVALID');
        bytes = fs.readFileSync(fd); if (bytes.length > 2 * 1024 * 1024) deny('STORAGE_INVALID');
      } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code === 'ENOENT') return { state: empty(), revision: digest('absent') }; if (error.code === 'ELOOP') deny('STORAGE_INVALID'); throw error; }
    try {
      const state = JSON.parse(bytes);
      if (state.version !== 1 || !state.accounts || Array.isArray(state.accounts) || !state.operations || Array.isArray(state.operations)
        || Object.keys(state.accounts).some(key => !['bilibili', 'douyin', 'x'].includes(key)) || Object.keys(state.operations).length > 2000) deny('STORAGE_INVALID');
      for (const row of Object.values(state.accounts)) {
        if (!row || !['disconnected', 'bound', 'candidate', 'account-mismatch', 'login-pending', 'login-unknown', 'expired', 'verification-required', 'identity-binding-required'].includes(row.state)
          || !Number.isSafeInteger(row.generation) || row.generation < 0 || row.accountId && !accountId(row.accountId)
          || row.name !== undefined && typeof row.name !== 'string' || row.loginSession && !uuid(row.loginSession)
          || row.candidate && (!accountId(row.candidate.accountId) || typeof row.candidate.name !== 'string')
          || row.activeOperation && !uuid(row.activeOperation)) deny('STORAGE_INVALID');
      }
      for (const [id, row] of Object.entries(state.operations)) {
        if (!uuid(id) || row?.id !== id || !accountId(row.accountId) || !Number.isSafeInteger(row.generation)
          || !['draft', 'approved', 'dispatching', 'unknown', 'sent'].includes(row.state) || !/^[a-f0-9]{64}$/.test(row.approvalDigest || '')) deny('STORAGE_INVALID');
        writeRequest(row.platform, row.request);
        if (row.origin !== undefined || row.autonomousInteraction !== undefined) {
          const own = row.autonomousInteraction;
          if (row.origin !== 'autonomy' || row.platform !== 'douyin' || !['like', 'follow', 'comment'].includes(row.request.operation)
            || !own || typeof own !== 'object' || Array.isArray(own)
            || Object.keys(own).sort().join(',') !== 'activityId,expectedVideoId,semanticDigest'
            || !/^auto-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(own.activityId || '')
            || !/^media-[a-f0-9]{64}$/.test(own.expectedVideoId || '') || !/^[a-f0-9]{64}$/.test(own.semanticDigest || '')
            || own.semanticDigest !== digest(['autonomous-douyin-interaction', row.accountId, row.request.operation, row.request.target])
            || row.request.operation !== 'follow' && own.expectedVideoId !== 'media-' + digest(['platform-video-id', row.request.target])
            || !['dispatching', 'unknown', 'sent'].includes(row.state)) deny('STORAGE_INVALID');
        }
      }
      return { state, revision: digest(bytes) };
    } catch { deny('STORAGE_INVALID'); }
  }
  transact(change, { revision, authorize = () => false } = {}) {
    if (authorize() !== true) deny('FORBIDDEN');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) deny('INVALID_STORAGE');
    fs.chmodSync(this.directory, 0o700);
    const lock = path.join(this.directory, '.write-lock'), token = randomUUID();
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') deny('STORAGE_BUSY'); throw error; }
    try {
      fs.writeFileSync(fd, token); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      const current = this.read();
      if (revision !== undefined && revision !== current.revision) deny('CONFLICT');
      const state = structuredClone(current.state), result = change(state);
      if (result && typeof result.then === 'function') deny('INVALID_TRANSACTION');
      if (authorize() !== true) deny('FORBIDDEN');
      const text = JSON.stringify(state);
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) deny('STORAGE_CAPACITY');
      const tmp = this.file + '.' + token + '.tmp';
      const out = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(out, text); fs.fsyncSync(out); } finally { fs.closeSync(out); }
      try {
        if (authorize() !== true) deny('FORBIDDEN');
        fs.renameSync(tmp, this.file);
        const dir = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      } finally { fs.rmSync(tmp, { force: true }); }
      return { result: structuredClone(result), revision: digest(text) };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
    }
  }
  privateDirectory(platform) {
    if (!['bilibili', 'douyin', 'x'].includes(platform)) deny('INVALID_PLATFORM');
    return path.join(this.directory, platform);
  }
}
