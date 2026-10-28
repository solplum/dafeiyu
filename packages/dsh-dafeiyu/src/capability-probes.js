import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractProof } from './capability-probe-runner.mjs';

const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";

/** No caller-controlled command, app, page, file or recipient enters these tests. */
export function createCapabilityProbes({ host, nativeControl = false } = {}) {
  const runner = fileURLToPath(new URL('./capability-probe-runner.mjs', import.meta.url));
  return Object.fromEntries(['computer','desktop','browser'].map((id) => [id, async ({signal,authorize}) => {
    if (!authorize?.() || signal?.aborted) return {ok:false,code:'CANCELLED'};
    if (nativeControl && ['desktop', 'browser'].includes(id)) {
      try { return await host.probeControl(id, { signal, authorize }); }
      catch (error) { return { ok: false, code: signal?.aborted ? 'CANCELLED'
        : ['DESKTOP_TARGET_UNCONFIRMED','ACCESSIBILITY_REQUIRED'].includes(error?.code) ? error.code : 'UNCONFIRMED' }; }
    }
    const nonce = 'DFY-CAP-' + randomBytes(12).toString('hex');
    const command = ['node',quote(runner),quote(id),quote(nonce)].join(' ');
    let result;
    try { result = await host.executeCommand(command,{signal,authorize,timeoutMs:60000}); }
    catch { return {ok:false,code:signal?.aborted ? 'CANCELLED' : 'UNCONFIRMED'}; }
    if (!authorize() || signal?.aborted) return {ok:false,code:'CANCELLED'};
    if (result?.ok !== true || result.exitCode !== 0) return {ok:false,code:['UNAVAILABLE','UNCONFIRMED','FAILED','ACCESSIBILITY_REQUIRED','DESKTOP_INIT_UNCONFIRMED','DESKTOP_TARGET_UNCONFIRMED'].includes(result?.code)?result.code:'UNCONFIRMED'};
    try { extractProof(result.stdout,id,nonce); }
    catch { return {ok:false,code:'UNCONFIRMED'}; }
    return {ok:true,evidence:{kind:'readback',matched:true}};
  }]));
}
