import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DeviceBinding } from '../packages/phone-mcp/src/phone-device.js';
import { validateQqSendProfile, verifiedQqSession, qqContact, qqSendControls } from '../packages/phone-mcp/src/phone-identity.js';
import { transcribeCapturedAudio, audioStatusText } from '../packages/phone-mcp/src/phone-audio.js';
import { probeCaptureDuration, captureDurationText } from '../packages/phone-mcp/src/shared/media-probe.js';

const packageFile = process.env.PHONE_TEST_DEPENDENCY_ROOT
  ? path.join(path.resolve(process.env.PHONE_TEST_DEPENDENCY_ROOT), 'package.json')
  : fileURLToPath(new URL('../packages/phone-mcp/package.json', import.meta.url));
const dependencyRequire = createRequire(packageFile);
let dependencies;
try {
  dependencies = {
    ...dependencyRequire('@modelcontextprotocol/sdk/server/mcp.js'),
    ...dependencyRequire('@modelcontextprotocol/sdk/client/index.js'),
    ...dependencyRequire('@modelcontextprotocol/sdk/inMemory.js'),
    z: dependencyRequire('zod').z,
  };
} catch (error) {
  if (process.env.PHONE_TEST_DEPENDENCY_ROOT) throw error;
}

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-phone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Real SDK and real Zod, real tool registration and in-memory JSON-RPC validation.
// Only operating system processes, time delays and external services are fixtures.
async function fixture(t, { env = {}, command, record, transcribe } = {}) {
  const dir = directory(t), calls = [];
  const runtimeEnv = { PHONE_ADB: 'fixture-adb', PHONE_SHOT_DIR: path.join(dir, 'shots'), PHONE_MACRO_FILE: path.join(dir, 'macros.json'), ...env };
  const source = fs.readFileSync(new URL('../packages/phone-mcp/src/phone-mcp.js', import.meta.url), 'utf8')
    .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '')
    .replace('const execFileAsync = promisify(execFile);', '');
  const body = source.slice(0, source.lastIndexOf("if (process.argv.includes('--selftest'))"));
  const sandbox = {
    ...dependencies, fs, path, os: { ...os, homedir: () => dir }, Buffer,
    console: { error() {} }, DeviceBinding, validateQqSendProfile, verifiedQqSession, qqContact, qqSendControls, audioStatusText,
    process: { env: runtimeEnv, cwd: () => dir, argv: [] }, ncm: {},
    setTimeout: (callback) => { queueMicrotask(callback); return 0; },
    execFileAsync: async (bin, args) => {
      calls.push({ bin, args });
      if (command) {
        const value = await command(args, { dir, env: runtimeEnv });
        if (value !== undefined) return value;
      }
      if (args.includes('get-state')) return { stdout: 'device', stderr: '' };
      if (args.includes('devices')) return { stdout: 'List of devices attached\nfixture-device\tdevice\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    execFile: (bin, args, options, callback) => {
      calls.push({ bin, args });
      if (record) return record(bin, args, options, callback, dir);
      callback(new Error('fixture recorder unavailable'));
    },
    transcribeCapturedAudio: (file, options = {}) => transcribeCapturedAudio(file, {
      ...options, env: runtimeEnv, tempDir: path.join(dir, 'stt'),
      providerOptions: { runCommand: transcribe || (async () => { throw new Error('unconfigured fixture STT'); }) },
    }),
  };
  sandbox.probeCaptureDuration = (file, options) => probeCaptureDuration(file, { ...options, runCommand: sandbox.execFileAsync });
  sandbox.captureDurationText = captureDurationText;
  const server = await vm.runInNewContext(`(async () => { ${body}\nreturn server; })()`, sandbox);
  const [clientTransport, serverTransport] = dependencies.InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new dependencies.Client({ name: 'review-phone-fixture', version: '1' });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { dir, calls, client, server, env: runtimeEnv, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}

const sdkTest = dependencies ? test : (name) => test(name, { skip: 'Install project dependencies; alternatively set PHONE_TEST_DEPENDENCY_ROOT to an existing phone-mcp package' }, () => {});

sdkTest('real phone_connect schema requires an explicit numeric connection port and rejects invalid calls before ADB', async (t) => {
  const f = await fixture(t);
  const tool = (await f.client.listTools()).tools.find((item) => item.name === 'phone_connect');
  assert.ok(tool.inputSchema.required.includes('port'));
  assert.equal(tool.inputSchema.properties.port.default, undefined);
  assert.match(tool.description, /主页.*配对弹窗/);
  assert.match(tool.inputSchema.properties.port.description, /1–65535.*主页.*配对端口/);
  for (const port of [undefined, '', '0', '65536', '-1', '1.5', '1e3', ' 5555', '5555 ', '5555\n', '35315:1', 5555, null]) {
    const args = { host: '192.0.2.1', ...(port === undefined ? {} : { port }) };
    const result = await f.call('phone_connect', args);
    assert.equal(result.isError, true, `invalid port ${JSON.stringify(port)} must fail`);
    assert.match(result.content[0].text, /连接端口/);
    assert.equal(f.calls.length, 0, 'invalid and omitted ports must not invoke adb or select a device');
  }
});

sdkTest('real phone_connect forwards only the explicit validated port, including fixed 5555 and range boundaries', async (t) => {
  const f = await fixture(t, { command: (args) => {
    if (args[0] === 'connect') return { stdout: `connected to ${args[1]}`, stderr: '' };
    if (args.at(-1) === 'wm size') return { stdout: 'Physical size: 1080x2400', stderr: '' };
  } });
  for (const port of ['1', '35315', '5555', '65535']) {
    f.calls.length = 0;
    const result = await f.call('phone_connect', { host: '192.0.2.1', port });
    assert.equal(result.isError, undefined);
    assert.deepEqual(f.calls.map(({ args }) => Array.from(args)), [
      ['connect', `192.0.2.1:${port}`],
      ['-s', `192.0.2.1:${port}`, 'get-state'],
      ['-s', `192.0.2.1:${port}`, 'shell', 'wm size'],
    ]);
    assert.match(result.content[0].text, new RegExp(`192\\.0\\.2\\.1:${port}`));
  }
});

sdkTest('real MCP schema permits listing/saving/playing macros without artificial actions and rejects conflicting branches', async (t) => {
  const f = await fixture(t);
  const tool = (await f.client.listTools()).tools.find((item) => item.name === 'phone_macro');
  assert.ok(!(tool.inputSchema.required || []).includes('actions'));
  assert.equal((await f.call('phone_macro', { listMacros: true })).isError, undefined);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call('phone_macro', { saveAs: 'back_once', actions: [{ type: 'key', key: 'back' }] })).isError, undefined);
  assert.equal(f.calls.length, 0, 'local save must not require ADB');
  const invalid = await f.call('phone_macro', { actions: [{ type: 'key', key: 'back' }], listMacros: true });
  assert.equal(invalid.isError, true);
  assert.equal(f.calls.length, 0);
  const played = await f.call('phone_macro', { playName: 'back_once', screenshot: false });
  assert.equal(played.isError, undefined);
  assert.ok(f.calls.some(({ args }) => args.at(-1) === 'input keyevent 4'));
});

