import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { PhoneTools } from '../packages/dsh-dafeiyu/src/phone-tools.js';
import { DeviceBinding } from '../packages/phone-mcp/src/phone-device.js';
import { validateQqSendProfile, verifiedQqSession, qqContact, qqSendControls } from '../packages/phone-mcp/src/phone-identity.js';
import { transcribeCapturedAudio, audioStatusText } from '../packages/phone-mcp/src/phone-audio.js';
import { probeCaptureDuration, captureDurationText } from '../packages/phone-mcp/src/shared/media-probe.js';

const require = createRequire(new URL('../packages/phone-mcp/package.json', import.meta.url));
const { z } = require('zod');
const metadata = (duration) => ({ stdout: JSON.stringify({ streams: [{ duration: String(duration) }], format: { duration: String(duration) } }), stderr: '' });

function directory(t) {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reliability-'));
  t.after(() => fs.rmSync(result, { recursive: true, force: true }));
  return result;
}

function nativeFixture(t, { measured = 1.31, recording, probing, transcribeAudio } = {}) {
  const dir = directory(t), calls = [];
  const tools = new PhoneTools({ device: 'fixture-phone', enabled: true, shotDir: dir,
    scrcpyPath: 'fixture-scrcpy', ffprobePath: 'fixture-ffprobe',
    getExecutionContext: () => ({ isOwner: true, scope: 'c2c' }), transcribeAudio,
    runCommand: async (bin, args, options) => {
      calls.push({ bin, args, options });
      if (bin === 'fixture-scrcpy') {
        const audio = args.find((value) => value.startsWith('--record=')).slice(9);
        fs.writeFileSync(audio, Buffer.alloc(256));
        await recording?.({ tools, audio, options });
        return { stdout: '', stderr: '' };
      }
      if (bin === 'fixture-ffprobe') return probing ? probing({ tools, args, options }) : metadata(measured);
      throw new Error('Unexpected external process in fixture');
    },
  });
  return { tools, calls, dir };
}

test('native short recording reports measured duration, retains the media and does not claim requested duration', async (t) => {
  const { tools, calls } = nativeFixture(t);
  const result = await tools.listen(3);
  assert.equal(result.ok, true);
  assert.equal(result.requestedSeconds, 3);
  assert.equal(result.actualDurationSeconds, 1.31);
  assert.equal(result.duration, 1.31);
  assert.equal(result.durationStatus, 'measured');
  assert.equal(result.partial, true);
  assert.ok(fs.existsSync(result.path));
  assert.equal(calls.length, 2);
});

test('missing or malformed duration probe preserves captured audio with unknown actual duration', async (t) => {
  for (const probing of [() => { throw Object.assign(new Error('ffprobe not installed'), { code: 'ENOENT' }); }, () => ({ stdout: '{invalid json' })]) {
    const { tools } = nativeFixture(t, { probing });
    const result = await tools.listen(3);
    assert.equal(result.ok, true);
    assert.equal(result.requestedSeconds, 3);
    assert.equal(result.actualDurationSeconds, null);
    assert.equal(result.duration, null);
    assert.equal(result.durationStatus, 'unknown');
    assert.equal(result.partial, null);
    assert.ok(fs.existsSync(result.path));
    assert.match(captureDurationText(result), /实际媒体时长未知/);
  }
});

test('duration probe measures the requested stream and rejects missing tracks and nonpositive metadata', async () => {
  const calls = [];
  const result = await probeCaptureDuration('fixture.m4a', { requestedSeconds: 3, runCommand: async (_bin, args) => {
    calls.push(args); return { stdout: JSON.stringify({ streams: [{ duration: '1.31' }], format: { duration: '3' } }) };
  } });
  assert.equal(result.actualDurationSeconds, 1.31);
  assert.ok(calls[0].includes('a:0'));
  for (const payload of [{ streams: [], format: { duration: '3' } }, { streams: [{ duration: '0' }], format: { duration: 'NaN' } }]) {
    const unknown = await probeCaptureDuration('fixture.m4a', { requestedSeconds: 3, runCommand: async () => ({ stdout: JSON.stringify(payload) }) });
    assert.equal(unknown.durationStatus, 'unknown');
    assert.equal(unknown.actualDurationSeconds, null);
  }
});

