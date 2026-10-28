import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BrowserAccountDriver } from '../packages/dsh-dafeiyu/src/social/browser-account.mjs';
import { SocialAccountError } from '../packages/dsh-dafeiyu/src/social/platforms.mjs';
const HOME='https://creator.douyin.com/creator-micro/home';
function fixture({frames=[{}, {id:'first-owner'}], afterWait, onPoll, initialUrl='about:blank'}={}) {
  let frame=0,url=initialUrl,polls=0;const navigations=[],checks=[],scripts=[];
  const visible=(props={})=>({tagName:'DIV',getBoundingClientRect:()=>({width:10,height:10}),getAttribute:()=>'',innerText:'',textContent:'',...props});
  const document={querySelectorAll(selector){
    const state=frames[Math.min(frame,frames.length-1)];
    if(selector==='#own')return state.id?[visible({innerText:'own:'+state.id,textContent:'own:'+state.id})]:[];
    if(selector.includes('iframe[src*=captcha]'))return state.risk?[visible({innerText:'安全验证'})]:[];
    if(selector.startsWith('form,'))return state.login?[visible({innerText:'扫码登录'})]:[];
    return [];
  }};
  const sandbox=vm.createContext({document,URL});
  const evaluate=code=>vm.runInContext(code,sandbox);
  const runtime={children:new Set(),available:true,async run(body,context){
    scripts.push(body);
    const authority=()=>{if(context.signal?.aborted||context.authorize?.()!==true)throw new SocialAccountError('FORBIDDEN');};
    authority();
    const page={async url(){authority();return url;},async goto(target,options){authority();assert.equal(options.wait,true);assert.equal(options.timeout,30000);navigations.push(target);url=target;},
      async evaluate(code){authority();checks.push(code.includes('iframe[src*=captcha]')?'safety':'identity');return evaluate(code);},
      async waitForFunction(code,options){assert.equal(options.timeout,10000);assert.equal(Object.keys(options).join(','),'timeout');
        for(let i=0;i<5;i++){authority();polls++;const ready=evaluate(code);onPoll?.(polls);
          if(ready){afterWait?.({setFrame:n=>{frame=n;}});return true;}frame++;
        }throw Error('fixture timeout');},
    };
    try{return await vm.runInNewContext('(async()=>{'+body+';return result;})()',{
      URL,page,browser:{async ensureRealTab(){}},taskSpaces:{async list(){return [{id:1,name:'dfy-social-douyin',ownership:'agent'}];},async useOrCreate(){}},
    });}catch(error){if(error.message==='RISK_CONTROL')error.code='RISK_CONTROL';throw error;}
  }};
  const driver=new BrowserAccountDriver({key:'douyin',directory:'/unused',runtime,bindings:{platform:'douyin',verified:true,accountId:'first-owner',identity:{url:HOME,selector:'#own',attribute:'innerText',pattern:'^own:(.+)$'}}});
  return {driver,navigations,checks,scripts,get polls(){return polls;},get frame(){return frame;}};
}
const context={authorize:()=>true,accountId:'first-owner'};

test('account waits for an SPA identity that appears after DOMContentLoaded without refreshing or navigating twice',async()=>{
  const f=fixture();const result=await f.driver.account(context);
  assert.equal(result.loggedIn,true);assert.equal(result.accountId,'first-owner');assert.equal(f.polls,2);assert.deepEqual(f.navigations,[HOME]);
  assert.equal(f.checks.at(-1),'identity');assert.equal(f.checks.at(-2),'safety');
});

test('another valid account ends readiness immediately instead of waiting for the saved account or switching it',async()=>{
  const f=fixture({frames:[{id:'different-owner'}]});const result=await f.driver.account(context);
  assert.equal(result.accountId,'different-owner');assert.equal(f.polls,1);assert.deepEqual(f.navigations,[HOME]);
});

test('late visible risk after a successful wait is rechecked and throws RISK_CONTROL before reading identity',async()=>{
  const f=fixture({frames:[{}, {id:'first-owner'}, {id:'first-owner',risk:true}],afterWait:({setFrame})=>setFrame(2)});
  await assert.rejects(f.driver.account(context),{code:'RISK_CONTROL'});assert.equal(f.polls,2);assert.equal(f.checks.at(-1),'safety');assert.deepEqual(f.navigations,[HOME]);
});

test('a visible risk page ends readiness and reports risk instead of waiting for an identity',async()=>{
  const f=fixture({frames:[{}, {risk:true}]});await assert.rejects(f.driver.account(context),{code:'RISK_CONTROL'});assert.equal(f.polls,2);assert.deepEqual(f.navigations,[HOME]);
});

test('a clear visible login page ends readiness without pretending that the stored account is logged in',async()=>{
  const f=fixture({frames:[{}, {login:true}]});const result=await f.driver.account(context);
  assert.equal(result.loggedIn,false);assert.equal(result.state,'login-pending');assert.equal(f.polls,2);assert.deepEqual(f.navigations,[HOME]);
});

test('cancellation during identity readiness interrupts the same account request without another navigation',async()=>{
  const controller=new AbortController();const f=fixture({onPoll:()=>controller.abort()});
  await assert.rejects(f.driver.account({...context,signal:controller.signal}),{code:'FORBIDDEN'});assert.equal(f.polls,1);assert.deepEqual(f.navigations,[HOME]);
});
