import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareOneBotImages, qqImageUrl } from '../packages/dsh-dafeiyu/src/onebot-image-input.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
function fixture({ supportsImage = true, maxImages = 4, saveImages } = {}) {
  const calls = { metadata: 0, reads: 0, saves: [], authorized: 0 };
  const attachments = { imageLimits: { maxImagesPerMessage: maxImages, maxMessageImageBytes: 1024, mediaTypes: ['image/png'] },
    async saveImages(inputs) { calls.saves.push(inputs); return saveImages ? saveImages(inputs) : inputs.map((v, i) => ({ id: 'durable-' + i, mediaType: v.mediaType, width: 1, height: 1 })); } };
  const llm = { async resolveModelInfo(provider, id) { calls.metadata++; return { provider, id, inputModalities: supportsImage ? ['text', 'image'] : ['text'] }; },
    imageRequestPricing() { return { priceImages() {} }; } };
  return { calls, options: { ctx: { get: name => ({ llm, attachments })[name] }, gateway: { async api() { calls.reads++; throw new Error('unexpected get_image'); } },
    images: [{ type: 'image', file: 'base64://' + png.toString('base64') }], selection: { provider: 'fixture', model: 'exact' },
    authorize() { calls.authorized++; }, fetchImpl() { calls.reads++; throw new Error('unexpected network read'); } } };
}
test('real image bytes are stored by the host and only durable image refs enter message content', async () => {
  const f = fixture(); const content = await prepareOneBotImages(f.options);
  assert.deepEqual(Buffer.from(f.calls.saves[0][0].data), png);
  assert.equal(f.calls.saves[0][0].mediaType, 'image/png');
  assert.deepEqual(content, [{ type: 'image', attachment: { id: 'durable-0', mediaType: 'image/png', width: 1, height: 1 } }]);
  assert.equal(f.calls.reads, 0); assert.ok(f.calls.authorized >= 4);
  assert.doesNotMatch(JSON.stringify(content), /base64|qpic|file:\/\//);
});
test('text-only or unknown model and missing host projection stop before reading any image', async () => {
  const f = fixture({ supportsImage: false });
  await assert.rejects(prepareOneBotImages(f.options), { code: 'IMAGE_UNAVAILABLE' });
  assert.equal(f.calls.reads, 0); assert.equal(f.calls.saves.length, 0);
  const g = fixture(); g.options.ctx.get('llm').imageRequestPricing = () => undefined;
  await assert.rejects(prepareOneBotImages(g.options), { code: 'IMAGE_UNAVAILABLE' });
  assert.equal(g.calls.saves.length, 0);
});
test('image count, canonical bytes, format, host rejection and revoked admission all fail before model publication', async () => {
  const f = fixture({ maxImages: 1 }); f.options.images.push(f.options.images[0]);
  await assert.rejects(prepareOneBotImages(f.options), { code: 'IMAGE_INPUT_FAILED' }); assert.equal(f.calls.saves.length, 0);
  const g = fixture(); g.options.images[0].file = 'base64://AAAA=';
  await assert.rejects(prepareOneBotImages(g.options), { code: 'IMAGE_INPUT_FAILED' });
  const h = fixture(); h.options.images[0].file = 'base64://' + Buffer.from('not an image').toString('base64');
  await assert.rejects(prepareOneBotImages(h.options), { code: 'IMAGE_INPUT_FAILED' }); assert.equal(h.calls.saves.length, 0);
  const j = fixture({ saveImages() { throw new Error('private host failure'); } });
  await assert.rejects(prepareOneBotImages(j.options), error => error.code === 'IMAGE_INPUT_FAILED' && !error.message.includes('private'));
  const k = fixture(); k.options.authorize = () => { throw new Error('revoked'); };
  await assert.rejects(prepareOneBotImages(k.options)); assert.equal(k.calls.metadata, 0);
});
test('QQ media URL boundary refuses local files, unrelated origins, userinfo, ports and redirect escapes', async () => {
  assert.equal(qqImageUrl('https://multimedia.nt.qq.com.cn/image?a=1'), 'https://multimedia.nt.qq.com.cn/image?a=1');
  for (const url of ['http://gchat.qpic.cn/x', 'https://127.0.0.1/x', 'file:///private/x', 'https://qq.com.evil.test/x',
    'https://name:secret@gchat.qpic.cn/x', 'https://gchat.qpic.cn:444/x', 'https://gchat.qpic.cn/x#token', 'https://qq.com/x', 'https://arbitrary.qq.com.cn/x']) assert.throws(() => qqImageUrl(url));
  const f = fixture(); f.options.images = [{ type: 'image', url: 'https://gchat.qpic.cn/test' }];
  let requested = 0; f.options.fetchImpl = async () => { requested++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); };
  await assert.rejects(prepareOneBotImages(f.options), { code: 'IMAGE_INPUT_FAILED' }); assert.equal(requested, 1); assert.equal(f.calls.saves.length, 0);
});
test('current QQ CDN bytes stream under a bound; local container paths and oversized streams are never admitted', async () => {
  const f = fixture(); f.options.images = [{ type: 'mface', url: 'https://gxh.vip.qq.com/test' }];
  f.options.fetchImpl = async () => new Response(png);
  assert.equal((await prepareOneBotImages(f.options))[0].attachment.mediaType, 'image/png');
  const g = fixture(); g.options.images = [{ type: 'image', file: '/root/private/image.png' }];
  await assert.rejects(prepareOneBotImages(g.options), { code: 'IMAGE_INPUT_FAILED' }); assert.equal(g.calls.reads, 0);
  const h = fixture(); h.options.images = [{ type: 'image', url: 'https://gchat.qpic.cn/test' }];
  h.options.fetchImpl = async () => new Response(Buffer.alloc(1025));
  await assert.rejects(prepareOneBotImages(h.options), { code: 'IMAGE_INPUT_FAILED' }); assert.equal(h.calls.saves.length, 0);
});

test('opaque image handle resolves once through the gateway and ignores returned container paths', async () => {
  const f = fixture(); f.options.images = [{ type: 'image', file: '{opaque}.png' }];
  let calls = 0;
  f.options.gateway.api = async (action, params, options) => {
    calls++; assert.equal(action, 'get_image'); assert.deepEqual(params, { file: '{opaque}.png' });
    assert.equal(options.singleAttempt, true); assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, data: { file: '/root/not-a-local-file.png', url: 'https://multimedia.nt.qq.com.cn/fixture' } };
  };
  f.options.fetchImpl = async () => new Response(png);
  assert.equal((await prepareOneBotImages(f.options))[0].type, 'image'); assert.equal(calls, 1);
  const g = fixture(); g.options.images = [{ type: 'image', url: 'https://gchat.qpic.cn/test', fileSize: '1025' }];
  await assert.rejects(prepareOneBotImages(g.options), { code: 'IMAGE_INPUT_FAILED' }); assert.equal(g.calls.reads, 0);
});
test('cancellation covers model metadata resolution and never leaves a later image read behind', async () => {
  const f = fixture(), controller = new AbortController(); f.options.signal = controller.signal;
  let release;
  f.options.ctx.get('llm').resolveModelInfo = () => new Promise(resolve => { release = resolve; });
  const pending = prepareOneBotImages(f.options); controller.abort();
  await assert.rejects(pending);
  release({ provider: 'fixture', id: 'exact', inputModalities: ['text', 'image'] });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.reads, 0); assert.equal(f.calls.saves.length, 0);
});
