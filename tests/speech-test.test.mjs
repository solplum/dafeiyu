import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testSpeechAudio, MAX_SPEECH_TEST_BYTES, MAX_SPEECH_TEST_BODY } from '../packages/dsh-dafeiyu/src/speech-test.js';

const input = (bytes = Buffer.from('fixture voice'), patch = {}) => ({
  audio: { mime: 'audio/mpeg', base64: bytes.toString('base64') }, fileName: 'sample.mp3', ...patch,
});
const forbidden = (error) => error.code === 'FORBIDDEN';

test('explicit speech test passes a real private bounded temporary file to STT and removes it afterward', async () => {
  const bytes = Buffer.from('fixture voice'); let file, directory, transcriptions = 0;
  const result = await testSpeechAudio(input(bytes), { authorize: () => true, voiceProcessor: {
    sttProvider() {},
    async transcribeFile(value) {
      transcriptions++; file = value; directory = path.dirname(file);
      assert.equal(path.dirname(directory), os.tmpdir()); assert.match(path.basename(directory), /^dafeiyu-speech-test-/);
      assert.equal(path.basename(file), 'input.mp3'); assert.deepEqual(fs.readFileSync(file), bytes);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      return '  实际识别的测试文字  ';
    },
    processInboundVoice() { assert.fail('uploaded test must not be treated as an incoming conversation'); },
    send() { assert.fail('uploaded test must not send QQ'); },
  } });
  assert.equal(transcriptions, 1); assert.equal(result.ok, true); assert.equal(result.text, '实际识别的测试文字');
  assert.equal(result.sentToQQ, false); assert.equal(result.source, 'uploaded-audio');
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(directory), false);
  assert.equal(JSON.stringify(result).includes(directory), false);
});

test('speech test permits exactly 5 MiB and rejects one more byte before calling STT', async () => {
  let calls = 0;
  const bytes = Buffer.alloc(MAX_SPEECH_TEST_BYTES, 7);
  const options = { authorize: () => true, voiceProcessor: { sttProvider() {}, async transcribeFile(file) {
    calls++; assert.equal(fs.statSync(file).size, MAX_SPEECH_TEST_BYTES); return '边界音频';
  } } };
  assert.ok(Buffer.byteLength(JSON.stringify(input(bytes))) <= MAX_SPEECH_TEST_BODY);
  assert.equal((await testSpeechAudio(input(bytes), options)).ok, true); assert.equal(calls, 1);
  await assert.rejects(testSpeechAudio(input(Buffer.alloc(MAX_SPEECH_TEST_BYTES + 1, 7)), options), (error) => error.code === 'INVALID_PATCH');
  assert.equal(calls, 1);
});

for (const [label, body] of [
  ['empty', input(Buffer.alloc(0))],
  ['invalid alphabet', { audio: { mime: 'audio/mpeg', base64: '!!!!' } }],
  ['noncanonical pad bits', { audio: { mime: 'audio/mpeg', base64: 'Zh==' } }],
  ['embedded line break', { audio: { mime: 'audio/mpeg', base64: 'Zg==\n' } }],
  ['URL instead of bytes', { audio: { mime: 'audio/mpeg', base64: 'https://example.test/audio' } }],
  ['HTML MIME', { audio: { mime: 'text/html', base64: 'Zg==' } }],
  ['unknown audio key', { audio: { mime: 'audio/mpeg', base64: 'Zg==', url: 'file:///private/example' } }],
  ['unknown root key', { ...input(), targetQq: 'unexpected-target' }],
  ['array body', []], ['null body', null],
]) test('speech test rejects ' + label + ' without invoking STT', async () => {
  await assert.rejects(testSpeechAudio(body, { authorize: () => true, voiceProcessor: {
    sttProvider() {}, transcribeFile() { assert.fail('invalid audio must not reach STT'); },
  } }), (error) => error.code === 'INVALID_PATCH');
});

test('untrusted uploaded filename cannot choose an output path or non-audio extension', async () => {
  let directory;
  const result = await testSpeechAudio(input(undefined, { fileName: '../../outside.html' }), {
    authorize: () => true, voiceProcessor: { sttProvider() {}, async transcribeFile(file) {
      directory = path.dirname(file); assert.equal(path.basename(file), 'input.audio'); return '文字';
    } },
  });
  assert.equal(result.ok, true); assert.equal(fs.existsSync(directory), false);
});

test('missing owner, busy runtime and missing provider cannot start recognition', async () => {
  const processor = { sttProvider() {}, transcribeFile() { assert.fail('rejected request must not start recognition'); } };
  await assert.rejects(testSpeechAudio(input(), { voiceProcessor: processor }), forbidden);
  await assert.rejects(testSpeechAudio(input(), { authorize: () => true, voiceProcessor: processor, busy: true }), (error) => error.code === 'BUSY');
  await assert.rejects(testSpeechAudio(input(), { authorize: () => true, voiceProcessor: {} }), (error) => error.code === 'UNAVAILABLE');
});

for (const [label, text] of [['empty transcript', ''], ['whitespace transcript', '  \n '], ['non-string transcript', {}], ['oversized transcript', '字'.repeat(32769)]]) {
  test('speech test reports ' + label + ' as failure and still cleans the temporary file', async () => {
    let directory;
    const result = await testSpeechAudio(input(), { authorize: () => true, voiceProcessor: {
      sttProvider() {}, async transcribeFile(file) { directory = path.dirname(file); return text; },
    } });
    assert.equal(result.ok, false); assert.equal(result.sentToQQ, false); assert.equal(result.text, undefined);
    assert.equal(fs.existsSync(directory), false);
  });
}

test('recognition errors are sanitized without exposing private paths or silently retrying', async () => {
  let directory, calls = 0;
  const result = await testSpeechAudio(input(), { authorize: () => true, voiceProcessor: {
    sttProvider() {}, async transcribeFile(file) { directory = path.dirname(file); calls++; throw new Error('secret-key PRIVATE_PATH=' + file); },
  } });
  assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal(fs.existsSync(directory), false);
  assert.doesNotMatch(JSON.stringify(result), /secret-key|PRIVATE_PATH|input\.mp3/);
});

for (const reason of ['owner revoked', 'runtime replaced']) test('speech test rechecks ' + reason + ' after asynchronous recognition', async () => {
  let authorized = true, runtime = {}, file, release, entered;
  const acceptedRuntime = runtime, ready = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  const pending = testSpeechAudio(input(), {
    authorize: () => authorized && runtime === acceptedRuntime,
    voiceProcessor: { sttProvider() {}, async transcribeFile(value) { file = value; entered(); await gate; return '不得回传给失效会话的结果'; } },
  });
  await ready; assert.equal(fs.existsSync(file), true);
  if (reason === 'owner revoked') authorized = false; else runtime = {};
  release(); await assert.rejects(pending, forbidden); assert.equal(fs.existsSync(path.dirname(file)), false);
});
