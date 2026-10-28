import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeEgoAccountRuntime } from '../packages/dsh-dafeiyu/src/social/native-ego-account-runtime.mjs';
import { BrowserAccountDriver } from '../packages/dsh-dafeiyu/src/social/browser-account.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const context = { authorize: () => true, accountId: '12345' };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-native-activity-')), directory = path.join(root, 'douyin');
  fs.mkdirSync(directory, {mode:0o700}); t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const write = (name,value) => { fs.writeFileSync(path.join(directory,name),JSON.stringify(value),{mode:0o600}); fs.chmodSync(path.join(directory,name),0o600); };
  const read = name => JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
  const binding = {version:2,spaceId:14,spaceName:'dafeiyu-previous-activity',pageLabel:'p1'};
  const accountBinding = {platform:'douyin',verified:true,accountId:'12345'};
  write('native-ego.private.json',binding); write('bindings.private.json',accountBinding);
  write('native-ego-owned.private.json',{version:1,bindingDigest:sha(JSON.stringify(binding)),spaceId:14,createdLabels:[],pending:false,unknown:false,creatingPage:false,workerPid:null});
  const policy = {version:1,profileId:'Default',accountBindingDigest:sha(JSON.stringify(accountBinding))}; write('native-ego-profile.private.json',policy);
  write('native-ego-activity.private.json',{version:1,policyDigest:sha(JSON.stringify(policy)),activityId:randomUUID(),spaceName:binding.spaceName,
    phase:options.active?'active':'closed',bindingDigest:sha(JSON.stringify(binding)),workerPid:null});
  const spaces=new Map(),events=[],children=[]; let nextId=40, finishCalls=0, createCalls=0, now=1000; const closeAtExit = new Set();
  function add(id,name,initialUrl='about:blank') {
    const pages=new Map(); const makePage=(label,url='about:blank',openedBy='agent')=>{
      const p={label,openedBy,targetId:'target-'+id+'-'+label,current:url,
        cdp:async (...args)=>events.push(['cdp',...args]),evaluate:async()=>{events.push(['evaluate',p.current]);assert(!p.current.startsWith('chrome:'));return true;},url:async()=>p.current,
        goto:async url=>{const phase=read('native-ego-activity.private.json').phase;if(phase==='creating'){assert.equal(url,'about:blank');if(options.initialGotoFails)throw Error('blank navigation failed');}else assert.equal(phase,'active');p.current=phase==='creating'&&options.initialRedirect?options.initialRedirect:url;events.push(['goto',url]);},
        close:async()=>{pages.delete(label);},waitForFunction:async()=>{},click:async()=>{},fill:async()=>{}};
      pages.set(label,p);return p;
    };
    makePage('p1',initialUrl);
    const task={spaceId:id,name,ownership:'agent',profileId:'Default',pages,
      page:label=>{assert(pages.has(label));return pages.get(label);},
      tabs:async()=>[...pages.values()].map(p=>({label:p.label,openedBy:p.openedBy,targetId:p.targetId,url:p.current})),
      newPage:async()=>makePage('p'+(pages.size+1)),
      finish:async finishOptions=>{assert.deepEqual(finishOptions,{keep:[]});assert.equal(read('native-ego-activity.private.json').phase,'stopping');finishCalls++;
        if(options?.failFinish)throw Error('fixture');
        if(options?.leaveSpace)return;
        if(options.closeOnProcessExit){closeAtExit.add(id);return {closed:['p1'],retained:[]};}
        if(finishDelay) setTimeout(()=>spaces.delete(id),finishDelay); else spaces.delete(id);
        return {closed:['p1'],retained:[]};}};
    spaces.set(id,task);return task;
  }
  let finishDelay=options.finishDelay||0;
  if(options.active)add(14,binding.spaceName);
  const sdkList=async()=>[...spaces.values()].map(({spaceId,name,ownership,profileId})=>({id:spaceId,name,ownership,profileId}));
  const sdkTask=async(name,opts)=>{
    if(typeof name==='number'){assert(spaces.has(name));return spaces.get(name);}
    const j=read('native-ego-activity.private.json');assert.equal(j.phase,'creating');assert.equal(j.spaceName,name);assert.deepEqual(opts,{profileId:'Default'});
    createCalls++;events.push(['create',name]); const task=add(nextId++,name,options.initialUrl||'chrome://newtab/');options.afterCreate?.();return task;
  };
  const spawnProcess=(exe,args,opts)=>{
    assert.equal(opts.shell,false);assert.deepEqual(args,['nodejs']);
    const child=new EventEmitter();child.pid=100000+children.length;child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();let done=false;
    const close=code=>{if(!done){done=true;for(const id of closeAtExit)spaces.delete(id);closeAtExit.clear();child.emit('close',code);}};
    child.kill=signal=>{events.push(['kill',signal]);setImmediate(()=>close(null));return true;};
    let script='';child.stdin.on('data',b=>{script+=b.toString();});child.stdin.on('finish',()=>setImmediate(async()=>{
      if(done)return;
      try {
        const fn=new AsyncFunction('profiles','listTaskSpaces','taskSpace','console',script);
        await fn(async()=>options.noProfile?[]:[{id:'Default',isDefault:true,name:'Default'}],sdkList,sdkTask,
          {log:value=>{if(!options.dropReceipt && !(options.dropReceiptOnMetadata && script.includes('@@DFY_ACTIVITY_CLOSED_')))child.stdout.write(value+'\n');}});
        options.afterExecute?.();close(0);
      }catch {close(1);}
    }));children.push(child);return child;
  };
  const runtime=()=>new NativeEgoAccountRuntime({directory,verifyCli:()=>options.cliValid!==false,spawnProcess,now:()=>now});
  return {root,directory,write,read,binding,spaces,events,children,add,runtime,options,setNow:v=>{now=v;},get createCalls(){return createCalls;},get finishCalls(){return finishCalls;}};
}

