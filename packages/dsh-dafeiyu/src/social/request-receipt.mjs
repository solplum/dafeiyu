import { deny } from './platforms.mjs';
import { exactResponseCapture } from './ego-douyin-driver.mjs';

/** Code-owned bindings must prove the actual outgoing target and content.
 * Refuse mismatches before the page calls fetch/XHR; never resend a request in
 * order to obtain evidence. Responses are still captured from that first call. */
export function requestReceipt(url, key, binding, expected) {
  if (!binding || !['POST', 'PUT', 'DELETE'].includes(binding.method)
    || !['json', 'form'].includes(binding.encoding) || !binding.fields || typeof binding.fields !== 'object') deny('BINDINGS_REQUIRED');
  for (const [source, value] of Object.entries(expected)) {
    const parts = binding.fields[source];
    if (typeof value !== 'string' || !Array.isArray(parts) || parts.length < 1 || parts.length > 8
      || parts.some(part => typeof part !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))) deny('BINDINGS_REQUIRED');
  }
  const reads = binding.readOnly || [];
  if (!Array.isArray(reads) || reads.length > 20 || reads.some(row => !row || !['GET', 'HEAD', 'POST'].includes(row.method)
    || row.verified !== true || typeof row.url !== 'string' || !row.url.startsWith('https://'))) deny('BINDINGS_REQUIRED');
  const capture = exactResponseCapture(url, key);
  const q = JSON.stringify, guard = key + '_guard';
  const install = `(()=>{
    const key=${q(guard)},expectedURL=${q(url)},binding=${q(binding)},expected=${q(expected)};
    if(window[key])throw Error('REQUEST_GUARD_EXISTS');
    const originalFetch=window.fetch,proto=XMLHttpRequest.prototype,originalOpen=proto.open,originalSend=proto.send,requests=new WeakMap();let attempted=false;
    const absolute=url=>{try{return new URL(String(url),location.href).href;}catch{return '';}};
    const same=url=>absolute(url)===expectedURL;
    const permit=(url,method)=>{method=String(method).toUpperCase();if(!['GET','HEAD'].includes(method)&&!same(url)
      &&!(binding.readOnly||[]).some(row=>row.url===absolute(url)&&row.method===method&&row.verified===true))throw Error('UNREVIEWED_MUTATION_BLOCKED');};
    const prove=(method,body)=>{if(attempted)throw Error('DUPLICATE_REQUEST_BLOCKED');if(String(method).toUpperCase()!==binding.method)throw Error('WRONG_REQUEST_METHOD');
      let payload;if(binding.encoding==='json'){if(typeof body!=='string'||body.length>262144)throw Error('REQUEST_PROOF_UNAVAILABLE');payload=JSON.parse(body);}
      else{if(typeof body==='string'){if(body.length>262144)throw Error('REQUEST_TOO_LARGE');payload={};for(const [k,v]of new URLSearchParams(body)){if(Object.hasOwn(payload,k))throw Error('AMBIGUOUS_REQUEST');payload[k]=v;}}
        else if(body instanceof URLSearchParams||body instanceof FormData){payload={};for(const [k,v]of body.entries()){if(typeof v!=='string'||Object.hasOwn(payload,k))throw Error('AMBIGUOUS_REQUEST');payload[k]=v;}}
        else throw Error('REQUEST_PROOF_UNAVAILABLE');}
      for(const [source,value]of Object.entries(expected)){const actual=binding.fields[source].reduce((v,k)=>v!=null&&Object.hasOwn(v,k)?v[k]:undefined,payload);
        if(!['string','number'].includes(typeof actual)||String(actual)!==value)throw Error('REQUEST_DRAFT_MISMATCH');}attempted=true;};
    const wrappedFetch=async function(input,init){const url=input instanceof Request?input.url:input,method=init?.method||(input instanceof Request?input.method:'GET');permit(url,method);if(same(url)){
      let body=init?.body;
      if(body===undefined&&input instanceof Request){const size=Number(input.headers.get('content-length'));if(size>262144)throw Error('REQUEST_TOO_LARGE');body=await input.clone().text();}
      prove(method,body);}return Reflect.apply(originalFetch,this,[input,init]);};
    const wrappedOpen=function(method,url,...rest){requests.set(this,{method,url});return Reflect.apply(originalOpen,this,[method,url,...rest]);};
    const wrappedSend=function(body){const meta=requests.get(this);if(meta){permit(meta.url,meta.method);if(same(meta.url))prove(meta.method,body);}return Reflect.apply(originalSend,this,[body]);};
    const ws=window.WebSocket?.prototype,wsSend=ws?.send,nav=window.navigator,beacon=nav?.sendBeacon;
    const blocked=()=>{throw Error('UNREVIEWED_MUTATION_BLOCKED');},form=event=>event.preventDefault();
    const state={restore:()=>{if(window.fetch===wrappedFetch)window.fetch=originalFetch;if(proto.open===wrappedOpen)proto.open=originalOpen;if(proto.send===wrappedSend)proto.send=originalSend;
      if(ws&&ws.send===blocked)ws.send=wsSend;if(nav&&nav.sendBeacon===blocked)nav.sendBeacon=beacon;window.document?.removeEventListener?.('submit',form,true);delete window[key];}};
    if(wsSend)ws.send=blocked;if(beacon)nav.sendBeacon=blocked;window.document?.addEventListener?.('submit',form,true);
    Object.defineProperty(window,key,{configurable:true,value:state});window.fetch=wrappedFetch;proto.open=wrappedOpen;proto.send=wrappedSend;return true;
  })()`;
  // Install receipt first, then request guard; restore in the reverse order.
  return { ...capture, install: `(()=>{const result=${capture.install};try{return ${install};}catch(error){${capture.cleanup};throw error;}})()`,
    cleanup: `(()=>{try{window[${q(guard)}]?.restore();}finally{${capture.cleanup};}})()` };
}
