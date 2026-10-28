import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectAutonomyBrowseEvidence } from '../packages/dsh-dafeiyu/src/autonomy-runner.js';
import { AutonomyEngine } from '../packages/dsh-dafeiyu/src/autonomy-engine.js';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { lifeOperation } from '../packages/dsh-dafeiyu/src/life-panel.js';
const yes = () => true, scope = { accountId: '200', identityId: 'default' };
const step = (sequence = 1) => ({ sequence, source: 'model-tool', action: 'open', accountMatches: true, generation: 3, generationMatches: true,
  muted: true, paused: true, videoIdHash: 'a'.repeat(64), previousVideoIdHash: null, expectedObservationMatches: null, stableVideoChanged: null });
const evidence = (activityId, steps = [step()]) => ({ version: 1, activityId, platform: 'douyin', steps });
function fixture(t, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-audit-'));
  let now = Date.parse('2026-10-27T04:00:00Z');
  const memory = new LifeMemory({ directory, now: () => now }), sends = [], calls = [];
  const engine = new AutonomyEngine({ memory, now: () => now, random: () => 0, scopes: () => [scope],
    browseReady: platform => platform === 'douyin', run: async (...args) => { calls.push(args); return run ? run(...args) : { status: 'succeeded', text: 'actual web observation' }; },
    send: async value => { sends.push(value); return { ok: true }; } });
  engine.configure({ enabled: true, browse: true, proactive: true, platforms: ['douyin'], targets: [scope], quietEnabled: false }, { authorize: yes });
  engine.wallet.configure({ enabled: true, dailySeconds: 600, monthlySeconds: 0 }, { authorize: yes });
  t.after(async () => { await engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const runtime = { lifeMemory: memory, autonomy: engine };
  return { memory, engine, runtime, sends, calls, setNow(value) { now = value; }, advance(ms) { now += ms; },
    run() { return lifeOperation(() => runtime, 'autonomy-browse-now', { revision: memory.snapshot().revision }, { authorize: yes }); } };
}
test('evidence parser admits only bounded typed successful receipt projections for the exact activity', () => {
  const id = 'auto-12345678-1234-4234-8234-123456789012', valid = evidence(id);
  assert.deepEqual(projectAutonomyBrowseEvidence(valid, id), valid);
  for (const candidate of [ { ...valid, activityId: 'auto-99999999-1234-4234-8234-123456789012' }, { ...valid, secret: 'body' },
    { ...valid, steps: Array.from({ length: 11 }, (_, i) => step(i + 1)) }, { ...valid, steps: [{ ...step(), source: 'assistant-text' }] },
    { ...valid, steps: [{ ...step(), source: 'executor-cleanup' }] }, { ...valid, steps: [{ ...step(), caption: 'private page' }] },
    { ...valid, steps: [{ ...step(), accountMatches: false }] }, { ...valid, steps: [{ ...step(), generation: '3' }] },
    { ...valid, steps: [{ ...step(), videoIdHash: 'raw-video-id' }] }, { ...valid, steps: [{ ...step(), muted: false }] } ])
    assert.throws(() => projectAutonomyBrowseEvidence(candidate, id), { code: 'EVIDENCE_UNCONFIRMED' });
});
test('trusted step evidence survives ephemeral runner disposal and is bound to the stored activity scope', async t => {
  let f; f = fixture(t, async (activity, options) => {
    const first = evidence(activity.id); options.onEvidence(first);
    const stored = f.engine.snapshot().activities.find(row => row.id === activity.id);
    assert.deepEqual(stored.scope, scope); assert.deepEqual(stored.browseEvidence, first);
    return { status: 'succeeded', text: 'actual web observation', browseEvidence: first };
  });
  const result = await f.run(), row = result.autonomy.activities.at(-1);
  assert.equal(row.status, 'completed'); assert.equal(row.browseEvidence.steps.length, 1); assert.deepEqual(row.scope, scope); assert.equal(f.sends.length, 0);
  assert.equal(f.engine.snapshot().activities.at(-1).browseEvidence.activityId, row.id);
});
test('unknown and failed runs preserve prior evidence, while assistant text cannot submit evidence', async t => {
  for (const status of ['unknown', 'failed']) {
    const f = fixture(t, async (activity, options) => { options.onEvidence(evidence(activity.id)); return { status, text: '' }; });
    const result = await f.run(); assert.equal(result.autonomy.activities.at(-1).status, status); assert.equal(result.autonomy.activities.at(-1).browseEvidence.steps.length, 1);
  }
  const textOnly = fixture(t, async () => ({ status: 'succeeded', text: JSON.stringify({ browseEvidence: 'forged model content' }) }));
  const row = (await textOnly.run()).autonomy.activities.at(-1); assert.equal(Object.hasOwn(row, 'browseEvidence'), false);
});
test('wrong activity, extra fields and rewriting a persisted prefix cannot become completed evidence', async t => {
  for (const kind of ['wrong-activity', 'raw-body', 'rewrite']) {
    const f = fixture(t, async (activity, options) => {
      options.onEvidence(evidence(activity.id));
      const value = evidence(activity.id);
      if (kind === 'wrong-activity') value.activityId = 'auto-99999999-1234-4234-8234-123456789012';
      if (kind === 'raw-body') value.steps[0].pageText = 'private';
      if (kind === 'rewrite') value.steps[0].videoIdHash = 'b'.repeat(64);
      return { status: 'succeeded', text: 'must not complete', browseEvidence: value };
    });
    const row = (await f.run()).autonomy.activities.at(-1); assert.equal(row.status, 'unknown'); assert.equal(row.browseEvidence.steps[0].videoIdHash, 'a'.repeat(64));
  }
});
test('fixed owner browse action selects a fresh browse activity despite an available proactive chat motive and preserves policy', async t => {
  const f = fixture(t);
  f.memory.configure({ learningEnabled: true }, { authorize: yes });
  f.memory.capture({ phase: 'received', selfId: '100', messageId: '1', userText: '真实已有话题', scope }, { authorize: yes });
  assert.equal(f.engine.preview().kind, 'chat'); const policy = f.engine.snapshot().policy;
  const row = (await f.run()).autonomy.activities.at(-1);
  assert.equal(row.kind, 'browse'); assert.equal(row.platform, 'douyin'); assert.equal(row.origin, 'memory'); assert.ok(row.sourceId);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0].kind, 'browse'); assert.equal(f.sends.length, 0); assert.deepEqual(f.engine.snapshot().policy, policy);
  await assert.rejects(lifeOperation(() => f.runtime, 'autonomy-browse-now', { revision: f.memory.snapshot().revision, kind: 'chat' }, { authorize: yes }), { code: 'INVALID_PATCH' });
});
test('fixed browse action retains quiet, disabled, wallet, unknown and scheduled gates and cannot opt in another platform', async t => {
  for (const kind of ['quiet', 'disabled', 'wallet', 'unknown', 'scheduled', 'platform']) {
    const f = fixture(t);
    if (kind === 'quiet') f.engine.configure({ quietEnabled: true, quietStart: 11, quietEnd: 13 }, { authorize: yes });
    if (kind === 'disabled') f.engine.configure({ browse: false }, { authorize: yes });
    if (kind === 'wallet') f.engine.wallet.configure({ enabled: false }, { authorize: yes });
    if (kind === 'platform') f.engine.configure({ platforms: ['bilibili'] }, { authorize: yes });
    if (['unknown', 'scheduled'].includes(kind)) { await f.engine.tick(); if (kind === 'unknown') f.memory.store.update(s => s.autonomy.activities[0].status = 'unknown', { authorize: yes }); }
    await assert.rejects(f.run()); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  }
});
test('stop waiting is not billed as observed entertainment time and leaves all allowance policy untouched', async t => {
  let f; f = fixture(t, async (_activity, options) => { options.onUsage('playing'); f.advance(3000); options.onUsage('paused'); f.advance(5000); return { status: 'succeeded', text: 'actual observation' }; });
  const policy = f.engine.wallet.snapshot().policy; await f.run();
  const wallet = f.engine.wallet.snapshot(); assert.equal(wallet.sessions.at(-1).charged, 3); assert.equal(wallet.sessions.at(-1).status, 'finished'); assert.deepEqual(wallet.policy, policy);
});

