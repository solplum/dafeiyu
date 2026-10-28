import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../packages/companion/src/brain.js';
import { runToolLoop, validateToolArguments } from '../packages/companion/src/tool-loop.js';

globalThis.fetch = async () => { throw new Error('Network disabled in offline tool-loop tests'); };
const tool = {type:'function',function:{name:'phone_tap',description:'fixture tap',parameters:{type:'object',properties:{x:{type:'integer',minimum:0},y:{type:'integer',minimum:0}},required:['x','y'],additionalProperties:false}}};
const call = (id='call-1',name='phone_tap',args='{"x":1,"y":2}') => ({id,type:'function',function:{name,arguments:args}});
const completion = (message) => ({choices:[{message}]});
const fixture = (registry, options={}) => {
 const writes=[];
 const memory={renderPerson:()=>'',renderRecent:()=>'',recentTurns:()=>[],remember:(...args)=>writes.push(['person',...args]),logTurn:(...args)=>writes.push(['turn',...args])};
 const brain=new Brain({apiKey:'synthetic-key',baseUrl:'https://model.fixture.invalid/v1',model:'fixture-model',ownerIds:['100'],role:{build:()=> 'fixture persona'},memory,toolRegistry:registry,...options});
 return {brain,writes};
};
const input=(extra={})=>({key:'private:100',userId:'100',text:'tap then read screen',record:false,...extra});
function modelStub(t,respond) {
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 const requests=[];
 globalThis.fetch=async(url,options)=> {
  assert.equal(url,'https://model.fixture.invalid/v1/chat/completions');
  const body=JSON.parse(options.body);requests.push(body);
  return {ok:true,text:async()=>JSON.stringify(await respond(body,requests.length,options.signal))};
 };
 return requests;
}

test('message reaches model tools, executor, tool result and final reply',async(t)=> {
 const executions=[];const image='data:image/png;base64,aA==';
 const registry={definitions:(context)=>{assert.equal(context.key,'private:100');return [tool]},execute:async(name,args,context,{signal})=>{
  executions.push({name,args,context,signal});return {output:{ok:true,x:args.x,y:args.y},content:[{type:'text',text:'actual screenshot fixture'},{type:'image_url',image_url:{url:image}}]};
 }};
 const requests=modelStub(t,(_body,n)=>n===1?completion({content:'intermediate is not final',tool_calls:[call()]}):completion({content:'tapped and checked'}));
 const {brain,writes}=fixture(registry);const result=await brain.reply(input());
 assert.equal(result.text,'tapped and checked');assert.equal(result.toolFailed,false);assert.deepEqual(result.toolResults,[{id:'call-1',name:'phone_tap',ok:true}]);
 assert.equal(executions.length,1);assert.deepEqual(executions[0].args,{x:1,y:2});assert.equal(executions[0].context.isOwner,true);assert.equal(Object.isFrozen(executions[0].context),true);assert.ok(executions[0].signal instanceof AbortSignal);
 assert.equal(requests[0].tools[0].function.name,'phone_tap');assert.equal(requests[0].tool_choice,'auto');
 const second=requests[1].messages;const toolResponse=second.find(x=>x.role==='tool');assert.equal(toolResponse.tool_call_id,'call-1');assert.deepEqual(JSON.parse(toolResponse.content),{ok:true,x:1,y:2});
 const attachment=second.find(x=>Array.isArray(x.content));assert.match(attachment.content[0].text,/phone_tap.*call-1/);assert.equal(attachment.content[2].image_url.url,image);
 assert.equal(writes.length,0);
});

test('unknown tool and malformed JSON/schema args never reach executor',async(t)=> {
 const invalid=[call('a','unknown_tool'),call('b','phone_tap','{broken'),call('c','phone_tap','[]'),call('d','phone_tap','{"x":1}'),call('e','phone_tap','{"x":1,"y":2,"command":"shell"}'),call('f','phone_tap','{"x":-1,"y":2}')];
 let executed=0;const registry={definitions:()=>[tool],execute:async()=>{executed++;return {ok:true}}};
 const requests=modelStub(t,(_body,n)=>n===1?completion({content:null,tool_calls:invalid}):completion({content:'工具参数错误 操作未完成'}));
 const {brain}=fixture(registry);const result=await brain.reply(input());assert.equal(executed,0);assert.equal(result.toolFailed,true);assert.equal(result.toolResults.length,6);
 const responses=requests[1].messages.filter(x=>x.role==='tool');assert.equal(responses.length,6);assert.ok(responses.every(x=>JSON.parse(x.content).ok===false));
});

