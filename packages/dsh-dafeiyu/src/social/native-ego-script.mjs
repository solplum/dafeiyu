import { NATIVE_EGO_PHASES, NATIVE_EGO_ERROR_NAMES } from './native-ego-diagnostic.mjs';
const q = JSON.stringify;
// Supplemental manual-step playback guard; native tab muting is version pinned.
const MEDIA = `(()=>{const pause=n=>{if(n?.matches?.('video,audio')){n.muted=true;n.pause();}n?.querySelectorAll?.('video,audio').forEach(v=>{v.muted=true;v.pause();});};pause(document);if(!window.__dfy_native_pause_v1){document.addEventListener('play',e=>pause(e.target),true);new MutationObserver(rs=>rs.forEach(r=>r.addedNodes.forEach(pause))).observe(document,{childList:true,subtree:true});Object.defineProperty(window,'__dfy_native_pause_v1',{value:true});}return [...document.querySelectorAll('video,audio')].every(v=>v.paused&&v.muted);})()`;
export function nativeEgoScript({ binding, state, stateFile, marker, key, body, stop = false, profileId }) {
  const hosts = key === 'douyin' ? ['www.douyin.com', 'creator.douyin.com'] : ['x.com'];
  const setup = `
const __fs=await import('node:fs'),__path=await import('node:path');
const __profileId=${q(profileId)};
const __binding=${q(binding)},__state=${q(state)},__stateFile=${q(stateFile)},__hosts=${q(hosts)};
const __error=code=>{throw Error(code);};
const __save=()=>{const previousPhase=__phase;__phase='state-write';const temp=__stateFile+'.'+${q(marker.replaceAll('@', ''))}+'.tmp';const fd=__fs.openSync(temp,'wx',0o600);try{__fs.writeFileSync(fd,JSON.stringify(__state));__fs.fsyncSync(fd);}finally{__fs.closeSync(fd);}try{__fs.renameSync(temp,__stateFile);const directory=__fs.openSync(__path.dirname(__stateFile),'r');try{__fs.fsyncSync(directory);}finally{__fs.closeSync(directory);}}finally{__fs.rmSync(temp,{force:true});}__phase=previousPhase;};
let __task,__selected,__tabs=new Map();
const __knownLabel=label=>label===__binding.pageLabel||__state.createdLabels.includes(label);
const __attach=async()=>{if(__task)return;__phase='binding-list';const found=(await listTaskSpaces()).find(x=>x.id===__binding.spaceId);if(!found||found.name!==__binding.spaceName||found.ownership!=='agent'||__profileId!==undefined&&found.profileId!==__profileId)__error('BINDINGS_REQUIRED');__phase='binding-resume';__task=await taskSpace(__binding.spaceId);if(__task.spaceId!==__binding.spaceId||__task.name!==__binding.spaceName||__task.ownership!=='agent')__error('BINDINGS_REQUIRED');__phase='identity-tabs';const identity=(await __task.tabs()).filter(x=>x.label===__binding.pageLabel&&x.openedBy==='agent');if(identity.length!==1)__error('BINDINGS_REQUIRED');__selected=__task.page(__binding.pageLabel);__phase='script-body';};
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
openOrReuseTab:async(value,options={})=>{await __attach();const url=__url(value);const matching=(await __task.tabs()).filter(t=>t.url===url);if(matching.length>1)__error('BINDINGS_REQUIRED');if(matching.length){const t=matching[0];if(!t.label||t.openedBy!=='agent'||!__knownLabel(t.label))__error('BINDINGS_REQUIRED');__selected=__task.page(t.label);return;}if(__profileId!==undefined&&__state.createdLabels.length===0){const first=(await __task.tabs()).filter(t=>t.label===__binding.pageLabel&&t.openedBy==='agent');if(first.length===1&&first[0].url==='about:blank'){__selected=__task.page(__binding.pageLabel);await __goto(url,options);return;}}if(__state.createdLabels.length>=20)__error('BINDINGS_REQUIRED');__state.creatingPage=true;__save();const p=await __task.newPage();if(!/^p[1-9][0-9]*$/.test(p.label)||p.label===__binding.pageLabel||p.openedBy!=='agent')__error('BROWSER_UNKNOWN');__state.createdLabels.push(p.label);__state.creatingPage=false;__save();__selected=p;const initialUrl=await p.url();if(initialUrl!=='about:blank'){if(initialUrl!=='chrome://newtab/')__error('BINDINGS_REQUIRED');await p.goto('about:blank',{timeout:10000,waitUntil:'domcontentloaded'});if(await p.url()!=='about:blank')__error('BINDINGS_REQUIRED');}await __goto(url,options);}};
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
  return `let __phase='bootstrap',__output;const __dfyPhase=value=>{if(${q(NATIVE_EGO_PHASES)}.includes(value))__phase=value;};try{const __resultPromise = (async () => {${body}})(); __output = await __resultPromise;}catch(error){const rawCode=String(error?.message||''),code=['RISK_CONTROL','ACCOUNT_MISMATCH','BINDINGS_REQUIRED','CLEANUP_UNCONFIRMED'].includes(rawCode)?rawCode:'BROWSER_UNKNOWN';__output={__dfy_error:code,diagnostic:{phase:${q(NATIVE_EGO_PHASES)}.includes(__phase)?__phase:'script-body',name:${q(NATIVE_EGO_ERROR_NAMES)}.includes(error?.name)?error.name:'Error',code:error?.name==='TimeoutError'||['ETIMEDOUT','TIMEOUT'].includes(error?.code)?'TIMEOUT':code}};}console.log(${q(marker)}+JSON.stringify(__output));\n`;
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

// Owner-policy allocation normalizes only the new Agent page to about:blank.
// It never reads internal browser pages or imports credentials.
export function nativeEgoActivityStartScript({ profileId, spaceName, marker }) {
  return nativeEgoEnvelope(`
const profileId=${q(profileId)},name=${q(spaceName)};
if((await profiles()).filter(p=>p.id===profileId).length!==1)throw Error('BINDINGS_REQUIRED');
if((await listTaskSpaces()).some(s=>s.name===name))throw Error('BINDINGS_REQUIRED');
const task=await taskSpace(name,{profileId});
const found=(await listTaskSpaces()).find(s=>s.id===task.spaceId);
if(!found||found.name!==name||found.ownership!=='agent'||found.profileId!==profileId||task.name!==name||task.ownership!=='agent')throw Error('BINDINGS_REQUIRED');
const tabs=await task.tabs();
if(tabs.length!==1||tabs[0].label!=='p1'||tabs[0].openedBy!=='agent')throw Error('CLEANUP_UNCONFIRMED');
const p=task.page('p1');
await p.goto('about:blank',{timeout:10000,waitUntil:'domcontentloaded'});
if(await p.url()!=='about:blank')throw Error('BINDINGS_REQUIRED');
await p.cdp('Page.addScriptToEvaluateOnNewDocument',{source:${q(MEDIA)}});
if(await p.evaluate(${q(MEDIA)})!==true)throw Error('CLEANUP_UNCONFIRMED');
return {binding:{version:2,spaceId:task.spaceId,spaceName:name,pageLabel:'p1'}};`,marker);
}

// End only this activity's exact, fully accounted Agent space. There is no
// claim, handoff, GUI activation, cookie operation or shared-browser shutdown.
export function nativeEgoActivityStopScript({ binding, labels, profileId, marker }) {
  return nativeEgoEnvelope(`
const binding=${q(binding)},labels=${q(labels)},profileId=${q(profileId)};
const spaces=await listTaskSpaces(),found=spaces.find(s=>s.id===binding.spaceId);
if(!found){if(spaces.some(s=>s.name===binding.spaceName))throw Error('CLEANUP_UNCONFIRMED');return {finishAccepted:true,alreadyAbsent:true};}
if(found.name!==binding.spaceName||found.ownership!=='agent'||found.profileId!==profileId)throw Error('CLEANUP_UNCONFIRMED');
const task=await taskSpace(binding.spaceId);
if(task.spaceId!==binding.spaceId||task.name!==binding.spaceName||task.ownership!=='agent')throw Error('CLEANUP_UNCONFIRMED');
const expected=[binding.pageLabel,...labels],tabs=await task.tabs();
if(tabs.length!==expected.length||tabs.some(t=>t.openedBy!=='agent'||!expected.includes(t.label))||expected.some(label=>tabs.filter(t=>t.label===label).length!==1))throw Error('CLEANUP_UNCONFIRMED');
for(const label of expected){if(await task.page(label).evaluate(${q(MEDIA)})!==true)throw Error('CLEANUP_UNCONFIRMED');}
const result={finishAccepted:true,alreadyAbsent:false};
await task.finish({keep:[]});
return result;`,marker);
}

// finish() is the last browser operation in its own invocation. Its removal
// may be committed only when that Node invocation exits, so observe absence
// from a fresh, metadata-only invocation; never repeat finish or allocate here.
export function nativeEgoActivityClosedScript({ binding, marker }) {
  return nativeEgoEnvelope(`
const binding=${q(binding)};
for(let attempt=0;attempt<51;attempt++){
  if(!(await listTaskSpaces()).some(s=>s.id===binding.spaceId||s.name===binding.spaceName))return {stopped:true,taskSpaceClosed:true,spaceRetained:false,browserStopped:false};
  if(attempt<50)await new Promise(resolve=>setTimeout(resolve,100));
}
throw Error('CLEANUP_UNCONFIRMED');`,marker);
}
