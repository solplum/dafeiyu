import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { PhoneTools } from '../packages/dsh-dafeiyu/src/phone-tools.js';
import { VoiceProcessor } from '../packages/dsh-dafeiyu/src/voice-processor.js';
import { MemeManager } from '../packages/dsh-dafeiyu/src/meme-manager.js';
import { DeviceBinding } from '../packages/phone-mcp/src/phone-device.js';
import { validateQqSendProfile, verifiedQqSession, qqContact, qqSendControls } from '../packages/phone-mcp/src/phone-identity.js';
import { transcribeCapturedAudio, audioStatusText } from '../packages/phone-mcp/src/phone-audio.js';
import { probeCaptureDuration, captureDurationText } from '../packages/phone-mcp/src/shared/media-probe.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function phone(t, runCommand) {
  return new PhoneTools({ device: 'fixture-device', enabled: true, getExecutionContext: () => ({ isOwner: true, scope: 'c2c' }), shotDir: fixture(t), runCommand });
}

test('recording failure is reported, successful recording has a real file and makes no transcription claim', async (t) => {
  const unavailable = phone(t, async () => { throw new Error('scrcpy unavailable'); });
  assert.equal((await unavailable.listen(1)).ok, false);
  const recorder = phone(t, async (bin, args) => {
    assert.equal(bin, 'scrcpy');
    assert.ok(args.includes('--require-audio'));
    fs.writeFileSync(args.find((arg) => arg.startsWith('--record=')).slice(9), Buffer.alloc(150));
    return { stdout: '', stderr: '' };
  });
  const recording = await recorder.listen(1);
  assert.equal(recording.ok, true);
  assert.equal(fs.statSync(recording.path).size, 150);
  assert.match(recording.note, /尚未配置语音识别/);
  await assert.rejects(() => recorder.listen(0), /1–3/);
});

test('Chinese typing uses base64 and restores both keyboard settings after a failed broadcast', async (t) => {
  const calls = [];
  const tools = phone(t, async (_bin, args) => {
    const cmd = args.at(-1); calls.push(cmd);
    if (cmd.includes("'ime' 'list'")) return { stdout: 'com.android.adbkeyboard/.AdbIME' };
    if (cmd.includes("'get' 'secure' 'default_input_method'")) return { stdout: 'original/.Ime' };
    if (cmd.includes("'get' 'secure' 'enabled_input_methods'")) return { stdout: 'original/.Ime:another/.Ime' };
    if (cmd.includes('ADB_INPUT_B64')) throw new Error('broadcast failure');
    return {};
  });
  await assert.rejects(() => tools.typeText('你好 $HOME'), /broadcast failure/);
  assert.ok(calls.some((cmd) => cmd.includes(Buffer.from('你好 $HOME').toString('base64'))));
  assert.match(calls.at(-2), /'default_input_method' 'original\/.Ime'/);
  assert.match(calls.at(-1), /'enabled_input_methods' 'original\/.Ime:another\/.Ime'/);
  await assert.rejects(() => tools.key('home; echo injected'), /不支持/);
});

test('native host registration accepts one complete ToolDefinition and unregisters all tools', (t) => {
  const tools = phone(t, async () => ({}));
  let registrations = 0, disposed = 0;
  const definitions = tools.registerToCordis({ logger: {}, tools: { register(...args) {
    assert.equal(args.length, 1);
    const [definition] = args;
    assert.equal(typeof definition.name, 'string');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    registrations++; return () => disposed++;
  } } });
  assert.ok(!definitions.some((definition) => definition.name === 'phone_type'));
  assert.ok(definitions.some((definition) => definition.name === 'phone_key'));
  assert.ok(definitions.some((definition) => definition.name === 'phone_get_ui_tree'));
  tools.dispose(); tools.dispose();
  assert.equal(disposed, registrations);
});

