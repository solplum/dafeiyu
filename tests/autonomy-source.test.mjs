import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { AutonomyEngine } from '../packages/dsh-dafeiyu/src/autonomy-engine.js';

const yes = () => true, scope = { accountId: '20002', identityId: 'source-fixture' };
function fixture(t, { run } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-source-'));
  const clock = { value: Date.parse('2026-10-25T10:00:00Z') }, calls = [], sent = [];
  const memory = new LifeMemory({ directory, now: () => clock.value });
  const engine = new AutonomyEngine({ memory, now: () => clock.value, random: () => 0, scopes: () => [scope],
    run: async (...args) => { calls.push(args); return run ? run(...args) : { status: 'succeeded', text: 'FICTIONAL_RESULT' }; },
    send: async (...args) => { sent.push(args); return { ok: true }; } });
  t.after(async () => { await engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  memory.configure({ learningEnabled: true }, { authorize: yes });
  const capture = (messageId, userText) => memory.capture({ phase: 'received', selfId: '10001', messageId, userText, scope }, { authorize: yes });
  capture('1', 'FICTIONAL_SAFE_FALLBACK');
  capture('2', 'FICTIONAL_SOURCE '.repeat(12) + ' ORIGINAL_TAIL');
  engine.configure({ enabled: true, proactive: true, quietStart: 0, quietEnd: 0, targets: [scope] }, { authorize: yes });
  const sourceId = memory.snapshot().items[0].id;
  return { clock, memory, engine, calls, sent, sourceId, capture,
    async schedule() { await engine.tick(); return engine.snapshot().activities[0]; },
    async due() { clock.value += 30 * 60000; await engine.tick(); } };
}

test('candidate versions reject changed, inactive, missing and foreign sources before dispatch without choosing an alternative', async t => {
  for (const mutation of ['detail-tail', 'summary', 'inactive', 'missing', 'foreign-account', 'foreign-identity', 'missing-proof']) {
    const f = fixture(t), candidate = await f.schedule();
    assert.match(candidate.sourceFingerprint, /^[a-f0-9]{64}$/);
    // Simulate a source writer predating manage() invalidation. Admission must
    // protect the candidate independently of the manager's convenience path.
    f.memory.store.update(state => {
      const row = state.memories.find(item => item.id === f.sourceId);
      if (mutation === 'detail-tail') row.detail += ' CHANGED_TAIL';
      if (mutation === 'summary') row.summary = 'FICTIONAL_CHANGED_TOPIC';
      if (mutation === 'inactive') row.status = 'inactive';
      if (mutation === 'missing') state.memories = state.memories.filter(item => item.id !== row.id);
      if (mutation === 'foreign-account') row.scope.accountId = '30003';
      if (mutation === 'foreign-identity') row.scope.identityId = 'other';
      if (mutation === 'missing-proof') delete state.autonomy.activities[0].sourceFingerprint;
    }, { authorize: yes });
    assert.equal(f.engine.preview().eligible, false, 'another valid topic does not authorize this stale candidate');
    assert.equal(f.engine.preview().reasonCode, 'CANDIDATE_INVALID');
    await f.due();
    const result = f.engine.snapshot();
    assert.equal(f.calls.length, 0, mutation); assert.equal(f.sent.length, 0, mutation);
    assert.equal(result.activities.length, 1); assert.equal(result.activities[0].id, candidate.id);
    assert.equal(result.activities[0].status, 'skipped'); assert.equal(result.activities[0].topic, '');
    assert.match(result.activities[0].reason, /来源记忆/); assert.ok(result.nextAt > f.clock.value);
    await f.engine.tick(); assert.equal(f.engine.snapshot().activities.length, 1, 'no immediate replacement or replay');
  }
});

test('effective clarity excludes faded ordinary sources but preserves pinned and unfinished sources', async t => {
  const f = fixture(t); f.clock.value += 31 * 86400000;
  assert.equal(f.engine.preview().eligible, false);
  for (const action of ['pin', 'pending']) {
    f.memory.manage(action, { id: f.sourceId, value: true }, { scope, authorize: yes });
    assert.equal(f.engine.preview().eligible, true, action);
    assert.equal(f.engine.preview().sourceId, f.sourceId);
    f.memory.manage(action, { id: f.sourceId, value: false }, { scope, authorize: yes });
  }
  const g = fixture(t), candidate = await g.schedule();
  g.clock.value += 31 * 86400000;
  await g.engine.execute(candidate, new AbortController());
  assert.equal(g.calls.length, 0); assert.equal(g.engine.snapshot().activities[0].status, 'skipped');
});

test('source corrections and restores invalidate scheduled candidates even when the effective topic returns to its old text', async t => {
  for (const action of ['correct', 'forget', 'delete', 'restore']) {
    const f = fixture(t);
    if (action === 'restore') f.memory.manage('correct', { id: f.sourceId, detail: 'FICTIONAL_CORRECTED_SOURCE' }, { scope, authorize: yes });
    const candidate = await f.schedule();
    f.memory.manage(action, { id: f.sourceId, ...(action === 'correct' ? { detail: 'FICTIONAL_CORRECTION' } : {}) }, { scope, authorize: yes });
    await f.due();
    assert.equal(f.calls.length, 0, action); assert.equal(f.sent.length, 0, action);
    assert.equal(f.engine.snapshot().activities.find(row => row.id === candidate.id).status, 'skipped', action);
  }
});

test('a source revoked while the runner waits loses authorization and late output cannot send before cleanup completes', async t => {
  let enter, resume, modelCalls = 0, observedAuthorization;
  const entered = new Promise(resolve => { enter = resolve; }), waiting = new Promise(resolve => { resume = resolve; });
  const f = fixture(t, { run: async (_activity, { authorize }) => {
    assert.equal(authorize(), true); enter(); await waiting;
    observedAuthorization = authorize(); if (observedAuthorization) modelCalls++;
    return { status: 'succeeded', text: 'FICTIONAL_LATE_OUTPUT' };
  } });
  await f.schedule(); f.clock.value += 30 * 60000; const running = f.engine.tick(); await entered;
  f.memory.manage('correct', { id: f.sourceId, detail: 'FICTIONAL_CURRENT_SOURCE' }, { scope, authorize: yes });
  assert.equal(f.engine.snapshot().running, true, 'revocation does not release the live worker lease');
  await f.engine.tick(); assert.equal(f.calls.length, 1);
  resume(); await running;
  assert.equal(observedAuthorization, false); assert.equal(modelCalls, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.engine.snapshot().activities[0].status, 'cancelled'); assert.equal(f.engine.snapshot().running, false);
});

test('unknown execution and delivery proofs remain unchanged and cannot be dispatched directly or by tick', async t => {
  const f = fixture(t), candidate = await f.schedule();
  f.memory.store.update(state => {
    const row = state.autonomy.activities[0]; row.status = 'unknown'; row.delivery = 'unknown';
  }, { authorize: yes });
  const before = f.engine.snapshot().activities[0];
  await f.engine.execute(candidate, new AbortController()); f.clock.value += 30 * 60000; await f.engine.tick();
  assert.deepEqual(f.engine.snapshot().activities[0], before); assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});
