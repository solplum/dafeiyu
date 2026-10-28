import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const CODES = new Set(['CONTEXT_CAPACITY_REQUIRED', 'CONTEXT_GUARD_UNAVAILABLE', 'CONTEXT_COMPACTION_FAILED']);
const FILE = 'desktop-context.private.json';
const LIMIT = 1024 * 1024;
const fault = code => Object.assign(new Error('桌面上下文操作未完成；原请求不会自动重跑'), { code });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clone = value => structuredClone(value);
const stamp = now => new Date(now()).toISOString();
const empty = agent => agent?.inbox && Array.isArray(agent.inbox.nextTurn) && Array.isArray(agent.inbox.nextStep)
  && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0 && agent.inbox.hasPending !== true;
const headerOf = agent => agent.session.requestHeader?.();
const checkpoint = agent => ({ seq: agent.session.seq, headerDigest: hash(headerOf(agent)) });
const sameCheckpoint = (agent, value) => agent.session.seq === value.seq && hash(headerOf(agent)) === value.headerDigest;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function validateState(value) {
  if (!plain(value) || value.version !== 1 || !uuid(value.revision) || !Array.isArray(value.sessions) || value.sessions.length > 4096) throw fault('CONTEXT_GUARD_UNAVAILABLE');
  const seen = new Set();
  for (const row of value.sessions) {
    if (!plain(row) || !id(row.sessionId) || seen.has(row.sessionId) || !Array.isArray(row.pending) || row.pending.length > 128
      || !Array.isArray(row.reviews) || row.reviews.length > 4096) throw fault('CONTEXT_GUARD_UNAVAILABLE');
    seen.add(row.sessionId);
    if (row.failure !== null && (!plain(row.failure) || !CODES.has(row.failure.code) || !uuid(row.failure.id)
      || !iso(row.failure.at) || !['guard', 'maintenance-migration'].includes(row.failure.kind)
      || row.failure.providerStarted !== undefined && typeof row.failure.providerStarted !== 'boolean'
      || !Number.isSafeInteger(row.failure.checkpoint?.seq) || row.failure.checkpoint.seq < 0 || !hex(row.failure.checkpoint.headerDigest))) throw fault('CONTEXT_GUARD_UNAVAILABLE');
    if (row.policy !== null && (!plain(row.policy) || !positive(row.policy.maxTokens) || row.policy.maxTokens > 8192 || !uuid(row.policy.revision))) throw fault('CONTEXT_GUARD_UNAVAILABLE');
    if (row.pending.some(p => !plain(p) || !uuid(p.id) || !iso(p.at) || !Number.isSafeInteger(p.seq) || p.seq < 0 || !hex(p.headerDigest))) throw fault('CONTEXT_GUARD_UNAVAILABLE');
    if (row.reviews.some(p => !hex(p))) throw fault('CONTEXT_GUARD_UNAVAILABLE');
  }
  return value;
}

