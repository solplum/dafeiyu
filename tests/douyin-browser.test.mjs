import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DouyinBrowser, douyinReadRequest, buildDouyinReadScript, douyinPageReadExpression, createDouyinToolRunner, registerDouyinBrowserTools } from '../packages/dsh-dafeiyu/src/douyin-browser.js';

const VIDEO = 'https://www.douyin.com/video/1234567890123456789';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+N5XcAAAAASUVORK5CYII=';
const space = 'dfy-douyin-12345678-1234-4234-8234-123456789abc';
function fixture() {
  let authorized = true, gate, fail = false, cleanup = true, state = 'video-observed', calls = [], extra = {};
  const browser = new DouyinBrowser({ enabled: true, runScript: async (job) => {
    calls.push(job); if (job.cleanup) { if (!cleanup) throw new Error('cleanup failure'); return { ok: true, result: { ok: true, cleanupConfirmed: true } }; }
    if (gate) await gate; if (fail) throw new Error('PRIVATE_DIAGNOSTIC /Users/private');
    const request = job.script.includes('"operation":"search"') ? { operation: 'search', url: 'https://www.douyin.com/search/' + encodeURIComponent('公开测试') } : { operation: 'watch', url: VIDEO };
    return { ok: true, result: { ok: true, cleanupConfirmed: true, ...request, state,
      results: request.operation === 'search' ? [{ id: '1234567890123456789', url: VIDEO, title: '公开标题' }] : [],
      ...(state === 'video-observed' && request.operation === 'watch' ? { video: { id: '1234567890123456789', currentTime: 1.5, duration: 10, paused: false, readyState: 4 },
        frames: [{ mime: 'image/png', data: PNG, time: 1.5 }], progressObserved: true } : { frames: [] }), ...extra } };
  } });
  return { browser, calls, options: { authorize: () => authorized }, authorize(value) { authorized = value; }, gate(value) { gate = value; }, fail(value) { fail = value; },
    cleanup(value) { cleanup = value; }, state(value) { state = value; }, extra(value) { extra = value; } };
}

test('Douyin request restricts exact numeric public video URLs and fixed encoded search targets', () => {
  assert.equal(douyinReadRequest({ operation: 'watch', url: VIDEO }).frames, 1);
  assert.equal(douyinReadRequest({ operation: 'search', keyword: '公开 测试' }).url, 'https://www.douyin.com/search/' + encodeURIComponent('公开 测试'));
  for (const url of [VIDEO + '?modal_id=2', VIDEO + '#x', VIDEO.replace('https:', 'http:'), 'https://www.douyin.com.evil.test/video/1234567890123456789', 'https://user:pass@www.douyin.com/video/1234567890123456789', 'file:///private', 'https://creator.douyin.com'])
    assert.throws(() => douyinReadRequest({ operation: 'watch', url }), { code: 'INVALID_ARGS' });
  for (const input of [{ operation: 'watch', url: VIDEO, script: 'click()' }, { operation: 'watch', url: VIDEO, frames: 4 }, { operation: 'watch', url: VIDEO, frames: 0 }, { operation: 'search', keyword: '' }, { operation: 'search', keyword: 'a'.repeat(101) }, { operation: 'search', keyword: 'ok', url: VIDEO }, { operation: 'like', url: VIDEO }])
    assert.throws(() => douyinReadRequest(input), { code: 'INVALID_ARGS' });
});

test('fixed scripts use one owned space, video time, cropped frames and finally cleanup without social-write actions', () => {
  const script = buildDouyinReadScript({ operation: 'watch', url: VIDEO, frames: 3 }, space);
  for (const text of ['taskSpaces.useOrCreate', 'currentTime', 'page.screenshot', 'taskSpaces.complete', 'keep:false', 'finally']) assert.ok(script.includes(text));
  for (const forbidden of ['.click(', 'setInputFiles', 'fetch(', 'download', 'get_by_role', 'ego_cli']) assert.equal(script.includes(forbidden), false, forbidden);
  assert.equal(script.includes(VIDEO), true); assert.throws(() => buildDouyinReadScript({ operation: 'watch', url: VIDEO }, 'default'));
});

