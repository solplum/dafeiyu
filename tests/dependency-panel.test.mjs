import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DependencyPanel, DependencyPanelError } from '../packages/dsh-dafeiyu/src/dependency-panel.js';

const SECRET = 'PRIVATE_DEPENDENCY_OUTPUT_SENTINEL';
const OLD = `mlikiowa/napcat-docker:v4.18.40@sha256:${'a'.repeat(64)}`;
const NEW = `mlikiowa/napcat-docker:v4.18.41@sha256:${'b'.repeat(64)}`;
const CONTAINER = 'c'.repeat(64);
const response = (value) => new Response(typeof value === 'string' ? value : JSON.stringify(value));

function fixture(t, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-panel-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const relative of ['data/qq', 'data/config', 'data/plugins', 'tools/cli-plugins']) fs.mkdirSync(path.join(directory, relative), { recursive: true });
  for (const name of ['tools/docker', 'tools/cli-plugins/docker-compose']) fs.writeFileSync(path.join(directory, name), 'fixture do not execute', { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'data/config/webui.json'), JSON.stringify({ token: SECRET }), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'data/qq/login.keep'), SECRET);
  const compose = { name: 'fixture-qq', services: { napcat: {
    image: OLD, platform: 'linux/arm64', container_name: 'fixture-napcat', restart: 'unless-stopped',
    environment: { ACCOUNT: '456', MODE: 'ws', NAPCAT_UID: '501', NAPCAT_GID: '20' },
    ports: ['127.0.0.1:6099:6099', '127.0.0.1:3001:3001'],
    volumes: ['./data/qq:/app/.config/QQ', './data/config:/app/napcat/config', './data/plugins:/app/napcat/plugins'],
  } } };
  fs.writeFileSync(path.join(directory, 'compose.yaml'), JSON.stringify(compose), { mode: 0o600 });
  const state = { commands: [], requests: [], authorized: true, running: true, imageInstalled: true,
    healthFail: false, statusCalls: 0, failUp: false, hooks: {}, runtime: {
      voiceProcessor: { sttProvider: () => {} }, nativeOneBot: { status: { pending: 0 } },
    }, config: { voiceTranscription: true }, busy: false };
  const execFileImpl = async (file, args, opts) => {
    state.commands.push({ file, args });
    assert.ok(opts.signal instanceof AbortSignal); assert.equal(typeof opts.timeout, 'number');
    assert.equal(opts.encoding, 'utf8'); assert.ok(opts.maxBuffer <= 1024 * 1024);
    assert.equal(opts.env.DOCKER_CONTEXT, undefined); assert.equal(opts.env.DOCKER_TLS_VERIFY, undefined);
    await state.hooks.command?.(file, args);
    if (file.endsWith('/docker-compose')) {
      assert.equal(opts.cwd, directory);
      assert.deepEqual(args.slice(0, 4), ['--project-directory', directory, '-f', path.join(directory, 'compose.yaml')]);
      const operation = args[4];
      if (operation === 'stop') { state.running = false; return { stdout: '', stderr: SECRET }; }
      assert.deepEqual(args.slice(4), ['up', '-d', '--pull', 'never', '--no-build']);
      if (state.failUp) { state.failUp = false; throw new Error(SECRET); }
      state.running = true; return { stdout: SECRET, stderr: SECRET };
    }
    if (file.endsWith('/docker')) {
      assert.equal(args[0], '--host'); assert.equal(args[1].startsWith('unix://'), true);
      if (args[2] === 'version') return { stdout: '"29.8.2"', stderr: SECRET };
      if (args[2] === 'inspect') return { stdout: JSON.stringify({ id: CONTAINER,
        image: JSON.parse(fs.readFileSync(path.join(directory, 'compose.yaml'))).services.napcat.image,
        state: state.running ? 'running' : 'exited', paused: false, restarting: false,
        project: 'fixture-qq', service: 'napcat', workingDir: directory,
        mounts: [['data/qq', '/app/.config/QQ'], ['data/config', '/app/napcat/config'], ['data/plugins', '/app/napcat/plugins']]
          .map(([source, target]) => ({ Type: 'bind', Source: path.join(directory, source), Destination: target, RW: true })),
        ...state.inspectPatch }), stderr: SECRET };
      if (args[2] === 'restart') {
        assert.deepEqual(args.slice(2), ['restart', '--time', '15', CONTAINER]);
        if (state.restartFails) throw new Error(SECRET);
        state.running = true; return { stdout: SECRET, stderr: SECRET };
      }
      if (args[2] === 'exec') {
        assert.deepEqual(args.slice(2), ['exec', CONTAINER, 'dpkg-query', '-W', '-f=${Version}', 'linuxqq']);
        return { stdout: '3.2.34-53644', stderr: SECRET };
      }
      if (args[2] === 'pull') {
        assert.deepEqual(args.slice(2, 5), ['pull', '--platform', 'linux/arm64']);
        assert.ok([OLD, NEW].includes(args[5])); return { stdout: SECRET, stderr: SECRET };
      }
      if (args[2] === 'image') {
        if (!state.imageInstalled) throw new Error(SECRET);
        return { stdout: CONTAINER, stderr: SECRET };
      }
      assert.fail(`Unexpected Docker command ${args[2]}`);
    }
    // Version only; an inventory must never access a phone, record, send, or synthesize.
    assert.ok([['-version'], ['--version'], ['version']].some((expected) => JSON.stringify(args) === JSON.stringify(expected)));
    if (file.endsWith('/ffmpeg')) return { stdout: 'ffmpeg version 9.0.1 Copyright', stderr: SECRET };
    if (file.endsWith('/ffprobe')) return { stdout: 'ffprobe version 9.0.1 Copyright', stderr: SECRET };
    if (file.endsWith('/scrcpy')) return { stdout: 'scrcpy 5.0.0', stderr: SECRET };
    if (file.endsWith('/adb')) return { stdout: 'Android Debug Bridge version 1.0.41\nVersion 37.0.1-12345678', stderr: SECRET };
    if (file.endsWith('/orbctl')) return { stdout: 'OrbStack 2.2.4', stderr: SECRET };
    throw new Error(SECRET);
  };
  const fetchImpl = async (url, opts) => {
    state.requests.push(url); assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers.Authorization, undefined);
    await state.hooks.request?.(url);
    if (state.metadataFail) throw new Error(SECRET);
    if (url.endsWith('/NapCatQQ/releases/latest')) return response({ tag_name: state.invalidTag || 'v4.18.41', draft: false, prerelease: false });
    if (url.includes('hub.docker.com/')) return response({ name: 'v4.18.41', digest: state.invalidDigest || `sha256:${'b'.repeat(64)}`,
      images: [{ os: 'linux', architecture: state.wrongArch ? 'amd64' : 'arm64', digest: `sha256:${'b'.repeat(64)}` }] });
    if (url.endsWith('/Dockerfile')) return response('RUN curl -o linuxqq.deb "https://qqdl.gtimg.cn/qqfile/QQNT/beta/linuxqq_3.2.34-53644_${arch}.deb"');
    if (url.endsWith('/formula/ffmpeg.json')) return response({ versions: { stable: '9.0.2' } });
    if (url.endsWith('/formula/scrcpy.json')) return response({ versions: { stable: '5.0.1' } });
    if (url.endsWith('/cask/android-platform-tools.json')) return response({ version: '37.0.1' });
    if (url.endsWith('/cask/orbstack.json')) return response({ version: '2.2.5' });
    assert.fail(`Unexpected public URL ${url}`);
  };
  const napcatPanel = { status: async () => {
    state.statusCalls++; await state.hooks.status?.();
    return { container: { running: state.running }, webui: { authenticated: !state.healthFail, reachable: !state.healthFail },
      login: { isLogin: state.loggedIn !== false, phase: state.loggedIn === false ? 'waiting_qrcode' : 'ready',
        selfMatches: state.loggedIn === false ? null : true } };
  } };
  const panel = new DependencyPanel({ deploymentDir: directory, platform: 'linux', arch: 'arm64',
    getRuntime: () => state.runtime, getConfig: () => state.config, getBusy: () => state.busy,
    execFileImpl, fetchImpl, napcatPanel, delayImpl: async () => {}, ...options });
  t.after(() => panel.dispose());
  return { panel, state, directory, compose, authorize: () => state.authorized };
}

