import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { allowed, deny, SocialAccountError } from './platforms.mjs';
import { nativeEgoScript, nativeEgoRecoveryScript, nativeEgoActivityStartScript, nativeEgoActivityStopScript, nativeEgoActivityClosedScript } from './native-ego-script.mjs';
import { nativeEgoMetadataScript, nativeEgoProfileMetadataScript } from './native-ego-metadata.mjs';
import { nativeEgoDiagnostic } from './native-ego-diagnostic.mjs';

export const NATIVE_EGO_CLI = path.join(os.homedir(), '.local/bin/ego-browser');
const APPROVED_BUILDS = Object.freeze([
  Object.freeze({ realpath: '/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/0.6.1.11/Helpers/ego-browser',
    sha256: '975f8fb7b8e64f8a619af631491d86096730697b7e2ada5defa92ddf91b32353' }),
  Object.freeze({ realpath: '/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/0.6.1.13/Helpers/ego-browser',
    sha256: 'fc1da0bbf2f8b78b4f171d59ee5a869f4bb8839cf46e5b02a711e82dc1706535' }),
]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileName = 'native-ego.private.json', stateName = 'native-ego-owned.private.json';
function privateJson(file, maximum = 16384) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum || (stat.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw Error();
    const bytes = fs.readFileSync(fd); if (bytes.length > maximum) throw Error();
    return { value: JSON.parse(bytes), digest: digest(bytes), bytes };
  } finally { fs.closeSync(fd); }
}
function readBinding(directory) {
  try {
    if (!path.isAbsolute(directory) || !fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) return null;
    const result = privateJson(path.join(directory, fileName)), v = result.value;
    if (!v || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'pageLabel,spaceId,spaceName,version'
      || v.version !== 2 || !Number.isSafeInteger(v.spaceId) || v.spaceId < 1
      || typeof v.spaceName !== 'string' || !/^[a-z][a-z0-9-]{3,79}$/.test(v.spaceName) || v.pageLabel !== 'p1') return null;
    return result;
  } catch { return null; }
}
export function isApprovedNativeEgoBuild(realpath, sha256) {
  return APPROVED_BUILDS.some(build => realpath === build.realpath && sha256 === build.sha256);
}
export function verifyNativeEgoCli() {
  try {
    const realpath = fs.realpathSync(NATIVE_EGO_CLI);
    if (!APPROVED_BUILDS.some(build => build.realpath === realpath)) return false;
    return isApprovedNativeEgoBuild(realpath, digest(fs.readFileSync(realpath)));
  }
  catch { return false; }
}
/** Exact verified Native Ego 0.6.1.11 / 0.6.1.13 builds only; upgrades require
 * a new path/hash pair. Agent tabs default muted (official 0.4.4.15
 * changelog); background focus fix is in 0.6.1.9. Media pause is supplemental.
 * https://lite.ego.app/hi/changelog and https://lite.ego.app/document/en/docs/space
 * Legacy owner-bound spaces remain compatible. Explicit owner profile policy
 * enables one new Space per new browse activity; never claim or retry unknown. */
