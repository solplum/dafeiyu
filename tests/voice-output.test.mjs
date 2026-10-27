import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceOutput, registerVoiceOutputTool } from '../packages/dsh-dafeiyu/src/voice-output.js';
import { VoicePanel } from '../packages/dsh-dafeiyu/src/voice-panel.js';
import { PrivateConfigStore } from '../packages/dsh-dafeiyu/src/config-store.js';
import { buildVoiceCatalog, validateVoiceProfiles } from '../packages/dsh-dafeiyu/src/voice-catalog.js';

const PRIVATE = 'VOICE_PRIVATE_CANARY';
// Two structurally complete MPEG-1 Layer III frames: 128 kbps / 44.1 kHz,
// floor(144 * 128000 / 44100) = 417 bytes each. No external encoder is used.
const FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
const AUDIO = Buffer.concat([FRAME, FRAME]);
const response = (chunks = [AUDIO], options = {}) => ({ ok: options.ok ?? true,
  headers: { get: () => options.length === undefined ? null : String(options.length) },
  body: { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } },
});
const config = { voiceReplyEnabled: true, ttsProvider: 'openai-compatible', ttsBaseURL: 'https://voice.example.com/v1',
  ttsModel: 'real-tts-model', ttsVoice: 'real-voice', ttsApiKey: PRIVATE };
const noBinaries = { say: '', ffmpeg: '', ffprobe: '' };
const makeVoice = (options = {}) => new VoiceOutput({ config, platform: 'linux', binaries: noBinaries,
  fetchImpl: async () => response(), execFileImpl: async () => { throw new Error('unexpected process'); }, ...options });

test('TTS configuration and status distinguish configured from unverified without returning key or URL', () => {
  const voice = makeVoice();
  assert.equal(voice.configured, true);
  assert.equal(voice.status.enabled, true);
  assert.equal(voice.status.readiness, 'not-verified');
  assert.equal(JSON.stringify(voice.status).includes(PRIVATE), false);
  assert.equal(JSON.stringify(voice.status).includes('voice.example.com'), false);
  for (const overrides of [{ ttsBaseURL: 'http://remote.example.com' }, { ttsBaseURL: 'https://user:pass@example.com' },
    { ttsBaseURL: 'https://example.com/?token=secret' }, { ttsProvider: 'unknown' }, { ttsApiKey: '' }]) {
    assert.equal(makeVoice({ config: { ...config, ...overrides } }).configured, false);
  }
  assert.equal(makeVoice({ config: { ...config, ttsBaseURL: 'http://127.0.0.1:8888/v1', ttsApiKey: '' } }).configured, true);
  assert.equal(makeVoice({ config: { ...config, ttsProvider: 'macos' } }).configured, false);
});

test('remote speech request uses fixed OpenAI audio protocol and returns bounded audio without claiming QQ delivery', async () => {
  const calls = [];
  const voice = makeVoice({ fetchImpl: async (url, options) => { calls.push({ url, options }); return response([AUDIO.subarray(0, 4), AUDIO.subarray(4)]); } });
  const bytes = await voice.synthesize('  用中文说话  ');
  assert.deepEqual(bytes, AUDIO);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://voice.example.com/v1/audio/speech');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${PRIVATE}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'real-tts-model', input: '用中文说话', voice: 'real-voice', response_format: 'mp3' });
  assert.equal(voice.status.readiness, 'synthesis-verified');
  assert.equal(voice.status.lastResult.delivered, false);
  assert.equal(JSON.stringify(voice.status).includes(PRIVATE), false);
});

test('bad status, oversize declarations or streams and non-audio responses fail with safe diagnostics', async () => {
  for (const fetchImpl of [
    async () => response([AUDIO], { ok: false }),
    async () => response([AUDIO], { length: 5 * 1024 * 1024 + 1 }),
    async () => response([AUDIO, Buffer.alloc(5 * 1024 * 1024)]),
    async () => response([Buffer.from('<html>' + PRIVATE + '</html>')]),
    async () => { throw new Error(PRIVATE); },
  ]) {
    const voice = makeVoice({ fetchImpl });
    await assert.rejects(voice.synthesize('你好'), (error) => !error.message.includes(PRIVATE));
    assert.equal(voice.status.lastResult.ok, false);
    assert.equal(voice.status.readiness, 'failed');
    assert.equal(JSON.stringify(voice.status).includes(PRIVATE), false);
  }
});