function item(snapshot, id) { return snapshot.items.find((entry) => entry.id === id); }
function privateDataAbsent(value) { assert.equal(JSON.stringify(value).includes(SECRET), false); }

test('unconfirmed management and login reads do not claim Linux QQ is offline or recommend scanning', async (t) => {
  for (const status of [undefined,
    { container: { running: true }, webui: { reachable: true, authenticated: false },
      login: { isLogin: null, isOffline: null, phase: 'unknown', selfMatches: null }, code: 'WEBUI_AUTH_REJECTED', error: '管理认证未确认' },
    { container: { running: true }, webui: { reachable: true, authenticated: true },
      login: { isLogin: null, phase: 'unknown', selfMatches: null }, code: 'WEBUI_REJECTED', error: '状态读取未确认' },
    { container: { running: true }, webui: { reachable: true, authenticated: true },
      login: { isLogin: true, selfMatches: true }, code: 'WEBUI_REQUEST_FAILED', error: '身份读取未完成' }]) {
    const f = fixture(t, { napcatPanel: { status: async () => status } });
    const value = await f.panel.check(); privateDataAbsent(value);
    const qq = item(value, 'linux-qq');
    assert.equal(qq.health, 'not-verified');
    assert.match(qq.note, /尚未确认|未完成/);
    assert.doesNotMatch(qq.note, /扫码|已离线/);
    assert.equal(f.state.commands.some(({ args }) => ['restart', 'pull', 'stop'].includes(args[2])), false);
  }
});

