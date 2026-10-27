import fs from 'node:fs';
import path from 'node:path';
import { platform, deny, safeUrl } from './platforms.mjs';
import { digest } from './account-store.mjs';
import { NativeEgoAccountRuntime } from './native-ego-account-runtime.mjs';
import { requestReceipt } from './request-receipt.mjs';
import { DOUYIN_RECOMMEND, DOUYIN_RECOMMEND_LINK, DOUYIN_NEXT, douyinBrowseExpressions, douyinVideoIdentityBinding,
  isRecommendationUrl } from './douyin-browse.mjs';

const q = JSON.stringify;
const X_IDENTITY = { selector: 'a[data-testid="AppTabBar_Profile_Link"]', attribute: 'href', pattern: '^/([A-Za-z0-9_]{1,15})/?$', prefix: '@' };
/** Platform DOM bindings are trusted local code/evidence, never supplied by a
 * model or a request. Unobserved controls stay disabled instead of guessing a
 * platform endpoint, treating a profile QR as login, or clicking broadly. */
export class BrowserAccountDriver {
  constructor({ key, directory, runtime, bindings } = {}) {
    this.key = key; this.definition = platform(key); this.directory = directory;
    this.runtime = runtime || new NativeEgoAccountRuntime({ directory });
    this.bindings = bindings || null; this.space = 'dfy-social-' + key;
    this.sessionId = null;
    this.browseCurrent = null; this.browseHistory = []; this.browseAccount = null; this.browseState = 'stopped';
  }
  #bindings() {
    if (this.bindings) return this.bindings;
    try {
      const file = path.join(this.directory, 'bindings.private.json'), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65536) deny('BINDINGS_REQUIRED');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.platform !== this.key || value.verified !== true || typeof value.accountId !== 'string') deny('BINDINGS_REQUIRED');
      return value;
    } catch { return null; }
  }
  capabilities() {
    const bindings = this.#bindings(), operations = {};
    for (const key of this.definition.reads) operations[key] = bindings?.reads?.[key]?.verified === true ? bindings.reads[key].emptyOnly ? 'empty-state-only' : 'implemented-not-verified' : 'bindings-required';
    for (const key of this.definition.writes) operations[key] = bindings?.writes?.[key]?.verified === true ? 'implemented-not-verified' : 'bindings-required';
    operations.video = 'not-implemented';
    operations.profile = this.key === 'x' || bindings?.identity ? 'implemented-not-verified' : 'bindings-required';
    return operations;
  }
  get idle() { return this.runtime.children?.size === 0 && !this.runtime.cleanupPending && !this.runtime.recoveryPending; }
  get loginAvailable() { return this.runtime.supportsOwnerLogin !== false; }
  #videoIdentity(bindings = this.#bindings()) {
    return this.key === 'douyin' && bindings?.platform === this.key && bindings.verified === true && bindings.accountId
      ? douyinVideoIdentityBinding(bindings.browse?.videoIdentity) : null;
  }
  get nextAvailable() { return this.#videoIdentity() !== null; }
  get supportsExecutorRecovery() { return this.runtime.backend === 'native-ego' && typeof this.runtime.recoverExecutor === 'function'; }
  recoverExecutor(context) { return this.runtime.recoverExecutor(context); }
  get available() { return this.runtime.available !== false; }
  browseStatus() {
    const durable = this.runtime.backend === 'native-ego' ? this.runtime.browseState : null;
    if (durable === 'unknown') return { state: 'unknown' };
    if (durable === 'active' || this.browseState === 'active') return { state: 'active' };
    return { state: this.browseState === 'stopped' && (durable === null || durable === 'stopped') ? 'stopped' : 'unknown' };
  }
  checkBrowser(context) { if (typeof this.runtime.checkMetadata !== 'function') deny('OPERATION_UNAVAILABLE'); return this.runtime.checkMetadata(context); }
  #prefix(resume = false) {
    return `const name=${q(this.space)}; const known=(await taskSpaces.list()).find(x=>x.name===name);\n`
      + (resume ? `if(known?.ownership==='user') await taskSpaces.claim(known.id);\n` : '')
      + `await taskSpaces.useOrCreate(name); await browser.ensureRealTab();\n`
      + `const assertSafety=async()=>{const blocked=await page.evaluate("(()=>{const visible=n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0;};return [...document.querySelectorAll('iframe[src*=captcha],iframe[src*=verify],[role=dialog],[id*=captcha],[class*=captcha]')].filter(visible).some(n=>n.tagName==='IFRAME'||/安全验证|实名认证|操作过于频繁|账号异常|验证身份|访问频繁/.test(n.innerText||''));})()");if(blocked)throw Error('RISK_CONTROL');};\n`
      + `const allowedHosts=${q(this.definition.hosts)}; const checkOrigin=async()=>{let u=new URL(await page.url());if(u.href==='about:blank'){await page.goto(${q(safeUrl(this.key, this.#bindings()?.identity?.url || this.definition.home))},{wait:true,timeout:30000});u=new URL(await page.url());}if(u.protocol!=='https:'||!allowedHosts.includes(u.hostname)||u.username||u.password)throw Error('WRONG_ORIGIN');return u;};\n`;
  }
  #identityExpression() {
    const bindings = this.#bindings(), identity = bindings?.identity || (this.key === 'x' ? X_IDENTITY : null);
    if (!identity?.selector || !identity.attribute || typeof identity.pattern !== 'string') return '({loggedIn:false,state:"identity-binding-required"})';
    return `(()=>{const nodes=[...document.querySelectorAll(${q(identity.selector)})].filter(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0;});
      if(nodes.length!==1)return{loggedIn:false,state:'login-pending'};
      const raw=${['innerText', 'textContent'].includes(identity.attribute) ? `nodes[0][${q(identity.attribute)}]` : `nodes[0].getAttribute(${q(identity.attribute)})`},match=new RegExp(${q(identity.pattern)}).exec(raw||'');
      if(!match||!match[1])return{loggedIn:false,state:'identity-binding-required'};
      const names=${identity.nameSelector ? `[...${identity.nameScope === 'parent' ? '(nodes[0].parentElement||nodes[0])' : 'document'}.querySelectorAll(${q(identity.nameSelector)})].filter(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0;})` : '[]'};
      return{loggedIn:true,accountId:${q(identity.prefix || '')}+match[1],name:(names.length===1?names[0].innerText||names[0].textContent:nodes[0].getAttribute('aria-label')||nodes[0].textContent||'').trim().slice(0,100)};})()`;
  }
  #identityReadinessExpression() {
    const bindings = this.#bindings(), identity = bindings?.identity || (this.key === 'x' ? X_IDENTITY : null);
    if (!identity?.selector || !identity.attribute || typeof identity.pattern !== 'string') return null;
    // Readiness accepts any parseable platform identity. Waiting for the saved
    // account would hide a real account switch behind a timeout.
    return `(()=>{if((${this.#identityExpression()}).loggedIn===true)return true;
      const visible=n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0;};
      const risk=[...document.querySelectorAll('iframe[src*=captcha],iframe[src*=verify],[role=dialog],[id*=captcha],[class*=captcha]')].filter(visible).some(n=>n.tagName==='IFRAME'||/安全验证|实名认证|操作过于频繁|账号异常|验证身份|访问频繁/.test(n.innerText||''));
      if(risk)return true;
      return [...document.querySelectorAll('form,[role=dialog],[data-e2e*=login],[class*=login],[id*=login]')].filter(visible).some(n=>/扫码登录|二维码登录|手机号登录|手机登录|短信登录|密码登录|登录抖音创作者中心|请使用抖音扫码/.test(n.innerText||n.textContent||''));})()`;
  }
  #identityNavigation() {
    const url = this.#bindings()?.identity?.url;
    if (!url) return '';
    const safe = safeUrl(this.key, url);
    return `if((await page.url())!==${q(safe)})await page.goto(${q(safe)},{wait:true,timeout:30000});`;
  }
  #assertIdentity() {
    const bindings = this.#bindings(); if (!bindings?.accountId) deny('BINDINGS_REQUIRED');
    return `const assertAccount=async()=>{await checkOrigin();await assertSafety();${this.#identityNavigation()}await assertSafety();const own=await page.evaluate(${q(this.#identityExpression())});if(own?.loggedIn!==true||own.accountId!==${q(bindings.accountId)})throw Error('ACCOUNT_MISMATCH');return own;};await assertAccount();\n`;
  }
  async startLogin(context) {
    this.sessionId = context.sessionId;
    const image = path.join(this.directory, 'login-' + this.sessionId + '.png');
    const body = this.#prefix(true) + `await page.goto(${q(this.definition.login)},{wait:true,timeout:30000});await checkOrigin();\n`
      + `const blocked=await page.evaluate("(()=>({verification:!!document.querySelector('iframe[src*=captcha],iframe[src*=verify]')}))()");\n`
      + (this.definition.qr ? `await page.screenshot({path:${q(image)}});const fs=await import('node:fs');const bytes=fs.readFileSync(${q(image)});if(bytes.length>1048576)throw Error('LOGIN_IMAGE_TOO_LARGE');const image={mime:'image/png',base64:bytes.toString('base64')};\n` : 'const image=null;\n')
      + `await taskSpaces.handOff(name);const result={state:blocked.verification?'verification-required':'login-pending',method:${q(this.definition.qr ? 'qr-or-official' : 'official-login')},browserWindow:true,sessionId:${q(this.sessionId)},image};`;
    return this.runtime.run(body, context);
  }
  async account(context) {
    const readiness = this.#identityReadinessExpression();
    const body = this.#prefix(context.resume === true) + `await checkOrigin();await assertSafety();${this.#identityNavigation()}await assertSafety();`
      + (readiness ? `await page.waitForFunction(${q(readiness)},{timeout:10000});await checkOrigin();await assertSafety();` : '')
      + `const result=await page.evaluate(${q(this.#identityExpression())});`;
    return this.runtime.run(body, context);
  }
  async checkLogin(context) {
    if (this.sessionId && context.sessionId !== this.sessionId) deny('CONFLICT');
    const body = this.#prefix(true) + `await checkOrigin();await assertSafety();${this.#identityNavigation()}await assertSafety();const result=await page.evaluate(${q(this.#identityExpression())});await taskSpaces.handOff(name);`;
    return this.runtime.run(body, context);
  }
  async closeLogin(context) { await this.runtime.stop(context); this.sessionId = null; }
  #recipe(operation, kind) {
    const value = this.#bindings()?.[kind]?.[operation];
    if (value?.verified !== true || !value.url || typeof value.url !== 'string') deny('BINDINGS_REQUIRED', '该账号的当前页面控件尚待核验，没有发起外部操作。');
    return value;
  }
  #target(recipe, input) {
    const replacements = { target: input.target || '', query: input.query || '', parentId: input.parentId || '' };
    return safeUrl(this.key, recipe.url.replace(/\{(target|query|parentId)\}/g, (_all, key) => encodeURIComponent(replacements[key])));
  }
  async read(input, context) {
    if (input.operation === 'profile') { const identity = await this.account(context); return { ok: identity.loggedIn === true, accountId: identity.accountId, profile: identity }; }
    const recipe = this.#recipe(input.operation, 'reads');
    if (!recipe.emptyOnly && (!recipe.row || !recipe.fields || Object.keys(recipe.fields).length > 8)) deny('BINDINGS_REQUIRED');
    const expression = recipe.emptyOnly ? '[]' : `(()=>{const read=(row,spec)=>{const n=spec.selector?row.querySelector(spec.selector):row;return n?(spec.attribute?n.getAttribute(spec.attribute):n.innerText||n.textContent||'').slice(0,spec.maxChars||1500):'';};return[...document.querySelectorAll(${q(recipe.row)})].slice(0,${input.limit}).map(row=>Object.fromEntries(Object.entries(${q(recipe.fields)}).map(([key,spec])=>[key,read(row,spec)])));})()`;
    const target = this.#target(recipe, input);
    const empty = recipe.empty;
    const emptyExpression = empty?.selector && typeof empty.text === 'string'
      ? `(()=>{const n=document.querySelector(${q(empty.selector)});if(!n)return false;const r=n.getBoundingClientRect();if(!r.width||!r.height)return false;const text=(n.innerText||n.textContent||'').trim();if(${empty.exact ? 'true' : 'false'}?text!==${q(empty.text)}:!text.includes(${q(empty.text)}))return false;const trace=JSON.stringify([...n.querySelectorAll('*')].map(x=>[x.tagName,typeof x.className==='string'?x.className:'',x.children.length]));return ${recipe.emptyOnly ? `trace===${q(empty.signature || 'unverified-empty')}` : 'true'};})()` : 'false';
    const body = this.#prefix() + this.#assertIdentity() + `await page.goto(${q(target)},{wait:true,timeout:30000});await checkOrigin();await assertSafety();if((await page.url())!==${q(target)})throw Error('BINDINGS_REQUIRED');\n`
      + `const items=await page.evaluate(${q(expression)});if(!items.length&&await page.evaluate(${q(emptyExpression)})!==true)throw Error('BINDINGS_REQUIRED');await assertAccount();const result={ok:true,accountId:${q(this.#bindings().accountId)},operation:${q(input.operation)},target:${q(input.target || '')},items,empty:items.length===0,scope:${q(recipe.scope || 'specified-account-content')},emptyReason:items.length===0?${q(empty?.text || '')}:null};`;
    return this.runtime.run(body, context);
  }
  // Manager-only finite read scope. Generic run/account/read never allocate.
  async beginReadActivity(context) {
    const bindings = this.#bindings();
    if (!bindings?.accountId || bindings.accountId !== context.accountId) deny('ACCOUNT_MISMATCH');
    const lifecycle = this.runtime.lifecycle;
    if (lifecycle === undefined || lifecycle === 'legacy' || lifecycle === 'active') return false;
    if (lifecycle !== 'closed' || typeof this.runtime.beginActivity !== 'function') deny('CLEANUP_UNCONFIRMED');
    const result = await this.runtime.beginActivity(context);
    if (result?.started !== true) deny('INVALID_RECEIPT');
    return true;
  }
  async endReadActivity(context) {
    const bindings = this.#bindings();
    if (!bindings?.accountId || bindings.accountId !== context.accountId) deny('ACCOUNT_MISMATCH');
    const result = await this.runtime.stop(context);
    if (result?.stopped !== true || result.taskSpaceClosed !== true || result.spaceRetained !== false || result.browserStopped !== false) deny('CLEANUP_UNCONFIRMED');
    return result;
  }
  async browse(input, context) {
    if (this.key !== 'douyin') deny('INVALID_OPERATION');
    if (this.browseAccount && context.accountId && this.browseAccount !== context.accountId) {
      this.browseCurrent = null; this.browseHistory = []; this.browseState = 'stopped';
    }
    const local = () => ({ ok: true, action: input.action, state: this.browseState,
      current: this.browseCurrent, history: structuredClone(this.browseHistory),
      evidence: 'page-text-and-playback-metadata', visualUnderstanding: false, autonomous: false });
    if (input.action === 'history') return local();
    if (input.action === 'stop') {
      const stopped = await this.runtime.stop(context); this.browseCurrent = null; this.browseState = 'stopped';
      return { ...local(), history: [], browserStopped: stopped?.browserStopped !== false, spaceRetained: stopped?.spaceRetained === true,
        ...(stopped?.taskSpaceClosed === true ? { taskSpaceClosed: true } : {}) };
    }
    const bindings = this.#bindings();
    if (!bindings?.identity?.url || !bindings.accountId || bindings.accountId !== context.accountId) deny('BINDINGS_REQUIRED');
    const videoIdentity = this.#videoIdentity(bindings);
    if (input.action === 'next' && !videoIdentity) deny('BROWSE_NEXT_UNAVAILABLE');
    if (input.action === 'next' && this.browseCurrent?.id !== input.expectedVideoId) deny('CONFLICT');
    const expectedPlatformVideoId = this.browseCurrent?.platformVideoId;
    if (input.action === 'next' && (this.browseCurrent?.identityKind !== 'platform-video-id'
      || typeof expectedPlatformVideoId !== 'string' || !/^[0-9]{10,25}(?![\s\S])/.test(expectedPlatformVideoId))) deny('BROWSE_NEXT_UNAVAILABLE');
    if (input.action === 'open' && typeof this.runtime.beginActivity === 'function') await this.runtime.beginActivity(context);
    const { videoExpression, videoReady, openNavigationExpression, openNavigationReady, feedReady } = douyinBrowseExpressions(videoIdentity);
    const home = safeUrl(this.key, bindings.identity.url);
    // Resolve tab IDs from the current task space each round. Identity checks
    // use a separate creator tab and never navigate the video tab away.
    const own = `const assertBrowseAccount=async(recheck=false)=>{markBrowsePhase(recheck?'browse-return-identity-navigation':'browse-identity-navigation');const tabs=await browser.listTabs();const candidates=tabs.filter(t=>t.url===${q(home)});if(candidates.length>1)throw Error('BINDINGS_REQUIRED');if(candidates.length===1)await browser.switchTab(candidates[0].targetId);else await browser.openOrReuseTab(${q(home)},{wait:true,timeout:30000});await checkOrigin();await assertSafety();markBrowsePhase(recheck?'browse-return-identity-wait':'browse-identity-wait');await page.waitForFunction(${q(`Boolean(document.querySelector(${q(bindings.identity.selector)}))`)},{timeout:10000});markBrowsePhase(recheck?'browse-return-identity-read':'browse-identity-read');const own=await page.evaluate(${q(this.#identityExpression())});if(own?.loggedIn!==true||own.accountId!==${q(context.accountId)})throw Error('ACCOUNT_MISMATCH');};await assertBrowseAccount();\n`;
    const selectFeed = `markBrowsePhase('browse-feed-select');const isBrowseFeedUrl=(${isRecommendationUrl.toString()});const feedTabs=(await browser.listTabs()).filter(t=>isBrowseFeedUrl(t.url));if(feedTabs.length>1)throw Error('BINDINGS_REQUIRED');`;
    let action = selectFeed + `markBrowsePhase('browse-feed-navigation');` + (input.action === 'open'
      ? `if(feedTabs.length)await browser.switchTab(feedTabs[0].targetId);else await browser.openOrReuseTab(${q(DOUYIN_RECOMMEND)},{wait:true,timeout:30000});`
      : `if(feedTabs.length!==1)throw Error('BINDINGS_REQUIRED');await browser.switchTab(feedTabs[0].targetId);`);
    action += `await checkOrigin();await assertSafety();`;
    if (input.action === 'open') {
      action += `markBrowsePhase('browse-navigation-wait');await page.waitForFunction(${q(openNavigationReady)},{timeout:15000});await checkOrigin();await assertSafety();markBrowsePhase('browse-navigation-read');const navigation=await page.evaluate(${q(openNavigationExpression)});if(navigation==='landing'){markBrowsePhase('browse-navigation-click');await page.locator(${q(DOUYIN_RECOMMEND_LINK)}).click();markBrowsePhase('browse-feed-wait');await page.waitForFunction(${q(feedReady)},{timeout:15000});}else if(navigation!=='feed')throw Error('BINDINGS_REQUIRED');await checkOrigin();await assertSafety();if(!isBrowseFeedUrl(await page.url()))throw Error('BINDINGS_REQUIRED');`;
    }
    action += `markBrowsePhase('browse-video-wait');await page.waitForFunction(${q(videoReady)},{timeout:15000});`;
    if (input.action === 'next') {
      // Consume the observation before dispatch. An unknown click cannot be
      // replayed with the same stale observation, even if the CLI exits.
      this.browseCurrent = null;
      action += `markBrowsePhase('browse-next-before');const before=await page.evaluate(${q(videoExpression)});if(before?.id!==${q(input.expectedVideoId)}||before.platformVideoId!==${q(expectedPlatformVideoId)}||before.identityKind!=='platform-video-id')throw Error('BINDINGS_REQUIRED');markBrowsePhase('browse-next-click');await page.locator(${q(DOUYIN_NEXT)}).click();markBrowsePhase('browse-next-wait');await page.waitForFunction(${q(`(async()=>{const v=await (${videoExpression});return Boolean(v&&v.identityKind==='platform-video-id'&&/^[0-9]{10,25}(?![\\s\\S])/.test(v.platformVideoId||'')&&v.platformVideoId!==${q(expectedPlatformVideoId)});})()`)},{timeout:10000});`;
    }
    const body = this.#prefix() + `const markBrowsePhase=phase=>{if(typeof __dfyPhase==='function')__dfyPhase(phase);};` + own + action
      + `await assertSafety();markBrowsePhase('browse-video-read');const current=await page.evaluate(${q(videoExpression)});if(!current||current.media.muted!==true||current.media.paused!==true${input.action === 'next' ? `||current.identityKind!=='platform-video-id'||!/^[0-9]{10,25}(?![\\s\\S])/.test(current.platformVideoId||'')||current.platformVideoId===${q(expectedPlatformVideoId)}` : ''})throw Error('BINDINGS_REQUIRED');await assertBrowseAccount(true);markBrowsePhase('browse-return-feed');const returnTabs=(await browser.listTabs()).filter(t=>isBrowseFeedUrl(t.url));if(returnTabs.length!==1)throw Error('BINDINGS_REQUIRED');await browser.switchTab(returnTabs[0].targetId);await assertSafety();markBrowsePhase('browse-return-video-wait');await page.waitForFunction(${q(videoReady)},{timeout:15000});markBrowsePhase('browse-return-video-read');const finalCurrent=await page.evaluate(${q(videoExpression)});if(!finalCurrent||finalCurrent.id!==current.id||finalCurrent.platformVideoId!==current.platformVideoId||finalCurrent.media.muted!==true||finalCurrent.media.paused!==true)throw Error('BINDINGS_REQUIRED');markBrowsePhase('browse-receipt');const result={ok:true,accountId:${q(context.accountId)},current:finalCurrent};`;
    try {
      const result = await this.runtime.run(body, context);
      const current = result?.current;
      const stableIdentity = videoIdentity !== null && current?.identityKind === 'platform-video-id'
        && typeof current.platformVideoId === 'string' && /^[0-9]{10,25}(?![\s\S])/.test(current.platformVideoId);
      const sourceIdentity = current?.identityKind === 'media-source-fingerprint' && current.platformVideoId === null;
      const sourceFingerprint = typeof current?.mediaSourceFingerprint === 'string' && /^media-[a-f0-9]{64}$/.test(current.mediaSourceFingerprint);
      if (result?.ok !== true || result.accountId !== context.accountId || !/^media-[a-f0-9]{64}$/.test(result.current?.id || '')
        || !(stableIdentity || sourceIdentity) || !(sourceFingerprint || stableIdentity && current.mediaSourceFingerprint === null
          && Number.isInteger(current.media?.readyState) && current.media.readyState >= 2 && current.media.readyState <= 4)
        || stableIdentity && current.id !== 'media-' + digest(['platform-video-id', current.platformVideoId])
        || sourceIdentity && current.id !== current.mediaSourceFingerprint
        || result.current.media?.muted !== true || result.current.media?.paused !== true
        || input.action === 'next' && (!result.current.platformVideoId || result.current.platformVideoId === expectedPlatformVideoId)) deny('INVALID_RECEIPT');
      this.browseAccount = context.accountId; this.browseCurrent = result.current; this.browseState = 'active';
      if (this.browseHistory.at(-1)?.id !== result.current.id) this.browseHistory.push(structuredClone(result.current));
      this.browseHistory = this.browseHistory.slice(-20);
      while (this.browseHistory.length && Buffer.byteLength(JSON.stringify(this.browseHistory)) > 24000) this.browseHistory.shift();
      return { ...local(), accountId: context.accountId };
    } catch (error) { this.browseCurrent = null; this.browseState = 'stopped'; throw error; }
  }
  async preflight(input) {
    const recipe = this.#recipe(input.operation, 'writes');
    if (this.#bindings()?.identity?.url) deny('BINDINGS_REQUIRED');
    if (!recipe.submit || typeof recipe.submitText !== 'string' || !recipe.submitText.trim() || !recipe.response?.url || !recipe.response.idPath || !recipe.response.okPath || !recipe.response.authorPath) deny('BINDINGS_REQUIRED');
    safeUrl(this.key, recipe.response.url);
    const proof = Object.fromEntries(['target', 'parentId', 'rootId', 'text', 'title'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    requestReceipt(recipe.response.url, '__dfy_receipt_preflight', recipe.request, proof);
    // Uploaded asset IDs must be bound to the selected media before enabling a
    // video recipe. A title match alone cannot prove which video was submitted.
    if (input.operation === 'video') deny('BINDINGS_REQUIRED');
    if (input.operation === 'video' && (!recipe.upload || !recipe.uploadReady || !recipe.declaration
      || input.cover && !recipe.cover || input.tags?.length && !recipe.tags)) deny('BINDINGS_REQUIRED');
    if (['comment', 'reply', 'message', 'post'].includes(input.operation) && !recipe.text) deny('BINDINGS_REQUIRED');
  }
  async execute(input, context) {
    await this.preflight(input); const recipe = this.#recipe(input.operation, 'writes'), bindings = this.#bindings();
    if (bindings.accountId !== context.accountId) deny('ACCOUNT_MISMATCH');
    const claim = `const fs=await import('node:fs');const claim=fs.openSync(${q(context.claimFile)},'wx',0o600);try{fs.writeFileSync(claim,${q(context.approvalDigest)});fs.fsyncSync(claim);}finally{fs.closeSync(claim);}\n`;
    const proof = Object.fromEntries(['target', 'parentId', 'rootId', 'text', 'title'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    const capture = requestReceipt(recipe.response.url, '__dfy_receipt_' + context.operationId.replaceAll('-', ''), recipe.request, proof);
    let edit = '';
    if (input.operation === 'video') {
      edit += `await page.locator(${q(recipe.upload)}).setInputFiles(${q(context.media.path)});\n`;
      if (input.cover) edit += `await page.locator(${q(recipe.cover)}).setInputFiles(${q(input.cover)});\n`;
      edit += `await page.locator(${q(recipe.uploadReady)}).waitFor({state:'visible',timeout:180000});\n`;
      if (input.title && recipe.title) edit += `await page.locator(${q(recipe.title)}).fill(${q(input.title)});\n`;
      if (input.tags?.length) edit += `await page.locator(${q(recipe.tags)}).fill(${q(input.tags.join(' '))});\n`;
      if (!recipe.declarationValues?.[input.declaration]) deny('DECLARATION_BINDING_REQUIRED');
      edit += `await page.locator(${q(recipe.declarationValues[input.declaration])}).click();\n`;
    }
    if (input.text && recipe.text) edit += `await page.locator(${q(recipe.text)}).fill(${q(input.text)});\n`;
    const readBack = `(()=>{const one=s=>{const r=document.querySelectorAll(s);if(r.length!==1)throw Error('AMBIGUOUS_EDITOR');return r[0];};`
      + (input.text && recipe.text ? `const text=one(${q(recipe.text)});if((text.value??text.innerText)!==${q(input.text)})return false;` : '')
      + `const button=one(${q(recipe.submit)});if(button.tagName!=='BUTTON'||button.disabled||(button.innerText||'').trim()!==${q(recipe.submitText)})return false;`
      + `return true;})()`;
    const body = this.#prefix() + this.#assertIdentity() + `await page.goto(${q(this.#target(recipe, input))},{wait:true,timeout:30000});await assertAccount();\n`
      + claim + edit + `await assertAccount();if(await page.evaluate(${q(readBack)})!==true)throw Error('DRAFT_CHANGED');\n`
      + `await page.evaluate(${q(capture.install)});let captured;try{const observed=page.waitForResponse(${q(recipe.response.url)},{timeout:30000});\n`
      + `await page.locator(${q(recipe.submit)}).click();const response=await observed;await page.waitForFunction(${q(capture.wait)},{timeout:10000});captured=await page.evaluate(${q(capture.read)});if([403,412,429].includes(response.status()))throw Error('RISK_CONTROL');if(response.status()!==200||response.url()!==${q(recipe.response.url)})throw Error('INVALID_RECEIPT');}finally{await page.evaluate(${q(capture.cleanup)});}\n`
      + `await assertAccount();if(!captured?.done||captured.error||captured.status!==200||captured.url!==${q(recipe.response.url)})throw Error('INVALID_RECEIPT');\n`
      + `const payload=captured.payload,at=p=>p.reduce((v,k)=>v?.[k],payload);if(at(${q(recipe.response.okPath)})!==${q(recipe.response.okValue)}||String(at(${q(recipe.response.authorPath)}))!==${q(context.accountId)})throw Error('INVALID_RECEIPT');\n`
      + `const id=String(at(${q(recipe.response.idPath)})||'');if(!/^[A-Za-z0-9_:-]{1,150}$/.test(id))throw Error('INVALID_RECEIPT');\n`
      + `const result={ok:true,id,accountId:${q(context.accountId)},operation:${q(input.operation)},operationId:${q(context.operationId)},target:${q(input.target || '')},parentId:${q(input.parentId || '')},rootId:${q(input.rootId || '')},contentDigest:${q(digest(input))},status:'submitted'};`;
    return this.runtime.run(body, context, { timeoutMs: input.operation === 'video' ? 240000 : 90000 });
  }
  dispose() { return this.runtime.dispose(); }
}
