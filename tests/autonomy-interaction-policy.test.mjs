import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { AutonomyEngine, RECOMMENDATION_TOPIC } from '../packages/dsh-dafeiyu/src/autonomy-engine.js';
import { lifeOperation } from '../packages/dsh-dafeiyu/src/life-panel.js';

const yes = () => true, scope = { accountId: '20002', identityId: 'default' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-interaction-policy-'));
  const memory = new LifeMemory({ directory });
  const calls = [];
  const engine = new AutonomyEngine({ memory, scopes: () => [scope], run: async (...args) => calls.push(args), send: async () => calls.push('send') });
  const runtime = { lifeMemory: memory, autonomy: engine };
  t.after(async () => { await engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { memory, engine, calls, runtime, configure: patch => engine.configure(patch, { authorize: yes }) };
}
test('legacy interaction permissions project closed without rewriting policy or either allowance ledger', t => {
  const f = fixture(t);
  f.configure({ enabled: true, browse: true, platforms: ['douyin'], quietEnabled: false, targets: [scope] });
  f.memory.store.update(state => { delete state.autonomy.policy.douyinInteractions; }, { authorize: yes });
  const before = fs.readFileSync(f.memory.store.file);
  assert.deepEqual(f.engine.snapshot().policy.douyinInteractions, { like: false, follow: false, comment: false });
  f.engine.preview();
  assert.deepEqual(fs.readFileSync(f.memory.store.file), before);
  f.configure({ maxActivities: 5 });
  assert.equal(Object.hasOwn(f.memory.store.read().state.autonomy.policy, 'douyinInteractions'), false);
  assert.equal(f.calls.length, 0);
});
test('nested policy patches update independent permission bits and reject unknown fields and coercions atomically', t => {
  const f = fixture(t);
  f.configure({ douyinInteractions: { like: true } });
  f.configure({ douyinInteractions: { follow: true } });
  assert.deepEqual(f.engine.snapshot().policy.douyinInteractions, { like: true, follow: true, comment: false });
  f.configure({ douyinInteractions: { like: false, comment: true } });
  assert.deepEqual(f.engine.snapshot().policy.douyinInteractions, { like: false, follow: true, comment: true });
  const before = fs.readFileSync(f.memory.store.file);
  for (const malformed of [null, true, [], 'true', { like: 1 }, { follow: 'true' }, { comment: null }, { message: true }, { like: true, reply: true }]) {
    assert.throws(() => f.configure({ douyinInteractions: malformed }), { code: 'INVALID_PATCH' });
    assert.deepEqual(fs.readFileSync(f.memory.store.file), before);
  }
  const projected = f.engine.snapshot(); projected.policy.douyinInteractions.follow = false;
  assert.equal(f.engine.snapshot().policy.douyinInteractions.follow, true);
  assert.equal(f.engine.snapshot().policy.enabled, false, 'saving a permission never enables autonomy');
  assert.equal(f.engine.snapshot().policy.browse, false);
  assert.equal(f.calls.length, 0);
});
test('interaction permissions use the owner life facade and CAS without touching other saved policies', async t => {
  const f = fixture(t), getRuntime = () => f.runtime;
  f.configure({ proactive: true, greetingEnabled: false, quietEnabled: false, targets: [scope] });
  const saved = f.engine.snapshot(), revision = saved.revision, before = fs.readFileSync(f.memory.store.file);
  const body = { revision, patch: { douyinInteractions: { comment: true } } };
  await assert.rejects(lifeOperation(getRuntime, 'autonomy-policy', body), { code: 'FORBIDDEN' });
  assert.deepEqual(fs.readFileSync(f.memory.store.file), before);
  await lifeOperation(getRuntime, 'autonomy-policy', body, { authorize: yes });
  assert.deepEqual(f.engine.snapshot().policy, { ...saved.policy, douyinInteractions: { like: false, follow: false, comment: true } });
  const { revision: oldRevision, ...oldWallet } = saved.wallet;
  const { revision: newRevision, ...newWallet } = f.engine.snapshot().wallet;
  assert.notEqual(oldRevision, newRevision, 'the shared CAS changes when policy is saved');
  assert.deepEqual(newWallet, oldWallet);
  const committed = fs.readFileSync(f.memory.store.file);
  await assert.rejects(lifeOperation(getRuntime, 'autonomy-policy', { ...body, patch: { douyinInteractions: { like: true } } }, { authorize: yes }), { code: 'CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.memory.store.file), committed);
  assert.equal(f.calls.length, 0);
});
test('revoking any enabled interaction aborts the current Douyin activity while an upgrade never restarts it', t => {
  const f = fixture(t);
  f.configure({ enabled: true, browse: true, platforms: ['douyin'], quietEnabled: false, targets: [scope], douyinInteractions: { like: true, comment: true } });
  const activity = { id: 'auto-00112233-4455-4677-8899-001122334455', scope, kind: 'browse', platform: 'douyin', origin: 'recommendation', topic: RECOMMENDATION_TOPIC, status: 'running' };
  f.memory.store.update(state => state.autonomy.activities.push(activity), { authorize: yes });
  const controller = new AbortController(); f.engine.active = { id: activity.id, controller };
  assert.equal(f.engine.permitted(activity), true);
  f.configure({ douyinInteractions: { follow: true } });
  assert.equal(controller.signal.aborted, false);
  f.configure({ douyinInteractions: { like: false } });
  assert.equal(controller.signal.aborted, true);
  assert.equal(f.engine.snapshot().policy.browse, true);
  assert.equal(f.engine.snapshot().policy.enabled, true);
  assert.equal(f.engine.snapshot().activities[0].status, 'running', 'revoke requests cancellation, without inventing a stopped or successful receipt');
  f.configure({ douyinInteractions: { like: true } });
  assert.equal(controller.signal.aborted, true);
  assert.equal(f.calls.length, 0);
  f.engine.active = null;
});
test('malformed persisted interaction grants stop store access rather than silently granting or repairing them', t => {
  const f = fixture(t); f.configure({ douyinInteractions: { like: true } });
  const state = JSON.parse(fs.readFileSync(f.memory.store.file, 'utf8'));
  for (const malformed of [{ like: true }, { like: true, follow: false, comment: 'true' }, { like: true, follow: false, comment: false, message: true }]) {
    state.autonomy.policy.douyinInteractions = malformed;
    const bytes = JSON.stringify(state); fs.writeFileSync(f.memory.store.file, bytes);
    assert.throws(() => f.engine.snapshot(), { code: 'STORAGE' });
    assert.equal(fs.readFileSync(f.memory.store.file, 'utf8'), bytes);
  }
  // Disposal must see a valid store, without changing the tested failure behavior.
  state.autonomy.policy.douyinInteractions = { like: false, follow: false, comment: false };
  fs.writeFileSync(f.memory.store.file, JSON.stringify(state));
});
test('an unknown interaction dominates cancellation and cannot be replayed after the activity or engine reload', async t => {
  for (const abort of [false, true]) {
    const f = fixture(t), controller = new AbortController();
    f.configure({ enabled: true, browse: true, platforms: ['douyin'], quietEnabled: false, targets: [scope], douyinInteractions: { comment: true } });
    f.engine.wallet.configure({ enabled: true, dailySeconds: 600, monthlySeconds: 0 }, { authorize: yes });
    const activity = { id: 'auto-00112233-4455-4677-8899-001122334455', scope, kind: 'browse', platform: 'douyin', origin: 'recommendation', topic: RECOMMENDATION_TOPIC, status: 'running' };
    f.memory.store.update(state => state.autonomy.activities.push(activity), { authorize: yes });
    f.engine.run = async () => { f.calls.push('interaction'); if (abort) controller.abort(); throw Object.assign(new Error('FIXTURE_UNKNOWN_INTERACTION'), { code: 'INTERACTION_UNCONFIRMED' }); };
    await f.engine.execute(activity, controller);
    assert.equal(f.engine.snapshot().activities[0].status, 'unknown');
    assert.equal(f.engine.preview().reasonCode, 'UNKNOWN_ACTIVITY');
    const proof = structuredClone(f.engine.snapshot().activities[0]);
    await f.engine.execute(activity, new AbortController());
    const reloaded = new AutonomyEngine({ memory: f.memory, scopes: () => [scope], run: async () => f.calls.push('replay'), send: async () => {} });
    try { await reloaded.tick(); await reloaded.execute(activity, new AbortController()); }
    finally { await reloaded.dispose(); }
    assert.deepEqual(f.engine.snapshot().activities[0], proof);
    assert.deepEqual(f.calls, ['interaction']);
  }
});
