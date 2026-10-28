import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanionToolRegistry } from '../packages/dsh-dafeiyu/src/companion-tool-registry.js';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';

globalThis.fetch = async()=>{throw Error('Network disabled in offline registry tests')};
const OWNER={key:'private:100',userId:'100',isGroup:false};
const OFFICIAL={key:'official:c2c:owner-openid',userId:'owner-openid',isGroup:false};
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aGQAAAAASUVORK5CYII=','base64');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-registry-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const make=(options={})=>new CompanionToolRegistry({ownerQq:'100',ownerOpenId:'owner-openid',...options});
const names=(registry,context=OWNER)=>registry.definitions(context).map(x=>x.function.name);

test('exact owner identifier and matching private route are required for definitions and execution',async()=> {
 const registry=make();assert.deepEqual(names(registry),['companion_status']);assert.deepEqual(names(registry,OFFICIAL),['companion_status']);
 for(const context of [{key:'private:999',userId:'999',isOwner:true},{key:'group:1',userId:'100',isOwner:true},{key:'private:999',userId:'100'}, {...OWNER,isGroup:true}, {key:'official:c2c:attacker',userId:'attacker',isOwner:true}]) {
  assert.deepEqual(names(registry,context),[]);await assert.rejects(registry.execute('companion_status',{},context),/绑定主人的原路私聊/);
 }
});

test('status never probes device and phone tools are disabled by default',async()=> {
 let commands=0;const phoneTools={enabled:true,device:'fixture-device',getRuntimeStatus:()=>({configured:true}),getDeviceState:()=>{commands++;throw Error('must not probe')},screenshot:()=>{commands++;throw Error('must not capture')}};
 const registry=make({phoneTools});assert.deepEqual(names(registry),['companion_status']);
 const {output}=await registry.execute('companion_status',{},OWNER);assert.equal(output.phone.enabled,false);assert.equal(output.phone.configured,true);assert.equal(output.phone.probed,false);assert.equal(commands,0);
 await assert.rejects(registry.execute('phone_screenshot',{},OWNER),/未启用/);assert.equal(commands,0);
});

test('phone whitelist and enabled state are checked again at execution time',async()=> {
 let calls=0;const registry=make({phoneEnabled:true,phoneTools:{enabled:true,screenshot:()=>{calls++},key:()=>{calls++},tap:()=>{calls++}}});
 assert.ok(names(registry).includes('phone_screenshot'));assert.ok(!names(registry).includes('phone_tap'));
 await assert.rejects(registry.execute('phone_tap',{x:1,y:2},OWNER),/未启用/);
 registry.phoneEnabled=false;await assert.rejects(registry.execute('phone_screenshot',{},OWNER),/未启用/);assert.equal(calls,0);
});

test('remember_event writes only when enabled and reports actual write failure',async(t)=> {
 const dir=temp(t);fs.mkdirSync(path.join(dir,'memory'));const bridge=new MemoryBridge({projectRoot:dir});
 const registry=make({memoryBridge:bridge});assert.ok(!names(registry).includes('remember_event'));await assert.rejects(registry.execute('remember_event',{summary:'fixture',detail:'fact'},OWNER),/未启用/);
 registry.allowMemoryWrites=true;const result=await registry.execute('remember_event',{summary:'  fixture\n event  ',detail:'actual test fact'},OWNER);
 assert.equal(result.output.saved,true);assert.match(fs.readFileSync(path.join(dir,'memory/timeline.md'),'utf8'),/fixture event.*\n.*actual test fact/);
 registry.memoryBridge={appendTimeline:()=>false};assert.equal((await registry.execute('remember_event',{summary:'fixture',detail:'fact'},OWNER)).output.ok,false);
 await assert.rejects(registry.execute('remember_event',{summary:'a'.repeat(81),detail:'fact'},OWNER),/上限/);
});

test('meme listing is bounded and sending uses exact library selection and current route',async(t)=> {
 const dir=temp(t),filename='fixture-whale.png';fs.writeFileSync(path.join(dir,filename),PNG);
 const rows=[{filename,path:'/ignored/path',isWhaleMeme:true},{filename:'other.png',isWhaleMeme:false}];let sent;
 const registry=make({memeManager:{libDir:dir,listMemes:()=>rows},sendImage:async(...args)=>{sent=args;return {ok:true}}});
 const list=await registry.execute('meme_list',{limit:1},OWNER);assert.equal(list.output.total,2);assert.equal(list.output.truncated,true);assert.deepEqual(list.output.memes,[{filename,title:'',tags:[],description:'',aiDescription:'',descriptionStatus:'missing',isWhaleMeme:true}]);assert.equal('path' in list.output.memes[0],false);
 const result=await registry.execute('meme_send',{filename},OFFICIAL);assert.equal(result.output.sent,true);assert.equal(sent[0],OFFICIAL.key);assert.equal(sent[1],fs.realpathSync(path.join(dir,filename)));assert.equal(sent[2].filename,filename);
 await assert.rejects(registry.execute('meme_send',{filename:'../fixture-whale.png'},OWNER),/精确文件名/);await assert.rejects(registry.execute('meme_send',{filename:'missing.png'},OWNER),/不在本地库/);
});

