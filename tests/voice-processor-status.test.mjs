import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceProcessor } from '../packages/phone-mcp/src/shared/voice-processor.js';

const wav = Buffer.alloc(48); wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8);
const record = { message: [{ type: 'record', data: { file: 'PRIVATE_RECORD_REFERENCE', url: 'https://private.invalid/PRIVATE_URL' } }] };
const preparationNote = '最近语音读取或转换失败，未开始转写';
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-status-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const processor = new VoiceProcessor({ tempDir: directory, ...options });
  let current = processor.lastResult, writes = 0;
  Object.defineProperty(processor, 'lastResult', { configurable: true, get: () => current,
    set: (value) => { current = value; writes++; } });
  return { processor, directory, get writes() { return writes; } };
}

test('a resolver failure replaces an earlier successful status with one current safe result without calling STT again', async (t) => {
  let sttCalls = 0, resolutions = 0;
  const f = fixture(t, { fetchImpl: () => assert.fail('resolver must not fall back to downloading'),
    sttProvider: async () => { sttCalls++; assert.equal(f.processor.active, 1); return '实际识别文字'; } });
  const good = await f.processor.processInboundVoice(record, { resolveRecord: async () => wav });
  assert.equal(good.ok, true); assert.equal(f.processor.status.readiness, 'ready');
  const previous = f.processor.lastResult;
  previous.at = '2000-01-01T00:00:00.000Z';
  const before = Date.now();
  const result = await f.processor.processInboundVoice(record, { resolveRecord: async () => {
    resolutions++; assert.equal(f.processor.active, 0); throw new Error('PRIVATE_ERROR /app/PRIVATE_FILE');
  } });
  assert.equal(result.ok, false); assert.equal(sttCalls, 1); assert.equal(resolutions, 1);
  assert.equal(f.writes, 2, 'each completed pipeline wrote exactly one result');
  const status = f.processor.status;
  assert.equal(status.active, 0); assert.equal(status.readiness, 'failed');
  assert.notEqual(status.lastResult, previous);
  assert.deepEqual(Object.keys(status.lastResult).sort(), ['at', 'note', 'ok']);
  assert.equal(status.lastResult.ok, false); assert.equal(status.lastResult.note, preparationNote);
  assert.ok(Date.parse(status.lastResult.at) >= before && Date.parse(status.lastResult.at) <= Date.now());
  assert.equal(result.text, '[语音处理失败]: ' + preparationNote);
  assert.doesNotMatch(JSON.stringify({ status, result }), /PRIVATE|private\.invalid|\/app\//);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

for (const [name, input, resolveRecord] of [
  ['missing source', { message: [{ type: 'record', data: {} }] }, undefined],
  ['invalid source type', { message: [{ type: 'record', data: { file: { PRIVATE: true } } }] }, undefined],
  ['invalid file URL', { message: [{ type: 'record', data: { file: 'file://PRIVATE_HOST/PRIVATE_FILE' } }] }, undefined],
  ['invalid resolved audio', record, async () => Buffer.alloc(0)],
]) test(name + ' records one bounded preparation failure without transcription', async (t) => {
  let resolves = 0;
  const f = fixture(t, { sttProvider: () => assert.fail('unprepared audio must not reach STT'),
    fetchImpl: () => assert.fail('invalid sources must not download') });
  const result = await f.processor.processInboundVoice(input, { resolveRecord: resolveRecord ? async (...args) => {
    resolves++; return resolveRecord(...args);
  } : undefined });
  assert.equal(result.ok, false); assert.equal(f.writes, 1); assert.equal(resolves, resolveRecord ? 1 : 0);
  assert.equal(f.processor.status.readiness, 'failed'); assert.equal(f.processor.active, 0);
  assert.equal(f.processor.lastResult.note, preparationNote);
  assert.doesNotMatch(JSON.stringify({ status: f.processor.status, result }), /PRIVATE/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('download preparation failure records a safe current status without retry or STT', async (t) => {
  let fetches = 0;
  const f = fixture(t, { sttProvider: () => assert.fail('failed download must not reach STT'), fetchImpl: async () => {
    fetches++; assert.equal(f.processor.active, 0); throw new Error('PRIVATE_NETWORK_ERROR https://private.invalid/PRIVATE_URL');
  } });
  const result = await f.processor.processInboundVoice(record);
  assert.equal(result.ok, false); assert.equal(fetches, 1); assert.equal(f.writes, 1);
  assert.equal(f.processor.active, 0); assert.equal(f.processor.status.readiness, 'failed');
  assert.equal(f.processor.lastResult.note, preparationNote);
  assert.doesNotMatch(JSON.stringify({ status: f.processor.status, result }), /PRIVATE|private\.invalid/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

for (const mode of ['failure', 'empty', 'cancelled']) test('entered transcription ' + mode + ' keeps its original single-result and active semantics', async (t) => {
  let calls = 0; const controller = new AbortController();
  const f = fixture(t, { sttProvider: async () => {
    calls++; assert.equal(f.processor.active, 1);
    if (mode === 'failure') throw new Error('PRIVATE_STT_ERROR');
    if (mode === 'cancelled') controller.abort(new Error('PRIVATE_CANCEL_REASON'));
    return mode === 'empty' ? '' : '稍后取消的识别文字';
  } });
  const result = await f.processor.processInboundVoice(record, { signal: controller.signal, resolveRecord: async () => wav });
  assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal(f.writes, 1);
  assert.equal(f.processor.active, 0); assert.equal(f.processor.status.readiness, 'failed');
  assert.equal(f.processor.lastResult.note, '最近音频转写失败或没有文字');
  assert.doesNotMatch(JSON.stringify(f.processor.status), /PRIVATE/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});
