/** Fixed, bounded, read-only Bilibili MCP transport. No upstream plugin runtime. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { validateToolArguments } from '../../companion/src/tool-loop.js';

export const BILI_READ_TOOLS = Object.freeze(['bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info', 'bili_cover', 'bili_frames', 'bili_danmaku']);
const BV = /^BV[0-9A-Za-z]{10}$/;
const MAX_LINE = 10 * 1024 * 1024, MAX_TEXT = 262144, MAX_IMAGE = 3 * 1024 * 1024;
const textOutput = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
  const { images = [], ...data } = value;
  return [{ type: 'text', text: JSON.stringify(data) }, ...images.map((attachment) => ({ type: 'image', attachment }))];
} };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const bvid = { type: 'string', minLength: 12, maxLength: 12 };
const count = (max) => ({ type: 'integer', minimum: 1, maximum: max });
// The current DSH PTC presenter accepts only its enforced schema subset.
// Keep bounds in execution validation even when the model-facing subset cannot
// express them; never weaken the actual request validator.
const wireSchema = (value) => Array.isArray(value) ? value.map(wireSchema) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength'].includes(key)).map(([key, item]) => [key, wireSchema(item)])) : value;
const SCHEMAS = {
  bili_search: schema({ keyword: { type: 'string', minLength: 1, maxLength: 100 }, num: count(20), order: { type: 'string', enum: ['totalrank', 'click', 'pubdate', 'dm'] } }, ['keyword']),
  bili_subtitle: schema({ bvid }, ['bvid']), bili_video_info: schema({ bvid }, ['bvid']), bili_cover: schema({ bvid }, ['bvid']),
  bili_comments: schema({ bvid, num: count(50) }, ['bvid']), bili_danmaku: schema({ bvid, num: count(100) }, ['bvid']),
  bili_frames: schema({ bvid, num: count(3), at: { type: 'array', maxItems: 3, minItems: 1, items: { type: 'number', minimum: 0, maximum: 86400 } } }, ['bvid']),
};
export class BiliBrowserError extends Error {
  constructor(code, message = 'B站读取未完成，请检查当前状态后再试') { super(message); this.code = code; }
}
const fail = (code, message) => new BiliBrowserError(code, message);
const allowed = (authorize) => { try { return authorize?.() === true; } catch { return false; } };
const checkAuthority = (authorize, signal) => {
  if (signal?.aborted) throw fail('CANCELLED', '本次B站读取已取消');
  if (!allowed(authorize)) throw fail('FORBIDDEN', '当前主人或浏览任务权限已失效');
};
const publicJSON = (value, depth = 0) => {
  if (depth > 12) throw fail('INVALID_RESPONSE');
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => publicJSON(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:credential|token|cookie|sessdata|bili_jct|path|home|trace|error|reason)/i.test(key))
    .map(([key, item]) => [key, publicJSON(item, depth + 1)]));
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  return value;
};
function normalizeResult(result, args) {
  if (result?.isError || !Array.isArray(result?.content) || result.content.length > 20) throw fail('REMOTE_FAILED');
  const images = [], texts = []; let imageBytes = 0, textBytes = 0;
  for (const block of result.content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      textBytes += Buffer.byteLength(block.text); if (textBytes > MAX_TEXT) throw fail('RESPONSE_TOO_LARGE'); texts.push(block.text);
    } else if (block?.type === 'image' && typeof block.data === 'string' && ['image/jpeg', 'image/png', 'image/webp'].includes(block.mimeType)) {
      if (images.length >= 3 || block.data.length > MAX_IMAGE * 4 / 3 + 4 || block.data.length % 4 || /[^A-Za-z0-9+/=]/.test(block.data)) throw fail('INVALID_RESPONSE');
      const data = Buffer.from(block.data, 'base64'); imageBytes += data.length;
      if (data.toString('base64') !== block.data) throw fail('INVALID_RESPONSE');
      const valid = block.mimeType === 'image/jpeg' ? data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        : block.mimeType === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
      if (!valid || !data.length || data.length > MAX_IMAGE || imageBytes > 8 * 1024 * 1024) throw fail('INVALID_RESPONSE');
      images.push({ data: block.data, mimeType: block.mimeType });
    } else throw fail('INVALID_RESPONSE');
  }
  let data; try { data = JSON.parse(texts.join('\n')); } catch { throw fail('INVALID_RESPONSE'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok === false || data.error) throw fail('REMOTE_FAILED');
  if (args.bvid && data.bvid !== args.bvid) throw fail('TARGET_MISMATCH');
  if (Array.isArray(data.videos) && data.videos.some((item) => !BV.test(item?.bvid || ''))) throw fail('INVALID_RESPONSE');
  return { ok: true, data: publicJSON(data), images };
}

class McpJob {
  constructor(child, maxLine = MAX_LINE) {
    this.child = child; this.buffer = ''; this.bytes = 0; this.id = 0; this.pending = new Map(); this.closed = false;
    this.completion = new Promise((resolve) => { this.resolveClose = resolve; });
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > maxLine * 2 || Buffer.byteLength(this.buffer) + Buffer.byteLength(chunk) > maxLine) return this.abort(fail('RESPONSE_TOO_LARGE'));
      this.buffer += chunk; let at;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { this.abort(fail('INVALID_RESPONSE')); return; }
        if (message.jsonrpc !== '2.0') { this.abort(fail('INVALID_RESPONSE')); return; }
        if (message.id !== undefined) {
          const pending = this.pending.get(message.id); if (!pending) continue;
          this.pending.delete(message.id);
          if (message.error) pending.reject(fail('REMOTE_FAILED')); else pending.resolve(message.result);
        }
      }
    });
    // Drain stderr without retaining potentially sensitive service diagnostics.
    child.stderr?.on('data', () => {});
    child.stdin?.on('error', () => this.abort(fail('PROCESS_EXITED')));
    child.stdout?.on('error', () => this.abort(fail('PROCESS_EXITED')));
    child.on('error', () => this.abort(fail('UNAVAILABLE')));
    child.once('close', () => { this.closed = true; this.abort(fail('PROCESS_EXITED')); this.resolveClose(); });
  }
  send(message) {
    if (this.closed || this.aborted) throw this.aborted || fail('PROCESS_EXITED');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error); } });
  }
  abort(error = fail('CANCELLED')) {
    this.aborted ||= error;
    for (const item of this.pending.values()) item.reject(this.aborted);
    this.pending.clear();
  }
  async stop() {
    if (this.closed) return;
    this.abort();
    try { this.child.kill('SIGTERM'); } catch {}
    let killTimer, deadline;
    try {
      await Promise.race([this.completion, new Promise((_, reject) => {
        killTimer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} }, 500);
        deadline = setTimeout(() => reject(fail('CLEANUP_UNCONFIRMED', '此前B站读取进程尚未确认退出')), 2500);
      })]);
    } finally { clearTimeout(killTimer); clearTimeout(deadline); }
  }
}

export class BiliBrowser {
  constructor({ pythonPath = '', scriptPath = '', stateDir = '', scriptSha256 = '', enabled = false, spawnImpl = spawn, timeoutMs = 45000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw fail('INVALID_CONFIG');
    Object.assign(this, { pythonPath, scriptPath, stateDir, scriptSha256, spawnImpl, timeoutMs });
    this.enabled = enabled === true; this.closed = false; this.jobs = new Set(); this.cleanupPending = false; this.lastCheck = null; this.lastResult = null;
  }
  get configured() { return [this.pythonPath, this.scriptPath, this.stateDir].every((value) => typeof value === 'string' && path.isAbsolute(value)) && /^[a-f0-9]{64}$/.test(this.scriptSha256); }
  get status() { const current = (result) => !this.closed && result?.ok === true && Date.now() - Date.parse(result.at) < 600000;
    return { enabled: this.enabled && !this.closed, configured: this.configured, active: this.jobs.size,
    cleanupPending: this.cleanupPending, toolsVerified: current(this.lastCheck),
    readiness: current(this.lastResult) ? 'read-verified' : current(this.lastCheck) ? 'tools-verified' : 'not-verified',
    lastCheck: this.lastCheck, lastResult: this.lastResult }; }
  #prepare() {
    if (!this.configured || !this.enabled || this.closed) throw fail('UNAVAILABLE');
    fs.accessSync(this.pythonPath, fs.constants.X_OK);
    if (fs.lstatSync(this.scriptPath).isSymbolicLink() || !fs.statSync(this.scriptPath).isFile() || fs.statSync(this.scriptPath).size > 1024 * 1024) throw fail('UNAVAILABLE');
    const source = fs.readFileSync(this.scriptPath);
    if (source.length > 1024 * 1024 || createHash('sha256').update(source).digest('hex') !== this.scriptSha256) throw fail('SOURCE_CHANGED');
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.stateDir).isSymbolicLink() || fs.realpathSync(this.stateDir) !== this.stateDir) throw fail('UNAVAILABLE');
    fs.chmodSync(this.stateDir, 0o700);
    const script = path.join(this.stateDir, 'mcp_server.py');
    if (fs.existsSync(script)) {
      if (fs.lstatSync(script).isSymbolicLink() || !fs.statSync(script).isFile() || fs.statSync(script).size > 1024 * 1024
        || createHash('sha256').update(fs.readFileSync(script)).digest('hex') !== this.scriptSha256) throw fail('SOURCE_CHANGED');
    } else fs.writeFileSync(script, source, { mode: 0o600, flag: 'wx' });
    const tmp = path.join(this.stateDir, 'tmp'); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(tmp).isSymbolicLink() || fs.realpathSync(tmp) !== tmp) throw fail('UNAVAILABLE');
    return { script, tmp };
  }
  async #run(operation, { authorize, signal } = {}) {
    const assertActive = () => { checkAuthority(authorize, signal); if (this.closed || !this.enabled) throw fail('UNAVAILABLE'); };
    assertActive();
    if (this.cleanupPending || this.jobs.size >= 2) throw fail('BUSY', 'B站读取正在处理或清理，请稍后再试');
    let job, timer, abort;
    try {
      const { script, tmp } = this.#prepare(); assertActive();
      const child = this.spawnImpl(this.pythonPath, ['-I', '-B', script], { cwd: this.stateDir, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], env: { HOME: this.stateDir, TMPDIR: tmp, PATH: path.dirname(this.pythonPath) + path.delimiter + '/usr/bin:/bin',
          BILI_MCP_TOOLS: BILI_READ_TOOLS.join(','), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
      job = new McpJob(child); this.jobs.add(job);
      abort = () => { job.abort(fail('CANCELLED')); void job.stop().catch(() => { this.cleanupPending = true; }); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { job.abort(fail('TIMEOUT')); void job.stop().catch(() => { this.cleanupPending = true; }); }, this.timeoutMs);
      if (signal?.aborted) abort();
      await job.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dafeiyu-bili-readonly', version: '1.0.0' } });
      assertActive(); job.send({ method: 'notifications/initialized', params: {} });
      const listing = await job.request('tools/list', {}); assertActive();
      const names = listing?.tools?.map((item) => item?.name);
      if (!Array.isArray(names) || names.length !== BILI_READ_TOOLS.length || new Set(names).size !== names.length || names.some((name) => !BILI_READ_TOOLS.includes(name))) throw fail('TOOLSET_MISMATCH');
      this.lastCheck = { ok: true, at: new Date().toISOString(), toolCount: names.length };
      const result = await operation(job); assertActive();
      return result;
    } catch (error) {
      if (!job || ['SOURCE_CHANGED', 'TOOLSET_MISMATCH', 'UNAVAILABLE'].includes(error.code)) this.lastCheck = { ok: false, at: new Date().toISOString(), code: error.code || 'UNAVAILABLE' };
      if (error instanceof BiliBrowserError) throw error; throw fail('UNAVAILABLE');
    }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (job) { try { await job.stop(); this.jobs.delete(job); } catch (error) { this.cleanupPending = true; throw error; } }
    }
  }
  async check(options) { return this.#run(async () => ({ ok: true, tools: [...BILI_READ_TOOLS] }), options); }
  async call(name, args = {}, options) {
    if (!Object.hasOwn(SCHEMAS, name)) throw fail('INVALID_ARGS', '仅允许已声明的B站只读能力');
    try { validateToolArguments(args, SCHEMAS[name]); if (args.bvid && !BV.test(args.bvid) || args.keyword !== undefined && !args.keyword.trim()
      || args.at?.some((value) => !Number.isFinite(value))) throw new Error(); }
    catch { throw fail('INVALID_ARGS', 'B站读取参数无效'); }
    try {
      const result = await this.#run(async (job) => normalizeResult(await job.request('tools/call', { name, arguments: args }), args), options);
      this.lastResult = { ok: true, at: new Date().toISOString(), tool: name, ...(args.bvid ? { bvid: args.bvid } : {}), imageCount: result.images.length };
      return result;
    } catch (error) { this.lastResult = { ok: false, at: new Date().toISOString(), code: error.code || 'UNAVAILABLE', note: 'B站读取未完成，未执行平台写入' }; throw error; }
  }
  async probe({ query = 'DeepSeek Harness', ...options } = {}) {
    const controller = new AbortController(), abort = () => controller.abort(); let expired = false;
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    const timer = setTimeout(() => { expired = true; controller.abort(); }, 150000);
    const bounded = { ...options, signal: controller.signal };
    try {
    const search = await this.call('bili_search', { keyword: query, num: 3 }, bounded);
    const selected = search.data.videos?.find((item) => BV.test(item?.bvid || ''));
    if (!selected) throw fail('NO_RESULTS', '本次公开检索没有返回可验证的视频');
    const info = await this.call('bili_video_info', { bvid: selected.bvid }, bounded);
    if (typeof info.data.title !== 'string' || !info.data.title.trim()) throw fail('NO_CONTENT');
    let content, kind;
    try { const subtitle = await this.call('bili_subtitle', { bvid: selected.bvid }, bounded);
      if (typeof subtitle.data.text === 'string' && subtitle.data.text.trim()) { content = subtitle; kind = 'subtitle'; } }
    catch (error) { if (['FORBIDDEN', 'CANCELLED', 'CLEANUP_UNCONFIRMED'].includes(error.code)) throw error; }
    if (!content) { content = await this.call('bili_frames', { bvid: selected.bvid, num: 1 }, bounded); kind = 'frames'; }
    if (kind === 'frames' && !content.images.length) throw fail('NO_CONTENT');
    checkAuthority(options.authorize, controller.signal);
    return { ok: true, bvid: selected.bvid, title: info.data.title.trim().slice(0, 200),
      url: 'https://www.bilibili.com/video/' + selected.bvid, kind, imageCount: content.images.length, readBackBvid: content.data.bvid,
      note: kind === 'frames' ? '已读取公开检索和抽样画面；不表示完整看完视频' : '已读取检索结果与字幕' };
    } catch (error) { if (expired) throw fail('TIMEOUT'); throw error; }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }
  async dispose() { this.closed = true; this.enabled = false; const results = await Promise.allSettled([...this.jobs].map((job) => job.stop()));
    if (results.some((item) => item.status === 'rejected')) { this.cleanupPending = true; throw fail('CLEANUP_UNCONFIRMED'); } this.jobs.clear(); }
}

export function registerBiliBrowserTools(ctx, { browser, getExecutionContext, controlAccess }) {
  if (!browser?.enabled) return () => {};
  let closed = false;
  const parameters = schema({ operation: { type: 'string', enum: ['search', 'subtitle', 'comments', 'video_info', 'cover', 'frames', 'danmaku'] },
    keyword: { type: 'string', minLength: 1, maxLength: 100 }, bvid, count: count(100),
    at: { type: 'array', maxItems: 3, minItems: 1, items: { type: 'number', minimum: 0, maximum: 86400 } } }, ['operation']);
  const stop = ctx.tools.register({ name: 'dafeiyu_bili_browse', description: '主人当前浏览任务中的B站只读检索、字幕、评论、视频信息与抽样画面。关键词最多100字，搜索最多20条，评论最多50条，抽帧最多3张。不能登录、评论、私信、收藏或投稿；抽样画面不代表看完整视频。', parameters: wireSchema(parameters), output: textOutput,
    async execute(args, execution = {}) {
      validateToolArguments(args, parameters);
      const fields = args.operation === 'search' ? ['operation', 'keyword', 'count'] : ['operation', 'bvid',
        ...(['comments', 'frames', 'danmaku'].includes(args.operation) ? ['count'] : []), ...(args.operation === 'frames' ? ['at'] : [])];
      if (Object.keys(args).some((key) => !fields.includes(key))) throw fail('INVALID_ARGS', '本次B站操作包含不适用的参数');
      const identity = getExecutionContext(execution), scope = controlAccess?.scopeFor(execution.agent);
      const permitted = () => {
        if (closed || execution.signal?.aborted) return false;
        const current = getExecutionContext(execution), live = controlAccess?.scopeFor(execution.agent);
        return Boolean(identity?.isOwner && identity.sessionId && current?.isOwner && current.sessionId === identity.sessionId
          && current.peerId === identity.peerId && current.selfId === identity.selfId && scope?.kind === 'owner'
          && live?.kind === 'owner' && live.taskId === scope.taskId && live.capabilities?.includes('browser'));
      };
      checkAuthority(permitted, execution.signal);
      const name = 'bili_' + args.operation;
      const request = args.operation === 'search' ? { keyword: args.keyword, ...(args.count !== undefined ? { num: args.count } : {}) }
        : { bvid: args.bvid, ...(args.count !== undefined ? { num: args.count } : {}), ...(args.at !== undefined ? { at: args.at } : {}) };
      const result = await browser.call(name, request, { authorize: permitted, signal: execution.signal });
      checkAuthority(permitted, execution.signal);
      const attachments = ctx.get?.('attachments'), images = [];
      if (result.images.length && typeof attachments?.saveImage === 'function') for (const item of result.images) {
        checkAuthority(permitted, execution.signal);
        images.push(await attachments.saveImage({ data: Buffer.from(item.data, 'base64'), mediaType: item.mimeType }));
      }
      checkAuthority(permitted, execution.signal);
      return { ok: true, data: result.data, images, ...(result.images.length && !images.length ? { note: '画面已读取，当前宿主未提供图片附件入口' } : {}) };
    } });
  return () => { closed = true; stop?.(); };
}