test('fake ID3 tags, incomplete frames and mismatched frame rates cannot count as successful audio', async () => {
  const mismatched = Buffer.from(AUDIO);
  mismatched[FRAME.length + 2] = 0x94; // second frame changes sample rate to 48 kHz
  for (const bytes of [Buffer.from('ID3' + 'fake-mp3'.repeat(20)), Buffer.from('ID3x'), FRAME,
    AUDIO.subarray(0, AUDIO.length - 1), mismatched]) {
    const voice = makeVoice({ fetchImpl: async () => response([bytes]) });
    await assert.rejects(voice.synthesize('你好'));
    assert.equal(voice.status.lastResult.ok, false);
    assert.equal(voice.status.readiness, 'failed');
  }
  const tagged = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), AUDIO]);
  const voice = makeVoice({ fetchImpl: async () => response([tagged]) });
  assert.deepEqual(await voice.synthesize('你好'), tagged);
  assert.equal(voice.status.lastResult.delivered, false);
});

test('invalid text and disposed synthesis never call a network service', async () => {
  let calls = 0;
  const voice = makeVoice({ fetchImpl: async () => { calls++; return response(); } });
  for (const text of ['', '  ', 'a'.repeat(301), null, { text: 'hello' }]) await assert.rejects(voice.synthesize(text));
  voice.dispose();
  await assert.rejects(voice.synthesize('你好'));
  assert.equal(voice.key, '');
  assert.equal(calls, 0);
});

test('disposing during a remote request aborts accepted synthesis and cannot mark it ready', async () => {
  let requested, started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const voice = makeVoice({ fetchImpl: (_url, { signal }) => {
    requested = signal; started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(PRIVATE)), { once: true }));
  } });
  const pending = voice.synthesize('你好');
  await waiting;
  voice.dispose();
  await assert.rejects(pending, (error) => !error.message.includes(PRIVATE));
  assert.equal(requested.aborted, true);
  assert.equal(voice.status.enabled, false);
  assert.equal(voice.status.lastResult.ok, false);
});

test('network and stalled audio streams have a bounded request lifetime even if a provider ignores abort', async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => ({ ok: true, headers: { get: () => null }, body: {
      [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; },
    } }),
  ]) {
    const voice = makeVoice({ fetchImpl, timeoutMs: 5 });
    await assert.rejects(voice.synthesize('你好'));
    assert.equal(voice.controllers.size, 0);
    assert.equal(voice.status.lastResult.ok, false);
  }
});

test('rejecting oversize streaming audio cancels the underlying request', async () => {
  let signal;
  const voice = makeVoice({ fetchImpl: async (_url, options) => {
    signal = options.signal;
    return response([Buffer.alloc(5 * 1024 * 1024 + 1)]);
  } });
  await assert.rejects(voice.synthesize('你好'));
  assert.equal(signal.aborted, true);
});

test('local speech keeps text in private temporary files and cleans them after processing', async () => {
  const calls = [];
  let directory;
  const voice = makeVoice({ platform: 'darwin', config: { ...config, ttsProvider: 'macos', ttsApiKey: '' },
    binaries: { say: '/fake/say', ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' },
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      if (command === '/fake/say') {
        const input = args[args.indexOf('-f') + 1]; directory = path.dirname(input);
        assert.equal(fs.readFileSync(input, 'utf8'), '你好 $(do-not-run) `literal`');
        assert.equal(fs.statSync(input).mode & 0o777, 0o600);
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'AIFF fixture');
      }
      if (command === '/fake/ffprobe') return { stdout: JSON.stringify({ format: { duration: '1.2' } }) };
      if (command === '/fake/ffmpeg') fs.writeFileSync(args.at(-1), AUDIO);
      return { stdout: '' };
    } });
  assert.deepEqual(await voice.synthesize('你好 $(do-not-run) `literal`'), AUDIO);
  assert.deepEqual(calls.map((call) => call.command), ['/fake/say', '/fake/ffprobe', '/fake/ffmpeg']);
  assert.equal(calls.some((call) => call.args.some((arg) => arg.includes('do-not-run'))), false);
  assert.equal(fs.existsSync(directory), false);
});