test('a fixed browse check never accelerates an already scheduled chat or relaxes its memory source', async t => {
  let f; f = fixture(t, async (activity, options) => {
    assert.equal(f.engine.sourceCurrent(activity), true);
    f.memory.store.update(state => { state.memories.find(row => row.id === activity.sourceId).summary = 'source changed'; }, { authorize: yes });
    assert.equal(f.engine.sourceCurrent(activity), false); assert.equal(options.authorize(), false);
    return { status: 'succeeded', text: 'stale result must not complete' };
  });
  f.memory.configure({ learningEnabled: true }, { authorize: yes });
  f.memory.capture({ phase: 'received', selfId: '100', messageId: '1', userText: '已有真实话题', scope }, { authorize: yes });
  const first = (await f.run()).autonomy.activities.at(-1); assert.equal(first.status, 'cancelled'); assert.equal(f.sends.length, 0);
  f.engine.run = async () => assert.fail('a scheduled chat is never accelerated');
  f.memory.store.update(state => { state.autonomy.nextAt = null; }, { authorize: yes });
  await f.engine.tick(); const scheduled = f.engine.snapshot().activities.find(row => row.status === 'scheduled'); assert.equal(scheduled.kind, 'chat');
  const before = fs.readFileSync(f.memory.store.file); await assert.rejects(f.run(), { code: 'SCHEDULED_EXISTS' });
  assert.deepEqual(fs.readFileSync(f.memory.store.file), before);
});

