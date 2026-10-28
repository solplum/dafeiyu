import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Waker } from '../packages/companion/src/wake.js';
import { Humanizer } from '../packages/companion/src/humanize.js';
import { Brain } from '../packages/companion/src/brain.js';
import { Role } from '../packages/companion/src/role.js';
import { Memory } from '../packages/companion/src/memory.js';
import { handleTurn } from '../packages/companion/src/index.js';
// Offline fixtures must never fall through to a real model or gateway request.
globalThis.fetch = async () => { throw new Error('Network disabled in offline regression tests'); };
function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-companion-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
test('failed delivery is rejected rather than counted as sent', async()=> {
 for (const enabled of [false,true]) {
  const human=new Humanizer({enabled});
  await assert.rejects(human.say('hello',{send:async()=>({ok:false,error:'rejected'}),sleep:async()=>{}}),/rejected/);
 }
});
test('same conversation receives previous turns and no unrelated private context', async(t)=> {
 const dir=fixture(t), memory=new Memory({dir});
 memory.logTurn({where:'private:100',who:'owner',text:'the code is 1234',reply:'remembered'});
 memory.logTurn({where:'private:999',who:'stranger',text:'stranger secret',reply:'private reply'});
 let request;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 globalThis.fetch=async(_url,opts)=>{request=JSON.parse(opts.body);return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'answer'}}]})}};
 const role={build:(ctx)=>JSON.stringify(ctx)};
 const brain=new Brain({apiKey:'fixture',role,memory,ownerIds:['100']});
 await brain.reply({key:'private:100',userId:'100',text:'what code?',record:false});
 assert.equal(request.messages.length,4);
 assert.equal(request.messages[1].content,'the code is 1234');assert.equal(request.messages[2].content,'remembered');
 assert.ok(!JSON.stringify(request).includes('stranger secret'));
});
test('unified private archive is opt in and excluded in groups', async(t)=> {
 const dir=fixture(t);fs.mkdirSync(path.join(dir,'memory'));fs.writeFileSync(path.join(dir,'memory/user.md'),'PRIVATE_ARCHIVE_TOKEN');
 const cardPath=path.join(dir,'role.md');fs.writeFileSync(cardPath,'short public persona');
 const role=new Role({cardPath,projectRoot:dir});
 assert.ok(!role.build().includes('PRIVATE_ARCHIVE_TOKEN'));assert.ok(role.build({includePrivateMemory:true}).includes('PRIVATE_ARCHIVE_TOKEN'));
 let ctx;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 globalThis.fetch=async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'answer'}}]})});
 const memory=new Memory({dir:path.join(dir,'data')});
 const brain=new Brain({apiKey:'fixture',ownerIds:['100'],memory,role:{build:(input)=>{ctx=input;return ''}}});
 await brain.reply({key:'group:9',userId:'100',isOwner:true,text:'hello',record:false});assert.equal(ctx.includePrivateMemory,false);
});
test('corrupt memory is surfaced and cannot be overwritten by remember', (t)=> {
 const dir=fixture(t), memory=new Memory({dir});const file=path.join(dir,'people.json');fs.writeFileSync(file,'{broken');
 assert.throws(()=>memory.remember('100',{fact:'new fact'}),/记忆|JSON|Unexpected|property/i);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
test('dry run and failed send do not write replies into memory', async()=> {
 const calls=[];const deps={bot:{send:async()=>({ok:false,error:'offline'}),setTyping:async()=>{}},brain:{reply:async(input)=>{calls.push(input.record);return {text:'hello'}},recordReply:()=>calls.push('record')},human:new Humanizer({enabled:false}),memory:{touch:()=>calls.push('touch')},waker:new Waker()};
 const items=[{key:'private:100',userId:'100',name:'owner',text:'hi'}];
 await handleTurn(deps,items,{dryRun:true,ownerIds:['100']});assert.deepEqual(calls,[false]);
 await assert.rejects(handleTurn(deps,items,{dryRun:false,ownerIds:['100']}),/offline/);assert.deepEqual(calls,[false,false]);
});

test('native WebSocket event listeners receive messages and close never reconnects',async()=> {
 const { OneBot }=await import('../packages/companion/src/transport-onebot.js');
 class NativeSocket { constructor(){this.listeners={};NativeSocket.instance=this;}addEventListener(type,fn){this.listeners[type]=fn}close(){this.listeners.close?.()}emit(type,value){this.listeners[type]?.(value)} }
 let received;const bot=new OneBot({wsUrl:'ws://fixture',httpUrl:'http://fixture',WebSocketImpl:NativeSocket,onMessage:(msg)=>{received=msg}});
 const socket=NativeSocket.instance;socket.emit('open');socket.emit('message',{data:JSON.stringify({post_type:'message',message_type:'private',self_id:200,user_id:100,message:[{type:'text',data:{text:'hello'}}]})});
 await Promise.resolve();assert.equal(received.text,'hello');assert.equal(bot.connected,true);bot.close();assert.equal(bot.connected,false);assert.equal(bot.reconnectTimer,null);
});

test('native WebSocket authentication requirement is explicit',async()=> {
 const { OneBot }=await import('../packages/companion/src/transport-onebot.js');
 class NativeSocket { addEventListener(){} }
 const bot=new OneBot({wsUrl:'ws://fixture',accessToken:'fixture-token',WebSocketImpl:NativeSocket});
 assert.match(bot.lastError,/ws/);assert.equal(bot.ws,null);bot.close();
});

test('OneBot rejects HTTP 200 invalid protocol and nonzero retcode',async(t)=> {
 const { OneBot }=await import('../packages/companion/src/transport-onebot.js');
 class NativeSocket {addEventListener(){}close(){}}
 const bot=new OneBot({wsUrl:'ws://fixture',httpUrl:'http://fixture',WebSocketImpl:NativeSocket});t.after(()=>bot.close());
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 for (const payload of ['not JSON','{}','null',JSON.stringify({retcode:100,status:'ok'})]) {
  globalThis.fetch=async()=>({ok:true,text:async()=>payload});assert.equal((await bot.send('private:100','hello')).ok,false);
 }
 globalThis.fetch=async()=>({ok:true,text:async()=>JSON.stringify({status:'ok',retcode:0,data:{message_id:1}})});assert.equal((await bot.send('private:100','hello')).ok,true);
});

test('group batching isolates speakers while preserving conversation target',()=> {
 const waker=new Waker();
 waker.batch({key:'group:9',userId:'100',text:'owner words'},{key:'group:9:user:100'});
 waker.batch({key:'group:9',userId:'999',text:'visitor words'},{key:'group:9:user:999'});
 const owner=waker.flush('group:9:user:100'), visitor=waker.flush('group:9:user:999');
 assert.equal(owner.length,1);assert.equal(owner[0].userId,'100');assert.equal(owner[0].key,'group:9');assert.equal(visitor[0].userId,'999');
});

test('six-message batch is ready for immediate delivery and retains every message',()=> {
 const waker=new Waker();let result;for(let i=0;i<6;i++) result=waker.batch({key:'private:100',text:String(i)});
 assert.equal(result.ready,true);assert.deepEqual(result.batch.map(x=>x.text),['0','1','2','3','4','5']);assert.equal(waker.flush('private:100').length,0);
});