test('meme sync calls the public pull method, imports nested images, and clears temporary files', async (t) => {
  const dir = fixture(t);
  let calls = 0;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6B7EAAAAASUVORK5CYII=', 'base64');
  const manager = new MemeManager({ desktopMemeDir: dir, phoneTools: { async pull(remote, local) {
    calls++; assert.equal(remote, '/sdcard/Pictures/大肥鱼表情包');
    fs.mkdirSync(path.join(local, '大肥鱼表情包'));
    fs.writeFileSync(path.join(local, '大肥鱼表情包', 'fixture.png'), png);
    fs.writeFileSync(path.join(local, 'notes.txt'), 'not an image');
  } } });
  assert.equal((await manager.syncFromPhone({ descriptions: [{ filename: '大肥鱼表情包/fixture.png', description: '测试像素图，用于验证手机图库同步，不表达真实人物或场景。' }] })).imported, 1);
  assert.equal(calls, 1);
  const memes = manager.listMemes();
  assert.equal(memes.length, 1);
  assert.deepEqual(fs.readFileSync(memes[0].path), png);
  assert.equal((await manager.syncFromPhone({ descriptions: [{ filename: '大肥鱼表情包/fixture.png', description: '测试像素图，用于验证手机图库同步，不表达真实人物或场景。' }] })).imported, 0);
  assert.equal(manager.listMemes().length, 1);
  assert.ok(!fs.readdirSync(dir).some((entry) => entry.startsWith('tmp_pull-')));
  const broken = new MemeManager({ desktopMemeDir: dir, phoneTools: {} });
  assert.equal((await broken.syncFromPhone()).ok, false);
});

test('voice ingestion requires real STT, uses existing local files, and rejects download errors', async (t) => {
  const dir = fixture(t), file = path.join(dir, 'voice.silk');
  fs.writeFileSync(file, 'fixture audio');
  const event = { message: [{ type: 'record', data: { file } }] };
  const absent = new VoiceProcessor({ tempDir: dir });
  assert.equal((await absent.processInboundVoice(event)).ok, false);
  let transcribed = 0;
  const voice = new VoiceProcessor({ tempDir: dir, sttProvider: async (p) => {
    transcribed++; assert.equal(p, file); return '识别文字';
  }, fetchImpl: async () => ({ ok: false, status: 404 }) });
  const local = await voice.processInboundVoice(event);
  assert.equal(local.ok, true); assert.match(local.text, /识别文字/);
  assert.equal(transcribed, 1);
  const failed = await voice.processInboundVoice({ message: [{ type: 'record', data: { url: 'https://fixture.invalid/audio' } }] });
  assert.equal(failed.ok, false); assert.equal(failed.text, '[语音处理失败]: 最近语音读取或转换失败，未开始转写');
  assert.equal(voice.status.readiness, 'failed'); assert.equal(transcribed, 1);
});