export class NativeEgoAccountRuntime {
  #closed = false;
  constructor({ directory, key = path.basename(directory || ''), spawnProcess = spawn, verifyCli = verifyNativeEgoCli, now = () => Date.now(), metadataTtlMs = 60000 } = {}) {
    this.directory = directory; this.key = key; this.spawnProcess = spawnProcess; this.verifyCli = verifyCli;
    this.now = now; this.metadataTtlMs = Number.isSafeInteger(metadataTtlMs) && metadataTtlMs > 0 && metadataTtlMs <= 600000 ? metadataTtlMs : 60000;
    this.metadataEvidence = null; this.metadataEpoch = 0;
    this.children = new Set(); this.cleanupPending = false; this.lastDiagnostic = null; this.recoveryPending = false; this.stoppers = new Map();
  }
  get supportsOwnerLogin() { return false; }
  get backend() { return 'native-ego'; }
  get cliPath() { return NATIVE_EGO_CLI; }
  get nativeReady() { return this.activityReady; }
  get lifecycle() { try { return this.#lifecycle()?.activity.value.phase || 'legacy'; } catch { return 'unknown'; } }
  get activityReady() { return this.lifecycle !== 'closed' && this.metadataStatus.ready; }
  get canStartNewActivity() { return this.lifecycle === 'closed' && this.metadataStatus.ready; }
  get browseState() {
    const binding = readBinding(this.directory); if (this.#closed || !binding) return 'unknown';
    const lifecycle = this.lifecycle; if (lifecycle !== 'legacy') return this.unavailableReason ? 'unknown' : lifecycle === 'closed' ? 'stopped' : lifecycle === 'active' ? 'active' : 'unknown';
    try {
      const state = this.#state(binding);
      if (state.pending || state.unknown || state.creatingPage || this.cleanupPending || this.recoveryPending) return 'unknown';
      return state.createdLabels.length ? 'active' : 'stopped';
    } catch { return 'unknown'; }
  }
  get unavailableReason() {
    if (this.#closed) return 'native-runtime-closed';
    try { const life = this.#lifecycle(); if (life && !['active', 'closed'].includes(life.activity.value.phase)) return 'native-cleanup-unconfirmed'; }
    catch { return 'native-cleanup-unconfirmed'; }
    const binding = readBinding(this.directory);
    if (!['douyin', 'x'].includes(this.key) || !binding) return 'native-space-required';
    try { const state = this.#state(binding); if (state.pending || state.unknown || state.creatingPage || this.lifecycle === 'closed' && (state.createdLabels.length || state.workerPid)) return 'native-cleanup-unconfirmed'; }
    catch { return 'native-cleanup-unconfirmed'; }
    if (this.cleanupPending || this.recoveryPending) return 'native-cleanup-unconfirmed';
    if (!this.verifyCli()) return 'native-cli-version-required';
    return null;
  }
  get available() { return this.unavailableReason === null; }
  get metadataStatus() {
    const localReason = this.unavailableReason, evidence = this.metadataEvidence, binding = readBinding(this.directory), now = this.now();
    if (localReason) return { ready: false, state: 'unavailable', reason: localReason, checkedAt: null, expiresAt: null };
    if (!evidence || evidence.bindingDigest !== binding?.digest) return { ready: false, state: 'not-checked', reason: null, checkedAt: null, expiresAt: null };
    const current = Number.isFinite(now) && now >= evidence.checkedAt && now < evidence.expiresAt;
    return { ready: current && evidence.ready, state: current ? evidence.ready ? this.lifecycle === 'closed' ? 'ready-to-start' : 'ready' : 'unconfirmed' : 'expired',
      reason: evidence.reason, checkedAt: new Date(evidence.checkedAt).toISOString(), expiresAt: new Date(evidence.expiresAt).toISOString() };
  }
  status() { const available = this.available, metadata = this.metadataStatus; return { backend: this.backend, available, configured: available,
    nativeReady: this.activityReady, lifecycle: this.lifecycle, canStartNewActivity: this.canStartNewActivity, activityReady: this.activityReady, reason: this.unavailableReason, readiness: metadata.state, metadata,
    audioPolicy: 'pinned-ego-agent-tabs-default-muted', backgroundPolicy: 'pinned-ego-background-focus-fix',
    lastDiagnostic: nativeEgoDiagnostic(this.lastDiagnostic) }; }
  #failure(code, diagnostic = this.lastDiagnostic) {
    const safe = nativeEgoDiagnostic(diagnostic), error = new SocialAccountError(code);
    if (safe) { this.lastDiagnostic = safe; error.diagnostic = { ...safe }; }
    return error;
  }
  #invalidateMetadata() { this.metadataEpoch++; this.metadataEvidence = null; }
  #recordMetadata(binding, result) {
    const at = this.now(); if (!Number.isFinite(at)) return;
    this.metadataEvidence = { bindingDigest: binding.digest, checkedAt: at, expiresAt: at + this.metadataTtlMs,
      ready: result.ready === true, reason: result.ready === true ? null : result.reason };
  }
  async checkMetadata(context = {}) {
    this.#authority(context);
    if (this.#closed || this.children.size || this.recoveryPending) deny('BUSY');
    if (!this.available) deny('DRIVER_UNAVAILABLE');
    const binding = readBinding(this.directory); if (!binding) deny('BINDINGS_REQUIRED');
    const stateFile = path.join(this.directory, stateName);
    const stateDigest = () => { try { return privateJson(stateFile).digest; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    const captured = stateDigest(), life = this.#lifecycle(), lifeDigest = life?.activity.digest, policyDigest = life?.policy.digest; this.#invalidateMetadata(); const epoch = this.metadataEpoch;
    const marker = '@@DFY_NATIVE_METADATA_' + randomUUID().replaceAll('-', '') + '@@';
    const env = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' };
    for (const name of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) {
      const value = process.env[name]; if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)) env[name] = value;
    }
    let child;
    try { child = this.spawnProcess(NATIVE_EGO_CLI, ['nodejs'], { shell: false, cwd: this.directory, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { deny('DRIVER_UNAVAILABLE'); }
    this.children.add(child);
    return new Promise((resolve, reject) => {
      let output = '', size = 0, aborted = false, done = false, hard, deadline;
      const abort = () => { aborted = true; child.kill('SIGTERM'); hard ||= setTimeout(() => child.kill('SIGKILL'), 1500);
        deadline ||= setTimeout(() => { if (!done) { done = true; this.cleanupPending = true; reject(new SocialAccountError('CLEANUP_UNCONFIRMED')); } }, 3500); };
      const timer = setTimeout(abort, 10000);
      const collect = bytes => { size += bytes.length; if (size > 65536) abort(); else output += bytes.toString(); };
      child.stdout.on('data', collect); child.stderr.on('data', collect); child.on('error', abort); child.stdin.on('error', abort);
      this.stoppers.set(child, abort); context.signal?.addEventListener('abort', abort, { once: true });
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(hard); clearTimeout(deadline); this.children.delete(child); this.stoppers.delete(child);
        context.signal?.removeEventListener('abort', abort); if (done) return; done = true;
        try {
          this.#authority(context);
          if (context.isCurrent && context.isCurrent() !== true) deny('CONFLICT');
          if (this.#closed || this.metadataEpoch !== epoch || readBinding(this.directory)?.digest !== binding.digest || stateDigest() !== captured) deny('CONFLICT');
          if (life && (this.#lifecycle()?.activity.digest !== lifeDigest || this.#lifecycle()?.policy.digest !== policyDigest)) deny('CONFLICT');
          if (!this.available || !this.verifyCli()) deny('DRIVER_UNAVAILABLE');
          if (code !== 0 || aborted) deny('BROWSER_UNKNOWN');
          const lines = output.split(/\r?\n/).filter(line => line.startsWith(marker)); if (lines.length !== 1) deny('INVALID_RECEIPT');
          const value = JSON.parse(lines[0].slice(marker.length));
          if (!value || typeof value.ready !== 'boolean' || Object.keys(value).some(key => !['ready', 'reason'].includes(key))
            || value.ready && value.reason !== undefined || !value.ready && !['space-unavailable', 'ownership-changed', 'identity-page-unavailable', 'profile-unavailable'].includes(value.reason)) deny('INVALID_RECEIPT');
          this.#recordMetadata(binding, value); resolve(this.metadataStatus);
        } catch (error) { this.#invalidateMetadata(); reject(error instanceof SocialAccountError ? error : new SocialAccountError('INVALID_RECEIPT')); }
      });
      if (context.signal?.aborted || !allowed(context.authorize)) abort(); else child.stdin.end(life?.activity.value.phase === 'closed' ? nativeEgoProfileMetadataScript(life.policy.value.profileId, marker) : nativeEgoMetadataScript(binding.value, marker, life?.policy.value.profileId));
    });
  }
  #authority(context) { if (!allowed(context.authorize) || context.signal?.aborted) deny('FORBIDDEN'); if (context.isCurrent && context.isCurrent() !== true) deny('CONFLICT'); }

  #lifecycle() {
    let policy;
    try { policy = privateJson(path.join(this.directory, 'native-ego-profile.private.json')); }
    catch (error) { if (error.code === 'ENOENT' && !fs.existsSync(path.join(this.directory, 'native-ego-activity.private.json'))) return null; deny('CLEANUP_UNCONFIRMED'); }
    const value = policy.value;
    if (this.key !== 'douyin' || !value || Object.keys(value).sort().join(',') !== 'accountBindingDigest,profileId,version'
      || value.version !== 1 || value.profileId !== 'Default' || !/^[a-f0-9]{64}$/.test(value.accountBindingDigest || '')) deny('CLEANUP_UNCONFIRMED');
    let accountBinding, activity;
    try { accountBinding = privateJson(path.join(this.directory, 'bindings.private.json'), 65536);
      activity = privateJson(path.join(this.directory, 'native-ego-activity.private.json')); }
    catch { deny('CLEANUP_UNCONFIRMED'); }
    if (accountBinding.digest !== value.accountBindingDigest || accountBinding.value.platform !== this.key
      || accountBinding.value.verified !== true || typeof accountBinding.value.accountId !== 'string') deny('BINDINGS_REQUIRED');
    const row = activity.value;
    if (!row || Object.keys(row).sort().join(',') !== 'activityId,bindingDigest,phase,policyDigest,spaceName,version,workerPid'
      || row.version !== 1 || row.policyDigest !== policy.digest || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(row.activityId || '')
      || !/^[a-z][a-z0-9-]{3,79}$/.test(row.spaceName || '') || !['creating', 'active', 'stopping', 'closed', 'unknown'].includes(row.phase)
      || !/^[a-f0-9]{64}$/.test(row.bindingDigest || '') || ['active', 'closed'].includes(row.phase) && row.workerPid !== null || row.workerPid !== null && (!Number.isSafeInteger(row.workerPid) || row.workerPid < 2)) deny('CLEANUP_UNCONFIRMED');
    const binding = readBinding(this.directory);
    if (['active', 'closed'].includes(row.phase) && (!binding || binding.digest !== row.bindingDigest
      || binding.value.spaceName !== row.spaceName)) deny('CLEANUP_UNCONFIRMED');
    return { policy, activity, accountBinding };
  }
  #atomic(name, value) {
    const file = path.join(this.directory, name), temp = file + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(temp, file); const dir = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
    finally { fs.rmSync(temp, { force: true }); }
  }
  #journal(row) { this.#atomic('native-ego-activity.private.json', row); }
  #stateDigest() { try { return privateJson(path.join(this.directory, stateName)).digest; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  #control(script, marker, context, onSpawn, timeoutMs = 15000) {
    this.#authority(context);
    if (this.#closed || this.children.size || this.recoveryPending || !this.verifyCli()) deny('DRIVER_UNAVAILABLE');
    this.lastDiagnostic = null;
    const env = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' };
    for (const name of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) {
      const value = process.env[name]; if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)) env[name] = value;
    }
    let child;
    try { child = this.spawnProcess(NATIVE_EGO_CLI, ['nodejs'], { shell: false, cwd: this.directory, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { deny('BROWSER_UNKNOWN'); }
    this.children.add(child);
    return new Promise((resolve, reject) => {
      let output = '', size = 0, aborted = false, done = false, hard, deadline;
      const abort = () => { aborted = true; child.kill('SIGTERM'); hard ||= setTimeout(() => child.kill('SIGKILL'), 1500);
        deadline ||= setTimeout(() => { if (!done) { done = true; this.cleanupPending = true; reject(new SocialAccountError('CLEANUP_UNCONFIRMED')); } }, 3500); };
      const timer = setTimeout(abort, timeoutMs), collect = bytes => { size += bytes.length; if (size > 65536) abort(); else output += bytes.toString(); };
      child.stdout.on('data', collect); child.stderr.on('data', collect); child.on('error', abort); child.stdin.on('error', abort);
      this.stoppers.set(child, abort); context.signal?.addEventListener('abort', abort, { once: true });
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(hard); clearTimeout(deadline); this.children.delete(child); this.stoppers.delete(child);
        context.signal?.removeEventListener('abort', abort); if (done) return; done = true;
        try {
          this.#authority(context); if (context.isCurrent && context.isCurrent() !== true) deny('CONFLICT');
          if (this.#closed || !this.verifyCli() || code !== 0 || aborted) deny('BROWSER_UNKNOWN');
          const lines = output.split(/\r?\n/).filter(line => line.startsWith(marker)); if (lines.length !== 1) deny('INVALID_RECEIPT');
          const value = JSON.parse(lines[0].slice(marker.length));
          if (value?.__dfy_error) throw this.#failure(['BINDINGS_REQUIRED', 'CLEANUP_UNCONFIRMED'].includes(value.__dfy_error) ? value.__dfy_error : 'BROWSER_UNKNOWN', value.diagnostic);
          resolve(value);
        } catch (error) { reject(error instanceof SocialAccountError ? error : new SocialAccountError('INVALID_RECEIPT')); }
      });
      try { onSpawn?.(Number.isSafeInteger(child.pid) && child.pid > 1 ? child.pid : null); }
      catch { abort(); }
      if (context.signal?.aborted || !allowed(context.authorize)) abort();
      if (!aborted) child.stdin.end(script);
    });
  }
  async beginActivity(context = {}) {
    this.#authority(context);
    const life = this.#lifecycle(); if (!life) return { legacy: true };
    if (!this.available || this.children.size || this.recoveryPending) deny('DRIVER_UNAVAILABLE');
    if (life.activity.value.phase !== 'closed') deny('BUSY');
    const previousBinding = readBinding(this.directory), previousState = this.#state(previousBinding);
    this.#noWorker(previousState);
    if (previousState.pending || previousState.unknown || previousState.creatingPage || previousState.createdLabels.length) deny('CLEANUP_UNCONFIRMED');
    const stateDigest = this.#stateDigest(), originalBindingDigest = previousBinding.digest;
    const row = { ...life.activity.value, activityId: randomUUID(), spaceName: 'dfy-douyin-activity-' + randomUUID(), phase: 'creating', workerPid: null };
    this.#invalidateMetadata(); this.#journal(row);
    let captured = this.#lifecycle().activity.digest;
    const same = () => {
      this.#authority(context);
      const current = this.#lifecycle();
      if (this.#closed || !this.verifyCli() || current.policy.digest !== life.policy.digest || current.activity.digest !== captured
        || readBinding(this.directory)?.digest !== originalBindingDigest || this.#stateDigest() !== stateDigest) deny('CONFLICT');
    };
    const unknown = () => { this.cleanupPending = true; try { const current = this.#lifecycle(); if (current.activity.digest === captured) this.#journal({ ...current.activity.value, phase: 'unknown', workerPid: this.children.size ? current.activity.value.workerPid : null }); } catch {} };
    const marker = '@@DFY_ACTIVITY_CREATE_' + randomUUID().replaceAll('-', '') + '@@';
    try {
      const result = await this.#control(nativeEgoActivityStartScript({ profileId: life.policy.value.profileId, spaceName: row.spaceName, marker }), marker, context, pid => {
        same(); row.workerPid = pid; this.#journal(row); captured = this.#lifecycle().activity.digest;
      });
      same();
      const value = result?.binding;
      if (!result || Object.keys(result).join(',') !== 'binding' || !value || Object.keys(value).sort().join(',') !== 'pageLabel,spaceId,spaceName,version'
        || value.version !== 2 || !Number.isSafeInteger(value.spaceId) || value.spaceId < 1 || value.spaceName !== row.spaceName || value.pageLabel !== 'p1') deny('INVALID_RECEIPT');
      const text = JSON.stringify(value), next = { version: 1, bindingDigest: digest(text), spaceId: value.spaceId,
        createdLabels: [], pending: false, unknown: false, creatingPage: false, workerPid: null };
      // A crash anywhere before the final journal leaves creating/unknown and
      // blocks all new allocations, including after a plugin reload.
      this.#atomic(fileName, text); this.#save(next);
      this.#journal({ ...row, bindingDigest: digest(text), phase: 'active', workerPid: null });
      this.cleanupPending = false; this.#recordMetadata(readBinding(this.directory), { ready: true });
      return { started: true, activityId: row.activityId };
    } catch (error) { unknown(); throw error; }
  }
  async #stopActivity(context) {
    this.#authority(context);
    const life = this.#lifecycle(), row = life.activity.value, binding = readBinding(this.directory);
    if (row.phase === 'closed') {
      const state = this.#state(binding); this.#noWorker(state);
      if (state.pending || state.unknown || state.creatingPage || state.createdLabels.length || this.cleanupPending) deny('CLEANUP_UNCONFIRMED');
      return { stopped: true, taskSpaceClosed: true, spaceRetained: false, browserStopped: false };
    }
    if (row.phase !== 'active' || this.cleanupPending || this.recoveryPending) deny('CLEANUP_UNCONFIRMED');
    const state = this.#state(binding); this.#noWorker(state);
    if (state.pending || state.unknown || state.creatingPage) deny('CLEANUP_UNCONFIRMED');
    const stateDigest = this.#stateDigest(); this.#invalidateMetadata();
    const stopping = { ...row, phase: 'stopping', workerPid: null }; this.#journal(stopping);
    let captured = this.#lifecycle().activity.digest;
    const same = () => {
      this.#authority(context); const current = this.#lifecycle();
      if (this.#closed || !this.verifyCli() || current.policy.digest !== life.policy.digest || current.activity.digest !== captured
        || readBinding(this.directory)?.digest !== binding.digest || this.#stateDigest() !== stateDigest) deny('CONFLICT');
    };
    const marker = '@@DFY_ACTIVITY_FINISH_' + randomUUID().replaceAll('-', '') + '@@';
    try {
      const finished = await this.#control(nativeEgoActivityStopScript({ binding: binding.value, labels: state.createdLabels,
        profileId: life.policy.value.profileId, marker }), marker, context, pid => {
        same(); stopping.workerPid = pid; this.#journal(stopping); captured = this.#lifecycle().activity.digest;
      }, 30000);
      same();
      if (!finished || Object.keys(finished).sort().join(',') !== 'alreadyAbsent,finishAccepted'
        || finished.finishAccepted !== true || typeof finished.alreadyAbsent !== 'boolean') deny('INVALID_RECEIPT');
      // The first CLI has now exited. Only observe the same known Space in a
      // second process: no finish replay, new task, Page access or activation.
      const confirmationMarker = '@@DFY_ACTIVITY_CLOSED_' + randomUUID().replaceAll('-', '') + '@@';
      const result = await this.#control(nativeEgoActivityClosedScript({ binding: binding.value, marker: confirmationMarker }), confirmationMarker, context, pid => {
        same(); stopping.workerPid = pid; this.#journal(stopping); captured = this.#lifecycle().activity.digest;
      }, 10000);
      same();
      if (!result || Object.keys(result).sort().join(',') !== 'browserStopped,spaceRetained,stopped,taskSpaceClosed'
        || result.stopped !== true || result.taskSpaceClosed !== true || result.spaceRetained !== false || result.browserStopped !== false) deny('INVALID_RECEIPT');
      this.#save({ ...state, createdLabels: [], pending: false, unknown: false, creatingPage: false, workerPid: null });
      this.#journal({ ...stopping, phase: 'closed', workerPid: null });
      this.cleanupPending = false; return result;
    } catch (error) {
      this.cleanupPending = true;
      try { const current = this.#lifecycle(); if (current.activity.digest === captured) this.#journal({ ...current.activity.value, phase: 'unknown', workerPid: this.children.size ? current.activity.value.workerPid : null }); } catch {}
      throw error;
    }
  }
  #state(binding) {
    let state;
    try { state = privateJson(path.join(this.directory, stateName)).value; }
    catch (error) { if (error.code !== 'ENOENT') deny('CLEANUP_UNCONFIRMED'); }
    if (!state) return { version: 1, bindingDigest: binding.digest, spaceId: binding.value.spaceId,
      createdLabels: [], pending: false, unknown: false, creatingPage: false };
    if (Object.keys(state).filter(k=>k!=='workerPid').sort().join(',') !== 'bindingDigest,createdLabels,creatingPage,pending,spaceId,unknown,version'
      || state.workerPid !== undefined && state.workerPid !== null && (!Number.isSafeInteger(state.workerPid) || state.workerPid < 2)
      || state.version !== 1 || state.bindingDigest !== binding.digest || state.spaceId !== binding.value.spaceId
      || !Array.isArray(state.createdLabels) || state.createdLabels.length > 20
      || state.createdLabels.some(x => !/^p(?:[2-9]|[1-9][0-9]+)$/.test(x))
      || new Set(state.createdLabels).size !== state.createdLabels.length
      || ['pending', 'unknown', 'creatingPage'].some(k => typeof state[k] !== 'boolean')) deny('CLEANUP_UNCONFIRMED');
    return state;
  }
  #save(state) { this.#atomic(stateName, state); }
  async run(body, context = {}, { timeoutMs = 60000 } = {}) { return this.#run(body, context, timeoutMs, false); }
  async #run(body, context, timeoutMs, stopping) {
    this.#authority(context);
    this.#invalidateMetadata();
    const life = this.#lifecycle(); if (life && life.activity.value.phase !== 'active') deny(['creating', 'stopping', 'unknown'].includes(life.activity.value.phase) ? 'CLEANUP_UNCONFIRMED' : 'BINDINGS_REQUIRED');
    const binding = readBinding(this.directory);
    if (!binding || !['douyin', 'x'].includes(this.key)) deny('BINDINGS_REQUIRED');
    if (this.#closed || this.children.size || this.recoveryPending || !this.verifyCli() || !stopping && this.cleanupPending) deny('DRIVER_UNAVAILABLE');
    if (typeof body !== 'string' || body.length > 128000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 240000) deny('INVALID_REQUEST');
    const lifeDigest = life?.activity.digest, policyDigest = life?.policy.digest;
    const state = this.#state(binding);
    if (!stopping && (state.pending || state.unknown || state.creatingPage)) { this.cleanupPending = true; deny('CLEANUP_UNCONFIRMED'); }
    this.lastDiagnostic = null;
    state.pending = true; this.#save(state);
    const marker = '@@DFY_NATIVE_' + randomUUID().replaceAll('-', '') + '@@';
    let script = nativeEgoScript({ binding: binding.value, state, stateFile: path.join(this.directory, stateName), marker, key: this.key, body, stop: stopping, profileId: life?.policy.value.profileId });
    const env = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' };
    // Preserve only non-secret caller identity so native spaces remain owned by
    // the same harness. Never inherit browser, provider or proxy credentials.
    for (const name of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) {
      const value = process.env[name]; if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)) env[name] = value;
    }
    let child;
    try { child = this.spawnProcess(NATIVE_EGO_CLI, ['nodejs'], { shell: false, cwd: this.directory,
      env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { state.unknown = true; this.#save(state); this.cleanupPending = true;
      throw this.#failure('BROWSER_UNKNOWN', { phase: 'native-process', name: 'Error', code: 'PROCESS_ERROR' }); }
    this.children.add(child);
    state.workerPid = Number.isSafeInteger(child.pid) && child.pid > 1 ? child.pid : null; this.#save(state);
    script = nativeEgoScript({ binding: binding.value, state, stateFile: path.join(this.directory, stateName), marker, key: this.key, body, stop: stopping, profileId: life?.policy.value.profileId });
    return new Promise((resolve, reject) => {
      let output = '', size = 0, cancelled = false, settled = false, hardTimer, finalTimer, abortReason;
      const markUnknown = () => { this.cleanupPending = true; try { const current = this.#state(binding); current.unknown = true; this.#save(current); } catch {} };
      const abort = (reason = 'CANCELLED') => { abortReason ||= ['TIMEOUT', 'OUTPUT_LIMIT', 'PROCESS_ERROR'].includes(reason) ? reason : 'CANCELLED';
        this.lastDiagnostic = { phase: 'native-process', name: 'AbortError', code: abortReason };
        cancelled = true; markUnknown(); child.kill('SIGTERM');
        hardTimer ||= setTimeout(() => child.kill('SIGKILL'), 1500);
        finalTimer ||= setTimeout(() => { if (!settled) { settled = true; reject(this.#failure('CLEANUP_UNCONFIRMED')); } }, 3500); };
      const timer = setTimeout(() => abort('TIMEOUT'), timeoutMs);
      const collect = data => { size += data.length; if (size > 2 * 1024 * 1024) abort('OUTPUT_LIMIT'); else output += data.toString(); };
      child.stdout.on('data', collect); child.stderr.on('data', collect); child.stdin.on('error', () => abort('PROCESS_ERROR')); child.on('error', () => abort('PROCESS_ERROR'));
      context.signal?.addEventListener('abort', abort, { once: true }); this.stoppers.set(child, abort);
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(hardTimer); clearTimeout(finalTimer); context.signal?.removeEventListener('abort', abort);
        this.children.delete(child); this.stoppers.delete(child);
        try { const current = this.#state(binding); if (current.workerPid === child.pid || current.workerPid === null) { current.workerPid = null; this.#save(current); } } catch {}
        if (settled) return;
        settled = true;
        let lifeChanged = false; try { if (life) lifeChanged = this.#lifecycle()?.activity.digest !== lifeDigest || this.#lifecycle()?.policy.digest !== policyDigest; } catch { lifeChanged = true; }
        if (code !== 0 || cancelled || !allowed(context.authorize) || context.signal?.aborted || context.isCurrent && context.isCurrent() !== true || !this.verifyCli() || lifeChanged || readBinding(this.directory)?.digest !== binding.digest) {
          markUnknown(); reject(this.#failure('BROWSER_UNKNOWN', this.lastDiagnostic || { phase: 'native-process', name: 'Error', code: 'PROCESS_EXIT' })); return;
        }
        const lines = output.split(/\r?\n/).filter(line => line.startsWith(marker));
        try {
          if (lines.length !== 1) throw Error();
          const value = JSON.parse(lines[0].slice(marker.length)); const error = value?.__dfy_error;
          this.lastDiagnostic = nativeEgoDiagnostic(value?.diagnostic);
          const current = this.#state(binding);
          if (error === 'BROWSER_UNKNOWN' || error === 'CLEANUP_UNCONFIRMED') { markUnknown(); reject(this.#failure(error)); return; }
          if (error && !['RISK_CONTROL', 'ACCOUNT_MISMATCH', 'BINDINGS_REQUIRED'].includes(error)) throw Error();
          current.pending = false; this.#save(current); this.cleanupPending = current.unknown || current.creatingPage;
          if (error) { reject(this.#failure(error)); return; }
          if (stopping && (value?.stopped !== true || value.browserStopped !== false || value.spaceRetained !== true
            || current.createdLabels.length || current.unknown || current.creatingPage)) throw Error();
          this.#recordMetadata(binding, { ready: true });
          resolve(value);
        } catch { markUnknown(); reject(this.#failure('INVALID_RECEIPT', { phase: 'native-receipt', name: 'Error', code: 'INVALID_RECEIPT' })); }
      });
      if (context.signal?.aborted || !allowed(context.authorize)) abort();
      if (!cancelled) child.stdin.end(script);
    });
  }

  #noWorker(state) {
    if (this.children.size) deny('BUSY');
    if (state.workerPid) {
      try { process.kill(state.workerPid, 0); deny('BUSY'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  async #recoveryProbe(binding, state, context) {
    const marker = '@@DFY_NATIVE_RECOVERY_' + randomUUID().replaceAll('-', '') + '@@';
    const script = nativeEgoRecoveryScript({ binding: binding.value, labels: state.createdLabels, marker });
    const env = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' };
    for (const name of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) {
      const value = process.env[name]; if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)) env[name] = value;
    }
    let child;
    try { child = this.spawnProcess(NATIVE_EGO_CLI, ['nodejs'], { shell: false, cwd: this.directory, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { deny('CLEANUP_UNCONFIRMED'); }
    this.children.add(child);
    return new Promise((resolve, reject) => {
      let output = '', size = 0, aborted = false, done = false, hard, deadline;
      const abort = () => { aborted = true; child.kill('SIGTERM'); hard ||= setTimeout(()=>child.kill('SIGKILL'),1500);
        deadline ||= setTimeout(()=>{ if(!done){done=true;reject(new SocialAccountError('CLEANUP_UNCONFIRMED'));}},3500); };
      const timer = setTimeout(abort, 10000);
      const collect = bytes => { size += bytes.length; if(size>2*1024*1024)abort(); else output += bytes.toString(); };
      child.stdout.on('data',collect); child.stderr.on('data',collect); child.on('error',abort); child.stdin.on('error',abort);
      this.stoppers.set(child,abort); context.signal?.addEventListener('abort',abort,{once:true});
      child.once('close',code=>{
        clearTimeout(timer);clearTimeout(hard);clearTimeout(deadline);this.children.delete(child);this.stoppers.delete(child);
        context.signal?.removeEventListener('abort',abort); if(done)return;done=true;
        try {
          this.#authority(context);
          if(code!==0||aborted)deny('CLEANUP_UNCONFIRMED');
          const lines=output.split(/\r?\n/).filter(line=>line.startsWith(marker));if(lines.length!==1)deny('INVALID_RECEIPT');
          const result=JSON.parse(lines[0].slice(marker.length));
          if(result?.ready!==true||result.spaceRetained!==true)deny(['BINDINGS_REQUIRED','CLEANUP_UNCONFIRMED'].includes(result?.__dfy_error)?result.__dfy_error:'CLEANUP_UNCONFIRMED');
          resolve(result);
        } catch(error) { reject(error instanceof SocialAccountError?error:new SocialAccountError('CLEANUP_UNCONFIRMED')); }
      });
      if(context.signal?.aborted||!allowed(context.authorize))abort();else child.stdin.end(script);
    });
  }
  /** Prepare only. The manager commits synchronously under its store CAS lock. */
  async recoverExecutor(context = {}) {
    this.#authority(context); this.#invalidateMetadata();
    if(context.ownerRecovery!==true||context.executionStopped!==true||context.resultReviewed!==true)deny('ACK_REQUIRED');
    if(this.#closed||this.recoveryPending||!this.verifyCli())deny('DRIVER_UNAVAILABLE');
    const binding=readBinding(this.directory);if(!binding)deny('BINDINGS_REQUIRED');
    const state=this.#state(binding);this.#noWorker(state);if(state.creatingPage)deny('CLEANUP_UNCONFIRMED');
    const stateFile=path.join(this.directory,stateName), captured=privateJson(stateFile);
    this.recoveryPending=true;let committed=false, clearedDigest;
    const cancel=()=>{this.recoveryPending=false;};
    const same=()=>{
      this.#authority(context);
      if(this.#closed||!this.recoveryPending||readBinding(this.directory)?.digest!==binding.digest)deny('CONFLICT');
      if(privateJson(stateFile).digest!==captured.digest)deny('CONFLICT');
      this.#noWorker(this.#state(binding));
    };
    try { await this.#recoveryProbe(binding,state,context);same(); }
    catch(error){cancel();throw error;}
    return {
      commit:()=>{
        same();
        const directory=path.join(this.directory,'native-recovery-proofs');
        fs.mkdirSync(directory,{recursive:true,mode:0o700});if(fs.lstatSync(directory).isSymbolicLink())deny('INVALID_STORAGE');
        const proof=JSON.stringify({version:1,stateDigest:captured.digest,bindingDigest:binding.digest,
          spaceId:binding.value.spaceId,unknownStateBytes:captured.bytes.toString('utf8'),executionStopped:true,resultReviewed:true,spaceRetained:true});
        const file=path.join(directory,captured.digest+'.json');let fd;
        try { fd=fs.openSync(file,'wx',0o400);fs.writeFileSync(fd,proof);fs.fsyncSync(fd); }
        catch(error){if(error.code!=='EEXIST'||privateJson(file).bytes.toString('utf8')!==proof)throw error;}
        finally{if(fd!==undefined)fs.closeSync(fd);}
        const dir=fs.openSync(directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
        same();const cleared={...state,createdLabels:[],pending:false,unknown:false,creatingPage:false,workerPid:null};
        this.#save(cleared);clearedDigest=privateJson(stateFile).digest;committed=true;
        this.cleanupPending=false;this.recoveryPending=false;
        return {recovered:true,spaceRetained:true,unknownResultRetained:true,proofDigest:captured.digest};
      },
      cancel,
      rollback:()=>{
        this.cleanupPending=true;this.recoveryPending=false;
        // Never overwrite a newer unknown or a changed binding during rollback.
        if(committed&&readBinding(this.directory)?.digest===binding.digest&&privateJson(stateFile).digest===clearedDigest)this.#save(captured.value);
      },
    };
  }

  async stop(context = {}) {
    this.#authority(context);
    if (this.#lifecycle()) return this.#stopActivity(context);
    const binding = readBinding(this.directory);
    if (!binding && !this.cleanupPending && !this.children.size) return { stopped: true, browserStopped: false, spaceRetained: true };
    if (this.children.size) deny('CLEANUP_UNCONFIRMED');
    return this.#run('', context, 30000, true);
  }
  async dispose() {
    this.#closed = true; this.#invalidateMetadata();
    const waits = [...this.children].map(child => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SocialAccountError('CLEANUP_UNCONFIRMED')), 4000);
      child.once('close', () => { clearTimeout(timer); resolve(); }); this.stoppers.get(child)?.();
    }));
    await Promise.all(waits);
    if (this.cleanupPending) deny('CLEANUP_UNCONFIRMED');
  }
}