test('overlong local output is rejected before encoding and temporary data is still cleaned', async () => {
  let directory, encoded = false;
  const voice = makeVoice({ platform: 'darwin', config: { ...config, ttsProvider: 'macos' },
    binaries: { say: '/fake/say', ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' },
    execFileImpl: async (command, args) => {
      if (command === '/fake/say') { directory = path.dirname(args[1]); fs.writeFileSync(args.at(-1), 'AIFF fixture'); }
      if (command === '/fake/ffprobe') return { stdout: JSON.stringify({ format: { duration: '91' } }) };
      if (command === '/fake/ffmpeg') encoded = true;
      return { stdout: '' };
    } });
  await assert.rejects(voice.synthesize('你好'));
  assert.equal(encoded, false);
  assert.equal(fs.existsSync(directory), false);
});

function toolFixture(options = {}) {
  const state = { identity: { isOwner: true, channel: 'onebot', scope: 'c2c', selfId: '11002', peerId: '11001', sessionId: 'owner-real-session' },
    synthesis: [], sends: [], result: { ok: true, data: { message_id: 123 } }, registration: null, unregistered: false };
  const voiceOutput = { enabled: true, closed: false, async synthesize(text) { state.synthesis.push(text); return AUDIO; }, ...options.voiceOutput };
  const qqGateway = { connected: true, online: true, loginVerified: true, identityConflict: false, selfId: '11002',
    async sendRecord(...args) { state.sends.push(args); return state.result; }, ...options.qqGateway };
  const ctx = { tools: { register(definition) { state.registration = definition; return () => { state.unregistered = true; }; } } };
  const dispose = registerVoiceOutputTool(ctx, { voiceOutput, qqGateway, getExecutionContext: () => state.identity });
  return { state, voiceOutput, qqGateway, dispose, execute: (...args) => state.registration.execute(...args) };
}

test('voice tool is absent while disabled and rejects desktop, visitors, groups, bad identity and bad args before synthesis', async () => {
  const disabled = toolFixture({ voiceOutput: { enabled: false } });
  assert.equal(disabled.state.registration, null);
  const fixture = toolFixture();
  for (const change of [{ isOwner: false }, { scope: 'desktop' }, { scope: 'group' }, { channel: 'official' }, { selfId: 'another-small-account' }]) {
    fixture.state.identity = { ...toolFixture().state.identity, ...change };
    await assert.rejects(fixture.execute({ text: '你好' }, {}));
  }
  fixture.state.identity = toolFixture().state.identity;
  await assert.rejects(fixture.execute({ text: '你好', peerId: 'arbitrary' }, {}));
  assert.equal(fixture.state.synthesis.length, 0);
  assert.equal(fixture.state.sends.length, 0);
});

test('voice tool checks current authority after synthesis and never sends to a changed peer', async () => {
  const fixture = toolFixture();
  fixture.voiceOutput.synthesize = async () => { fixture.state.identity.peerId = 'another-peer'; return AUDIO; };
  const result = await fixture.execute({ text: '你好' }, {});
  assert.equal(result.ok, false);
  assert.equal(fixture.state.sends.length, 0);
});

test('successful voice delivery is reported only after the OneBot receipt', async () => {
  const { state, execute, voiceOutput } = toolFixture();
  const result = await execute({ text: '你好' }, {});
  assert.deepEqual(state.sends[0], ['private:11001', AUDIO, { selfId: '11002' }]);
  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(result.messageId, '123');
  assert.equal(voiceOutput.lastResult.delivered, true);
});

test('uncertain send result blocks retry within the current session and never duplicates a send', async () => {
  const { state, execute } = toolFixture();
  state.result = { ok: false, uncertain: true, error: PRIVATE };
  const result = await execute({ text: '你好' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  await assert.rejects(execute({ text: '你好' }, {}), /禁止自动重发/);
  assert.equal(state.sends.length, 1);
});

test('unloading a tool during synthesis revokes delivery and unregisters it', async () => {
  const fixture = toolFixture();
  fixture.voiceOutput.synthesize = async () => { fixture.dispose(); return AUDIO; };
  const result = await fixture.execute({ text: '你好' }, {});
  assert.equal(result.ok, false);
  assert.equal(fixture.state.sends.length, 0);
  assert.equal(fixture.state.unregistered, true);
});

test('voice settings use the private store CAS, preserve unrelated fields, and never return the key', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-panel-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...config, ownerQq: '11001', onebotSelfId: '11002' }), { mode: 0o600 });
  const store = new PrivateConfigStore({ configFile });
  const runtime = { voiceOutput: makeVoice() };
  let busy = false;
  const panel = new VoicePanel({ store, getRuntime: () => runtime, getBusy: () => busy });
  const first = panel.snapshot();
  assert.equal(JSON.stringify(first).includes(PRIVATE), false);
  const saved = panel.save({ revision: first.config.revision, patch: { ttsVoice: 'new-voice', ttsApiKey: 'replaced-key' } });
  assert.equal(saved.pendingReload, true);
  assert.equal(saved.config.secretConfigured.ttsApiKey, true);
  assert.equal(JSON.stringify(saved).includes('replaced-key'), false);
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(raw.ownerQq, '11001');
  assert.equal(raw.ttsApiKey, 'replaced-key');
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  assert.throws(() => panel.save({ revision: first.config.revision, patch: { ttsVoice: 'stale' } }), { code: 'CONFLICT' });
  busy = true;
  assert.throws(() => panel.save({ revision: saved.config.revision, patch: { ttsVoice: 'busy' } }), { code: 'BUSY' });
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).ttsVoice, 'new-voice');
  busy = false;
  assert.throws(() => panel.save({ revision: saved.config.revision, patch: { ttsVoice: 'invalid' }, clearSecrets: 'ttsApiKey' }), { code: 'INVALID_PATCH' });
});

