import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSttProvider, createNativeSttProvider, VoiceProcessor } from '../packages/dsh-dafeiyu/src/voice-processor.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stt-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const audio = path.join(directory, "audio ' ; $(ignored).wav");
  fs.writeFileSync(audio, 'test-fixture-audio');
  return { directory, audio };
}

test('provider construction validates serializable config and performs no process/network calls', () => {
  let called = 0;
  const options = { runCommand: async () => { called++; }, fetchImpl: async () => { called++; } };
  assert.equal(createSttProvider(undefined, options), undefined);
  assert.equal(typeof createSttProvider({ type: 'command', command: 'whisper-cli', args: ['-f', '{audio}'] }, options), 'function');
  assert.equal(typeof createSttProvider({ type: 'http', endpoint: 'http://127.0.0.1:9000/transcribe', model: 'local-whisper' }, options), 'function');
  assert.equal(called, 0);
  assert.throws(() => createSttProvider({ type: 'command', command: 'x', args: ['missing-placeholder'] }), /audio/);
  assert.throws(() => createSttProvider({ type: 'http', endpoint: 'http://remote.invalid/', model: 'm' }), /HTTPS/);
});

test('command provider uses literal argv and returns only actual command stdout', async (t) => {
  const { directory, audio } = fixture(t);
  const fakeEngine = path.join(directory, 'fixture-engine.mjs');
  fs.writeFileSync(fakeEngine, "import fs from 'node:fs'; if (fs.readFileSync(process.argv[2], 'utf8') !== 'test-fixture-audio') process.exit(1); console.log('fixture transcript');");
  const provider = createSttProvider({ type: 'command', command: process.execPath, args: [fakeEngine, '{audio}'] });
  assert.equal(await provider(audio), 'fixture transcript');
  const empty = createSttProvider({ type: 'command', command: process.execPath, args: ['-e', '', '{audio}'] });
  await assert.rejects(() => empty(audio), /未返回识别文字/);
  const missing = createSttProvider({ type: 'command', command: path.join(directory, 'not-installed'), args: ['{audio}'] });
  await assert.rejects(() => missing(audio), /本地 STT 命令执行失败/);
});

test('optional ffmpeg conversion hands its real output to STT and cleans it afterward', async (t) => {
  const { directory, audio } = fixture(t);
  let calls = 0, converted;
  const provider = createSttProvider({ type: 'command', command: 'fixture-whisper', args: ['--file={audio}'], convertToWav: true }, {
    tempDir: path.join(directory, 'temp'), runCommand: async (command, args, options) => {
      assert.equal(options.shell, undefined); calls++;
      if (command === 'ffmpeg') {
        assert.equal(args[args.indexOf('-i') + 1], audio);
        converted = args.at(-1); fs.writeFileSync(converted, 'converted-fixture');
        return { stdout: '' };
      }
      assert.equal(command, 'fixture-whisper');
      assert.equal(args[0], `--file=${converted}`);
      assert.equal(fs.readFileSync(converted, 'utf8'), 'converted-fixture');
      return { stdout: 'converted transcript' };
    },
  });
  assert.equal(await provider(audio), 'converted transcript');
  assert.equal(calls, 2);
  assert.ok(!fs.existsSync(converted));
});

test('failed audio conversion never calls STT and leaves no temporary audio', async (t) => {
  const { directory, audio } = fixture(t);
  const temporary = path.join(directory, 'temp');
  let calls = 0;
  const provider = createSttProvider({ type: 'command', command: 'fixture-whisper', args: ['{audio}'], convertToWav: true }, {
    tempDir: temporary, runCommand: async () => { calls++; throw new Error('unsupported codec'); },
  });
  await assert.rejects(() => provider(audio), /音频解码失败/);
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(temporary), []);
});

test('HTTP provider uploads bounded file/model to the explicitly configured endpoint', async (t) => {
  const { audio } = fixture(t);
  let calls = 0;
  const provider = createSttProvider({ type: 'http', endpoint: 'https://speech.invalid/transcriptions', model: 'fixture-stt', apiKeyEnv: 'FIXTURE_STT_KEY', language: 'zh' }, {
    env: { FIXTURE_STT_KEY: 'fixture-not-a-real-key' }, fetchImpl: async (endpoint, options) => {
      calls++;
      assert.equal(endpoint, 'https://speech.invalid/transcriptions');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer fixture-not-a-real-key');
      assert.equal(options.body.get('model'), 'fixture-stt');
      assert.equal(options.body.get('language'), 'zh');
      assert.equal(await options.body.get('file').text(), 'test-fixture-audio');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ text: '真实服务约定的返回文字' }) };
    },
  });
  assert.equal(await provider(audio), '真实服务约定的返回文字');
  assert.equal(calls, 1);
});

