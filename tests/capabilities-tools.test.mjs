import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../packages/dsh-dafeiyu/src/capabilities.js';
import { registerCapabilityTools } from '../packages/dsh-dafeiyu/src/capabilities-tools.js';

function fixture(t, options = {}) {
  const agent = {}, definitions = new Map(), identity = { value: { isOwner: true, channel: 'onebot' } };
  let probes = 0;
  const registry = new CapabilityRegistry({ probes: { computer: async () => { probes++; } },
    getHost: () => ({ computer: { present: true, available: true } }) });
  const stop = registerCapabilityTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } } },
    { registry, getExecutionContext: (execution) => execution?.agent === agent ? identity.value : null, ...options });
  const definition = definitions.get('dafeiyu_capabilities'); t.after(() => { stop(); registry.dispose(); });
  return { agent, identity, definitions, definition, stop, registry, get probes() { return probes; },
    invoke: (args = {}, execution = {}) => definition.execute(args, { agent, ...execution }) };
}

test('only a read-only capability query is registered and trusted owner channels read the same registry snapshot', async (t) => {
  const f = fixture(t); assert.deepEqual([...f.definitions.keys()], ['dafeiyu_capabilities']);
  for (const channel of ['onebot', 'desktop', 'official']) {
    f.identity.value = { isOwner: true, channel }; const result = await f.invoke({ id: 'computer' });
    assert.equal(result.ok, true); assert.equal(result.items.length, 1); assert.equal(result.items[0].state, 'ready');
    assert.deepEqual(result.items, f.registry.snapshot().items.filter((item) => item.id === 'computer'));
  }
  assert.equal((await f.invoke()).items.length, 11); assert.equal(f.probes, 0);
});

test('guest, unknown, copied, cancelled and unregistered executions cannot read capability state', async (t) => {
  const f = fixture(t); f.identity.value = { isOwner: false, channel: 'onebot' };
  await assert.rejects(f.invoke(), /已验证的主人/); f.identity.value = { isOwner: true };
  await assert.rejects(f.invoke({}, { agent: {}, isOwner: true }), /已验证的主人/);
  await assert.rejects(f.invoke({}, { agent: null }), /已验证的主人/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.invoke({}, { signal: controller.signal }), /已验证的主人/);
  f.stop(); await assert.rejects(f.invoke(), /已验证的主人/); assert.equal(f.probes, 0);
});

test('query arguments cannot select another account, trigger probes or inject runtime status', async (t) => {
  const f = fixture(t);
  for (const args of [{ id: 'unknown' }, { probe: true }, { qq: '12345' }, { agent: {} }, { state: 'verified' }])
    await assert.rejects(f.invoke(args));
  assert.equal(f.probes, 0);
});

test('owner desktop preparation is explicit and cannot mark a capability verified or be triggered by a status query', async (t) => {
  let calls=0;
  const f=fixture(t,{prepareDesktop:async({authorize})=>{calls++;assert.equal(authorize(),true);return {ok:true,code:'READY'};}});
  const definition=f.definitions.get('dafeiyu_desktop_prepare');
  assert.deepEqual(definition.parameters.properties,{});
  await f.invoke();assert.equal(calls,0);
  const result=await definition.execute({}, {agent:f.agent});
  assert.deepEqual({ok:result.ok,code:result.code,verified:result.verified},{ok:true,code:'READY',verified:false});
  assert.equal(calls,1);assert.equal(f.registry.snapshot().items.find(item=>item.id==='computer').state,'ready');
  for(const args of [{pid:930},{app:'another-app'},{command:'arbitrary'}])await assert.rejects(definition.execute(args,{agent:f.agent}));
  assert.equal(calls,1);
});

test('untrusted, cancelled or disposed preparation never starts a helper; revoked ownership never publishes READY', async (t) => {
  let calls=0;
  const f=fixture(t,{prepareDesktop:async()=>{calls++;f.identity.value={isOwner:false};return {ok:true,code:'READY'};}});
  const definition=f.definitions.get('dafeiyu_desktop_prepare');
  await assert.rejects(definition.execute({}, {agent:{}}));assert.equal(calls,0);
  f.identity.value={isOwner:false};await assert.rejects(definition.execute({}, {agent:f.agent}));assert.equal(calls,0);
  f.identity.value={isOwner:true};const controller=new AbortController();controller.abort();
  await assert.rejects(definition.execute({}, {agent:f.agent,signal:controller.signal}));assert.equal(calls,0);
  await assert.rejects(definition.execute({}, {agent:f.agent}),/撤销|取消/);assert.equal(calls,1);
  f.identity.value={isOwner:true};f.stop();
  await assert.rejects(definition.execute({}, {agent:f.agent}));assert.equal(calls,1);
});

test('permission refusal and malformed preparation receipts cannot become successful control proofs', async (t) => {
  let reply={ok:false,code:'UNTRUSTED'};
  const f=fixture(t,{prepareDesktop:async()=>reply});const definition=f.definitions.get('dafeiyu_desktop_prepare');
  let result=await definition.execute({}, {agent:f.agent});
  assert.equal(result.ok,false);assert.equal(result.code,'UNTRUSTED');assert.equal(result.verified,false);assert.match(result.message,/没有自动申请权限/);
  reply={ok:true,code:'UNCONFIRMED',raw:'PRIVATE'};result=await definition.execute({}, {agent:f.agent});
  assert.equal(result.ok,false);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});

test('unexpected preparation failures return a fixed receipt instead of raw compiler diagnostics',async(t)=>{
  const f=fixture(t,{prepareDesktop:async()=>{throw Error('PRIVATE_COMPILER_OUTPUT');}});
  const result=await f.definitions.get('dafeiyu_desktop_prepare').execute({}, {agent:f.agent});
  assert.equal(result.ok,false);assert.equal(result.code,'UNCONFIRMED');assert.equal(result.verified,false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
