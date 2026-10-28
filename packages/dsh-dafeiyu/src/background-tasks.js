import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const EXECUTORS = new Set(['auto', 'native', 'codex', 'zcode', 'minimax']);
const WRITERS = new Set(['native', 'codex']);
const STATUS = { queued: '排队中', running: '执行中', cancelling: '正在停止', succeeded: '已完成', failed: '失败', cancelled: '已取消', unknown: '执行结果待核实' };
const ERROR = { unavailable: '执行器尚未就绪，未派发任务。', 'invalid-result': '执行已结束，但没有生成可确认的结果说明。',
  'context-required': '上下文接近容量保护线，后续模型调用已暂停；原任务未自动重跑。',
  'context-compaction-failed': '上下文压缩未完成，后续模型调用已暂停；原任务未自动重跑。',
  'context-guard-unavailable': '上下文容量暂时无法确认，后续模型调用已暂停；原任务未自动重跑。',
  'login-required': '执行器认证失败，请先在对应执行器登录，再检查连通；本次执行结果仍需核实。',
  'access-policy': '执行器权限被拒绝，请检查权限设置；部分操作可能已执行，请先核实。',
  quota: '执行器额度不足或受到限流，请稍后再试；部分操作可能已执行，请先核实。',
  limit: '执行器额度不足或受到限流，请稍后再试；部分操作可能已执行，请先核实。',
  transport: '执行器通信失败；部分操作可能已执行，请先核实。',
  service: '执行器服务暂时异常；部分操作可能已执行，请先核实。',
  'product-error': '执行器未能正常完成任务；部分操作可能已执行，请先核实。',
  'no-result': '执行已结束，但没有生成可确认的结果说明。',
  'cancel-unconfirmed': '已请求停止，但尚未确认执行器已终止；可能仍有操作发生，请先核实。',
  interrupted: '服务曾中断；没有重新执行此任务。', cancelled: '已停止后续执行；已经发生的操作不会自动撤销。',
  timeout: '任务超时，已请求停止；部分操作可能已执行，请先核实。', execution: '执行未能正常结束；部分操作可能已执行，请先核实。' };
const scopeKey = (scope) => `${scope.selfId}:${scope.peerId}:${scope.identityId}`;
const validScope = (s) => s && /^[1-9]\d{0,19}$/.test(s.selfId) && /^[1-9]\d{0,19}$/.test(s.peerId)
  && s.selfId !== s.peerId && /^[A-Za-z0-9_-]{1,48}$/.test(s.identityId);