sdkTest('explicit device selection remains bound when offline and does not enumerate a fallback phone', async (t) => {
  const f = await fixture(t, { command: (args) => args.includes('get-state') ? { stdout: 'offline', stderr: '' } : undefined });
  await f.call('phone_devices', { use: 'selected-phone' });
  f.calls.length = 0;
  const result = await f.call('phone_tap', { x: 1, y: 2 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /selected-phone.*不在线/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Array.from(f.calls[0].args), ['-s', 'selected-phone', 'get-state']);
});

sdkTest('concurrent selection cannot move the rest of an in-flight macro onto another device', async (t) => {
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  let taps = 0;
  const f = await fixture(t, { env: { PHONE_SERIAL: 'phone-a' }, command: async (args) => {
    if (args.at(-1).startsWith('input tap') && ++taps === 1) { entered(); await barrier; }
  } });
  const macro = f.call('phone_macro', { actions: [{ type: 'tap', x: 1, y: 2 }, { type: 'tap', x: 3, y: 4 }], stepMs: 0, screenshot: false });
  await started;
  await f.call('phone_devices', { use: 'phone-b' });
  release();
  assert.equal((await macro).isError, undefined);
  const commands = f.calls.filter(({ args }) => args.at(-1).startsWith('input tap'));
  assert.equal(commands.length, 2);
  assert.ok(commands.every(({ args }) => args[0] === '-s' && args[1] === 'phone-a'));
});

const profile = {
  version: 1, recipientName: 'bound owner', recipientIdentity: 'QQ: fixture-owner',
  titleResourceId: 'com.tencent.mobileqq:id/chat_title', identityResourceId: 'com.tencent.mobileqq:id/chat_peer',
  editorResourceId: 'com.tencent.mobileqq:id/chat_editor', sendResourceId: 'com.tencent.mobileqq:id/chat_send',
  contactResourceId: 'com.tencent.mobileqq:id/contact_name',
};
const node = (id, text, klass = 'android.widget.TextView') => `<node package="com.tencent.mobileqq" resource-id="com.tencent.mobileqq:id/${id}" class="${klass}" text="${text}" enabled="true" bounds="[10,10][30,30]"/>`;

sdkTest('a same-name message bubble cannot authorize QQ sending, including an omitted target', async (t) => {
  const f = await fixture(t, { env: { PHONE_SERIAL: 'fixture-device' }, command: (args) => {
    const cmd = args.at(-1);
    if (cmd.includes('dumpsys window')) return { stdout: 'mCurrentFocus com.tencent.mobileqq/.ChatActivity', stderr: '' };
    if (cmd.includes('uiautomator dump')) return { stdout: node('chat_title', 'someone else') + node('chat_peer', 'QQ: other') + node('bubble', profile.recipientName) + node('chat_editor', '', 'android.widget.EditText') + node('chat_send', '发送'), stderr: '' };
  } });
  f.env.PHONE_QQ_SEND_PROFILE = path.join(f.dir, 'scope.json');
  fs.writeFileSync(f.env.PHONE_QQ_SEND_PROFILE, JSON.stringify(profile));
  for (const arguments_ of [{ message: 'hello', target: profile.recipientName }, { message: 'hello' }]) {
    assert.equal((await f.call('phone_qq_send', arguments_)).isError, true);
  }
  assert.ok(!f.calls.some(({ args }) => /input (tap|text)/.test(args.at(-1))));
});

sdkTest('verified QQ session and exact draft are required before clicking the configured send button', async (t) => {
  let draft = '';
  const f = await fixture(t, { env: { PHONE_SERIAL: 'fixture-device' }, command: (args) => {
    const cmd = args.at(-1);
    if (cmd.includes('dumpsys window')) return { stdout: 'mCurrentFocus com.tencent.mobileqq/.ChatActivity', stderr: '' };
    if (cmd.startsWith('input text')) draft = 'hello';
    if (cmd.includes('uiautomator dump')) return { stdout: node('chat_title', profile.recipientName) + node('chat_peer', profile.recipientIdentity) + node('chat_editor', draft, 'android.widget.EditText') + node('chat_send', '发送'), stderr: '' };
  } });
  f.env.PHONE_QQ_SEND_PROFILE = path.join(f.dir, 'scope.json');
  fs.writeFileSync(f.env.PHONE_QQ_SEND_PROFILE, JSON.stringify(profile));
  const result = await f.call('phone_qq_send', { message: 'hello' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /已验证会话/);
  assert.equal(f.calls.filter(({ args }) => args.at(-1) === 'input tap 20 20').length, 2);
});

sdkTest('scope filters tools, keys and listen duration at the actual MCP boundary', async (t) => {
  const f = await fixture(t, { env: { PHONE_ALLOWED_TOOLS: '["phone_key","phone_listen"]', PHONE_ALLOWED_KEYS: 'back', PHONE_MAX_LISTEN_SECONDS: '3', PHONE_SERIAL: 'fixture-device' } });
  const tools = (await f.client.listTools()).tools.map((item) => item.name).sort();
  assert.deepEqual(tools, ['phone_key', 'phone_listen']);
  assert.equal((await f.call('phone_key', { key: 'home' })).isError, true);
  assert.equal((await f.call('phone_listen', { seconds: 4 })).isError, true);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call('phone_key', { key: 'back' })).isError, undefined);
});

