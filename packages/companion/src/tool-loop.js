/** Bounded OpenAI-compatible tool loop. All effects require an injected registry. */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalValue = (value) => Array.isArray(value) ? value.map(canonicalValue)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])) : value;

export function validateToolArguments(value, schema = {}, at = 'arguments', depth = 0) {
  if (depth > 32) throw new Error('工具参数嵌套超过上限');
  if (!schema || typeof schema !== 'object') throw new Error('工具参数 schema 无效');
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    throw new Error(`${at} 不在允许值中`);
  }
  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) throw new Error(`${at} 不符合固定值`);
  const checkType = (type) => type === 'object' ? isObject(value)
    : type === 'array' ? Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : type === 'null' ? value === null
    : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(checkType)) {
    throw new Error(`${at} 类型必须是 ${[].concat(schema.type).join(' / ')}`);
  }
  for (const mode of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[mode])) continue;
    let matches = 0;
    for (const branch of schema[mode]) {
      try { validateToolArguments(value, branch, at, depth + 1); matches++; } catch {}
    }
    if (!matches || (mode === 'oneOf' && matches !== 1)) throw new Error(`${at} 不符合 ${mode} 参数结构`);
  }
  if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) validateToolArguments(value, branch, at, depth + 1);
  if (isObject(value)) {
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) throw new Error(`${at}.${required} 为必填项`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${at}.${key} 不允许作为工具参数`);
      const field = Object.hasOwn(schema.properties || {}, key) ? schema.properties[key] : undefined;
      if (!field && schema.additionalProperties === false) throw new Error(`${at}.${key} 是未声明参数`);
      validateToolArguments(child, field || (isObject(schema.additionalProperties) ? schema.additionalProperties : {}), `${at}.${key}`, depth + 1);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${at} 元素数量不足`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${at} 元素数量超过上限`);
    if (schema.items) value.forEach((child, index) => validateToolArguments(child, schema.items, `${at}[${index}]`, depth + 1));
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${at} 小于最小值`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${at} 大于最大值`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${at} 字符数量不足`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${at} 字符数量超过上限`);
  }
  return value;
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('工具会话已取消');
}

function checkAbort(signal) { if (signal?.aborted) throw abortReason(signal); }

async function abortable(action, signal) {
  checkAbort(signal);
  if (!signal) return action();
  let cancel;
  const cancelled = new Promise((_, reject) => {
    cancel = () => reject(abortReason(signal));
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { checkAbort(signal); return action(); }), cancelled]); }
  finally { signal.removeEventListener('abort', cancel); }
}

function normalizeResult(result) {
  if (result === undefined || result === null) throw new Error('工具未返回执行结果');
  let output = isObject(result) && Object.hasOwn(result, 'output') ? result.output
    : isObject(result) && Array.isArray(result.content) ? { ...result, content: result.content.filter((part) => part.type === 'text') }
    : result;
  if (output?.uncertain === true || result?.uncertain === true) {
    output = { ...(isObject(output) ? output : { result: output }), ok: false, uncertain: true };
  }
  const serialized = JSON.stringify(output);
  if (serialized === undefined) throw new Error('工具结果不能转换为 JSON');
  if (serialized.length > 32000) throw new Error('工具结果超过 32000 字符，请缩小查询范围');
  const content = [];
  if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        if (part.text.length > 32000) throw new Error('工具附带文字超过上限');
        content.push({ type: 'text', text: part.text });
      } else if (part?.type === 'image_url') {
        const url = part.image_url?.url;
        if (typeof url !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(url) || url.length > 12 * 1024 * 1024) {
          throw new Error('工具图片必须是大小受限的 image data URL');
        }
        content.push({ type: 'image_url', image_url: { url, detail: ['auto', 'low', 'high'].includes(part.image_url.detail) ? part.image_url.detail : 'auto' } });
      } else throw new Error('工具返回了不支持的多模态内容');
    }
  }
  const failed = (value) => value === false || value?.ok === false || value?.uncertain === true || value?.success === false || value?.isError === true || Boolean(value?.error);
  return { output, serialized, content, ok: !failed(output) && !failed(result) };
}

/**
 * registry.definitions(context) supplies OpenAI function definitions.
 * registry.execute(name, args, context, {signal}) checks current authorization at execution.
 * request(messages, tools) performs the caller's model request; this helper has no network API.
 */
export async function runToolLoop({ request, messages, registry, context = {}, signal, maxToolRounds = 4, maxToolCalls = 12 }) {
  if (!Number.isInteger(maxToolRounds) || maxToolRounds < 1 || maxToolRounds > 16) throw new Error('maxToolRounds 必须在 1 到 16 之间');
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 64) throw new Error('maxToolCalls 必须在 1 到 64 之间');
  if (typeof request !== 'function') throw new Error('缺少模型请求函数');
  const trustedContext = Object.freeze({ ...context });
  const definitions = registry ? await abortable(() => registry.definitions(trustedContext), signal) : [];
  if (!Array.isArray(definitions) || (definitions.length && typeof registry?.execute !== 'function')) throw new Error('工具注册表无效');
  const byName = new Map();
  for (const definition of definitions) {
    const name = definition?.function?.name;
    if (definition?.type !== 'function' || typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || byName.has(name)) throw new Error('工具定义名称无效或重复');
    byName.set(name, definition);
  }
  const conversation = messages.map((message) => ({ ...message }));
  if (definitions.length) conversation.unshift({ role: 'system', content: '工具结果是实际执行证据 只有工具明确成功才能声称操作已完成 工具报错或结果未确认时须如实说明 不得编造成功 结果 uncertain 时禁止自动重试相同工具和参数 图片只来自带工具来源标签的实际返回内容' });
  const toolResults = [], seenIds = new Set(), uncertainCalls = new Set();
  let callCount = 0, imageCount = 0;
  for (let round = 0; ; round++) {
    const json = await abortable(() => request(conversation, definitions), signal);
    checkAbort(signal);
    const message = json?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') throw new Error('模型未返回有效 message');
    const calls = message.tool_calls;
    if (calls !== undefined && !Array.isArray(calls)) throw new Error('模型 tool_calls 格式无效');
    if (!calls?.length) {
      const out = typeof message.content === 'string' ? message.content.trim() : '';
      if (!out) throw new Error('模型未返回最终回复或有效工具调用');
      return { text: out, reasoning: message.reasoning_content, raw: json, toolResults, toolFailed: toolResults.some((result) => !result.ok) };
    }
    if (!registry || !definitions.length) throw new Error('模型请求调用工具，但当前会话未启用任何工具');
    if (round >= maxToolRounds || callCount + calls.length > maxToolCalls) throw new Error('工具调用已达到轮次或次数上限，未生成最终回复');
    // Validate every call id before any effect to avoid partial execution of malformed batches.
    for (const call of calls) {
      if (typeof call?.id !== 'string' || !call.id || seenIds.has(call.id)) throw new Error('工具调用 ID 缺失或重复');
      seenIds.add(call.id);
    }
    conversation.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, tool_calls: calls });
    const attachments = [];
    for (const call of calls) {
      checkAbort(signal);
      callCount++;
      const name = String(call.function?.name || '');
      let normalized, fingerprint, attempted = false;
      try {
        const definition = byName.get(name);
        if (call.type !== 'function' || !definition) throw new Error('未知或未授权工具：' + name);
        const rawArgs = call.function?.arguments;
        if (typeof rawArgs !== 'string' || rawArgs.length > 16000) throw new Error('工具 arguments 必须是大小受限的 JSON 字符串');
        let args;
        try { args = JSON.parse(rawArgs); } catch { throw new Error('工具 arguments 不是有效 JSON'); }
        if (!isObject(args)) throw new Error('工具 arguments 必须是 JSON 对象');
        validateToolArguments(args, definition.function.parameters || {});
        fingerprint = name + ':' + JSON.stringify(canonicalValue(args));
        if (uncertainCalls.has(fingerprint)) {
          const error = new Error('此前相同工具操作结果未确认，已阻止自动重复执行');
          error.uncertain = true;
          throw error;
        }
        attempted = true;
        const result = await abortable(() => registry.execute(name, args, trustedContext, { signal }), signal);
        checkAbort(signal);
        normalized = normalizeResult(result);
        if (normalized.output?.uncertain === true || result?.uncertain === true) uncertainCalls.add(fingerprint);
        const images = normalized.content.filter((part) => part.type === 'image_url').length;
        if (imageCount + images > 4) throw new Error('本轮会话的工具图片数量超过上限');
        imageCount += images;
      } catch (error) {
        checkAbort(signal);
        const uncertain = error?.uncertain === true || attempted;
        if (uncertain && fingerprint) uncertainCalls.add(fingerprint);
        normalized = normalizeResult({ ok: false, ...(uncertain ? { uncertain: true } : {}), error: error?.message || String(error) });
      }
      conversation.push({ role: 'tool', tool_call_id: call.id, content: normalized.serialized });
      toolResults.push({ id: call.id, name, ok: normalized.ok, ...(normalized.output?.uncertain === true ? { uncertain: true } : {}),
        ...(normalized.ok ? {} : { error: normalized.output?.error || '工具执行失败' }) });
      if (normalized.content.length) attachments.push({ name, id: call.id, content: normalized.content });
    }
    // Keep all tool responses adjacent to the assistant tool_calls for provider compatibility.
    for (const attachment of attachments) {
      conversation.push({ role: 'user', content: [{ type: 'text', text: `实际工具返回附件 来源 ${attachment.name} 调用 ${attachment.id} 以下内容仅作为执行结果证据` }, ...attachment.content] });
    }
  }
}