/** One fixed private CAS file. Reads never initialize, repair, or write it. */
class DesktopContextState {
  constructor(directory, now = () => Date.now()) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fault('CONTEXT_GUARD_UNAVAILABLE');
    this.directory = directory; this.file = path.join(directory, FILE); this.now = now; this.loadedAt = stamp(now); this.live = new Set(); this.failed = false;
  }
  read() {
    if (this.failed) throw fault('CONTEXT_GUARD_UNAVAILABLE');
    try {
      if (fs.existsSync(this.file + '.pending')) throw fault('CONTEXT_GUARD_UNAVAILABLE');
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT || stat.mode & 0o077
        || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw fault('CONTEXT_GUARD_UNAVAILABLE');
      return validateState(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch { throw fault('CONTEXT_GUARD_UNAVAILABLE'); }
  }
  row(state, sessionId, create = false) {
    let row = state.sessions.find(value => value.sessionId === sessionId);
    if (!row && create) { row = { sessionId, failure: null, policy: null, pending: [], reviews: [] }; state.sessions.push(row); }
    return row;
  }
  transaction(expectedRevision, change, { initialize = false } = {}) {
    let lock, temp;
    try {
      const dir = fs.lstatSync(this.directory);
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw fault('CONTEXT_GUARD_UNAVAILABLE');
      lock = fs.openSync(this.file + '.lock', 'wx', 0o600);
      if (fs.existsSync(this.file + '.pending')) throw fault('CONTEXT_GUARD_UNAVAILABLE');
      let state;
      if (initialize && !fs.existsSync(this.file)) state = { version: 1, revision: randomUUID(), sessions: [] };
      else state = this.read();
      if (expectedRevision !== undefined && state.revision !== expectedRevision) throw fault('CONFLICT');
      const result = change(state);
      state.revision = randomUUID(); validateState(state);
      const text = JSON.stringify(state) + '\n';
      if (Buffer.byteLength(text) > LIMIT) throw fault('CONTEXT_GUARD_UNAVAILABLE');
      // A crash or a failed publication must never turn a failed recovery into an open session.
      // This marker is removed only after the new state and directory are fsynced.
      const intent = fs.openSync(this.file + '.pending', 'wx', 0o600);
      try { fs.writeFileSync(intent, state.revision); fs.fsyncSync(intent); } finally { fs.closeSync(intent); }
      const journalDirectory = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(journalDirectory); } finally { fs.closeSync(journalDirectory); }
      temp = this.file + '.' + randomUUID() + '.tmp';
      const out = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(out, text); fs.fsyncSync(out); } finally { fs.closeSync(out); }
      fs.renameSync(temp, this.file); temp = undefined;
      const handle = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      // No fallible publication work follows this commit point. An unflushed unlink
      // can only restore a conservative hold after a crash.
      fs.unlinkSync(this.file + '.pending');
      return { result, revision: state.revision };
    } catch (error) {
      if (['CONFLICT', 'FORBIDDEN', 'BUSY'].includes(error?.code)) throw error;
      if (error?.code === 'EEXIST') throw fault('BUSY');
      this.failed = true; throw fault('CONTEXT_GUARD_UNAVAILABLE');
    } finally {
      if (temp) try { fs.unlinkSync(temp); } catch {}
      if (lock !== undefined) { fs.closeSync(lock); try { fs.unlinkSync(this.file + '.lock'); } catch {} }
    }
  }
  failure(agent) {
    const row = this.row(this.read(), agent.id);
    // Existing trusted desktops may have an old closure-only failure. Absence
    // of a migration record is never evidence that the old session was clear.
    if (!row) return { id: hash(agent.id), code: 'CONTEXT_GUARD_UNAVAILABLE', kind: 'unreviewed-migration',
      at: this.loadedAt, checkpoint: checkpoint(agent) };
    if (row?.failure) return clone(row.failure);
    const pending = row?.pending.find(value => !this.live.has(value.id));
    return pending ? { id: pending.id, code: 'CONTEXT_GUARD_UNAVAILABLE', kind: 'interrupted-admission', at: pending.at,
      checkpoint: { seq: pending.seq, headerDigest: pending.headerDigest } } : null;
  }
  recordFailure(agent, value) {
    const result = this.transaction(undefined, state => {
      const row = this.row(state, agent.id, true), old = row.failure;
      row.failure = { id: old?.id || randomUUID(), code: old?.code || value.code, at: old?.at || value.at,
        kind: old?.kind || 'guard', checkpoint: old?.checkpoint || checkpoint(agent),
        ...(value.providerStarted !== undefined || old?.providerStarted !== undefined
          ? { providerStarted: old?.providerStarted === true || value.providerStarted === true } : {}) };
      return clone(row.failure);
    });
    return result.result;
  }
  begin(agent) {
    const value = { id: randomUUID(), at: stamp(this.now), ...checkpoint(agent) };
    this.transaction(undefined, state => this.row(state, agent.id, true).pending.push(value));
    this.live.add(value.id); return value.id;
  }
  end(agent, admissionId) {
    if (!admissionId) return;
    this.transaction(undefined, state => {
      const row = this.row(state, agent.id);
      if (!row?.pending.some(value => value.id === admissionId)) throw fault('CONFLICT');
      row.pending = row.pending.filter(value => value.id !== admissionId);
    });
    this.live.delete(admissionId);
  }
  assertPolicy(agent, options) {
    const cap = this.row(this.read(), agent.id)?.policy?.maxTokens;
    if (cap !== undefined && (!positive(options.maxTokens) || options.maxTokens > cap)) throw fault('CONTEXT_GUARD_UNAVAILABLE');
  }
  review(agent, failure, { revision, maxTokens } = {}) {
    return this.transaction(revision, state => {
      const row = this.row(state, agent.id);
      if (!row || hash(row.failure) !== hash(failure) || row.pending.length) throw fault('CONFLICT');
      // Persist the reviewed failure before clearing it. Orphan proofs never grant admission.
      const proof = { version: 1, sessionDigest: hash(agent.id), failure: row.failure, checkpoint: checkpoint(agent),
        maxTokens: maxTokens ?? row.policy?.maxTokens ?? null, at: stamp(this.now), automaticReplay: false };
      const proofDigest = hash(proof), target = path.join(this.directory, 'context-review-' + proofDigest + '.private.json');
      const out = fs.openSync(target, 'wx', 0o400);
      try { fs.writeFileSync(out, JSON.stringify(proof) + '\n'); fs.fsyncSync(out); } finally { fs.closeSync(out); }
      row.reviews.push(proofDigest); row.failure = null;
      if (maxTokens !== undefined) row.policy = { maxTokens, revision: randomUUID() };
    }).revision;
  }
}

