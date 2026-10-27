import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFINITIONS = [
  ['computer', '电脑终端与文件', '通过已授权的终端工具读取或修改电脑文件。', ['查看系统版本', '整理指定项目文件'], 'dependencies'],
  ['desktop', '电脑界面操作', '通过鼠标和键盘操作电脑界面；安全验证只覆盖独立本机临时窗口，不表示所有应用或 DSH 自身兼容已通过。', ['点击应用按钮', '读取当前窗口'], 'dependencies'],
  ['browser', '浏览器交互', '在浏览器中读取页面、点击和输入。', ['打开指定网页', '填写已授权的表单'], 'dependencies'],
  ['web', '网络搜索与读取', '通过宿主搜索及网页读取工具获取信息。', ['搜索官方文档', '读取指定网页'], 'dependencies'],
  ['qq', 'QQ 私聊', '通过已核验的小号接收并回复已授权的私聊。', ['接收主人指令', '回复任务结果'], 'qq'],
  ['phone', '安卓手机', '在手机授权范围内读取界面并操作设备。', ['截图', '读取当前界面'], 'phone'],
  ['voice-input', '语音接收', '把收到的语音转成当前对话文字。', ['识别 QQ 语音'], 'voice'],
  ['voice-output', '语音发送', '合成语音并通过已授权的通道发送。', ['用语音回复'], 'voice'],
  ['memory', '长期记忆', '在可信身份范围内读取和管理伴侣记忆。', ['查询已确认的偏好'], 'memory'],
  ['memes', '表情包', '按图库中已有的含义选择表情包。', ['选择合适的表情'], 'memes'],
  ['background', '后台任务', '把耗时工作交给后台执行器并单独回传结果。', ['后台分析项目', '查询任务状态'], 'background'],
];
export const CAPABILITY_IDS = Object.freeze(DEFINITIONS.map(([id]) => id));
const IDS = new Set(CAPABILITY_IDS), HOST_IDS = CAPABILITY_IDS.slice(0, 4);
const TEXT = { unknown: '尚未检测', disabled: '未启用', unavailable: '当前不可用', ready: '已就绪，未实测',
  verified: '已实测', failed: '验证失败', stale: '验证已过期' };
const MESSAGES = { FORBIDDEN: '需要当前已验证的主人权限。', INVALID_REQUEST: '能力或验证请求编号无效。',
  BUSY: '已有能力检测或验证正在进行，请稍后再试。', UNAVAILABLE: '当前能力没有可用的验证入口。',
  DISABLED: '请先启用并应用相关配置。', FAILED: '验证未通过；请检查配置后重新明确发起验证。',
  CANCELLED: '验证已取消；尚未据此确认能力可用。', TIMEOUT: '验证超时，已请求停止；结果尚未确认。',
  ACCESSIBILITY_REQUIRED: '执行应用尚未获得辅助功能授权；请在系统设置的隐私与安全性中核对 DeepSeek Harness 的辅助功能，再明确发起验证。未自动改变系统授权。',
  DESKTOP_INIT_UNCONFIRMED: '本应用辅助树初始化尚未确认，尚未输入或点击；请核对执行应用状态后明确发起新验证，不会自动重试。',
  DESKTOP_TARGET_UNCONFIRMED: '绑定窗口内尚未找到唯一的本机测试框，尚未输入或点击；请保持能力页和测试区可见后明确发起新验证，不会自动重试。',
  UNCONFIRMED: '此前验证结果未确认，不会自动重复执行。', CONFLICT: '运行实例已变化，请刷新后重新验证。',
  STORAGE_UNAVAILABLE: '验证记录不可用，请检查本地存储后再试。', LIMIT: '近期验证记录已满，请稍后再试。' };
