import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { registerConfigPanel } from '../packages/dsh-dafeiyu/src/config-panel.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { resolve, promise }; };
function fixture(t, { peerKind = 'owner', body = { action: 'autonomy-check-now', input: { revision: 'a'.repeat(64) } } } = {}) {
  const owner = new AbortController(), routes = new Map(), entered = deferred(), gate = deferred(), effects = [];
  let peer = { principal: { kind: peerKind }, signal: owner.signal }, context, continued = 0;
  const autonomy = { snapshot: () => ({ activities: [], wallet: { transactions: [], sessions: [] } }), preview: () => ({ eligible: false }),
    async checkNow(options) { context = options; entered.resolve(); await gate.promise; if (options.authorize() && !options.signal.aborted) continued++; return { automaticReplay: false }; } };
  let runtime = { lifeMemory: { snapshot: () => ({ revision: 'a'.repeat(64) }) }, autonomy };
  const ctx = { inject(_names, callback) {
    callback({ get: name => name === 'connection' ? { admit: () => ({ peer }) } : { register(def) { routes.set(def.path, def.handler); return () => routes.delete(def.path); } },
      effect(fn) { effects.push(fn()); } }); return { async dispose() { effects.splice(0).forEach(fn => fn?.()); } };
  } };
  const registration = registerConfigPanel(ctx, { getRuntime: () => runtime });
  t.after(async () => { gate.resolve(); await registration.dispose(); });
  const req = Readable.from([JSON.stringify(body)]); req.method = 'POST'; req.url = '/dafeiyu-panel/api/life/action'; req.headers = { 'content-type': 'application/json' };
  const res = new EventEmitter(); res.destroyed = false; res.writableEnded = false; res.ends = []; res.status = null;
  res.writeHead = status => { assert.equal(res.destroyed, false); res.status = status; };
  res.end = bytes => { assert.equal(res.destroyed, false); res.ends.push(JSON.parse(String(bytes))); res.writableEnded = true; res.emit('close'); };
  routes.get(req.url)(req, res);
  return { owner, req, res, entered: entered.promise, get context() { return context; }, get continued() { return continued; }, setPeer(value) { peer = value; },
    replace() { runtime = { ...runtime, autonomy: { ...autonomy } }; }, async release() { gate.resolve(); await tick(); await tick(); } };
}
test('owner immediate autonomy route passes exact CAS and a request signal; guest and extra fields cannot start a check', async t => {
  const f = fixture(t); await f.entered; assert.equal(f.context.revision, 'a'.repeat(64)); assert.equal(f.context.authorize(), true); await f.release();
  assert.equal(f.continued, 1); assert.equal(f.res.status, 200); assert.equal(f.res.ends[0].life.result.automaticReplay, false);
  const guest = fixture(t, { peerKind: 'guest' }); await guest.release(); assert.equal(guest.res.status, 403); assert.equal(guest.context, undefined);
  const extra = fixture(t, { body: { action: 'autonomy-check-now', input: { revision: 'a'.repeat(64), id: 'old-activity' } } }); await extra.release();
  assert.equal(extra.res.status, 400); assert.equal(extra.context, undefined);
});
test('closed owner response and request abort cancel a live immediate check without a late continuation or response write', async t => {
  for (const kind of ['response', 'request']) {
    const f = fixture(t); await f.entered;
    if (kind === 'response') { f.res.destroyed = true; f.res.emit('close'); }
    else { f.req.aborted = true; f.req.emit('aborted'); }
    assert.equal(f.context.signal.aborted, true); assert.equal(f.context.authorize(), false); await f.release(); assert.equal(f.continued, 0);
    if (kind === 'response') assert.equal(f.res.ends.length, 0);
    assert.equal(f.res.listenerCount('close'), 0); assert.equal(f.req.listenerCount('aborted'), 0);
  }
});
test('owner revoke and runtime replacement revoke the exact immediate check authorization', async t => {
  for (const kind of ['owner', 'runtime']) {
    const f = fixture(t); await f.entered; if (kind === 'owner') f.owner.abort(); else f.replace();
    assert.equal(f.context.authorize(), false); await f.release(); assert.equal(f.continued, 0); assert.ok([403, 409].includes(f.res.status));
  }
});

test('owner fixed browse route carries only the internal browse selection and rejects user supplied destinations', async t => {
  const f = fixture(t, { body: { action: 'autonomy-browse-now', input: { revision: 'a'.repeat(64) } } });
  await f.entered; assert.equal(f.context.kind, 'browse'); await f.release(); assert.equal(f.res.status, 200);
  const extra = fixture(t, { body: { action: 'autonomy-browse-now', input: { revision: 'a'.repeat(64), target: 'unapproved-destination' } } });
  await extra.release(); assert.equal(extra.res.status, 400); assert.equal(extra.context, undefined);
});
