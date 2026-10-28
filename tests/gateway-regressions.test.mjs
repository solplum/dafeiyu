import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQGateway } from '../packages/dsh-dafeiyu/src/qq-gateway.js';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';
// Every test starts with denied network; individual cases supply explicit stubs.
globalThis.fetch = async () => { throw new Error('Network disabled in offline regression tests'); };
const make=()=>new QQGateway({ownerQq:'100',ownerOpenId:'owner-openid',appId:'',appSecret:'',onebotHttp:'http://fixture.invalid',onebotWs:'ws://fixture.invalid'});
test('official integration is disabled without explicitly configured credentials',async(t)=> {
 const g=make();let calls=0;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});globalThis.fetch=async()=>{calls++;throw Error('unexpected network')};
 assert.equal(g.appId,'');assert.equal(g.appSecret,'');assert.equal(await g.getOfficialToken(),'');assert.equal(calls,0);
});
test('owner check uses exact trusted channel identity only',()=> {
 const g=make();assert.equal(g.handleOfficialInbound({sender:'attacker',senderName:'sol impostor',scope:'c2c'}).isOwner,false);
 assert.equal(g.isMaster({channel:'onebot',userId:'999',userName:'至死 sol 卓霖',isOwner:true}),false);
 assert.equal(g.isMaster({channel:'onebot',userId:'100'}),true);assert.equal(g.isMaster({channel:'official',userId:'owner-openid'}),true);
});
test('private replies keep original recipient and use HTTP when WS is unavailable',async()=> {
 const g=make();let target;let official=0;g.sendPrivateMsg=async(id)=>{target=id;return {ok:false,error:'offline'}};g.sendOfficialDirectMsg=async()=>{official++;return {ok:true}};
 assert.equal((await g.sendMessage('private:999','private reply')).ok,false);assert.equal(target,'999');assert.equal(official,0);
});
test('official passive reply forwards triggering message ID',async()=> {
 const g=make();let seen;g.sendOfficialDirectMsg=async(...args)=>{seen=args;return {ok:true}};
 await g.sendMessage('official:c2c:peer','reply',{messageId:'trigger-42'});assert.deepEqual(seen,['peer','reply','trigger-42']);
});
test('lost WS acknowledgement does not send non-idempotent action twice',async(t)=> {
 const g=make();g.connected=true;let wsSends=0,httpSends=0,timer;g.wsClient={readyState:1,send:()=>{wsSends++}};
 const originalFetch=globalThis.fetch, originalTimeout=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
 t.after(()=>{globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimeout;globalThis.clearTimeout=originalClear});
 globalThis.fetch=async()=>{httpSends++;return {ok:true,json:async()=>({status:'ok'})}};globalThis.setTimeout=(fn)=>{timer=fn;return {unref(){}}};globalThis.clearTimeout=()=>{};
 const waiting=g.api('send_private_msg',{user_id:100,message:'once'});timer();const result=await waiting;
 assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(wsSends,1);assert.equal(httpSends,0);
});
test('stop cancels outstanding requests without invoking HTTP or reconnect',async()=> {
 const g=make();g.connected=true;g.wsClient={readyState:1,send(){},close(){}};const pending=g.api('send_private_msg',{user_id:100,message:'once'});g.stop();
 assert.equal((await pending).ok,false);assert.equal(g.pendingReqs.size,0);assert.equal(g.connected,false);
});
test('failed history lookup preserves failure',async()=> {
 const g=make();g.api=async()=>({ok:false,error:'offline'});assert.deepEqual(await g.fetchFriendHistory('100'),{ok:false,error:'offline',messages:[]});
});
test('memory bridge defaults to public persona and only reveals archive explicitly',t=> {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-bridge-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'memory'));
 fs.writeFileSync(path.join(dir,'memory/user.md'),'ARCHIVE_PRIVATE');fs.writeFileSync(path.join(dir,'memory/timeline.md'),'TIMELINE_PRIVATE');
 const bridge=new MemoryBridge({projectRoot:dir,ownerQq:'100',ownerOpenId:'owner-openid'});assert.ok(!bridge.buildSystemPrompt().includes('ARCHIVE_PRIVATE'));assert.ok(!bridge.buildSystemPrompt().includes('owner-openid'));assert.ok(bridge.buildSystemPrompt('',{isOwner:true}).includes('ARCHIVE_PRIVATE'));
});

test('gateway rejects HTTP 200 nonprotocol JSON and API retcode failure',async(t)=> {
 const g=make();const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 for(const response of [null,{},[],{status:'ok',retcode:100}]) {
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>response});assert.equal((await g.api('send_private_msg')).ok,false);
 }
 globalThis.fetch=async()=>({ok:true,status:200,json:async()=>{throw Error('invalid json')}});assert.equal((await g.api('send_private_msg')).ok,false);
});

test('OneBot image keeps exact private target and carries bytes without filesystem assumptions',async(t)=> {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-image-regression-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'fixture.png');fs.writeFileSync(file,'fixture image');
 const gateway=make();let sent;
 gateway.api=async(action,params)=>{sent={action,params};return {ok:true}};
 assert.equal((await gateway.sendImage('private:100',file)).ok,true);
 assert.equal(sent.action,'send_private_msg');assert.equal(sent.params.user_id,100);
 assert.equal(sent.params.message[0].type,'image');
 assert.equal(sent.params.message[0].data.file,'base64://'+Buffer.from('fixture image').toString('base64'));
 sent=undefined;
 assert.equal((await gateway.sendImage('official:c2c:owner-openid',file)).ok,false);
 assert.equal(sent,undefined);
});