test('closed metadata reads only the fixed profile, status never spawns, and run cannot allocate',async t=>{
  const f=fixture(t),r=f.runtime();
  assert.equal(r.status().lifecycle,'closed');assert.equal(r.status().activityReady,false);assert.equal(f.children.length,0);
  await assert.rejects(r.run('const result={};',context),{code:'BINDINGS_REQUIRED'});assert.equal(f.children.length,0);
  const check=await r.checkMetadata(context);assert.equal(check.state,'ready-to-start');assert.equal(r.status().canStartNewActivity,true);assert.equal(r.status().activityReady,false);
  assert.equal(f.createCalls,0);assert.equal(f.events.length,0);
});

test('explicit open intent allocates once, current reuses it, stop finishes once, next activity is new',async t=>{
  const f=fixture(t),r=f.runtime();await r.beginActivity(context);
  const first=f.read('native-ego-activity.private.json');assert.equal(first.phase,'active');assert.equal(f.createCalls,1);
  await r.run('const result={ok:true};',context);await r.run('const result={ok:true};',context);assert.equal(f.createCalls,1);
  await assert.rejects(r.beginActivity(context),{code:'BUSY'});assert.equal(f.createCalls,1);
  const stopped=await r.stop(context);assert.deepEqual(stopped,{stopped:true,taskSpaceClosed:true,spaceRetained:false,browserStopped:false});assert.equal(f.finishCalls,1);assert.equal(f.spaces.size,0);
  await r.stop(context);assert.equal(f.finishCalls,1);
  f.setNow(60*60*1000);await r.beginActivity(context);
  const second=f.read('native-ego-activity.private.json');assert.notEqual(second.activityId,first.activityId);assert.notEqual(second.spaceName,first.spaceName);assert.equal(f.createCalls,2);
});

test('stop waits on the same finished Space metadata and never repeats finish',async t=>{
  const f=fixture(t,{active:true,finishDelay:150}),r=f.runtime();await r.stop(context);assert.equal(f.finishCalls,1);assert.equal(f.read('native-ego-activity.private.json').phase,'closed');
});

test('active missing Space never reallocates; explicit clean stop records absence before a new activity',async t=>{
  const f=fixture(t,{active:true}),r=f.runtime();f.spaces.clear();
  await assert.rejects(r.run('const result={};',context),{code:'BINDINGS_REQUIRED'});
  await assert.rejects(r.beginActivity(context),{code:'BUSY'});assert.equal(f.createCalls,0);
  await r.stop(context);assert.equal(f.finishCalls,0);await r.beginActivity(context);assert.equal(f.createCalls,1);
});

test('lost create receipt is durable unknown across reload and cannot allocate or finish again',async t=>{
  const f=fixture(t,{dropReceipt:true}),r=f.runtime();await assert.rejects(r.beginActivity(context),{code:'INVALID_RECEIPT'});
  assert.equal(f.createCalls,1);assert.equal(f.read('native-ego-activity.private.json').phase,'unknown');
  const again=f.runtime();await assert.rejects(again.beginActivity(context));await assert.rejects(again.run('const result={};',context));await assert.rejects(again.stop(context));assert.equal(f.createCalls,1);assert.equal(f.finishCalls,0);
});

