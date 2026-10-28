import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PLATFORMS, platform, accountId, uuid, deny, allowed, exactKeys, readRequest, writeRequest, browseRequest } from './platforms.mjs';
import { DEFAULT_REQUEST_POLICY, RISK_CODES, consumeRequest, requireNotPaused } from './request-policy.mjs';
import { SocialAccountStore, digest } from './account-store.mjs';
import { nativeEgoDiagnostic } from './native-ego-diagnostic.mjs';
import { DOUYIN_INTERACTIONS, douyinInteractionRequest, interactionSemanticDigest, validateInteractionCurrent } from './douyin-interactions.mjs';

const ACTIVE_LEASES = new Set();
// Pure projection of the same persistent request ceilings used by consumeRequest.
// null means the stored history cannot establish a safe local next time.
function readCooldownRemaining(row, now, policy, kind = 'read') {
  if (!policy) return 0;
  const limit = policy[kind], history = row?.requestHistory || [];
  if (!limit || !Number.isFinite(now) || !Array.isArray(history) || history.some(event => !event
    || !Object.hasOwn(DEFAULT_REQUEST_POLICY, event.kind) || !Number.isFinite(event.at) || event.at > now + 60000)) return null;
  const recent = history.filter(event => now - event.at < 86400000).sort((a, b) => a.at - b.at);
  const own = recent.filter(event => event.kind === kind), hourly = own.filter(event => now - event.at < 3600000);
  let next = now;
  if (own.length) next = Math.max(next, own.at(-1).at + limit.gapMs);
  if (hourly.length >= limit.perHour) next = Math.max(next, hourly[hourly.length - limit.perHour].at + 3600000);
  if (limit.perDay && own.length >= limit.perDay) next = Math.max(next, own[own.length - limit.perDay].at + 86400000);
  if (recent.length >= 2000) next = Math.max(next, recent[recent.length - 2000].at + 86400000);
  return Math.max(0, Math.ceil(next - now));
}

const safeIdentity = value => {
  if (value?.loggedIn !== true || !accountId(value.accountId)) return null;
  return { accountId: value.accountId, name: typeof value.name === 'string' ? value.name.slice(0, 100).replace(/[\x00-\x1f\x7f]/g, '') : value.accountId };
};
const safeOperation = (row, live) => ({ id: row.id, platform: row.platform, accountId: row.accountId, generation: row.generation,
  origin: row.autonomousInteraction ? 'autonomy' : 'owner', activityId: row.autonomousInteraction?.activityId || null,
  operation: row.request.operation, target: row.request.target || '', parentId: row.request.parentId || '', rootId: row.request.rootId || '', text: row.request.text || '',
  title: row.request.title || '', mediaName: row.media?.name || '', mediaBytes: row.media?.bytes || 0,
  coverName: row.media?.cover?.name || '', declaration: row.request.declaration || null, tags: row.request.tags || [], category: row.request.category || null,
  state: row.state === 'dispatching' && !live ? 'unknown' : row.state, approvalDigest: row.approvalDigest,
  resultId: row.receipt?.id || null, resultUrl: row.receipt?.url || null, createdAt: row.createdAt, updatedAt: row.updatedAt,
  note: row.note || '' });
async function mediaSnapshot(file, cover = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) deny('INVALID_MEDIA');
  const real = fs.realpathSync(file), fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    const extensions = cover ? ['.png', '.jpg', '.jpeg', '.webp'] : ['.mp4', '.mov', '.m4v'];
    if (!stat.isFile() || stat.size < 1 || stat.size > (cover ? 20 * 1024 ** 2 : 1024 ** 3) || !extensions.includes(path.extname(real).toLowerCase())) deny('INVALID_MEDIA');
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < stat.size;) { const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset); if (!count) deny('MEDIA_CHANGED'); hash.update(buffer.subarray(0, count)); offset += count; }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || fs.realpathSync(file) !== real) deny('MEDIA_CHANGED');
    return { path: real, name: path.basename(real), bytes: stat.size, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}

/** Account-scoped capabilities. UI owner approves an exact draft; models can
 * neither bind an account nor approve their own outgoing content. No timer,
 * autonomous enablement, credential import or provider request is started here. */