test('downloaded voice is bounded and removed after STT', async (t) => {
  const dir = fixture(t);
  let downloaded;
  const voice = new VoiceProcessor({ tempDir: dir, sttProvider: async (p) => {
    downloaded = p; assert.equal(fs.readFileSync(p, 'utf8'), 'voice'); return 'heard';
  }, fetchImpl: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('voice') }) });
  const event = { message: [{ type: 'record', data: { url: 'https://fixture.invalid/audio' } }] };
  assert.equal((await voice.processInboundVoice(event)).ok, true);
  assert.ok(!fs.existsSync(downloaded));
  voice.maxAudioBytes = 2;
  assert.equal((await voice.processInboundVoice(event)).ok, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// Handler-only regressions. Real SDK/Zod parameter contracts are covered by review-phone-runtime.test.mjs.
// No device, model, QQ account, credential or package installation is required.
async function mcpFixture(t, { command, serialState = 'device', recordingCommand } = {}) {
  const dir = fixture(t), calls = [];
  const source = fs.readFileSync(new URL('../packages/phone-mcp/src/phone-mcp.js', import.meta.url), 'utf8')
    .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replace('const execFileAsync = promisify(execFile);', '');
  class StubServer {
    constructor() { this.handlers = new Map(); }
    tool(name, ...args) { this.handlers.set(name, args.at(-1)); }
    async connect() {}
  }
  const chain = new Proxy(function () {}, { get(_target, key) { return key === 'safeParse' ? (data) => ({ success: true, data }) : chain; }, apply() { return chain; } });
  const sandbox = {
    fs, path, os: { ...os, homedir: () => dir }, Buffer, console, McpServer: StubServer,
    DeviceBinding, validateQqSendProfile, verifiedQqSession, qqContact, qqSendControls, audioStatusText,
    transcribeCapturedAudio: (audio, options) => transcribeCapturedAudio(audio, { ...options, env: {}, tempDir: path.join(dir, 'stt') }),
    StdioServerTransport: class {}, z: chain, ncm: {}, setTimeout: (fn) => { fn(); return 0; },
    process: { env: { PHONE_ADB: 'fixture-adb', PHONE_SERIAL: 'fixture-device', HOME: dir }, cwd: () => dir, argv: [] },
    execFileAsync: async (bin, args) => {
      calls.push(args);
      if (args.includes('get-state')) return { stdout: serialState, stderr: '' };
      return { stdout: command?.(args.at(-1), args) || '', stderr: '' };
    },
    execFile: recordingCommand || ((_bin, _args, _opts, callback) => callback(new Error('recorder unavailable'))),
  };
  sandbox.probeCaptureDuration = (file, options) => probeCaptureDuration(file, { ...options, runCommand: sandbox.execFileAsync });
  sandbox.captureDurationText = captureDurationText;
  const server = await vm.runInNewContext(`(async () => { ${source}\nreturn server; })()`, sandbox);
  return { server, calls, dir };
}

test('phone_connect handler never guesses a port even when schema validation is bypassed', async (t) => {
  const { server, calls } = await mcpFixture(t);
  const connect = server.handlers.get('phone_connect');
  for (const port of [undefined, '', '0', '65536', '5555\n', 5555]) {
    const result = await connect({ host: '192.0.2.1', port });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /主页.*配对端口/);
    assert.equal(calls.length, 0);
  }
});

test('sixth direct tap is blocked before ADB and macro actions obey the same limit', async (t) => {
  const { server, calls } = await mcpFixture(t);
  const tap = server.handlers.get('phone_tap');
  for (let i = 0; i < 5; i++) assert.ok(!(await tap({ x: 1, y: 1 })).isError);
  assert.equal((await tap({ x: 1, y: 1 })).isError, true);
  assert.equal(calls.filter((args) => args.at(-1) === 'input tap 1 1').length, 5);
  const macro = await server.handlers.get('phone_macro')({ actions: [{ type: 'tap', x: 1, y: 1 }], repeat: 1, stepMs: 0, repeatGapMs: 0 });
  assert.equal(macro.isError, true);
});

test('QQ target absence cancels before typing or sending', async (t) => {
  const { server, calls } = await mcpFixture(t, { command: (cmd) => cmd.includes('dumpsys window') ? 'com.tencent.mobileqq' : '<node text="someone else" class="android.widget.EditText" bounds="[0,0][10,10]"/>' });
  const result = await server.handlers.get('phone_qq_send')({ message: 'secret', target: 'missing recipient' });
  assert.equal(result.isError, true);
  assert.ok(!calls.some((args) => /input (tap|text)|ADB_INPUT/.test(args.at(-1))));
});

test('Chinese QQ message without ADBKeyboard never presses send', async (t) => {
  const { server, calls } = await mcpFixture(t, { command: (cmd) => {
    if (cmd.includes('dumpsys window')) return 'com.tencent.mobileqq';
    if (cmd.includes('cat')) return '<node text="" class="android.widget.EditText" bounds="[0,0][10,10]"/><node text="发送" bounds="[10,10][20,20]"/>';
    return '';
  } });
  const result = await server.handlers.get('phone_qq_send')({ message: '你好' });
  assert.equal(result.isError, true);
  assert.ok(!calls.some((args) => args.at(-1) === 'input tap 15 15'));
});