/** Explicit owner maintenance migration; never an export of an old guard's private latch. */
export function writeDesktopContextMaintenanceHold(input, { authorize = () => false, now = () => Date.now() } = {}) {
  if (!authorize() || input?.acknowledgeNoReplay !== true) throw fault('FORBIDDEN');
  const { directory, sessionId, expectedSeq, header, capacityEvidence } = input;
  const events = input.events?.map(value => value.event ?? value);
  if (!id(sessionId) || !Number.isSafeInteger(expectedSeq) || expectedSeq < 1 || !plain(header?.config)
    || !id(header.config.provider) || !id(header.config.model) || !positive(header.config.maxTokens)
    || !Array.isArray(events) || !events.length || events.length > 4096 || !positive(capacityEvidence?.contextWindow)
    || !Number.isSafeInteger(capacityEvidence?.inputTokens) || capacityEvidence.inputTokens < 0
    || capacityEvidence.outputTokens !== header.config.maxTokens
    || capacityEvidence.inputTokens + capacityEvidence.outputTokens <= Math.floor(capacityEvidence.contextWindow * 0.9)) throw fault('INVALID_PATCH');
  const last = events.at(-1), start = events.findLast(value => value.type === 'turn/start');
  const error = last?.data?.reason?.error;
  if (last?.seq !== expectedSeq - 1 || last.type !== 'turn/end' || last.data?.reason?.kind !== 'error'
    || !start || start.seq >= last.seq || !['UNKNOWN', 'CONTEXT_CAPACITY_REQUIRED'].includes(error?.code)
    || error?.message !== '上下文保护已暂停后续模型调用；原请求未自动重跑'
    || events.some(value => value.seq > start.seq && ['tool/call', 'tool/result'].includes(value.type))) throw fault('INVALID_PATCH');
  const loggedHeader = events.findLast(value => value.type === 'request/header')?.data?.header;
  if (loggedHeader && hash(loggedHeader) !== hash(header)) throw fault('CONFLICT');
  const store = new DesktopContextState(directory, now);
  return store.transaction(undefined, state => {
    if (!authorize()) throw fault('FORBIDDEN');
    const row = store.row(state, sessionId, true);
    if (row.failure || row.pending.length) throw fault('CONFLICT');
    row.failure = { id: randomUUID(), code: 'CONTEXT_CAPACITY_REQUIRED', at: stamp(now), kind: 'maintenance-migration',
      checkpoint: { seq: expectedSeq, headerDigest: hash(header) } };
    return { held: true, holdKind: 'maintenance-migration', automaticReplay: false };
  }, { initialize: true }).result;
}