const profiles = [
  { id: 'gentle', voice: 'Serena', name: '温柔', description: '轻声、舒缓的中文女声' },
  { id: 'bright', voice: 'Vivian', name: '明亮', description: '自然、活泼的中文女声' },
];
const profileConfig = { ...config, ttsLanguage: 'chinese', ttsVoice: 'gentle', ttsVoiceProfiles: profiles, ttsAutoVoice: true };

test('managed catalogues preserve legacy voices, expose real Qwen speakers and reject unsafe owner records', () => {
  assert.equal(buildVoiceCatalog(config).voices[0].voice, 'real-voice');
  const compatible = buildVoiceCatalog({ ttsModel: 'tts-1', ttsVoice: 'custom-speaker' });
  assert.equal(compatible.defaultVoiceId, 'custom-speaker');
  assert.equal(compatible.voices.find((item) => item.id === compatible.defaultVoiceId).voice, 'custom-speaker');
  const qwen = buildVoiceCatalog({ ttsModel: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit', ttsVoice: 'Serena' });
  assert.equal(qwen.defaultVoiceId, 'serena'); assert.equal(qwen.voices.length, 9);
  assert(qwen.voices.some((item) => item.voice === 'vivian'));
  assert.equal(validateVoiceProfiles(profiles), true);
  let getterCalled = false;
  for (const value of [null, {}, [profiles[0], profiles[0]], [{ ...profiles[0], url: 'https://private.example' }],
    [{ ...profiles[0], id: '../voice' }], [{ ...profiles[0], voice: '-unsafe' }], [{ ...profiles[0], voice: '/private/file' }],
    [{ ...profiles[0], description: 'a'.repeat(401) }], [{ ...profiles[0], get name() { getterCalled = true; return 'unsafe'; } }]]) {
    assert.equal(validateVoiceProfiles(value), false);
  }
  assert.equal(getterCalled, false);
});

test('per-request managed voices and explicit Chinese language reach the service without mutating the default', async () => {
  const calls = [];
  const voice = makeVoice({ config: profileConfig, fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return response(); } });
  await Promise.all([voice.synthesize('温柔地说你好', { voiceId: 'gentle', automatic: true }),
    voice.synthesize('活泼地说你好', { voiceId: 'bright', automatic: true })]);
  assert.deepEqual(calls.map((call) => call.voice), ['Serena', 'Vivian']);
  assert(calls.every((call) => call.lang_code === 'chinese'));
  assert.equal(voice.defaultVoiceId, 'gentle'); assert.equal(voice.voice, 'gentle');
  await voice.synthesize('恢复默认声音'); assert.equal(calls.at(-1).voice, 'Serena');
  await assert.rejects(voice.synthesize('未知声音', { voiceId: 'outside' })); assert.equal(calls.length, 3);
  const fixed = makeVoice({ config: { ...profileConfig, ttsAutoVoice: false }, fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(fixed.synthesize('不允许自动变声', { voiceId: 'bright', automatic: true }), /未开启/);
  assert.equal(fixed.selectVoice('bright', { automatic: false }).voice, 'Vivian', 'manual preview remains available');
});

test('Qwen presets and legacy Pascal-case speakers use the model native lowercase IDs', async () => {
  const calls = [];
  const voice = makeVoice({ config: { ...config, ttsModel: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit',
    ttsVoice: 'Serena', ttsAutoVoice: true }, fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return response(); } });
  assert.equal(voice.defaultVoiceId, 'serena');
  assert.equal(voice.voices.length, 9);
  await voice.synthesize('默认温柔声音');
  await voice.synthesize('明亮声音', { voiceId: 'vivian', automatic: true });
  assert.deepEqual(calls.map((call) => call.voice), ['serena', 'vivian']);
});

test('selected macOS profiles use separate argv voice names while legacy local configs retain the system default', async () => {
  const calls = [];
  const voice = makeVoice({ platform: 'darwin', config: { ...profileConfig, ttsProvider: 'macos',
    ttsVoice: 'chinese-gentle', ttsVoiceProfiles: [{ id: 'chinese-gentle', name: '婷婷', voice: 'Tingting' }] },
    binaries: { say: '/fake/say', ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' },
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      if (command === '/fake/say') fs.writeFileSync(args[args.indexOf('-o') + 1], 'AIFF fixture');
      if (command === '/fake/ffprobe') return { stdout: JSON.stringify({ format: { duration: '1.2' } }) };
      if (command === '/fake/ffmpeg') fs.writeFileSync(args.at(-1), AUDIO);
      return { stdout: '' };
    } });
  await voice.synthesize('你好'); assert.deepEqual(calls[0].args.slice(0, 2), ['-v', 'Tingting']);
  assert.equal(buildVoiceCatalog({ ...config, ttsProvider: 'macos' }).voices[0].voice, '');
});

test('voice directory is owner-only passive metadata and AI voice overrides obey the same session authority', async () => {
  const registrations = [], sends = [];
  let identity = { isOwner: true, channel: 'onebot', scope: 'c2c', selfId: '11002', peerId: '11001', sessionId: 'owned' }, calls = 0;
  const voiceOutput = makeVoice({ config: profileConfig, fetchImpl: async () => { calls++; return response(); } });
  const dispose = registerVoiceOutputTool({ tools: { register(tool) { registrations.push(tool); return () => {}; } } }, {
    voiceOutput, getExecutionContext: () => identity,
    qqGateway: { connected: true, online: true, loginVerified: true, selfId: '11002', sendRecord: async (...args) => { sends.push(args); return { ok: true, data: { message_id: 7 } }; } },
  });
  const list = registrations.find((item) => item.name === 'dafeiyu_voice_list'), send = registrations.find((item) => item.name === 'dafeiyu_voice_send');
  const metadata = await list.execute({}, {});
  assert.deepEqual(metadata.voices.map((item) => item.id), ['gentle', 'bright']); assert.equal(metadata.defaultVoiceId, 'gentle');
  assert.equal(calls, 0); assert.equal(sends.length, 0); assert(!JSON.stringify(metadata).includes(PRIVATE));
  assert(!Object.hasOwn(metadata.voices[0], 'voice'));
  assert.deepEqual(send.parameters.properties.voiceId.enum, ['gentle', 'bright']);
  const result = await send.execute({ text: '换个明亮声音', voiceId: 'bright' }, {});
  assert.equal(result.delivered, true); assert.equal(voiceOutput.defaultVoiceId, 'gentle');
  identity = { ...identity, isOwner: false }; assert.throws(() => list.execute({}, {}));
  await assert.rejects(send.execute({ text: '不能发送', voiceId: 'gentle' }, {}));
  assert.equal(calls, 1); assert.equal(sends.length, 1); dispose();
});

test('a same-session duplicate is rejected while synthesis is pending and a later explicit call may succeed', async () => {
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const fixture = toolFixture({ voiceOutput: { async synthesize() { started(); return new Promise((resolve) => { release = () => resolve(AUDIO); }); } } });
  const first = fixture.execute({ text: '一次' }, {}); await ready;
  await assert.rejects(fixture.execute({ text: '一次' }, {}), /正在处理/); release();
  assert.equal((await first).delivered, true); assert.equal(fixture.state.sends.length, 1);
  fixture.voiceOutput.synthesize = async () => AUDIO;
  assert.equal((await fixture.execute({ text: '下一条' }, {})).delivered, true); assert.equal(fixture.state.sends.length, 2);
});

function panelFixture(t, initial = profileConfig) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-preview-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(initial));
  const store = new PrivateConfigStore({ configFile });
  const runtime = { voiceOutput: makeVoice({ config: initial }) };
  return { store, runtime, configFile, panel: new VoicePanel({ store, getRuntime: () => runtime, getBusy: () => false }) };
}