test('native screenshot/UI/BACK pass one signal and stop immediately after cancellation or disposal', async (t) => {
  for (const operation of ['phone_screenshot', 'phone_get_ui_tree', 'phone_key']) {
    for (const stop of ['abort', 'dispose']) {
      const controller = new AbortController(), calls = [];
      let tools;
      tools = new PhoneTools({ device: 'fixture-phone', enabled: true, shotDir: directory(t),
        getExecutionContext: () => ({ isOwner: true, scope: 'c2c' }), runCommand: async (_bin, args, options) => {
          calls.push({ args, options });
          if (stop === 'abort') controller.abort(new Error('fixture cancelled'));
          else tools.dispose();
          return { stdout: '', stderr: '' };
        } });
      const definition = tools.registerToCordis({ logger: { info() {} }, tools: { register() {} } }).find((item) => item.name === operation);
      await assert.rejects(() => definition.execute(operation === 'phone_key' ? { key: 'back' } : {}, { signal: controller.signal }), /fixture cancelled|已停止/);
      assert.equal(calls.length, 1, 'pull/rm or another command must not continue');
      assert.equal(calls[0].options.signal, controller.signal);
    }
  }
});

for (const stop of ['abort', 'dispose']) {
  test(`native screenshot cannot return an image after ${stop} during asynchronous attachment saving`, async (t) => {
    const controller = new AbortController(), dir = directory(t), calls = [];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6B7EAAAAASUVORK5CYII=', 'base64');
    let saved = 0;
    const tools = new PhoneTools({ device: 'fixture-phone', enabled: true, shotDir: dir,
      getExecutionContext: () => ({ isOwner: true, scope: 'c2c' }),
      runCommand: async (_bin, args, options) => {
        assert.equal(options.signal, controller.signal);
        calls.push(args);
        if (args.includes('pull')) fs.writeFileSync(args.at(-1), png);
        return { stdout: '', stderr: '' };
      },
    });
    const definition = tools.registerToCordis({ logger: { info() {} }, tools: { register() {} },
      get(name) {
        assert.equal(name, 'attachments');
        return { async saveImage({ data }) {
          saved++;
          assert.deepEqual(data, png);
          await Promise.resolve();
          if (stop === 'abort') controller.abort(new Error('fixture attachment cancelled'));
          else tools.dispose();
          return { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: png.length };
        } };
      },
    }).find((tool) => tool.name === 'phone_screenshot');
    await assert.rejects(() => definition.execute({}, { signal: controller.signal }), /fixture attachment cancelled|已停止/);
    assert.equal(saved, 1);
    assert.equal(calls.length, 3);
    assert.equal(fs.readdirSync(dir).length, 1, 'capture remains on disk without returning a successful image result');
  });
}

test('an already cancelled native operation never starts a command', async (t) => {
  const controller = new AbortController();
  controller.abort(new Error('fixture cancelled'));
  const { tools, calls } = nativeFixture(t);
  for (const operation of [() => tools.screenshot({ signal: controller.signal }), () => tools.getUiTree({ signal: controller.signal }),
    () => tools.key('back', { signal: controller.signal }), () => tools.listen(3, { signal: controller.signal })]) {
    await assert.rejects(operation, /fixture cancelled/);
  }
  assert.equal(calls.length, 0);
});