const clip = (v, n) => Array.from(String(v ?? '')).slice(0, n).join('');
const digest = (bytes) => createHash('sha256').update(bytes ?? 'missing').digest('hex');
const fault = (code, message) => Object.assign(new Error(message), { code });
const safeFacts = (facts) => {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return undefined;
  const selected = {};
  if (['initialize', 'thread-start', 'turn-start', 'turn', 'teardown', 'process'].includes(facts.stage)) selected.stage = facts.stage;
  if (['unknown', 'transport', 'product-error', 'limit', 'service', 'access-policy', 'invalid-result', 'process'].includes(facts.category)) selected.category = facts.category;
  if (Number.isInteger(facts.httpStatus) && facts.httpStatus >= 100 && facts.httpStatus <= 599) selected.httpStatus = facts.httpStatus;
  return Object.keys(selected).length ? selected : undefined;
};
const canonicalDirectory = (cwd) => {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw fault('INVALID_TASK', '任务目录必须是存在的绝对目录');
  try {
    const real = fs.realpathSync(cwd);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
    return real;
  } catch { throw fault('INVALID_TASK', '任务目录不存在或不是目录，未派发'); }
};
const overlaps = (left, right) => {
  const contains = (parent, child) => { const relative = path.relative(parent, child);
    return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  return contains(left, right) || contains(right, left);
};

/** A durable dispatch ledger, not a replay queue. A launch proof is written
 * before execution, and a send proof before delivery. Unknown work is never retried. */
export class BackgroundTaskManager {
  constructor({ storeFile, executors = {}, deliver, isAuthorized = () => false, maxConcurrent = 2,
    maxPending = 12, maxRecords = 1024, taskTimeoutMs = 30 * 60 * 1000, externalRouting = true,
    defaultCwd, now = () => Date.now() } = {}) {
    if (!path.isAbsolute(storeFile || '') || typeof deliver !== 'function') throw new Error('后台任务需要固定存储路径和回传通道');
    Object.assign(this, { storeFile, executors, deliver, isAuthorized, defaultCwd, now, externalRouting });
    this.legacyDefaultCwd = defaultCwd;
    this.defaultCwd = canonicalDirectory(defaultCwd === undefined ? process.cwd() : defaultCwd);
    this.maxConcurrent = Math.max(1, Math.min(4, maxConcurrent));
    this.maxPending = Math.max(1, Math.min(64, maxPending));
    this.maxRecords = Math.max(1, Math.min(2048, maxRecords));
    this.taskTimeoutMs = Math.max(10, Math.min(3600000, taskTimeoutMs));
    this.jobs = new Map(); this.work = new Map(); this.running = 0; this.closed = false;
    this.scheduled = false; this.sends = new Map(); this.writeLocks = new Map(); this.fault = ''; this.revision = digest(null);
    try { this.load(); } catch { this.fault = 'storage_invalid'; }
  }
  iso() { return new Date(this.now()).toISOString(); }
  readBytes() {
    try {
      const st = fs.lstatSync(this.storeFile);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 4 * 1024 * 1024) throw new Error('invalid ledger');
      return fs.readFileSync(this.storeFile);
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  load() {
    const bytes = this.readBytes(); this.revision = digest(bytes);
    if (!bytes) return;
    const data = JSON.parse(bytes.toString('utf8'));
    if (data.version !== 1 || !Array.isArray(data.jobs) || data.jobs.length > this.maxRecords) throw new Error('invalid ledger');
    let changed = false;
    for (const job of data.jobs) {
      if (!job || !/^dfy-[a-f0-9]{16}$/.test(job.id) || this.jobs.has(job.id) || !validScope(job.scope)
        || !/^[a-f0-9]{64}$/.test(job.key) || !(ACTIVE.has(job.status) || TERMINAL.has(job.status))
        || !EXECUTORS.has(job.executor) || !['pending', 'sending', 'sent', 'failed', 'unknown'].includes(job.delivery)
        || typeof job.title !== 'string' || job.title.length > 160 || typeof job.text !== 'string' || job.text.length > 24000
        || typeof job.createdAt !== 'string' || job.readOnly !== undefined && typeof job.readOnly !== 'boolean'
        || job.probe !== undefined && typeof job.probe !== 'boolean'
        || job.control !== undefined && !['desktop','browser'].includes(job.control)) throw new Error('invalid ledger');
      if (job.cwd === undefined) { job.cwd = this.defaultCwd; changed = true; }
      if (typeof job.cwd !== 'string' || !path.isAbsolute(job.cwd) || path.resolve(job.cwd) !== job.cwd || job.cwd.includes('\0')
        || job.requiresVerification !== undefined && typeof job.requiresVerification !== 'boolean') throw new Error('invalid workspace ledger');
      if (ACTIVE.has(job.status)) {
        job.status = job.status === 'queued' ? 'cancelled' : 'unknown'; job.errorCode = 'interrupted';
        job.requiresVerification = job.status === 'unknown'; job.waitingForWorkspace = false;
        job.finishedAt = this.iso(); job.delivery = 'pending'; changed = true;
      }
      if (job.requiresVerification === undefined) { job.requiresVerification = job.status === 'unknown'; changed = true; }
      if (job.requiresVerification && job.status !== 'unknown') throw new Error('invalid workspace protection');
      if (job.diagnosticFacts !== undefined) {
        const selected = safeFacts(job.diagnosticFacts);
        if (JSON.stringify(selected) !== JSON.stringify(job.diagnosticFacts)) {
          if (selected) job.diagnosticFacts = selected; else delete job.diagnosticFacts; changed = true;
        }
      }
      if (job.delivery === 'sending') { job.delivery = 'unknown'; changed = true; }
      this.jobs.set(job.id, job);
    }
    if (changed) this.save();
  }
  save() {
    if (this.fault) throw fault('STORAGE_UNAVAILABLE', '任务记录不可用，未重新派发');
    const dir = path.dirname(this.storeFile), lock = this.storeFile + '.lock';
    let fd, temporary;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fd = fs.openSync(lock, 'wx', 0o600);
      if (digest(this.readBytes()) !== this.revision) throw new Error('ledger conflict');
      const bytes = Buffer.from(JSON.stringify({ version: 1, jobs: [...this.jobs.values()] }));
      if (bytes.length > 4 * 1024 * 1024) throw new Error('ledger full');
      temporary = this.storeFile + '.' + randomUUID() + '.tmp';
      const out = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(out, bytes); fs.fsyncSync(out); } finally { fs.closeSync(out); }
      fs.renameSync(temporary, this.storeFile); temporary = null;
      const directoryFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      this.revision = digest(bytes);
    } catch { this.fault = 'storage_unavailable'; throw fault('STORAGE_UNAVAILABLE', '任务记录保存未确认，已停止新派发；不会自动重做'); }
    finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } if (fd !== undefined) { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} } }
  }
  assertScope(scope) {
    if (this.closed || this.fault) throw fault('UNAVAILABLE', '后台任务尚未就绪');
    if (!validScope(scope) || !this.isAuthorized(scope)) throw fault('FORBIDDEN', '当前账号或身份没有后台任务权限');
  }
  view(job) {
    const work = this.work.get(job.id);
    const conflict = job.status === 'queued' && work?.waitingForWorkspace && this.workspaceConflict(job.cwd, job.id);
    return { id: job.id, title: job.title, kind: job.probe === true ? 'connectivity-test' : job.probe === false ? 'task' : 'legacy-unknown',
      status: job.status, statusText: STATUS[job.status], executor: job.executor, readOnly: job.readOnly === true,
      ...(job.control ? { control: job.control } : {}),
      createdAt: job.createdAt, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
      progress: job.progress || '', text: job.text, error: job.status === 'succeeded' ? '' : ERROR[job.errorCode] || (job.status === 'failed' || job.status === 'unknown' ? ERROR.execution : ''),
      delivery: job.delivery, canCancel: ACTIVE.has(job.status) && job.status !== 'cancelling',
      ...(safeFacts(job.diagnosticFacts) ? { diagnosticFacts: safeFacts(job.diagnosticFacts) } : {}),
      requiresVerification: job.requiresVerification === true, waitingForWorkspace: Boolean(conflict),
      workspaceReason: job.requiresVerification ? '旧执行器是否已停止尚未确认；此目录及父子目录的新写任务已暂停。'
        : conflict === 'unverified' ? '相同或父子目录有结果待核实的旧任务；确认旧执行器已停止后才能继续写入。'
          : conflict ? '相同或父子目录的任务正在执行或清理；等待目录释放。' : '' };
  }
  get(id, scope) {
    this.assertScope(scope);
    const job = this.jobs.get(id);
    if (!job || scopeKey(job.scope) !== scopeKey(scope)) throw fault('NOT_FOUND', '没有找到当前账号身份的任务');
    return this.view(job);
  }
  visibleJobs(scope) {
    const priority = (job) => job.requiresVerification ? 0 : ACTIVE.has(job.status) ? 1
      : job.delivery === 'unknown' ? 2 : ['pending', 'sending', 'failed'].includes(job.delivery) ? 3 : 4;
    // Scope admission precedes the display limit; unresolved work remains actionable
    // even after newer completed jobs fill the recent-history portion of the panel.
    return [...this.jobs.values()].filter((job) => !scope || scopeKey(job.scope) === scopeKey(scope)).reverse()
      .sort((left, right) => priority(left) - priority(right)).slice(0, 64);
  }
  list(scope) {
    this.assertScope(scope);
    return this.visibleJobs(scope).map((j) => this.view(j));
  }
  get status() {
    return { ready: !this.closed && !this.fault, busy: this.running > 0 || this.sends.size > 0 || [...this.jobs.values()].some((j) => ACTIVE.has(j.status)), active: [...this.jobs.values()].filter((j) => ACTIVE.has(j.status)).length,
      running: this.running, queued: [...this.jobs.values()].filter((j) => j.status === 'queued').length,
      pendingDelivery: [...this.jobs.values()].filter((j) => TERMINAL.has(j.status) && j.delivery === 'pending').length,
      deliveryUnknown: [...this.jobs.values()].filter((j) => j.delivery === 'unknown').length,
      workspacesRequiringVerification: [...this.jobs.values()].filter((j) => j.requiresVerification === true).length,
      tasks: this.visibleJobs().map((j) => ({ ...this.view(j), scope: { ...j.scope } })) };
  }
  async submit({ scope, originId, prompt, title = '后台任务', difficulty = 'normal', executor = 'auto', parent, cwd, probe = false, readOnly = false, control } = {}) {
    this.assertScope(scope);
    if (typeof originId !== 'string' || !/^-?[1-9]\d{0,39}$/.test(originId) || typeof prompt !== 'string'
      || !prompt.trim() || prompt.length > 16000 || typeof title !== 'string' || !title.trim() || title.length > 160
      || !['simple', 'normal', 'hard'].includes(difficulty) || !EXECUTORS.has(executor) || typeof readOnly !== 'boolean'
      || control !== undefined && !['desktop','browser'].includes(control)) throw fault('INVALID_TASK', '后台任务参数无效');
    if (control && !['auto','native'].includes(executor)) throw fault('INVALID_TASK', '界面任务需使用 DSH 原生子 Agent；不会转交其他执行器重复执行。');
    if (control) executor = 'native';
    const legacyCwd = cwd === undefined ? this.legacyDefaultCwd : cwd;
    cwd = canonicalDirectory(cwd === undefined ? this.defaultCwd : cwd);
    const keyFor = (directory) => digest(JSON.stringify([scopeKey(scope), originId, prompt.trim(), directory]));
    const key = keyFor(cwd), id = 'dfy-' + key.slice(0, 16);
    for (const candidate of new Set([key, keyFor(legacyCwd || '')])) {
      const existing = this.jobs.get('dfy-' + candidate.slice(0, 16));
      if (existing) { if (existing.key !== candidate) throw fault('CONFLICT', '任务编号冲突，未派发'); return { ...this.view(existing), duplicate: true }; }
    }
    readOnly = readOnly || probe === true;
    if (['zcode', 'minimax'].includes(executor) && !readOnly)
      throw fault('INVALID_TASK', 'Z Code 和 MiniMax 当前只支持明确声明的只读任务；需要写入或修改时请选择原生或 Codex 执行器。');
    if (this.jobs.size >= this.maxRecords || this.status.active >= this.maxPending) throw fault('QUEUE_FULL', '后台任务队列或记录已满，请先处理现有任务');
    const job = { id, key, scope: { selfId: scope.selfId, peerId: scope.peerId, identityId: scope.identityId },
      title: title.trim(), difficulty, executor, cwd, readOnly, ...(control ? { control } : {}), requiresVerification: false,
      probe: probe === true, status: 'queued', createdAt: this.iso(), text: '', delivery: 'pending' };
    this.jobs.set(id, job); this.work.set(id, { prompt: prompt.trim(), parent, cwd, requestedExecutor: executor,
      controller: new AbortController(), promise: null });
    this.save(); this.schedule();
    return this.view(job);
  }
  schedule() {
    if (this.scheduled || this.closed || this.fault) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const job of this.jobs.values()) {
        if (this.closed || this.fault || this.running >= this.maxConcurrent) break;
        if (job.status !== 'queued' || !this.work.has(job.id)) continue;
        const work = this.work.get(job.id);
        if (work.waitingForWorkspace && WRITERS.has(work.selected?.name) && this.workspaceConflict(job.cwd, job.id)) continue;
        // Reserve the slot before the async availability check.
        this.running++; job.status = 'running';
        try { this.save(); } catch { this.running--; break; }
        work.promise = this.execute(job, work).catch(() => {}).finally(() => {
          this.running--; this.writeLocks.delete(job.id);
          if (job.status !== 'queued' || !work.waitingForWorkspace) this.work.delete(job.id);
          this.schedule();
        });
      }
    });
  }
  async select(job, requestedExecutor = job.executor) {
    const candidates = requestedExecutor !== 'auto' ? [requestedExecutor] : job.difficulty === 'hard' ? ['codex', 'native']
      : this.externalRouting && job.readOnly === true && job.difficulty === 'simple' && this.running > 1 ? ['minimax', 'zcode', 'native'] : ['native', 'codex'];
    for (const name of candidates) {
      if (this.closed || job.status === 'cancelling') return null;
      const runner = this.executors[name];
      try {
        if (!runner) continue;
        const readiness = await runner.available();
        if (readiness?.available === true || job.probe && readiness?.installed === true) return { name, runner };
      } catch {}
    }
    return null;
  }
  async execute(job, work) {
    let timer;
    try {
      // Parked work keeps a name only for no-spin resource checks. Once free,
      // recheck provider health instead of bypassing a newly closed gate.
      const selected = await this.select(job, work.requestedExecutor);
      if (this.closed || work.controller.signal.aborted || job.status === 'cancelling') return this.finish(job, 'cancelled', '', 'cancelled');
      if (!this.isAuthorized(job.scope)) return this.finish(job, 'cancelled', '', 'cancelled');
      if (!selected) return this.finish(job, 'failed', '', 'unavailable');
      work.selected = selected; job.executor = selected.name;
      if (canonicalDirectory(job.cwd) !== job.cwd) return this.finish(job, 'failed', '', 'workspace-changed');
      if (WRITERS.has(selected.name)) {
        if (this.workspaceConflict(job.cwd, job.id)) {
          work.waitingForWorkspace = true; job.waitingForWorkspace = true; job.status = 'queued'; job.startedAt = null;
          job.progress = '等待相同或父子目录的任务完成清理或人工核实'; this.save(); return;
        }
        this.writeLocks.set(job.id, job.cwd);
      }
      work.waitingForWorkspace = false; job.waitingForWorkspace = false;
      job.startedAt = this.iso(); job.progress = '已派发，等待执行器返回结果'; this.save();
      timer = setTimeout(() => { work.timedOut = true; work.controller.abort(); }, this.taskTimeoutMs); timer.unref?.();
      work.dispatched = true;
      const result = await selected.runner.run({ id: job.id, prompt: work.prompt, cwd: work.cwd, parent: work.parent, probe: job.probe === true, readOnly: job.readOnly === true,
        scope: Object.freeze({ selfId: job.scope.selfId, peerId: job.scope.peerId, identityId: job.scope.identityId }),
        ...(job.control ? { control: job.control } : {}),
        signal: work.controller.signal, onProgress: (event) => {
          if (ACTIVE.has(job.status) && !this.closed) job.progress = clip(event?.text || '执行器正在处理', 160);
        } });
      const diagnosticFacts = safeFacts(result?.diagnosticFacts);
      if (diagnosticFacts) job.diagnosticFacts = diagnosticFacts;
      if (work.timedOut) return this.finish(job, 'unknown', '', 'timeout');
      if (job.status === 'cancelling' || this.closed) return this.finish(job, result?.status === 'unknown' ? 'unknown' : 'cancelled', '', result?.status === 'unknown' ? 'cancel-unconfirmed' : 'cancelled');
      const status = TERMINAL.has(result?.status) ? result.status : 'unknown';
      const text = typeof result?.text === 'string' ? clip(result.text.trim(), 10000) : '';
      return this.finish(job, status === 'succeeded' && !text ? 'failed' : status, status === 'succeeded' ? text : '',
        status === 'succeeded' && text ? undefined : status === 'succeeded' && !text || result?.errorCode === 'no-result' ? 'invalid-result' : result?.errorCode || 'execution');
    } catch { if (!this.fault) this.finish(job, work.controller.signal.aborted || work.dispatched ? 'unknown' : 'failed', '', work.timedOut ? 'timeout' : 'execution'); }
    finally { clearTimeout(timer); }
  }
  finish(job, status, text, errorCode) {
    if (TERMINAL.has(job.status)) return;
    job.status = status; job.text = text; job.errorCode = errorCode; job.finishedAt = this.iso(); job.progress = '';
    job.waitingForWorkspace = false; job.requiresVerification = status === 'unknown';
    this.save();
    if (!this.closed) void this.send(job).catch(() => {});
  }
  async cancel(id, scope) {
    this.get(id, scope);
    const job = this.jobs.get(id);
    if (job.status === 'queued') { this.work.get(id)?.controller.abort(); this.work.delete(id); this.finish(job, 'cancelled', '', 'cancelled'); }
    else if (job.status === 'running') { job.status = 'cancelling'; this.save(); this.work.get(id)?.controller.abort(); }
    return this.view(job);
  }
  workspaceConflict(cwd, ignoredId) {
    for (const job of this.jobs.values()) if (job.id !== ignoredId && job.requiresVerification === true && overlaps(cwd, job.cwd)) return 'unverified';
    for (const [id, locked] of this.writeLocks) if (id !== ignoredId && overlaps(cwd, locked)) return 'busy';
    return '';
  }
  /** Only an explicit, authorized human confirmation may call this method.
   * It releases directory protection, never reruns or changes the old result. */
  async acknowledge(id, scope) {
    this.get(id, scope);
    const job = this.jobs.get(id);
    if (job.status !== 'unknown') throw fault('INVALID_TASK', '该任务没有待核实的目录保护');
    if (job.requiresVerification) {
      job.requiresVerification = false; job.workspaceVerifiedAt = this.iso(); this.save(); this.schedule();
    }
    return this.view(job);
  }
  resultMessage(job) {
    const body = job.status === 'succeeded' ? clip(job.text, 1300) : ERROR[job.errorCode] || ERROR.execution;
    return `后台任务 ${job.id}｜${job.title}\n${STATUS[job.status]}\n${body}${job.text.length > 1300 ? '\n完整结果可发送“查询任务 ' + job.id + '”。' : ''}`;
  }
  async send(job) {
    if (this.sends.has(job.id)) return this.sends.get(job.id);
    if (this.closed || this.fault || !TERMINAL.has(job.status) || job.delivery !== 'pending' || !this.isAuthorized(job.scope)) return;
    const promise = (async () => {
      job.delivery = 'sending'; this.save();
      let receipt;
      try { receipt = await this.deliver(job.scope, this.resultMessage(job)); }
      catch { receipt = { ok: false, uncertain: true }; }
      job.delivery = receipt?.attempted === false ? 'pending' : receipt?.ok === true ? 'sent'
        : receipt?.ok === false && receipt?.uncertain === false ? 'failed' : 'unknown';
      if (receipt?.ok === true && receipt?.data?.message_id != null) job.receiptId = String(receipt.data.message_id);
      this.save();
    })();
    this.sends.set(job.id, promise);
    try { await promise; } finally { if (this.sends.get(job.id) === promise) this.sends.delete(job.id); }
  }
  async flushDeliveries() {
    for (const job of this.jobs.values()) if (TERMINAL.has(job.status) && job.delivery === 'pending') await this.send(job);
  }
  async cancelScope(scope) {
    for (const job of this.jobs.values()) if (scopeKey(job.scope) === scopeKey(scope) && ACTIVE.has(job.status)) await this.cancel(job.id, scope);
  }
  async dispose() {
    if (this.disposal) return this.disposal;
    this.closed = true;
    for (const job of this.jobs.values()) {
      if (job.status === 'queued') { job.status = 'cancelled'; job.errorCode = 'interrupted'; job.finishedAt = this.iso(); }
      if (job.status === 'running') job.status = 'cancelling';
      this.work.get(job.id)?.controller.abort();
    }
    try { this.save(); } catch {}
    this.disposal = Promise.allSettled([...this.work.values()].map((w) => w.promise).filter(Boolean).concat([...this.sends.values()]));
    return this.disposal;
  }
}
