import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateContextRequest, CONTEXT_REQUEST_SIZE_LIMITS } from '../packages/dsh-dafeiyu/src/context-request-size.js';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const message = (role, content, extra = {}) => ({ role, content, ...extra });
const text = value => ({ type: 'text', text: value });
const request = (patch = {}) => ({ provider: 'fixture-provider', model: 'fixture-model', maxTokens: 4096,
  messages: [message('system', [text('system context')]), message('user', [text('hello')])], ...patch });
const image = (offloaded = false) => ({ type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64),
  mediaType: 'image/png', width: 1280, height: 720, bytes: 4096, name: 'PRIVATE_IMAGE_NAME' }, ...(offloaded ? { offloaded: true } : {}) });
const file = () => ({ type: 'file', attachment: { attachmentId: 'sha256:' + 'b'.repeat(64),
  mediaType: 'application/pdf', bytes: 12345, name: 'PRIVATE_FILE_NAME' } });
const rejects = (run, code) => assert.throws(run, error => {
  assert.equal(error.code, code); assert.doesNotMatch(String(error.message), /PRIVATE_|SECRET_|fixture-provider|fixture-model/); return true;
});

test('frozen whole requests count every message, tool result, reasoning and historical tool declaration without mutation', () => {
  const options = freeze(request({ messages: [
    message('system', [text('PRIVATE_SYSTEM')]), message('user', [text('PRIVATE_USER')]),
    message('assistant', [{ type: 'reasoning', text: 'PRIVATE_THINKING' }, { type: 'tool-call', id: 'call-1', name: 'tool_one', arguments: '{"q":"PRIVATE_ARGUMENT"}' }],
      { source: { kind: 'model', provider: 'fixture-provider', model: 'fixture-model', replayState: {
        response: { kind: 'deepseek-messages', version: 1, model: 'fixture-model' },
        blocks: [{ type: 'reasoning', signature: 'PRIVATE_SIGNATURE' }, { type: 'tool-call' }] } } }),
    message('tool', [text('PRIVATE_RESULT_ONE')], { toolCallId: 'call-1', isError: false }),
    message('tool', [text('PRIVATE_RESULT_TWO')], { toolCallId: 'call-2', isError: true }),
    message('developer', [{ type: 'tool-addition', toolName: 'old_tool' }, { type: 'tool-removal', toolName: 'old_tool' }]),
  ], tools: [{ name: 'tool_one', description: 'PRIVATE_TOOL_DESCRIPTION', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
  toolHistory: { tools: [], updates: [{ messageId: 'update-1', additions: [{ name: 'old_tool', parameters: { type: 'object' }, description: 'PRIVATE_OLD_SCHEMA' }] }] } }));
  const before = JSON.stringify(options), measured = estimateContextRequest(options);
  assert.equal(JSON.stringify(options), before); assert.equal(measured.outputTokens, 4096);
  assert.equal(measured.estimated, true); assert.equal(measured.source, 'utf8-conservative-v1');
  assert.ok(Number.isSafeInteger(measured.inputTokens)); assert.ok(measured.inputTokens >= Buffer.byteLength(before) - 200);
  assert.deepEqual(Object.keys(measured).sort(), ['estimated', 'inputTokens', 'outputTokens', 'source']);
  assert.doesNotMatch(JSON.stringify(measured), /PRIVATE_|fixture-/);
});

test('UTF8 estimation does not apply chars-per-four to Chinese, emoji or escaped content', () => {
  const value = '中文内容'.repeat(200) + '🐳'.repeat(100) + '\n\\"'.repeat(100);
  const base = estimateContextRequest(request({ messages: [message('user', [text('')])] })).inputTokens;
  const measured = estimateContextRequest(request({ messages: [message('user', [text(value)])] })).inputTokens;
  assert.ok(measured - base >= Buffer.byteLength(value, 'utf8'));
  assert.ok(measured - base > value.length);
});

test('tool schemas, tool-history additions and opaque replay signatures contribute to the whole request', () => {
  const options = request(), base = estimateContextRequest(options).inputTokens;
  for (const patch of [
    { tools: [{ name: 'large_schema', parameters: { enum: ['schema'.repeat(1000)] } }] },
    { toolHistory: { tools: [], updates: [{ additions: [{ name: 'historical_schema', description: 'old'.repeat(1000) }] }] } },
    { messages: [message('assistant', [text('answer')], { source: { kind: 'model', replayState: { signature: 'sig'.repeat(1000) } } })] },
  ]) assert.ok(estimateContextRequest(request(patch)).inputTokens > base + 2000);
});

test('request-level system and stop strings are counted independently of message history, with typed controls', () => {
  const base = estimateContextRequest(request()).inputTokens;
  const system = estimateContextRequest(request({ system: 'PRIVATE_SYSTEM_FIELD'.repeat(1000) })).inputTokens;
  const stop = estimateContextRequest(request({ stop: ['PRIVATE_STOP'.repeat(1000)], temperature: 0.6, reasoningEffort: 'high' })).inputTokens;
  assert.ok(system > base + 18000); assert.ok(stop > base + 10000);
  for (const patch of [{ system: {} }, { stop: 'not-array' }, { stop: [7] }, { temperature: Infinity }, { temperature: '0.6' },
    { reasoningEffort: 7 }, { reasoningEffort: '' }]) rejects(() => estimateContextRequest(request(patch)), 'CONTEXT_REQUEST_INVALID');
  rejects(() => estimateContextRequest(request({ system: 'x'.repeat(CONTEXT_REQUEST_SIZE_LIMITS.bytes) })), 'CONTEXT_REQUEST_CAPACITY');
});

test('actual maxTokens wins over a fallback, and an unresolved or invalid output reserve fails closed', () => {
  assert.equal(estimateContextRequest(request(), { outputTokens: 99 }).outputTokens, 4096);
  assert.equal(estimateContextRequest(request({ maxTokens: undefined }), { outputTokens: 321 }).outputTokens, 321);
  for (const maxTokens of [undefined, null, 0, -1, 1.5, '100', Infinity])
    rejects(() => estimateContextRequest(request({ maxTokens })), 'CONTEXT_OUTPUT_UNKNOWN');
});

test('image occurrences require host route pricing, including offloaded placeholders and tool-role images', () => {
  const images = [image(), image(true)], options = freeze(request({ messages: [message('tool', images, { toolCallId: 'call-image' })] }));
  rejects(() => estimateContextRequest(options), 'CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
  let occurrences;
  const measured = estimateContextRequest(options, { imageRequestPricing: { priceImages(value) {
    occurrences = value; return value.map(block => ({ visualTokens: block.offloaded ? 0 : 900, text: block.offloaded ? 'offloaded image placeholder' : 'image request handle' }));
  } } });
  assert.equal(occurrences.length, 2); assert.equal(occurrences[0], images[0]);
  assert.ok(measured.inputTokens >= 900 + Buffer.byteLength('image request handleoffloaded image placeholder'));
});

test('file projections count the actual host-generated handle text without reading file contents', () => {
  const attachment = file(), options = freeze(request({ messages: [message('user', [attachment])] }));
  rejects(() => estimateContextRequest(options), 'CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
  let received;
  const short = estimateContextRequest(options, { fileRequestText(ref) { received = ref; return 'read-only handle'; } });
  const long = estimateContextRequest(options, { fileRequestText: () => 'PRIVATE_PROJECTED_HANDLE'.repeat(1000) });
  assert.equal(received, attachment.attachment); assert.ok(long.inputTokens > short.inputTokens + 20000);
  assert.doesNotMatch(JSON.stringify(long), /PRIVATE_/);
});

test('throwing, asynchronous, incomplete and malformed attachment projections produce only fixed safe errors', () => {
  const options = request({ messages: [message('user', [image()])] });
  for (const priceImages of [() => { throw Error('PRIVATE_PROVIDER_SECRET'); }, () => Promise.resolve([]), () => Promise.reject(Error('PRIVATE_ASYNC_PROJECTION')), () => [],
    () => [{ visualTokens: -1, text: 'PRIVATE_BAD' }], () => [{ visualTokens: 1, text: null }]])
    rejects(() => estimateContextRequest(options, { imageRequestPricing: { priceImages } }), 'CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
  for (const fileRequestText of [() => { throw Error('PRIVATE_PATH'); }, () => Promise.resolve('secret'), () => Promise.reject(Error('PRIVATE_ASYNC_FILE')), () => 7])
    rejects(() => estimateContextRequest(request({ messages: [message('user', [file()])] }), { fileRequestText }), 'CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
});

test('unsupported content and malformed canonical requests cannot silently become zero-sized inputs', () => {
  for (const messages of [undefined, [], [{ role: 'user', content: 'raw untyped text' }], [message('unknown', [text('PRIVATE_CONTENT')])],
    [message('user', [{ type: 'audio', data: 'PRIVATE_AUDIO' }])], [message('assistant', [{ type: 'reasoning', text: 7 }])],
    [message('tool', [text('PRIVATE_TOOL')])]])
    rejects(() => estimateContextRequest(request({ messages })), 'CONTEXT_REQUEST_INVALID');
});

test('capacity errors distinguish bounded traversal, depth, byte and collection limits from internal failures', () => {
  rejects(() => estimateContextRequest(request({ messages: [message('user', [text('x'.repeat(CONTEXT_REQUEST_SIZE_LIMITS.bytes + 1))])] })), 'CONTEXT_REQUEST_CAPACITY');
  rejects(() => estimateContextRequest(request({ messages: Array.from({ length: CONTEXT_REQUEST_SIZE_LIMITS.messages + 1 }, () => message('user', [])) })), 'CONTEXT_REQUEST_CAPACITY');
  rejects(() => estimateContextRequest(request({ tools: Array.from({ length: CONTEXT_REQUEST_SIZE_LIMITS.tools + 1 }, () => ({ name: 'tool' })) })), 'CONTEXT_REQUEST_CAPACITY');
  let deep = {};
  for (let i = 0; i < CONTEXT_REQUEST_SIZE_LIMITS.depth + 1; i++) deep = { nested: deep };
  rejects(() => estimateContextRequest(request({ tools: [{ name: 'deep', parameters: deep }] })), 'CONTEXT_REQUEST_CAPACITY');
});

test('getters, toJSON callbacks, cycles and non-JSON objects never execute or escape into errors', () => {
  let calls = 0;
  const getter = { name: 'getter' }; Object.defineProperty(getter, 'description', { enumerable: true, get() { calls++; throw Error('PRIVATE_GETTER'); } });
  const json = { name: 'json', toJSON() { calls++; throw Error('PRIVATE_TO_JSON'); } }, cyclic = { name: 'cycle' }; cyclic.self = cyclic;
  for (const tool of [getter, json, cyclic, { name: 'date', parameters: new Date() }])
    rejects(() => estimateContextRequest(request({ tools: [tool] })), 'CONTEXT_REQUEST_INVALID');
  assert.equal(calls, 0);
});

test('projection errors cannot supply unsafe code getters or spoof an internal capacity classification', () => {
  let calls = 0;
  const unsafe = {}; Object.defineProperty(unsafe, 'code', { get() { calls++; throw Error('PRIVATE_CODE_GETTER'); } });
  for (const failure of [unsafe, { code: 'CONTEXT_REQUEST_CAPACITY', message: 'PRIVATE_SPOOFED' }])
    rejects(() => estimateContextRequest(request({ messages: [message('user', [image()])] }), {
      imageRequestPricing: { priceImages() { throw failure; } },
    }), 'CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('non-enumerable model-facing fields and proxy inputs cannot hide text from the counted request', () => {
  const hidden = { type: 'text' }; Object.defineProperty(hidden, 'text', { value: 'PRIVATE_HIDDEN_TEXT' });
  rejects(() => estimateContextRequest(request({ messages: [message('user', [hidden])] })), 'CONTEXT_REQUEST_INVALID');
  let calls = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; throw Error('PRIVATE_PROXY'); }, ownKeys() { calls++; throw Error('PRIVATE_PROXY'); } });
  rejects(() => estimateContextRequest(request({ tools: [proxy] })), 'CONTEXT_REQUEST_INVALID');
  assert.equal(calls, 0);
  const messages = [message('user', [image()])];
  messages[Symbol.iterator] = function* () { calls++; yield message('user', [text('pretend no image')]); };
  rejects(() => estimateContextRequest(request({ messages })), 'CONTEXT_REQUEST_INVALID');
  assert.equal(calls, 0);
});

test('shared values are counted per request occurrence rather than deduplicated as if they cost nothing', () => {
  const repeated = message('user', [text('shared content'.repeat(100))]);
  const one = estimateContextRequest(request({ messages: [repeated] })).inputTokens;
  const two = estimateContextRequest(request({ messages: [repeated, repeated] })).inputTokens;
  assert.ok(two >= one * 1.5);
});
