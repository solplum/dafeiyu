import { PublishError } from './publish-journal.mjs';

const j = JSON.stringify;
const UPLOAD = 'https://creator.douyin.com/creator-micro/content/upload';
const MANAGE = 'https://creator.douyin.com/creator-micro/content/manage';
// These three selectors are evidenced in the pinned SAU uploader, not asserted
// to be current live Douyin DOM. All write operations still need live bindings.
export const SOURCE_SELECTORS = Object.freeze({ upload: 'input.upload-btn-input',
  title: 'input[placeholder*="填写作品标题"]', description: 'div.zone-container[contenteditable="true"]' });

/** Capture the original fetch/XHR response; never request a receipt again.
 * The installed harness disables Network when waitForResponse resolves, so its
 * Response.json() can lose the CDP body. This bounded page-side copy avoids that
 * runtime bug and leaves the application's response untouched. */
export function exactResponseCapture(pattern, key) {
  if (typeof pattern !== 'string' || typeof key !== 'string' || !/^__dfy_receipt_[a-z0-9_]{1,100}$/.test(key)) throw new PublishError('BINDINGS_REQUIRED', '响应捕获绑定无效');
  const url = new URL(pattern);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || pattern !== url.href) throw new PublishError('BINDINGS_REQUIRED', '需要精确响应地址');
  const install = `(() => {
    const key=${j(key)}, expected=${j(pattern)}, limit=262144; if(window[key]) throw new Error('RECEIPT_CAPTURE_EXISTS');
    const same=u=>{try{return new URL(String(u),location.href).href===expected;}catch{return false;}};
    const state={done:false,error:null,status:null,url:null,payload:null};
    const capture=(raw,status,url)=>{if(state.done||state.error)return; if(typeof raw!=='string'||raw.length>limit){state.error='RECEIPT_TOO_LARGE';return;}try{state.payload=JSON.parse(raw);state.status=status;state.url=url;state.done=true;}catch{state.error='INVALID_RECEIPT_JSON';}};
    const originalFetch=window.fetch, proto=XMLHttpRequest.prototype, originalOpen=proto.open, originalSend=proto.send;
    const xhrUrls=new WeakMap();
    const wrappedFetch=function(...args){const response=Reflect.apply(originalFetch,this,args);response.then(async value=>{if(!same(value.url))return;try{const clone=value.clone(), reader=clone.body?.getReader();if(!reader){state.error='RECEIPT_BODY_UNAVAILABLE';return;}const decoder=new TextDecoder();let raw='',size=0;for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit){await reader.cancel();state.error='RECEIPT_TOO_LARGE';return;}raw+=decoder.decode(next.value,{stream:true});}raw+=decoder.decode();capture(raw,value.status,value.url);}catch{state.error='RECEIPT_BODY_UNAVAILABLE';}}).catch(()=>{});return response;};
    const wrappedOpen=function(method,url,...rest){xhrUrls.set(this,url);return Reflect.apply(originalOpen,this,[method,url,...rest]);};
    const wrappedSend=function(...args){if(same(xhrUrls.get(this)))this.addEventListener('load',()=>{try{if(this.responseType===''||this.responseType==='text')capture(this.responseText,this.status,this.responseURL);else if(this.responseType==='json')capture(JSON.stringify(this.response),this.status,this.responseURL);else state.error='RECEIPT_TYPE_UNSUPPORTED';}catch{state.error='RECEIPT_BODY_UNAVAILABLE';}},{once:true});return Reflect.apply(originalSend,this,args);};
    state.restore=()=>{if(window.fetch===wrappedFetch)window.fetch=originalFetch;if(proto.open===wrappedOpen)proto.open=originalOpen;if(proto.send===wrappedSend)proto.send=originalSend;delete window[key];};
    Object.defineProperty(window,key,{configurable:true,value:state});window.fetch=wrappedFetch;proto.open=wrappedOpen;proto.send=wrappedSend;return true;
  })()`;
  return { install, wait: `Boolean(window[${j(key)}]?.done || window[${j(key)}]?.error)`,
    read: `(() => {const s=window[${j(key)}];return s?{done:s.done,error:s.error,status:s.status,url:s.url,payload:s.payload}:null;})()`,
    cleanup: `(() => {const s=window[${j(key)}];if(s)s.restore();return true;})()` };
}