test('policy, owner or CLI changing after creation keeps unknown instead of committing active',async t=>{
  for(const which of ['policy','owner','cli']){
    const f=fixture(t);let authorized=true;f.options.afterExecute=()=>{if(which==='owner')authorized=false;else if(which==='cli')f.options.cliValid=false;else f.write('native-ego-profile.private.json',{version:1,profileId:'Default',accountBindingDigest:'0'.repeat(64)});};
    await assert.rejects(f.runtime().beginActivity({...context,authorize:()=>authorized}));assert.equal(f.createCalls,1);assert.notEqual(f.read('native-ego-activity.private.json').phase,'active');
    await assert.rejects(f.runtime().beginActivity(context));assert.equal(f.createCalls,1);
  }
});

test('unknown owned state, incomplete creation, revoked authority and aborted calls never allocate',async t=>{
  for(const field of ['pending','unknown','creatingPage']){
    const f=fixture(t);f.write('native-ego-owned.private.json',{...f.read('native-ego-owned.private.json'),[field]:true});await assert.rejects(f.runtime().beginActivity(context));assert.equal(f.createCalls,0);
  }
  const f=fixture(t),c=new AbortController();c.abort();await assert.rejects(f.runtime().beginActivity({...context,signal:c.signal}));await assert.rejects(f.runtime().beginActivity({authorize:()=>false}));assert.equal(f.children.length,0);
});

test('unmanaged or user-owned tabs prevent finish and keep activity protected',async t=>{
  for(const which of ['ownership','tab']){
    const f=fixture(t,{active:true});const task=f.spaces.get(14);
    if(which==='ownership')task.ownership='user';else task.pages.set('p9',{label:'p9',openedBy:'unknown',current:'https://example.test',targetId:'protected'});
    await assert.rejects(f.runtime().stop(context),{code:'CLEANUP_UNCONFIRMED'});assert.equal(f.finishCalls,0);assert.equal(f.read('native-ego-activity.private.json').phase,'unknown');assert.equal(f.spaces.size,1);
  }
});

test('missing owner policy with an activity journal cannot fall back to legacy and bypass a hold',async t=>{
  const f=fixture(t,{active:true});fs.unlinkSync(path.join(f.directory,'native-ego-profile.private.json'));
  const r=f.runtime();assert.equal(r.available,false);await assert.rejects(r.run('const result={};',context));assert.equal(f.children.length,0);
});

test('only BrowserAccountDriver open invokes allocation; current, next, account and history never do',async()=>{
  const calls=[],runtime={children:new Set(),available:true,async beginActivity(){calls.push('begin');throw Error('begin stopped fixture');},async run(){calls.push('run');throw Error('run stopped fixture');},async stop(){calls.push('stop');return {stopped:true,taskSpaceClosed:true,spaceRetained:false,browserStopped:false};}};
  const driver=new BrowserAccountDriver({key:'douyin',directory:'/unused',runtime,bindings:{platform:'douyin',verified:true,accountId:'12345',identity:{url:'https://creator.douyin.com/creator-micro/home',selector:'#own',attribute:'innerText',pattern:'^(12345)$'}}});
  await assert.rejects(driver.browse({action:'open'},context),/begin stopped/);assert.deepEqual(calls,['begin']);calls.length=0;
  await assert.rejects(driver.browse({action:'current'},context),/run stopped/);assert.deepEqual(calls,['run']);calls.length=0;
  await assert.rejects(driver.account(context),/run stopped/);assert.deepEqual(calls,['run']);calls.length=0;
  await driver.browse({action:'history'},context);assert.deepEqual(calls,[]);await assert.rejects(driver.browse({action:'next',expectedVideoId:'no-observation'},context));assert.deepEqual(calls,[]);
  assert.equal((await driver.browse({action:'stop'},context)).taskSpaceClosed,true);
});

test('lost finish receipt retains unknown even when the Space actually closed; no automatic finish or open replay',async t=>{
  const f=fixture(t,{active:true,dropReceipt:true});await assert.rejects(f.runtime().stop(context),{code:'INVALID_RECEIPT'});
  assert.equal(f.finishCalls,1);assert.equal(f.spaces.size,0);assert.equal(f.read('native-ego-activity.private.json').phase,'unknown');
  const r=f.runtime();await assert.rejects(r.stop(context));await assert.rejects(r.beginActivity(context));assert.equal(f.finishCalls,1);assert.equal(f.createCalls,0);
});