test('recovery and accepted-login phases remain unverified while explicit waiting or offline phases retain their meaning', async (t) => {
  for (const phase of ['reconnecting', 'qrcode_scanned', 'initializing', 'unknown', 'waiting_qrcode', 'generating_qrcode', 'offline']) {
    const f = fixture(t, { napcatPanel: { status: async () => ({ container: { running: true },
      webui: { reachable: true, authenticated: true }, login: { isLogin: false, selfMatches: null, phase } }) } });
    const value = await f.panel.check(); privateDataAbsent(value);
    const qq = item(value, 'linux-qq');
    const definite = ['waiting_qrcode', 'generating_qrcode', 'offline'].includes(phase);
    assert.equal(qq.health, definite ? 'offline' : 'not-verified', phase);
    assert.doesNotMatch(qq.note, /扫码/);
    if (phase === 'reconnecting') assert.match(qq.note, /正在恢复.*等待更新/);
    if (['qrcode_scanned', 'initializing'].includes(phase)) assert.match(qq.note, /确认或准备.*等待状态更新/);
    assert.equal(f.state.commands.some(({ args }) => ['restart', 'pull', 'stop'].includes(args[2])), false);
  }
  for (const phase of ['reconnecting', 'qrcode_scanned', 'initializing']) {
    const f = fixture(t, { napcatPanel: { status: async () => ({ container: { running: true },
      webui: { reachable: true, authenticated: true }, login: { isLogin: true, selfMatches: true, phase } }) } });
    assert.equal(item(await f.panel.check(), 'linux-qq').health, 'not-verified',
      'transitional evidence does not certify stable login readiness');
  }
});

test('snapshot is passive and starts unknown; no network, commands, phone or model work', (t) => {
  const f = fixture(t), result = f.panel.snapshot(); privateDataAbsent(result);
  assert.equal(result.checkedAt, null); assert.equal(result.busy, false);
  assert.equal(result.items.length, 11); assert.ok(result.items.every((entry) => entry.installed === null));
  assert.equal(f.state.commands.length, 0); assert.equal(f.state.requests.length, 0);
  assert.ok(result.items.filter((entry) => ['napcat', 'linux-qq'].includes(entry.id))
    .every((entry) => entry.actions.find((action) => action.id === 'restart').enabled === false));
});