test('configured offline device never falls back to another phone', async (t) => {
  const { server, calls } = await mcpFixture(t, { serialState: 'offline' });
  assert.equal((await server.handlers.get('phone_tap')({ x: 1, y: 1 })).isError, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), 'get-state');
});

test('app package input remains one literal Android shell argument', async (t) => {
  const { server, calls, dir } = await mcpFixture(t);
  const marker = path.join(dir, 'injected');
  const target = `pkg'; touch ${marker}; #`;
  await server.handlers.get('phone_open_app')({ pkg: target });
  const cmd = calls.find((args) => args.at(-1).startsWith('am start')).at(-1);
  const printed = execFileSync('/bin/sh', ['-c', 'am() { printf "%s\\n" "$@"; }; ' + cmd], { encoding: 'utf8' });
  assert.ok(printed.includes(target));
  assert.ok(!fs.existsSync(marker));
});

test('legacy CQ voice uses its decoded local path instead of an invented temporary path', async (t) => {
  const dir = fixture(t), file = path.join(dir, 'voice,audio.silk');
  fs.writeFileSync(file, 'voice');
  const voice = new VoiceProcessor({ tempDir: dir, sttProvider: async (received) => {
    assert.equal(received, file); return 'CQ transcription';
  } });
  const result = await voice.processInboundVoice({ message: `[CQ:record,file=${file.replace(',', '&#44;')}]` });
  assert.equal(result.ok, true);
  assert.match(result.text, /CQ transcription/);
});

test('unverified NCM room posting fails without touching any phone', async (t) => {
  const { server, calls } = await mcpFixture(t);
  assert.equal((await server.handlers.get('ncm_room_say')({ text: 'hello' })).isError, true);
  assert.deepEqual(calls, []);
});

test('NCM uses the packaged WebSocket fallback when the runtime has no global WebSocket', async () => {
  const source = fs.readFileSync(new URL('../packages/phone-mcp/src/ncm.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
  let opened = 0, closed = 0;
  class FallbackSocket {
    constructor() { opened++; queueMicrotask(() => this.onopen()); }
    send() { queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: 1, result: { result: { value: 'fixture-result' } } }) })); }
    close() { closed++; }
  }
  const api = await vm.runInNewContext(`(async()=>{ ${source}\nreturn { cdpEvalOnce }; })()`, {
    WebSocketFallback: FallbackSocket, AbortSignal, setTimeout, clearTimeout,
  });
  assert.equal(await api.cdpEvalOnce('ws://fixture.invalid/', 'fixture'), 'fixture-result');
  assert.equal(opened, 1); assert.equal(closed, 1);
});

test('screenshot render carries the actual native image attachment into model context', async (t) => {
  const dir = fixture(t), imagePath = path.join(dir, 'screenshot.png');
  fs.writeFileSync(imagePath, 'fixture-image');
  const tools = phone(t, async () => ({}));
  tools.screenshot = async () => ({ path: imagePath, filename: 'screenshot.png' });
  const ref = { attachmentId: 'fixture', mediaType: 'image/png', bytes: 13 };
  let saved = 0;
  const definitions = tools.registerToCordis({ logger: {}, tools: { register() {} }, get(name) {
    assert.equal(name, 'attachments');
    return { async saveImage(input) {
      assert.equal(input.mediaType, 'image/png');
      assert.equal(input.data.toString(), 'fixture-image');
      saved++; return ref;
    } };
  } });
  const screenshot = definitions.find((definition) => definition.name === 'phone_screenshot');
  const result = await screenshot.execute({});
  assert.equal(saved, 1);
  assert.deepEqual(screenshot.output.render({}, result).at(-1), { type: 'image', attachment: ref });
});