test('execution errors and explicit unsuccessful results remain model-visible failures',async(t)=> {
 let executed=0;const registry={definitions:()=>[tool],execute:async()=>{executed++;if(executed===1)throw Error('permission denied');return {output:{ok:false,error:'device offline'}}}};
 const requests=modelStub(t,(_body,n)=>n===1?completion({content:null,tool_calls:[call('a'),call('b','phone_tap','{"x":1,"y":3}')]}):completion({content:'手机未连接 操作失败'}));
 const result=await fixture(registry).brain.reply(input());assert.equal(result.toolFailed,true);assert.equal(result.toolResults[0].error,'permission denied');assert.equal(result.toolResults[1].error,'device offline');
 assert.match(requests[1].messages.filter(x=>x.role==='tool').map(x=>x.content).join(' '),/permission denied.*device offline/);
});

test('round limit does not return intermediate success or record an unfinished reply',async(t)=> {
 let executes=0;modelStub(t,(_body,n)=>completion({content:'claimed success during tools',tool_calls:[call('round-'+n)]}));
 const {brain,writes}=fixture({definitions:()=>[tool],execute:async()=>{executes++;return {ok:true}}},{maxToolRounds:1});
 await assert.rejects(brain.reply(input({record:true})),/上限/);assert.equal(executes,1);assert.equal(writes.length,0);
});

test('call budget is checked before executing a multi-call batch',async(t)=> {
 let executes=0;modelStub(t,()=>completion({content:null,tool_calls:[call('a'),call('b')]}));
 const {brain}=fixture({definitions:()=>[tool],execute:async()=>{executes++;return {ok:true}}},{maxToolCalls:1});
 await assert.rejects(brain.reply(input()),/上限/);assert.equal(executes,0);
});

test('duplicate call IDs are rejected before any executor effect',async(t)=> {
 let executes=0;modelStub(t,()=>completion({content:null,tool_calls:[call('same'),call('same')]}));
 const {brain}=fixture({definitions:()=>[tool],execute:async()=>{executes++;return {ok:true}}});
 await assert.rejects(brain.reply(input()),/ID.*重复/);assert.equal(executes,0);
});

test('abort during a tool stops the loop even if executor ignores cancellation',async(t)=> {
 const controller=new AbortController();let executes=0;const requests=modelStub(t,()=>completion({content:null,tool_calls:[call('a'),call('b')]}));
 const registry={definitions:()=>[tool],execute:async()=>{executes++;queueMicrotask(()=>controller.abort(new Error('session disposed')));return new Promise(()=>{})}};
 const {brain,writes}=fixture(registry);await assert.rejects(brain.reply(input({signal:controller.signal,record:true})),/session disposed/);
 assert.equal(requests.length,1);assert.equal(executes,1);assert.equal(writes.length,0);
});

test('pre-aborted session cannot inspect tools or request a model',async()=> {
 const controller=new AbortController();controller.abort(new Error('already disposed'));let definitions=0;
 const {brain}=fixture({definitions:()=>{definitions++;return [tool]},execute:async()=>({ok:true})});
 await assert.rejects(brain.reply(input({signal:controller.signal})),/already disposed/);assert.equal(definitions,0);
});

test('shared Brain retains trusted owner/session isolation for concurrent replies',async(t)=> {
 const executions=[];
 const registry={definitions:(context)=>context.isOwner&&!context.isGroup?[tool]:[],execute:async(name,args,context)=>{
  if(!context.isOwner||context.isGroup)throw Error('unauthorized');executions.push(context);return {ok:true};
 }};
 modelStub(t,(body)=> {
  const original=body.messages.find(m=>m.role==='user'&&typeof m.content==='string')?.content;
  const hasResult=body.messages.some(m=>m.role==='tool');
  return hasResult?completion({content:'owner operation complete'}):completion({content:null,tool_calls:[call(original==='owner'?'owner-call':'visitor-call')]});
 });
 const {brain}=fixture(registry);
 const [owner,visitor]=await Promise.allSettled([brain.reply(input({text:'owner'})),brain.reply(input({key:'group:9',userId:'999',text:'visitor',isOwner:false,isGroup:true}))]);
 assert.equal(owner.status,'fulfilled');assert.equal(visitor.status,'rejected');assert.match(visitor.reason.message,/未启用/);assert.equal(executions.length,1);assert.equal(executions[0].key,'private:100');
});

