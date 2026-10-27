import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CapabilityRegistry, CAPABILITY_IDS, capabilityPromptSummary } from '../packages/dsh-dafeiyu/src/capabilities.js';

const owner = () => true;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const verified = { ok: true, evidence: { kind: 'read-only', matched: true } };
const item = (registry, id = 'computer') => registry.snapshot().items.find((entry) => entry.id === id);
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-capability-'));
  const clock = { value: Date.parse('2026-10-24T00:00:00Z') }, state = { runtime: { instanceId: 'runtime-a' }, host: { computer: { present: true, available: true } } };
  const calls = [], refreshes = [], registryInstances = [];
  const getHost = () => state.host;
  getHost.refresh = async (input) => { refreshes.push(input); return state.host; };
  const create = (patch = {}) => {
    const registry = new CapabilityRegistry({ getRuntime: () => state.runtime, getHost, now: () => clock.value,
      ttlMs: 1000, timeoutMs: 1000, probes: { computer: async (input) => { calls.push(input); return verified; } }, ...options, ...patch });
    registryInstances.push(registry); return registry;
  };
  const registry = create();
  t.after(() => { registryInstances.forEach((entry) => entry.dispose()); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, clock, state, calls, refreshes, getHost, registry, create,
    probe: (id = 'computer', patch = {}) => registry.probe(id, { authorize: owner, requestId: randomUUID(), ...patch }) };
}

test('snapshots and prompt summaries expose fixed safe facts without running probes or host refresh', (t) => {
  const f = fixture(t); f.state.host.computer.reason = 'PRIVATE_SECRET';
  f.state.runtime = { instanceId: 'a', privateMemory: 'PRIVATE_MEMORY', personalQQ: { configured: true, enabled: true,
    connected: true, loginVerified: true, online: true, userId: 'PRIVATE_QQ' }, phone: { enabled: false, device: 'PRIVATE_DEVICE' } };
  const snapshot = f.registry.snapshot(); assert.deepEqual(snapshot.items.map((entry) => entry.id), CAPABILITY_IDS);
  assert.equal(item(f.registry).state, 'ready'); assert.equal(item(f.registry, 'qq').state, 'ready');
  assert.equal(item(f.registry, 'phone').state, 'disabled'); assert.equal(snapshot.checkedAt, null);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false); assert.equal(f.calls.length, 0); assert.equal(f.refreshes.length, 0);
  assert.match(capabilityPromptSummary(f.registry), /不授予权限.*未实测/); assert.equal(f.calls.length, 0);
  assert.match(capabilityPromptSummary(f.registry), /尚未检测不等于能力缺失.*不能仅因无验证就声称不会/);
  assert.match(capabilityPromptSummary(f.registry), /安全验证仅覆盖独立本机临时窗口.*DSH 自身窗口可能被共享浮层遮蔽，读取不到目标时停止操作/);
  assert.ok(snapshot.items.filter((entry) => ['computer', 'desktop', 'browser', 'web'].includes(entry.id)).every((entry) => entry.section === 'dependencies'));
});

test('the selected DSH plugin route survives missing metadata and uncertain proofs without reverting to legacy CLI', (t) => {
  const f = fixture(t, { controlBackend: 'dsh-plugins' });
  f.state.host = {};
  const prompt = capabilityPromptSummary(f.registry);
  assert.equal(f.registry.snapshot().controlBackend, 'dsh-plugins');
  assert.match(prompt, /dafeiyu_control_context.*dsh-computer-use/);
  assert.match(prompt, /每次显式指定.*返回的 space/);
  assert.match(prompt, /不自动重做，也不换成旧 Orca\/Ego CLI/);
  assert.doesNotMatch(prompt, /再按 computer-use 技能/);
  assert.equal(f.calls.length, 0); assert.equal(f.refreshes.length, 0);
});