test('HTTP errors and missing configuration do not become fake transcriptions', async (t) => {
  const { audio } = fixture(t);
  const base = { type: 'http', endpoint: 'http://localhost:9000/transcribe', model: 'fixture' };
  const failing = createSttProvider(base, { fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(() => failing(audio), /503/);
  const empty = createSttProvider(base, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(() => empty(audio), /未返回识别文字/);
  let calls = 0;
  const noCredential = createSttProvider({ ...base, apiKeyEnv: 'MISSING_FIXTURE' }, { env: {}, fetchImpl: async () => { calls++; } });
  await assert.rejects(() => noCredential(audio), /MISSING_FIXTURE/);
  assert.equal(calls, 0);
});

test('VoiceProcessor accepts YAML-compatible stt object and uses it for both message and phone recordings', async (t) => {
  const { directory, audio } = fixture(t);
  const voice = new VoiceProcessor({ tempDir: directory,
    stt: { type: 'command', command: 'fixture-engine', args: ['{audio}'] },
    providerOptions: { runCommand: async (_command, args) => { assert.equal(args[0], audio); return { stdout: 'from configured engine' }; } },
  });
  assert.equal((await voice.processInboundVoice({ message: [{ type: 'record', data: { file: audio } }] })).ok, true);
  assert.equal(await voice.transcribeFile(audio), 'from configured engine');
});

test('native STT converts PCM to exact canonical WAV and uses the selected host provider without preparation', async (t) => {
  const { directory, audio } = fixture(t);
  let resolveCalls = 0, transcribeCalls = 0, decodeCalls = 0;
  const native = {
    prepare() { assert.fail('must not prepare or download a provider'); },
    configure() { assert.fail('must not change the selected provider'); },
    resolve(request) {
      resolveCalls++;
      const wave = request.audio;
      assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wave.toString('ascii', 8, 12), 'WAVE');
      assert.equal(wave.toString('ascii', 12, 16), 'fmt ');
      assert.equal(wave.readUInt32LE(16), 16);
      assert.equal(wave.readUInt16LE(20), 1);
      assert.equal(wave.readUInt16LE(22), 1);
      assert.equal(wave.readUInt32LE(24), 16000);
      assert.equal(wave.readUInt32LE(28), 32000);
      assert.equal(wave.readUInt16LE(32), 2);
      assert.equal(wave.readUInt16LE(34), 16);
      assert.equal(wave.toString('ascii', 36, 40), 'data');
      assert.equal(wave.readUInt32LE(4), wave.length - 8);
      assert.equal(wave.readUInt32LE(40), wave.length - 44);
      assert.equal(request.providerId, undefined);
      return { pinned: true, audio: wave };
    },
    async transcribe(spec, signal) {
      transcribeCalls++; assert.equal(spec.pinned, true); assert.equal(signal.aborted, false);
      return { text: '本机语音服务返回的文字', audioSeconds: 0.1, inferenceSeconds: 0.01 };
    },
  };
  const provider = createNativeSttProvider(native, { tempDir: path.join(directory, 'native'),
    runCommand: async (command, args) => {
      decodeCalls++; assert.equal(command, 'ffmpeg');
      assert.equal(args[args.indexOf('-i') + 1], audio);
      assert.equal(args[args.indexOf('-f') + 1], 's16le');
      fs.writeFileSync(args.at(-1), Buffer.alloc(3200)); return {};
    },
  });
  assert.equal(resolveCalls + transcribeCalls + decodeCalls, 0);
  assert.equal(await provider(audio), '本机语音服务返回的文字');
  assert.equal(resolveCalls, 1); assert.equal(transcribeCalls, 1); assert.equal(decodeCalls, 1);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'native')), []);
});

test('native STT preserves provider readiness errors and never starts a fallback or download', async (t) => {
  const { directory, audio } = fixture(t);
  let prepared = 0;
  const provider = createNativeSttProvider({
    resolve: (request) => request,
    prepare() { prepared++; },
    async transcribe() { throw new Error('Speech provider unprepared'); },
  }, { tempDir: path.join(directory, 'native'), runCommand: async (_command, args) => { fs.writeFileSync(args.at(-1), Buffer.alloc(3200)); return {}; } });
  await assert.rejects(() => provider(audio), /unprepared/);
  assert.equal(prepared, 0);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'native')), []);
});
