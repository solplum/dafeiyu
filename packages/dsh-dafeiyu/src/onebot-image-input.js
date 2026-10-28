const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES = 4;
const imageError = code => Object.assign(new Error(code === 'IMAGE_UNAVAILABLE'
  ? '当前图片输入通道尚不可用，未调用模型' : 'QQ 图片读取未完成，未调用模型'), { code });

// Only first-party QQ media origins from an admitted, current message. Never
// open a container path or let an attachment supply an arbitrary network target.
export function qqImageUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw imageError('IMAGE_INPUT_FAILED');
  let url; try { url = new URL(value); } catch { throw imageError('IMAGE_INPUT_FAILED'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !(host === 'qpic.cn' || host.endsWith('.qpic.cn')
      || ['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'gxh.vip.qq.com'].includes(host))) throw imageError('IMAGE_INPUT_FAILED');
  return url.href;
}
export function imageMediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw imageError('IMAGE_INPUT_FAILED');
}
function base64Bytes(value, maxBytes) {
  if (typeof value !== 'string' || !value.length || value.length % 4 || value.length > 4 * Math.ceil(maxBytes / 3)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw imageError('IMAGE_INPUT_FAILED');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value) throw imageError('IMAGE_INPUT_FAILED');
  return bytes;
}
function waitFor(pending, signal) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(imageError('IMAGE_INPUT_FAILED'));
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([pending, stopped]).finally(() => signal.removeEventListener('abort', abort));
}
async function download(value, { signal, maxBytes, fetchImpl, authorize }) {
  let url = qqImageUrl(value);
  for (let redirects = 0; redirects <= 2; redirects++) {
    authorize(); signal?.throwIfAborted();
    const response = await waitFor(fetchImpl(url, { signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' }), signal);
    authorize(); signal?.throwIfAborted();
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects === 2) throw imageError('IMAGE_INPUT_FAILED');
      const location = response.headers.get('location');
      if (!location) throw imageError('IMAGE_INPUT_FAILED');
      url = qqImageUrl(new URL(location, url).href); continue;
    }
    if (!response.ok || !response.body?.getReader) { await response.body?.cancel(); throw imageError('IMAGE_INPUT_FAILED'); }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { await response.body.cancel(); throw imageError('IMAGE_INPUT_FAILED'); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const next = await waitFor(reader.read(), signal); authorize(); signal?.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) throw imageError('IMAGE_INPUT_FAILED');
        chunks.push(Buffer.from(next.value));
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    if (!size) throw imageError('IMAGE_INPUT_FAILED');
    return Buffer.concat(chunks, size);
  }
  throw imageError('IMAGE_INPUT_FAILED');
}

/** Called once, inside an admitted FIFO task. The host validates and stores the
 * real bytes; its original request projection and capacity guard remain in use. */
export async function prepareOneBotImages({ ctx, gateway, images, selection, signal, authorize, fetchImpl = globalThis.fetch }) {
  if (!images?.length) return [];
  const attachments = ctx.get?.('attachments'), llm = ctx.get?.('llm');
  if (typeof attachments?.saveImages !== 'function' || typeof llm?.resolveModelInfo !== 'function'
    || typeof llm?.imageRequestPricing !== 'function' || !selection?.provider || !selection?.model) throw imageError('IMAGE_UNAVAILABLE');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let total = 0; const inputs = [];
  try {
    authorize(); workSignal.throwIfAborted();
    let info;
    try { info = await waitFor(llm.resolveModelInfo(selection.provider, selection.model, workSignal), workSignal); }
    catch { throw imageError('IMAGE_UNAVAILABLE'); }
    authorize(); workSignal.throwIfAborted();
    if (info?.provider !== selection.provider || info?.id !== selection.model || !info.inputModalities?.includes('image')
      || typeof llm.imageRequestPricing(selection.provider, selection.model)?.priceImages !== 'function') throw imageError('IMAGE_UNAVAILABLE');
    const limits = attachments.imageLimits;
    const maxImages = Math.min(MAX_IMAGES, Number.isSafeInteger(limits?.maxImagesPerMessage) ? limits.maxImagesPerMessage : MAX_IMAGES);
    const totalLimit = Math.min(MAX_MESSAGE_BYTES, Number.isSafeInteger(limits?.maxMessageImageBytes) ? limits.maxMessageImageBytes : MAX_MESSAGE_BYTES);
    if (images.length > maxImages) throw imageError('IMAGE_INPUT_FAILED');
    for (const image of images) {
      authorize(); workSignal.throwIfAborted();
      const remaining = Math.min(MAX_IMAGE_BYTES, totalLimit - total);
      if (remaining < 1 || typeof image.fileSize === 'string' && /^\d+$/.test(image.fileSize) && Number(image.fileSize) > remaining) throw imageError('IMAGE_INPUT_FAILED');
      let bytes;
      if (typeof image.file === 'string' && image.file.startsWith('base64://')) bytes = base64Bytes(image.file.slice(9), remaining);
      else {
        let url = image.url;
        if (!url && typeof image.file === 'string' && /^https:/.test(image.file)) url = image.file;
        if (!url) {
          // NapCat may omit a URL. Resolve the opaque basename once through the
          // verified gateway; returned local paths remain deliberately unused.
          if (typeof gateway.api !== 'function' || typeof image.file !== 'string'
            || !/^[A-Za-z0-9_{}.-]{1,256}$/.test(image.file) || image.file.includes('..')) throw imageError('IMAGE_INPUT_FAILED');
          const result = await waitFor(gateway.api('get_image', { file: image.file }, { signal: workSignal, singleAttempt: true }), workSignal);
          authorize(); workSignal.throwIfAborted();
          if (result?.ok !== true) throw imageError('IMAGE_INPUT_FAILED');
          if (result.data?.base64) bytes = base64Bytes(result.data.base64, remaining);
          else url = result.data?.url;
        }
        if (!bytes) bytes = await download(url, { signal: workSignal, maxBytes: remaining, fetchImpl, authorize });
      }
      const mediaType = imageMediaType(bytes);
      if (Array.isArray(limits?.mediaTypes) && !limits.mediaTypes.includes(mediaType)) throw imageError('IMAGE_INPUT_FAILED');
      total += bytes.length; inputs.push({ data: new Uint8Array(bytes), mediaType });
    }
    authorize(); workSignal.throwIfAborted();
    const refs = await waitFor(attachments.saveImages(inputs), workSignal);
    authorize(); workSignal.throwIfAborted();
    if (!Array.isArray(refs) || refs.length !== images.length || refs.some(ref => !ref || typeof ref !== 'object')) throw imageError('IMAGE_INPUT_FAILED');
    return refs.map(attachment => ({ type: 'image', attachment }));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw imageError(error?.code === 'IMAGE_UNAVAILABLE' ? 'IMAGE_UNAVAILABLE' : 'IMAGE_INPUT_FAILED');
  } finally { clearTimeout(timer); }
}