test('passive status never starts browsing; sampling reports exact time and never claims full viewing', async () => {
  const f = fixture(); assert.equal(f.browser.status.readiness, 'not-verified'); assert.equal(f.calls.length, 0);
  const result = await f.browser.browse({ operation: 'watch', url: VIDEO }, f.options);
  assert.equal(f.calls.length, 1); assert.equal(result.video.currentTime, 1.5); assert.equal(result.frameCount, 1); assert.equal(result.progressObserved, true);
  assert.match(result.note, /不表示完整看完/); assert.equal(f.browser.status.readiness, 'read-verified');
});

test('search results stay explicit metadata and do not claim video frames or watching', async () => {
  const f = fixture(), result = await f.browser.browse({ operation: 'search', keyword: '公开测试' }, f.options);
  assert.equal(result.state, 'search-read'); assert.equal(result.videos.length, 1); assert.equal(result.frameCount, 0); assert.equal(result.video, null); assert.match(result.note, /尚未观看/);
});

for (const state of ['needs-login', 'verification-required', 'no-content', 'private-overlay']) test('platform obstacle ' + state + ' is truthful and never prompts bypass', async () => {
  const f = fixture(); f.state(state); const result = await f.browser.browse({ operation: 'watch', url: VIDEO }, f.options);
  assert.equal(result.ok, false); assert.equal(result.state, state); assert.equal(result.frameCount, 0); assert.equal(f.calls.length, 1);
  if (state === 'needs-login') assert.equal(f.browser.status.readiness, 'needs-login');
});

test('missing authority, cancelled signal and disabled capability reject before any tool call', async () => {
  const f = fixture(); await assert.rejects(f.browser.browse({ operation: 'watch', url: VIDEO }), { code: 'FORBIDDEN' });
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.browser.browse({ operation: 'watch', url: VIDEO }, { ...f.options, signal: controller.signal }), { code: 'CANCELLED' });
  f.browser.enabled = false; await assert.rejects(f.browser.browse({ operation: 'watch', url: VIDEO }, f.options), { code: 'UNAVAILABLE' }); assert.equal(f.calls.length, 0);
});

test('only one read runs, late authority loss suppresses it, and a completed cleanup is not marked unknown', async () => {
  const f = fixture(); let release; f.gate(new Promise((resolve) => { release = resolve; }));
  const pending = f.browser.browse({ operation: 'watch', url: VIDEO }, f.options);
  await assert.rejects(f.browser.browse({ operation: 'watch', url: VIDEO }, f.options), { code: 'BUSY' });
  f.authorize(false); release(); await assert.rejects(pending, { code: 'FORBIDDEN' }); assert.equal(f.browser.cleanupPending, false); assert.equal(f.calls.length, 1);
});

test('failed cleanup blocks further reads and errors do not expose raw runtime output', async () => {
  const f = fixture(); f.fail(true); f.cleanup(false);
  await assert.rejects(f.browser.browse({ operation: 'watch', url: VIDEO }, f.options), (error) => error.code === 'READ_FAILED' && !error.message.includes('PRIVATE'));
  assert.equal(f.browser.status.cleanupPending, true); assert.equal(f.calls.length, 2);
  await assert.rejects(f.browser.browse({ operation: 'watch', url: VIDEO }, f.options), { code: 'BUSY' }); assert.equal(f.calls.length, 2);
});

test('disposal cancels the active read and awaits its actual settlement instead of releasing early', async () => {
  const f = fixture(); let release; f.gate(new Promise((resolve) => { release = resolve; }));
  const pending = f.browser.browse({ operation: 'watch', url: VIDEO }, f.options); let disposed = false;
  const disposing = f.browser.dispose().then(() => { disposed = true; });
  assert.equal(f.calls[0].signal.aborted, true); await Promise.resolve(); assert.equal(disposed, false);
  release(); await assert.rejects(pending, { code: 'CANCELLED' }); await disposing; assert.equal(f.browser.active, 0); assert.equal(f.browser.cleanupPending, false);
});

