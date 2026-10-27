const q = JSON.stringify;
// Supplemental manual-step playback guard; native tab muting is version pinned.
const MEDIA = `(()=>{const pause=n=>{if(n?.matches?.('video,audio')){n.muted=true;n.pause();}n?.querySelectorAll?.('video,audio').forEach(v=>{v.muted=true;v.pause();});};pause(document);if(!window.__dfy_native_pause_v1){document.addEventListener('play',e=>pause(e.target),true);new MutationObserver(rs=>rs.forEach(r=>r.addedNodes.forEach(pause))).observe(document,{childList:true,subtree:true});Object.defineProperty(window,'__dfy_native_pause_v1',{value:true});}return [...document.querySelectorAll('video,audio')].every(v=>v.paused&&v.muted);})()`;
export function nativeEgoScript({ binding, state, stateFile, marker, key, body, stop = false }) {
  const hosts = key === 'douyin' ? ['www.douyin.com', 'creator.douyin.com'] : ['x.com'];
  const setup = `
const __fs=await import('node:fs');
const __binding=${q(binding)},__state=${q(state)},__stateFile=${q(stateFile)},__hosts=${q(hosts)};
const __error=code=>{throw Error(code);};
const __save=()=>{const previousPhase=__phase;__phase='state-write';const temp=__stateFile+'.'+${q(marker.replaceAll('@', ''))}+'.tmp';const fd=__fs.openSync(temp,'wx',0o600);try{__fs.writeFileSync(fd,JSON.stringify(__state));__fs.fsyncSync(fd);}finally{__fs.closeSync(fd);}try{__fs.renameSync(temp,__stateFile);}finally{__fs.rmSync(temp,{force:true});}__phase=previousPhase;};
let __task,__selected,__tabs=new Map();
const __knownLabel=label=>label===__binding.pageLabel||__state.createdLabels.includes(label);
const __attach=async()=>{if(__task)return;__phase='binding-list';const found=(await listTaskSpaces()).find(x=>x.id===__binding.spaceId);if(!found||found.name!==__binding.spaceName||found.ownership!=='agent')__error('BINDINGS_REQUIRED');__phase='binding-resume';__task=await taskSpace(__binding.spaceId);if(__task.spaceId!==__binding.spaceId||__task.name!==__binding.spaceName||__task.ownership!=='agent')__error('BINDINGS_REQUIRED');__phase='identity-tabs';const identity=(await __task.tabs()).filter(x=>x.label===__binding.pageLabel&&x.openedBy==='agent');if(identity.length!==1)__error('BINDINGS_REQUIRED');__selected=__task.page(__binding.pageLabel);__phase='script-body';};
const __url=value=>{let u;try{u=new URL(value);}catch{__error('BINDINGS_REQUIRED');}if(u.protocol!=='https:'||!__hosts.includes(u.hostname)||u.username||u.password||u.port||u.hash||String(value).length>2000)__error('BINDINGS_REQUIRED');return u.href;};
const __guard=async p=>{await p.cdp('Page.addScriptToEvaluateOnNewDocument',{source:${q(MEDIA)}});await p.evaluate(${q(MEDIA)});};
const __page=()=>{if(!__selected||!__knownLabel(__selected.label))__error('BINDINGS_REQUIRED');return __selected;};
const __goto=async(value,options={})=>{const url=__url(value),p=__page();await __guard(p);await p.goto(url,{timeout:options.timeout||30000,waitUntil:'domcontentloaded'});const rawActual=await p.url();if(__url(rawActual)!==url&&!(${q(key)}==='douyin'&&value==='https://www.douyin.com/?recommend=1'&&rawActual==='https://www.douyin.com/jingxuan'))__error('BINDINGS_REQUIRED');await p.evaluate(${q(MEDIA)});};
const page={url:()=>__page().url(),evaluate:(...args)=>__page().evaluate(...args),snapshot:o=>__page().snapshot(o),screenshot:o=>__page().screenshot(o),goto:__goto,
waitForFunction:(fn,options={})=>__page().waitForFunction(fn,undefined,options),
locator:selector=>({click:options=>__page().click(selector,options),fill:(value,options)=>__page().fill(selector,value,options),waitFor:options=>__page().waitForSelector(selector,options),setInputFiles:()=>__error('BINDINGS_REQUIRED')})};
const taskSpaces={list:async()=>{await __attach();return[{id:__binding.spaceId,name:${q('dfy-social-' + key)},ownership:'agent'}];},
useOrCreate:async name=>{if(![${q('dfy-social-' + key)},__binding.spaceName].includes(name))__error('BINDINGS_REQUIRED');await __attach();return __task;},
claim:()=>__error('BINDINGS_REQUIRED'),handOff:()=>__error('BINDINGS_REQUIRED')};
const browser={ensureRealTab:async()=>{await __attach();__selected=__task.page(__binding.pageLabel);},
listTabs:async()=>{await __attach();const tabs=await __task.tabs();__tabs=new Map(tabs.map(t=>[t.targetId,t]));return tabs.map(({targetId,label,url,openedBy})=>({targetId,label,url,openedBy}));},
switchTab:async targetId=>{const t=__tabs.get(targetId);if(!t?.label||t.openedBy!=='agent'||!__knownLabel(t.label))__error('BINDINGS_REQUIRED');__selected=__task.page(t.label);},
openOrReuseTab:async(value,options={})=>{await __attach();const url=__url(value);const matching=(await __task.tabs()).filter(t=>t.url===url);if(matching.length>1)__error('BINDINGS_REQUIRED');if(matching.length){const t=matching[0];if(!t.label||t.openedBy!=='agent'||!__knownLabel(t.label))__error('BINDINGS_REQUIRED');__selected=__task.page(t.label);return;}if(__state.createdLabels.length>=20)__error('BINDINGS_REQUIRED');__state.creatingPage=true;__save();const p=await __task.newPage();if(!/^p[1-9][0-9]*$/.test(p.label)||p.label===__binding.pageLabel||p.openedBy!=='agent')__error('BROWSER_UNKNOWN');__state.createdLabels.push(p.label);__state.creatingPage=false;__save();__selected=p;await __goto(url,options);}};
await __attach();
`;
  const action = stop ? `
const tabs=await __task.tabs();
for(const label of [__binding.pageLabel,...__state.createdLabels]){const row=tabs.find(t=>t.label===label);if(!row){if(label===__binding.pageLabel)__error('CLEANUP_UNCONFIRMED');__state.createdLabels=__state.createdLabels.filter(x=>x!==label);continue;}if(row.openedBy!=='agent')__error('CLEANUP_UNCONFIRMED');const p=__task.page(label);if(await p.evaluate(${q(MEDIA)})!==true)__error('CLEANUP_UNCONFIRMED');if(label!==__binding.pageLabel){await p.close();if((await __task.tabs()).some(t=>t.label===label))__error('CLEANUP_UNCONFIRMED');__state.createdLabels=__state.createdLabels.filter(x=>x!==label);__save();}}
const remaining=await __task.tabs();if(__state.createdLabels.some(label=>remaining.some(t=>t.label===label)))__error('CLEANUP_UNCONFIRMED');
if(__state.unknown||__state.creatingPage)__error('CLEANUP_UNCONFIRMED');
const result={stopped:true,browserStopped:false,spaceRetained:true};
` : body;
  return nativeEgoEnvelope(`${setup}\n${action}\n__state.pending=false;__save();return result;`, marker);
}

