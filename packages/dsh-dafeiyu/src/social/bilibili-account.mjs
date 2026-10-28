import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { allowed, deny, SocialAccountError } from './platforms.mjs';
import { digest } from './account-store.mjs';

const WORKER = fileURLToPath(new URL('./bilibili-worker.py', import.meta.url));
/** Independent credential directory; reuses the already pinned Python SDK,
 * never the anonymous MCP's state, browser cookies or upstream runtime. */
export class BilibiliAccountDriver {
  constructor({ python, directory, spawnWorker = spawn, stopGraceMs = 1500 } = {}) {
    this.python = python; this.directory = directory; this.spawnWorker = spawnWorker;
    this.pending = new Map(); this.child = null; this.closed = false;
    this.cleanupPending = false; this.stopGraceMs = stopGraceMs; this.stopping = new Map();
  }
  capabilities() { return Object.fromEntries(['profile', 'search', 'posts', 'comments', 'replies', 'inbox', 'messages', 'notifications', 'comment', 'reply', 'message', 'video']
    .map(key => [key, 'implemented-not-verified'])); }
  get idle() { return this.pending.size === 0 && !this.cleanupPending; }
  #rejectAll() {
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(new SocialAccountError('WORKER_UNKNOWN')); }
    this.pending.clear();
  }
  #stop(child) {
    if (!child || child !== this.child) return Promise.resolve(true);
    if (this.stopping.has(child)) return this.stopping.get(child);
    this.cleanupPending = true;
    const done = new Promise(resolve => {
      const hard = setTimeout(() => child.kill('SIGKILL'), this.stopGraceMs);
      const limit = setTimeout(() => { this.#rejectAll(); resolve(false); }, this.stopGraceMs * 2);
      child.once('close', () => { clearTimeout(hard); clearTimeout(limit); resolve(true); });
      child.kill('SIGTERM');
    });
    this.stopping.set(child, done); return done;
  }
  #start() {
    if (this.closed || this.cleanupPending || !path.isAbsolute(this.python || '') || !path.isAbsolute(this.directory || '') || !fs.existsSync(this.python)) deny('DRIVER_UNAVAILABLE');
    if (this.child) return;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) deny('INVALID_STORAGE'); fs.chmodSync(this.directory, 0o700);
    const child = this.spawnWorker(this.python, ['-I', '-B', WORKER, this.directory], { shell: false,
      env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8', TMPDIR: this.directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { void this.#stop(child); return; }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); let value;
        try { value = JSON.parse(line); } catch { void this.#stop(child); return; }
        const item = this.pending.get(value.id); if (!item) continue;
        if (this.cleanupPending) continue;
        this.pending.delete(value.id); item.cleanup();
        if (value.ok !== true) item.reject(new SocialAccountError(/^[A-Z_]{3,64}$/.test(value.code || '') ? value.code : 'WORKER_UNKNOWN'));
        else if (value.sdkVersion !== '17.4.2') item.reject(new SocialAccountError('SDK_VERSION_MISMATCH'));
        else item.resolve(value.result);
      }
    });
    child.stderr.on('data', () => {}); child.stdin.on('error', () => { void this.#stop(child); });
    child.on('error', () => { void this.#stop(child); });
    child.once('close', () => {
      this.#rejectAll(); this.stopping.delete(child);
      if (this.child === child) { this.child = null; this.cleanupPending = false; }
    });
  }
  async #call(method, input, { authorize, signal } = {}, timeout = 60000) {
    if (!allowed(authorize) || signal?.aborted) return Promise.reject(new SocialAccountError('FORBIDDEN'));
    this.#start(); const id = randomUUID(), child = this.child;
    return new Promise((resolve, reject) => {
      const stop = () => { void this.#stop(child); };
      const timer = setTimeout(stop, timeout); signal?.addEventListener('abort', stop, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
      this.pending.set(id, { resolve: value => { if (!allowed(authorize) || signal?.aborted) reject(new SocialAccountError('FORBIDDEN')); else resolve(value); }, reject, cleanup });
      if (!allowed(authorize) || signal?.aborted) { this.pending.delete(id); cleanup(); reject(new SocialAccountError('FORBIDDEN')); return; }
      try { child.stdin.write(JSON.stringify({ id, method, input }) + '\n'); }
      catch { stop(); }
    });
  }
  startLogin(context) { return this.#call('login/start', { sessionId: context.sessionId }, context); }
  checkLogin(context) { return this.#call('login/check', { sessionId: context.sessionId }, context); }
  account(context) { return this.#call('account', {}, context); }
  read(input, context) { return this.#call('read', input, context); }
  async preflight(input) {
    if (!['comment', 'reply', 'message', 'video'].includes(input.operation)) deny('OPERATION_UNAVAILABLE');
    if (input.operation === 'reply' && (!/^[1-9]\d{0,19}$/.test(input.rootId || '') || !/^[1-9]\d{0,19}$/.test(input.parentId || ''))) deny('INVALID_TARGET');
    if (input.operation === 'video' && (input.declaration !== 'none' || !input.cover || !input.tags?.length || !/^[1-9]\d{0,3}$/.test(input.category || '')))
      deny('VIDEO_METADATA_REQUIRED', 'B站投稿需要封面、标签、分区及已核验声明；未上传或发布。');
  }
  execute(input, context) { return this.#call('execute', { request: input, operationId: context.operationId,
    approvalDigest: context.approvalDigest, contentDigest: digest(input), claimFile: context.claimFile,
    accountId: context.accountId, media: context.media }, context, input.operation === 'video' ? 600000 : 60000); }
  async closeLogin() {
    if (!(await this.#stop(this.child))) deny('CLEANUP_UNCONFIRMED');
    fs.rmSync(path.join(this.directory, 'login-pending.private.json'), { force: true });
  }
  async dispose() {
    this.closed = true; const child = this.child;
    if (!(await this.#stop(child))) deny('CLEANUP_UNCONFIRMED');
  }
}
