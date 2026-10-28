import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { AutonomyEngine } from '../packages/dsh-dafeiyu/src/autonomy-engine.js';
import { lifeOperation } from '../packages/dsh-dafeiyu/src/life-panel.js';
const yes = () => true, scope = { accountId: '20002', identityId: 'default' };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'time-autonomy-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clock = { value: Date.parse('2026-10-24T10:00:00Z') }, memory = new LifeMemory({ directory, now: () => clock.value });
  const sent = [], calls = []; let busy = false;
  const engine = new AutonomyEngine({ memory, now: () => clock.value, random: () => 0, scopes: () => [scope], isBusy: () => busy,
    tokenBudget: options.tokenBudget,
    run: async (...args) => { calls.push(args); return options.run ? options.run(...args) : { status: 'succeeded', text: '面试结果怎么样了？' }; },
    send: async (...args) => { sent.push(args); return options.send ? options.send(...args) : { ok: true }; } });
  t.after(() => engine.dispose());
  const enable = (patch = {}) => {
    memory.configure({ learningEnabled: true }, { authorize: yes });
    memory.capture({ phase: 'received', messageId: '1', selfId: '10001', scope, userText: '最近在学习摄影' }, { authorize: yes });
    engine.configure({ enabled: true, proactive: true, targets: [scope], ...patch }, { authorize: yes });
  };
  return { directory, clock, memory, engine, wallet: engine.wallet, enable, sent, calls, setBusy: (value) => { busy = value; } };
}
test('daily base resets, monthly wallet carries, bonus and monthly grants are idempotent across restart', (t) => {
  const f = fixture(t); f.wallet.configure({ enabled: true, dailySeconds: 2, monthlySeconds: 5 }, { authorize: yes });
  f.wallet.start('session-123', { maxSeconds: 20, authorize: yes }); f.wallet.meter('session-123', 'playing', { authorize: yes });
  for (let i = 0; i < 4; i++) { f.clock.value += 1000; f.wallet.meter('session-123', 'playing', { authorize: yes }); }
  f.wallet.meter('session-123', 'paused', { authorize: yes, finish: true });
  assert.equal(f.wallet.snapshot().balance, 3); assert.equal(f.wallet.snapshot().dailyRemainingSeconds, 0);
  f.clock.value += 86400000; assert.equal(f.wallet.snapshot().dailyRemainingSeconds, 2); assert.equal(f.wallet.snapshot().balance, 3);
  f.clock.value = Date.parse('2026-11-01T10:00:00Z'); assert.equal(f.wallet.snapshot().balance, 8);
  f.wallet.add({ requestId: 'bonus-request-123', seconds: 2 }, { authorize: yes });
  f.wallet.add({ requestId: 'bonus-request-123', seconds: 2 }, { authorize: yes });
  assert.equal(f.wallet.snapshot().balance, 10); assert.equal(f.wallet.snapshot().transactions.filter((row) => row.kind === 'monthly').length, 2);
  f.wallet.recover({ authorize: yes }); assert.equal(f.wallet.snapshot().balance, 10);
});
test('waiting, paused and failed startup cost no time; parallel platforms and depleted balances cannot overspend', (t) => {
  const f = fixture(t); f.wallet.configure({ enabled: true, dailySeconds: 0, monthlySeconds: 2 }, { authorize: yes });
  f.wallet.start('session-123', { maxSeconds: 20, authorize: yes }); f.clock.value += 100000;
  f.wallet.meter('session-123', 'waiting', { authorize: yes }); assert.equal(f.wallet.snapshot().balance, 2);
  assert.throws(() => f.wallet.start('session-456', { maxSeconds: 2, authorize: yes }), { code: 'BUSY' });
  f.wallet.meter('session-123', 'playing', { authorize: yes }); f.clock.value += 2000;
  assert.equal(f.wallet.meter('session-123', 'playing', { authorize: yes }).result.exhausted, true);
  assert.equal(f.wallet.snapshot().balance, 0); assert.throws(() => f.wallet.start('session-789', { maxSeconds: 2, authorize: yes }), { code: 'LIMIT' });
});