const PROOF = { nonce: '固定验证标记已匹配。', 'read-only': '限定的只读操作已通过验证。', readback: '限定操作的读取结果已核对。', status: '当前通道状态已核对。' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const boolean = (value) => typeof value === 'boolean' ? value : null;
const authorized = (fn) => { try { return fn() === true; } catch { return false; } };
const error = (code) => Object.assign(new Error(MESSAGES[code]), { code });
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const componentsOf = (host, id) => {
  const row = HOST_IDS.includes(id) ? host[id] || {} : {}, metadata = row.metadata || {}, explicit = row.components || {};
  const observed = Number.isFinite(host.checkedAt) || validDate(host.checkedAt);
  const validNames = (names) => Array.isArray(names) && names.every((name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/.test(name));
  const tools = validNames(host.tools) ? host.tools : null, skills = validNames(host.skills) ? host.skills : null;
  const skill = id === 'desktop' ? 'computer-use' : id === 'browser' ? 'ego-browser' : null;
  const version = explicit.version ?? row.version ?? metadata.version;
  return { ...(['@anionex/dsh-computer-use','dsh-ego-browser'].includes(explicit.backend) ? { backend: explicit.backend } : {}),
    cliPresent: boolean(explicit.cliPresent) ?? boolean(row.cliPresent) ?? boolean(metadata.cliPresent),
    ...(typeof version === 'string' && version.length <= 80
      && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,7})(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version) ? { version } : {}),
    skillVisible: boolean(explicit.skillVisible) ?? (skill && skills ? skills.includes(skill) ? true : host.skillsComplete === true ? false : null : null),
    terminalVisible: HOST_IDS.includes(id) ? boolean(explicit.terminalVisible) ?? (tools?.includes('bash') ? true : tools && observed ? false : null) : null,
    accessibilityGranted: id === 'desktop' ? boolean(explicit.accessibilityGranted) ?? boolean(metadata.accessibilityGranted) : null,
    screenshotsGranted: id === 'desktop' ? boolean(explicit.screenshotsGranted) ?? boolean(metadata.screenshotsGranted) : null };
};
const hostGuidance = (id, components) => {
  if (id !== 'desktop' && id !== 'browser') return {};
  if (components.backend) {
    const blocked = components.cliPresent === false || components.skillVisible === false
      || id === 'desktop' && components.accessibilityGranted === false;
    return { blocked, reason: blocked ? 'DSH 控制插件或所需权限尚未就绪。' : 'DSH 原生插件已检测，实际输入、点击和回读需单独验证。',
      nextStep: blocked ? id === 'desktop' && components.accessibilityGranted === false
        ? '在系统设置中核对 DeepSeek Harness 的辅助功能授权，再发起验证。' : '在 DSH 插件管理中核对相应插件是否已启用。' : null };
  }
  const steps = [];
  if (id === 'desktop' && (components.accessibilityGranted === false || components.screenshotsGranted === false))
    steps.push('在系统设置的隐私与安全性中授权 Orca Computer Use 的辅助功能/屏幕录制，再检测');
  if (components.terminalVisible === false) steps.push('在当前 Agent 的预设中启用终端（bash）工具，再检测');
  if (components.skillVisible === false) steps.push(id === 'desktop' ? '在宿主中启用 computer-use 技能，再检测' : '在宿主中启用 ego-browser 技能，再检测');
  if (components.cliPresent === false) steps.push(id === 'desktop' ? '安装或修复 Orca Computer Use 命令入口，再检测' : '安装或修复 ego-browser 命令入口，再检测');
  const complete = components.cliPresent === true && components.terminalVisible === true && components.skillVisible === true
    && (id !== 'desktop' || components.accessibilityGranted === true && components.screenshotsGranted === true);
  return { blocked: steps.length > 0, nextStep: steps.length ? steps.join('；') + '。' : null,
    reason: steps.length ? '已检测到缺少必要入口或系统权限，尚不能执行界面操作。'
      : complete ? '入口/权限已检测，实际输入点击尚未确认。' : null };
};

