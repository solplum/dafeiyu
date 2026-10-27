import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SocialAccounts } from '../packages/dsh-dafeiyu/src/social/accounts.mjs';
import { digest } from '../packages/dsh-dafeiyu/src/social/account-store.mjs';
import { consumeRequest } from '../packages/dsh-dafeiyu/src/social/request-policy.mjs';
const context = { authorize: () => true };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-social-policy-')); let now=1700000000000, reads=0, writes=0, logins=0, risk=false;
  const drivers=Object.fromEntries(['bilibili','douyin','x'].map(key=>[key,{
    capabilities:()=>({profile:'implemented-not-verified',comment:'implemented-not-verified'}),
    async startLogin(){logins++;return{state:'login-pending'};},
    async checkLogin(){return{loggedIn:true,accountId:key+'-own',name:'fixture'};},
    async account(){return{loggedIn:true,accountId:key+'-own',name:'fixture'};},
    async read(){reads++;if(risk)throw Object.assign(Error('fixed'),{code:'RISK_CONTROL'});return{ok:true,accountId:key+'-own',items:[]};},
    async preflight(){},async closeLogin(){},
    async execute(request,execution){writes++;if(risk)throw Object.assign(Error('fixed'),{code:'RISK_CONTROL'});return{ok:true,id:'receipt-'+writes,accountId:key+'-own',operation:request.operation,operationId:execution.operationId,target:request.target||'',parentId:request.parentId||'',contentDigest:digest(request)};}
  }]));
  const manager=new SocialAccounts({directory,drivers,now:()=>now});
  t.after(async()=>{await manager.dispose();fs.rmSync(directory,{recursive:true,force:true});});
  const login=async(key='douyin')=>{const requestId=randomUUID();await manager.startLogin({platform:key,requestId,revision:manager.snapshot().revision},context);await manager.checkLogin({platform:key,sessionId:requestId},context);await manager.confirmAccount({platform:key,accountId:key+'-own',revision:manager.snapshot().revision},context);};
  const prepare=async()=>{const row=await manager.prepare('douyin',{operation:'comment',target:'work',text:'fixture'},{...context,requestId:randomUUID()});manager.approve({operationId:row.operation.id,approvalDigest:row.operation.approvalDigest,revision:manager.snapshot().revision},context);return row;};
  return{manager,drivers,directory,login,prepare,advance(ms){now+=ms;},setRisk(value){risk=value;},get reads(){return reads;},get writes(){return writes;},get logins(){return logins;},get now(){return now;}};
}

test('local read/write/login ceilings count accepted attempts and never enqueue a retry',()=>{
  const row={};let now=1700000000000;consumeRequest(row,'read',now);
  assert.throws(()=>consumeRequest(row,'read',now+1),{code:'COOLDOWN'});assert.equal(row.requestHistory.length,1);
  now+=15000;consumeRequest(row,'read',now);consumeRequest(row,'write',now);
  assert.throws(()=>consumeRequest(row,'write',now+1000),{code:'COOLDOWN'});
  for(let i=1;i<6;i++)consumeRequest(row,'write',now+i*60000);
  assert.throws(()=>consumeRequest(row,'write',now+6*60000),{code:'COOLDOWN'});
  now+=6*60000;consumeRequest(row,'login',now);assert.throws(()=>consumeRequest(row,'login',now+180000),{code:'COOLDOWN'});
  assert.equal(row.requestHistory.filter(e=>e.kind==='write').length,6);
});

test('risk on a read persists across reload, blocks new requests and requires explicit owner verification',async t=>{
  const f=fixture(t);await f.login();f.setRisk(true);
  await assert.rejects(f.manager.read('douyin',{operation:'profile'},context),{code:'RISK_CONTROL'});assert.equal(f.reads,1);
  const next=new SocialAccounts({directory:f.directory,drivers:f.drivers,now:()=>f.now});
  assert.equal(next.snapshot().platforms.find(p=>p.platform==='douyin').safetyPause.reason,'risk-control');
  const revision=next.snapshot().revision;await assert.rejects(next.read('douyin',{operation:'profile'},context),{code:'RISK_CONTROL'});
  assert.equal(next.snapshot().revision,revision);assert.equal(f.reads,1);
  assert.throws(()=>next.resumePlatform({platform:'douyin',revision,verificationCompleted:false},context),{code:'ACK_REQUIRED'});
  assert.throws(()=>next.resumePlatform({platform:'douyin',revision,verificationCompleted:true},{authorize:()=>false}),{code:'FORBIDDEN'});
  f.setRisk(false);next.resumePlatform({platform:'douyin',revision,verificationCompleted:true},context);
  await assert.rejects(next.read('douyin',{operation:'profile'},context),{code:'COOLDOWN'});f.advance(15000);
  await next.read('douyin',{operation:'profile'},context);assert.equal(f.reads,2);
});

test('risk during a write keeps unknown once-only proof; clearing risk never replays or clears unknown automatically',async t=>{
  const f=fixture(t);await f.login();const row=await f.prepare();f.setRisk(true);
  const input={operationId:row.operation.id,approvalDigest:row.operation.approvalDigest};
  assert.equal((await f.manager.execute(input,context)).operation.state,'unknown');assert.equal(f.writes,1);
  assert.throws(()=>f.manager.resumePlatform({platform:'douyin',revision:f.manager.snapshot().revision,verificationCompleted:true},context),{code:'RESULT_UNKNOWN'});
  f.manager.acknowledgeUnknown({operationId:row.operation.id,revision:f.manager.snapshot().revision,executionStopped:true,resultReviewed:true},context);
  assert(f.manager.snapshot().platforms.find(p=>p.platform==='douyin').safetyPause);
  f.manager.resumePlatform({platform:'douyin',revision:f.manager.snapshot().revision,verificationCompleted:true},context);
  await f.manager.execute(input,context);assert.equal(f.writes,1);assert.equal(f.manager.snapshot().operations[0].state,'unknown');
});

test('owner pause blocks login without a driver, remains after reload and does not stop another platform',async t=>{
  const f=fixture(t);f.manager.holdPlatform({platform:'bilibili',revision:f.manager.snapshot().revision,reason:'account-verification-required'},context);
  const next=new SocialAccounts({directory:f.directory,drivers:f.drivers});
  await assert.rejects(next.startLogin({platform:'bilibili',requestId:randomUUID(),revision:next.snapshot().revision},context),{code:'RISK_CONTROL'});assert.equal(f.logins,0);
  await f.login('douyin');assert.equal(f.logins,1);assert.equal(f.manager.snapshot().platforms.find(p=>p.platform==='bilibili').state,'disconnected');
});

test('read cooldown survives reload; a failed request cannot be repeated to bypass the interval',async t=>{
  const f=fixture(t);await f.login();f.drivers.douyin.read=async()=>{throw Error('network unavailable');};
  await assert.rejects(f.manager.read('douyin',{operation:'profile'},context));
  const next=new SocialAccounts({directory:f.directory,drivers:f.drivers,now:()=>f.now});
  await assert.rejects(next.read('douyin',{operation:'profile'},context),{code:'COOLDOWN'});
});
