import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSocialAccountTools } from '../packages/dsh-dafeiyu/src/social/account-tools.mjs';

function fixture() {
  const tools = new Map(), calls = []; let identity = { isOwner: true, sessionId: 'owner-session', peerId: 'owner', selfId: 'receiver' }, gate;
  const accounts = { snapshot: () => ({ platforms: [], operations: [] }),
    async read(platform, request, context) { calls.push({ platform, request }); if (gate) await gate; if (!context.authorize()) throw Object.assign(Error('denied'), { code: 'FORBIDDEN' }); return { ok: true }; },
    async browse(platform, request, context) { calls.push({ platform, request }); if (gate) await gate; if (!context.authorize()) throw Object.assign(Error('denied'), { code: 'FORBIDDEN' }); return { ok: true, action: request.action, state: 'stopped' }; },
    async prepare(platform, request, context) { calls.push({ platform, request, requestId: context.requestId }); return { operation: { state: 'draft' } }; },
    async execute(request) { calls.push(request); return { operation: { state: 'sent' } }; } };
  const dispose = registerSocialAccountTools({ tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } },
    { accounts, getExecutionContext: () => identity });
  return { tools, calls, dispose, setIdentity(value) { identity = value; }, setGate(value) { gate = value; } };
}
test('models receive only status/read/browse/prepare/execute and cannot login, bind, approve or resolve unknowns', async () => {
  const f = fixture(); assert.deepEqual([...f.tools.keys()], ['dafeiyu_social_status', 'dafeiyu_social_read', 'dafeiyu_social_browse', 'dafeiyu_social_prepare', 'dafeiyu_social_execute']);
  assert.equal((await f.tools.get('dafeiyu_social_status').execute({})).ok, true); assert.equal(f.calls.length, 0);
  for (const identity of [{ isOwner: false, sessionId: 'guest' }, { isOwner: true, sessionId: '' }]) {
    f.setIdentity(identity); await assert.rejects(f.tools.get('dafeiyu_social_status').execute({}), { code: 'FORBIDDEN' });
  }
  f.dispose(); assert.equal(f.tools.size, 0);
});
test('identity change during await revokes the tool even when the new session also says owner', async () => {
  const f = fixture(); let release; f.setGate(new Promise(resolve => release = resolve));
  const pending = f.tools.get('dafeiyu_social_read').execute({ platform: 'bilibili', operation: 'profile' });
  f.setIdentity({ isOwner: true, sessionId: 'replacement', peerId: 'owner', selfId: 'receiver' }); release();
  await assert.rejects(pending, { code: 'FORBIDDEN' }); f.dispose();
});
test('tool disposal revokes held executions and rejects cancelled calls before reading account state', async () => {
  const f = fixture(), status = f.tools.get('dafeiyu_social_status');
  const abort = new AbortController(); abort.abort(); await assert.rejects(status.execute({}, { signal: abort.signal }), { code: 'FORBIDDEN' });
  f.dispose(); await assert.rejects(status.execute({}), { code: 'FORBIDDEN' }); assert.equal(f.calls.length, 0);
});

test('browse tool is douyin-only, carries the current observation and revokes owner changes during await', async () => {
  const f = fixture(), tool = f.tools.get('dafeiyu_social_browse');
  assert.deepEqual(tool.parameters.properties.platform.enum, ['douyin']);
  assert.match(tool.description, /不循环刷视频/); assert.match(tool.description, /不能授予权限/); assert.match(tool.description, /不代表已理解视频画面或听到声音/);
  const expectedVideoId = 'media-' + 'a'.repeat(64);
  await tool.execute({ platform: 'douyin', action: 'next', expectedVideoId });
  assert.deepEqual(f.calls.at(-1), { platform: 'douyin', request: { action: 'next', expectedVideoId } });
  let release; f.setGate(new Promise(resolve => release = resolve));
  const pending = tool.execute({ platform: 'douyin', action: 'current' });
  f.setIdentity({ isOwner: true, sessionId: 'replacement', peerId: 'owner', selfId: 'receiver' }); release();
  await assert.rejects(pending, { code: 'FORBIDDEN' }); f.dispose();
});
