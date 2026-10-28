import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanionToolRegistry } from '../packages/dsh-dafeiyu/src/companion-tool-registry.js';

const owner = { userId: 'fixture-owner', key: 'private:fixture-owner', isGroup: false };
function fixture(t, result) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-bridge-reliability-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const audio = path.join(directory, 'fixture.m4a');
  fs.writeFileSync(audio, Buffer.alloc(150));
  const registry = new CompanionToolRegistry({ ownerQq: owner.userId, phoneEnabled: true,
    phoneTools: { enabled: true, listen: async () => ({ path: audio, ...result }) } });
  return { audio, registry };
}

test('the model bridge preserves measured short recordings instead of reporting the requested duration', async (t) => {
  const { registry } = fixture(t, { ok: true, requestedSeconds: 3, actualDurationSeconds: 1.31,
    duration: 1.31, durationStatus: 'measured', partial: true, text: 'fixture transcription' });
  const { output } = await registry.execute('phone_listen', { seconds: 3 }, owner);
  assert.equal(output.requestedSeconds, 3); assert.equal(output.actualDurationSeconds, 1.31);
  assert.equal(output.duration, 1.31); assert.equal(output.partial, true);
  assert.equal(output.transcribed, true); assert.equal(output.text, 'fixture transcription');
});

test('the bridge does not infer actual duration from a legacy requested-duration field', async (t) => {
  const { registry } = fixture(t, { ok: true, duration: 3 });
  const { output } = await registry.execute('phone_listen', { seconds: 3 }, owner);
  assert.equal(output.audioSaved, true); assert.equal(output.requestedSeconds, 3);
  assert.equal(output.actualDurationSeconds, null); assert.equal(output.duration, null);
  assert.equal(output.durationStatus, 'unknown'); assert.equal(output.partial, null);
  assert.equal(output.transcribed, false);
});

test('transcription failure keeps the actual audio path and measured duration without retrying STT', async (t) => {
  const { audio, registry } = fixture(t, { ok: false, requestedSeconds: 3, actualDurationSeconds: 1.31,
    durationStatus: 'measured', partial: true, error: 'fixture STT returned no text' });
  registry.voiceProcessor = { sttProvider() {}, transcribeFile() { assert.fail('must not retry a failed transcription'); } };
  const { output } = await registry.execute('phone_listen', { seconds: 3 }, owner);
  assert.equal(output.ok, false); assert.equal(output.audioSaved, true); assert.equal(output.path, audio);
  assert.equal(output.actualDurationSeconds, 1.31); assert.equal(output.partial, true);
  assert.equal(output.transcribed, false); assert.match(output.error, /no text/);
});