export class SocialAccounts {
  constructor({ directory, drivers = {}, now = () => Date.now(), isOpen = () => true, requestPolicy = DEFAULT_REQUEST_POLICY } = {}) {
    this.store = new SocialAccountStore(directory); this.drivers = drivers; this.now = now;
    this.live = new Map(); this.closed = false; this.controller = new AbortController();
    this.loginImages = new Map();
    this.isOpen = isOpen; this.requestPolicy = requestPolicy;
  }
  iso() { return new Date(this.now()).toISOString(); }
  get busy() { return this.live.size > 0 || Object.values(this.drivers).some(driver => driver.idle === false); }
  #lease(key) { return path.join(this.store.privateDirectory(key), '.runtime-lock'); }
  #recoverLease(key, stopping = false, recoveryToken) {
    const maintenance=path.join(this.store.privateDirectory(key),'.recovery-lock');
    if(fs.existsSync(maintenance)&&fs.readFileSync(maintenance,'utf8')!==recoveryToken)deny('BUSY');
    if (this.live.has(key) || !stopping && this.drivers[key]?.idle === false) deny('BUSY');
    const file = this.#lease(key);
    if (ACTIVE_LEASES.has(file)) deny('BUSY');
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024) deny('STORAGE_INVALID');
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!uuid(lease.token) || !Number.isSafeInteger(lease.pid) || lease.pid < 1) deny('STORAGE_INVALID');
    if (lease.pid !== process.pid) {
      try { process.kill(lease.pid, 0); deny('BUSY'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    // A human acknowledgement never kills another process or replays a task.
    if (JSON.parse(fs.readFileSync(file, 'utf8')).token !== lease.token) deny('CONFLICT');
    fs.unlinkSync(file);
  }
  #authority(authorize, signal) { if (this.closed || !this.isOpen() || signal?.aborted || !allowed(authorize)) deny('FORBIDDEN'); }
  #driver(key) { platform(key); return this.drivers[key] || deny('DRIVER_UNAVAILABLE'); }
  #account(key) {
    const row = this.store.read().state.accounts[key];
    if (!row || row.state !== 'bound' || !accountId(row.accountId)) deny('ACCOUNT_REQUIRED'); return row;
  }
  async #exclusive(key, context, action) {
    this.#authority(context.authorize, context.signal); if (this.live.has(key) || !context.stopping && this.drivers[key]?.idle === false) deny('BUSY');
    const directory = this.store.privateDirectory(key);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) deny('INVALID_STORAGE'); fs.chmodSync(directory, 0o700);
    if (fs.existsSync(path.join(directory, '.recovery-lock'))) deny('BUSY');
    const lease = path.join(directory, '.runtime-lock'), token = randomUUID(); let descriptor;
    try { descriptor = fs.openSync(lease, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') deny('BUSY', '该平台有正在运行或尚待核对的旧执行器。'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid })); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    const controller = new AbortController(), abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true }); this.controller.signal.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted || this.controller.signal.aborted) abort();
    let finish;
    const job = { id: randomUUID(), controller, done: new Promise(resolve => { finish = resolve; }) }; this.live.set(key, job);
    ACTIVE_LEASES.add(lease);
    try { return await action({ ...context, signal: controller.signal,
      authorize: () => !this.closed && this.isOpen() && !controller.signal.aborted && allowed(context.authorize) }); }
    catch (error) { if (RISK_CODES.has(error?.code)) this.#pause(key, 'risk-control'); throw error; }
    finally {
      context.signal?.removeEventListener('abort', abort); this.controller.signal.removeEventListener('abort', abort);
      if (this.live.get(key) === job) this.live.delete(key);
      ACTIVE_LEASES.delete(lease);
      try { if (!job.cleanupUnknown && this.drivers[key]?.idle !== false && JSON.parse(fs.readFileSync(lease, 'utf8')).token === token) fs.unlinkSync(lease); } catch {}
      finish();
    }
  }
  #pause(key, reason) {
    if (this.store.read().state.accounts[key]?.safetyPause) return;
    this.store.transact(state => { const row = state.accounts[key]; if (row) row.safetyPause = { reason, at: this.iso() }; }, { authorize: () => true });
  }
  #pace(key, kind, current) {
    this.store.transact(state => { const row = state.accounts[key]; if (!row) deny('ACCOUNT_REQUIRED');
      consumeRequest(row, kind, this.now(), this.requestPolicy); }, { authorize: current.authorize });
  }
  snapshot() {
    const { state, revision } = this.store.read();
    const platforms = Object.entries(PLATFORMS).map(([key, definition]) => {
      const row = state.accounts[key], driver = this.drivers[key];
      const readiness = driver?.capabilities?.() || {};
      const native = driver?.runtime?.backend === 'native-ego' ? driver.runtime.status() : null;
      return { platform: key, name: definition.name, loginMethod: definition.qr ? 'qr' : 'official-login',
        state: row?.state || 'disconnected', safetyPause: row?.safetyPause ? { reason: row.safetyPause.reason, at: row.safetyPause.at } : null, accountId: row?.accountId || null, accountName: row?.name || '',
        candidate: row?.candidate && accountId(row.candidate.accountId) ? { accountId: row.candidate.accountId,
          name: typeof row.candidate.name === 'string' ? row.candidate.name.slice(0, 100) : '' } : null, generation: row?.generation || 0,
        connectedAt: row?.connectedAt || null, checkedAt: row?.checkedAt || null, loginSession: row?.loginSession || null,
        loginImageAvailable: this.loginImages.has(key) && row?.state === 'login-pending' && this.loginImages.get(key)?.sessionId === row.loginSession && this.loginImages.get(key).expiresAt > this.now(),
        busy: this.live.has(key), blocked: Boolean(row?.activeOperation), cleanupRequired: !this.live.has(key) && fs.existsSync(this.#lease(key)),
        nextAvailable: key === 'douyin' && driver?.nextAvailable === true,
        loginAvailable: driver?.loginAvailable !== false, driverConfigured: Boolean(driver) && driver.available !== false,
        driverAvailable: native ? native.nativeReady === true || native.canStartNewActivity === true : Boolean(driver) && driver.available !== false, driverIssue: driver?.runtime?.unavailableReason || null,
        browser: native ? { configured: native.configured, ...native.metadata, lifecycle: native.lifecycle,
          canStartNewActivity: native.canStartNewActivity === true, activityReady: native.activityReady === true,
          lastDiagnostic: nativeEgoDiagnostic(native.lastDiagnostic) } : null,
        browse: key === 'douyin' ? { state: driver?.browseStatus?.().state || 'unknown',
          cooldownRemainingMs: readCooldownRemaining(row, this.now(), this.requestPolicy),
          interactionCooldownRemainingMs: readCooldownRemaining(row, this.now(), this.requestPolicy, 'write') } : null,
        interactions: key === 'douyin' ? Object.fromEntries(DOUYIN_INTERACTIONS.map(action => [action,
          row?.state !== 'bound' ? 'needs-login' : driver?.interactionCapabilities?.()[action] === 'ready' ? 'ready' : 'bindings-required'])) : null,
        capabilities: [...definition.reads, ...definition.writes].map(operation => ({ operation,
          mode: definition.writes.includes(operation) ? 'write' : 'read',
          state: row?.state !== 'bound' ? 'needs-login' : readiness[operation] || 'not-implemented' })) };
    });
    return { revision, busy: this.busy, platforms, operations: Object.values(state.operations).slice(-100).reverse()
      .map(row => safeOperation(row, this.live.has(row.platform))) };
  }
  async checkBrowser(body, context) {
    exactKeys(body, ['platform', 'revision']); if (body.platform !== 'douyin' || typeof body.revision !== 'string') deny('INVALID_REQUEST');
    return this.#exclusive(body.platform, context, async current => {
      const before = this.store.read(); if (before.revision !== body.revision) deny('CONFLICT');
      requireNotPaused(before.state.accounts[body.platform]);
      if (before.state.accounts[body.platform]?.activeOperation) deny('RESULT_UNKNOWN');
      const browser = await this.#driver(body.platform).checkBrowser({ ...current, isCurrent: () => this.store.read().revision === before.revision });
      this.#authority(current.authorize, current.signal); if (this.store.read().revision !== before.revision) deny('CONFLICT');
      return { browser, accounts: this.snapshot() };
    });
  }
  async startLogin(body, context) {
    exactKeys(body, ['platform', 'requestId', 'revision']); const key = body.platform; platform(key);
    if (!uuid(body.requestId) || typeof body.revision !== 'string') deny('INVALID_REQUEST');
    this.#authority(context.authorize, context.signal); if (this.#driver(key).loginAvailable === false) deny('OPERATION_UNAVAILABLE');
    return this.#exclusive(key, context, async current => {
      const driver = this.#driver(key), prior = this.store.read().state.accounts[key];
      requireNotPaused(prior); if (prior?.activeOperation) deny('RESULT_UNKNOWN');
      if (prior?.loginSession === body.requestId) return { state: prior.state, sessionId: body.requestId, replayed: false, accounts: this.snapshot() };
      if (prior?.state === 'login-pending') deny('LOGIN_PENDING', '已有登录会话，请先检查或明确关闭它。');
      this.store.transact(state => { state.accounts[key] = { ...state.accounts[key], generation: (state.accounts[key]?.generation || 0) + 1,
        state: 'login-pending', candidate: null, loginSession: body.requestId, checkedAt: this.iso() };
        consumeRequest(state.accounts[key], 'login', this.now(), this.requestPolicy); }, { revision: body.revision, authorize: current.authorize });
      try {
        const login = await driver.startLogin({ sessionId: body.requestId, ...current });
        this.#authority(current.authorize, current.signal);
        const image = login?.image;
        if (image?.mime === 'image/png' && typeof image.base64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(image.base64)
          && image.base64.length < 1400000 && Buffer.from(image.base64, 'base64').subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
          this.loginImages.set(key, { sessionId: body.requestId, image: { mime: image.mime, base64: image.base64 }, expiresAt: this.now() + 120000 });
        return { login, sessionId: body.requestId, accounts: this.snapshot() };
      } catch (error) {
        this.store.transact(state => { const row = state.accounts[key]; if (row.loginSession === body.requestId) row.state = 'login-unknown'; }, { authorize: () => true });
        throw error;
      }
    });
  }
  loginImage(body, context) {
    exactKeys(body, ['platform', 'sessionId']); platform(body.platform); this.#authority(context.authorize, context.signal);
    const row = this.store.read().state.accounts[body.platform], image = this.loginImages.get(body.platform);
    if (!row || row.loginSession !== body.sessionId || row.state !== 'login-pending' || image?.sessionId !== body.sessionId || image.expiresAt <= this.now()) deny('CONFLICT');
    return { image: structuredClone(image.image), sessionId: body.sessionId };
  }
  async checkLogin(body, context) {
    exactKeys(body, ['platform', 'sessionId']); const key = body.platform; platform(key);
    this.#authority(context.authorize, context.signal); if (this.#driver(key).loginAvailable === false) deny('OPERATION_UNAVAILABLE');
    return this.#exclusive(key, context, async current => {
      const before = this.store.read().state.accounts[key];
      if (!before || body.sessionId !== before.loginSession) deny('CONFLICT');
      this.#pace(key, 'poll', current);
      const result = await this.#driver(key).checkLogin({ sessionId: body.sessionId, ...current });
      this.#authority(current.authorize, current.signal); const identity = safeIdentity(result);
      this.store.transact(state => {
        const row = state.accounts[key]; if (row.generation !== before.generation || row.loginSession !== body.sessionId) deny('CONFLICT');
        row.checkedAt = this.iso();
        if (identity) {
          if (row.accountId && row.accountId !== identity.accountId) { row.state = 'account-mismatch'; row.candidate = identity; }
          else if (before.state === 'bound') { row.state = 'bound'; row.candidate = null; row.name = identity.name; }
          else { row.candidate = identity; row.state = 'candidate'; }
        } else if (['expired', 'verification-required', 'login-pending', 'login-unknown', 'identity-binding-required'].includes(result?.state)) row.state = result.state;
        else row.state = 'login-unknown';
      }, { authorize: current.authorize });
      return { login: identity ? { state: this.store.read().state.accounts[key].state, ...identity } : { state: result?.state || 'login-unknown', scanned: result?.scanned === true }, accounts: this.snapshot() };
    });
  }
  async confirmAccount(body, context) {
    exactKeys(body, ['platform', 'accountId', 'revision']); const key = body.platform; platform(key);
    if (!accountId(body.accountId)) deny('INVALID_REQUEST');
    return this.#exclusive(key, context, async current => {
      const before = this.store.read();
      if (before.revision !== body.revision || before.state.accounts[key]?.candidate?.accountId !== body.accountId) deny('CONFLICT');
      requireNotPaused(before.state.accounts[key]);
      const actual = safeIdentity(await this.#driver(key).account({ ...current, resume: true }));
      this.#authority(current.authorize, current.signal); if (actual?.accountId !== body.accountId) deny('ACCOUNT_MISMATCH');
      this.store.transact(state => {
        const row = state.accounts[key]; if (row.activeOperation) deny('RESULT_UNKNOWN');
        row.accountId = actual.accountId; row.name = actual.name; row.state = 'bound'; row.candidate = null;
        row.connectedAt = this.iso(); row.checkedAt = this.iso();
      }, { revision: body.revision, authorize: current.authorize });
      return { accounts: this.snapshot() };
    });
  }
  async #identity(key, expected, current) {
    this.#authority(current.authorize, current.signal);
    const row = this.#account(key);
    if (row.accountId !== expected.accountId || row.generation !== expected.generation) deny('ACCOUNT_MISMATCH');
    const actual = safeIdentity(await this.#driver(key).account(current));
    this.#authority(current.authorize, current.signal);
    if (actual?.accountId !== expected.accountId) deny('ACCOUNT_MISMATCH');
  }
  async read(key, request, context) {
    const input = readRequest(key, request);
    return this.#exclusive(key, context, async current => {
      const expected = this.#account(key), driver = this.#driver(key), job = this.live.get(key);
      if (expected.activeOperation) deny('RESULT_UNKNOWN');
      requireNotPaused(expected); this.#pace(key, 'read', current);
      // This explicit read operation may own a finite new task. Generic native
      // run/account never create a Space, and a borrowed active feed is retained.
      let created = false;
      try {
        if (typeof driver.beginReadActivity === 'function')
          created = await driver.beginReadActivity({ ...current, accountId: expected.accountId }) === true;
        await this.#identity(key, expected, current);
        const result = await driver.read(input, current);
        await this.#identity(key, expected, current);
        // Project selected data, never raw headers, credentials or unrelated chats.
        if (Buffer.byteLength(JSON.stringify(result)) > 32000 || result?.ok !== true || result.accountId !== expected.accountId) deny('INVALID_RECEIPT');
        return result;
      } catch (error) {
        // Preserve the platform pause even if final task cleanup also fails.
        if (RISK_CODES.has(error?.code)) this.#pause(key, 'risk-control');
        throw error;
      } finally {
        if (created) {
          const cleanupAuthorized = () => {
            try { const row = this.#account(key);
              return !this.closed && this.isOpen() && this.live.get(key) === job && ACTIVE_LEASES.has(this.#lease(key))
                && row.accountId === expected.accountId && row.generation === expected.generation;
            } catch { return false; }
          };
          // Cancellation revokes reading, while this exact still-held job may
          // finish only the task it created. A cleanup failure retains occupancy.
          try {
            if (!cleanupAuthorized() || typeof driver.endReadActivity !== 'function') deny('CLEANUP_UNCONFIRMED');
            const receipt = await driver.endReadActivity({ accountId: expected.accountId, authorize: cleanupAuthorized,
              signal: new AbortController().signal });
            if (receipt?.stopped !== true || receipt.taskSpaceClosed !== true || receipt.spaceRetained !== false || receipt.browserStopped !== false) deny('CLEANUP_UNCONFIRMED');
          } catch { job.cleanupUnknown = true; deny('CLEANUP_UNCONFIRMED'); }
        }
      }
    });
  }
  #autonomousBrowseExpectation(key, context, { initiallyStopped = false } = {}) {
    const expectation = context.autonomousExpectation;
    if (expectation === undefined) return;
    if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)
      || Object.keys(expectation).sort().join(',') !== 'accountId,generation,initiallyStopped'
      || !accountId(expectation.accountId) || !Number.isSafeInteger(expectation.generation) || expectation.generation < 0
      || typeof expectation.initiallyStopped !== 'boolean') deny('AUTONOMY_PRECONDITION');
    const row = this.#account(key);
    if (row.accountId !== expectation.accountId || row.generation !== expectation.generation
      || initiallyStopped && expectation.initiallyStopped && this.#driver(key).browseStatus?.().state !== 'stopped') deny('AUTONOMY_PRECONDITION');
  }
  async browse(key, request, context) {
    const input = browseRequest(key, request); this.#authority(context.authorize, context.signal);
    const driver = this.#driver(key);
    if (typeof driver.browse !== 'function') deny('OPERATION_UNAVAILABLE');
    if (input.action === 'history') {
      this.#autonomousBrowseExpectation(key, context);
      const expected = this.#account(key);
      const result = await driver.browse(input, { ...context, accountId: expected.accountId });
      this.#authority(context.authorize, context.signal);
      const after = this.#account(key);
      if (after.accountId !== expected.accountId || after.generation !== expected.generation) deny('ACCOUNT_MISMATCH');
      return result;
    }
    if (input.action === 'stop') {
      this.#autonomousBrowseExpectation(key, context);
      const job = this.live.get(key); job?.controller.abort();
      if (job) await job.done;
      this.#authority(context.authorize, context.signal);
      this.#autonomousBrowseExpectation(key, context);
      this.#recoverLease(key, true);
      return this.#exclusive(key, { ...context, stopping: true }, current => {
        this.#autonomousBrowseExpectation(key, current);
        return driver.browse(input, current);
      });
    }
    return this.#exclusive(key, context, async current => {
      const expected = this.#account(key); if (expected.activeOperation) deny('RESULT_UNKNOWN');
      this.#autonomousBrowseExpectation(key, current, { initiallyStopped: input.action === 'open' });
      this.#pace(key, 'read', current);
      current.onBrowseDispatch?.();
      // The browse driver verifies identity in a separate creator tab before
      // and after reading. Generic account() would navigate away from the feed.
      const result = await driver.browse(input, { ...current, accountId: expected.accountId });
      this.#authority(current.authorize, current.signal);
      const after = this.#account(key);
      if (after.accountId !== expected.accountId || after.generation !== expected.generation) deny('ACCOUNT_MISMATCH');
      if (result?.ok !== true || result.accountId !== expected.accountId || Buffer.byteLength(JSON.stringify(result)) > 32000) deny('INVALID_RECEIPT');
      return result;
    });
  }
  /** Separate autonomous grant: owner drafts/approvals do not authorize this
   * path. Permission comes from a live code-owned activity and saved policy. */
  async interact(key, request, context) {
    if (key !== 'douyin') deny('INVALID_OPERATION');
    const input = douyinInteractionRequest(request);
    const permission = () => allowed(context?.authorize) && allowed(() => context?.interactionAllowed?.(input.action))
      && typeof context?.activityId === 'string' && /^auto-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(context.activityId);
    if (!permission() || context?.autonomousExpectation?.initiallyStopped !== false) deny('FORBIDDEN');
    return this.#exclusive(key, { ...context, authorize: permission }, async current => {
      this.#autonomousBrowseExpectation(key, current);
      const expected = this.#account(key), driver = this.#driver(key);
      if (expected.activeOperation) deny('RESULT_UNKNOWN');
      requireNotPaused(expected);
      if (driver.browseStatus?.().state !== 'active' || driver.interactionCapabilities?.()[input.action] !== 'ready'
        || typeof driver.interactionPreflight !== 'function' || typeof driver.interact !== 'function') deny('BINDINGS_REQUIRED');
      this.#pace(key, 'write', current);
      const preflight = await driver.interactionPreflight(input, { ...current, accountId: expected.accountId });
      this.#authority(current.authorize, current.signal); this.#autonomousBrowseExpectation(key, current);
      if (!validateInteractionCurrent(preflight?.current, input.expectedVideoId) || typeof preflight.target !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(preflight.target) || !/^[a-f0-9]{64}$/.test(preflight.bindingDigest || '')
        || input.action !== 'follow' && preflight.target !== preflight.current.platformVideoId) deny('INVALID_RECEIPT');
      const semanticDigest = interactionSemanticDigest(expected.accountId, expected.generation, input.action, preflight.target);
      const operationId = randomUUID(), outgoing = { operation: input.action, target: preflight.target, ...(input.text !== undefined ? { text: input.text } : {}) };
      const contentDigest = digest(outgoing), approvalDigest = digest({ origin: 'autonomy', activityId: context.activityId,
        accountId: expected.accountId, generation: expected.generation, input, request: outgoing });
      this.store.transact(state => {
        const account = state.accounts[key];
        if (account.activeOperation) deny('RESULT_UNKNOWN');
        if (account.state !== 'bound' || account.accountId !== expected.accountId || account.generation !== expected.generation) deny('ACCOUNT_MISMATCH');
        if (Object.values(state.operations).some(row => row.autonomousInteraction?.semanticDigest === semanticDigest)) deny('NO_REPLAY');
        if (Object.keys(state.operations).length >= 2000) deny('STORAGE_CAPACITY');
        state.operations[operationId] = { id: operationId, platform: key, accountId: expected.accountId, generation: expected.generation, origin: 'autonomy',
          request: outgoing, media: null, approvalDigest, state: 'dispatching', createdAt: this.iso(), updatedAt: this.iso(), receipt: null,
          autonomousInteraction: { activityId: context.activityId, expectedVideoId: input.expectedVideoId, semanticDigest } };
        account.activeOperation = operationId;
      }, { authorize: current.authorize });
      let receipt;
      try {
        this.#authority(current.authorize, current.signal); this.#autonomousBrowseExpectation(key, current);
        receipt = await driver.interact(input, { ...current, accountId: expected.accountId, generation: expected.generation,
          target: preflight.target, bindingDigest: preflight.bindingDigest, operationId, contentDigest,
          claimFile: path.join(this.store.privateDirectory(key), operationId + '.once') });
        if (receipt?.ok !== true || receipt.status !== 'confirmed' || receipt.action !== input.action || receipt.accountId !== expected.accountId
          || receipt.operationId !== operationId || receipt.target !== preflight.target || receipt.contentDigest !== contentDigest
          || typeof receipt.receiptId !== 'string' || !/^[A-Za-z0-9_:-]{1,150}$/.test(receipt.receiptId)
          || !validateInteractionCurrent(receipt.current, input.expectedVideoId) || Buffer.byteLength(JSON.stringify(receipt)) > 16000) deny('INVALID_RECEIPT');
      } catch (error) {
        // Persisting the result or pause can itself fail. The earlier durable
        // dispatching/activeOperation proof still blocks this account, and the
        // caller must retain unknown outcome instead of treating it as failure.
        try { if (RISK_CODES.has(error?.code)) this.#pause(key, 'risk-control'); } catch {}
        try { this.store.transact(state => { const row = state.operations[operationId]; if (!row) deny('STORAGE_INVALID');
          row.state = 'unknown'; row.updatedAt = this.iso(); row.note = '自主互动结果未确认；不会自动重试，请核对原平台和旧执行器。'; }, { authorize: () => true }); } catch {}
        deny('INTERACTION_UNCONFIRMED');
      }
      try {
        this.store.transact(state => {
          const row = state.operations[operationId], account = state.accounts[key];
          if (row.state !== 'dispatching' || account.activeOperation !== operationId) deny('CONFLICT');
          row.state = 'sent'; row.updatedAt = this.iso(); row.receipt = { id: receipt.receiptId, status: 'confirmed' }; account.activeOperation = null;
        }, { authorize: () => true });
      } catch { deny('INTERACTION_UNCONFIRMED'); }
      return { ok: true, action: input.action, accountId: expected.accountId, generation: expected.generation,
        operationId, targetHash: digest((input.action === 'follow' ? 'douyin-author\0' : 'douyin-video\0') + preflight.target),
        contentDigest: input.action === 'comment' ? digest(input.text) : null, status: 'confirmed', receiptId: receipt.receiptId,
        current: receipt.current };
    });
  }
  async prepare(key, request, { requestId, authorize, signal } = {}) {
    this.#authority(authorize, signal); if (!uuid(requestId)) deny('INVALID_REQUEST');
    const input = writeRequest(key, request), account = this.#account(key);
    const media = input.video ? { ...await mediaSnapshot(input.video), cover: input.cover ? await mediaSnapshot(input.cover, true) : null } : null;
    this.#authority(authorize, signal);
    const approvalDigest = digest({ platform: key, accountId: account.accountId, generation: account.generation, request: input, media });
    const result = this.store.transact(state => {
      const previous = state.operations[requestId];
      if (previous) { if (previous.approvalDigest !== approvalDigest) deny('CONFLICT'); return safeOperation(previous, this.live.has(key)); }
      const current = state.accounts[key];
      if (current.state !== 'bound' || current.accountId !== account.accountId || current.generation !== account.generation) deny('ACCOUNT_MISMATCH');
      if (current.activeOperation) deny('RESULT_UNKNOWN');
      if (Object.keys(state.operations).length >= 2000) deny('STORAGE_CAPACITY');
      const row = { id: requestId, platform: key, accountId: account.accountId, generation: account.generation,
        request: input, media, approvalDigest, state: 'draft', createdAt: this.iso(), updatedAt: this.iso(), receipt: null };
      state.operations[requestId] = row; return safeOperation(row, false);
    }, { authorize });
    return { operation: result.result, revision: result.revision };
  }
  approve(body, context) {
    exactKeys(body, ['operationId', 'approvalDigest', 'revision']); this.#authority(context.authorize, context.signal);
    if (!uuid(body.operationId) || !/^[a-f0-9]{64}$/.test(body.approvalDigest || '')) deny('INVALID_REQUEST');
    this.store.transact(state => {
      const row = state.operations[body.operationId]; if (!row || row.approvalDigest !== body.approvalDigest) deny('CONFLICT');
      if (row.state !== 'draft') deny('NO_REPLAY');
      const account = state.accounts[row.platform];
      if (account?.state !== 'bound' || account.accountId !== row.accountId || account.generation !== row.generation) deny('ACCOUNT_MISMATCH');
      row.state = 'approved'; row.updatedAt = this.iso();
    }, { revision: body.revision, authorize: context.authorize });
    return { accounts: this.snapshot() };
  }
  async execute(body, context) {
    exactKeys(body, ['operationId', 'approvalDigest']); if (!uuid(body.operationId)) deny('INVALID_REQUEST');
    const start = this.store.read().state.operations[body.operationId]; if (!start || start.approvalDigest !== body.approvalDigest) deny('CONFLICT');
    return this.#exclusive(start.platform, context, async current => {
      const key = start.platform, expected = this.#account(key);
      if (start.state !== 'approved') return { operation: safeOperation(start, false), replayed: false };
      if (expected.activeOperation) deny('RESULT_UNKNOWN');
      const driver = this.#driver(key);
      requireNotPaused(expected); await driver.preflight(start.request, current); this.#pace(key, 'write', current); await this.#identity(key, start, current);
      if (start.media && digest({ ...await mediaSnapshot(start.media.path), cover: start.media.cover ? await mediaSnapshot(start.media.cover.path, true) : null }) !== digest(start.media)) deny('MEDIA_CHANGED');
      this.store.transact(state => {
        const row = state.operations[start.id], account = state.accounts[key];
        if (row.state !== 'approved' || account.activeOperation || row.approvalDigest !== body.approvalDigest) deny('NO_REPLAY');
        if (account.generation !== row.generation || account.accountId !== row.accountId || account.state !== 'bound') deny('ACCOUNT_MISMATCH');
        row.state = 'dispatching'; row.updatedAt = this.iso(); account.activeOperation = row.id;
      }, { authorize: current.authorize });
      let receipt;
      try {
        receipt = await driver.execute(start.request, { ...current, operationId: start.id, approvalDigest: start.approvalDigest,
          accountId: start.accountId, media: start.media, claimFile: path.join(this.store.privateDirectory(key), start.id + '.once') });
        await this.#identity(key, start, current);
        if (receipt?.ok !== true || receipt.accountId !== start.accountId || receipt.operation !== start.request.operation
          || typeof receipt.id !== 'string' || !/^[A-Za-z0-9_:-]{1,150}$/.test(receipt.id)
          || receipt.target !== (start.request.target || '') || receipt.parentId !== (start.request.parentId || '') || (start.request.rootId && receipt.rootId !== start.request.rootId)
          || receipt.contentDigest !== digest(start.request) || receipt.operationId !== start.id) deny('INVALID_RECEIPT');
      } catch (error) {
        if (RISK_CODES.has(error?.code)) this.#pause(key, 'risk-control');
        this.store.transact(state => { const row = state.operations[start.id]; row.state = 'unknown'; row.updatedAt = this.iso();
          row.note = '执行或回执未确认；不会自动重试，请先核对原平台和旧执行器。'; }, { authorize: () => true });
        return { operation: safeOperation(this.store.read().state.operations[start.id], false) };
      }
      this.store.transact(state => {
        const row = state.operations[start.id], account = state.accounts[key];
        if (row.state !== 'dispatching' || account.activeOperation !== row.id) deny('CONFLICT');
        row.state = 'sent'; row.updatedAt = this.iso(); row.receipt = { id: receipt.id,
          status: 'submitted' };
        account.activeOperation = null;
      }, { authorize: () => true });
      return { operation: safeOperation(this.store.read().state.operations[start.id], false) };
    });
  }
  async closeLogin(body, context) {
    exactKeys(body, ['platform', 'sessionId', 'revision']); const key = body.platform; platform(key);
    return this.#exclusive(key, context, async current => {
      const before = this.store.read();
      if (before.revision !== body.revision || before.state.accounts[key]?.loginSession !== body.sessionId) deny('CONFLICT');
      if (before.state.accounts[key].activeOperation) deny('RESULT_UNKNOWN');
      const driver = this.#driver(key); if (typeof driver.closeLogin !== 'function') deny('DRIVER_UNAVAILABLE');
      await driver.closeLogin(current); this.#authority(current.authorize, current.signal);
      this.store.transact(state => { const row = state.accounts[key]; row.state = 'disconnected'; row.candidate = null;
        row.loginSession = null; row.generation++; }, { revision: body.revision, authorize: current.authorize });
      return { accounts: this.snapshot() };
    });
  }
  cancel(body, context) {
    exactKeys(body, ['platform']); this.#authority(context.authorize, context.signal); platform(body.platform);
    this.live.get(body.platform)?.controller.abort();
    return { requested: true, note: '已请求停止后续步骤；已经发生的操作不撤销，结果未知不会重发。' };
  }
  acknowledgeUnknown(body, context) {
    exactKeys(body, ['operationId', 'revision', 'executionStopped', 'resultReviewed']);
    this.#authority(context.authorize, context.signal);
    if (!uuid(body.operationId) || body.executionStopped !== true || body.resultReviewed !== true) deny('ACK_REQUIRED');
    const before = this.store.read();
    if (before.revision !== body.revision) deny('CONFLICT');
    const original = before.state.operations[body.operationId]; if (!original) deny('CONFLICT');
    this.#recoverLease(original.platform);
    this.store.transact(state => {
      const row = state.operations[body.operationId]; if (!row || !['unknown', 'dispatching'].includes(row.state)) deny('CONFLICT');
      const account = state.accounts[row.platform];
      if (this.live.has(row.platform) || this.drivers[row.platform]?.idle === false) deny('BUSY');
      if (account?.activeOperation !== row.id) deny('CONFLICT');
      row.state = 'unknown'; row.acknowledgedAt = this.iso(); row.updatedAt = this.iso();
      row.note = '主人已确认原执行器停止并核对平台结果；此记录仍为未知，没有重跑。'; account.activeOperation = null;
    }, { revision: body.revision, authorize: context.authorize });
    return { accounts: this.snapshot() };
  }
  recoverExecutor(body, context) {
    exactKeys(body, ['platform', 'revision', 'executionStopped', 'resultReviewed']); platform(body.platform);
    this.#authority(context.authorize, context.signal);
    if (body.executionStopped !== true || body.resultReviewed !== true) deny('ACK_REQUIRED');
    const before = this.store.read(); if (before.revision !== body.revision) deny('CONFLICT');
    if (before.state.accounts[body.platform]?.activeOperation) deny('RESULT_UNKNOWN');
    const driver = this.drivers[body.platform];
    if (driver?.supportsExecutorRecovery === true) return this.#recoverNativeExecutor(body, context, before, driver);
    this.#recoverLease(body.platform); this.#authority(context.authorize, context.signal);
    return { accounts: this.snapshot() };
  }
  async #recoverNativeExecutor(body, context, before, driver) {
    const key=body.platform, directory=this.store.privateDirectory(key), lease=this.#lease(key);
    const lock=path.join(directory,'.recovery-lock'), token=randomUUID(), lockBytes=JSON.stringify({token,pid:process.pid});
    const valid=()=>!this.closed&&this.isOpen()&&!this.controller.signal.aborted&&!context.signal?.aborted&&allowed(context.authorize);
    const readLease=()=>{
      if(this.live.has(key)||ACTIVE_LEASES.has(lease))deny('BUSY');
      if(!fs.existsSync(lease))return null;
      const stat=fs.lstatSync(lease);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>1024)deny('STORAGE_INVALID');
      const bytes=fs.readFileSync(lease), row=JSON.parse(bytes);
      if(!uuid(row.token)||!Number.isSafeInteger(row.pid)||row.pid<1)deny('STORAGE_INVALID');
      if(row.pid!==process.pid){try{process.kill(row.pid,0);deny('BUSY');}catch(error){if(error.code!=='ESRCH')throw error;}}
      return digest(bytes);
    };
    const leaseDigest=readLease(); let fd, prepared;
    if(fs.existsSync(lock)){
      const stat=fs.lstatSync(lock);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>1024)deny('STORAGE_INVALID');
      const bytes=fs.readFileSync(lock,'utf8'),previous=JSON.parse(bytes);
      if(!uuid(previous.token)||!Number.isSafeInteger(previous.pid)||previous.pid<1)deny('STORAGE_INVALID');
      if(previous.pid===process.pid)deny('BUSY');
      try{process.kill(previous.pid,0);deny('BUSY');}catch(error){if(error.code!=='ESRCH')throw error;}
      this.#authority(valid,context.signal);if(fs.readFileSync(lock,'utf8')!==bytes)deny('CONFLICT');fs.unlinkSync(lock);
    }
    try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,lockBytes);fs.fsyncSync(fd);}
    catch(error){if(error.code==='EEXIST')deny('BUSY');throw error;}
    finally{if(fd!==undefined)fs.closeSync(fd);}
    try {
      prepared=await driver.recoverExecutor({...context,authorize:valid,ownerRecovery:true,executionStopped:true,resultReviewed:true});
      this.#authority(valid,context.signal);
      if(this.store.read().revision!==before.revision||readLease()!==leaseDigest)deny('CONFLICT');
      const expected=before.state.accounts[key];
      const result=this.store.transact(state=>{
        const current=state.accounts[key];
        if(current?.activeOperation)deny('RESULT_UNKNOWN');
        if(current?.accountId!==expected?.accountId||current?.generation!==expected?.generation)deny('CONFLICT');
        this.#authority(valid,context.signal);if(readLease()!==leaseDigest)deny('CONFLICT');
        return prepared.commit();
      },{revision:body.revision,authorize:valid}).result;
      this.#authority(valid,context.signal);this.#recoverLease(key,true,lockBytes);
      return {...result,accounts:this.snapshot()};
    } catch(error){prepared?.rollback?.();throw error;}
    finally{prepared?.cancel?.();try{if(fs.readFileSync(lock,'utf8')===lockBytes)fs.unlinkSync(lock);}catch{}}
  }
  holdPlatform(body, context) {
    exactKeys(body, ['platform', 'revision', 'reason']); platform(body.platform); this.#authority(context.authorize, context.signal);
    if (!['account-verification-required', 'owner-paused'].includes(body.reason)) deny('INVALID_REQUEST');
    this.store.transact(state => { const row = state.accounts[body.platform] ||= { state: 'disconnected', generation: 0 };
      row.safetyPause = { reason: body.reason, at: this.iso() }; }, { revision: body.revision, authorize: context.authorize });
    this.live.get(body.platform)?.controller.abort(); return { accounts: this.snapshot() };
  }
  resumePlatform(body, context) {
    exactKeys(body, ['platform', 'revision', 'verificationCompleted']); platform(body.platform); this.#authority(context.authorize, context.signal);
    if (body.verificationCompleted !== true) deny('ACK_REQUIRED');
    if (this.live.has(body.platform) || this.drivers[body.platform]?.idle === false) deny('BUSY');
    this.store.transact(state => { const row = state.accounts[body.platform]; if (!row?.safetyPause) deny('CONFLICT');
      if (row.activeOperation) deny('RESULT_UNKNOWN'); row.safetyPause = null; }, { revision: body.revision, authorize: context.authorize });
    return { accounts: this.snapshot() };
  }
  async stopExecutor(body, context) {
    exactKeys(body, ['platform', 'revision']); platform(body.platform); this.#authority(context.authorize, context.signal);
    if (this.store.read().revision !== body.revision) deny('CONFLICT');
    this.#recoverLease(body.platform, true);
    return this.#exclusive(body.platform, { ...context, stopping: true }, async current => {
      const driver = this.#driver(body.platform);
      if (typeof driver.closeLogin !== 'function') deny('DRIVER_UNAVAILABLE');
      await driver.closeLogin(current); this.#authority(current.authorize, current.signal);
      return { accounts: this.snapshot(), note: '独立执行器已停止；原平台结果仍需核对，没有重发或清除账号登录。' };
    });
  }
  async dispose() { this.closed = true; this.controller.abort(); this.loginImages.clear(); await Promise.allSettled(Object.values(this.drivers).map(driver => driver.dispose?.())); }
}