test('no registry means no advertised tools and unexpected tool calls fail',async(t)=> {
 const requests=modelStub(t,()=>completion({content:null,tool_calls:[call()]}));const {brain}=fixture(null);
 await assert.rejects(brain.reply(input()),/未启用/);assert.equal(Object.hasOwn(requests[0],'tools'),false);
});

test('empty final model output is a failure and never recorded',async(t)=> {
 modelStub(t,()=>completion({content:''}));const {brain,writes}=fixture(null);
 await assert.rejects(brain.reply(input({record:true})),/最终回复/);assert.equal(writes.length,0);
});

test('remote attachment URLs are rejected rather than presented as observed screenshots',async(t)=> {
 const requests=modelStub(t,(_body,n)=>n===1?completion({content:null,tool_calls:[call()]}):completion({content:'图片格式错误 操作结果未确认'}));
 const {brain}=fixture({definitions:()=>[tool],execute:async()=>({output:{ok:true},content:[{type:'image_url',image_url:{url:'https://untrusted.fixture.invalid/image.png'}}]})});
 const result=await brain.reply(input());assert.equal(result.toolFailed,true);assert.match(result.toolResults[0].error,/data URL/);assert.equal(requests[1].messages.some(x=>Array.isArray(x.content)),false);
});

test('argument schema validates nested types, arrays, enum and unsafe properties',()=> {
 const schema={type:'object',properties:{actions:{type:'array',minItems:1,maxItems:2,items:{type:'object',properties:{kind:{enum:['tap']},x:{type:'integer'}},required:['kind','x'],additionalProperties:false}}},required:['actions'],additionalProperties:false};
 assert.deepEqual(validateToolArguments({actions:[{kind:'tap',x:1}]},schema),{actions:[{kind:'tap',x:1}]});
 for(const value of [{actions:[]},{actions:[{kind:'shell',x:1}]},{actions:[{kind:'tap',x:'1'}]},JSON.parse('{"__proto__":{}}')]) assert.throws(()=>validateToolArguments(value,schema));
});

test('all tool responses precede attached images for provider compatibility',async()=> {
 let n=0;const requests=[];
 const result=await runToolLoop({messages:[{role:'user',content:'fixture'}],context:{key:'private:100'},registry:{definitions:()=>[tool],execute:async()=>({output:{ok:true},content:[{type:'image_url',image_url:{url:'data:image/png;base64,aA=='}}]})},request:async(messages)=>{
  requests.push(structuredClone(messages));return ++n===1?completion({tool_calls:[call('a'),call('b')]}):completion({content:'observed both'});
 }});
 assert.equal(result.toolResults.length,2);const roles=requests[1].map(x=>x.role);const firstTool=roles.indexOf('tool');assert.deepEqual(roles.slice(firstTool,firstTool+4),['tool','tool','user','user']);
});

test('uncertain operation is not executed again when model repeats reordered same arguments',async(t)=> {
 let executions=0;const requests=modelStub(t,(_body,n)=> n===1?completion({tool_calls:[call('a')]}):n===2?completion({tool_calls:[call('b','phone_tap','{"y":2,"x":1}')]}):completion({content:'操作结果未确认 没有自动重复'}));
 const {brain}=fixture({definitions:()=>[tool],execute:async()=>{executions++;return {output:{ok:false,uncertain:true,error:'ack lost'}}}});
 const result=await brain.reply(input());assert.equal(executions,1);assert.equal(result.toolResults[0].uncertain,true);assert.equal(result.toolResults[1].uncertain,true);assert.match(result.toolResults[1].error,/阻止自动重复/);assert.equal(requests.length,3);
});

test('uncertain executor result cannot be exposed as confirmed success',async(t)=> {
 const requests=modelStub(t,(_body,n)=>n===1?completion({tool_calls:[call()]}):completion({content:'结果未确认'}));
 const {brain}=fixture({definitions:()=>[tool],execute:async()=>({output:{ok:true,uncertain:true}})});
 const result=await brain.reply(input());assert.equal(result.toolFailed,true);assert.equal(result.toolResults[0].ok,false);assert.equal(result.toolResults[0].uncertain,true);
 const response=JSON.parse(requests[1].messages.find(x=>x.role==='tool').content);assert.equal(response.ok,false);assert.equal(response.uncertain,true);
});