/** Shared observations, not a permission grant. Getters must only return metadata. */
export class CapabilityRegistry {
  constructor({ getRuntime = () => null, getHost = () => ({}), probes = {}, storeFile,
    now = () => Date.now(), ttlMs = 10 * 60 * 1000, timeoutMs = 15000, controlBackend = 'legacy-cli' } = {}) {
    Object.assign(this, { getRuntime, getHost, probes, storeFile, now });
    if (!['legacy-cli','dsh-plugins'].includes(controlBackend)) throw error('INVALID_REQUEST');
    this.controlBackend = controlBackend;
    this.ttlMs = Math.max(1000, Math.min(86400000, Number(ttlMs) || 600000));
    this.timeoutMs = Math.max(5, Math.min(60000, Number(timeoutMs) || 15000));
    this.host = {}; this.proofs = new Map(); this.requests = new Map(); this.current = null;
    this.checkedAt = null; this.closed = false; this.storageFault = false; this.runtimeIds = new WeakMap(); this.nextRuntimeId = 0;
    if (storeFile !== undefined && (!path.isAbsolute(storeFile) || storeFile.includes('\0'))) throw error('INVALID_REQUEST');
    this.load();
  }
  iso() { return new Date(this.now()).toISOString(); }
  readCurrent() {
    let runtime = null;
    try { runtime = this.getRuntime() || null; } catch {}
    try {
      const host = this.getHost();
      if (host && typeof host.then === 'function') void Promise.resolve(host).catch(() => {});
      else if (host && typeof host === 'object') this.host = host;
    } catch {}
    let runtimeId = runtime?.instanceId;
    if (typeof runtimeId !== 'string') {
      if (runtime && typeof runtime === 'object') {
        if (!this.runtimeIds.has(runtime)) this.runtimeIds.set(runtime, ++this.nextRuntimeId);
        runtimeId = this.runtimeIds.get(runtime);
      } else runtimeId = null;
    }
    const key = JSON.stringify([runtimeId, this.host.instanceId ?? this.host.generation ?? null,
      ...HOST_IDS.map((id) => [boolean(this.host[id]?.present), boolean(this.host[id]?.available), componentsOf(this.host, id)])]);
    for (const proof of this.proofs.values()) if (proof.key && proof.key !== key) proof.invalidated = true;
    return { runtime, host: this.host, key, runtimeKey: runtimeId };
  }
  facts(id, { runtime: runtime, host }) {
    if (HOST_IDS.includes(id)) return { present: boolean(host[id]?.present), available: hostGuidance(id, componentsOf(host, id)).blocked ? false : boolean(host[id]?.available) };
    if (!runtime) return { present: null, available: null };
    let value;
    if (id === 'qq') {
      value = runtime.personalQQ || {};
      return { present: boolean(value.configured), disabled: value.enabled === false,
        available: value.identityConflict === true ? false : value.enabled === true && value.connected === true
          && value.loginVerified === true && value.online === true ? true : value.enabled === true ? false : null };
    }
    if (id === 'phone') {
      value = runtime.phone || {};
      return { present: boolean(value.present) ?? (value.state === 'online' ? true : null), disabled: value.enabled === false,
        available: value.state === 'online' ? true : ['offline', 'unauthorized', 'disabled'].includes(value.state) ? false : null };
    }
    if (id === 'voice-input' || id === 'voice-output') {
      value = runtime[id === 'voice-input' ? 'voiceInput' : 'voiceOutput'] || {};
      return { present: boolean(value.configured), disabled: (id === 'voice-input' ? value.receiveEnabled : value.enabled) === false,
        available: ['ready', 'verified', 'synthesis-verified'].includes(value.readiness) ? true : value.configured === false ? false : null };
    }
    if (id === 'background') {
      value = runtime.backgroundTasks || {};
      return { present: boolean(value.ready), available: boolean(value.ready), disabled: value.enabled === false };
    }
    value = runtime[id] || {};
    return { present: boolean(value.present) ?? boolean(value.available), available: boolean(value.available), disabled: value.enabled === false };
  }
  snapshot({ agent } = {}) {
    void agent;
    const current = this.readCurrent(), now = this.now(), cleanupPending = current.host.cleanupPending === true;
    return { busy: Boolean(this.current) || current.host.busy === true, checkedAt: this.checkedAt, controlBackend: this.controlBackend,
      items: DEFINITIONS.map(([id, title, description, examples, section]) => {
        const facts = this.facts(id, current), proof = this.proofs.get(id), components = componentsOf(current.host, id), guidance = hostGuidance(id, components);
        const stale = proof && (proof.loaded || proof.invalidated || proof.key !== current.key || now >= Date.parse(proof.expiresAt));
        let state = facts.disabled ? 'disabled' : facts.present === false || facts.available === false ? 'unavailable'
          : facts.available === true ? 'ready' : 'unknown';
        if (!facts.disabled && facts.present !== false && facts.available !== false && proof) state = stale ? 'stale' : proof.status === 'verified' ? 'verified' : 'failed';
        if (state === 'verified') { facts.present ??= true; facts.available ??= true; }
        const running = this.current?.id === id;
        const status = running ? 'running' : proof ? stale ? 'stale' : proof.status : 'none';
        const code = proof?.code;
        const nativeDesktop = id === 'desktop' && components.backend === '@anionex/dsh-computer-use';
        const nativeDesktopProof = nativeDesktop && proof?.backend === '@anionex/dsh-computer-use' && proof?.scope === 'dsh-window';
        return { id, title, description: nativeDesktop ? '通过 Anionex DSH 专用插件读取和操作电脑界面；安全验证在 DSH 本身的临时测试框中完成。' : description,
          examples: [...examples], components, present: facts.present, available: facts.available, state, stateText: TEXT[state],
          reason: cleanupPending && HOST_IDS.includes(id) ? '此前检测进程尚未确认停止，已暂停后续检测；可刷新等待停止确认。' : running ? '正在执行主人明确发起的固定验证。' : state === 'stale' ? '历史证据已过期或运行实例已变化，需要重新验证。'
            : state === 'failed' ? MESSAGES[code] || MESSAGES.FAILED : state === 'verified'
              ? id === 'desktop' ? nativeDesktopProof ? 'DSH 自身窗口的输入、点击和结果回读已实测；其他应用需按任务核验。' : '独立本机临时窗口的输入、点击和回读已实测；不代表所有应用或 DSH 自身兼容已通过。' : PROOF[proof.kind]
              : state === 'disabled' ? MESSAGES.DISABLED : guidance.reason || (state === 'unavailable' ? '当前配置或通道状态尚不满足使用条件。'
                : state === 'ready' ? '已检测到可用条件；安装或配置存在不等于实际操作已通过。' : '尚无当前可用性证据。'),
          nextStep: state === 'verified' ? '使用时仍须遵守当前账号和工具授权。'
            + (id === 'desktop' ? nativeDesktop ? '使用新鲜界面观测，只操作已确认的目标。' : 'DSH 自身窗口可能被共享浮层遮蔽，读取不到目标时停止操作。' : '') : state === 'disabled' ? '在相关设置中启用并应用配置。'
            : state === 'failed' && !running && !cleanupPending && code === 'ACCESSIBILITY_REQUIRED'
              ? '请在系统设置确认 DeepSeek Harness 的辅助功能已开启；如出现触控 ID 或密码验证，由本人完成后再点击安全验证。'
            : guidance.nextStep || (typeof this.probes[id] === 'function' ? '由主人点击验证，核对一次限定操作。' : '在对应设置页检测配置和通道状态。'),
          section, checkedAt: proof?.checkedAt || this.checkedAt, verifiedAt: proof?.verifiedAt || null, expiresAt: proof?.expiresAt || null,
          verification: { status, ...(proof?.kind ? { kind: proof.kind,
            summary: id === 'desktop' ? nativeDesktopProof ? 'DSH 本身的输入、点击与回读已核对。' : '独立本机临时窗口的输入、点击与回读已核对。' : PROOF[proof.kind],
            ...(proof.backend ? { backend: proof.backend } : {}), ...(proof.scope ? { scope: proof.scope } : {}) } : {}), ...(code ? { code } : {}) },
          canProbe: !this.closed && !this.storageFault && !this.current && current.host.busy !== true && !facts.disabled && typeof this.probes[id] === 'function' };
      }) };
  }
  result(record, duplicate = false) {
    const code = record.code;
    return { ok: code === 'VERIFIED' || code === 'DETECTED', ...(code === 'VERIFIED' || code === 'DETECTED' ? {} : { code }),
      message: code === 'VERIFIED' ? '固定能力验证已通过。' : code === 'DETECTED' ? '能力状态已刷新；没有自动执行验证。' : MESSAGES[code] || MESSAGES.FAILED,
      ...(duplicate ? { duplicate: true } : {}), ...(code === 'FORBIDDEN' ? {} : { state: this.snapshot() }) };
  }
  prune() { for (const [id, record] of this.requests) if (!record.pending && this.now() >= record.until) this.requests.delete(id); }
  probe(id, { authorize = () => false, requestId, signal } = {}) {
    if (!authorized(authorize)) return Promise.reject(error('FORBIDDEN'));
    if (this.closed) return Promise.reject(error('UNAVAILABLE'));
    if (!IDS.has(id) || typeof requestId !== 'string' || !UUID.test(requestId)) return Promise.reject(error('INVALID_REQUEST'));
    this.prune();
    const existing = this.requests.get(requestId);
    if (existing) return existing.id !== id ? Promise.reject(error('INVALID_REQUEST'))
      : Promise.resolve(existing.promise).then(() => { if (!authorized(authorize)) throw error('FORBIDDEN'); return this.result(existing, true); });
    if (this.current) return Promise.reject(error('BUSY'));
    if (this.storageFault) return Promise.reject(error('STORAGE_UNAVAILABLE'));
    if (this.requests.size >= 128) return Promise.reject(error('LIMIT'));
    if (signal?.aborted) return Promise.reject(error('CANCELLED'));
    const current = this.readCurrent();
    if (current.host.busy === true) return Promise.reject(error('BUSY'));
    if (this.facts(id, current).disabled) return Promise.reject(error('DISABLED'));
    if (typeof this.probes[id] !== 'function') return Promise.reject(error('UNAVAILABLE'));
    const record = { id, requestId, code: 'UNCONFIRMED', checkedAt: this.iso(), until: this.now() + 86400000, pending: true };
    this.requests.set(requestId, record);
    try { this.save(); } catch { this.requests.delete(requestId); return Promise.reject(error('STORAGE_UNAVAILABLE')); }
    record.promise = this.run(id, record, authorize, signal, current.key, current.runtimeKey);
    return record.promise;
  }
  detect({ authorize = () => false, signal } = {}) {
    if (!authorized(authorize)) return Promise.reject(error('FORBIDDEN'));
    if (this.closed) return Promise.reject(error('UNAVAILABLE'));
    if (this.current) return Promise.reject(error('BUSY'));
    if (signal?.aborted) return Promise.reject(error('CANCELLED'));
    const record = { id: 'detect', code: 'UNCONFIRMED', checkedAt: this.iso() };
    const current = this.readCurrent();
    return this.run('detect', record, authorize, signal, current.key, current.runtimeKey);
  }
  async run(id, record, authorize, signal, key, runtimeKey) {
    const controller = new AbortController(), task = { id, controller }; this.current = task;
    let timer, onAbort, release, settled = false;
    const interruption = new Promise((resolve) => { release = resolve; });
    const stop = (code) => { controller.abort(); release({ interrupted: code }); };
    onAbort = () => stop('CANCELLED'); signal?.addEventListener('abort', onAbort, { once: true });
    task.stop = stop;
    timer = setTimeout(() => stop('TIMEOUT'), this.timeoutMs);
    const unchanged = () => { const current = this.readCurrent(); return id === 'detect' ? current.runtimeKey === runtimeKey : current.key === key; };
    const stillAuthorized = () => this.current === task && !this.closed && !controller.signal.aborted && authorized(authorize) && unchanged();
    const operation = Promise.resolve().then(() => {
      if (!stillAuthorized()) throw error('FORBIDDEN');
      return id === 'detect' ? (typeof this.getHost.refresh === 'function' ? this.getHost.refresh({ authorize: stillAuthorized, signal: controller.signal }) : this.getHost())
        : this.probes[id]({ signal: controller.signal, authorize: stillAuthorized });
    }).then((value) => ({ value }), () => ({ failure: true })).finally(() => { settled = true; if (this.current === task) this.current = null; });
    const outcome = await Promise.race([operation, interruption]);
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    let code;
    if (!authorized(authorize)) code = 'FORBIDDEN';
    else if (this.closed) code = 'CANCELLED';
    else if (!unchanged()) code = 'CONFLICT';
    else if (outcome.interrupted) code = outcome.interrupted;
    else if (outcome.failure) code = 'FAILED';
    else if (id === 'detect') { if (outcome.value && typeof outcome.value === 'object') this.host = outcome.value; code = 'DETECTED'; }
    else if (outcome.value?.ok === true && Object.hasOwn(PROOF, outcome.value.evidence?.kind) && outcome.value.evidence?.matched === true) code = 'VERIFIED';
    else code = ['UNAVAILABLE', 'DISABLED', 'CANCELLED', 'TIMEOUT', 'UNCONFIRMED', 'ACCESSIBILITY_REQUIRED',
      'DESKTOP_INIT_UNCONFIRMED', 'DESKTOP_TARGET_UNCONFIRMED'].includes(outcome.value?.code) ? outcome.value.code : 'FAILED';
    record.code = code; record.pending = !settled; record.checkedAt = this.iso(); this.checkedAt = record.checkedAt;
    if (id !== 'detect' && !['FORBIDDEN', 'CONFLICT', 'CANCELLED'].includes(code)) {
      const verified = code === 'VERIFIED';
      this.proofs.set(id, { status: verified ? 'verified' : ['TIMEOUT', 'UNCONFIRMED', 'DESKTOP_INIT_UNCONFIRMED', 'DESKTOP_TARGET_UNCONFIRMED'].includes(code) ? 'uncertain' : 'failed',
        code: verified ? undefined : code, kind: verified ? outcome.value.evidence.kind : undefined, key,
        ...(verified && ['@anionex/dsh-computer-use','dsh-ego-browser'].includes(outcome.value.evidence.backend) ? { backend: outcome.value.evidence.backend } : {}),
        ...(verified && ['dsh-window','owned-local-page'].includes(outcome.value.evidence.scope) ? { scope: outcome.value.evidence.scope } : {}),
        checkedAt: record.checkedAt, verifiedAt: verified ? record.checkedAt : null,
        expiresAt: new Date(this.now() + this.ttlMs).toISOString() });
    }
    // A timed-out operation retains the single-flight gate until its actual
    // promise settles; aborting a signal alone does not prove cleanup finished.
    if (!settled) void operation.then(() => { record.pending = false; });
    try { this.save(); } catch { record.code = 'STORAGE_UNAVAILABLE'; this.proofs.delete(id); }
    return this.result(record);
  }
  load() {
    if (!this.storeFile) return;
    try {
      const stat = fs.lstatSync(this.storeFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw new Error('invalid store');
      const data = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.proofs) || data.proofs.length > 11 || !Array.isArray(data.requests) || data.requests.length > 128) throw new Error('invalid store');
      for (const proof of data.proofs) {
        if (!IDS.has(proof.id) || !validDate(proof.checkedAt) || !validDate(proof.expiresAt)) throw new Error('invalid proof');
        this.proofs.set(proof.id, { loaded: true, status: 'stale', checkedAt: proof.checkedAt, verifiedAt: validDate(proof.verifiedAt) ? proof.verifiedAt : null,
          expiresAt: proof.expiresAt, ...(Object.hasOwn(PROOF, proof.kind) ? { kind: proof.kind } : {}),
          ...(['@anionex/dsh-computer-use','dsh-ego-browser'].includes(proof.backend) ? { backend: proof.backend } : {}),
          ...(['dsh-window','owned-local-page'].includes(proof.scope) ? { scope: proof.scope } : {}) });
      }
      for (const record of data.requests) {
        if (!UUID.test(record.requestId) || !IDS.has(record.id) || !Number.isFinite(record.until) || !validDate(record.checkedAt)) throw new Error('invalid request');
        if (this.now() < record.until) this.requests.set(record.requestId, { id: record.id, requestId: record.requestId, until: record.until,
          checkedAt: record.checkedAt, code: 'UNCONFIRMED', pending: false });
      }
    } catch (cause) { if (cause.code !== 'ENOENT') { this.storageFault = true; this.proofs.clear(); this.requests.clear(); } }
  }
  save() {
    if (!this.storeFile) return;
    let temporary;
    try {
      if (this.storageFault) throw new Error('invalid store');
      try { if (fs.lstatSync(this.storeFile).isSymbolicLink()) throw new Error('symlink'); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      const data = { version: 1,
        proofs: [...this.proofs].map(([id, proof]) => ({ id, checkedAt: proof.checkedAt, verifiedAt: proof.verifiedAt || null, expiresAt: proof.expiresAt,
          ...(proof.kind ? { kind: proof.kind } : {}), ...(proof.backend ? { backend: proof.backend } : {}), ...(proof.scope ? { scope: proof.scope } : {}) })),
        requests: [...this.requests.values()].map(({ id, requestId, checkedAt, until }) => ({ id, requestId, checkedAt, until })) };
      const bytes = Buffer.from(JSON.stringify(data)); if (bytes.length > 131072) throw new Error('full');
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true, mode: 0o700 }); temporary = this.storeFile + '.' + randomUUID() + '.tmp';
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.storeFile); temporary = null;
      const directory = fs.openSync(path.dirname(this.storeFile), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { this.storageFault = true; throw error('STORAGE_UNAVAILABLE'); }
    finally { if (temporary) try { fs.unlinkSync(temporary); } catch {} }
  }
  dispose() { this.closed = true; this.current?.stop?.('CANCELLED'); }
}

