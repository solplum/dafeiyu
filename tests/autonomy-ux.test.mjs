import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { AutonomyEngine } from '../packages/dsh-dafeiyu/src/autonomy-engine.js';

const yes = () => true, scope = { accountId: '200', identityId: 'default' };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-ux-'));
  const clock = { now: Date.parse('2026-10-26T04:00:00Z') };
  const memory = new LifeMemory({ directory, now: () => clock.now });
  const trust = { scopes: [scope], greeting: [scope], ready: true, busy: false };
  const budget = { policy: { enabled: true, requestReserveTokens: 100 }, availableTokens: 1000,
    pendingUnknownCount: 0, overdrawnTokens: 0 };
  const calls = [], sends = [], engines = [];
  const make = (extra = {}) => {
    const engine = new AutonomyEngine({ memory, now: () => clock.now, random: () => 0,
      scopes: () => trust.scopes, ...(options.noGreetingScope ? {} : { greetingScopes: () => trust.greeting }),
      contactReady: () => trust.ready, isBusy: () => trust.busy, tokenBudget: { snapshot: () => budget },
      run: async (...args) => { calls.push(args); return options.run ? options.run(...args) : { status: 'succeeded', text: 'FICTIONAL_GREETING' }; },
      send: async (...args) => { sends.push(args); return options.send ? options.send(...args) : { ok: true }; }, ...extra });
    engines.push(engine); return engine;
  };
  const engine = make();
  const configure = patch => engine.configure(patch, { authorize: yes });
  configure({ enabled: true, proactive: true, quietEnabled: false, targets: [scope] });
  let serial = 0;
  const capture = (userText = 'FICTIONAL_RECENT_TOPIC', target = scope) => {
    memory.configure({ learningEnabled: true }, { authorize: yes });
    memory.capture({ phase: 'received', selfId: '100', messageId: String(++serial), userText, scope: target }, { authorize: yes });
  };
  t.after(async () => { for (const e of engines) await e.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { engine, memory, clock, trust, budget, calls, sends, make, capture, configure,
    async schedule() { await engine.tick(); return engine.snapshot().activities.at(-1); },
    async due() { clock.now = engine.snapshot().activities.find(row => row.status === 'scheduled').dueAt; await engine.tick(); } };
}

test('legacy quiet policies project explicit switches without rewriting old data or opting into greetings', t => {
  const f = fixture(t);
  for (const [start, end, enabled] of [[0, 0, false], [23, 9, true]]) {
    f.memory.store.update(state => { const p = state.autonomy.policy; delete p.quietEnabled; delete p.greetingEnabled;
      p.quietStart = start; p.quietEnd = end; }, { authorize: yes });
    const before = fs.readFileSync(f.memory.store.file);
    assert.equal(f.engine.snapshot().policy.quietEnabled, enabled);
    assert.equal(f.engine.snapshot().policy.greetingEnabled, false);
    f.engine.preview();
    assert.deepEqual(fs.readFileSync(f.memory.store.file), before);
    f.configure({ maxActivities: 10 });
    assert.equal(Object.hasOwn(f.memory.store.read().state.autonomy.policy, 'quietEnabled'), false);
  }
});

test('explicit quiet controls preserve hours and reject an enabled empty range atomically', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.memory.store.file);
  assert.throws(() => f.configure({ quietEnabled: true, quietStart: 9, quietEnd: 9 }), { code: 'INVALID_PATCH' });
  assert.deepEqual(fs.readFileSync(f.memory.store.file), before);
  f.clock.now = Date.parse('2026-10-26T16:00:00Z');
  assert.notEqual(f.engine.preview().reasonCode, 'QUIET_HOURS');
  f.configure({ quietEnabled: true });
  assert.equal(f.engine.preview().reasonCode, 'QUIET_HOURS');
  f.configure({ quietEnabled: false });
  assert.equal(f.engine.snapshot().policy.quietStart, 23);
  assert.equal(f.engine.snapshot().policy.quietEnd, 9);
  assert.notEqual(f.engine.preview().reasonCode, 'QUIET_HOURS');
});

