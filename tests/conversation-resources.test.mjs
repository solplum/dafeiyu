import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhoneTools } from '../packages/dsh-dafeiyu/src/phone-tools.js';
import { VoiceProcessor } from '../packages/dsh-dafeiyu/src/voice-processor.js';

function phoneFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-conversation-resources-'));
  const authorized = new Set(['qq', 'desktop']);
  const phone = new PhoneTools({ device: 'fixture-device', shotDir: root, enabled: true,
    allowedTools: ['phone_key', 'phone_get_ui_tree'],
    getExecutionContext: ({ agent }) => ({ isOwner: authorized.has(agent), scope: 'c2c' }),
    runCommand: async () => { throw new Error('fixture must not execute ADB'); } });
  const tools = new Map(phone.registerToCordis({ tools: { register: () => () => {} } }).map((tool) => [tool.name, tool]));
  t.after(() => { phone.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { phone, tools, authorized };
}

test('QQ and desktop tools serialize access to the same physical phone', async (t) => {
  const { phone, tools } = phoneFixture(t);
  const events = [];
  let release;
  phone.key = async () => { events.push('key:start'); await new Promise((resolve) => { release = resolve; }); events.push('key:end'); return { ok: true }; };
  phone.getUiTree = async () => { events.push('ui'); return { ok: true }; };
  const key = tools.get('phone_key').execute({ key: 'back' }, { agent: 'qq' });
  const ui = tools.get('phone_get_ui_tree').execute({}, { agent: 'desktop' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['key:start']);
  assert.equal(phone.active, 2);
  release();
  await Promise.all([key, ui]);
  assert.deepEqual(events, ['key:start', 'key:end', 'ui']);
  assert.equal(phone.active, 0);
});

test('a waiting phone tool rechecks conversation authority and cancellation before any device command', async (t) => {
  const { phone, tools, authorized } = phoneFixture(t);
  let release, uiCalls = 0;
  phone.key = async () => { await new Promise((resolve) => { release = resolve; }); return { ok: true }; };
  phone.getUiTree = async () => { uiCalls++; return { ok: true }; };
  const key = tools.get('phone_key').execute({ key: 'back' }, { agent: 'qq' });
  const ui = tools.get('phone_get_ui_tree').execute({}, { agent: 'desktop' });
  const abort = new AbortController();
  const cancelled = tools.get('phone_get_ui_tree').execute({}, { agent: 'qq', signal: abort.signal });
  const denied = assert.rejects(ui, /仅允许已绑定主人/);
  const stopped = assert.rejects(cancelled, /aborted|取消/i);
  await new Promise((resolve) => setImmediate(resolve));
  authorized.delete('desktop');
  abort.abort();
  release();
  await Promise.all([key, denied, stopped]);
  assert.equal(uiCalls, 0);
  assert.equal(phone.active, 0);
});

test('stopping voice preparation aborts its download, skips STT, and removes temporary audio', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let started, networkAborted = false, sttCalls = 0;
  const downloading = new Promise((resolve) => { started = resolve; });
  const voice = new VoiceProcessor({ tempDir: root, sttProvider: async () => { sttCalls++; return 'must not run'; },
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { networkAborted = true; reject(new Error('download aborted')); }, { once: true });
      started();
    }) });
  const abort = new AbortController();
  const pending = voice.processInboundVoice({ message: [{ type: 'record', data: { url: 'https://fixture.invalid/audio' } }] }, { signal: abort.signal });
  await downloading;
  abort.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(networkAborted, true);
  assert.equal(sttCalls, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});
