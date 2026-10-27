import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { allowed, deny, SocialAccountError } from './platforms.mjs';

const LOCK = fileURLToPath(new URL('./ego-runtime-lock.json', import.meta.url));
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const exec = promisify(execFile);
function ownsProfile(command, directory, chrome) {
  const profile = '--user-data-dir=' + path.join(directory, 'profile');
  const start = command.indexOf(profile), suffix = start < 0 ? '?' : command.slice(start + profile.length, start + profile.length + 1);
  return command.includes(chrome) && start >= 0 && (!suffix || /[\s"']/.test(suffix));
}
async function findOwnBrowsers(directory, chrome) {
  // Filter locally; never log or return the process list or other profiles.
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,command='], { timeout: 1500, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(.+)$/.exec(line);
    return row && ownsProfile(row[2], directory, chrome) ? [Number(row[1])] : [];
  });
}
async function probeOwnBrowser(pid, directory, chrome) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; deny('CLEANUP_UNCONFIRMED'); }
  let command; try { command = (await exec('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 1500, maxBuffer: 32768 })).stdout; }
  catch { try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; } deny('CLEANUP_UNCONFIRMED'); }
  if (!ownsProfile(command, directory, chrome)) deny('CLEANUP_UNCONFIRMED');
  return true;
}
export function discoverSocialEgoRuntime() {
  const base = path.join(os.homedir(), '.dsh/profiles/desktop/node_modules/dsh-ego-browser');
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    for (const [file, expected] of Object.entries(lock.files)) {
      if (createHash('sha256').update(fs.readFileSync(path.join(base, file))).digest('hex') !== expected) return null;
    }
    const chrome = CHROME.find(file => fs.existsSync(file));
    return chrome ? { entry: path.join(base, 'runtime/ego-linux/bin/ego-browser.mjs'), chrome, version: lock.version } : null;
  } catch { return null; }
}

/** Installed managed Ego runtime, separate profile/state per platform. Does not
 * touch the running DSH browser or import another browser's cookies. No own CDP
 * implementation, sandbox disabling, telemetry fallback or arbitrary UI script. */