test('enabled autonomy without topic records stays blocked and an upgrade never implicitly greets', async t => {
  const f = fixture(t);
  assert.equal(f.engine.preview().reasonCode, 'NO_TOPIC');
  assert.equal(f.engine.preview().readiness, 'blocked');
  await f.engine.tick(); f.clock.now += 30 * 60000; await f.engine.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.engine.snapshot().activities.length, 0);
  assert.equal(f.engine.snapshot().policy.greetingEnabled, false);
});

test('first greeting needs explicit opt-in and a trusted owner identity, without inventing a memory source', async t => {
  const f = fixture(t); f.configure({ greetingEnabled: true });
  assert.equal(f.engine.preview().reasonCode, 'GREETING_READY');
  const revision = f.memory.snapshot().revision;
  f.engine.preview(); assert.equal(f.memory.snapshot().revision, revision);
  const candidate = await f.schedule();
  assert.equal(candidate.kind, 'chat'); assert.equal(candidate.origin, 'greeting');
  assert.equal(Object.hasOwn(candidate, 'sourceId'), false);
  assert.equal(Object.hasOwn(candidate, 'sourceFingerprint'), false);
  assert.equal(f.engine.preview().eligible, false);
  assert.equal(f.engine.preview().readiness, 'waiting');
  assert.equal(f.engine.preview().scheduledAt, candidate.dueAt);
  assert.equal(f.engine.preview().reasonCode, 'SCHEDULED_WAIT');
  await f.due();
  assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 1);
  assert.equal(f.engine.snapshot().wallet.sessions.length, 0, 'chat never starts the entertainment wallet');
  assert.equal(f.engine.preview().reasonCode, 'WAITING_REPLY');
  f.engine.userActivity(scope);
  assert.equal(f.engine.preview().eligible, false, 'a prior successful proactive contact is never a first greeting again');
  await f.engine.tick(); assert.equal(f.calls.length, 1);
});

test('greeting authority defaults closed, cannot cross account or identity, and ignores malformed opt-in', async t => {
  const a = fixture(t, { noGreetingScope: true }); a.configure({ greetingEnabled: true });
  assert.equal(a.engine.preview().eligible, false); await a.engine.tick(); assert.equal(a.calls.length, 0);
  const f = fixture(t), foreign = { accountId: '300', identityId: 'default' }, other = { accountId: '200', identityId: 'other' };
  f.trust.scopes.push(foreign, other);
  for (const target of [foreign, other]) {
    f.configure({ greetingEnabled: true, targets: [target] });
    assert.equal(f.engine.preview().eligible, false);
  }
  assert.throws(() => f.configure({ greetingEnabled: 'true' }), { code: 'INVALID_PATCH' });
  f.configure({ targets: [scope] });
  f.memory.store.update(state => { state.autonomy.policy.greetingEnabled = 'true'; }, { authorize: yes });
  assert.equal(f.engine.preview().eligible, false);
});

test('a forged or source-bearing greeting cannot reuse the persisted source exception', async t => {
  const f = fixture(t); f.configure({ greetingEnabled: true });
  const candidate = await f.schedule();
  const forged = { ...candidate, id: 'auto-00000000-0000-0000-0000-000000000000' };
  assert.equal(f.engine.sourceCurrent(forged), false);
  assert.equal(f.engine.sourceCurrent({ ...candidate, scope: { ...scope, identityId: 'other' } }), false);
  assert.equal(f.engine.sourceCurrent({ ...candidate, sourceId: 'a'.repeat(64) }), false);
  await f.engine.execute({ ...candidate, sourceId: 'a'.repeat(64) }, new AbortController());
  assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
});