test('host components expose only fixed booleans and safe semantic versions, never raw metadata or reasons', (t) => {
  const f = fixture(t); f.state.host = { checkedAt: f.clock.value, tools: ['bash', 'read'], skills: ['computer-use', 'ego-browser'], skillsComplete: true,
    desktop: { present: true, available: null, cliPresent: true, version: '1.2.3-beta.1+build.4', reason: 'PRIVATE_REASON',
      metadata: { accessibilityGranted: true, screenshotsGranted: true, helperAppPath: 'PRIVATE_PATH', raw: 'PRIVATE_RAW' } },
    browser: { present: true, available: null, cliPresent: 'PRIVATE_STRING', version: 'PRIVATE_VERSION' } };
  assert.deepEqual(item(f.registry, 'desktop').components, { cliPresent: true, version: '1.2.3-beta.1+build.4', skillVisible: true,
    terminalVisible: true, accessibilityGranted: true, screenshotsGranted: true });
  assert.deepEqual(item(f.registry, 'browser').components, { cliPresent: null, skillVisible: true, terminalVisible: true,
    accessibilityGranted: null, screenshotsGranted: null });
  assert.equal(JSON.stringify(f.registry.snapshot()).includes('PRIVATE'), false); assert.equal(f.calls.length, 0); assert.equal(f.refreshes.length, 0);
});

test('missing macOS interface permissions override optimistic availability and give a fixed actionable system-settings instruction', (t) => {
  const f = fixture(t); f.state.host = { checkedAt: f.clock.value, tools: ['bash'], skills: ['computer-use'], skillsComplete: true,
    desktop: { present: true, available: true, cliPresent: true, metadata: { accessibilityGranted: false, screenshotsGranted: true } } };
  const desktop = item(f.registry, 'desktop'); assert.equal(desktop.available, false); assert.equal(desktop.state, 'unavailable');
  assert.match(desktop.nextStep, /在系统设置的隐私与安全性中授权 Orca Computer Use 的辅助功能\/屏幕录制，再检测/);
  f.state.host.desktop.metadata = { accessibilityGranted: true, screenshotsGranted: false };
  assert.equal(item(f.registry, 'desktop').available, false); assert.equal(f.calls.length, 0);
});

test('incomplete discovery remains unknown while observed missing terminal, skill and CLI name concrete next steps', (t) => {
  const f = fixture(t); f.state.host = { checkedAt: null, tools: [], skills: [], skillsComplete: null,
    browser: { present: null, available: null }, desktop: { present: null, available: null } };
  for (const id of ['browser', 'desktop']) {
    assert.equal(item(f.registry, id).components.skillVisible, null); assert.equal(item(f.registry, id).components.terminalVisible, null);
    assert.equal(item(f.registry, id).state, 'unknown');
  }
  f.state.host.checkedAt = f.clock.value; f.state.host.tools = ['read']; f.state.host.skillsComplete = true;
  f.state.host.browser.cliPresent = false; f.state.host.desktop.cliPresent = false;
  for (const [id, skill, cli] of [['browser', 'ego-browser', 'ego-browser'], ['desktop', 'computer-use', 'Orca Computer Use']]) {
    const entry = item(f.registry, id); assert.equal(entry.available, false); assert.equal(entry.state, 'unavailable');
    assert.match(entry.nextStep, /启用终端（bash）工具/); assert.ok(entry.nextStep.includes('启用 ' + skill + ' 技能'));
    assert.ok(entry.nextStep.includes('安装或修复 ' + cli + ' 命令入口'));
  }
});

test('complete interface metadata still requires click/input proof and a revoked permission cannot revive an old successful proof', async (t) => {
  const f = fixture(t); f.state.host = { checkedAt: f.clock.value, tools: ['bash'], skills: ['computer-use', 'ego-browser'], skillsComplete: true,
    desktop: { present: true, available: null, cliPresent: true, metadata: { accessibilityGranted: true, screenshotsGranted: true } },
    browser: { present: true, available: null, cliPresent: true } };
  for (const id of ['desktop', 'browser']) {
    const entry = item(f.registry, id); assert.equal(entry.state, 'unknown'); assert.equal(entry.verifiedAt, null);
    assert.match(entry.reason, /入口\/权限已检测，实际输入点击尚未确认/);
  }
  f.registry.probes.desktop = async () => verified; await f.probe('desktop'); assert.equal(item(f.registry, 'desktop').state, 'verified');
  f.state.host.desktop.metadata.accessibilityGranted = false; assert.equal(item(f.registry, 'desktop').state, 'unavailable');
  f.state.host.desktop.metadata.accessibilityGranted = true; assert.equal(item(f.registry, 'desktop').state, 'stale');
  assert.equal(f.calls.length, 0);
});