test('meme_send rejects outside-library symlinks and unconfirmed sends',async(t)=> {
 const dir=temp(t),library=path.join(dir,'library');fs.mkdirSync(library);const outside=path.join(dir,'outside.png');fs.writeFileSync(outside,PNG);fs.symlinkSync(outside,path.join(library,'escape.png'));
 let sends=0;const registry=make({memeManager:{libDir:library,listMemes:()=>[{filename:'escape.png'}]},sendImage:async()=>{sends++;return {ok:true}}});
 await assert.rejects(registry.execute('meme_send',{filename:'escape.png'},OWNER),/不在库内/);assert.equal(sends,0);
 fs.writeFileSync(path.join(library,'inside.png'),PNG);registry.memeManager.listMemes=()=>[{filename:'inside.png'}];registry.sendImage=async()=>({ok:false,uncertain:true,error:'no ACK'});
 const failure=await registry.execute('meme_send',{filename:'inside.png'},OWNER);assert.equal(failure.output.ok,false);assert.equal(failure.output.uncertain,true);
});

test('actual screenshot bytes are included as image data and invalid files fail clearly',async(t)=> {
 const dir=temp(t),file=path.join(dir,'screen.png');fs.writeFileSync(file,PNG);let captures=0;
 const registry=make({phoneEnabled:true,phoneTools:{enabled:true,screenshot:async()=>{captures++;return {path:file}}}});
 const result=await registry.execute('phone_screenshot',{},OWNER);assert.equal(result.output.source,'adb_screencap');assert.equal(result.output.imageAttached,true);assert.equal(result.content[0].image_url.url,'data:image/png;base64,'+PNG.toString('base64'));assert.equal(captures,1);
 fs.writeFileSync(file,'not a screenshot');await assert.rejects(registry.execute('phone_screenshot',{},OWNER),/不是 PNG/);
 fs.truncateSync(file,8*1024*1024+1);await assert.rejects(registry.execute('phone_screenshot',{},OWNER),/大小上限/);
});

test('UI results preserve source and explicitly report truncation within JSON output bound',async()=> {
 const xml='<node text="'.repeat(6000);const registry=make({phoneEnabled:true,phoneTools:{enabled:true,getUiTree:async()=>({ok:true,xml})}});
 const {output}=await registry.execute('phone_get_ui_tree',{},OWNER);assert.equal(output.source,'adb_uiautomator_dump');assert.equal(output.fullLength,xml.length);assert.equal(output.truncated,true);assert.ok(JSON.stringify(output).length<=30000);
});

test('only configured key and bounded listen duration can reach phone executor',async()=> {
 const keys=[];let listens=0;const registry=make({phoneEnabled:true,phoneTools:{enabled:true,key:async(key)=>{keys.push(key);return {ok:true}},listen:async()=>{listens++;return {ok:false,error:'fixture offline'}}}});
 await registry.execute('phone_key',{key:'back'},OWNER);assert.deepEqual(keys,['back']);await assert.rejects(registry.execute('phone_key',{key:'power'},OWNER),/允许值/);
 await assert.rejects(registry.execute('phone_listen',{seconds:4},OWNER),/最大值/);assert.equal(listens,0);const failure=await registry.execute('phone_listen',{seconds:3},OWNER);assert.equal(failure.output.ok,false);assert.equal(failure.output.transcribed,false);
});

test('listen without STT saves actual audio without fabricating heard text',async(t)=> {
 const dir=temp(t),audio=path.join(dir,'fixture.m4a');fs.writeFileSync(audio,Buffer.alloc(128));
 const registry=make({phoneEnabled:true,phoneTools:{enabled:true,listen:async(seconds)=>({ok:true,path:audio,duration:seconds})}});
 const {output}=await registry.execute('phone_listen',{},OWNER);assert.equal(output.audioSaved,true);assert.equal(output.transcribed,false);assert.equal(Object.hasOwn(output,'text'),false);assert.match(output.note,/不知道录音/);
});

test('listen uses actual STT provider text and preserves transcription failure',async(t)=> {
 const dir=temp(t),audio=path.join(dir,'fixture.m4a');fs.writeFileSync(audio,Buffer.alloc(128));let transcribes=0;
 const voiceProcessor={sttProvider:()=>{},transcribeFile:async(file)=>{assert.equal(file,audio);transcribes++;return '真实识别的测试文字'}};
 const registry=make({phoneEnabled:true,phoneTools:{enabled:true,listen:async()=>({ok:true,path:audio,duration:2})},voiceProcessor});
 const success=await registry.execute('phone_listen',{seconds:2},OWNER);assert.equal(success.output.transcribed,true);assert.equal(success.output.text,'真实识别的测试文字');assert.equal(transcribes,1);
 voiceProcessor.transcribeFile=async()=>{throw Error('synthetic STT failure')};const failure=await registry.execute('phone_listen',{seconds:2},OWNER);assert.equal(failure.output.ok,false);assert.equal(failure.output.audioSaved,true);assert.equal(failure.output.transcribed,false);assert.match(failure.output.error,/synthetic STT failure/);
});

test('pre-abort and disposed registry perform no side effects',async()=> {
 let calls=0;const registry=make({phoneEnabled:true,phoneTools:{enabled:true,key:async()=>{calls++;return {ok:true}}}});const controller=new AbortController();controller.abort(Error('disposed session'));
 await assert.rejects(registry.execute('phone_key',{key:'back'},OWNER,{signal:controller.signal}),/disposed session/);assert.equal(calls,0);
 registry.dispose();assert.deepEqual(names(registry),[]);await assert.rejects(registry.execute('phone_key',{key:'back'},OWNER),/绑定主人的原路私聊/);assert.equal(calls,0);
});