test('cancellation after Space allocation drains only its CLI child and cannot commit a new active activity',async t=>{
  const c=new AbortController(),f=fixture(t,{afterCreate:()=>c.abort()});
  await assert.rejects(f.runtime().beginActivity({...context,signal:c.signal}));assert.equal(f.createCalls,1);
  assert.equal(f.read('native-ego-activity.private.json').phase,'unknown');assert(f.events.some(e=>e[0]==='kill'));
  await assert.rejects(f.runtime().beginActivity(context));assert.equal(f.createCalls,1);assert.equal(f.finishCalls,0);
});

test('changed account-binding bytes and missing fixed profile never silently change the authorized account',async t=>{
  const f=fixture(t);f.write('bindings.private.json',{platform:'douyin',verified:true,accountId:'other'});await assert.rejects(f.runtime().beginActivity(context));assert.equal(f.children.length,0);
  const g=fixture(t,{noProfile:true}),r=g.runtime();const metadata=await r.checkMetadata(context);
  assert.equal(metadata.ready,false);assert.equal(metadata.reason,'profile-unavailable');assert.equal(r.status().canStartNewActivity,false);assert.equal(g.createCalls,0);
});

test('closed with dirty owned labels or a worker never advertises ready-to-start',async t=>{
  for(const dirty of [{createdLabels:['p2']},{workerPid:process.pid}]){
    const f=fixture(t);f.write('native-ego-owned.private.json',{...f.read('native-ego-owned.private.json'),...dirty});
    const r=f.runtime();assert.equal(r.status().canStartNewActivity,false);assert.equal(r.status().activityReady,false);assert.equal(r.browseState,'unknown');
    await assert.rejects(r.checkMetadata(context));assert.equal(f.children.length,0);
  }
});

test('finite read scope provisions only from closed for the same account and demands a real finish receipt',async()=>{
  const calls=[],runtime={lifecycle:'closed',async beginActivity(){calls.push('begin');return {started:true};},async stop(){calls.push('stop');return {stopped:true,taskSpaceClosed:true,spaceRetained:false,browserStopped:false};}};
  const driver=new BrowserAccountDriver({key:'douyin',directory:'/unused',runtime,bindings:{platform:'douyin',verified:true,accountId:'12345'}});
  assert.equal(await driver.beginReadActivity(context),true);assert.deepEqual(calls,['begin']);calls.length=0;
  runtime.lifecycle='active';assert.equal(await driver.beginReadActivity(context),false);assert.deepEqual(calls,[]);
  runtime.lifecycle='legacy';assert.equal(await driver.beginReadActivity(context),false);assert.deepEqual(calls,[]);
  runtime.lifecycle='unknown';await assert.rejects(driver.beginReadActivity(context),{code:'CLEANUP_UNCONFIRMED'});assert.deepEqual(calls,[]);
  await assert.rejects(driver.beginReadActivity({...context,accountId:'different'}),{code:'ACCOUNT_MISMATCH'});assert.deepEqual(calls,[]);
  assert.equal((await driver.endReadActivity(context)).taskSpaceClosed,true);assert.deepEqual(calls,['stop']);
  runtime.stop=async()=>({stopped:true,spaceRetained:true,browserStopped:false});await assert.rejects(driver.endReadActivity(context),{code:'CLEANUP_UNCONFIRMED'});
});


test('finish failure and non-disappearing Space remain unknown and never replay finish',async t=>{
  for(const options of [{active:true,failFinish:true},{active:true,leaveSpace:true}]){
    const f=fixture(t,options);await assert.rejects(f.runtime().stop(context),e=>['CLEANUP_UNCONFIRMED','BROWSER_UNKNOWN'].includes(e.code));
    assert.equal(f.finishCalls,1);assert.equal(f.read('native-ego-activity.private.json').phase,'unknown');
    await assert.rejects(f.runtime().stop(context));await assert.rejects(f.runtime().beginActivity(context));assert.equal(f.finishCalls,1);assert.equal(f.createCalls,0);
  }
});

test('owner revocation after finish cannot commit closed or start a replacement',async t=>{
  const f=fixture(t,{active:true});let allowed=true;f.options.afterExecute=()=>{allowed=false;};
  await assert.rejects(f.runtime().stop({...context,authorize:()=>allowed}),{code:'FORBIDDEN'});
  assert.equal(f.finishCalls,1);assert.equal(f.read('native-ego-activity.private.json').phase,'unknown');
  await assert.rejects(f.runtime().beginActivity(context));assert.equal(f.createCalls,0);
});