test('malformed image, mismatched video and arbitrary image URL are rejected without pretending cleanup failed', async () => {
  for (const extra of [{ video: { id: '9999999999999999999', currentTime: 1 } }, { frames: [{ mime: 'image/png', data: 'https://evil.test/frame.png', time: 1 }] }, { frames: Array(4).fill({ mime: 'image/png', data: PNG, time: 1 }) }]) {
    const f = fixture(); f.extra(extra); await assert.rejects(f.browser.browse({ operation: 'watch', url: VIDEO }, f.options), { code: 'INVALID_RESPONSE' }); assert.equal(f.browser.cleanupPending, false);
  }
});

test('page reader classifies login/captcha before copying page text and refuses wrong origins', () => {
  const document = { body: { innerText: '扫码登录后继续 PRIVATE_PAGE_TEXT' }, querySelectorAll: () => [] };
  const context = { document, location: { origin: 'https://www.douyin.com', pathname: '/video/1234567890123456789' }, getComputedStyle: () => ({}), innerHeight: 800, innerWidth: 1200 };
  const login = vm.runInNewContext(douyinPageReadExpression('1234567890123456789'), context); assert.equal(login.state, 'needs-login'); assert.equal(JSON.stringify(login).includes('PRIVATE'), false);
  document.body.innerText = '安全验证'; assert.equal(vm.runInNewContext(douyinPageReadExpression(), context).state, 'verification-required');
  document.body.innerText = ''; document.title = '验证码中间页'; assert.equal(vm.runInNewContext(douyinPageReadExpression(), context).state, 'verification-required');
  context.location.origin = 'https://evil.test'; assert.equal(vm.runInNewContext(douyinPageReadExpression(), context).state, 'wrong-origin');
});

test('native runner uses only canonical exact ego_script dispatch through controlAccess grant', async () => {
  const calls = [], agent = {}, parent = {}, signal = new AbortController().signal;
  const access = { async executeTrustedBrowserRead(job, operation) { assert.equal(job.agent, agent); return operation({ callId: 'fixed-proof', arguments: { script: 'fixed', timeoutMs: 10000 }, signal, authorize: () => true }); } };
  const runner = createDouyinToolRunner({ ctx: {}, controlAccess: access, callTool: async (request) => { calls.push(request); return { ok: true, result: { cleanupConfirmed: true } }; } });
  await runner({ agent, parent, script: 'fixed', space, timeoutMs: 10000 }); assert.equal(calls.length, 1); assert.equal(calls[0].name, 'ego_script');
  assert.equal(calls[0].callId, 'fixed-proof'); assert.equal(calls[0].parent, parent); assert.equal(calls[0].signal, signal);
});

test('registered tool needs owner/live task browser capability and saves at most sampled frames as attachments', async () => {
  const f = fixture(); let definition, current = { isOwner: true, sessionId: 'owner', peerId: 'p', selfId: 's' }, scope = { kind: 'owner', taskId: 'task-1', capabilities: ['browser'] }, saved = 0;
  const ctx = { tools: { register(value) { definition = value; return () => {}; } }, get: () => ({ async saveImage({ mediaType }) { saved++; assert.equal(mediaType, 'image/png'); return { id: 'owned-frame' }; } }) };
  const dispose = registerDouyinBrowserTools(ctx, { browser: f.browser, getExecutionContext: () => current, controlAccess: { scopeFor: () => scope } });
  const execution = { agent: {}, signal: new AbortController().signal };
  assert.equal(definition.name, 'dafeiyu_douyin_browse'); assert.equal(Object.hasOwn(definition.parameters.properties, 'script'), false);
  const result = await definition.execute({ operation: 'watch', url: VIDEO }, execution); assert.equal(saved, 1); assert.equal(result.displayedFrames, 1); assert.equal(result.images[0].id, 'owned-frame');
  current = { ...current, isOwner: false }; await assert.rejects(definition.execute({ operation: 'watch', url: VIDEO }, execution), { code: 'FORBIDDEN' });
  current = { ...current, isOwner: true }; scope = { ...scope, capabilities: [] }; await assert.rejects(definition.execute({ operation: 'watch', url: VIDEO }, execution), { code: 'FORBIDDEN' });
  dispose(); await assert.rejects(definition.execute({ operation: 'watch', url: VIDEO }, execution), { code: 'FORBIDDEN' });
});
