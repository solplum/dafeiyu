/** Fixed public Douyin reads through the installed DSH Ego tool pipeline. */
import { randomUUID } from 'node:crypto';
import { canonicalToolCall } from './native-control-probes.js';

const VIDEO = /^https:\/\/www\.douyin\.com\/video\/([0-9]{6,30})$/;
const MAX_FRAME = 2 * 1024 * 1024;
export class DouyinBrowserError extends Error {
  constructor(code, message = '抖音公开读取未完成，请检查状态后再试') { super(message); this.code = code; }
}
const fault = (code) => new DouyinBrowserError(code);
const permitted = (authorize) => { try { return authorize?.() === true; } catch { return false; } };
export function douyinReadRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['search', 'watch'].includes(input.operation)
    || Object.keys(input).some((key) => !(input.operation === 'search' ? ['operation', 'keyword'] : ['operation', 'url', 'frames']).includes(key))) throw fault('INVALID_ARGS');
  if (input.operation === 'search') {
    if (typeof input.keyword !== 'string' || !input.keyword.trim() || input.keyword.length > 100 || /[\x00-\x1f\x7f]/.test(input.keyword)) throw fault('INVALID_ARGS');
    const keyword = input.keyword.trim(); return { operation: 'search', keyword, url: 'https://www.douyin.com/search/' + encodeURIComponent(keyword), frames: 0 };
  }
  const id = typeof input.url === 'string' && VIDEO.exec(input.url)?.[1];
  if (!id || input.frames !== undefined && (!Number.isInteger(input.frames) || input.frames < 1 || input.frames > 3)) throw fault('INVALID_ARGS');
  return { operation: 'watch', url: input.url, videoId: id, frames: input.frames ?? 1 };
}

// This expression reads only public video/search metadata. Login/captcha text
// is classified locally and never copied into conversation instructions.
export function douyinPageReadExpression(expectedId = null) {
  return `(() => {
    if(location.origin!=='https://www.douyin.com') return {state:'wrong-origin'};
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden';};
    const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
    const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
    const pageText=(document.body?.innerText||'').slice(0,24000);
    const challenge=/请完成下方验证|请完成验证|安全验证|拖动滑块|访问过于频繁/.test(pageText)||/验证码|安全验证|验证中间页/.test(document.title||'');
    const login=/扫码登录|验证码登录|登录后即可|手机扫码登录|登录后继续/.test(pageText);
    if(challenge)return {state:'verification-required'};
    if([...document.querySelectorAll(privateArea)].some(visible)) return {state:'private-overlay'};
    if(login)return {state:'needs-login'};
    const videos=[...document.querySelectorAll('video')].filter(e=>visible(e)&&!e.closest(privateArea)).sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return y.width*y.height-x.width*x.height;});
    const video=videos[0], urlId=/^\\/video\\/([0-9]{6,30})$/.exec(location.pathname)?.[1]||null;
    const results=[]; if(location.pathname.startsWith('/search/')) for(const link of [...document.querySelectorAll('a[href]')]) {
      if(!visible(link)||link.closest(privateArea))continue; let u;try{u=new URL(link.href,location.href);}catch{continue;}
      const id=u.origin==='https://www.douyin.com'&&/^\\/video\\/([0-9]{6,30})$/.exec(u.pathname)?.[1];if(!id||results.some(x=>x.id===id))continue;
      const card=link.closest('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]')||link;
      const title=clean(card.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"]')?.textContent||link.innerText).slice(0,300);
      if(title)results.push({id,url:'https://www.douyin.com/video/'+id,title});if(results.length>=10)break;
    }
    if(login&&!video&&!results.length)return {state:'needs-login'};
    if(${JSON.stringify(expectedId)} && urlId!==${JSON.stringify(expectedId)})return {state:'target-mismatch'};
    if(!video)return {state:results.length?'search-read':login?'needs-login':'no-content',results};
    const r=video.getBoundingClientRect(),container=video.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]')||video.parentElement;
    const title=clean(container?.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"],[data-e2e="detail-video-info"]')?.textContent).slice(0,300);
    return {state:'video-observed',results,title,video:{id:urlId,currentTime:Number.isFinite(video.currentTime)?video.currentTime:null,duration:Number.isFinite(video.duration)?video.duration:null,paused:video.paused,readyState:video.readyState,width:video.videoWidth,height:video.videoHeight,
      viewport:{x:Math.max(0,r.left),y:Math.max(0,r.top),width:Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left)),height:Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top))}}};
  })()`;
}