export class EgoAccountRuntime {
  constructor({ directory, runtime = discoverSocialEgoRuntime(), spawnProcess = spawn, probeBrowser = probeOwnBrowser, findBrowsers = findOwnBrowsers, stopWaitMs = 3000 } = {}) {
    this.directory = directory; this.runtime = runtime; this.spawnProcess = spawnProcess;
    this.closed = false; this.children = new Set(); this.cleanupPending = false; this.stoppers = new Map();
    this.probeBrowser = probeBrowser;
    this.findBrowsers = findBrowsers; this.stopWaitMs = stopWaitMs;
  }
  get available() { return Boolean(this.runtime && !this.closed && !this.cleanupPending); }
  #env() {
    if (!path.isAbsolute(this.directory || '')) deny('INVALID_STORAGE');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) deny('INVALID_STORAGE'); fs.chmodSync(this.directory, 0o700);
    return { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8',
      XDG_DATA_HOME: path.join(this.directory, 'browser-data'), XDG_STATE_HOME: path.join(this.directory, 'browser-state'),
      EGO_LINUX_PROFILE: path.join(this.directory, 'profile'), EGO_LINUX_CHROME: this.runtime.chrome,
      EGO_LINUX_EXTRA_ARGS: '--mute-audio', EGO_ISOLATE_SPACES: '0', EGO_LINUX_SPACE_IDLE_MIN: '0',
      EGO_BROWSER_NO_UPDATE_NOTIFIER: '1' };
  }
  async run(body, context = {}, { timeoutMs = 60000 } = {}) {
    if (!this.available) deny('DRIVER_UNAVAILABLE');
    if (!allowed(context.authorize) || context.signal?.aborted) deny('FORBIDDEN');
    const marker = '@@DFY_SOCIAL_' + randomUUID().replaceAll('-', '') + '@@';
    const script = `const result=await(async()=>{try{${body}\nreturn result;}catch(error){const code=String(error?.message||'');return{__dfy_error:['RISK_CONTROL','ACCOUNT_MISMATCH','BINDINGS_REQUIRED'].includes(code)?code:'BROWSER_UNKNOWN'};}})();` + '\nconsole.log(' + JSON.stringify(marker) + '+JSON.stringify(result));\n';
    if (script.length > 128000) deny('INVALID_REQUEST');
    const child = this.spawnProcess(process.execPath, [this.runtime.entry, 'nodejs'], { shell: false,
      env: this.#env(), cwd: this.directory, stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.add(child);
    return await new Promise((resolve, reject) => {
      let output = '', size = 0, cancelled = false, overLimit = false, settled = false, hardTimer, finalTimer;
      const abort = () => {
        cancelled = true; this.cleanupPending = true; child.kill('SIGTERM');
        hardTimer ||= setTimeout(() => child.kill('SIGKILL'), 3000);
        finalTimer ||= setTimeout(() => { if (!settled) { settled = true; reject(new SocialAccountError('CLEANUP_UNCONFIRMED')); } }, 6000);
      };
      const collect = data => { size += data.length; if (size > 2 * 1024 * 1024) { overLimit = true; abort(); } else output += data.toString(); };
      const timer = setTimeout(abort, timeoutMs);
      context.signal?.addEventListener('abort', abort, { once: true });
      if (context.signal?.aborted || !allowed(context.authorize)) abort();
      this.stoppers.set(child, abort);
      const cleanup = () => { clearTimeout(timer); clearTimeout(hardTimer); clearTimeout(finalTimer); context.signal?.removeEventListener('abort', abort);
        this.stoppers.delete(child);
        this.children.delete(child); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.stdin.on('error', () => { abort(); });
      child.on('error', abort);
      child.once('close', code => {
        cleanup(); if (settled) return; settled = true;
        if (code !== 0 || cancelled || overLimit || !allowed(context.authorize) || context.signal?.aborted) { this.cleanupPending = true; reject(new SocialAccountError('BROWSER_UNKNOWN')); return; }
        const lines = output.split(/\r?\n/).filter(line => line.startsWith(marker));
        if (lines.length !== 1) { this.cleanupPending = true; reject(new SocialAccountError('INVALID_RECEIPT')); return; }
        try { const value = JSON.parse(lines[0].slice(marker.length));
          if (value?.__dfy_error) { const code = ['RISK_CONTROL', 'ACCOUNT_MISMATCH', 'BINDINGS_REQUIRED'].includes(value.__dfy_error) ? value.__dfy_error : 'BROWSER_UNKNOWN';
            this.cleanupPending = code === 'BROWSER_UNKNOWN'; reject(new SocialAccountError(code)); return; }
          this.cleanupPending = false; resolve(value); }
        catch { this.cleanupPending = true; reject(new SocialAccountError('INVALID_RECEIPT')); }
      });
      child.stdin.end(script);
    });
  }
  async stop(context) {
    if (!this.runtime) return;
    if (!allowed(context.authorize) || context.signal?.aborted || this.children.size) deny('CLEANUP_UNCONFIRMED');
    const targetFile = path.join(this.directory, 'browser-cleanup.private.json');
    const stateFile = path.join(this.directory, 'browser-state/ego-lite-linux/browser.json');
    let target = null;
    for (const file of [targetFile, stateFile]) {
      if (!fs.existsSync(file)) continue;
      const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) deny('CLEANUP_UNCONFIRMED');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || target && target.pid !== value.pid) deny('CLEANUP_UNCONFIRMED');
      target = { pid: value.pid };
    }
    const candidates = await this.findBrowsers(this.directory, this.runtime.chrome);
    if (candidates.length > 1 || target && candidates.some(pid => pid !== target.pid)) deny('CLEANUP_UNCONFIRMED');
    if (!target && candidates.length === 1) {
      // Without the managed state, the CLI cannot safely target a residual
      // browser. Ask for manual closure rather than clearing its live locks.
      fs.writeFileSync(targetFile, JSON.stringify({ pid: candidates[0] }), { mode: 0o600 });
      this.cleanupPending = true; deny('CLEANUP_UNCONFIRMED');
    }
    // The pinned CLI can return after SIGTERM, before Chrome has exited.
    // Remember its exact process before --stop removes the browser state.
    if (target) {
      await this.probeBrowser(target.pid, this.directory, this.runtime.chrome);
      if (!allowed(context.authorize) || context.signal?.aborted) deny('FORBIDDEN');
      fs.writeFileSync(targetFile, JSON.stringify(target), { mode: 0o600 });
    }
    this.cleanupPending = true;
    await new Promise((resolve, reject) => {
      const child = this.spawnProcess(process.execPath, [this.runtime.entry, '--stop'], { shell: false, env: this.#env(), stdio: ['ignore', 'ignore', 'ignore'] });
      this.children.add(child); this.cleanupPending = true;
      let settled = false, hard, limit;
      const abort = () => {
        child.kill('SIGTERM'); hard ||= setTimeout(() => child.kill('SIGKILL'), 1500);
        limit ||= setTimeout(() => { settled = true; reject(new SocialAccountError('CLEANUP_UNCONFIRMED')); }, 3000);
      };
      const timeout = setTimeout(abort, 10000); this.stoppers.set(child, abort);
      context.signal?.addEventListener('abort', abort, { once: true });
      child.once('error', abort);
      child.once('close', code => {
        clearTimeout(timeout); clearTimeout(hard); clearTimeout(limit); this.children.delete(child); this.stoppers.delete(child);
        context.signal?.removeEventListener('abort', abort);
        if (settled) return; settled = true;
        code === 0 && allowed(context.authorize) && !context.signal?.aborted ? resolve() : reject(new SocialAccountError('CLEANUP_UNCONFIRMED'));
      });
    });
    const deadline = Date.now() + this.stopWaitMs;
    while (target && await this.probeBrowser(target.pid, this.directory, this.runtime.chrome)) {
      if (!allowed(context.authorize) || context.signal?.aborted || Date.now() >= deadline) deny('CLEANUP_UNCONFIRMED');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if ((await this.findBrowsers(this.directory, this.runtime.chrome)).length) deny('CLEANUP_UNCONFIRMED');
    if (!allowed(context.authorize) || context.signal?.aborted) deny('CLEANUP_UNCONFIRMED');
    fs.rmSync(targetFile, { force: true }); this.cleanupPending = false;
  }
  async dispose() {
    this.closed = true;
    await Promise.all([...this.children].map(child => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SocialAccountError('CLEANUP_UNCONFIRMED')), 6500);
      child.once('close', () => { clearTimeout(timer); resolve(); }); this.stoppers.get(child)?.();
    })));
    // Browsers keep their dedicated logged-in profile for subsequent sessions.
    // No cookie clearing or global browser shutdown is performed on reload.
  }
}