test('explicit QQ recovery restarts the verified existing container once, preserves image and all data, and does not claim QQ login', async (t) => {
  let maintenance = false, acquired = 0, released = 0;
  const f = fixture(t, { acquireMaintenance: () => {
    acquired++; maintenance = true;
    return () => { released++; maintenance = false; };
  } });
  f.state.loggedIn = false;
  const before = await f.panel.check();
  for (const id of ['napcat', 'linux-qq']) assert.equal(item(before, id).actions.find((action) => action.id === 'restart').enabled, true);
  const files = ['compose.yaml', 'data/qq/login.keep', 'data/config/webui.json'];
  fs.writeFileSync(path.join(f.directory, 'data/plugins/plugin.keep'), SECRET);
  files.push('data/plugins/plugin.keep');
  const bytes = files.map((file) => fs.readFileSync(path.join(f.directory, file)));
  const startAt = f.state.commands.length;
  f.state.hooks.command = (_file, args) => { if (args[2] === 'restart') assert.equal(maintenance, true); };
  const accepted = await f.panel.action({ id: 'napcat', action: 'restart' }, { authorize: f.authorize });
  assert.equal(accepted.accepted, true);
  assert.equal(f.panel.snapshot().items.find((entry) => entry.id === 'napcat').actions.find((action) => action.id === 'restart').enabled, false);
  await assert.rejects(f.panel.action({ id: 'linux-qq', action: 'restart' }, { authorize: f.authorize }), { code: 'BUSY' });
  const result = await f.panel.settled(); privateDataAbsent(result);
  assert.equal(result.job.state, 'succeeded'); assert.equal(result.busy, false);
  assert.equal(item(result, 'napcat').health, 'ready'); assert.equal(item(result, 'linux-qq').health, 'offline');
  assert.match(result.job.message, /核实.*QQ 登录/);
  const operations = f.state.commands.slice(startAt);
  assert.equal(operations.filter(({ args }) => args[2] === 'restart').length, 1);
  assert.ok(operations.every(({ file, args }) => !file.endsWith('/docker-compose') && !args.includes('pull')));
  assert.equal(f.state.requests.length, 0);
  files.forEach((file, at) => assert.deepEqual(fs.readFileSync(path.join(f.directory, file)), bytes[at]));
  assert.equal(fs.existsSync(path.join(f.directory, 'backups')), false);
  assert.equal(acquired, 1); assert.equal(released, 1); assert.equal(maintenance, false);
});

test('QQ restart revalidates account authorization, busy state and managed container identity before mutation', async (t) => {
  for (const mode of ['busy', 'pending', 'maintenance', 'revoked', 'late-busy', 'identity', 'project', 'service', 'directory', 'image', 'mount', 'paused', 'stopped']) {
    let acquired = 0, released = 0;
    const f = fixture(t, { acquireMaintenance: () => {
      acquired++; return mode === 'maintenance' ? null : () => { released++; };
    } });
    await f.panel.check();
    if (mode === 'busy') f.state.busy = true;
    if (mode === 'pending') f.state.runtime.nativeOneBot.status.pending = 1;
    if (mode === 'revoked' || mode === 'late-busy') f.state.hooks.command = (_file, args) => {
      if (args[2] === 'inspect') { if (mode === 'revoked') f.state.authorized = false; else f.state.busy = true; }
    };
    const patch = { identity: { id: 'not-a-container-id' }, project: { project: 'another-project' }, service: { service: 'other' },
      directory: { workingDir: '/' }, image: { image: NEW }, mount: { mounts: [] }, paused: { paused: true } }[mode];
    if (patch) f.state.inspectPatch = patch;
    if (mode === 'stopped') f.state.running = false;
    await f.panel.action({ id: 'napcat', action: 'restart' }, { authorize: f.authorize });
    const result = await f.panel.settled(); privateDataAbsent(result);
    assert.equal(result.job.state, 'failed', mode);
    assert.ok(!f.state.commands.some(({ args }) => args[2] === 'restart'), mode);
    assert.equal(released, mode === 'busy' || mode === 'pending' || mode === 'maintenance' ? 0 : acquired, mode);
  }
  const f = fixture(t);
  await assert.rejects(f.panel.action({ id: 'napcat', action: 'restart' }), { code: 'FORBIDDEN' });
  await assert.rejects(f.panel.action({ id: 'adb', action: 'restart' }, { authorize: f.authorize }), { code: 'UNSUPPORTED' });
  await assert.rejects(f.panel.action({ id: 'napcat', action: 'restart', container: 'other' }, { authorize: f.authorize }), { code: 'INVALID_PATCH' });
  assert.equal(f.state.commands.length, 0);
});