// Keep await separate from an immediately invoked expression. The native
// embedded runtime rewrites top-level await(...) differently from Node ESM.
export function nativeEgoEnvelope(body, marker) {
  return `let __phase='bootstrap',__output;try{const __resultPromise = (async () => {${body}})(); __output = await __resultPromise;}catch(error){const code=String(error?.message||'');__output={__dfy_error:['RISK_CONTROL','ACCOUNT_MISMATCH','BINDINGS_REQUIRED','CLEANUP_UNCONFIRMED'].includes(code)?code:'BROWSER_UNKNOWN',diagnostic:{phase:['bootstrap','binding-list','binding-resume','identity-tabs','script-body','state-write'].includes(__phase)?__phase:'script-body',name:['Error','TypeError','ReferenceError','SyntaxError','RangeError','AbortError'].includes(error?.name)?error.name:'Error'}};}console.log(${q(marker)}+JSON.stringify(__output));\n`;
}


// Owner recovery probes metadata only. It cannot close, navigate or evaluate a
// platform page, and it never adopts an unknown tab.
export function nativeEgoRecoveryScript({ binding, labels, marker }) {
  return nativeEgoEnvelope(`
__phase='binding-list';
const binding=${q(binding)},labels=${q(labels)};
const found=(await listTaskSpaces()).find(x=>x.id===binding.spaceId);
if(!found||found.name!==binding.spaceName||found.ownership!=='agent')throw Error('BINDINGS_REQUIRED');
__phase='binding-resume';const task=await taskSpace(binding.spaceId);
if(task.spaceId!==binding.spaceId||task.name!==binding.spaceName||task.ownership!=='agent')throw Error('BINDINGS_REQUIRED');
__phase='identity-tabs';const tabs=await task.tabs();
if(tabs.filter(t=>t.label===binding.pageLabel&&t.openedBy==='agent').length!==1)throw Error('CLEANUP_UNCONFIRMED');
if(labels.some(label=>tabs.some(t=>t.label===label)))throw Error('CLEANUP_UNCONFIRMED');
return {ready:true,spaceRetained:true};`, marker);
}
