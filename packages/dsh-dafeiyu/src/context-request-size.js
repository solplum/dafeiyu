import { types } from 'node:util';

export const CONTEXT_REQUEST_SIZE_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024, messages: 4096, blocks: 16384, tools: 512, nodes: 100000, depth: 32,
});
const CODES = Object.freeze({
  CONTEXT_REQUEST_INVALID: '请求上下文结构无法安全计量，尚未派发模型。',
  CONTEXT_REQUEST_CAPACITY: '请求上下文超过本地安全计量容量，请先整理内容。',
  CONTEXT_REQUEST_PROJECTION_UNAVAILABLE: '请求附件的真实投影未确认，尚未派发模型。',
  CONTEXT_OUTPUT_UNKNOWN: '模型输出预留未确认，尚未派发模型。',
});
const failures = new WeakMap();
const fail = code => {
  const error = Object.assign(new Error(CODES[code]), { code });
  failures.set(error, code); throw error;
};
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const data = (value, key) => {
  if (!plain(value)) fail('CONTEXT_REQUEST_INVALID');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('CONTEXT_REQUEST_INVALID');
  return descriptor.value;
};
const text = value => typeof value === 'string';
const nonempty = value => text(value) && value.length > 0;
const tokens = value => Number.isSafeInteger(value) && value >= 0;
const array = value => Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
  && !Object.hasOwn(value, Symbol.iterator);
const synchronousProjection = value => {
  if (types.isPromise(value)) {
    // The installed projection contract is synchronous. Contain a rejected
    // async implementation while refusing it immediately, without awaiting or
    // allowing an unhandled rejection to destabilize the host process.
    Promise.prototype.then.call(value, undefined, () => {});
    fail('CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
  }
  return value;
};

/** Count bounded JSON data without invoking getters, toJSON, or provider code. */
function counter() {
  let bytes = 0, nodes = 0, overhead = 256, visualTokens = 0;
  const path = new WeakSet();
  const addBytes = count => {
    bytes += count;
    if (!Number.isSafeInteger(bytes) || bytes > CONTEXT_REQUEST_SIZE_LIMITS.bytes) fail('CONTEXT_REQUEST_CAPACITY');
  };
  const string = value => {
    // Bound allocation before escaping; serialized control characters can
    // expand, but at most sixfold under this already bounded string size.
    if (value.length > CONTEXT_REQUEST_SIZE_LIMITS.bytes) fail('CONTEXT_REQUEST_CAPACITY');
    addBytes(Buffer.byteLength(JSON.stringify(value), 'utf8'));
  };
  function walk(value, depth = 0) {
    if (++nodes > CONTEXT_REQUEST_SIZE_LIMITS.nodes || depth > CONTEXT_REQUEST_SIZE_LIMITS.depth) fail('CONTEXT_REQUEST_CAPACITY');
    if (typeof value === 'string') { string(value); return; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
      addBytes(String(value).length); return;
    }
    if (typeof value !== 'object' || types.isProxy(value) || !array(value) && !plain(value) || path.has(value)) fail('CONTEXT_REQUEST_INVALID');
    const toJSON = Object.getOwnPropertyDescriptor(value, 'toJSON');
    if (toJSON && (!Object.hasOwn(toJSON, 'value') || typeof toJSON.value === 'function')) fail('CONTEXT_REQUEST_INVALID');
    path.add(value);
    try {
      addBytes(2);
      if (array(value)) {
        if (value.length > CONTEXT_REQUEST_SIZE_LIMITS.nodes) fail('CONTEXT_REQUEST_CAPACITY');
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, index);
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('CONTEXT_REQUEST_INVALID');
          walk(descriptor.value, depth + 1); addBytes(1);
        }
      } else {
        // for-in is stopped by the shared node budget rather than allocating
        // an unbounded Object.entries array before checking its length.
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('CONTEXT_REQUEST_INVALID');
          if (descriptor.value === undefined) continue;
          walk(key, depth + 1); walk(descriptor.value, depth + 1); addBytes(2);
        }
      }
    } finally { path.delete(value); }
  }
  return {
    walk,
    addOverhead(value) { overhead += value; },
    projectText(value) { string(value); overhead += 32; },
    addVisual(value) {
      visualTokens += value;
      if (!tokens(visualTokens)) fail('CONTEXT_REQUEST_CAPACITY');
    },
    total() {
      const total = bytes + overhead + visualTokens;
      if (!tokens(total)) fail('CONTEXT_REQUEST_CAPACITY');
      return total;
    },
  };
}

/**
 * Estimate the actual provider-neutral request, including old tool schemas and
 * replay signatures. One UTF8 JSON byte is conservatively priced as one token,
 * with extra framing for provider wrappers. This is an admission estimate,
 * never provider usage, a wallet charge, or an exact tokenizer guarantee.
 *
 * imageRequestPricing must be the installed route's synchronous object with
 * priceImages(imageBlocks) -> [{visualTokens, text}]. fileRequestText must be
 * the installed LLM service's synchronous fileRequestText(attachmentRef).
 * No attachment files or network resources are opened by this module.
 * outputTokens is only a trusted already-resolved fallback when maxTokens is
 * absent; the actual request's explicit output bound always takes priority.
 */
