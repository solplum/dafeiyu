import test from 'node:test';
import assert from 'node:assert/strict';
import { computerProbe, desktopProbe, browserScript, browserProbe, extractProof, findFixtureIndex, PROOF_PREFIX } from '../packages/dsh-dafeiyu/src/capability-probe-runner.mjs';
import { createCapabilityProbes } from '../packages/dsh-dafeiyu/src/capability-probes.js';

const nonce = 'DFY-CAP-' + 'a'.repeat(24);
const fixtureTitle = '本机桌面能力安全测试';
const withFixture = async callback => callback({pid:930,signal:new AbortController().signal,isAlive:()=>true});
test('computer probe creates, reads and cleans its own disposable file, rejecting caller paths', async () => {
  assert.deepEqual(await computerProbe(nonce), { kind:'computer',nonce,matched:true });
  for (const value of ['/private/data', nonce+'\n', null]) await assert.rejects(computerProbe(value));
});
test('desktop control uses unique fixture fields and fresh button indexes, then requires actual changed state', async () => {
  const calls=[]; let observations=0;
  const run=async (_binary,args)=>{
    calls.push(args);
    let result=args[1]==='list-windows'?{app:{pid:930},windows:[{id:91,index:0,title:fixtureTitle,isMinimized:false,isOffscreen:false}]}:{};
    if(args[1]==='get-app-state') {
      const trees=['42 text field 本机能力验证输入\n43 button 确认本机能力测试',
        '9 text field 本机能力验证输入 '+nonce+'\n77 button 确认本机能力测试\n78 text 确认本机能力测试',
        '9 text field 本机能力验证输入 '+nonce+'\n80 text 本机界面验证已收到 '+nonce];
      result={snapshot:{treeText:trees[observations++]}};
    }
    return {stdout:JSON.stringify({ok:true,result})};
  };
  assert.deepEqual(await desktopProbe(nonce,{withFixture,run,resolveExecutable:async()=>'/controlled/orca'}),{kind:'desktop',nonce,matched:true});
  const click=calls.find(args=>args[1]==='click'); assert.equal(click[click.indexOf('--element-index')+1],'77');
  assert.ok(calls.filter(args=>args[1]!=='list-windows').every(args=>args.includes('--no-screenshot')&&args.includes('--window-id')&&args[args.indexOf('--window-id')+1]==='91'));
  let attempts=0;
  await assert.rejects(desktopProbe(nonce,{withFixture,resolveExecutable:async()=>'/controlled/orca',run:async()=>{
    attempts++;return {stdout:JSON.stringify({ok:true,result:{snapshot:{treeText:'42 text field other application field'}}})};
  }}));assert.equal(attempts,1);
});
test('ambiguous fixture targets and unconfirmed values never lead to clicks', async () => {
  assert.throws(()=>findFixtureIndex('1 text field 本机能力验证输入\n2 text field 本机能力验证输入','本机能力验证输入',{input:true}));
  let reads=0,clicks=0;
  await assert.rejects(desktopProbe(nonce,{withFixture,resolveExecutable:async()=>'/controlled/orca',run:async(_bin,args)=>{
    if(args[1]==='click')clicks++;
    if(args[1]==='list-windows')return {stdout:JSON.stringify({ok:true,result:{app:{pid:930},windows:[{id:91,title:fixtureTitle}]}})};
    const tree=reads++===0?'1 text field 本机能力验证输入':'1 text field 本机能力验证输入 unchanged\n2 button 确认本机能力测试';
    return {stdout:JSON.stringify({ok:true,result:args[1]==='list-windows'?{windows:[{id:91,title:fixtureTitle}]}:{snapshot:{treeText:tree}}})};
  }}));assert.equal(clicks,0);
});
test('browser fixture script stays on localhost, uses fill/click and readback, and closes its own space', () => {
  const source=browserScript('http://127.0.0.1:32100/owned-fixture',nonce);
  assert.match(source,/page\.fill/);assert.match(source,/page\.click/);assert.match(source,/textContent === expected/);
  assert.match(source,/task\.finish\(\{keep:\[\]\}\)/);
  for(const url of ['https://example.com','http://localhost:32100/test','file:///private/test'])assert.throws(()=>browserScript(url,nonce));
});
test('only one exact structured nonce proof can certify a test', () => {
  const line=PROOF_PREFIX+JSON.stringify({kind:'browser',nonce,matched:true});
  assert.equal(extractProof('ordinary log\n'+line,'browser',nonce).matched,true);
  for(const stdout of [line+'\n'+line,PROOF_PREFIX+'{}',line.replace('true','false'),line.replace('browser','desktop'),'claimed success'])
    assert.throws(()=>extractProof(stdout,'browser',nonce));
});
test('registry probe adapter always executes a fixed script through the host and refuses revoked or unconfirmed receipts', async () => {
  const commands=[];let allowed=true;
  const host={async executeCommand(command,options){
    commands.push(command);assert.equal(options.timeoutMs,60000);
    const actual=command.match(/DFY-CAP-[a-f0-9]{24}/)[0];
    return {ok:true,exitCode:0,stdout:PROOF_PREFIX+JSON.stringify({kind:'computer',nonce:actual,matched:true})};
  }};
  const probes=createCapabilityProbes({host});
  assert.deepEqual(await probes.computer({authorize:()=>allowed}),{ok:true,evidence:{kind:'readback',matched:true}});
  allowed=false;assert.equal((await probes.computer({authorize:()=>allowed})).ok,false);assert.equal(commands.length,1);
  const revoked=createCapabilityProbes({host:{async executeCommand(){allowed=false;return {ok:true,exitCode:0,stdout:'PRIVATE_RAW'};}}});
  allowed=true;assert.equal((await revoked.computer({authorize:()=>allowed})).code,'CANCELLED');
  const bad=createCapabilityProbes({host:{async executeCommand(){return {ok:true,exitCode:0,stdout:'PRIVATE_RAW'};}}});
  assert.equal((await bad.computer({authorize:()=>true})).code,'UNCONFIRMED');
});


