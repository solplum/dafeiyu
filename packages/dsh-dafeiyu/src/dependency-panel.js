/** Fixed local dependency inventory. Reads are explicit; installers only run from owner actions. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const IMAGE = 'mlikiowa/napcat-docker';
const TAG = /^v\d+\.\d+\.\d+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^[0-9][0-9A-Za-z.+_~-]{0,95}$/;
const MAX_JSON = 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;
const clone = (value) => JSON.parse(JSON.stringify(value));
const version = (value) => typeof value === 'string' && VERSION.test(value.trim()) ? value.trim() : null;
const compare = (left, right) => {
  if (!left || !right) return null;
  const a = left.replace(/^v/, '').split(/[.+_-]/), b = right.replace(/^v/, '').split(/[.+_-]/);
  if ([...a, ...b].some((part) => !/^\d+$/.test(part))) return left === right ? 0 : null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = Number(a[i] || 0) - Number(b[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
};
const CATALOG = [
  ['orbstack', 'OrbStack 容器运行环境', 'https://orbstack.dev/download'],
  ['docker', 'Docker 引擎', 'https://orbstack.dev/download'],
  ['napcat', 'NapCat QQ 接入', 'https://github.com/NapNeko/NapCat-Docker'],
  ['linux-qq', '容器内 Linux QQ', 'https://im.qq.com/linuxqq/download.html'],
  ['ffmpeg', 'FFmpeg 音频解码与格式转换', 'https://ffmpeg.org/download.html'],
  ['ffprobe', 'ffprobe 音频时长与格式校验', 'https://ffmpeg.org/download.html'],
  ['scrcpy', 'scrcpy 手机播放声音采集', 'https://github.com/Genymobile/scrcpy/releases/latest'],
  ['adb', 'Android Platform Tools', 'https://developer.android.com/tools/releases/platform-tools'],
  ['macos-tts', 'macOS 系统语音合成', 'https://support.apple.com/guide/mac-help/get-macos-updates-mchlpx1065/mac'],
  ['voice-receive', 'QQ 语音接收与识别', ''],
  ['voice-send', 'QQ 语音合成与发送', ''],
];

export class DependencyPanelError extends Error {
  constructor(code, message) { super(message); this.name = 'DependencyPanelError'; this.code = code; }
}
const fail = (code, message) => { throw new DependencyPanelError(code, message); };

function readJson(file, maximum = MAX_JSON) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error('Invalid local dependency metadata');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local dependency metadata');
  return value;
}

/** Does not follow links or copy QQ chat/login files into a second location. */
function copyConfig(source, target) {
  let entries = 0, bytes = 0;
  const copy = (from, to, depth = 0) => {
    const stat = fs.lstatSync(from);
    if (++entries > 5000 || depth > 8 || stat.isSymbolicLink()) fail('BACKUP_FAILED', 'NapCat 配置备份遇到链接或超出大小上限');
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { mode: 0o700 });
      for (const child of fs.readdirSync(from)) copy(path.join(from, child), path.join(to, child), depth + 1);
    } else if (stat.isFile() && (bytes += stat.size) <= 32 * 1024 * 1024) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, 0o600);
    } else fail('BACKUP_FAILED', 'NapCat 配置备份包含不支持的文件或超出大小上限');
  };
  copy(source, target);
}

