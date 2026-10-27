/** NapCat v4.18.41 status/QR adapter. No shell, logs, logout, startup or model calls. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const execFileAsync = promisify(execFile);
const MAX_QR = 2 * 1024 * 1024;
const MAX_JSON = 64 * 1024;
const PHASES = new Set(['waiting_qrcode', 'generating_qrcode', 'qrcode_scanned', 'initializing', 'ready', 'offline', 'reconnecting']);
const INSPECT = '{"id":{{json .Id}},"state":{{json .State.Status}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"restarts":{{json .RestartCount}},"ports":{{json .NetworkSettings.Ports}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}}';
const qqId = (value) => ((typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)))
  && /^[1-9]\d{0,19}$/.test(String(value))) ? String(value) : '';
const clone = (value) => JSON.parse(JSON.stringify(value));

// The login URL is a private, short-lived credential. Encode it locally rather
// than reading NapCat's asynchronously written (and potentially stale) PNG.
function qrUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && (url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com')) ? value : '';
  } catch { return ''; }
}
const qrRevision = (value) => value ? createHash('sha256').update(value).digest('hex') : null;
function loginIssue(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.trimStart().startsWith('[SelfOffline]')) return { code: 'LOGIN_SELF_OFFLINE',
    note: 'QQ 报告账号离线，未收到被踢下线通知；具体原因尚未确认，请等待状态更新。' };
  if (value.trimStart().startsWith('[KickedOffLine]')) return { code: 'LOGIN_KICKED_OFFLINE',
    note: 'QQ 报告账号被踢下线；具体原因尚未确认，请先核对设备和登录状态。' };
  if (/过期|expired|expire/i.test(value)) return { code: 'QR_EXPIRED', note: 'QQ 登录二维码已过期，请刷新后扫描新二维码。' };
  if (/网络|连接|断开|重连|network|connect|offline|socket/i.test(value)) return {
    code: 'LOGIN_NETWORK_UNAVAILABLE', note: 'QQ 登录服务连接异常，请稍后检查登录状态。' };
  return { code: 'LOGIN_REJECTED', note: 'QQ 登录未成功，请核对手机端提示后重新获取二维码。' };
}
async function encodeQr(value) {
  let encoder;
  try { const imported = await import('qrcode'); encoder = imported.default || imported; }
  catch { fail('QR_ENCODER_UNAVAILABLE', '本机二维码组件缺失，请修复插件依赖后重试。'); }
  return encoder.toBuffer(value, { type: 'png', errorCorrectionLevel: 'M', margin: 4, width: 320 });
}

export class NapCatPanelError extends Error {
  constructor(code, message) { super(message); this.name = 'NapCatPanelError'; this.code = code; }
}
const fail = (code, message) => { throw new NapCatPanelError(code, message); };

function localJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON) fail('INVALID_CONFIG', 'NapCat 本机配置不是有效的普通文件');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CONFIG', 'NapCat 本机配置格式无效');
    return value;
  } catch (error) {
    if (error instanceof NapCatPanelError) throw error;
    fail('INVALID_CONFIG', '无法读取 NapCat 本机部署配置');
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > MAX_QR
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8, width, height, channels, depth, ended = false;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) return false;
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (offset === 8) {
      if (type !== 'IHDR' || size !== 13) return false;
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8];
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[data[9]];
      const depths = ({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] })[data[9]];
      if (!width || !height || width > 4096 || height > 4096 || !depths?.includes(depth)
        || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return false;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') compressed.push(data);
    if (type === 'IEND') { if (size !== 0 || end !== bytes.length) return false; ended = true; break; }
    offset = end;
  }
  if (!ended || !compressed.length) return false;
  try {
    const rowSize = Math.ceil(width * channels * depth / 8) + 1;
    const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: 16 * 1024 * 1024 });
    if (decoded.length !== rowSize * height) return false;
    for (let row = 0; row < height; row++) if (decoded[row * rowSize] > 4) return false;
    return true;
  } catch { return false; }
}

export class NapCatPanel {
  #directory;
  #platform;
  #expected;
  #getExpected;
  #fetch;
  #exec;
  #timeout;
  #refreshTimeout;
  #encodeQr;
  #credential;
  #authPending;
  #closed = false;
  #controllers = new Set();

  constructor({ deploymentDir, expectedSelfId = '', getExpectedSelfId, fetchImpl = globalThis.fetch,
    execFileImpl = execFileAsync, qrEncoder = encodeQr, platform = process.platform, timeoutMs = 5000, refreshTimeoutMs = 12000 } = {}) {
    this.#platform = platform;
    this.#directory = deploymentDir ?? (platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/lzl-dsh/napcat-docker') : '');
    if (this.#directory && (typeof this.#directory !== 'string' || !path.isAbsolute(this.#directory))) fail('INVALID_CONFIG', 'NapCat 部署目录必须是明确的绝对路径');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000
      || !Number.isInteger(refreshTimeoutMs) || refreshTimeoutMs < 10 || refreshTimeoutMs > 30000) fail('INVALID_CONFIG', 'NapCat 探测超时配置无效');
    this.#expected = qqId(expectedSelfId); this.#getExpected = getExpectedSelfId;
    this.#fetch = fetchImpl; this.#exec = execFileImpl;
    this.#timeout = timeoutMs; this.#refreshTimeout = refreshTimeoutMs;
    if (typeof qrEncoder !== 'function') fail('INVALID_CONFIG', '二维码组件配置无效');
    this.#encodeQr = qrEncoder;
  }

  async #bounded(task, timeout = this.#timeout) {
    if (this.#closed) fail('UNAVAILABLE', 'NapCat 面板适配已停止');
    const controller = new AbortController();
    this.#controllers.add(controller);
    let timer;
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new NapCatPanelError('PROBE_TIMEOUT', 'NapCat 探测已停止或超时')), { once: true });
      timer = setTimeout(() => controller.abort(), timeout);
    });
    try { return await Promise.race([Promise.resolve().then(() => task(controller.signal)), aborted]); }
    finally { clearTimeout(timer); this.#controllers.delete(controller); }
  }

  #deployment() {
    if (!this.#directory) fail('NOT_CONFIGURED', '当前平台尚未指定 NapCat 部署目录');
    let directory;
    try { directory = fs.realpathSync(this.#directory); } catch { fail('NOT_CONFIGURED', '尚未找到本机 NapCat 部署目录'); }
    const compose = localJson(path.join(directory, 'compose.yaml'));
    const service = compose.services?.napcat;
    if (!service || typeof compose.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(compose.name)
      || typeof service.container_name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service.container_name)) fail('INVALID_CONFIG', 'NapCat 专用容器配置不完整');
    const docker = path.join(directory, 'tools/docker');
    try { if (!fs.statSync(docker).isFile()) throw new Error(); fs.accessSync(docker, fs.constants.X_OK); }
    catch { fail('DOCKER_UNAVAILABLE', 'NapCat 专用 Docker 工具不可用'); }
    const socket = this.#platform === 'darwin' ? path.join(os.homedir(), '.orbstack/run/docker.sock') : '/var/run/docker.sock';
    const env = { ...process.env };
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION']) delete env[key];
    return { directory, docker, prefix: ['--host', `unix://${socket}`], env, project: compose.name, name: service.container_name };
  }

  async #docker(deployment, args, binary = false) {
    return this.#bounded(async (signal) => {
      const result = await this.#exec(deployment.docker, [...deployment.prefix, ...args], { signal,
        cwd: deployment.directory, env: deployment.env, timeout: this.#timeout, maxBuffer: binary ? MAX_QR : MAX_JSON,
        encoding: binary ? null : 'utf8', windowsHide: true });
      return result.stdout;
    });
  }

  async #request(session, endpoint, body = {}, credential, timeout = this.#timeout) {
    return this.#bounded(async (signal) => {
      const response = await this.#fetch(`${session.origin}/api/${endpoint}`, { method: 'POST',
        redirect: 'error', signal, headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential.value}` } : {}) },
        body: JSON.stringify(body) });
      session.reachable = true;
      const rejectAuth = () => {
        // Compare the exact cache generation, not its text: two credentials
        // issued in the same server second may contain identical signed data.
        if (credential && this.#credential === credential) this.#credential = undefined;
        fail('WEBUI_AUTH_REJECTED', 'NapCat 管理认证未通过，QQ 登录状态尚未确认；请稍后检查管理连接。');
      };
      if ([401, 403].includes(response.status)) rejectAuth();
      if (!response.ok) fail('WEBUI_REQUEST_FAILED', 'NapCat WebUI 请求未成功');
      const chunks = []; let size = 0;
      if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') fail('WEBUI_RESPONSE_INVALID', 'NapCat WebUI 响应格式无效');
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_JSON) fail('WEBUI_RESPONSE_INVALID', 'NapCat WebUI 响应超过大小上限');
        chunks.push(Buffer.from(chunk));
      }
      let json;
      try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail('WEBUI_RESPONSE_INVALID', 'NapCat WebUI 未返回有效 JSON'); }
      if (!json || json.code !== 0) {
        // Only exact upstream auth errors invalidate the credential used by
        // this request. Arbitrary remote text is never copied to the snapshot.
        if (credential && ['Unauthorized', 'Authorization Failed'].includes(json?.message)) rejectAuth();
        if (endpoint === 'auth/login') {
          if (['token is empty', 'token is invalid'].includes(json?.message)) rejectAuth();
          if (json?.message === 'login rate limit') fail('WEBUI_AUTH_RATE_LIMITED', 'NapCat 管理认证暂时受限，QQ 登录状态尚未确认；请稍后再检查。');
        }
        fail('WEBUI_REJECTED', 'NapCat WebUI 未接受请求，请核对本机管理配置');
      }
      return json.data;
    }, timeout);
  }

  async #authenticate(session, token) {
    const key = createHash('sha256').update(`${session.id}\0${session.origin}\0${token}`).digest('hex');
    if (this.#credential?.key === key && this.#credential.expires > Date.now()) return this.#credential;
    if (this.#authPending?.key === key) return this.#authPending.promise;
    const pending = { key, promise: null };
    this.#authPending = pending;
    pending.promise = (async () => {
      const hash = createHash('sha256').update(token + '.napcat').digest('hex');
      const data = await this.#request(session, 'auth/login', { hash });
      if (data?.require2FA === true) fail('WEBUI_2FA_REQUIRED', 'NapCat WebUI 已启用双因素认证，请先在原管理页完成验证');
      if (typeof data?.Credential !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.Credential) || data.Credential.length > 16384) fail('WEBUI_AUTH_FAILED', 'NapCat WebUI 管理凭据未确认');
      if (this.#closed) fail('UNAVAILABLE', 'NapCat 面板适配已停止');
      this.#credential = Object.freeze({ key, value: data.Credential, expires: Date.now() + 55 * 60 * 1000 });
      return this.#credential;
    })().finally(() => { if (this.#authPending === pending) this.#authPending = undefined; });
    return pending.promise;
  }

  #login(data) {
    if (!data || ['isLogin', 'isOffline', 'coreReady', 'qrLoginAccepted'].some((key) => typeof data[key] !== 'boolean')
      || !PHASES.has(data.loginPhase) || (data.isLogin && (!data.coreReady || data.isOffline))) fail('LOGIN_STATE_INVALID', 'NapCat 登录状态尚未得到一致确认');
    const issue = data.isLogin ? null : loginIssue(data.loginError);
    const currentUrl = data.loginPhase === 'waiting_qrcode' && !issue ? qrUrl(data.qrcodeurl) : '';
    return { isLogin: data.isLogin, isOffline: data.isOffline, phase: data.loginPhase,
      coreReady: data.coreReady, qrLoginAccepted: data.qrLoginAccepted, selfMatches: null, accountId: null,
      qrcodeRevision: qrRevision(currentUrl), issue };
  }

  async #collect() {
    const snapshot = { configured: false, container: { available: false, running: false },
      webui: { reachable: false, authenticated: false },
      login: { isLogin: null, isOffline: null, phase: 'unknown', coreReady: false, qrLoginAccepted: false,
        selfMatches: null, accountId: null, qrcodeRevision: null, issue: null }, checkedAt: new Date().toISOString() };
    let session, stage = 'deployment';
    try {
      if (this.#closed) fail('UNAVAILABLE', 'NapCat 面板适配已停止');
      const deployment = this.#deployment();
      snapshot.configured = true;
      let inspect;
      try { inspect = JSON.parse(String(await this.#docker(deployment, ['inspect', '--type', 'container', '--format', INSPECT, deployment.name]))); }
      catch (error) { if (error instanceof NapCatPanelError) throw error; fail('DOCKER_UNAVAILABLE', '无法读取 NapCat 专用容器状态'); }
      if (!inspect || !/^[a-f0-9]{64}$/.test(inspect.id || '') || inspect.project !== deployment.project
        || inspect.service !== 'napcat' || inspect.workingDir !== deployment.directory) fail('CONTAINER_MISMATCH', '容器与本机 NapCat 专用部署不匹配');
      snapshot.container = { available: true, running: inspect.running === true && inspect.paused === false && inspect.restarting === false,
        state: ['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead'].includes(inspect.state) ? inspect.state : 'unknown',
        restarts: Number.isSafeInteger(inspect.restarts) && inspect.restarts >= 0 ? inspect.restarts : null };
      if (!snapshot.container.running) return { snapshot };
      const config = localJson(path.join(deployment.directory, 'data/config/webui.json'));
      if (config.disableWebUI === true) fail('WEBUI_DISABLED', 'NapCat WebUI 当前已禁用');
      if (typeof config.token !== 'string' || !config.token || config.token.length > 8192) fail('WEBUI_AUTH_FAILED', 'NapCat WebUI 本机管理凭据未配置');
      const port = config.port ?? 6099;
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail('INVALID_CONFIG', 'NapCat WebUI 端口配置无效');
      const bindings = inspect.ports?.[`${port}/tcp`];
      if (!Array.isArray(bindings) || !bindings.length || bindings.some((entry) => !['127.0.0.1', '::1'].includes(entry.HostIp)
        || !/^[1-9]\d{0,4}$/.test(entry.HostPort) || Number(entry.HostPort) > 65535)) fail('WEBUI_BINDING_UNSAFE', 'NapCat WebUI 尚未确认仅发布到本机回环地址');
      const binding = bindings.find((entry) => entry.HostIp === '127.0.0.1') || bindings[0];
      session = { deployment, id: inspect.id, origin: `http://${binding.HostIp === '::1' ? '[::1]' : '127.0.0.1'}:${binding.HostPort}`, reachable: false };
      const expected = qqId(this.#getExpected ? await this.#bounded(() => this.#getExpected()) : this.#expected);
      session.expected = expected;
      stage = 'management-auth';
      session.credential = await this.#authenticate(session, config.token);
      snapshot.webui.authenticated = true;
      stage = 'login-status';
      const loginData = await this.#request(session, 'QQLogin/CheckLoginStatus', {}, session.credential);
      snapshot.login = this.#login(loginData);
      session.qrcodeUrl = qrUrl(loginData.qrcodeurl);
      stage = 'account-info';
      const info = await this.#request(session, 'QQLogin/GetQQLoginInfo', {}, session.credential);
      const accountId = qqId(info?.uin);
      snapshot.login.accountId = accountId || null;
      if (snapshot.login.isLogin || snapshot.login.isOffline || snapshot.login.coreReady) {
        if (!accountId || typeof info?.online !== 'boolean' || (snapshot.login.isLogin && info.online !== true)
          || (snapshot.login.isOffline && info.online !== false)) fail('LOGIN_IDENTITY_UNVERIFIED', 'QQ 登录标记存在，但账号身份或在线状态尚未核实');
        snapshot.login.selfMatches = expected ? accountId === expected : null;
        if (expected && accountId !== expected) { snapshot.code = 'ACCOUNT_MISMATCH'; snapshot.error = '当前 Linux QQ 登录账号与配置小号不一致'; }
      } else if (info?.online === true) fail('LOGIN_STATE_INVALID', 'NapCat 登录状态发生变化，请刷新后再查看');
      snapshot.webui.reachable = session.reachable;
      return { snapshot, session };
    } catch (error) {
      snapshot.webui.reachable = session?.reachable === true;
      snapshot.code = error instanceof NapCatPanelError ? error.code : 'PROBE_FAILED';
      snapshot.error = error instanceof NapCatPanelError ? error.message : 'NapCat 本机状态探测失败，请稍后再试';
      const authRejected = ['WEBUI_AUTH_REJECTED', 'WEBUI_AUTH_RATE_LIMITED', 'WEBUI_2FA_REQUIRED', 'WEBUI_AUTH_FAILED'].includes(snapshot.code);
      snapshot.errorStage = authRejected ? 'management-auth' : stage;
      if (authRejected) {
        snapshot.webui.authenticated = false;
        snapshot.login = { isLogin: null, isOffline: null, phase: 'unknown', coreReady: false, qrLoginAccepted: false,
          selfMatches: null, accountId: null, qrcodeRevision: null, issue: null };
      }
      return { snapshot };
    }
  }

  async status() { return clone((await this.#collect()).snapshot); }

  #canShowQr(login) {
    return login.isLogin === false && login.isOffline === false && login.coreReady === false
      && login.qrLoginAccepted === false && login.phase === 'waiting_qrcode' && !login.issue && Boolean(login.qrcodeRevision);
  }

  #canRequestQr(login) {
    return login.isLogin === false && login.isOffline === false && login.coreReady === false
      && login.qrLoginAccepted === false && ['waiting_qrcode', 'generating_qrcode'].includes(login.phase);
  }

  async qrcode({ refresh = false } = {}, { authorize = () => true } = {}) {
    if (typeof refresh !== 'boolean') fail('INVALID_PATCH', '刷新二维码必须使用明确的布尔值');
    const unavailable = (code, note) => ({ available: false, code, note });
    const allowed = () => { try { return !this.#closed && typeof authorize === 'function' && authorize() === true; } catch { return false; } };
    if (!allowed()) return unavailable('FORBIDDEN', '当前主人授权已失效，未获取或刷新二维码');
    const { snapshot, session } = await this.#collect();
    if (!session || snapshot.error) return unavailable(snapshot.code || 'UNAVAILABLE', snapshot.error || 'NapCat 二维码暂不可用');
    if (!session.expected) return unavailable('EXPECTED_ACCOUNT_REQUIRED', '请先明确绑定接收小号，再扫码登录');
    if (!this.#canRequestQr(snapshot.login)) return unavailable('LOGIN_NOT_WAITING', 'QQ 已登录或正在恢复登录；未读取或刷新二维码');
    try {
      if (!allowed()) return unavailable('FORBIDDEN', '当前主人授权已失效，未获取或刷新二维码');
      if (refresh) {
        const refreshed = await this.#request(session, 'QQLogin/RefreshQRcode', {}, session.credential, this.#refreshTimeout);
        if (refreshed?.restarting === true) return unavailable('LOGIN_RECOVERING', 'QQ 正在恢复连接，请稍后重新查看');
        const refreshedUrl = qrUrl(refreshed?.qrcodeurl);
        if (!refreshedUrl || refreshedUrl === session.qrcodeUrl) return unavailable('QR_REFRESH_UNCONFIRMED', 'QQ 尚未返回新的二维码，请稍后重新查看；未复用旧二维码');
      }
      // NapCat updates the URL before its PNG write completes. Always encode the
      // current API URL, then confirm the same generation is still current.
      const before = await this.#request(session, 'QQLogin/CheckLoginStatus', {}, session.credential);
      const beforeLogin = this.#login(before);
      if (beforeLogin.issue) return unavailable(beforeLogin.issue.code, beforeLogin.issue.note);
      if (!this.#canShowQr(beforeLogin)) return unavailable('LOGIN_NOT_WAITING', 'QQ 正在生成二维码或登录状态已变化，请稍后重新获取');
      if (!allowed()) return unavailable('FORBIDDEN', '当前主人授权已失效，未获取或刷新二维码');
      const bytes = await this.#bounded(() => this.#encodeQr(qrUrl(before.qrcodeurl)));
      if (!validPng(bytes)) return unavailable('QR_IMAGE_INVALID', '二维码图片不存在、损坏或超过大小上限');
      const afterLogin = this.#login(await this.#request(session, 'QQLogin/CheckLoginStatus', {}, session.credential));
      if (afterLogin.issue) return unavailable(afterLogin.issue.code, afterLogin.issue.note);
      if (!this.#canShowQr(afterLogin)) return unavailable('LOGIN_NOT_WAITING', '登录状态已变化，未返回二维码');
      if (afterLogin.qrcodeRevision !== beforeLogin.qrcodeRevision) return unavailable('QR_CHANGED', 'QQ 已更新二维码，请重新获取当前二维码；未返回旧二维码');
      const expectedNow = qqId(this.#getExpected ? await this.#bounded(() => this.#getExpected()) : this.#expected);
      if (expectedNow !== session.expected || this.#closed) return unavailable('EXPECTED_ACCOUNT_CHANGED', '绑定小号已变化，请重新查看二维码');
      if (!allowed()) return unavailable('FORBIDDEN', '当前主人授权已失效，未返回二维码');
      return { available: true, image: { mime: 'image/png', base64: bytes.toString('base64') },
        revision: afterLogin.qrcodeRevision, checkedAt: new Date().toISOString(),
        note: '二维码来自当前 Linux QQ 登录会话；请使用配置的小号扫码，二维码失效后重新获取或刷新' };
    } catch (error) {
      return unavailable(error instanceof NapCatPanelError ? error.code : 'QR_READ_FAILED',
        error instanceof NapCatPanelError ? error.message : '二维码读取未完成，请稍后重试');
    }
  }

  dispose() { this.#closed = true; this.#credential = undefined; for (const controller of this.#controllers) controller.abort(); }
}