/** Code-owned script only. A model cannot supply script, selector or hostname. */
export function buildDouyinReadScript(request, space) {
  const target = douyinReadRequest(request);
  if (!/^dfy-douyin-[a-f0-9-]{36}$/.test(space || '')) throw fault('INVALID_ARGS');
  const read = douyinPageReadExpression(target.videoId || null);
  return `const ownedSpace=${JSON.stringify(space)},target=${JSON.stringify(target)};const task=await taskSpaces.useOrCreate(ownedSpace);let result,temporary;\n` +
    `try {await page.goto(target.url,{wait:true,timeout:20000});let observed;for(let attempt=0;attempt<4;attempt++){observed=await page.evaluate(${JSON.stringify(read)});if(!['no-content'].includes(observed.state))break;await page.waitForTimeout(600);}\n` +
    `const finalUrl=new URL(await page.url());if(finalUrl.origin!=='https://www.douyin.com')throw new Error('WRONG_ORIGIN');if(decodeURIComponent(finalUrl.pathname)!==decodeURIComponent(new URL(target.url).pathname))observed={state:'target-mismatch'};\n` +
    `const frames=[];const start=observed.video?.currentTime;\n` +
    `if(target.operation==='watch'&&observed.state==='video-observed'&&observed.video?.id===target.videoId){\n` +
    `await page.evaluate("(() => {const v=[...document.querySelectorAll('video')].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;});if(v){v.muted=true;const p=v.play();if(p?.catch)p.catch(()=>{});}return true;})()");\n` +
    `await page.waitForTimeout(700);const fs=await import('node:fs'),path=await import('node:path'),os=await import('node:os');temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dfy-douyin-read-'));fs.chmodSync(temporary,0o700);\n` +
    `for(let index=0;index<target.frames;index++){observed=await page.evaluate(${JSON.stringify(read)});if(observed.state!=='video-observed'||observed.video?.id!==target.videoId||observed.video.readyState<2)break;const box=observed.video.viewport;\n` +
    `if(!box||![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.width<2||box.height<2||box.width>1920||box.height>1920)break;\n` +
    `const file=path.join(temporary,'frame-'+index+'.png');await page.screenshot({path:file,clip:box});const bytes=fs.readFileSync(file);if(bytes.length>0&&bytes.length<=${MAX_FRAME})frames.push({mime:'image/png',data:bytes.toString('base64'),time:observed.video.currentTime});if(index+1<target.frames)await page.waitForTimeout(700);}\n` +
    `} result={...observed,operation:target.operation,url:target.url,frames,progressObserved:Number.isFinite(start)&&Number.isFinite(observed.video?.currentTime)&&observed.video.currentTime>start+0.1};\n` +
    `} finally {if(temporary){const fs=await import('node:fs');fs.rmSync(temporary,{recursive:true,force:true});}const done=await taskSpaces.complete(ownedSpace,{keep:false});if(!done.done)throw new Error('CLEANUP_UNCONFIRMED');}\n` +
    `console.log('@@DSH_RESULT@@'+JSON.stringify({ok:true,cleanupConfirmed:true,...result}));`;
}