test('actual accessibility denial names the execution app and personal system verification despite granted Orca metadata', async (t) => {
  const f = fixture(t); f.state.host = { checkedAt: f.clock.value, tools: ['bash'], skills: ['computer-use'], skillsComplete: true,
    desktop: { present: true, available: null, cliPresent: true, metadata: { accessibilityGranted: true, screenshotsGranted: true } } };
  f.registry.probes.desktop = async () => ({ ok: false, code: 'ACCESSIBILITY_REQUIRED' });
  const result = await f.probe('desktop'); assert.equal(result.ok, false); assert.equal(result.code, 'ACCESSIBILITY_REQUIRED');
  const failed = item(f.registry, 'desktop');
  assert.equal(failed.components.accessibilityGranted, true); assert.equal(failed.state, 'failed'); assert.equal(failed.verifiedAt, null);
  assert.match(failed.nextStep, /系统设置确认 DeepSeek Harness 的辅助功能已开启/);
  assert.match(failed.nextStep, /触控 ID 或密码验证，由本人完成后再点击安全验证/);
  f.clock.value += 1000;
  const stale = item(f.registry, 'desktop'); assert.equal(stale.state, 'stale');
  assert.equal(stale.nextStep.includes('由本人完成'), false, 'an expired denial must not override current guidance');
  f.registry.probes.desktop = async () => verified;
  assert.equal((await f.probe('desktop')).ok, true);
  const current = item(f.registry, 'desktop'); assert.equal(current.state, 'verified');
  assert.match(current.nextStep, /^使用时仍须遵守当前账号和工具授权。/);
  assert.equal(current.nextStep.includes('触控 ID'), false);
});

test('desktop success only certifies the independent temporary window and keeps DSH compatibility limitations explicit', async (t) => {
  const f = fixture(t); f.state.host.desktop = { present: true, available: null };
  f.registry.probes.desktop = async () => ({ ok: true, evidence: { kind: 'readback', matched: true } });
  assert.equal((await f.probe('desktop')).ok, true);
  const desktop = item(f.registry, 'desktop'); assert.equal(desktop.state, 'verified');
  assert.match(desktop.description, /只覆盖独立本机临时窗口，不表示所有应用或 DSH 自身兼容已通过/);
  assert.match(desktop.reason, /独立本机临时窗口的输入、点击和回读已实测/);
  assert.match(desktop.reason, /不代表所有应用或 DSH 自身兼容已通过/);
  assert.match(desktop.nextStep, /DSH 自身窗口可能被共享浮层遮蔽，读取不到目标时停止操作/);
  assert.match(desktop.verification.summary, /独立本机临时窗口/);
  await f.probe('computer');
  assert.equal(item(f.registry, 'computer').reason.includes('独立本机临时窗口'), false, 'other capability proof descriptions remain unchanged');
});

test('desktop initialization and target diagnostics retain uncertain proofs and duplicate UUIDs cannot replay them', async (t) => {
  const f = fixture(t); f.state.host.desktop = { present: true, available: null };
  for (const [code, explanation] of [['DESKTOP_INIT_UNCONFIRMED', '本应用辅助树初始化尚未确认'],
    ['DESKTOP_TARGET_UNCONFIRMED', '绑定窗口内尚未找到唯一的本机测试框']]) {
    let calls = 0;
    f.registry.probes.desktop = async () => { calls++; return { ok: false, code, rawTree: 'PRIVATE_TREE', path: 'PRIVATE_PATH', stdout: 'PRIVATE_OUTPUT' }; };
    const requestId = randomUUID(), result = await f.probe('desktop', { requestId });
    assert.equal(result.ok, false); assert.equal(result.code, code);
    const entry = item(f.registry, 'desktop'); assert.equal(entry.state, 'failed'); assert.equal(entry.verifiedAt, null);
    assert.equal(entry.verification.status, 'uncertain'); assert.equal(entry.verification.code, code);
    assert.ok(entry.reason.includes(explanation)); assert.match(entry.reason, /尚未输入或点击/); assert.match(entry.reason, /不会自动重试/);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    const duplicate = await f.probe('desktop', { requestId }); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.code, code); assert.equal(calls, 1);
  }
});