test('owner preview returns bounded playable MP3 without dispatch and requires saved applied settings', async (t) => {
  const f = panelFixture(t), before = fs.readFileSync(f.configFile);
  const snapshot = f.panel.snapshot(); assert.equal(snapshot.pendingReload, false);
  assert.deepEqual(snapshot.voices.map((item) => item.id), ['gentle', 'bright']);
  assert.equal(snapshot.defaultVoiceId, 'gentle');
  const preview = await f.panel.test({ voiceId: 'bright' }, { authorize: () => true });
  assert.equal(preview.generated, true); assert.equal(preview.delivered, false); assert.equal(preview.voiceId, 'bright');
  assert.equal(preview.audio.mime, 'audio/mpeg'); assert.deepEqual(Buffer.from(preview.audio.base64, 'base64'), AUDIO);
  assert.deepEqual(fs.readFileSync(f.configFile), before);
  for (const body of [{ voiceId: 'outside' }, { text: 'a'.repeat(301) }, { voiceId: 'gentle', endpoint: 'https://other.example' }]) {
    await assert.rejects(f.panel.test(body, { authorize: () => true }), { code: 'INVALID_PATCH' });
  }
  await assert.rejects(f.panel.test({}, { authorize: () => false }), { code: 'FORBIDDEN' });
  const saved = f.panel.save({ revision: snapshot.config.revision, patch: { ttsVoice: 'bright', ttsAutoVoice: false } });
  assert.equal(saved.pendingReload, true); assert.equal(f.panel.snapshot().pendingReload, true);
  await assert.rejects(f.panel.test({}, { authorize: () => true }), { code: 'CONFLICT' });
  f.runtime.voiceOutput = makeVoice({ config: { ...profileConfig, ttsVoice: 'bright', ttsAutoVoice: false } });
  assert.equal(f.panel.snapshot().pendingReload, false);
  assert.equal((await f.panel.test({ authorize: () => true })).generated, true, 'legacy voice/check remains compatible');
});