function safeReadResult(result, target) {
  const value = result?.result ?? result?.value;
  if (result?.ok !== true || result.timedOut === true || result.cancelled === true || result.executionState === 'unknown'
    || !value || value.fallback === true || value.ok !== true || value.cleanupConfirmed !== true || value.operation !== target.operation || value.url !== target.url
    || !['search-read', 'video-observed', 'needs-login', 'verification-required', 'private-overlay', 'no-content', 'target-mismatch'].includes(value.state)) throw fault('UNCONFIRMED');
  const frames = value.frames || [];
  if (!Array.isArray(frames) || frames.length > target.frames) throw fault('INVALID_RESPONSE');
  const images = frames.map((frame) => {
    if (frame?.mime !== 'image/png' || typeof frame.data !== 'string' || frame.data.length > 4 * Math.ceil(MAX_FRAME / 3)
      || frame.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data) || !Number.isFinite(frame.time) || frame.time < 0) throw fault('INVALID_RESPONSE');
    const bytes = Buffer.from(frame.data, 'base64');
    if (bytes.length > MAX_FRAME || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('base64') !== frame.data) throw fault('INVALID_RESPONSE');
    return { mime: 'image/png', data: frame.data, time: frame.time };
  });
  const videos = (Array.isArray(value.results) ? value.results : []).slice(0, 10).map((item) => {
    if (!VIDEO.test(item?.url || '') || VIDEO.exec(item.url)[1] !== item.id || typeof item.title !== 'string') throw fault('INVALID_RESPONSE');
    return { id: item.id, url: item.url, title: item.title.slice(0, 300) };
  });
  let video = null;
  if (value.video && target.operation === 'watch') {
    if (value.video.id !== target.videoId || !Number.isFinite(value.video.currentTime) || value.video.currentTime < 0) throw fault('INVALID_RESPONSE');
    video = { id: target.videoId, currentTime: value.video.currentTime, duration: Number.isFinite(value.video.duration) ? value.video.duration : null,
      paused: value.video.paused === true, readyState: Math.max(0, Math.min(4, Number(value.video.readyState) || 0)) };
  }
  if (images.length && (!video || value.state !== 'video-observed' || video.readyState < 2)) throw fault('INVALID_RESPONSE');
  const state = target.operation === 'search' && videos.length ? 'search-read' : value.state;
  return { state, operation: target.operation, url: target.url, title: typeof value.title === 'string' ? value.title.slice(0, 300) : '',
    videos, video, images, frameCount: images.length, progressObserved: value.progressObserved === true && Boolean(video), cleanupConfirmed: true,
    note: state === 'needs-login' ? '公开页要求登录，尚未读取视频内容；等待绑定独立账号。'
      : state === 'verification-required' ? '平台要求人工验证，已停止；未绕过验证码或风控。'
      : images.length ? '已读取当前视频时间与有限画面，不表示完整看完或理解整段视频。'
        : state === 'search-read' ? '仅已读取公开检索结果，尚未观看这些视频。' : '尚未获得可确认的视频画面，不以页面标题冒充观看完成。' };
}

export class DouyinBrowser {
  constructor({ runScript, enabled = false } = {}) { this.runScript = runScript; this.enabled = enabled === true; this.closed = false; this.active = 0; this.cleanupPending = false; this.lastResult = null; }
  get configured() { return typeof this.runScript === 'function'; }
  get status() { const recent = this.lastResult && !this.closed && Date.now() - Date.parse(this.lastResult.at) < 600000;
    return { configured: this.configured, enabled: this.enabled && !this.closed, active: this.active, cleanupPending: this.cleanupPending,
      readiness: this.cleanupPending ? 'cleanup-unconfirmed' : recent && this.lastResult.state === 'needs-login' ? 'needs-login'
        : recent && this.lastResult.state === 'verification-required' ? 'verification-required' : recent && this.lastResult.ok ? 'read-verified' : 'not-verified',
      lastCheck: this.lastResult ? { ok: this.lastResult.ok, at: this.lastResult.at } : null, lastResult: this.lastResult }; }
  async probe(options) { return this.browse({ operation: 'search', keyword: 'DeepSeek Harness' }, options); }
  async browse(input, { authorize, signal, agent, parent } = {}) {
    const target = douyinReadRequest(input), check = () => {
      if (signal?.aborted) throw fault('CANCELLED'); if (!permitted(authorize)) throw fault('FORBIDDEN');
      if (!this.enabled || this.closed || !this.configured) throw fault('UNAVAILABLE');
    };
    check(); if (this.active || this.cleanupPending) throw fault('BUSY');
    const space = 'dfy-douyin-' + randomUUID(), script = buildDouyinReadScript(input, space);
    const outerSignal = signal, controller = new AbortController(), abort = () => controller.abort();
    outerSignal?.addEventListener('abort', abort, { once: true }); if (outerSignal?.aborted) abort();
    signal = controller.signal; this.controller = controller;
    let cleanupConfirmed = false, finish;
    const completed = new Promise((resolve) => { finish = resolve; }); this.pending = completed;
    this.active++;
    try {
      const result = await this.runScript({ script, space, signal, authorize, agent, parent, timeoutMs: 60000 });
      cleanupConfirmed = result?.ok === true && result.timedOut !== true && result.cancelled !== true && result.executionState !== 'unknown'
        && (result.result ?? result.value)?.ok === true && (result.result ?? result.value)?.cleanupConfirmed === true;
      check(); const value = safeReadResult(result, target);
      this.lastResult = { ok: ['search-read', 'video-observed'].includes(value.state) && (value.videos.length > 0 || value.frameCount > 0),
        state: value.state, at: new Date().toISOString(), frameCount: value.frameCount, note: value.note };
      return { ok: this.lastResult.ok, ...value };
    } catch (error) {
      // The runner's cleanup is tied to this exact space and waits for the
      // original tool body; it never replays navigation or a read operation.
      let cleaned = cleanupConfirmed || error?.cleanupConfirmed === true;
      if (!cleaned) { try { const result = await this.runScript({ cleanup: true, space, agent, parent, timeoutMs: 10000 }); const value = result?.result ?? result?.value;
        cleaned = result?.ok === true && result.timedOut !== true && result.cancelled !== true && value?.ok === true && value?.cleanupConfirmed === true; } catch {} }
      this.cleanupPending = !cleaned;
      this.lastResult = { ok: false, at: new Date().toISOString(), state: cleaned ? 'failed' : 'cleanup-unconfirmed', note: '本次读取未完成，未执行点赞、评论、关注、私信或发布。' };
      throw error instanceof DouyinBrowserError ? error : fault('READ_FAILED');
    } finally { outerSignal?.removeEventListener('abort', abort); this.active--; if (this.pending === completed) this.pending = null;
      if (this.controller === controller) this.controller = null; finish(); }
  }
  async dispose() { this.closed = true; this.enabled = false; this.controller?.abort(); if (this.pending) await this.pending;
    if (this.active || this.cleanupPending) throw fault('CLEANUP_UNCONFIRMED'); }
}