/** One native ego_script call per action; no cookie import and no own browser. */
export class EgoDouyinDriver {
  constructor({ runScript, space, targetId, bindings } = {}) {
    this.runScript = runScript; this.space = space; this.targetId = targetId; this.bindings = bindings;
  }
  #ready() {
    const b = this.bindings;
    if (typeof this.runScript !== 'function' || !/^[a-zA-Z0-9_-]{1,100}$/.test(this.space || '') || typeof this.targetId !== 'string' || !this.targetId
      || b?.verified !== true || typeof b.accountId !== 'string' || typeof b.accountSelector !== 'string' || !b.accountAttribute
      || !b.publishSelector || !b.uploadReadySelector || !b.draftTokenAttribute || !b.draftTokenSelector || !b.declarationSelector
      || !b.workRowSelector || !b.workIdAttribute || !b.reviewAttribute || !b.workTitleSelector
      || !b.submitResponse?.pattern || !Array.isArray(b.submitResponse.workIdPath) || !Array.isArray(b.submitResponse.okPath)) {
      throw new PublishError('BINDINGS_REQUIRED', '独立账号和当前创作者页尚未核验；不会上传或点击发布');
    }
    const endpoint = new URL(b.submitResponse.pattern);
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'creator.douyin.com' || endpoint.username || endpoint.password || endpoint.hash
      || endpoint.href !== b.submitResponse.pattern) throw new PublishError('BINDINGS_REQUIRED', '需要核验当前精确投稿接口');
  }
  #prefix() {
    this.#ready();
    return `const task = await taskSpaces.useOrCreate(${j(this.space)});\nawait browser.switchTab(${j(this.targetId)});\n` +
      `const origin = new URL(await page.url()); if(origin.protocol !== 'https:' || origin.hostname !== 'creator.douyin.com') throw new Error('WRONG_ORIGIN');\n` +
      `const assertIdentity = async () => {const identity = await page.evaluate(${j(`(() => { const rows = document.querySelectorAll(${j(this.bindings.accountSelector)}); return rows.length === 1 ? rows[0].getAttribute(${j(this.bindings.accountAttribute)}) : null; })()`)});\n` +
      `if(identity !== ${j(this.bindings.accountId)}) throw new Error('ACCOUNT_MISMATCH'); return identity; }; const identity=await assertIdentity();\n`;
  }
  async #run(script, { mutation = false, timeoutMs = 30000 } = {}) {
    const result = await this.runScript({ tool: 'ego_script', args: { script, timeoutMs }, noRetry: mutation });
    // Transport must return only the parsed sentinel result. Raw stdout/stderr
    // and page HTML are not accepted as publication evidence.
    // Native ego_script returns `result`; a caller may normalize it to `value`.
    const value = result?.result ?? result?.value;
    if (!result || result.ok !== true || result.timedOut === true || result.cancelled === true || result.executionState === 'unknown'
      || !value || typeof value !== 'object' || Array.isArray(value) || value.fallback === true
      || result.result !== undefined && result.value !== undefined && JSON.stringify(result.result) !== JSON.stringify(result.value)) {
      throw new PublishError('BROWSER_UNKNOWN', '浏览器操作没有返回完整回执');
    }
    return value;
  }
  async account() {
    const script = this.#prefix() + `console.log('@@DSH_RESULT@@' + JSON.stringify({loggedIn:true,accountId:identity}));`;
    return this.#run(script);
  }
  #inspectScript(record) {
    const b = this.bindings;
    const expression = `(() => { const one = s => { const a = document.querySelectorAll(s); if(a.length !== 1) throw new Error('AMBIGUOUS_DRAFT'); return a[0]; };\n` +
      `const title = one(${j(SOURCE_SELECTORS.title)}).value; const description = one(${j(SOURCE_SELECTORS.description)}).innerText;\n` +
      `return {title,description,ready:!!document.querySelector(${j(b.uploadReadySelector)}),draftToken:one(${j(b.draftTokenSelector)}).getAttribute(${j(b.draftTokenAttribute)}),declaration:one(${j(b.declarationSelector)}).getAttribute(${j(b.declarationAttribute || 'data-value')})}; })()`;
    return `const draft = await page.evaluate(${j(expression)}); if(draft.title !== ${j(record.metadata.title)} || draft.description !== ${j(record.metadata.description)} || draft.declaration !== ${j(record.metadata.declaration)}) throw new Error('DRAFT_CHANGED');\n`;
  }
  #claimScript(file, digest) {
    if (typeof file !== 'string' || !file.startsWith('/')) throw new PublishError('CLAIM_REQUIRED', '上传与发布需要持久单次执行证明');
    return `const fs = await import('node:fs'); const path = await import('node:path');\n` +
      `const claim = fs.openSync(${j(file)}, 'wx', 0o600); try {fs.writeFileSync(claim, ${j(digest)}); fs.fsyncSync(claim);} finally {fs.closeSync(claim);}\n` +
      `const dir = fs.openSync(path.dirname(${j(file)}),'r'); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}\n`;
  }
  validateDraft(record) {
    this.#ready();
    // Cover/tags/declaration need verified platform-specific widgets. Refuse
    // unsupported choices rather than silently publish different content.
    if (record.cover || record.metadata.tags.length) throw new PublishError('DRAFT_FEATURE_PENDING', '封面与话题控件尚待独立账号实测；已保留离线稿件');
  }
  async prepare(record, { claimFile } = {}) {
    this.validateDraft(record);
    const script = this.#prefix() + this.#claimScript(claimFile, record.approvalDigest) + `await page.goto(${j(UPLOAD)}, {wait:true,timeout:30000}); await assertIdentity();\n` +
      `await page.locator(${j(SOURCE_SELECTORS.upload)}).setInputFiles(${j(record.video.path)});\n` +
      `await page.locator(${j(SOURCE_SELECTORS.title)}).fill(${j(record.metadata.title)});\n` +
      `await page.locator(${j(SOURCE_SELECTORS.description)}).fill(${j(record.metadata.description)});\n` +
      this.#inspectScript(record) + `console.log('@@DSH_RESULT@@' + JSON.stringify(draft));`;
    return this.#run(script, { mutation: true, timeoutMs: 180000 });
  }
  async inspectDraft(record) {
    return this.#run(this.#prefix() + this.#inspectScript(record) + `console.log('@@DSH_RESULT@@' + JSON.stringify(draft));`);
  }
  buildSubmitScript(record, { claimFile }) {
    const b = this.bindings;
    const capture = exactResponseCapture(b.submitResponse.pattern, '__dfy_receipt_' + record.approvalDigest.slice(0, 32));
    const prefix = this.#prefix() + this.#inspectScript(record);
    // The installed managed Ego wrapper performs one submission. The on-disk
    // exclusive claim remains INSIDE the script to prevent a duplicate publish
    // click even if a transport unexpectedly replays it. Never remove a claim.
    const buttonCheck = `(() => {const rows=document.querySelectorAll(${j(b.publishSelector)}); if(rows.length!==1) return false; const button=rows[0]; return button.innerText.trim()==='发布' && !button.disabled && button.getAttribute('aria-disabled')!=='true';})()`;
    return prefix + `if(draft.draftToken !== ${j(record.draftToken)} || !draft.ready) throw new Error('DRAFT_CHANGED');\n` +
      `if(await page.evaluate(${j(buttonCheck)}) !== true) throw new Error('AMBIGUOUS_PUBLISH_BUTTON');\n` +
      this.#claimScript(claimFile, record.approvalDigest) +
      `await assertIdentity(); await page.evaluate(${j(capture.install)}); let payload; try {\n` +
      `const response = page.waitForResponse(${j(b.submitResponse.pattern)}, {timeout:30000}).then(value=>({value}),error=>({error}));\n` +
      `await page.locator(${j(b.publishSelector)}).click();\n` +
      `const observed=await response; if(observed.error) throw new Error('NO_EXACT_RECEIPT'); const received=observed.value;\n` +
      `await page.waitForFunction(${j(capture.wait)}, {timeout:10000}); const captured=await page.evaluate(${j(capture.read)});\n` +
      `if(!captured?.done || captured.error || captured.url!==${j(b.submitResponse.pattern)} || received.url()!==captured.url || received.status()!==200 || captured.status!==200) throw new Error('NO_EXACT_RECEIPT'); payload=captured.payload;\n` +
      `} finally {await page.evaluate(${j(capture.cleanup)});} const at=p=>p.reduce((v,k)=>v&&v[k],payload);\n` +
      `if(at(${j(b.submitResponse.okPath)}) !== ${j(b.submitResponse.okValue)}) throw new Error('NO_EXACT_RECEIPT');\n` +
      `const workId = String(at(${j(b.submitResponse.workIdPath)}) || ''); if(!/^\\d{6,30}$/.test(workId)) throw new Error('NO_WORK_ID');\n` +
      `console.log('@@DSH_RESULT@@' + JSON.stringify({accountId:identity,draftToken:draft.draftToken,workId}));`;
  }
  async submitOnce(record, options) { return this.#run(this.buildSubmitScript(record, options), { mutation: true, timeoutMs: 45000 }); }
  async queryWork(workId) {
    const b = this.bindings;
    const expression = `(() => { const rows = [...document.querySelectorAll(${j(b.workRowSelector)})].filter(x => x.getAttribute(${j(b.workIdAttribute)}) === ${j(workId)});\n` +
      `if(rows.length !== 1) return null; const row=rows[0], title=row.querySelector(${j(b.workTitleSelector)});\n` +
      `return {workId:row.getAttribute(${j(b.workIdAttribute)}),title:title?.innerText || '',reviewStatus:(${j(b.reviewStates || {})})[row.getAttribute(${j(b.reviewAttribute)})] || 'unknown',accountId:${j(b.accountId)}}; })()`;
    return this.#run(this.#prefix() + `await page.goto(${j(MANAGE)}, {wait:true,timeout:30000}); await assertIdentity();\nconst work = await page.evaluate(${j(expression)});\nconsole.log('@@DSH_RESULT@@' + JSON.stringify(work || {}));`);
  }
}