test('midnight splits daily usage and a sleeping process does not bill unobserved offline time', (t) => {
  const f = fixture(t); f.clock.value = Date.parse('2026-10-24T15:59:58Z');
  f.wallet.configure({ enabled: true, dailySeconds: 2, monthlySeconds: 10 }, { authorize: yes });
  f.wallet.start('midnight-123', { maxSeconds: 10, authorize: yes }); f.wallet.meter('midnight-123', 'playing', { authorize: yes });
  f.clock.value += 4000; f.wallet.meter('midnight-123', 'playing', { authorize: yes });
  assert.equal(f.wallet.snapshot().balance, 10); assert.equal(f.wallet.snapshot().days['2026-10-24'], 2); assert.equal(f.wallet.snapshot().days['2026-10-25'], 2);
  f.clock.value += 3600000; f.wallet.meter('midnight-123', 'playing', { authorize: yes });
  assert.equal(f.wallet.snapshot().balance, 10); assert.equal(f.wallet.snapshot().sessions[0].charged, 4);
});
test('snapshot and preview do not schedule or execute; random candidate survives until due and sends only once', async (t) => {
  const f = fixture(t); f.enable(); const revision = f.memory.snapshot().revision;
  f.engine.snapshot(); f.engine.preview(); assert.equal(f.memory.snapshot().revision, revision); assert.equal(f.calls.length, 0);
  await f.engine.tick(); const scheduled = f.engine.snapshot().activities[0]; assert.equal(scheduled.dueAt, f.clock.value + 30 * 60000);
  await f.engine.tick(); assert.equal(f.calls.length, 0);
  f.clock.value += 30 * 60000; await f.engine.tick(); await f.engine.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1); assert.equal(f.engine.snapshot().activities[0].delivery, 'sent');
  assert.equal(f.engine.preview().eligible, false, 'unanswered proactive message is not followed up');
});
test('quiet hours, busy state and disabled/unbound scopes prevent autonomous work', async (t) => {
  const f = fixture(t); f.enable(); f.clock.value = Date.parse('2026-10-24T16:00:00Z');
  assert.match(f.engine.preview().reason, /免打扰/); await f.engine.tick(); assert.equal(f.calls.length, 0);
  f.clock.value += 10 * 3600000; f.setBusy(true); assert.match(f.engine.preview().reason, /用户任务/);
  assert.throws(() => f.engine.configure({ targets: [{ accountId: '30003', identityId: 'default' }] }, { authorize: yes }), { code: 'INVALID_PATCH' });
});
test('unknown send never retries or regenerates across ticks; acknowledgement does not resend', async (t) => {
  const f = fixture(t, { send: async () => { throw new Error('uncertain delivery'); } }); f.enable();
  await f.engine.tick(); f.clock.value += 30 * 60000; await f.engine.tick();
  assert.equal(f.engine.snapshot().activities[0].status, 'unknown');
  f.clock.value += 86400000; await f.engine.tick(); await f.engine.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.calls.length, 1);
});
test('new chat aborts background browsing and keeps its lease until the worker cleanup settles', async (t) => {
  let settle, observedAbort = false;
  const f = fixture(t, { run: (_activity, { signal, onUsage }) => {
    onUsage('playing'); signal.addEventListener('abort', () => { observedAbort = true; });
    return new Promise((resolve) => { settle = resolve; });
  } });
  f.enable({ proactive: false, browse: true, platforms: ['bilibili'] }); f.wallet.configure({ enabled: true, dailySeconds: 10, monthlySeconds: 0 }, { authorize: yes });
  await f.engine.tick(); f.clock.value += 30 * 60000; const running = f.engine.tick();
  await new Promise((resolve) => setImmediate(resolve));
  f.engine.userActivity(scope); assert.equal(observedAbort, true); assert.equal(f.engine.snapshot().running, true);
  await f.engine.tick(); assert.equal(f.calls.length, 1);
  settle({ status: 'succeeded', text: 'late result' }); await running;
  assert.equal(f.engine.snapshot().activities[0].status, 'cancelled'); assert.equal(f.sent.length, 0);
});
test('restart marks running work unknown without playing or billing offline time', (t) => {
  const f = fixture(t); f.enable({ proactive: false, browse: true, platforms: ['bilibili'] });
  f.wallet.configure({ enabled: true, dailySeconds: 10, monthlySeconds: 0 }, { authorize: yes });
  f.wallet.start('old-task-123', { maxSeconds: 10, authorize: yes });
  f.memory.store.update((state) => state.autonomy.activities.push({ id: 'old-task-123', kind: 'browse', scope, platform: 'bilibili', status: 'running', createdAt: new Date(f.clock.value).toISOString(), delivery: 'none' }), { authorize: yes });
  f.clock.value += 86400000; f.engine.start();
  assert.equal(f.engine.snapshot().activities[0].status, 'unknown'); assert.equal(f.wallet.snapshot().sessions[0].status, 'unknown');
  assert.equal(f.wallet.snapshot().sessions[0].charged, 0); assert.equal(f.calls.length, 0);
});
test('owner life facade fences stale instances, revocation and arbitrary fields, and all reads are non-mutating', async (t) => {
  const f = fixture(t), runtime = { lifeMemory: f.memory, autonomy: f.engine }; let current = runtime;
  const initial = await lifeOperation(() => current, 'snapshot', {}, { authorize: yes });
  assert.equal(fs.existsSync(f.memory.store.file), false);
  await assert.rejects(lifeOperation(() => current, 'memory-policy', { revision: initial.memory.revision, patch: { learningEnabled: true } }, { authorize: () => false }), { code: 'FORBIDDEN' });
  current = {}; await assert.rejects(lifeOperation(() => current, 'cancel', {}, { authorize: yes, runtime }), { code: 'FORBIDDEN' });
  current = runtime;
  await assert.rejects(lifeOperation(() => current, 'wallet-policy', { revision: initial.memory.revision, patch: { path: '/private' } }, { authorize: yes }), { code: 'INVALID_PATCH' });
});
test('autonomous preview rejects disabled, unmetered, overdrawn and insufficient token allowances without executing', async t => {
  const healthy = { policy: { enabled: true, requestReserveTokens: 100 }, availableTokens: 1000, pendingUnknownCount: 0, overdrawnTokens: 0 };
  for (const [patch, expected] of [[{ policy: { enabled: false } }, /尚未开启/], [{ pendingUnknownCount: 1 }, /尚未核清/],
    [{ overdrawnTokens: 2 }, /已超出/], [{ availableTokens: 99 }, /不足/]]) {
    const f = fixture(t, { tokenBudget: { snapshot: () => ({ ...healthy, ...patch }) } }); f.enable();
    assert.equal(f.engine.preview().eligible, false); assert.match(f.engine.preview().reason, expected);
    await f.engine.tick(); assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  }
  const broken = fixture(t, { tokenBudget: { snapshot() { throw Error('PRIVATE_LEDGER_ERROR'); } } }); broken.enable();
  assert.match(broken.engine.preview().reason, /无法确认/); assert.equal(broken.engine.preview().reason.includes('PRIVATE'), false);
});
test('budget is checked again before activity execution and never starts or charges the separate time wallet', async t => {
  const token = { policy: { enabled: true, requestReserveTokens: 100 }, availableTokens: 1000, pendingUnknownCount: 0, overdrawnTokens: 0 };
  const f = fixture(t, { tokenBudget: { snapshot: () => token } });
  f.enable({ proactive: false, browse: true, platforms: ['bilibili'] });
  f.wallet.configure({ enabled: true, dailySeconds: 20, monthlySeconds: 0 }, { authorize: yes });
  await f.engine.tick(); const candidate = f.engine.snapshot().activities[0];
  token.availableTokens = 0;
  await f.engine.execute(candidate, new AbortController());
  assert.equal(f.calls.length, 0); assert.equal(f.wallet.snapshot().sessions.length, 0);
  assert.equal(f.engine.snapshot().activities[0].status, 'skipped');
  assert.match(f.engine.snapshot().activities[0].reason, /Token/);
});
test('new-month token admission uses the pure pending-grant projection before the first request persists it', t => {
  const f = fixture(t, { tokenBudget: { snapshot: () => ({ policy: { enabled: true, requestReserveTokens: 100 },
    availableTokens: 0, overdrawnTokens: 10, projectedAvailableTokens: 500, projectedOverdrawnTokens: 0, pendingUnknownCount: 0 }) } });
  f.enable(); assert.equal(f.engine.preview().eligible, true); assert.equal(f.calls.length, 0);
});