function atomicBytes(file, bytes) {
  const temporary = `${file}.panel-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
const atomicCompose = (file, value) => atomicBytes(file, JSON.stringify(value, null, 2) + '\n');

export class DependencyPanel {
  #runtime; #config; #voice; #busy; #maintenance; #napcat; #directory; #platform; #arch; #exec; #fetch; #home; #delay;
  #closed = false; #closing = false; #checkPending; #checkingUpdates = false; #job; #jobPromise; #candidate; #brew;
  #deploymentReady = false; #composeReady = false; #controllers = new Set();
  #state = { ok: true, checkedAt: null, updatesCheckedAt: null, busy: false, job: null,
    items: CATALOG.map(([id, name]) => ({ id, name, installed: null, currentVersion: null, latestVersion: null,
      updateState: 'not-checked', health: 'not-verified', note: '尚未检测', actions: [] })) };

  constructor({ getRuntime = () => null, getConfig = () => ({}), getVoiceStatus, getBusy = () => false, acquireMaintenance, napcatPanel,
    deploymentDir, platform = process.platform, arch = process.arch, homeDir = os.homedir(),
    execFileImpl = execute, fetchImpl = globalThis.fetch,
    delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
    this.#runtime = getRuntime; this.#config = getConfig; this.#voice = getVoiceStatus; this.#busy = getBusy;
    this.#maintenance = acquireMaintenance;
    this.#napcat = napcatPanel; this.#platform = platform; this.#arch = arch; this.#home = homeDir;
    this.#directory = deploymentDir ?? (platform === 'darwin' ? path.join(homeDir, 'Library/Application Support/lzl-dsh/napcat-docker') : '');
    if (this.#directory && (typeof this.#directory !== 'string' || !path.isAbsolute(this.#directory))) fail('INVALID_CONFIG', '部署目录必须是受信任的绝对路径');
    this.#exec = execFileImpl; this.#fetch = fetchImpl; this.#delay = delayImpl;
  }

  #item(id) { return this.#state.items.find((item) => item.id === id); }
  #set(id, patch) { Object.assign(this.#item(id), patch); }
  #assertOpen() { if (this.#closed) fail('UNAVAILABLE', '组件管理已经停止'); }
  #allow(authorize) {
    this.#assertOpen();
    if (this.#closing) fail('UNAVAILABLE', '组件管理正在停止，未开始新的变更');
    let allowed = false; try { allowed = typeof authorize === 'function' && authorize() === true; } catch {}
    if (!allowed) fail('FORBIDDEN', '主人授权已失效，未执行组件操作');
  }

  #environment() {
    const env = { ...process.env, HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1',
      HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_AUTO_UPDATE: '1' };
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION']) delete env[key];
    return env;
  }

  async #command(file, args, { timeout = 5000, env = this.#environment(), cwd } = {}) {
    this.#assertOpen();
    const controller = new AbortController(); this.#controllers.add(controller);
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new DependencyPanelError('COMMAND_TIMEOUT', '组件命令执行超时')); }, timeout);
      controller.signal.addEventListener('abort', () => reject(new DependencyPanelError('UNAVAILABLE', '组件命令已停止')), { once: true });
    });
    try {
      const result = await Promise.race([this.#exec(file, args, { timeout, signal: controller.signal,
        maxBuffer: MAX_JSON, encoding: 'utf8', env, ...(cwd ? { cwd } : {}), windowsHide: true }), timeoutPromise]);
      if (this.#closed) fail('UNAVAILABLE', '组件管理已经停止');
      return String(result.stdout || '');
    } finally { clearTimeout(timer); this.#controllers.delete(controller); }
  }

  async #public(url, text = false) {
    this.#assertOpen();
    const controller = new AbortController(); this.#controllers.add(controller);
    let timer;
    try {
      const operation = (async () => {
        const response = await this.#fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: text ? 'text/plain' : 'application/json', 'User-Agent': 'lzl-dsh-component-panel/1.0' } });
        if (!response.ok) throw new Error('Metadata unavailable');
        const chunks = []; let length = 0;
        if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') throw new Error('Invalid metadata');
        for await (const chunk of response.body) {
          length += chunk.length; if (length > MAX_JSON) throw new Error('Metadata too large'); chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString('utf8'); return text ? body : JSON.parse(body);
      })();
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Metadata timeout')); }, 7000);
        controller.signal.addEventListener('abort', () => reject(new Error('Metadata stopped')), { once: true });
      })]);
    } finally { clearTimeout(timer); this.#controllers.delete(controller); }
  }

  #executable(candidates) {
    return candidates.find((candidate) => {
      try { return typeof candidate === 'string' && path.isAbsolute(candidate) && fs.statSync(candidate).isFile()
        && (fs.accessSync(candidate, fs.constants.X_OK), true); } catch { return false; }
    }) || null;
  }

  #tool(name, runtime, config) {
    const custom = { adb: runtime?.phoneTools?.adbPath || config.adbPath || process.env.PHONE_ADB,
      scrcpy: runtime?.phoneTools?.scrcpyPath || process.env.PHONE_SCRCPY,
      ffmpeg: config.stt?.ffmpegPath || process.env.PHONE_FFMPEG,
      ffprobe: runtime?.phoneTools?.ffprobePath || process.env.PHONE_FFPROBE }[name];
    return this.#executable([custom, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`,
      ...(name === 'adb' ? [path.join(this.#home, 'Library/Android/sdk/platform-tools/adb')] : [])]);
  }

  #deployment() {
    if (!this.#directory) fail('NOT_CONFIGURED', '当前平台尚未配置 NapCat 专用部署');
    let directory, compose;
    try { directory = fs.realpathSync(this.#directory); compose = readJson(path.join(directory, 'compose.yaml')); }
    catch { fail('NOT_CONFIGURED', '尚未找到 NapCat 专用部署配置'); }
    const service = compose.services?.napcat;
    const requiredVolumes = ['./data/qq:/app/.config/QQ', './data/config:/app/napcat/config', './data/plugins:/app/napcat/plugins'];
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(compose.name || '') || !service
      || Object.keys(compose.services).length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service.container_name || '')
      || !new RegExp(`^${IMAGE.replace('.', '\\.')}:(v\\d+\\.\\d+\\.\\d+)@sha256:[a-f0-9]{64}$`).test(service.image || '')
      || !['linux/arm64', 'linux/amd64'].includes(service.platform)
      || !Array.isArray(service.volumes) || service.volumes.length !== 3 || requiredVolumes.some((volume) => !service.volumes.includes(volume))
      || !Array.isArray(service.ports) || service.ports.length !== 2
      || service.ports.some((port) => !/^127\.0\.0\.1:[1-9]\d{0,4}:(?:6099|3001)$/.test(port))
      || Object.keys(service).some((key) => !['image', 'platform', 'container_name', 'restart', 'environment', 'ports', 'volumes', 'logging', 'ulimits'].includes(key))
      || !service.environment || Object.keys(service.environment).some((key) => !['ACCOUNT', 'MODE', 'NAPCAT_UID', 'NAPCAT_GID'].includes(key))
      || !/^[1-9]\d{0,19}$/.test(service.environment.ACCOUNT || '') || service.environment.MODE !== 'ws'
      || !/^\d{1,10}$/.test(service.environment.NAPCAT_UID || '') || !/^\d{1,10}$/.test(service.environment.NAPCAT_GID || '')) {
      fail('DEPLOYMENT_UNSAFE', '部署结构与专用 NapCat 模板不符，已禁止自动安装或更新');
    }
    for (const relative of ['data/qq', 'data/config', 'data/plugins']) {
      const location = path.join(directory, relative);
      try { if (!fs.lstatSync(location).isDirectory() || fs.realpathSync(location) !== location) throw new Error(); }
      catch { fail('DEPLOYMENT_UNSAFE', 'NapCat 数据目录不存在或指向部署目录之外'); }
    }
    const docker = this.#executable([path.join(directory, 'tools/docker')]);
    const composer = this.#executable([path.join(directory, 'tools/cli-plugins/docker-compose')]);
    if (!docker) fail('DOCKER_UNAVAILABLE', '专用 Docker 工具尚未安装');
    const socket = this.#platform === 'darwin' ? path.join(this.#home, '.orbstack/run/docker.sock') : '/var/run/docker.sock';
    return { directory, compose, service, docker, composer, prefix: ['--host', `unix://${socket}`],
      env: { ...this.#environment(), DOCKER_HOST: `unix://${socket}` } };
  }

  async #docker(deployment, args, options = {}) {
    return this.#command(deployment.docker, [...deployment.prefix, ...args], { cwd: deployment.directory, ...options });
  }
  async #compose(deployment, args) {
    if (!deployment.composer) fail('COMPOSE_UNAVAILABLE', '专用 Docker Compose 工具尚未安装');
    return this.#command(deployment.composer, ['--project-directory', deployment.directory, '-f', path.join(deployment.directory, 'compose.yaml'), ...args],
      { cwd: deployment.directory, env: deployment.env, timeout: 120000 });
  }

  async #installed() {
    const runtime = this.#runtime(), config = this.#config() || {};
    for (const id of ['napcat', 'linux-qq']) this.#set(id, { containerRunning: null });
    this.#deploymentReady = false; this.#composeReady = false;
    this.#brew = this.#executable(['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew']);
    const orbctl = this.#executable(['/Applications/OrbStack.app/Contents/MacOS/bin/orbctl']);
    this.#set('orbstack', { installed: Boolean(orbctl), currentVersion: null, health: orbctl ? 'not-verified' : 'missing',
      note: this.#platform === 'darwin' ? '检测本机应用；更新由 OrbStack 自带更新器完成' : '此安装方式用于 macOS，当前平台可使用自己的 Docker 引擎' });
    if (orbctl) {
      try { this.#set('orbstack', { currentVersion: version((await this.#command(orbctl, ['version'])).match(/(?:OrbStack\s+)?([0-9][\w.+~-]*)/)?.[1]), health: 'ready' }); }
      catch { this.#set('orbstack', { health: 'blocked', note: '已安装，但版本命令未成功' }); }
    }
    await Promise.all(['ffmpeg', 'ffprobe', 'scrcpy', 'adb'].map(async (id) => {
      const file = this.#tool(id, runtime, config);
      this.#set(id, { installed: Boolean(file), currentVersion: null, health: file ? 'not-verified' : 'missing', note: file ? '已找到程序，正在检测版本' : '未找到可执行程序' });
      if (!file) return;
      try {
        const output = await this.#command(file, [['ffmpeg', 'ffprobe'].includes(id) ? '-version' : id === 'adb' ? 'version' : '--version']);
        const parsed = id === 'ffmpeg' ? output.match(/^ffmpeg version ([^\s]+)/m)?.[1]
          : id === 'ffprobe' ? output.match(/^ffprobe version ([^\s]+)/m)?.[1]
          : id === 'scrcpy' ? output.match(/^scrcpy ([^\s]+)/m)?.[1] : output.match(/^Version ([^\s]+)/m)?.[1];
        const current = version(parsed?.replace(/-(?:Homebrew|[0-9]{6,})$/, ''));
        this.#set(id, { currentVersion: current, health: current ? 'ready' : 'blocked',
          note: current ? (id === 'adb' ? '版本检测成功；未连接或探测手机' : '版本检测成功，尚未执行真实音频任务') : '程序返回的版本格式无法确认' });
      } catch { this.#set(id, { health: 'blocked', note: '已安装，但版本命令失败或超时' }); }
    }));
    const macTts = this.#platform === 'darwin' && Boolean(this.#executable(['/usr/bin/say']));
    this.#set('macos-tts', { installed: macTts, currentVersion: macTts ? `系统组件 (Darwin ${os.release()})` : null,
      health: macTts ? 'not-verified' : this.#platform === 'darwin' ? 'missing' : 'unsupported',
      note: macTts ? '已找到 /usr/bin/say；尚未合成或发送语音，版本随 macOS 更新'
        : this.#platform === 'darwin' ? '未找到 macOS 系统语音程序' : '当前平台不提供 macOS 系统语音；可配置远程 TTS' });
    let deployment, inspect, napcat;
    try {
      deployment = this.#deployment();
      this.#deploymentReady = true; this.#composeReady = Boolean(deployment.composer);
      const result = await this.#docker(deployment, ['version', '--format', '{{json .Server.Version}}']);
      const currentVersion = version(JSON.parse(result));
      this.#set('docker', { installed: true, currentVersion, health: currentVersion ? 'ready' : 'blocked', note: '固定本机 Docker socket；没有启动容器' });
      try {
        inspect = JSON.parse(await this.#docker(deployment, ['inspect', '--type', 'container', '--format',
          '{"id":{{json .Id}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}}', deployment.service.container_name]));
        if (!ID.test(inspect?.id || '') || inspect.project !== deployment.compose.name || inspect.workingDir !== deployment.directory
          || inspect.image !== deployment.service.image) throw new Error();
      } catch { inspect = null; }
      const pinnedVersion = deployment.service.image.match(/:(v[0-9.]+)@/)?.[1]?.slice(1) || null;
      let imageInstalled = Boolean(inspect);
      if (!imageInstalled) { try { await this.#docker(deployment, ['image', 'inspect', '--format', '{{.Id}}', deployment.service.image]); imageInstalled = true; } catch {} }
      this.#set('napcat', { installed: imageInstalled, currentVersion: imageInstalled ? pinnedVersion : null,
        containerRunning: inspect?.state === 'running',
        health: !imageInstalled ? 'missing' : inspect?.state === 'running' ? 'not-verified' : 'offline',
        note: !imageInstalled ? '专用部署已配置，镜像尚未下载' : '固定镜像的 NapCat 发布版本；登录状态需经 WebUI 核实' });
      this.#set('linux-qq', { installed: imageInstalled, currentVersion: null,
        containerRunning: inspect?.state === 'running',
        health: !imageInstalled ? 'missing' : inspect?.state === 'running' ? 'not-verified' : 'offline',
        note: 'Linux QQ 与 NapCat 一同由镜像管理；QQ 安装版本单独检测' });
      if (inspect?.state === 'running') {
        try {
          const qqVersion = version((await this.#docker(deployment, ['exec', inspect.id, 'dpkg-query', '-W', '-f=${Version}', 'linuxqq'])).trim());
          this.#set('linux-qq', { installed: Boolean(qqVersion), currentVersion: qqVersion,
            health: qqVersion ? 'not-verified' : 'blocked', note: qqVersion ? '已核实容器内 Linux QQ 安装包版本' : '容器存在，但 Linux QQ 安装包版本无法确认' });
        } catch { this.#set('linux-qq', { installed: null, health: 'blocked', note: '无法确认容器内 Linux QQ 安装包是否存在' }); }
      }
      if (this.#napcat && inspect?.state === 'running') {
        try { napcat = await this.#napcat.status(); } catch {}
        const ready = napcat?.container?.running === true && napcat?.webui?.authenticated === true;
        const loginRead = ready && !napcat?.error;
        const accountRecovering = loginRead && napcat.login?.phase === 'reconnecting';
        const accountInitializing = loginRead && ['qrcode_scanned', 'initializing'].includes(napcat.login?.phase);
        const accountReady = loginRead && !accountRecovering && !accountInitializing
          && napcat.login?.isLogin === true && napcat.login?.selfMatches === true;
        const accountOffline = loginRead && napcat.login?.isLogin === false
          && ['waiting_qrcode', 'generating_qrcode', 'offline'].includes(napcat.login?.phase);
        this.#set('napcat', { health: ready ? 'ready' : 'blocked', note: ready ? '容器与管理接口均可用' : '容器运行中，但管理接口尚未确认可用' });
        if (this.#item('linux-qq').installed === true) this.#set('linux-qq', {
          health: accountReady ? 'ready'
            : napcat?.login?.selfMatches === false ? 'blocked' : accountOffline ? 'offline' : 'not-verified',
          note: napcat?.login?.selfMatches === false ? '登录账号与配置小号不一致'
            : accountReady ? '已登录并核实为配置小号'
              : accountRecovering ? '已安装；QQ 正在恢复连接，在线状态尚未确认，请等待更新'
                : accountInitializing ? '已安装；QQ 正在确认或准备登录，请等待状态更新'
                  : accountOffline ? '已安装；QQ 报告当前未登录，请到 QQ 连接页查看状态'
                    : '已安装；管理状态读取未完成，QQ 登录状态尚未确认，请稍后检查' });
      }
    } catch (error) {
      const missingTool = error instanceof DependencyPanelError && error.code === 'DOCKER_UNAVAILABLE';
      this.#set('docker', { installed: missingTool ? false : deployment ? true : null, currentVersion: null,
        health: missingTool ? 'missing' : 'offline',
        note: missingTool ? '专用 Docker 工具尚未安装，无法检测引擎' : '专用 Docker 引擎不可用或部署尚未配置' });
      for (const id of ['napcat', 'linux-qq']) this.#set(id, { installed: null, currentVersion: null, health: 'not-verified', note: 'Docker 或专用部署不可用，无法确认安装与运行状态' });
    }
    let voice = {}; try { voice = this.#voice?.() || {}; } catch {}
    const stt = typeof runtime?.voiceProcessor?.sttProvider === 'function' && voice.receiveConfigured !== false;
    const ffmpeg = this.#item('ffmpeg').health === 'ready';
    const inbound = config.voiceTranscription === true;
    this.#set('voice-receive', { installed: stt, currentVersion: null, latestVersion: null, updateState: 'not-checked',
      health: !stt ? 'missing' : voice.receiveReady === false ? 'blocked' : !ffmpeg ? 'missing' : !inbound ? 'offline' : 'not-verified',
      note: !stt ? '未配置可用 STT；请配置语音识别服务'
        : voice.receiveReady === false ? '识别服务已存在，但所选模型资源尚未准备，请在语音页下载/准备'
        : !ffmpeg ? '缺少可用 FFmpeg 解码器'
          : !inbound ? '识别服务已配置，但 QQ 语音接收开关未启用'
            : '识别服务与解码器已配置；尚未通过真实 QQ 语音识别验证（SILK 需兼容解码）' });
    let output = {}; try { output = typeof runtime?.voiceOutput?.status === 'function' ? runtime.voiceOutput.status() : runtime?.voiceOutput?.status || {}; } catch {}
    const outbound = output.supported === true || voice.sendImplemented === true;
    this.#set('voice-send', { installed: outbound, currentVersion: null, latestVersion: null, updateState: 'not-checked',
      health: !outbound ? 'unsupported' : output.enabled === false ? 'offline'
        : output.readiness === 'ready' && output.lastResult?.delivered === true && !output.lastResult?.error ? 'ready'
          : output.configured === true || voice.sendReady === true ? 'not-verified' : 'blocked',
      note: !outbound ? '当前未接入 TTS 合成与 QQ 语音发送；安装播放器或 FFmpeg 不会自动补齐此功能'
        : output.enabled === false ? '语音发送已接入，但当前开关未启用'
          : output.readiness === 'ready' && output.lastResult?.delivered === true && !output.lastResult?.error ? '最近一次 QQ 语音发送已取得实际成功回执'
          : output.configured === true || voice.sendReady === true ? '已配置合成与发送能力；需要真实语音回执验证'
            : '语音发送已接入，但合成服务或编码器尚未配置完整' });
    this.#reconcileVersions(deployment);
    return deployment;
  }

  #reconcileVersions(deployment) {
    for (const id of ['ffmpeg', 'ffprobe', 'scrcpy', 'adb', 'orbstack', 'linux-qq']) {
      const item = this.#item(id), compared = compare(item.currentVersion, item.latestVersion);
      if (compared !== null) this.#set(id, { updateState: compared < 0 ? 'available' : 'up-to-date' });
    }
    if (this.#candidate) this.#set('napcat', {
      updateState: !deployment || this.#item('napcat').installed !== true ? 'unknown'
        : deployment.service.image !== this.#candidate.image ? 'available' : 'up-to-date',
    });
  }

  async #updates(deployment) {
    const attempts = await Promise.allSettled([
      ...[['ffmpeg', 'formula', 'ffmpeg'], ['scrcpy', 'formula', 'scrcpy'], ['adb', 'cask', 'android-platform-tools'], ['orbstack', 'cask', 'orbstack']].map(async ([id, type, name]) => {
        const data = await this.#public(`https://formulae.brew.sh/api/${type}/${name}.json`);
        const latest = version(type === 'formula' ? data?.versions?.stable : typeof data?.version === 'string' ? data.version.split(',')[0] : null);
        if (!latest) throw new Error();
        this.#set(id, { latestVersion: latest, updateState: 'unknown' });
      }),
      (async () => {
        const release = await this.#public('https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest');
        if (!TAG.test(release?.tag_name || '') || release.draft === true || release.prerelease === true) throw new Error();
        const tag = release.tag_name;
        const metadata = await this.#public(`https://hub.docker.com/v2/repositories/${IMAGE}/tags/${tag}`);
        const architecture = deployment?.service.platform.split('/')[1] || (this.#arch === 'arm64' ? 'arm64' : 'amd64');
        if (metadata?.name !== tag || !DIGEST.test(metadata.digest || '')
          || !metadata.images?.some((image) => image.os === 'linux' && image.architecture === architecture && DIGEST.test(image.digest || ''))) throw new Error();
        this.#candidate = { image: `${IMAGE}:${tag}@${metadata.digest}`, checkedAt: Date.now(), tag };
        this.#set('napcat', { latestVersion: tag.slice(1),
          updateState: !deployment || this.#item('napcat').installed !== true ? 'unknown'
            : deployment.service.image !== this.#candidate.image ? 'available' : 'up-to-date' });
      })(),
      (async () => {
        const recipe = await this.#public('https://raw.githubusercontent.com/NapNeko/NapCat-Docker/main/Dockerfile', true);
        const latest = version(recipe.match(/https:\/\/qqdl\.gtimg\.cn\/[^"\s]+\/linuxqq_([0-9][0-9.~-]+)_\$\{arch\}\.deb/)?.[1]);
        if (!latest) throw new Error();
        this.#set('linux-qq', { latestVersion: latest, updateState: 'unknown',
          note: this.#item('linux-qq').note + '；可用版本来自官方镜像构建配方，实际更新以镜像包含版本为准' });
      })(),
    ]);
    for (let i = 0; i < attempts.length; i++) if (attempts[i].status === 'rejected') {
      const id = ['ffmpeg', 'scrcpy', 'adb', 'orbstack', 'napcat', 'linux-qq'][i];
      this.#set(id, { latestVersion: null, updateState: 'unknown', note: this.#item(id).note + '；检查更新失败，请稍后重试' });
      if (id === 'napcat') this.#candidate = undefined;
    }
    for (const id of ['ffmpeg', 'scrcpy', 'adb', 'orbstack', 'linux-qq']) {
      const item = this.#item(id), compared = compare(item.currentVersion, item.latestVersion);
      if (compared !== null) this.#set(id, { updateState: compared < 0 ? 'available' : 'up-to-date' });
    }
    const ffmpeg = this.#item('ffmpeg'), ffprobe = this.#item('ffprobe');
    const probeComparison = compare(ffprobe.currentVersion, ffmpeg.latestVersion);
    this.#set('ffprobe', { latestVersion: ffmpeg.latestVersion,
      updateState: probeComparison === null ? ffmpeg.latestVersion ? 'unknown' : ffmpeg.updateState : probeComparison < 0 ? 'available' : 'up-to-date' });
    this.#set('docker', { updateState: 'unknown', note: this.#item('docker').note + '；随 OrbStack 更新，不单独替换引擎' });
    this.#state.updatesCheckedAt = new Date().toISOString();
  }

  snapshot() {
    const result = clone(this.#state); result.busy = Boolean(this.#jobPromise); result.job = this.#job ? clone(this.#job) : null;
    for (const item of result.items) {
      const catalog = CATALOG.find(([id]) => id === item.id);
      item.actions = [{ id: 'check', label: '检测状态与更新', enabled: !result.busy }];
      if (catalog[2]) item.actions.push({ id: 'download', label: item.id === 'napcat' ? '官方部署与下载' : item.id === 'macos-tts' ? 'macOS 系统更新说明' : '官方下载', enabled: true, url: catalog[2] });
      if (['ffmpeg', 'ffprobe', 'scrcpy', 'adb'].includes(item.id)) {
        const enabled = !result.busy && Boolean(this.#brew);
        item.actions.push({ id: item.installed === true ? 'update' : 'install', label: item.installed === true ? '更新（Homebrew）' : '安装（Homebrew）',
          enabled, ...(!enabled ? { reason: result.busy ? '有组件操作正在执行' : !this.#state.checkedAt ? '尚未检测安装器，请先检测本机' : '未找到 Homebrew，请使用官方下载' } : {}) });
      }
      if (['napcat', 'linux-qq'].includes(item.id)) {
        const managed = this.#deploymentReady && this.#composeReady;
        item.actions.push({ id: item.installed === true ? 'update' : 'install', label: item.installed === true ? '更新 QQ 与 NapCat 镜像' : '下载并安装固定镜像',
          enabled: !result.busy && managed && (item.installed !== true || Boolean(this.#candidate)),
          reason: result.busy ? '有组件操作正在执行' : !managed ? '请先检测并初始化专用部署与 Compose 工具'
            : !this.#candidate && item.installed === true ? '请先成功检查官方镜像更新' : '将保留登录和配置目录，更新时会暂时中断 QQ' });
        item.actions.push({ id: 'start', label: '启动 QQ 容器', enabled: !result.busy && managed && item.containerRunning !== true,
          ...(!managed ? { reason: '请先检测并初始化专用部署与 Compose 工具' }
            : item.containerRunning === true ? { reason: '容器已运行；未登录请到 QQ 连接页扫码' } : {}) });
        item.actions.push({ id: 'restart', label: '重启 QQ 服务',
          enabled: !result.busy && this.#deploymentReady && item.installed === true && item.containerRunning === true,
          reason: result.busy ? '有组件操作正在执行' : !this.#deploymentReady || item.installed !== true
            ? '请先检测并确认专用 QQ 容器已安装'
            : item.containerRunning !== true ? '容器未运行，请先启动'
              : '仅在登录或连接卡住时手动重启；保留当前镜像、登录数据、配置与插件，期间 QQ 会暂时断开' });
      }
      if (['orbstack', 'docker', 'macos-tts'].includes(item.id)) item.actions.push({ id: 'update', label: item.id === 'macos-tts' ? '系统组件更新' : '前往官方下载与更新', enabled: true, url: catalog[2] });
    }
    return result;
  }

  async check({ updates = false } = {}) {
    this.#assertOpen();
    if (typeof updates !== 'boolean') fail('INVALID_PATCH', '更新检测参数无效');
    if (this.#jobPromise) return this.snapshot();
    if (this.#checkPending) {
      const includesUpdates = this.#checkingUpdates;
      await this.#checkPending;
      if (updates && !includesUpdates) return this.check({ updates });
      return this.snapshot();
    }
    this.#checkingUpdates = updates;
    this.#checkPending = (async () => {
      const deployment = await this.#installed();
      if (updates) await this.#updates(deployment);
      this.#state.checkedAt = new Date().toISOString();
    })();
    try { await this.#checkPending; } finally { this.#checkPending = undefined; this.#checkingUpdates = false; }
    return this.snapshot();
  }

  #phase(phase, message) { Object.assign(this.#job, { phase, message, updatedAt: new Date().toISOString() }); }
  async #health(deployment, failureMessage = '更新后 QQ 管理接口未恢复，正在回滚') {
    for (let attempt = 0; attempt < 6; attempt++) {
      this.#assertOpen();
      if (attempt) await this.#delay(2000);
      const state = this.#napcat ? await this.#napcat.status() : null;
      if (state?.container?.running === true && state?.webui?.authenticated === true && state?.webui?.reachable === true
        && state?.login?.selfMatches !== false) return;
      // Without the owner-only WebUI adapter, container existence cannot certify a successful update.
    }
    fail('HEALTH_FAILED', failureMessage);
  }

  async #restartTarget(deployment, expectedId = '') {
    let container;
    try {
      container = JSON.parse(await this.#docker(deployment, ['inspect', '--type', 'container', '--format',
        '{"id":{{json .Id}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"mounts":{{json .Mounts}}}', deployment.service.container_name]));
    } catch { fail('CONTAINER_MISMATCH', '无法确认专用 QQ 容器，未继续重启'); }
    const mounts = [['data/qq', '/app/.config/QQ'], ['data/config', '/app/napcat/config'], ['data/plugins', '/app/napcat/plugins']];
    if (!ID.test(container?.id || '') || expectedId && container.id !== expectedId
      || container.project !== deployment.compose.name || container.service !== 'napcat'
      || container.workingDir !== deployment.directory || container.image !== deployment.service.image
      || !Array.isArray(container.mounts) || container.mounts.length !== mounts.length
      || mounts.some(([source, target]) => !container.mounts.some((mount) => mount.Type === 'bind'
        && mount.Source === path.join(deployment.directory, source) && mount.Destination === target && mount.RW === true))) {
      fail('CONTAINER_MISMATCH', 'QQ 容器身份、镜像或数据挂载与专用部署不一致，未继续重启');
    }
    if (container.state !== 'running' || container.paused !== false || container.restarting !== false) {
      fail('CONTAINER_NOT_RUNNING', '专用 QQ 容器当前未正常运行，请先检测或启动');
    }
    return container;
  }

  async #updateContainer(action, authorize) {
    const deployment = this.#deployment();
    if (action !== 'restart' && !deployment.composer) fail('COMPOSE_UNAVAILABLE', 'Docker Compose 工具不可用');
    if (this.#busy() || Number(this.#runtime()?.nativeOneBot?.status?.pending || 0) > 0) fail('BUSY', '当前正在处理 QQ 消息或应用配置，请稍后更新');
    const maintenance = () => {
      if (!this.#maintenance) return () => {};
      let release;
      try { release = this.#maintenance(); } catch {}
      if (typeof release !== 'function') fail('BUSY', 'QQ 未能进入维护状态，未重启容器');
      return () => { try { release(); } catch {} };
    };
    if (action === 'restart') {
      const release = maintenance();
      try {
        this.#allow(authorize); this.#phase('checking', '正在核实专用 QQ 容器、固定镜像与数据挂载');
        const container = await this.#restartTarget(deployment);
        this.#allow(authorize);
        if (this.#busy() || Number(this.#runtime()?.nativeOneBot?.status?.pending || 0) > 0) fail('BUSY', 'QQ 开始处理任务，未重启');
        this.#phase('restarting', '正在重启现有 QQ 服务；镜像和三个数据目录保持原地保留');
        try { await this.#docker(deployment, ['restart', '--time', '15', container.id], { timeout: 120000 }); }
        catch { fail('RESTART_FAILED', 'QQ 服务重启未确认；未更换镜像或清理数据，请重新检测状态'); }
        this.#phase('checking', '正在确认重启后的 QQ 管理接口；登录状态另行核实');
        await this.#health(deployment, '重启后 QQ 管理接口尚未恢复；未自动重复重启或更换镜像，请检测状态');
        await this.#restartTarget(deployment, container.id);
        this.#phase('complete', 'QQ 管理服务已恢复；请到 QQ 连接页核实登录，必要时重新扫码');
        return;
      } finally { release(); }
    }
    if (action === 'start') {
      const release = maintenance();
      try {
        this.#allow(authorize);
        if (this.#platform === 'darwin') {
          const orbctl = this.#executable(['/Applications/OrbStack.app/Contents/MacOS/bin/orbctl']);
          if (!orbctl) fail('DOCKER_UNAVAILABLE', '请先安装 OrbStack');
          this.#phase('starting-engine', '正在启动 OrbStack'); await this.#command(orbctl, ['start'], { timeout: 120000 });
        }
        this.#allow(authorize); this.#phase('starting', '正在启动已安装的 QQ 镜像');
        await this.#compose(deployment, ['up', '-d', '--pull', 'never', '--no-build']);
        this.#phase('checking', '正在确认 QQ 管理接口'); await this.#health(deployment); return;
      } finally { release(); }
    }
    const candidate = action === 'update' ? this.#candidate : { image: deployment.service.image };
    if (!candidate || (action === 'update' && Date.now() - candidate.checkedAt > 15 * 60 * 1000)) fail('CHECK_REQUIRED', '请先检查官方镜像更新，再执行安装或更新');
    if (action === 'update' && candidate.image === deployment.service.image) {
      this.#phase('unchanged', '当前已使用最新可核实的镜像，无需重启 QQ'); return;
    }
    this.#allow(authorize); this.#phase('downloading', '正在下载并校验固定摘要镜像，QQ 暂不停止');
    await this.#docker(deployment, ['pull', '--platform', deployment.service.platform, candidate.image], { timeout: 600000 });
    this.#allow(authorize);
    if (this.#busy() || Number(this.#runtime()?.nativeOneBot?.status?.pending || 0) > 0) fail('BUSY', 'QQ 开始处理消息或应用配置，镜像已下载，暂不重启');
    const release = maintenance();
    try {
      const original = clone(deployment.compose), originalBytes = fs.readFileSync(path.join(deployment.directory, 'compose.yaml'));
      const backupRoot = path.join(deployment.directory, 'backups');
      if (fs.existsSync(backupRoot) && (fs.lstatSync(backupRoot).isSymbolicLink() || !fs.lstatSync(backupRoot).isDirectory())) fail('BACKUP_FAILED', '备份目录无效');
      fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(backupRoot, 0o700);
      const backup = path.join(backupRoot, `panel-${randomUUID()}`); fs.mkdirSync(backup, { mode: 0o700 });
      let stopped = false, changed = false;
      try {
        this.#allow(authorize); this.#phase('stopping', '正在暂停 QQ，以备份一致的管理配置');
        stopped = true; await this.#compose(deployment, ['stop']);
        this.#allow(authorize); this.#phase('backing-up', '正在备份配置；QQ 登录数据目录原地保留');
        fs.writeFileSync(path.join(backup, 'compose.yaml'), originalBytes, { mode: 0o600, flag: 'wx' });
        copyConfig(path.join(deployment.directory, 'data/config'), path.join(backup, 'config'));
        this.#allow(authorize);
        if (!fs.readFileSync(path.join(deployment.directory, 'compose.yaml')).equals(originalBytes)) fail('CONFLICT', '部署配置被其他操作修改，已取消更新');
        const next = clone(original); next.services.napcat.image = candidate.image;
        atomicCompose(path.join(deployment.directory, 'compose.yaml'), next); changed = true;
        this.#allow(authorize); this.#phase('restarting', '正在使用新镜像启动 QQ');
        await this.#compose(deployment, ['up', '-d', '--pull', 'never', '--no-build']);
        this.#phase('checking', '正在确认更新后的 QQ 管理接口'); await this.#health(deployment);
        this.#phase('complete', '镜像更新完成；登录状态请在 QQ 连接页核实');
      } catch (error) {
        if (stopped && !this.#closed) {
          this.#phase('rolling-back', '更新未完成，正在恢复原镜像与配置');
          try {
            await this.#compose(deployment, ['stop']);
            if (changed) {
              atomicBytes(path.join(deployment.directory, 'compose.yaml'), originalBytes);
              const currentConfig = path.join(deployment.directory, 'data/config');
              fs.renameSync(currentConfig, path.join(backup, 'failed-config'));
              copyConfig(path.join(backup, 'config'), currentConfig);
            }
            await this.#compose(deployment, ['up', '-d', '--pull', 'never', '--no-build']);
          } catch { fail('ROLLBACK_FAILED', '组件操作失败，自动恢复也未完成；请使用部署目录的备份恢复'); }
        }
        if (error instanceof DependencyPanelError) throw error;
        fail('UPDATE_FAILED', '镜像操作失败，已尝试恢复原部署；详细命令输出已隐藏');
      }
    } finally { release(); }
  }

  async #installTool(id, action, authorize) {
    const brew = this.#executable(['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew']);
    if (!brew) fail('INSTALLER_UNAVAILABLE', '未找到 Homebrew，请使用官方下载');
    const packageName = id === 'adb' ? 'android-platform-tools' : id === 'ffprobe' ? 'ffmpeg' : id;
    this.#allow(authorize); this.#phase('installing', action === 'install' ? '正在下载并安装组件' : '正在下载并更新组件');
    await this.#command(brew, [action === 'install' ? 'install' : 'upgrade', id === 'adb' ? '--cask' : '--formula', packageName], { timeout: 600000 });
  }

  async action(body, { authorize = () => false } = {}) {
    this.#allow(authorize);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['id', 'action'].includes(key))
      || !CATALOG.some(([id]) => id === body.id) || !['check', 'download', 'install', 'update', 'start', 'restart'].includes(body.action)) fail('INVALID_PATCH', '组件操作参数无效');
    const { id, action } = body;
    if (action === 'check') { const value = await this.check({ updates: true }); this.#allow(authorize); return value; }
    const url = CATALOG.find(([key]) => key === id)[2];
    if (action === 'download' || (action === 'update' && ['orbstack', 'docker', 'macos-tts'].includes(id))) {
      if (!url) fail('UNSUPPORTED', '此能力由服务配置提供，没有独立安装包');
      return { ok: true, downloadUrl: url };
    }
    if (!(['ffmpeg', 'ffprobe', 'scrcpy', 'adb'].includes(id) && ['install', 'update'].includes(action))
      && !(['napcat', 'linux-qq'].includes(id) && ['install', 'update', 'start', 'restart'].includes(action))) fail('UNSUPPORTED', '此组件暂不支持该安装或更新方式');
    if (this.#jobPromise || this.#checkPending) fail('BUSY', '组件检测或操作正在执行，请稍后再试');
    this.#job = { id: randomUUID(), componentId: id, action, state: 'running', phase: 'queued', message: '已接受组件操作',
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const accepted = clone(this.#job);
    this.#jobPromise = Promise.resolve().then(async () => {
      try {
        if (['napcat', 'linux-qq'].includes(id)) await this.#updateContainer(action, authorize);
        else await this.#installTool(id, action, authorize);
        this.#phase('complete', '操作已完成，正在刷新本机状态'); await this.#installed();
        this.#state.checkedAt = new Date().toISOString(); this.#job.state = 'succeeded';
        this.#phase('complete', '操作已完成；请核实组件状态与 QQ 登录');
      } catch (error) {
        this.#job.state = 'failed'; this.#job.code = error instanceof DependencyPanelError ? error.code : 'OPERATION_FAILED';
        this.#phase('failed', error instanceof DependencyPanelError ? error.message : '组件操作失败；原始命令输出已隐藏');
      } finally { this.#jobPromise = undefined; }
    });
    return { ok: true, accepted: true, job: accepted };
  }

  async settled() { if (this.#jobPromise) await this.#jobPromise; return this.snapshot(); }
  dispose() {
    this.#closing = true;
    const close = () => { this.#closed = true; for (const controller of this.#controllers) controller.abort(); this.#controllers.clear(); };
    // A stopped QQ must be restored before cancelling the transaction's local processes.
    if (this.#jobPromise) return this.#jobPromise.finally(close);
    close(); return Promise.resolve();
  }
}
