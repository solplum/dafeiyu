import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { ConfigStoreError } from './config-store.js';
const execute = promisify(execFile);

// Parse locally, retain only fixed categories. Raw ADB output can contain
// device identifiers, host paths or other private text and never leaves here.
const DIAGNOSTICS = {
  online: ['ADB 已确认配置设备在线，未读取屏幕或录音', '连接检查已完成；手机操作仍按已授权工具范围执行。'],
  unauthorized: ['ADB 已发现设备，但设备尚未授权', '查看手机上的调试授权提示；无线调试请核对本机是否仍在已配对设备列表中。'],
  authentication_failed: ['ADB 明确返回身份认证失败', '在手机无线调试中核对本机配对状态；若需重新配对，使用手机当次显示的配对端口和配对码。'],
  device_offline: ['ADB 记录中存在配置设备，但当前离线', '确认手机无线调试仍开启，并核对当前 IP 和连接端口；可再点击“连接配置设备”。'],
  device_not_found: ['ADB 当前未找到配置的设备', '核对手机显示的 IP:连接端口与配置是否一致；设备未找到不能单独证明未配对。'],
  adb_missing: ['当前运行配置的 ADB 程序不存在', '到“依赖与更新”检查 ADB 安装；确认运行时使用的 ADB 路径后重新应用配置。'],
  adb_not_executable: ['当前运行配置的 ADB 程序无法执行', '到“依赖与更新”检查 ADB；核对可执行文件和执行权限，修复后重新检测。'],
  adb_server_unavailable: ['本机 ADB 服务未能正常连接或启动', '检查本机 ADB 服务及其端口占用，再重新检测；这不是手机连接端口拒绝连接的结论。'],
  device_permission_denied: ['本机没有访问该设备的权限', '核对本机 USB 设备访问权限与调试设置；这与手机上的授权确认是不同问题。'],
  address_unresolved: ['配置设备的主机地址无法解析', '核对配置的主机名或手机当前 IP；未改用其他设备。'],
  network_unreachable: ['配置设备地址的网络不可达', '先确认电脑和手机当前网络可以互通，再核对手机当前 Wi-Fi 地址和连接端口；配置已过期时，仅重试不会修正地址。'],
  connection_refused: ['配置设备的连接端口拒绝连接', '确认手机无线调试已开启，并核对当前连接端口；端口拒绝连接不等于未配对。'],
  connect_timeout: ['连接配置设备超时，尚未确认在线', '核对网络、手机当前 IP 和连接端口后重试；超时不能证明配对失败。'],
  check_timeout: ['ADB 设备状态检查超时，尚未确认在线', '确认 ADB 服务及手机连接是否响应后重新检测；超时不能证明配对失败。'],
  connection_failed: ['ADB 未能确认连接配置设备', '核对网络、无线调试和当前连接地址后重试；未返回原始命令输出。'],
  check_failed: ['未能读取明确的 ADB 设备状态', '到“依赖与更新”检查 ADB，再核对配置设备并重新检测；未返回原始命令输出。'],
};
const diagnosis = (reasonCode) => ({ reasonCode, note: DIAGNOSTICS[reasonCode][0], nextStep: DIAGNOSTICS[reasonCode][1] });
function classifyAdb(result, error, phase) {
  const code = String(error?.code || '').toUpperCase();
  const output = [result?.stdout, result?.stderr, error?.stdout, error?.stderr, error?.message]
    .filter((value) => typeof value === 'string').map((value) => value.slice(0, 8192)).join('\n').toLowerCase();
  if (code === 'ENOENT') return diagnosis('adb_missing');
  if (['EACCES', 'EPERM', 'ENOEXEC'].includes(code)) return diagnosis('adb_not_executable');
  if (/cannot connect to daemon|failed to start daemon|could not read ok from adb server|cannot bind[^\r\n]*5037|adb server[^\r\n]*(?:didn't ack|failed)|could not install[^\r\n]*smartsocket/.test(output)) return diagnosis('adb_server_unavailable');
  if (/insufficient permissions for device|no permissions(?: for device|\s*\()/.test(output)) return diagnosis('device_permission_denied');
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code) || /cannot resolve (?:host|hostname)|name or service not known|nodename nor servname provided|no such host is known/.test(output)) return diagnosis('address_unresolved');
  if (['ENETUNREACH', 'EHOSTUNREACH'].includes(code) || /network is unreachable|network unreachable|no route to host|host is unreachable/.test(output)) return diagnosis('network_unreachable');
  if (code === 'ECONNREFUSED' || /connection refused|actively refused/.test(output)) return diagnosis('connection_refused');
  if (['ETIMEDOUT', 'PHONE_DIAGNOSTIC_TIMEOUT'].includes(code) || /connection timed out|operation timed out|connect(?:ion)? timeout/.test(output)) return diagnosis(phase === 'connect' ? 'connect_timeout' : 'check_timeout');
  if (/device\b[^\r\n]*\bnot found\b|no devices\/emulators found|no devices found/.test(output)) return diagnosis('device_not_found');
  if (/(?:^|\n)\s*(?:error:\s*)?(?:device\s+)?unauthorized(?:[.\s]|$)|\bdevice (?:is )?unauthorized\b/.test(output)) return diagnosis('unauthorized');
  if (/failed to authenticate|authentication failed|authentication failure/.test(output)) return diagnosis('authentication_failed');
  if (/(?:^|\n)\s*(?:error:\s*)?(?:device\s+)?offline(?:[.\s]|$)|\bdevice (?:is )?offline\b/.test(output)) return diagnosis('device_offline');
  // Connect can exit successfully with a textual error. A success line is not
  // an online proof; only the following exact get-state result may prove that.
  if (!error && phase === 'connect' && /^(?:already )?connected to /m.test(output)
    && !/failed|unable|cannot|error:/.test(output)) return null;
  return diagnosis(phase === 'connect' ? 'connection_failed' : 'check_failed');
}

function finalDiagnosis(connectIssue, stateIssue) {
  // An explicit state authorization or host-tool error is stronger than an
  // earlier connection attempt. A concrete connect failure must survive the
  // generic offline/not-found entry left in the local ADB transport table.
  if (stateIssue && !['device_offline', 'device_not_found', 'check_failed'].includes(stateIssue.reasonCode)) return stateIssue;
  if (connectIssue && connectIssue.reasonCode !== 'connection_failed') return connectIssue;
  return stateIssue || connectIssue || diagnosis('check_failed');
}

// A USB serial and adb pairing target are not interchangeable with an explicit
// TCP connect address. Never guess a port or enumerate another device.
function isTcpTarget(device) {
  if (typeof device !== 'string' || device.length > 261 || device.trim() !== device) return false;
  const match = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(device);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return false;
  const host = match[1];
  if (host.startsWith('[')) return isIP(host.slice(1, -1)) === 6;
  if (isIP(host)) return true;
  if (/^[\d.]+$/.test(host) || host.length > 253) return false;
  return host.split('.').every((label) => label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label));
}

