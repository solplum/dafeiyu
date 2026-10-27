import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {SocialAccounts} from '../packages/dsh-dafeiyu/src/social/accounts.mjs';
const yes=()=>true;
function fixture(t,{created=true,failRead=false,failCleanup=false,onRead}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dfy-finite-read-')),events=[];let ready=true,readContext,cleanupContext;
 const driver={get idle(){return ready;},async beginReadActivity(c){assert.equal(c.authorize(),true);assert.equal(c.accountId,'owned-account');events.push('begin');return created;},
 async account(c){assert.equal(c.authorize(),true);events.push('identity');return{loggedIn:true,accountId:'owned-account'};},
 async read(_input,c){events.push('read');readContext=c;await onRead?.(c);if(failRead)throw Object.assign(Error(),{code:typeof failRead==='string'?failRead:'BROWSER_UNKNOWN'});return{ok:true,accountId:'owned-account',items:[]};},
 async endReadActivity(c){cleanupContext=c;events.push('finish');assert.equal(c.authorize(),true);assert.equal(c.signal.aborted,false);if(failCleanup){ready=false;throw Error('unknown');}return{stopped:true,taskSpaceClosed:true,spaceRetained:false,browserStopped:false};}};
 const manager=new SocialAccounts({directory,drivers:{douyin:driver},requestPolicy:null});
 manager.store.transact(s=>{s.accounts.douyin={state:'bound',accountId:'owned-account',generation:3};},{authorize:yes});
 t.after(async()=>{await manager.dispose();fs.rmSync(directory,{recursive:true,force:true});});
 return{manager,events,get readContext(){return readContext;},get cleanupContext(){return cleanupContext;}};
}
test('explicit account read owns and finishes one finite task around both identity checks',async t=>{
 const f=fixture(t);assert.equal((await f.manager.read('douyin',{operation:'profile'},{authorize:yes})).ok,true);
 assert.deepEqual(f.events,['begin','identity','read','identity','finish']);assert.equal(f.manager.snapshot().platforms.find(p=>p.platform==='douyin').cleanupRequired,false);
});
test('read borrowing an already active task never finishes the owner feed',async t=>{
 const f=fixture(t,{created:false});await f.manager.read('douyin',{operation:'profile'},{authorize:yes});assert.deepEqual(f.events,['begin','identity','read','identity']);
});
test('revoked reading still closes only its own held task using a separate cleanup signal',async t=>{
 const controller=new AbortController();let authorized=true;const f=fixture(t,{onRead:()=>{authorized=false;controller.abort();}});
 await assert.rejects(f.manager.read('douyin',{operation:'profile'},{authorize:()=>authorized,signal:controller.signal}),{code:'FORBIDDEN'});
 assert.deepEqual(f.events,['begin','identity','read','finish']);assert.notEqual(f.cleanupContext.signal,f.readContext.signal);
});
test('unknown cleanup retains the platform lease and blocks any replacement task',async t=>{
 const f=fixture(t,{failRead:true,failCleanup:true});await assert.rejects(f.manager.read('douyin',{operation:'profile'},{authorize:yes}),{code:'CLEANUP_UNCONFIRMED'});
 assert.equal(f.manager.snapshot().platforms.find(p=>p.platform==='douyin').cleanupRequired,true);
 await assert.rejects(f.manager.read('douyin',{operation:'profile'},{authorize:yes}),{code:'BUSY'});assert.equal(f.events.filter(x=>x==='begin').length,1);
});
test('paused accounts are rejected before even allocating a read activity',async t=>{
 const f=fixture(t);f.manager.store.transact(s=>{s.accounts.douyin.safetyPause={reason:'risk-control',at:new Date().toISOString()};},{authorize:yes});
 await assert.rejects(f.manager.read('douyin',{operation:'profile'},{authorize:yes}),{code:'RISK_CONTROL'});assert.deepEqual(f.events,[]);
});

test('an account generation change refuses cleanup and retains its job even if the browser process is idle',async t=>{
 let f;f=fixture(t,{onRead:()=>f.manager.store.transact(s=>{s.accounts.douyin.generation++;},{authorize:yes})});
 await assert.rejects(f.manager.read('douyin',{operation:'profile'},{authorize:yes}),{code:'CLEANUP_UNCONFIRMED'});
 assert.equal(f.events.includes('finish'),false);assert.equal(f.manager.snapshot().platforms.find(p=>p.platform==='douyin').cleanupRequired,true);
 await assert.rejects(f.manager.read('douyin',{operation:'profile'},{authorize:yes}),{code:'BUSY'});
});

test('platform risk pause survives a simultaneous unknown read cleanup',async t=>{
 const f=fixture(t,{failRead:'RISK_CONTROL',failCleanup:true});
 await assert.rejects(f.manager.read('douyin',{operation:'profile'},{authorize:yes}),{code:'CLEANUP_UNCONFIRMED'});
 const row=f.manager.snapshot().platforms.find(p=>p.platform==='douyin');assert.equal(row.safetyPause.reason,'risk-control');assert.equal(row.cleanupRequired,true);
});