test('a failed pause checkpoint freezes prior charges and never catches up unobserved cleanup time', async t => {
  let f, callsAfterFault = 0;
  f = fixture(t, async (_activity, options) => {
    options.onUsage('playing'); f.advance(1000); options.onUsage('playing');
    const original = f.engine.wallet.meter.bind(f.engine.wallet); let fault = false;
    f.engine.wallet.meter = (...args) => { if (!fault && args[1] === 'paused') { fault = true; throw Error('one failed storage checkpoint'); } if (fault) callsAfterFault++; return original(...args); };
    f.advance(2000); assert.throws(() => options.onUsage('paused'), { code: 'TIME_ACCOUNTING_UNCONFIRMED' });
    f.advance(2000); assert.throws(() => options.onUsage('paused'), { code: 'TIME_ACCOUNTING_UNCONFIRMED' });
    return { status: 'unknown', text: '' };
  });
  const result = await f.run(), wallet = f.engine.wallet.snapshot();
  assert.equal(result.autonomy.activities.at(-1).status, 'unknown'); assert.equal(wallet.sessions.at(-1).status, 'unknown'); assert.equal(wallet.sessions.at(-1).mode, 'paused');
  assert.equal(wallet.sessions.at(-1).charged, 1, 'preserve only the last confirmed checkpoint'); assert.equal(callsAfterFault, 0);
  assert.equal(wallet.transactions.some(row => row.kind === 'spend'), false);
});
test('waiting and final checkpoint failures also preserve unknown time without a normal billing finish', async t => {
  for (const failAt of ['waiting', 'finish']) {
    let f, normalCalls = 0;
    f = fixture(t, async (_activity, options) => {
      options.onUsage('playing'); f.advance(1000); options.onUsage('playing');
      const original = f.engine.wallet.meter.bind(f.engine.wallet);
      f.engine.wallet.meter = (...args) => { if (args[1] === failAt || failAt === 'finish' && args[2]?.finish) { normalCalls++; throw Error('fixture checkpoint failure'); } return original(...args); };
      if (failAt === 'waiting') { f.advance(1000); assert.throws(() => options.onUsage('waiting'), { code: 'TIME_ACCOUNTING_UNCONFIRMED' }); f.advance(2000); }
      else f.advance(2000);
      return { status: 'succeeded', text: 'actual observation' };
    });
    const result = await f.run(), session = f.engine.wallet.snapshot().sessions.at(-1);
    assert.equal(result.autonomy.activities.at(-1).status, 'unknown'); assert.equal(session.status, 'unknown'); assert.equal(session.charged, 1); assert.equal(normalCalls, 1);
  }
});

test('an interval checkpoint failure is sticky and cannot bill later cleanup', async t => {
  let f, faultCalls = 0;
  f = fixture(t, async (_activity, options) => {
    options.onUsage('playing'); f.advance(1000); options.onUsage('playing');
    f.engine.wallet.meter = () => { faultCalls++; throw Error('fixture interval write failure'); };
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('expected the live interval to abort')), 2500);
      options.signal.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    f.advance(2000); return { status: 'cancelled', text: '' };
  });
  const row = (await f.run()).autonomy.activities.at(-1), session = f.engine.wallet.snapshot().sessions.at(-1);
  assert.equal(faultCalls, 1); assert.equal(row.status, 'unknown'); assert.equal(session.status, 'unknown'); assert.equal(session.charged, 1);
});
test('failed unknown-time persistence remains protected and restart recovers a still-running wallet without accruing time', async t => {
  let f; f = fixture(t, async (_activity, options) => {
    options.onUsage('playing'); f.advance(1000); options.onUsage('playing');
    f.engine.wallet.meter = () => { throw Error('fixture checkpoint failure'); };
    f.engine.wallet.recover = () => { throw Error('fixture recovery write failure'); };
    assert.throws(() => options.onUsage('paused'), { code: 'TIME_ACCOUNTING_UNCONFIRMED' }); f.advance(2000);
    return { status: 'unknown', text: '' };
  });
  assert.equal((await f.run()).autonomy.activities.at(-1).status, 'unknown');
  const before = f.engine.wallet.snapshot(); assert.equal(before.sessions.at(-1).status, 'running'); assert.equal(before.sessions.at(-1).charged, 1);
  const restarted = new AutonomyEngine({ memory: f.memory, scopes: () => [scope], now: () => Date.parse('2026-10-27T05:00:00Z'),
    run: () => assert.fail('restart must not execute an unknown activity'), send: () => assert.fail('must not send') });
  restarted.start(); const after = restarted.wallet.snapshot();
  assert.equal(after.sessions.at(-1).status, 'unknown'); assert.equal(after.sessions.at(-1).mode, 'paused'); assert.equal(after.sessions.at(-1).charged, 1);
  assert.deepEqual(after.policy, before.policy); assert.equal(after.balance, before.balance); await restarted.dispose();
});