test('new real topic invalidates a waiting source-free greeting and delays replacement without false memory deletion claims', async t => {
  const f = fixture(t); f.configure({ greetingEnabled: true }); await f.schedule();
  f.capture();
  assert.equal(f.engine.preview().reasonCode, 'CANDIDATE_INVALID');
  await f.due();
  const value = f.engine.snapshot();
  assert.equal(value.activities[0].status, 'skipped');
  assert.match(value.activities[0].reason, /首次问候条件已变化/);
  assert.doesNotMatch(value.activities[0].reason, /记忆.*删除|来源记忆/);
  assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.engine.preview().reasonCode, 'NEXT_CHECK_WAIT');
});

test('persisted greeting survives reload, but uncertain execution or delivery can never replay', async t => {
  const f = fixture(t, { send: async () => ({ ok: false, uncertain: true }) }); f.configure({ greetingEnabled: true });
  const candidate = await f.schedule();
  const reloaded = f.make(); f.clock.now = candidate.dueAt;
  await reloaded.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 1);
  assert.equal(reloaded.snapshot().activities[0].status, 'unknown');
  const before = reloaded.snapshot().activities[0];
  const again = f.make(); f.clock.now += 86400000;
  await again.tick(); await again.execute(candidate, new AbortController());
  assert.deepEqual(again.snapshot().activities[0], before);
  assert.equal(again.preview().reasonCode, 'UNKNOWN_ACTIVITY');
  assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 1);
});

test('acknowledging stopped unknown work preserves its proof and does not authorize another first greeting', async t => {
  const f = fixture(t, { send: async () => ({ ok: false, uncertain: true }) });
  f.configure({ greetingEnabled: true }); await f.schedule(); await f.due();
  f.memory.store.update(state => { state.autonomy.activities[0].status = 'interrupted'; }, { authorize: yes });
  assert.equal(f.engine.preview().reasonCode, 'GREETING_UNCONFIRMED');
  f.clock.now += 86400000; await f.engine.tick(); assert.equal(f.calls.length, 1);
  f.capture('FICTIONAL_NEW_TOPIC');
  assert.equal(f.engine.preview().reasonCode, 'NEXT_CHECK_WAIT', 'new topic work can resume without replaying the uncertain greeting');
  assert.equal(f.engine.snapshot().activities[0].delivery, 'unknown');
});

test('an older uncertain topic message cannot be treated as proof that the account was never contacted', async t => {
  const f = fixture(t); f.configure({ greetingEnabled: true });
  f.memory.store.update(state => state.autonomy.activities.push({ id: 'old-topic', kind: 'chat', scope,
    origin: 'memory', status: 'interrupted', delivery: 'unknown', createdAt: new Date(f.clock.now).toISOString() }), { authorize: yes });
  assert.equal(f.engine.preview().reasonCode, 'GREETING_UNCONFIRMED');
  await f.engine.tick(); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
});

test('an assessment wait is reused once when a new topic arrives, without a second random candidate delay', async t => {
  const f = fixture(t); await f.engine.tick(); const next = f.engine.snapshot().nextAt;
  f.capture();
  assert.equal(f.engine.preview().reasonCode, 'NEXT_CHECK_WAIT');
  assert.equal(f.engine.preview().nextCheckAt, next);
  assert.equal(f.engine.preview().eligible, false);
  f.clock.now = next; await f.engine.tick();
  assert.equal(f.engine.snapshot().activities[0].dueAt, next);
  assert.equal(f.engine.preview().readiness, 'ready');
  await f.engine.tick(); assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 1);
});

test('offline contact blocks chat model admission but does not invent browser connectivity', async t => {
  const f = fixture(t); f.capture(); f.trust.ready = false;
  assert.equal(f.engine.preview().reasonCode, 'CONTACT_NOT_READY');
  await f.engine.tick(); assert.equal(f.calls.length, 0);
  f.configure({ proactive: false, browse: true, platforms: ['bilibili'] });
  f.engine.wallet.configure({ enabled: true, dailySeconds: 10, monthlySeconds: 0 }, { authorize: yes });
  assert.equal(f.engine.preview().reasonCode, 'NEXT_CHECK_WAIT', 'a browse plan can remain eligible for the next assessment');
  f.clock.now = f.engine.snapshot().nextAt; await f.engine.tick();
  assert.equal(f.engine.snapshot().activities[0].kind, 'browse');
});

