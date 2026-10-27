import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { allowed, deny, SocialAccountError } from './platforms.mjs';
import { nativeEgoScript, nativeEgoRecoveryScript } from './native-ego-script.mjs';

export const NATIVE_EGO_CLI = path.join(os.homedir(), '.local/bin/ego-browser');
const PIN = { realpath: '/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/0.6.1.11/Helpers/ego-browser',
  sha256: '975f8fb7b8e64f8a619af631491d86096730697b7e2ada5defa92ddf91b32353' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileName = 'native-ego.private.json', stateName = 'native-ego-owned.private.json';
function privateJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 16384 || (stat.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw Error();
    const bytes = fs.readFileSync(fd); if (bytes.length > 16384) throw Error();
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
export function verifyNativeEgoCli() {
  try { return fs.realpathSync(NATIVE_EGO_CLI) === PIN.realpath && digest(fs.readFileSync(PIN.realpath)) === PIN.sha256; }
  catch { return false; }
}
/** Native Ego 0.6.1.11 only. Agent tabs default muted (official 0.4.4.15
 * changelog); background focus fix is in 0.6.1.9. Media pause is supplemental.
 * https://lite.ego.app/hi/changelog and https://lite.ego.app/document/en/docs/space
 * Existing owner-bound Agent space only: no create, claim, profile or fallback. */
export class NativeEgoAccountRuntime {
  #closed = false;
  constructor({ directory, key = path.basename(directory || ''), spawnProcess = spawn, verifyCli = verifyNativeEgoCli } = {}) {
    this.directory = directory; this.key = key; this.spawnProcess = spawnProcess; this.verifyCli = verifyCli;
    this.children = new Set(); this.cleanupPending = false; this.lastDiagnostic = null; this.recoveryPending = false; this.stoppers = new Map();
  }
  get supportsOwnerLogin() { return false; }
  get backend() { return 'native-ego'; }
  get cliPath() { return NATIVE_EGO_CLI; }
  get nativeReady() { return this.available; }
  get unavailableReason() {
    if (this.#closed) return 'native-runtime-closed';
    const binding = readBinding(this.directory);
    if (!['douyin', 'x'].includes(this.key) || !binding) return 'native-space-required';
    try { const state = this.#state(binding); if (state.pending || state.unknown || state.creatingPage) return 'native-cleanup-unconfirmed'; }
    catch { return 'native-cleanup-unconfirmed'; }
    if (this.cleanupPending || this.recoveryPending) return 'native-cleanup-unconfirmed';
    if (!this.verifyCli()) return 'native-cli-version-required';
    return null;
  }
  get available() { return this.unavailableReason === null; }
  status() { const available = this.available; return { backend: this.backend, available, nativeReady: available,
    reason: this.unavailableReason, readiness: 'local-binding-only', audioPolicy: 'pinned-ego-agent-tabs-default-muted',
    backgroundPolicy: 'pinned-ego-background-focus-fix' }; }
  #authority(context) { if (!allowed(context.authorize) || context.signal?.aborted) deny('FORBIDDEN'); }
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
  #save(state) {
    const file = path.join(this.directory, stateName), temp = file + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
  }
  async run(body, context = {}, { timeoutMs = 60000 } = {}) { return this.#run(body, context, timeoutMs, false); }
  async #run(body, context, timeoutMs, stopping) {
    this.#authority(context);
    const binding = readBinding(this.directory);
    if (!binding || !['douyin', 'x'].includes(this.key)) deny('BINDINGS_REQUIRED');
    if (this.#closed || this.children.size || this.recoveryPending || !this.verifyCli() || !stopping && this.cleanupPending) deny('DRIVER_UNAVAILABLE');
    if (typeof body !== 'string' || body.length > 128000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 240000) deny('INVALID_REQUEST');
    const state = this.#state(binding);
    if (!stopping && (state.pending || state.unknown || state.creatingPage)) { this.cleanupPending = true; deny('CLEANUP_UNCONFIRMED'); }
    state.pending = true; this.#save(state);
    const marker = '@@DFY_NATIVE_' + randomUUID().replaceAll('-', '') + '@@';
    let script = nativeEgoScript({ binding: binding.value, state, stateFile: path.join(this.directory, stateName), marker, key: this.key, body, stop: stopping });
    const env = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' };
    // Preserve only non-secret caller identity so native spaces remain owned by
    // the same harness. Never inherit browser, provider or proxy credentials.
    for (const name of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) {
      const value = process.env[name]; if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)) env[name] = value;
    }
    let child;
    try { child = this.spawnProcess(NATIVE_EGO_CLI, ['nodejs'], { shell: false, cwd: this.directory,
      env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { state.unknown = true; this.#save(state); this.cleanupPending = true; deny('BROWSER_UNKNOWN'); }
    this.children.add(child);
    state.workerPid = Number.isSafeInteger(child.pid) && child.pid > 1 ? child.pid : null; this.#save(state);
    script = nativeEgoScript({ binding: binding.value, state, stateFile: path.join(this.directory, stateName), marker, key: this.key, body, stop: stopping });
    return new Promise((resolve, reject) => {
      let output = '', size = 0, cancelled = false, settled = false, hardTimer, finalTimer;
      const markUnknown = () => { this.cleanupPending = true; try { const current = this.#state(binding); current.unknown = true; this.#save(current); } catch {} };
      const abort = () => { cancelled = true; markUnknown(); child.kill('SIGTERM');
        hardTimer ||= setTimeout(() => child.kill('SIGKILL'), 1500);
        finalTimer ||= setTimeout(() => { if (!settled) { settled = true; reject(new SocialAccountError('CLEANUP_UNCONFIRMED')); } }, 3500); };
      const timer = setTimeout(abort, timeoutMs);
      const collect = data => { size += data.length; if (size > 2 * 1024 * 1024) abort(); else output += data.toString(); };
      child.stdout.on('data', collect); child.stderr.on('data', collect); child.stdin.on('error', abort); child.on('error', abort);
      context.signal?.addEventListener('abort', abort, { once: true }); this.stoppers.set(child, abort);
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(hardTimer); clearTimeout(finalTimer); context.signal?.removeEventListener('abort', abort);
        this.children.delete(child); this.stoppers.delete(child);
        try { const current = this.#state(binding); if (current.workerPid === child.pid || current.workerPid === null) { current.workerPid = null; this.#save(current); } } catch {}
        if (settled) return;
        settled = true;
        if (code !== 0 || cancelled || !allowed(context.authorize) || context.signal?.aborted || readBinding(this.directory)?.digest !== binding.digest) {
          markUnknown(); reject(new SocialAccountError('BROWSER_UNKNOWN')); return;
        }
        const lines = output.split(/\r?\n/).filter(line => line.startsWith(marker));
        try {
          if (lines.length !== 1) throw Error();
          const value = JSON.parse(lines[0].slice(marker.length)); const error = value?.__dfy_error;
          if (['bootstrap', 'binding-list', 'binding-resume', 'identity-tabs', 'script-body', 'state-write'].includes(value?.diagnostic?.phase)
            && ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AbortError'].includes(value.diagnostic.name))
            this.lastDiagnostic = { phase: value.diagnostic.phase, name: value.diagnostic.name };
          const current = this.#state(binding);
          if (error === 'BROWSER_UNKNOWN' || error === 'CLEANUP_UNCONFIRMED') { markUnknown(); reject(new SocialAccountError(error)); return; }
          if (error && !['RISK_CONTROL', 'ACCOUNT_MISMATCH', 'BINDINGS_REQUIRED'].includes(error)) throw Error();
          current.pending = false; this.#save(current); this.cleanupPending = current.unknown || current.creatingPage;
          if (error) { reject(new SocialAccountError(error)); return; }
          if (stopping && (value?.stopped !== true || value.browserStopped !== false || value.spaceRetained !== true
            || current.createdLabels.length || current.unknown || current.creatingPage)) throw Error();
          resolve(value);
        } catch { markUnknown(); reject(new SocialAccountError('INVALID_RECEIPT')); }
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
    this.#authority(context);
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
    const binding = readBinding(this.directory);
    if (!binding && !this.cleanupPending && !this.children.size) return { stopped: true, browserStopped: false, spaceRetained: true };
    if (this.children.size) deny('CLEANUP_UNCONFIRMED');
    return this.#run('', context, 30000, true);
  }
  async dispose() {
    this.#closed = true;
    const waits = [...this.children].map(child => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SocialAccountError('CLEANUP_UNCONFIRMED')), 4000);
      child.once('close', () => { clearTimeout(timer); resolve(); }); this.stoppers.get(child)?.();
    }));
    await Promise.all(waits);
    if (this.cleanupPending) deny('CLEANUP_UNCONFIRMED');
  }
}