test('failed QQ restart or health reports failure once without pulling, recreating or clearing data', async (t) => {
  for (const failure of ['command', 'health', 'identity']) {
    let acquired = 0, released = 0;
    const f = fixture(t, { acquireMaintenance: () => { acquired++; return () => { released++; }; } });
    await f.panel.check();
    if (failure === 'command') f.state.restartFails = true;
    if (failure === 'health') f.state.healthFail = true;
    if (failure === 'identity') f.state.hooks.status = () => { f.state.inspectPatch = { id: 'd'.repeat(64) }; };
    await f.panel.action({ id: 'linux-qq', action: 'restart' }, { authorize: f.authorize });
    const result = await f.panel.settled(); privateDataAbsent(result);
    assert.equal(result.job.state, 'failed');
    assert.equal(result.job.code, { command: 'RESTART_FAILED', health: 'HEALTH_FAILED', identity: 'CONTAINER_MISMATCH' }[failure]);
    assert.equal(f.state.commands.filter(({ args }) => args[2] === 'restart').length, 1);
    assert.ok(f.state.commands.every(({ file, args }) => !file.endsWith('/docker-compose') && !args.includes('pull')));
    assert.equal(fs.readFileSync(path.join(f.directory, 'data/qq/login.keep'), 'utf8'), SECRET);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'compose.yaml'))).services.napcat.image, OLD);
    assert.equal(acquired, 1); assert.equal(released, 1);
  }
});

test('closing before verified restart prevents mutation; closing during restart waits for bounded health before release', async (t) => {
  for (const at of ['inspect', 'restart']) {
    const f = fixture(t);
    await f.panel.check();
    let closing;
    f.state.hooks.command = (_file, args) => { if (args[2] === at && !closing) closing = f.panel.dispose(); };
    await f.panel.action({ id: 'napcat', action: 'restart' }, { authorize: f.authorize });
    const result = await f.panel.settled(); await closing;
    assert.equal(f.state.commands.filter(({ args }) => args[2] === 'restart').length, at === 'restart' ? 1 : 0);
    assert.equal(result.job.state, at === 'restart' ? 'succeeded' : 'failed');
    await assert.rejects(f.panel.check(), { code: 'UNAVAILABLE' });
  }
});

test('explicit local check separates actual Linux QQ package version, NapCat release, login and voice readiness', async (t) => {
  const f = fixture(t), result = await f.panel.check(); privateDataAbsent(result);
  assert.equal(item(result, 'napcat').currentVersion, '4.18.40');
  assert.equal(item(result, 'linux-qq').currentVersion, '3.2.34-53644');
  assert.equal(item(result, 'linux-qq').health, 'ready');
  assert.equal(item(result, 'linux-qq').actions.find((entry) => entry.id === 'start').enabled, false);
  assert.equal(item(result, 'docker').currentVersion, '29.8.2');
  assert.equal(item(result, 'voice-send').health, 'unsupported');
  assert.notEqual(item(result, 'voice-receive').health, 'ready');
  assert.equal(f.state.requests.length, 0);
  assert.ok(f.state.commands.every(({ args }) => !args.includes('devices') && !args.includes('connect') && !args.includes('shell')));
});

test('official update detection checks release, exact image digest and platform before offering update', async (t) => {
  const f = fixture(t), result = await f.panel.check({ updates: true }); privateDataAbsent(result);
  assert.equal(item(result, 'napcat').latestVersion, '4.18.41'); assert.equal(item(result, 'napcat').updateState, 'available');
  assert.equal(item(result, 'linux-qq').latestVersion, '3.2.34-53644');
  assert.equal(item(result, 'linux-qq').updateState, 'up-to-date');
  assert.match(item(result, 'linux-qq').note, /构建配方/);
  assert.ok(item(result, 'napcat').actions.find((entry) => entry.id === 'update').enabled);
  assert.ok(result.updatesCheckedAt); assert.ok(f.state.requests.every((url) => url.startsWith('https://')));
});

test('missing deployment or Docker tool cannot certify that NapCat is current', async (t) => {
  for (const missing of ['compose.yaml', 'tools/docker']) {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.directory, missing));
    const result = await f.panel.check({ updates: true }); privateDataAbsent(result);
    assert.equal(item(result, 'napcat').installed, null);
    assert.equal(item(result, 'napcat').currentVersion, null);
    assert.equal(item(result, 'napcat').latestVersion, '4.18.41');
    assert.equal(item(result, 'napcat').updateState, 'unknown');
    if (missing === 'tools/docker') {
      assert.equal(item(result, 'docker').installed, false);
      assert.equal(item(result, 'docker').health, 'missing');
      assert.match(item(result, 'docker').note, /工具尚未安装/);
    } else assert.equal(item(result, 'docker').installed, null);
    assert.ok(!f.state.commands.some(({ file }) => file.endsWith('/docker')));
  }
});