test('desktop probe refuses ambiguous or missing windows before reading or changing another window',async()=>{
  for(const windows of [[],[{id:1},{id:2}],[{id:null}]]){
    const calls=[];await assert.rejects(desktopProbe(nonce,{withFixture,resolveExecutable:async()=>'/controlled/orca',run:async(_bin,args)=>{
      calls.push(args[1]);return {stdout:JSON.stringify({ok:true,result:{windows}})};
    }}));assert.deepEqual(calls,['list-windows']);
  }
});
test('browser failure preserves the same test space for recovery and only finishes after verified readback',async()=>{
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const names=[],receipts=[];let fail=true,finished=0;
  const page={goto:async()=>{},snapshot:async()=>({title:'大肥鱼本地能力测试'}),fill:async()=>{},
    click:async()=>{if(fail)throw Error('FIXTURE_FAILURE');},waitForFunction:async()=>{},evaluate:async()=>true};
  const task={page:()=>page,finish:async()=>{finished++;}};
  const taskSpace=async name=>{names.push(name);return task;};
  const run=new AsyncFunction('taskSpace','console',browserScript('http://127.0.0.1:32100/fixture',nonce));
  await assert.rejects(run(taskSpace,{log:value=>receipts.push(value)}),/FIXTURE_FAILURE/);
  assert.equal(finished,0);assert.equal(receipts.length,0);
  fail=false;await run(taskSpace,{log:value=>receipts.push(value)});
  assert.deepEqual(names,['大肥鱼能力安全验证','大肥鱼能力安全验证']);assert.equal(finished,1);
  assert.equal(extractProof(receipts[0],'browser',nonce).matched,true);
});

test('desktop sharing-overlay fallback binds the same listed window by index before any input',async()=>{
  const calls=[];let reads=0;
  const run=async(_bin,args)=>{
    calls.push(args);let result={};
    if(args[1]==='list-windows')result={app:{pid:930},windows:[{id:91,index:0,title:fixtureTitle}]};
    if(args[1]==='get-app-state'){
      const tree=reads++===0?'0 dialog Window\n1 button WindowSharingSessionButton':reads===2?'42 text field 本机能力验证输入\n43 button 确认本机能力测试':reads===3?'8 text field 本机能力验证输入 '+nonce+'\n9 button 确认本机能力测试':'10 text 本机界面验证已收到 '+nonce;
      result={snapshot:{treeText:tree}};
    }
    return {stdout:JSON.stringify({ok:true,result})};
  };
  assert.equal((await desktopProbe(nonce,{withFixture,run,resolveExecutable:async()=>'/controlled/orca'})).matched,true);
  const actions=calls.filter(args=>['set-value','click'].includes(args[1]));assert.equal(actions.length,2);
  for(const args of actions){assert.ok(args.includes('--window-index'));assert.ok(!args.includes('--window-id'));assert.equal(args[args.indexOf('--app')+1],'pid:930');}
  assert.deepEqual(calls.slice(0,3).map(args=>args[1]),['list-windows','get-app-state','get-app-state']);
});