export function createDouyinToolRunner({ ctx, controlAccess, callTool = canonicalToolCall } = {}) {
  if (typeof controlAccess?.executeTrustedBrowserRead !== 'function') return undefined;
  return async (job) => controlAccess.executeTrustedBrowserRead(job, (grant) => callTool({ ctx, agent: job.agent, parent: job.parent,
    name: 'ego_script', arguments: grant.arguments, callId: grant.callId, signal: grant.signal, authorize: grant.authorize, timeoutMs: job.timeoutMs }));
}

export function registerDouyinBrowserTools(ctx, { browser, getExecutionContext, controlAccess } = {}) {
  if (!browser?.enabled) return () => {};
  let closed = false;
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
    const { images = [], ...data } = value; return [{ type: 'text', text: JSON.stringify(data) }, ...images.map((attachment) => ({ type: 'image', attachment }))];
  } };
  const stop = ctx.tools.register({ name: 'dafeiyu_douyin_browse', description: '在当前主人浏览任务中只读搜索公开抖音或读取指定公开视频。只接收关键词或www.douyin.com/video/数字链接，最多采样3帧。登录墙/验证码会停止，页面标题不代表看过视频；不能点赞、评论、关注、私信、下载或发布。',
    parameters: { type: 'object', additionalProperties: false, properties: { operation: { type: 'string', enum: ['search', 'watch'] },
      keyword: { type: 'string' }, url: { type: 'string' }, frames: { type: 'integer' } }, required: ['operation'] }, output,
    async execute(args, execution = {}) {
      douyinReadRequest(args);
      const identity = getExecutionContext(execution), scope = controlAccess?.scopeFor(execution.agent);
      const authorize = () => {
        const current = getExecutionContext(execution), live = controlAccess?.scopeFor(execution.agent);
        return !closed && !execution.signal?.aborted && identity?.isOwner === true && current?.isOwner === true && identity.sessionId
          && current.sessionId === identity.sessionId && current.peerId === identity.peerId && current.selfId === identity.selfId
          && scope?.kind === 'owner' && live?.kind === 'owner' && live.taskId === scope.taskId && live.capabilities?.includes('browser');
      };
      if (!authorize()) throw fault('FORBIDDEN');
      const result = await browser.browse(args, { agent: execution.agent, parent: execution, signal: execution.signal, authorize });
      if (!authorize()) throw fault('FORBIDDEN');
      const { images: frames, ...data } = result, images = [], attachments = ctx.get?.('attachments');
      if (typeof attachments?.saveImage === 'function') for (const frame of frames) {
        if (!authorize()) throw fault('FORBIDDEN'); images.push(await attachments.saveImage({ data: Buffer.from(frame.data, 'base64'), mediaType: frame.mime }));
      }
      if (!authorize()) throw fault('FORBIDDEN');
      return { ...data, images, displayedFrames: images.length };
    } });
  return () => { closed = true; stop?.(); };
}