test('native cancellation/disposal during recording prevents probe and STT and removes incomplete output', async (t) => {
  for (const stop of ['abort', 'dispose']) {
    const controller = new AbortController();
    let transcribed = 0;
    const { tools, calls, dir } = nativeFixture(t, {
      recording: ({ tools: active }) => stop === 'abort' ? controller.abort() : active.dispose(),
      transcribeAudio: async () => { transcribed++; return 'must not run'; },
    });
    const result = await tools.listen(3, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(calls.length, 1);
    assert.equal(transcribed, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('native cancellation/disposal during STT never returns recognized text as success', async (t) => {
  for (const stop of ['abort', 'dispose']) {
    const controller = new AbortController();
    let current;
    const { tools } = nativeFixture(t, { transcribeAudio: async (_file, options) => {
      assert.equal(options.signal, controller.signal);
      if (stop === 'abort') controller.abort(); else current.dispose();
      return 'late fixture recognition';
    } });
    current = tools;
    const result = await tools.listen(3, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.text, undefined);
    assert.ok(fs.existsSync(result.path), 'a completed capture remains available separately from cancelled recognition');
  }
});

async function mcpFixture(t, { probeFails = false, transcribe, measured = 1.31 } = {}) {
  const dir = directory(t), calls = [];
  class Server {
    constructor() { this.handlers = new Map(); }
    tool(name, ...args) { this.handlers.set(name, args.at(-1)); }
  }
  const source = fs.readFileSync(new URL('../packages/phone-mcp/src/phone-mcp.js', import.meta.url), 'utf8')
    .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replace('const execFileAsync = promisify(execFile);', '');
  const body = source.slice(0, source.lastIndexOf("if (process.argv.includes('--selftest'))"));
  const sandbox = { fs, os, path, Buffer, z, McpServer: Server, DeviceBinding,
    validateQqSendProfile, verifiedQqSession, qqContact, qqSendControls, captureDurationText, audioStatusText,
    console: { error() {} }, setTimeout, process: { env: { PHONE_ADB: 'fixture-adb', PHONE_SERIAL: 'fixture-phone', PHONE_SHOT_DIR: dir, PHONE_FFPROBE: 'fixture-ffprobe' } },
    execFileAsync: async (bin, args, options) => {
      calls.push({ bin, args, options });
      if (bin === 'fixture-adb') return { stdout: 'device', stderr: '' };
      if (bin === 'fixture-ffprobe') { if (probeFails) throw new Error('fixture missing probe'); return metadata(measured); }
      throw new Error('Unexpected process in fixture');
    },
    execFile: (bin, args, _options, callback) => {
      calls.push({ bin, args });
      if (bin === 'scrcpy') fs.writeFileSync(args.find((value) => value.startsWith('--record=')).slice(9), Buffer.alloc(2048));
      else if (bin === 'ffmpeg') fs.writeFileSync(args.at(-1).replace('%02d', '01'), 'fixture frame');
      else return callback(new Error('Unexpected recorder in fixture'));
      callback(null, '', '');
    },
    transcribeCapturedAudio: transcribe || (async () => ({ status: 'not-configured', error: 'fixture STT not configured' })),
  };
  sandbox.probeCaptureDuration = (file, options) => probeCaptureDuration(file, { ...options, runCommand: sandbox.execFileAsync });
  const server = await vm.runInNewContext(`(async()=>{${body}\nreturn server;})()`, sandbox);
  return { calls, dir, invoke: (name, args, execution) => server.handlers.get(name)(args, execution) };
}

test('MCP listen/record results distinguish requested and actual duration, including unknown probes', async (t) => {
  for (const probeFails of [false, true]) {
    const { invoke, calls } = await mcpFixture(t, { probeFails });
    for (const name of ['phone_listen', 'phone_record_screen']) {
      const result = await invoke(name, { seconds: 3, frames: 2 });
      assert.equal(result.isError, undefined);
      const capture = result.structuredContent.capture;
      assert.equal(capture.requestedSeconds, 3);
      assert.equal(capture.actualDurationSeconds, probeFails ? null : 1.31);
      assert.equal(capture.seconds, probeFails ? null : 1.31);
      assert.equal(capture.partial, probeFails ? null : true);
      assert.equal(capture.durationStatus, probeFails ? 'unknown' : 'measured');
      assert.ok(fs.existsSync(capture.file));
      assert.ok(!result.content[0].text.includes('已保存 3 秒'));
    }
    assert.ok(calls.some(({ args }) => args.includes('a:0')));
    assert.ok(calls.some(({ args }) => args.includes('v:0')));
  }
});

test('MCP cancellation after an uncooperative transcription callback cannot return success', async (t) => {
  for (const name of ['phone_listen', 'phone_record_screen']) {
    const controller = new AbortController();
    const { invoke } = await mcpFixture(t, { transcribe: async (_file, options) => {
      assert.equal(options.signal, controller.signal); controller.abort();
      return { status: 'succeeded', text: 'late fixture recognition' };
    } });
    const result = await invoke(name, { seconds: 3, frames: 2 }, { signal: controller.signal });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  }
});

test('shared phone audio wrapper cannot turn cancelled STT into a succeeded status', async (t) => {
  const dir = directory(t), file = path.join(dir, 'fixture.m4a'), controller = new AbortController();
  fs.writeFileSync(file, 'fixture audio');
  const result = await transcribeCapturedAudio(file, { env: {}, tempDir: path.join(dir, 'stt'), signal: controller.signal,
    sttProvider: async () => { controller.abort(); return 'late fixture words'; } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.text, undefined);
});