export class RuntimeDiagnostics {
  constructor({ getRuntime, getBusy = () => false, execFileImpl = execute, timeoutMs = 5000, now = Date.now }) {
    this.getRuntime = getRuntime;
    this.getBusy = getBusy;
    this.exec = execFileImpl;
    this.timeoutMs = Math.max(1, Math.min(5000, Number(timeoutMs) || 5000));
    this.now = now;
    this.lastCheck = null;
    this.operation = null;
    this.closed = false;
  }
  get active() { return this.operation ? 1 : 0; }
  phone() {
    const phone = this.getRuntime()?.phoneTools;
    if (phone?.enabled !== true || this.closed) this.lastCheck = null;
    const current = this.lastPhone === phone && this.lastCheck?.device === phone?.device
      && this.lastCheck?.adbPath === phone?.adbPath ? this.lastCheck : null;
    const fresh = current && this.now() - Date.parse(current.at) <= 60000;
    const connectReason = this.closed ? '手机诊断已停止，请刷新 DSH'
      : phone?.enabled !== true ? '请先在手机权限页启用并应用配置'
      : !phone?.device ? '请先配置明确的手机地址'
      : !isTcpTarget(phone.device) ? '无线连接需要明确的主机:端口；USB 设备请使用检测连接' : '';
    return { enabled: phone?.enabled === true, device: String(phone?.device || ''),
      state: phone?.enabled !== true ? 'disabled' : fresh ? current.online ? 'online' : 'offline' : 'not-probed',
      canConnect: !connectReason, connectReason, checking: Boolean(this.operation),
      checkedAt: current?.at || null, reasonCode: fresh ? current.reasonCode : current ? 'stale' : 'not_checked',
      nextStep: fresh ? current.nextStep : current ? '点击“检测手机连接”获取当前状态。' : '',
      note: current && !fresh ? '上次连接检测已过期，请重新检测' : current?.note || '尚未检测设备连接，不会自动连接、截图或录音', lastTool: phone?.lastToolResult || null };
  }
  assertCurrent(phone, snapshot, authorize) {
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '主人权限已失效');
    if (this.closed) throw new ConfigStoreError('UNAVAILABLE', '手机诊断已停止，请刷新 DSH');
    if (this.getRuntime()?.phoneTools !== phone || phone.device !== snapshot.device
      || phone.adbPath !== snapshot.adbPath || phone.enabled !== true) {
      throw new ConfigStoreError('CONFLICT', '手机运行配置已经变化，请重新检测');
    }
  }
  async command(file, args, signal, guard) {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    let timer, rejectAbort, timedOut = false;
    const cancelled = new Promise((_resolve, reject) => {
      rejectAbort = () => reject(new Error('Phone diagnostic cancelled'));
      abort.signal.addEventListener('abort', rejectAbort, { once: true });
      if (abort.signal.aborted) rejectAbort();
      timer = setTimeout(() => { timedOut = true; abort.abort(); }, this.timeoutMs);
    });
    try {
      return await Promise.race([cancelled, Promise.resolve().then(() => {
        abort.signal.throwIfAborted();
        guard();
        return this.exec(file, args, { timeout: this.timeoutMs, maxBuffer: 8192, windowsHide: true, signal: abort.signal });
      })]);
    } catch (error) {
      if (timedOut) throw Object.assign(new Error('Phone diagnostic timed out'), { code: 'PHONE_DIAGNOSTIC_TIMEOUT' });
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      abort.signal.removeEventListener('abort', rejectAbort);
    }
  }
  async observe(connect, { authorize = () => false } = {}) {
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '主人权限已失效');
    if (this.closed) throw new ConfigStoreError('UNAVAILABLE', '手机诊断已停止，请刷新 DSH');
    if (this.operation || this.getBusy()) throw new ConfigStoreError('BUSY', '正在处理任务或检测手机，请稍后再试');
    const phone = this.getRuntime()?.phoneTools;
    if (phone?.enabled !== true || !phone.device) throw new ConfigStoreError('UNAVAILABLE', '请先启用手机并配置明确设备');
    const snapshot = { device: phone.device, adbPath: phone.adbPath };
    if (connect && !isTcpTarget(snapshot.device)) throw new ConfigStoreError('INVALID_CONFIG', '无线连接需要明确的主机:端口；USB 设备请使用检测连接');
    const operation = new AbortController();
    const guard = () => this.assertCurrent(phone, snapshot, authorize);
    this.operation = operation;
    // An earlier online proof must not survive a failed or cancelled new attempt.
    this.lastCheck = null;
    try {
      let connectIssue = null;
      if (connect) {
        try { connectIssue = classifyAdb(await this.command(snapshot.adbPath, ['connect', snapshot.device], operation.signal, guard), null, 'connect'); }
        catch (error) { connectIssue = classifyAdb(null, error, 'connect'); }
        this.assertCurrent(phone, snapshot, authorize);
      }
      let online = false, stateIssue = null;
      try {
        const result = await this.command(snapshot.adbPath, ['-s', snapshot.device, 'get-state'], operation.signal, guard);
        online = String(result.stdout).trim() === 'device';
        if (!online) stateIssue = classifyAdb(result, null, 'get-state');
      } catch (error) { stateIssue = classifyAdb(null, error, 'get-state'); }
      this.assertCurrent(phone, snapshot, authorize);
      this.lastPhone = phone;
      this.lastCheck = { ...snapshot, online, at: new Date(this.now()).toISOString(),
        ...(online ? diagnosis('online') : finalDiagnosis(connectIssue, stateIssue)) };
    } finally {
      if (this.operation === operation) this.operation = null;
    }
    return this.phone();
  }
  checkPhone(options) { return this.observe(false, options); }
  connectPhone(options) { return this.observe(true, options); }
  dispose() {
    this.closed = true;
    this.lastCheck = null;
    this.operation?.abort();
  }
}