test('switching to native plugins never relabels a legacy temporary-window proof as a DSH-window success', async (t) => {
  const f = fixture(t), storeFile = path.join(f.dir, 'native-proofs.json');
  f.state.host.desktop = { present: true, available: null, components: {
    backend: '@anionex/dsh-computer-use', cliPresent: true, skillVisible: true, accessibilityGranted: true } };
  fs.writeFileSync(storeFile, JSON.stringify({ version: 1, proofs: [{ id: 'desktop', kind: 'readback',
    checkedAt: new Date(f.clock.value).toISOString(), verifiedAt: new Date(f.clock.value).toISOString(),
    expiresAt: new Date(f.clock.value + 1000).toISOString() }], requests: [] }));
  const registry = f.create({ storeFile, probes: { desktop: async () => ({ ok: true, evidence: {
    kind: 'readback', matched: true, backend: '@anionex/dsh-computer-use', scope: 'dsh-window' } }) } });
  assert.equal(item(registry, 'desktop').state, 'stale');
  assert.match(item(registry, 'desktop').verification.summary, /独立本机临时窗口/);
  await registry.probe('desktop', { authorize: owner, requestId: randomUUID() });
  assert.equal(item(registry, 'desktop').state, 'verified');
  assert.match(item(registry, 'desktop').verification.summary, /DSH 本身/);
  assert.equal(item(registry, 'desktop').verification.scope, 'dsh-window');
  const restored = f.create({ storeFile });
  assert.equal(item(restored, 'desktop').state, 'stale');
  assert.equal(item(restored, 'desktop').verification.backend, '@anionex/dsh-computer-use');
  assert.equal(item(restored, 'desktop').verification.scope, 'dsh-window');
});

test('runtime readiness uses channel evidence and never converts installed or configured services into verified operations', (t) => {
  const f = fixture(t); f.state.runtime = { instanceId: 'a', personalQQ: { enabled: true, configured: true, connected: true,
    loginVerified: false, online: true }, phone: { enabled: true, state: 'not-probed' }, voiceInput: { receiveEnabled: true, configured: true },
    voiceOutput: { enabled: true, configured: true, readiness: 'synthesis-verified' }, memory: { enabled: true, available: true },
    memes: { enabled: false, available: true }, backgroundTasks: { ready: false } };
  for (const id of ['qq', 'background']) assert.equal(item(f.registry, id).state, 'unavailable');
  for (const id of ['phone', 'voice-input']) assert.equal(item(f.registry, id).state, 'unknown');
  for (const id of ['voice-output', 'memory']) assert.equal(item(f.registry, id).state, 'ready');
  assert.equal(item(f.registry, 'memes').state, 'disabled'); assert.equal(f.calls.length, 0);
});

test('detection is explicit, authorized, refreshes metadata only and accepts a changed host readiness snapshot', async (t) => {
  const f = fixture(t); await assert.rejects(f.registry.detect(), { code: 'FORBIDDEN' }); assert.equal(f.refreshes.length, 0);
  f.getHost.refresh = async (input) => { f.refreshes.push(input); f.state.host.browser = { present: true, available: true }; return f.state.host; };
  const result = await f.registry.detect({ authorize: owner }); assert.equal(result.ok, true);
  assert.equal(result.state.checkedAt, new Date(f.clock.value).toISOString()); assert.equal(item(f.registry, 'browser').state, 'ready');
  assert.equal(f.refreshes.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.refreshes[0].authorize(), false, 'the completed operation cannot retain an authority lease');
});