sdkTest('macros cannot bypass omitted action capabilities or take an unallowed screenshot', async (t) => {
  const f = await fixture(t, { env: { PHONE_ALLOWED_TOOLS: 'phone_macro,phone_key', PHONE_ALLOWED_KEYS: 'back', PHONE_SERIAL: 'fixture-device' } });
  for (const args of [
    { actions: [{ type: 'tap', x: 1, y: 2 }] },
    { actions: [{ type: 'text', text: 'hello' }], saveAs: 'forbidden' },
    { actions: [{ type: 'key', key: 'home' }], saveAs: 'wrong_key' },
    { actions: [{ type: 'key', key: 'back' }], screenshot: true },
  ]) assert.equal((await f.call('phone_macro', args)).isError, true);
  assert.equal(f.calls.length, 0, 'rejected plans must not reach ADB');
  assert.equal((await f.call('phone_macro', { actions: [{ type: 'key', key: 'back' }] })).isError, undefined);
  assert.ok(f.calls.some(({ args }) => args.at(-1) === 'input keyevent 4'));
  assert.ok(!f.calls.some(({ args }) => args.includes('pull') || args.some((value) => value.includes('screencap'))));
  fs.writeFileSync(f.env.PHONE_MACRO_FILE, JSON.stringify({ legacy_tap: { actions: [{ type: 'tap', x: 1, y: 2 }] } }));
  f.calls.length = 0;
  assert.equal((await f.call('phone_macro', { playName: 'legacy_tap' })).isError, true);
  assert.equal(f.calls.length, 0);
});