test('cached latest image cannot keep a current or available label after installation becomes unconfirmed', async (t) => {
  const f = fixture(t);
  const initial = await f.panel.check({ updates: true });
  assert.equal(item(initial, 'napcat').updateState, 'available');
  fs.unlinkSync(path.join(f.directory, 'compose.yaml'));
  const unchecked = await f.panel.check();
  assert.equal(item(unchecked, 'napcat').latestVersion, '4.18.41');
  assert.equal(item(unchecked, 'napcat').installed, null);
  assert.equal(item(unchecked, 'napcat').updateState, 'unknown');
});

test('invalid latest tag, digest, architecture and metadata errors do not become install targets', async (t) => {
  for (const key of ['invalidTag', 'invalidDigest', 'wrongArch', 'metadataFail']) {
    const f = fixture(t); f.state[key] = key === 'invalidTag' ? 'latest;$(private)' : key === 'invalidDigest' ? SECRET : true;
    const result = await f.panel.check({ updates: true }); privateDataAbsent(result);
    assert.equal(item(result, 'napcat').latestVersion, null);
    assert.equal(item(result, 'napcat').updateState, 'unknown');
    const action = await f.panel.action({ id: 'napcat', action: 'update' }, { authorize: f.authorize });
    assert.equal(action.accepted, true);
    const settled = await f.panel.settled(); privateDataAbsent(settled);
    assert.equal(settled.job.state, 'failed'); assert.equal(settled.job.code, 'CHECK_REQUIRED');
    assert.ok(!f.state.commands.some(({ args }) => args.includes('pull') || args.includes('stop')));
  }
});

test('download URLs are fixed; unknown ids, caller paths and unauthenticated actions are rejected', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.panel.action({ id: 'ffmpeg', action: 'download' }), (error) => error.code === 'FORBIDDEN');
  for (const body of [{ id: 'bad', action: 'install' }, { id: 'ffmpeg', action: 'install', command: 'malicious' },
    { id: 'napcat', action: 'update', image: 'other/repo:latest' }, { id: 'voice-send', action: 'install' }]) {
    await assert.rejects(f.panel.action(body, { authorize: f.authorize }), (error) => error instanceof DependencyPanelError);
  }
  const download = await f.panel.action({ id: 'orbstack', action: 'update' }, { authorize: f.authorize });
  assert.equal(download.downloadUrl, 'https://orbstack.dev/download'); assert.equal(f.state.commands.length, 0);
});