test('finish is confirmed after its process exits before a metadata-only second process observes absence',async t=>{
  const f=fixture(t,{active:true,closeOnProcessExit:true}),r=f.runtime();
  await r.stop(context);assert.equal(f.children.length,2);assert.equal(f.finishCalls,1);assert.equal(f.spaces.size,0);
  assert.equal(f.read('native-ego-activity.private.json').phase,'closed');
});

test('abort between finish and metadata confirmation leaves stopping evidence unknown without another CLI',async t=>{
  const c=new AbortController(),f=fixture(t,{active:true,closeOnProcessExit:true});let count=0;
  f.options.afterExecute=()=>{if(++count===1)c.abort();};
  await assert.rejects(f.runtime().stop({...context,signal:c.signal}),{code:'FORBIDDEN'});
  assert.equal(f.children.length,1);assert.equal(f.finishCalls,1);assert.equal(f.spaces.size,0);
  assert.equal(f.read('native-ego-activity.private.json').phase,'unknown');
  await assert.rejects(f.runtime().beginActivity(context));assert.equal(f.createCalls,0);
});


test('second-stage receipt loss preserves unknown without another finish or replacement',async t=>{
  const f=fixture(t,{active:true,closeOnProcessExit:true,dropReceiptOnMetadata:true});
  await assert.rejects(f.runtime().stop(context),{code:'INVALID_RECEIPT'});assert.equal(f.children.length,2);assert.equal(f.finishCalls,1);
  assert.equal(f.read('native-ego-activity.private.json').phase,'unknown');await assert.rejects(f.runtime().stop(context));await assert.rejects(f.runtime().beginActivity(context));assert.equal(f.finishCalls,1);
});

test('policy, CLI and journal CAS changes during second-stage observation cannot commit closed',async t=>{
  for(const which of ['policy','cli','journal']){
    const f=fixture(t,{active:true,closeOnProcessExit:true});let count=0;
    f.options.afterExecute=()=>{if(++count!==2)return;
      if(which==='policy')f.write('native-ego-profile.private.json',{version:1,profileId:'Default',accountBindingDigest:'0'.repeat(64)});
      else if(which==='cli')f.options.cliValid=false;
      else f.write('native-ego-activity.private.json',{...f.read('native-ego-activity.private.json'),activityId:randomUUID()});
    };
    await assert.rejects(f.runtime().stop(context));assert.equal(f.children.length,2);assert.equal(f.finishCalls,1);assert.notEqual(f.read('native-ego-activity.private.json').phase,'closed');
    await assert.rejects(f.runtime().beginActivity(context));assert.equal(f.createCalls,0);
  }
});


test('a real chrome new-tab initial p1 is normalized before any DOM evaluation and reused for the first identity page',async t=>{
  const f=fixture(t,{initialUrl:'chrome://newtab/'}),r=f.runtime();await r.beginActivity(context);
  const blank=f.events.findIndex(e=>e[0]==='goto'&&e[1]==='about:blank');const evaluated=f.events.findIndex(e=>e[0]==='evaluate');
  assert(blank>=0&&evaluated>blank);assert(!f.events.some(e=>e[0]==='evaluate'&&e[1].startsWith('chrome:')));
  await r.run("await browser.openOrReuseTab('https://creator.douyin.com/creator-micro/home');const result={ok:true};",context);
  const task=[...f.spaces.values()][0];assert.equal(task.pages.size,1);assert.equal(task.pages.get('p1').current,'https://creator.douyin.com/creator-micro/home');
  await r.run("await browser.openOrReuseTab('https://www.douyin.com/?recommend=1');const result={ok:true};",context);
  assert.equal(task.pages.size,2);assert.equal(task.pages.get('p1').current,'https://creator.douyin.com/creator-micro/home');assert.equal(task.pages.get('p2').current,'https://www.douyin.com/?recommend=1');
});

test('blank-page navigation failure or unexpected committed URL holds the created activity unknown and never creates a replacement',async t=>{
  for(const options of [{initialGotoFails:true},{initialRedirect:'chrome://newtab/'}]){
    const f=fixture(t,options);await assert.rejects(f.runtime().beginActivity(context));
    assert.equal(f.createCalls,1);assert.equal(f.read('native-ego-activity.private.json').phase,'unknown');
    assert(!f.events.some(e=>e[0]==='evaluate'));
    await assert.rejects(f.runtime().beginActivity(context));assert.equal(f.createCalls,1);assert.equal(f.finishCalls,0);
  }
});