test('fixture startup refusal never invokes Orca or targets another application',async()=>{
  for (const code of ['UNAVAILABLE','UNCONFIRMED','CANCELLED']) {
    let touched=false;
    await assert.rejects(desktopProbe(nonce,{withFixture:async()=>{throw Object.assign(Error(code),{code});},
      resolveExecutable:async()=>{touched=true;},run:async()=>{touched=true;}}),{code});
    assert.equal(touched,false);
  }
});

test('browser bootstrap distinguishes missing automation service before creating a page',async()=>{
  let calls=0;
  for(const output of [null,'unexpected']){
    await assert.rejects(browserProbe(nonce,{resolveExecutable:async()=>'/controlled/ego-browser',run:async(_bin,args,options)=>{
      calls++;assert.equal(options.timeout,10000);assert.equal(args[2],'console.log("DFY_EGO_BOOTSTRAP_READY")');
      if(output===null)throw Error('CLI_TIMEOUT');return {stdout:output};
    }}),{code:'UNAVAILABLE'});
  }
  assert.equal(calls,2);
});
test('fixed nonzero host failure codes remain safe actionable results instead of being recast as success',async()=>{
  for(const code of ['UNAVAILABLE','UNCONFIRMED','FAILED','ACCESSIBILITY_REQUIRED','DESKTOP_INIT_UNCONFIRMED','DESKTOP_TARGET_UNCONFIRMED']){
    const probes=createCapabilityProbes({host:{executeCommand:async()=>({ok:false,exitCode:1,stdout:'',code})}});
    assert.deepEqual(await probes.browser({authorize:()=>true}),{ok:false,code});
  }
});

test('desktop missing or ambiguous fixture targets retain the target diagnostic without input or clicks',async()=>{
  for(const tree of ['0 dialog Window\n1 button WindowSharingSessionButton','1 text field 本机能力验证输入\n2 text field 本机能力验证输入']){
    const calls=[];
    await assert.rejects(desktopProbe(nonce,{withFixture,
      resolveExecutable:async()=>'/controlled/orca',run:async(_bin,args)=>{
        calls.push(args[1]);
        return {stdout:JSON.stringify({ok:true,result:args[1]==='list-windows'
          ?{app:{pid:930},windows:[{id:91,index:0,title:fixtureTitle}]}:{snapshot:{treeText:tree}}})};
      }}),{code:'DESKTOP_TARGET_UNCONFIRMED'});
    assert.equal(calls.includes('set-value'),false);assert.equal(calls.includes('click'),false);
    assert.ok(calls.filter((name)=>name==='get-app-state').length<=3);
  }
});

test('Ego stderr-only console receipts pass while duplicate markers across streams do not',async()=>{
  for(const channel of ['stdout','stderr']){
    let calls=0;
    const result=await browserProbe(nonce,{resolveExecutable:async()=>'/controlled/ego-browser',run:async()=>{
      calls++;return {[channel]:calls===1?'DFY_EGO_BOOTSTRAP_READY\n':PROOF_PREFIX+JSON.stringify({kind:'browser',nonce,matched:true})+'\n'};
    }});assert.equal(result.matched,true);assert.equal(calls,2);
  }
  for(const duplicateBootstrap of [true,false]){
    let calls=0;await assert.rejects(browserProbe(nonce,{resolveExecutable:async()=>'/controlled/ego-browser',run:async()=>{
      calls++;
      if(calls===1)return duplicateBootstrap?{stdout:'DFY_EGO_BOOTSTRAP_READY\n',stderr:'DFY_EGO_BOOTSTRAP_READY\n'}:{stderr:'DFY_EGO_BOOTSTRAP_READY\n'};
      const proof=PROOF_PREFIX+JSON.stringify({kind:'browser',nonce,matched:true});return {stdout:proof,stderr:proof};
    }}));assert.equal(calls,duplicateBootstrap?1:2);
  }
});

test('desktop fixture PID, title and continued child ownership are required before any input',async()=>{
  for(const change of ['pid','title','closed']) {
    const calls=[];let alive=true;
    await assert.rejects(desktopProbe(nonce,{
      withFixture:async callback=>callback({pid:930,signal:new AbortController().signal,isAlive:()=>alive}),
      resolveExecutable:async()=>'/controlled/orca',run:async(_bin,args)=>{
        calls.push(args[1]);
        if(args[1]==='list-windows')return {stdout:JSON.stringify({ok:true,result:{app:{pid:change==='pid'?931:930},
          windows:[{id:91,index:0,title:change==='title'?'Other app':fixtureTitle}]}})};
        if(change==='closed')alive=false;
        return {stdout:JSON.stringify({ok:true,result:{snapshot:{treeText:'1 text field 本机能力验证输入\n2 button 确认本机能力测试'}}})};
      }}));
    assert.equal(calls.includes('set-value'),false);assert.equal(calls.includes('click'),false);
  }
});