test('read-only preview does not consume scheduling randomness and actual browsing retains its platform selection', async t => {
  const f = fixture(t); f.capture(); f.configure({ proactive: false, browse: true, platforms: ['bilibili', 'douyin'] });
  f.engine.wallet.configure({ enabled: true, dailySeconds: 10, monthlySeconds: 0 }, { authorize: yes });
  let randomCalls = 0; f.engine.random = () => { randomCalls++; return 0.99; };
  const before = fs.readFileSync(f.memory.store.file);
  assert.equal(f.engine.preview().eligible, true);
  assert.equal(randomCalls, 0); assert.deepEqual(fs.readFileSync(f.memory.store.file), before);
  const candidate = await f.schedule();
  assert.equal(candidate.platform, 'douyin'); assert.equal(randomCalls, 2);
});

test('a scheduled browser plan cannot preview ready after its platform permission was removed', async t => {
  const f = fixture(t); f.capture(); f.configure({ proactive: false, browse: true, platforms: ['bilibili'] });
  f.engine.wallet.configure({ enabled: true, dailySeconds: 10, monthlySeconds: 0 }, { authorize: yes });
  const candidate = await f.schedule();
  f.configure({ platforms: ['douyin'] });
  assert.equal(f.engine.permitted(candidate), false);
  assert.equal(f.engine.preview().eligible, false);
  assert.equal(f.engine.preview().reasonCode, 'CANDIDATE_PERMISSION_CHANGED');
  f.clock.now = candidate.dueAt;
  assert.equal(f.engine.preview().eligible, false);
  f.configure({ quietEnabled: true, quietStart: 12, quietEnd: 13 });
  await f.engine.tick();
  const snapshot = f.engine.snapshot();
  assert.equal(snapshot.activities[0].status, 'skipped', 'quiet deferral cannot keep a revoked platform authorized');
  assert.match(snapshot.activities[0].reason, /授权或有效期/);
  assert.ok(snapshot.nextAt > f.clock.now);
  assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
});

test('temporary quiet time or offline contact defers the same unstarted greeting until permitted', async t => {
  for (const mode of ['quiet', 'contact']) {
    const f = fixture(t); f.configure({ greetingEnabled: true });
    const candidate = await f.schedule(); f.clock.now = candidate.dueAt;
    if (mode === 'quiet') f.configure({ quietEnabled: true, quietStart: 12, quietEnd: 13 });
    else f.trust.ready = false;
    assert.equal(f.engine.preview().reasonCode, mode === 'quiet' ? 'QUIET_HOURS' : 'CONTACT_NOT_READY');
    await f.engine.tick();
    assert.equal(f.engine.snapshot().activities[0].status, 'scheduled');
    assert.equal(f.calls.length, 0);
    if (mode === 'quiet') f.clock.now = Date.parse('2026-10-26T05:00:00Z');
    else f.trust.ready = true;
    await f.engine.tick(); await f.engine.tick();
    assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 1);
    assert.equal(f.engine.snapshot().activities.length, 1);
    assert.equal(f.engine.snapshot().activities[0].id, candidate.id);
  }
});

test('specific reasons retain original identity/day counter semantics and do not mutate ledgers', t => {
  const f = fixture(t); f.capture();
  const preview = f.engine.preview();
  assert.deepEqual(preview.counterPolicy, { contacts: 'account-identity-delivered-local-day', activities: 'created-local-day-non-scheduled' });
  f.memory.store.update(state => state.autonomy.activities.push({ id: 'past', scope, kind: 'chat', status: 'completed', delivery: 'sent',
    createdAt: new Date(f.clock.now).toISOString(), finishedAt: new Date(f.clock.now).toISOString() }), { authorize: yes });
  assert.equal(f.engine.preview().reasonCode, 'MIN_GAP');
  f.configure({ maxContacts: 1 }); assert.equal(f.engine.preview().reasonCode, 'CONTACT_LIMIT');
  f.configure({ maxActivities: 1 }); assert.equal(f.engine.preview().reasonCode, 'ACTIVITY_LIMIT');
  const before = fs.readFileSync(f.memory.store.file); f.engine.preview(); assert.deepEqual(fs.readFileSync(f.memory.store.file), before);
});