test('one fixed successful proof is shared by duplicate UUIDs and sanitizes arbitrary probe output', async (t) => {
  const f = fixture(t); const gate = deferred();
  f.registry.probes.computer = async (input) => { f.calls.push(input); return gate.promise; };
  const requestId = randomUUID(), first = f.probe('computer', { requestId }), duplicate = f.probe('computer', { requestId });
  await tick(); assert.equal(f.calls.length, 1); assert.equal(item(f.registry).verification.status, 'running');
  await assert.rejects(f.probe('browser'), { code: 'BUSY' });
  gate.resolve({ ...verified, text: 'PRIVATE_BODY', stderr: 'PRIVATE_ERROR', evidence: { ...verified.evidence, nonce: 'PRIVATE_NONCE' } });
  assert.equal((await first).ok, true); assert.equal((await duplicate).duplicate, true);
  assert.equal((await f.probe('computer', { requestId })).duplicate, true); assert.equal(f.calls.length, 1);
  assert.equal(item(f.registry).state, 'verified'); assert.equal(JSON.stringify(f.registry.snapshot()).includes('PRIVATE'), false);
  await assert.rejects(f.probe('browser', { requestId }), { code: 'INVALID_REQUEST' });
});

test('start and end authorization are required and late successful results cannot survive revocation', async (t) => {
  const f = fixture(t), gate = deferred(); let allowed = true;
  f.registry.probes.computer = async () => gate.promise;
  await assert.rejects(f.registry.probe('computer', { requestId: randomUUID() }), { code: 'FORBIDDEN' });
  const pending = f.probe('computer', { authorize: () => allowed }); await tick(); allowed = false; gate.resolve(verified);
  const result = await pending; assert.equal(result.code, 'FORBIDDEN'); assert.equal('state' in result, false);
  assert.equal(item(f.registry).state, 'ready'); assert.equal(item(f.registry).verifiedAt, null);
});

test('runtime replacement fences in-flight results and revokes old proofs without leaking instance identities', async (t) => {
  const f = fixture(t); assert.equal((await f.probe()).ok, true);
  f.state.runtime = { instanceId: 'PRIVATE_RUNTIME_B' }; assert.equal(item(f.registry).state, 'stale');
  const gate = deferred(); f.registry.probes.computer = async () => gate.promise;
  const pending = f.probe(); await tick(); f.state.runtime = { instanceId: 'c' }; gate.resolve(verified);
  assert.equal((await pending).code, 'CONFLICT'); assert.equal(item(f.registry).state, 'stale');
  assert.equal(JSON.stringify(f.registry.snapshot()).includes('PRIVATE'), false);
});

test('verification expires and current missing or disabled conditions override historical successful proof', async (t) => {
  const f = fixture(t); await f.probe(); f.clock.value += 1000;
  assert.equal(item(f.registry).state, 'stale');
  f.state.host.computer.available = false; assert.equal(item(f.registry).state, 'unavailable');
  f.state.runtime.phone = { enabled: false }; await assert.rejects(f.probe('phone'), { code: 'DISABLED' });
});