sdkTest('ADB launch failure cannot become an app-start success message', async (t) => {
  const f = await fixture(t, { env: { PHONE_SERIAL: 'fixture-device' }, command: (args) => {
    if (args.at(-1).startsWith('am start')) throw Object.assign(new Error('device offline'), { stderr: 'device offline' });
  } });
  const result = await f.call('phone_open_app', { pkg: 'com.example.app' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ADB 启动命令失败/);
});

const sttConfig = JSON.stringify({ type: 'command', command: 'fixture-stt', args: ['{audio}'] });
const recording = (bin, args, _options, callback) => {
  if (bin === 'scrcpy') {
    const file = args.find((value) => value.startsWith('--record=')).slice('--record='.length);
    fs.writeFileSync(file, Buffer.alloc(2048, 1));
  } else if (bin === 'ffmpeg') {
    fs.writeFileSync(args.at(-1).replace('%02d', '01'), 'fixture-frame');
  } else return callback(new Error('Unexpected process in fixture: ' + bin));
  callback(null, '', '');
};

sdkTest('listen and screen recording share explicit STT and distinguish capture from recognition', async (t) => {
  const f = await fixture(t, { env: { PHONE_SERIAL: 'fixture-device', PHONE_STT_CONFIG: sttConfig }, record: recording,
    transcribe: async (command, [audio]) => { assert.equal(command, 'fixture-stt'); assert.ok(fs.statSync(audio).size); return { stdout: 'fixture spoken words' }; } });
  for (const [tool, args] of [['phone_listen', { seconds: 1 }], ['phone_record_screen', { seconds: 1, frames: 2 }]]) {
    const result = await f.call(tool, args);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.capture.status, 'succeeded');
    assert.equal(result.structuredContent.transcription.status, 'succeeded');
    assert.equal(result.structuredContent.transcription.text, 'fixture spoken words');
  }
  delete f.env.PHONE_STT_CONFIG;
  const missing = await f.call('phone_listen', { seconds: 1 });
  assert.equal(missing.structuredContent.capture.status, 'succeeded');
  assert.equal(missing.structuredContent.transcription.status, 'not-configured');
  assert.equal(missing.structuredContent.transcription.text, undefined);
});

sdkTest('MCP cancellation reaches the recorder and prevents fallback recording or STT', async (t) => {
  for (const name of ['phone_listen', 'phone_record_screen']) {
    let started, stopped, recognitions = 0;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const stoppedPromise = new Promise((resolve) => { stopped = resolve; });
    const f = await fixture(t, { env: { PHONE_SERIAL: 'fixture-device', PHONE_STT_CONFIG: sttConfig },
      transcribe: async () => { recognitions++; return { stdout: 'must not run' }; },
      record: (bin, _args, options, callback) => {
        assert.equal(bin, 'scrcpy');
        assert.ok(options.signal);
        options.signal.addEventListener('abort', () => { callback(Object.assign(new Error('fixture aborted'), { name: 'AbortError' })); stopped(); }, { once: true });
        started();
      },
    });
    const controller = new AbortController();
    const pending = f.client.callTool({ name, arguments: { seconds: 1, ...(name === 'phone_record_screen' ? { frames: 2 } : {}) } }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(pending, /abort|cancel/i);
    await startedPromise;
    controller.abort(new Error('fixture cancelled'));
    await Promise.all([rejected, stoppedPromise]);
    assert.equal(recognitions, 0);
    assert.ok(!f.calls.some(({ args }) => args.some((value) => value.includes('screenrecord'))));
  }
});

test('audio provider failure remains a recognition failure while the recording stays available', async (t) => {
  const dir = directory(t), file = path.join(dir, 'audio.m4a');
  fs.writeFileSync(file, 'fixture audio');
  const result = await transcribeCapturedAudio(file, { env: {}, sttProvider: async () => { throw new Error('fixture recognizer failed'); }, tempDir: path.join(dir, 'stt') });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /fixture recognizer failed/);
  assert.ok(fs.existsSync(file));
});

test('phone-mcp bin has a Node interpreter and executable mode', () => {
  const file = new URL('../packages/phone-mcp/src/phone-mcp.js', import.meta.url);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node\n'));
  if (process.platform !== 'win32') assert.ok(fs.statSync(file).mode & 0o111);
});
