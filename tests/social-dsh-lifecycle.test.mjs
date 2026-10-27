import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { registerConfigPanel } from '../packages/dsh-dafeiyu/src/config-panel.js';
import { SocialAccountError } from '../packages/dsh-dafeiyu/src/social/platforms.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };

// The shipped HTTP route is mounted. Only its runtime and HTTP transports are
// fixtures: no file, browser, platform, private configuration or model is used.
function fixture(t, { action = 'next', reject = false } = {}) {
  const entered = deferred(), gate = deferred(), completed = deferred(), owner = new AbortController();
  const routes = new Map(); let captured, lateSteps = 0, peer = { principal: { kind: 'owner' }, signal: owner.signal };
  const manager = {
    snapshot: () => ({ revision: 'fixture', platforms: [], operations: [] }),
    async browse(platform, request, context) {
      assert.equal(platform, 'douyin'); assert.equal(request.action, action);
      captured = context; entered.resolve(); await gate.promise;
      try {
        if (reject || !context.authorize() || context.signal.aborted) throw new SocialAccountError('FORBIDDEN');
        lateSteps++; return { ok: true, action, state: action === 'stop' ? 'stopped' : 'active' };
      } finally { completed.resolve(); }
    },
  };
  const runtime = { socialAccounts: manager }, effects = [];
  const ctx = { inject(names, callback) {
    assert.deepEqual(names, ['webServer', 'connection']);
    callback({ get(name) { return name === 'connection' ? { admit: () => ({ peer }) } : {
      register(row) { routes.set(row.path, row.handler); return () => routes.delete(row.path); },
    }; }, effect(install) { effects.push(install()); } });
    return { async dispose() { for (const cleanup of effects.splice(0)) await cleanup(); } };
  } };
  const registration = registerConfigPanel(ctx, { getRuntime: () => runtime });
  t.after(async () => { gate.resolve(); await registration.dispose(); });
  const request = { action, ...(action === 'next' ? { expectedVideoId: 'media-' + 'a'.repeat(64) } : {}) };
  const req = Readable.from([JSON.stringify({ platform: 'douyin', request })]);
  req.method = 'POST'; req.url = '/dafeiyu-panel/api/social/browse'; req.headers = { 'content-type': 'application/json' };
  const res = new EventEmitter(); res.destroyed = false; res.writableEnded = false;
  res.writes = []; res.ends = []; res.status = null;
  res.writeHead = (status, headers) => { res.status = status; res.writes.push({ status, headers }); };
  res.end = data => { res.ends.push(JSON.parse(String(data))); res.writableEnded = true; res.emit('finish'); res.emit('close'); };
  routes.get(req.url)(req, res);
  return { req, res, owner, entered: entered.promise, get context() { return captured; }, get lateSteps() { return lateSteps; },
    setPeer(next) { peer = next; },
    async release() { gate.resolve(); await completed.promise; await turn(); await turn(); },
  };
}

test('real DSH social route cancels after the full body when its response closes; no late step or closed write', async t => {
  const f = fixture(t); await f.entered;
  assert.equal(f.req.readableEnded, true); assert.equal(f.context.signal.aborted, false);
  f.res.destroyed = true; f.res.emit('close');
  assert.equal(f.context.signal.aborted, true); assert.equal(f.context.authorize(), false);
  await f.release(); assert.equal(f.lateSteps, 0);
  assert.equal(f.res.writes.length, 0); assert.equal(f.res.ends.length, 0);
  assert.equal(f.res.listenerCount('close'), 0); assert.equal(f.req.listenerCount('aborted'), 0);
});

test('real DSH social route relays req.aborted after body completion', async t => {
  const f = fixture(t, { action: 'current' }); await f.entered;
  f.req.aborted = true; f.req.emit('aborted');
  assert.equal(f.context.signal.aborted, true); assert.equal(f.context.authorize(), false);
  await f.release(); assert.equal(f.lateSteps, 0);
  assert.equal(f.res.ends[0].code, 'FORBIDDEN'); assert.equal(f.res.status, 403);
});

test('normal body close and response finish do not cancel a completed DSH social request or the owner session', async t => {
  const f = fixture(t, { action: 'stop' }); await f.entered; await turn();
  assert.equal(f.req.readableEnded, true); assert.equal(f.context.signal.aborted, false);
  await f.release(); assert.equal(f.res.status, 200); assert.equal(f.lateSteps, 1);
  assert.equal(f.res.ends[0].browse.state, 'stopped'); assert.equal(f.context.signal.aborted, false);
  assert.equal(f.owner.signal.aborted, false); assert.equal(f.res.writes.length, 1); assert.equal(f.res.ends.length, 1);
  f.res.emit('close'); assert.equal(f.context.signal.aborted, false);
  assert.equal(f.res.listenerCount('close'), 0); assert.equal(f.req.listenerCount('aborted'), 0);
});

test('already ended responses receive no second JSON response on a delayed route failure', async t => {
  const f = fixture(t, { reject: true }); await f.entered;
  f.res.end(JSON.stringify({ ok: true, externalFixtureResponse: true }));
  assert.equal(f.context.signal.aborted, false, 'a normal finish is not cancellation');
  await f.release(); assert.equal(f.res.ends.length, 1); assert.equal(f.res.writes.length, 0);
});

test('owner signal revocation aborts the per-request signal and still suppresses private results', async t => {
  const f = fixture(t); await f.entered; f.owner.abort();
  assert.notEqual(f.context.signal, f.owner.signal); assert.equal(f.context.signal.aborted, true);
  assert.equal(f.context.authorize(), false); await f.release();
  assert.equal(f.lateSteps, 0); assert.equal(f.res.status, 403); assert.equal(f.res.ends[0].code, 'FORBIDDEN');
  assert.equal(f.res.ends[0].browse, undefined);
});

test('dynamic owner admission changes revoke the action even without a peer abort event', async t => {
  const f = fixture(t); await f.entered;
  f.setPeer({ principal: { kind: 'guest' }, signal: new AbortController().signal });
  assert.equal(f.context.authorize(), false); await f.release();
  assert.equal(f.lateSteps, 0); assert.equal(f.res.status, 403); assert.equal(f.res.ends[0].browse, undefined);
});