/** Owner-only desktop output policy. No model calls, inbox writes or header writes. */
export function createDesktopContextControl({ ctx, directory, trustedSessionIds = [], getExecutionContext,
  isOpen = () => true, now = () => Date.now() } = {}) {
  const store = new DesktopContextState(directory, now), trusted = new Set(trustedSessionIds), previews = new Map();
  let guard, closed = false, active = false;
  // Load before registering any request hook. A missing/corrupt file stays fail closed.
  try { store.read(); } catch { store.failed = true; }
  const actual = sessionId => {
    const agents = ctx.get?.('agents'), agent = agents?.get?.(sessionId);
    const identity = agent ? getExecutionContext?.({ agent }) : null;
    if (!trusted.has(sessionId) || !agent || agents.get(agent.id) !== agent || agent.id !== sessionId
      || agent.session?.id !== sessionId || agent.session?.header?.id !== sessionId
      || agent.session.header.origin === 'subagent' || identity?.isOwner !== true || identity?.scope !== 'desktop' || identity?.trusted !== true) throw fault('FORBIDDEN');
    return agent;
  };
  const owned = agent => !closed && isOpen() && actual(agent.id) === agent;
  const authorized = (agent, authorize) => {
    if (!authorize() || !owned(agent)) throw fault('FORBIDDEN');
    if (!empty(agent)) throw fault('BUSY');
  };
  const inMaintenance = async (agent, authorize, fn) => {
    authorized(agent, authorize);
    if (active || agent.status !== 'idle' || typeof agent.runMaintenance !== 'function') throw fault('BUSY');
    active = true;
    try { return await agent.runMaintenance(async () => { authorized(agent, authorize); return await fn(); }); }
    finally { active = false; }
  };
  const read = agent => {
    const state = store.read(), row = store.row(state, agent.id);
    return { state, row, failure: guard.failureFor(agent) };
  };
  const requestListener = async ({ agent, signal }, next) => {
    const config = await next();
    if (!trusted.has(agent?.id)) return config;
    if (getExecutionContext?.({ agent })?.scope !== 'desktop') return config;
    if (signal?.aborted || !owned(agent)) throw fault('CONTEXT_GUARD_UNAVAILABLE');
    const cap = store.row(store.read(), agent.id)?.policy?.maxTokens;
    return cap === undefined ? config : { ...config, maxTokens: Math.min(positive(config.maxTokens) ? config.maxTokens : cap, cap) };
  };
  const disposeRequest = ctx.on?.('agent/request', requestListener, { global: true, prepend: true });
  const applies = agent => {
    if (!trusted.has(agent?.id)) return false;
    if (getExecutionContext?.({ agent })?.scope !== 'desktop') return false;
    if (!owned(agent)) throw fault('CONTEXT_GUARD_UNAVAILABLE');
    return true;
  };
  const persistence = {
    loadFailure: agent => applies(agent) ? store.failure(agent) : null,
    recordFailure: (agent, value) => applies(agent) ? store.recordFailure(agent, value) : value,
    beginAdmission: agent => applies(agent) ? store.begin(agent) : undefined,
    // The token is this instance's opaque capability. A known unstarted request
    // may release its own intent even after owner/Agent revocation; no failure
    // or other worker's pending record is cleared.
    endAdmission: (agent, token) => { if (trusted.has(agent?.id) && store.live.has(token)) store.end(agent, token); },
    assertPolicy: (agent, options) => { if (applies(agent)) store.assertPolicy(agent, options); },
    clearFailure: (agent, value) => { if (applies(agent)) store.review(agent, value); },
  };
  return Object.freeze({
    persistence,
    attachGuard(value) { if (guard || !value) throw fault('CONFLICT'); guard = value; },
    snapshot() {
      let state; try { state = store.read(); } catch { return { enabled: false, revision: null, sessions: [] }; }
      const sessions = [];
      for (const sessionId of trusted) try {
        const agent = actual(sessionId), row = store.row(state, sessionId), failure = guard?.failureFor(agent);
        sessions.push({ sessionId, seq: agent.session.seq, paused: Boolean(failure), holdKind: failure?.kind || null,
          checkpointHeaderDigest: failure?.checkpoint?.headerDigest || null,
          maxTokens: row?.policy?.maxTokens ?? headerOf(agent)?.config?.maxTokens ?? null,
          busy: active || agent.status !== 'idle' || !empty(agent) });
      } catch {}
      return { enabled: !closed && isOpen(), revision: state.revision, sessions };
    },
    async preview(body, { authorize = () => false } = {}) {
      if (!plain(body) || Object.keys(body).some(key => !['sessionId', 'maxTokens', 'expectedSeq'].includes(key))
        || body.maxTokens !== 8192 || !Number.isSafeInteger(body.expectedSeq) || body.expectedSeq < 0) throw fault('INVALID_PATCH');
      if (!authorize()) throw fault('FORBIDDEN');
      const agent = actual(body.sessionId);
      return inMaintenance(agent, authorize, async () => {
        const point = checkpoint(agent), before = read(agent), failure = before.failure;
        if (point.seq !== body.expectedSeq) throw fault('CONFLICT');
        if (!failure || failure.code !== 'CONTEXT_CAPACITY_REQUIRED' || !['guard', 'maintenance-migration'].includes(failure.kind)
          || failure.providerStarted === true || before.row?.pending.length) throw fault('CONTEXT_RECOVERY_REQUIRED');
        if (failure.kind === 'maintenance-migration' && (failure.checkpoint.seq !== point.seq || failure.checkpoint.headerDigest !== point.headerDigest)) throw fault('CONFLICT');
        const header = headerOf(agent), cap = Math.min(body.maxTokens, before.row?.policy?.maxTokens ?? Infinity, header.config.maxTokens);
        if (!positive(cap)) throw fault('CONTEXT_RECOVERY_REQUIRED');
        const check = () => {
          authorized(agent, authorize);
          if (!sameCheckpoint(agent, point) || store.read().revision !== before.state.revision || guard.failureFor(agent) !== failure) throw fault('CONFLICT');
          return true;
        };
        const checked = await guard.checkRecovery(agent, { maxTokens: cap, validate: check }); check();
        if (checked.allowed !== true) throw fault('CONTEXT_RECOVERY_REQUIRED');
        const previewId = randomUUID();
        for (const [key, value] of previews) if (value.expires < now() || value.agent === agent) previews.delete(key);
        if (previews.size >= 128) throw fault('BUSY');
        previews.set(previewId, { agent, point, failure, revision: before.state.revision, cap, expires: now() + 120000 });
        return { ok: true, sessionId: agent.id, previewId, seq: point.seq, revision: before.state.revision, holdKind: failure.kind,
          maxTokens: cap, ...checked.view, allowed: true, automaticReplay: false };
      });
    },
    async recover(body, { authorize = () => false } = {}) {
      if (!plain(body) || Object.keys(body).some(key => !['sessionId', 'previewId', 'acknowledgeNoReplay'].includes(key))
        || body.acknowledgeNoReplay !== true || !uuid(body.previewId)) throw fault('INVALID_PATCH');
      if (!authorize()) throw fault('FORBIDDEN');
      const preview = previews.get(body.previewId); previews.delete(body.previewId);
      if (!preview || preview.expires < now() || preview.agent.id !== body.sessionId) throw fault('CONFLICT');
      const agent = actual(body.sessionId);
      if (agent !== preview.agent) throw fault('CONFLICT');
      return inMaintenance(agent, authorize, async () => {
        const check = () => {
          authorized(agent, authorize);
          if (!sameCheckpoint(agent, preview.point) || store.read().revision !== preview.revision || guard.failureFor(agent) !== preview.failure) throw fault('CONFLICT');
          return true;
        };
        check();
        const checked = await guard.checkRecovery(agent, { maxTokens: preview.cap, validate: check }); check();
        if (checked.allowed !== true) throw fault('CONTEXT_RECOVERY_REQUIRED');
        guard.clear(agent, { validate: check, commit: () => store.review(agent, preview.failure, { revision: preview.revision, maxTokens: preview.cap }) });
        return { ok: true, recovered: true, maxTokens: preview.cap, automaticReplay: false };
      });
    },
    dispose() { closed = true; previews.clear(); if (typeof disposeRequest === 'function') disposeRequest(); },
  });
}