export function estimateContextRequest(options, projections = {}) {
  try {
    const messages = data(options, 'messages'), tools = data(options, 'tools'), history = data(options, 'toolHistory');
    const system = data(options, 'system'), stop = data(options, 'stop');
    const temperature = data(options, 'temperature'), reasoningEffort = data(options, 'reasoningEffort');
    const maxTokens = data(options, 'maxTokens');
    const outputTokens = maxTokens === undefined ? data(projections, 'outputTokens') : maxTokens;
    if (!tokens(outputTokens) || outputTokens < 1) fail('CONTEXT_OUTPUT_UNKNOWN');
    if (!array(messages) || messages.length < 1) fail('CONTEXT_REQUEST_INVALID');
    if (messages.length > CONTEXT_REQUEST_SIZE_LIMITS.messages) fail('CONTEXT_REQUEST_CAPACITY');
    if (tools !== undefined && !array(tools)) fail('CONTEXT_REQUEST_INVALID');
    if ((tools?.length || 0) > CONTEXT_REQUEST_SIZE_LIMITS.tools) fail('CONTEXT_REQUEST_CAPACITY');
    if (system !== undefined && !text(system) || stop !== undefined && !array(stop)
      || temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature))
      || reasoningEffort !== undefined && !nonempty(reasoningEffort)) fail('CONTEXT_REQUEST_INVALID');
    if ((stop?.length || 0) > CONTEXT_REQUEST_SIZE_LIMITS.nodes) fail('CONTEXT_REQUEST_CAPACITY');
    for (const sequence of stop || []) if (!text(sequence)) fail('CONTEXT_REQUEST_INVALID');
    const measured = counter();
    // Include all JSON metadata in the counted request, conservatively keeping
    // source replay signatures even when a particular route later drops them.
    measured.walk({ provider: data(options, 'provider'), model: data(options, 'model'), system, stop, temperature,
      reasoningEffort, maxTokens, messages, tools, toolHistory: history });
    const images = [], files = [];
    let blockCount = 0;
    for (const message of messages) {
      const role = data(message, 'role'), content = data(message, 'content');
      if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role) || !array(content)
        || role === 'tool' && !nonempty(data(message, 'toolCallId'))) fail('CONTEXT_REQUEST_INVALID');
      measured.addOverhead(64);
      for (const block of content) {
        if (++blockCount > CONTEXT_REQUEST_SIZE_LIMITS.blocks) fail('CONTEXT_REQUEST_CAPACITY');
        const type = data(block, 'type');
        measured.addOverhead(32);
        if (type === 'text' || type === 'reasoning') {
          if (!text(data(block, 'text'))) fail('CONTEXT_REQUEST_INVALID');
        } else if (type === 'tool-call') {
          if (!nonempty(data(block, 'id')) || !nonempty(data(block, 'name')) || !text(data(block, 'arguments'))) fail('CONTEXT_REQUEST_INVALID');
        } else if (type === 'tool-addition' || type === 'tool-removal') {
          if (role !== 'developer' || !nonempty(data(block, 'toolName'))) fail('CONTEXT_REQUEST_INVALID');
        } else if (type === 'image' || type === 'file') {
          const attachment = data(block, 'attachment');
          if (!plain(attachment) || !nonempty(data(attachment, 'attachmentId'))) fail('CONTEXT_REQUEST_INVALID');
          if (type === 'image') images.push(block); else files.push(attachment);
        } else fail('CONTEXT_REQUEST_INVALID');
      }
    }
    for (const tool of tools || []) {
      if (!nonempty(data(tool, 'name'))) fail('CONTEXT_REQUEST_INVALID');
      measured.addOverhead(64);
    }
    if (images.length) {
      try {
        const pricing = data(projections, 'imageRequestPricing'), priceImages = data(pricing, 'priceImages');
        if (typeof priceImages !== 'function') fail('CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
        const prices = synchronousProjection(priceImages.call(pricing, Object.freeze(images.slice())));
        if (!array(prices) || prices.length !== images.length) fail('CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
        for (const price of prices) {
          const visual = data(price, 'visualTokens'), projectedText = data(price, 'text');
          if (!tokens(visual) || !text(projectedText)) fail('CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
          measured.addVisual(visual); measured.projectText(projectedText);
        }
      } catch (error) {
        if (failures.get(error) === 'CONTEXT_REQUEST_CAPACITY') throw error;
        fail('CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
      }
    }
    if (files.length) {
      try {
        const fileRequestText = data(projections, 'fileRequestText');
        if (typeof fileRequestText !== 'function') fail('CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
        for (const attachment of files) {
          const projectedText = synchronousProjection(fileRequestText(attachment));
          if (!text(projectedText)) fail('CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
          measured.projectText(projectedText);
        }
      } catch (error) {
        if (failures.get(error) === 'CONTEXT_REQUEST_CAPACITY') throw error;
        fail('CONTEXT_REQUEST_PROJECTION_UNAVAILABLE');
      }
    }
    const inputTokens = measured.total();
    if (!tokens(inputTokens + outputTokens)) fail('CONTEXT_REQUEST_CAPACITY');
    return Object.freeze({ inputTokens, outputTokens, estimated: true, source: 'utf8-conservative-v1' });
  } catch (error) {
    const code = failures.get(error);
    if (code) fail(code);
    fail('CONTEXT_REQUEST_INVALID');
  }
}