test('quiet, target revocation, greeting opt-out and connection loss cancel a live greeting without releasing cleanup or sending late output', async t => {
  for (const change of ['quiet-policy', 'quiet-clock', 'target', 'greeting', 'connection', 'user']) {
    let enter, release, aborted = false, begunUsage = 0;
    const entered = new Promise(resolve => { enter = resolve; }), waiting = new Promise(resolve => { release = resolve; });
    const f = fixture(t, { run: async (_activity, { signal }) => {
      begunUsage++; signal.addEventListener('abort', () => { aborted = true; }); enter(); await waiting;
      return { status: 'succeeded', text: 'FICTIONAL_LATE' };
    } });
    f.configure({ greetingEnabled: true });
    if (change === 'quiet-clock') f.configure({ quietEnabled: true, quietStart: 13, quietEnd: 14 });
    const candidate = await f.schedule(); f.clock.now = candidate.dueAt;
    const running = f.engine.tick(); await entered;
    if (change === 'quiet-policy') f.configure({ quietEnabled: true, quietStart: 12, quietEnd: 13 });
    if (change === 'quiet-clock') { f.clock.now = Date.parse('2026-10-26T05:00:00Z'); await f.engine.tick(); }
    if (change === 'target') f.configure({ targets: [] });
    if (change === 'greeting') f.configure({ greetingEnabled: false });
    if (change === 'connection') { f.trust.ready = false; await f.engine.tick(); }
    if (change === 'user') f.engine.userActivity(scope);
    assert.equal(aborted, true, change);
    assert.equal(f.engine.snapshot().running, true, 'abort does not prove worker cleanup');
    release(); await running;
    assert.equal(f.sends.length, 0, change);
    assert.equal(begunUsage, 1, 'cancellation neither fabricates zero use nor repeats a begun request');
    assert.equal(f.engine.snapshot().activities[0].status, 'cancelled');
  }
});

test('unknown cleanup or Token settlement dominates cancellation and never authorizes a replacement greeting', async t => {
  for (const code of ['CONTROL_CLEANUP_UNCONFIRMED', 'TOKEN_ACCOUNTING_UNCONFIRMED']) {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), waiting = new Promise(resolve => { release = resolve; });
    const f = fixture(t, { run: async () => { enter(); await waiting; throw Object.assign(new Error('FIXTURE_UNCONFIRMED'), { code }); } });
    f.configure({ greetingEnabled: true });
    const candidate = await f.schedule(); f.clock.now = candidate.dueAt;
    const running = f.engine.tick(); await entered;
    f.engine.userActivity(scope); release(); await running;
    assert.equal(f.engine.snapshot().activities[0].status, 'unknown', code);
    assert.equal(f.engine.preview().reasonCode, 'UNKNOWN_ACTIVITY');
    f.clock.now += 86400000; await f.make().tick();
    assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 0);
  }
});

test('an explicit unknown execution receipt cannot become ordinary cancellation after an abort', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { run: async () => { enter(); await waiting; return { status: 'unknown', text: '' }; } });
  f.configure({ greetingEnabled: true });
  const candidate = await f.schedule(); f.clock.now = candidate.dueAt;
  const running = f.engine.tick(); await entered;
  f.engine.userActivity(scope); release(); await running;
  assert.equal(f.engine.snapshot().activities[0].status, 'unknown');
  assert.equal(f.engine.preview().reasonCode, 'UNKNOWN_ACTIVITY');
  assert.equal(f.sends.length, 0);
});