test('invalid evidence, exceptions and arbitrary errors never claim verification or expose diagnostics', async (t) => {
  const f = fixture(t);
  for (const value of [{ ok: true, evidence: { kind: 'nonce', matched: false } },
    { ok: true, evidence: { kind: 'PRIVATE_PROOF', matched: true } }, { ok: false, code: 'PRIVATE_CODE', stderr: 'PRIVATE_ERROR' }]) {
    f.registry.probes.computer = async () => value; const result = await f.probe(); assert.equal(result.code, 'FAILED');
    assert.equal(item(f.registry).state, 'failed'); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
  f.registry.probes.computer = async () => { throw new Error('PRIVATE_EXCEPTION'); };
  const result = await f.probe(); assert.equal(result.code, 'FAILED'); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('timeout returns promptly but retains single-flight until the actual operation settles and never retries the UUID', async (t) => {
  const f = fixture(t, { timeoutMs: 10 }), gate = deferred();
  f.registry.probes.computer = async (input) => { f.calls.push(input); return gate.promise; };
  const requestId = randomUUID(), result = await f.probe('computer', { requestId });
  assert.equal(result.code, 'TIMEOUT'); assert.equal(f.calls[0].signal.aborted, true); assert.equal(result.state.busy, true);
  await assert.rejects(f.probe(), { code: 'BUSY' });
  assert.equal((await f.probe('computer', { requestId })).duplicate, true); assert.equal(f.calls.length, 1);
  gate.resolve(verified); await tick(); assert.equal(f.registry.snapshot().busy, false);
  assert.equal(item(f.registry).verification.status, 'uncertain'); assert.equal(item(f.registry).state, 'failed');
});

test('external cancellation and disposal revoke in-flight work and prevent a late proof from being published', async (t) => {
  const f = fixture(t), gate = deferred(), controller = new AbortController();
  f.registry.probes.computer = async (input) => { f.calls.push(input); return gate.promise; };
  const pending = f.probe('computer', { signal: controller.signal }); await tick(); controller.abort();
  assert.equal((await pending).code, 'CANCELLED'); assert.equal(f.calls[0].signal.aborted, true);
  gate.resolve(verified); await tick(); assert.equal(item(f.registry).verifiedAt, null);
  const gate2 = deferred(); f.registry.probes.computer = async () => gate2.promise;
  const second = f.probe(); await tick(); f.registry.dispose(); assert.equal((await second).code, 'CANCELLED');
  gate2.resolve(verified); await tick(); assert.equal(item(f.registry).canProbe, false);
  await assert.rejects(f.probe(), { code: 'UNAVAILABLE' });
});

test('persistent proof files are bounded private metadata, history loads stale and old request UUIDs never replay', async (t) => {
  const f = fixture(t), storeFile = path.join(f.dir, 'proofs.json'); const registry = f.create({ storeFile });
  registry.probes.computer = async () => ({ ...verified, text: 'PRIVATE_TEXT', nonce: 'PRIVATE_NONCE' });
  const requestId = randomUUID(); await registry.probe('computer', { authorize: owner, requestId });
  assert.equal(fs.statSync(storeFile).mode & 0o777, 0o600); assert.equal(fs.readFileSync(storeFile, 'utf8').includes('PRIVATE'), false);
  registry.dispose(); const restored = f.create({ storeFile });
  assert.equal(item(restored).state, 'stale'); const result = await restored.probe('computer', { authorize: owner, requestId });
  assert.equal(result.duplicate, true); assert.equal(result.code, 'UNCONFIRMED'); assert.equal(f.calls.length, 0);
  assert.equal((await restored.probe('computer', { authorize: owner, requestId: randomUUID() })).ok, true);
  assert.equal(item(restored).state, 'verified');
});

test('corrupt or symlinked proof storage fails closed without overwriting the target or dispatching probes', async (t) => {
  const f = fixture(t), target = path.join(f.dir, 'target'), storeFile = path.join(f.dir, 'link');
  fs.writeFileSync(target, 'PRIVATE_TARGET'); fs.symlinkSync(target, storeFile);
  const registry = f.create({ storeFile }); assert.equal(item(registry).canProbe, false);
  await assert.rejects(registry.probe('computer', { authorize: owner, requestId: randomUUID() }), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'PRIVATE_TARGET'); assert.equal(f.calls.length, 0);
  assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith('.tmp')), false);
});


test('unconfirmed host cleanup keeps capability UI and config gate busy without launching another probe', async (t) => {
  const f=fixture(t);f.state.host={...f.state.host,busy:true,cleanupPending:true};
  const snapshot=f.registry.snapshot();assert.equal(snapshot.busy,true);assert.equal(item(f.registry).canProbe,false);
  assert.match(item(f.registry).reason,/进程尚未确认停止/);
  await assert.rejects(f.probe(),{code:'BUSY'});assert.equal(f.calls.length,0);
  delete f.state.host.busy;delete f.state.host.cleanupPending;
  assert.equal(f.registry.snapshot().busy,false);assert.equal((await f.probe()).ok,true);
});