export function capabilityPromptSummary(registry) {
  const snapshot = registry?.snapshot?.();
  if (!snapshot?.items) return '';
  return '【当前能力状态】状态仅表示检测证据，不授予权限；未实测不应承诺可执行。尚未检测不等于能力缺失；用户要做事时先查可用工具并依据实际调用结果判断，不能仅因无验证就声称不会。' + snapshot.items
    .map((item) => `${item.title}：${item.stateText}`).join('；') + '。查看详情可用 dafeiyu_capabilities；实际操作仍核对当前授权。'
    + (snapshot.controlBackend === 'dsh-plugins'
      ? '【默认界面通道】电脑界面使用 Anionex 的 DSH 专用插件，先调用 dafeiyu_control_context，再只加载 dsh-computer-use 技能并使用 computer_* 原生工具。'
        + '浏览器使用 Fisfzy 的 dsh-ego-browser 原生 ego_* 工具，每次显式指定 dafeiyu_control_context 返回的 space。短任务可自己执行，多步骤界面任务交 dafeiyu_task_start，填写 control=desktop 或 browser，执行器用 native。'
        + '同一主人对话延续自己的浏览器空间；子任务只用本任务空间。操作前观察，操作后回读；拒绝、取消或结果未知时停止并说明，不自动重做，也不换成旧 Orca/Ego CLI。'
        + '电脑安全验证覆盖 DSH 本身的测试框，浏览器安全验证覆盖专属本地测试页；其他应用和网站按任务及授权逐项核验。'
      : '当前电脑界面安全验证仅覆盖独立本机临时窗口，不代表所有应用或 DSH 自身兼容已通过。DSH 自身窗口可能被共享浮层遮蔽，读取不到目标时停止操作。'
        + 'macOS 中首次需要读取或操作 DSH 自身界面时，可先调用 dafeiyu_desktop_prepare 初始化本应用的 Electron 辅助树，再按 computer-use 技能使用真实工具操作。初始化不授予系统权限、不操作其他应用，也不代表输入点击已验证；当前用户只问状态时不要初始化。');
}