test('container update is a polled job, backs up private configuration and preserves login and mounts', async (t) => {
  const f = fixture(t); await f.panel.check({ updates: true });
  const accepted = await f.panel.action({ id: 'linux-qq', action: 'update' }, { authorize: f.authorize });
  assert.equal(accepted.accepted, true); assert.equal(accepted.job.state, 'running');
  const result = await f.panel.settled(); privateDataAbsent(result);
  assert.equal(result.job.state, 'succeeded'); assert.equal(result.busy, false);
  assert.equal(item(result, 'napcat').updateState, 'up-to-date');
  const updated = JSON.parse(fs.readFileSync(path.join(f.directory, 'compose.yaml')));
  assert.equal(updated.services.napcat.image, NEW);
  assert.deepEqual(updated.services.napcat.volumes, f.compose.services.napcat.volumes);
  assert.equal(fs.readFileSync(path.join(f.directory, 'data/qq/login.keep'), 'utf8'), SECRET);
  const backups = fs.readdirSync(path.join(f.directory, 'backups')); assert.equal(backups.length, 1);
  const backup = path.join(f.directory, 'backups', backups[0]);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(backup, 'config/webui.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'compose.yaml'))).services.napcat.image, OLD);
  assert.equal(fs.existsSync(path.join(backup, 'qq')), false, 'private chat/login data is not duplicated');
  assert.ok(f.state.commands.find(({ args }) => args.includes('pull')).args.includes(NEW));
});

test('failed start after update rolls back old image and private configuration', async (t) => {
  const f = fixture(t); await f.panel.check({ updates: true }); f.state.failUp = true;
  const originalBytes = fs.readFileSync(path.join(f.directory, 'compose.yaml'));
  await f.panel.action({ id: 'napcat', action: 'update' }, { authorize: f.authorize });
  const result = await f.panel.settled(); privateDataAbsent(result);
  assert.equal(result.job.state, 'failed'); assert.equal(result.job.code, 'UPDATE_FAILED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'compose.yaml'))).services.napcat.image, OLD);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'compose.yaml')), originalBytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'data/config/webui.json'))).token, SECRET);
  assert.equal(f.state.running, true);
});

test('failed management health triggers rollback instead of declaring installed or usable', async (t) => {
  const f = fixture(t); await f.panel.check({ updates: true }); f.state.healthFail = true;
  await f.panel.action({ id: 'napcat', action: 'update' }, { authorize: f.authorize });
  const result = await f.panel.settled(); privateDataAbsent(result);
  assert.equal(result.job.state, 'failed'); assert.equal(result.job.code, 'HEALTH_FAILED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'compose.yaml'))).services.napcat.image, OLD);
});

test('revoked owner during image download never stops or replaces a working QQ', async (t) => {
  const f = fixture(t); await f.panel.check({ updates: true });
  f.state.hooks.command = (_file, args) => { if (args.includes('pull')) f.state.authorized = false; };
  await f.panel.action({ id: 'napcat', action: 'update' }, { authorize: f.authorize });
  const result = await f.panel.settled(); privateDataAbsent(result);
  assert.equal(result.job.code, 'FORBIDDEN');
  assert.ok(!f.state.commands.some(({ args }) => args.includes('stop')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'compose.yaml'))).services.napcat.image, OLD);
});

test('revoked owner after stop restores old QQ; no new update is continued', async (t) => {
  const f = fixture(t); await f.panel.check({ updates: true });
  f.state.hooks.command = (_file, args) => { if (args[4] === 'stop') f.state.authorized = false; };
  await f.panel.action({ id: 'napcat', action: 'update' }, { authorize: f.authorize });
  const result = await f.panel.settled(); privateDataAbsent(result);
  assert.equal(result.job.code, 'FORBIDDEN'); assert.equal(f.state.running, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'compose.yaml'))).services.napcat.image, OLD);
});

test('busy runtime and untrusted compose layouts prevent destructive actions', async (t) => {
  for (const mode of ['busy', 'pending', 'mount', 'privileged']) {
    const f = fixture(t); await f.panel.check({ updates: true });
    if (mode === 'busy') f.state.busy = true;
    if (mode === 'pending') f.state.runtime.nativeOneBot.status.pending = 1;
    if (mode === 'mount' || mode === 'privileged') {
      const compose = JSON.parse(fs.readFileSync(path.join(f.directory, 'compose.yaml')));
      if (mode === 'mount') compose.services.napcat.volumes.push('/:/host'); else compose.services.napcat.privileged = true;
      fs.writeFileSync(path.join(f.directory, 'compose.yaml'), JSON.stringify(compose));
    }
    await f.panel.action({ id: 'napcat', action: 'update' }, { authorize: f.authorize });
    const result = await f.panel.settled(); privateDataAbsent(result);
    assert.equal(result.job.state, 'failed'); assert.ok(!f.state.commands.some(({ args }) => args.includes('pull') || args.includes('stop')));
  }
});

test('closing during a stopped-container transaction rolls back before disposing', async (t) => {
  const f = fixture(t); await f.panel.check({ updates: true });
  let dispose;
  f.state.hooks.command = (_file, args) => { if (args[4] === 'stop' && !dispose) dispose = f.panel.dispose(); };
  await f.panel.action({ id: 'napcat', action: 'update' }, { authorize: f.authorize });
  const result = await f.panel.settled(); await dispose;
  assert.equal(result.job.state, 'failed'); assert.equal(f.state.running, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'compose.yaml'))).services.napcat.image, OLD);
  await assert.rejects(f.panel.check(), (error) => error.code === 'UNAVAILABLE');
});

test('already-current image does not pull or interrupt QQ; unavailable voice services stay unverified', async (t) => {
  const f = fixture(t); f.compose.services.napcat.image = NEW;
  fs.writeFileSync(path.join(f.directory, 'compose.yaml'), JSON.stringify(f.compose));
  f.state.runtime.voiceOutput = { status: () => ({ supported: true, configured: true, enabled: false }) };
  const checked = await f.panel.check({ updates: true });
  assert.equal(item(checked, 'voice-send').health, 'offline'); assert.equal(item(checked, 'voice-send').installed, true);
  await f.panel.action({ id: 'napcat', action: 'update' }, { authorize: f.authorize });
  const result = await f.panel.settled(); assert.equal(result.job.state, 'succeeded');
  assert.ok(!f.state.commands.some(({ args }) => args.includes('pull') || args.includes('stop')));
});