test('unconfigured DSH phone cannot act on the first attached device', async (t) => {
  let calls = 0;
  const tools = new PhoneTools({ device: '', shotDir: fixture(t), runCommand: async () => { calls++; return {}; } });
  await assert.rejects(() => tools.tap(1, 1), /未配置 phoneDevice/);
  await assert.rejects(() => tools.listen(1), /未配置 phoneDevice/);
  assert.equal((await tools.getDeviceState()).online, false);
  assert.equal(calls, 0);
});

test('native phone tools require bound owner private execution context and constrained actions', async (t) => {
  const calls = [];
  let context;
  const tools = new PhoneTools({ device: 'fixture-device', enabled: true, shotDir: fixture(t),
    getExecutionContext: () => context, runCommand: async (_command, args) => { calls.push(args); return {}; },
  });
  const definitions = tools.registerToCordis({ logger: {}, tools: { register() {} } });
  assert.deepEqual(new Set(definitions.map((definition) => definition.name)),
    new Set(['phone_screenshot', 'phone_get_ui_tree', 'phone_key', 'phone_listen']));
  const key = definitions.find((definition) => definition.name === 'phone_key');
  const listen = definitions.find((definition) => definition.name === 'phone_listen');
  for (context of [undefined, { isOwner: false, scope: 'c2c' }, { isOwner: true, scope: 'group' }, { isOwner: true, scope: 'desktop' }]) {
    await assert.rejects(() => key.execute({ key: 'back' }, {}), /主人的私聊/);
  }
  assert.equal(calls.length, 0);
  context = { isOwner: true, scope: 'c2c' };
  await assert.rejects(() => key.execute({ key: 'home' }, {}), /白名单/);
  await assert.rejects(() => listen.execute({ seconds: 4 }, {}), /1–3/);
  assert.equal(calls.length, 0);
  assert.equal((await key.execute({ key: 'BACK' }, {})).ok, true);
  assert.equal(calls.length, 1);
});

test('offline phone runtime neither probes nor executes commands even for owner', async (t) => {
  let calls = 0;
  const tools = new PhoneTools({ device: 'fixture-device', shotDir: fixture(t),
    getExecutionContext: () => ({ isOwner: true, scope: 'c2c' }), runCommand: async () => { calls++; return {}; },
  });
  assert.equal(tools.getRuntimeStatus().enabled, false);
  assert.equal((await tools.getDeviceState()).disabled, true);
  const definitions = tools.registerToCordis({ logger: {}, tools: { register() {} } });
  await assert.rejects(() => definitions.find((definition) => definition.name === 'phone_key').execute({ key: 'back' }), /离线/);
  await assert.rejects(() => tools.tap(1, 1), /离线/);
  assert.equal(calls, 0);
});

test('phone cleanup attempts every unregister even when one fails', (t) => {
  const tools = phone(t, async () => ({}));
  let disposed = 0;
  tools.disposers.push(() => { disposed++; }, () => { disposed++; throw new Error('fixture'); }, () => { disposed++; });
  assert.throws(() => tools.dispose(), AggregateError);
  assert.equal(disposed, 3);
  tools.dispose();
});

test('phone listening passes captured audio to the configured transcription pipeline', async (t) => {
  const directory = fixture(t);
  let audio;
  const tools = new PhoneTools({ device: 'fixture-device', enabled: true, shotDir: directory,
    runCommand: async (_command, args) => {
      audio = args.find((argument) => argument.startsWith('--record=')).slice(9);
      fs.writeFileSync(audio, Buffer.alloc(200)); return {};
    },
    transcribeAudio: async (file) => { assert.equal(file, audio); return '视频里实际识别的文字'; },
  });
  const result = await tools.listen(3);
  assert.equal(result.ok, true);
  assert.equal(result.text, '视频里实际识别的文字');
  tools.transcribeAudio = async () => { throw new Error('provider unavailable'); };
  const failed = await tools.listen(3);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /语音识别失败/);
  assert.ok(fs.existsSync(failed.path));
});