test('preview prevents overlapping work and drops audio if owner authorization or runtime changes', async (t) => {
  const f = panelFixture(t); let resolve, allowed = true;
  f.runtime.voiceOutput.synthesize = async () => new Promise((done) => { resolve = done; });
  const pending = f.panel.test({}, { authorize: () => allowed });
  await assert.rejects(f.panel.test({}, { authorize: () => true }), { code: 'BUSY' });
  assert.throws(() => f.panel.save({ revision: f.panel.snapshot().config.revision, patch: { ttsAutoVoice: false } }), { code: 'BUSY' });
  allowed = false; resolve(AUDIO); await assert.rejects(pending, { code: 'FORBIDDEN' });
  f.runtime.voiceOutput.synthesize = async () => { f.runtime.voiceOutput = makeVoice({ config: profileConfig }); return AUDIO; };
  await assert.rejects(f.panel.test({}, { authorize: () => true }), { code: 'CONFLICT' });
});

test('voice profile saves keep CAS and reject missing defaults, endpoints and duplicate identifiers before writes', (t) => {
  const f = panelFixture(t); const first = f.panel.snapshot();
  for (const patch of [{ ttsVoiceProfiles: [profiles[0], profiles[0]] }, { ttsVoiceProfiles: [{ ...profiles[0], endpoint: 'https://other.example' }] },
    { ttsLanguage: '../private' }, { ttsAutoVoice: 'true' }]) {
    assert.throws(() => f.panel.save({ revision: first.config.revision, patch }), { code: 'INVALID_PATCH' });
  }
  assert.throws(() => f.panel.save({ revision: first.config.revision, patch: { ttsVoice: 'not-in-catalog' } }), { code: 'INVALID_CONFIG' });
  const updated = f.panel.save({ revision: first.config.revision, patch: { ttsVoice: 'bright', ttsLanguage: 'auto' } });
  assert.equal(updated.config.saved.ttsVoice, 'bright');
  assert.equal(JSON.stringify(updated).includes(PRIVATE), false);
  assert.throws(() => f.panel.save({ revision: first.config.revision, patch: { ttsVoice: 'gentle' } }), { code: 'CONFLICT' });
});