test('maintenance is acquired after download, blocks message admission during replacement and is always released', async (t) => {
  for (const failUp of [false, true]) {
    let maintenance = false, acquired = 0, released = 0;
    const f = fixture(t, { acquireMaintenance: () => {
      acquired++; maintenance = true;
      return () => { released++; maintenance = false; };
    } });
    await f.panel.check({ updates: true }); f.state.failUp = failUp;
    f.state.hooks.command = (_file, args) => {
      if (args.includes('pull')) assert.equal(maintenance, false, 'download does not pause QQ');
      if (args[4] === 'stop' || args[4] === 'up') assert.equal(maintenance, true, 'replacement and rollback hold the maintenance gate');
    };
    await f.panel.action({ id: 'napcat', action: 'update' }, { authorize: f.authorize });
    const result = await f.panel.settled();
    assert.equal(result.job.state, failUp ? 'failed' : 'succeeded');
    assert.equal(acquired, 1); assert.equal(released, 1); assert.equal(maintenance, false);
  }
});

test('a failed maintenance acquisition never stops QQ even after the new image has downloaded', async (t) => {
  const f = fixture(t, { acquireMaintenance: () => null }); await f.panel.check({ updates: true });
  await f.panel.action({ id: 'napcat', action: 'update' }, { authorize: f.authorize });
  const result = await f.panel.settled(); assert.equal(result.job.code, 'BUSY');
  assert.ok(f.state.commands.some(({ args }) => args.includes('pull')));
  assert.ok(!f.state.commands.some(({ args }) => args.includes('stop')));
  assert.equal(f.state.running, true);
});

test('voice send readiness requires enabled support plus a successful actual delivery result', async (t) => {
  const f = fixture(t);
  f.state.runtime.voiceOutput = { status: () => ({ supported: true, configured: true, enabled: true, readiness: 'ready' }) };
  let snapshot = await f.panel.check(); assert.notEqual(item(snapshot, 'voice-send').health, 'ready');
  f.state.runtime.voiceOutput.status = () => ({ supported: true, configured: true, enabled: true, readiness: 'ready', lastResult: { delivered: true } });
  snapshot = await f.panel.check(); assert.equal(item(snapshot, 'voice-send').health, 'ready');
  assert.match(item(snapshot, 'voice-send').note, /实际成功回执/);
});

test('an update check arriving during a local-only check still refreshes upstream metadata', async (t) => {
  const f = fixture(t); await f.panel.check({ updates: true });
  const previousRequests = f.state.requests.length;
  let release, entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let blockedOnce = false;
  f.state.hooks.command = async (file, args) => {
    if (file.endsWith('/docker') && args[2] === 'version' && !blockedOnce) { blockedOnce = true; entered(); await blocked; }
  };
  const local = f.panel.check(); await started;
  const updates = f.panel.check({ updates: true }); release();
  await Promise.all([local, updates]);
  assert.ok(f.state.requests.length > previousRequests);
});

test('an existing speech provider with unprepared selected resources is blocked, not absent or end-to-end ready', async (t) => {
  let ready = false;
  const f = fixture(t, { getVoiceStatus: () => ({ receiveConfigured: true, receiveReady: ready }) });
  let snapshot = await f.panel.check();
  assert.equal(item(snapshot, 'voice-receive').installed, true);
  assert.equal(item(snapshot, 'voice-receive').health, 'blocked');
  assert.match(item(snapshot, 'voice-receive').note, /识别服务已存在.*所选模型资源尚未准备/);
  ready = true; snapshot = await f.panel.check();
  assert.equal(item(snapshot, 'voice-receive').installed, true);
  assert.notEqual(item(snapshot, 'voice-receive').health, 'blocked');
  assert.notEqual(item(snapshot, 'voice-receive').health, 'ready', 'prepared resources still do not prove a real QQ speech transcription');
  assert.doesNotMatch(item(snapshot, 'voice-receive').note, /资源尚未准备/);
});
