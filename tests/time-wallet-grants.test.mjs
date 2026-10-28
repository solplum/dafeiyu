import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeStore } from '../packages/dsh-dafeiyu/src/life-store.js';
import { TimeWallet } from '../packages/dsh-dafeiyu/src/time-wallet.js';

const auth = { authorize: () => true }, requestId = '00112233-4455-4677-8899-001122334455';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'time-wallet-grants-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clock = { value: Date.parse('2026-10-26T00:00:00Z') }, store = new LifeStore({ directory });
  const wallet = new TimeWallet({ store, now: () => clock.value });
  wallet.configure({ enabled: true, dailySeconds: 1800, monthlySeconds: 18000 }, auth);
  const restart = () => new TimeWallet({ store: new LifeStore({ directory }), now: () => clock.value });
  const persisted = () => store.read().state.wallet;
  return { directory, clock, store, wallet, restart, persisted };
}

test('same UUID and amount return the original grant proof without adding another transaction or changing bytes', t => {
  const f = fixture(t), before = f.persisted(), first = f.wallet.add({ requestId, seconds: 60 }, auth);
  assert.deepEqual(first.result, { added: 60, requestId });
  const bytes = fs.readFileSync(f.store.file), repeated = f.wallet.add({ requestId, seconds: 60 }, auth);
  assert.deepEqual(repeated.result, { duplicate: true, added: 60, requestId });
  assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  const value = f.persisted(); assert.equal(value.balance, before.balance + 60);
  assert.equal(value.transactions.filter(row => row.id === 'bonus:' + requestId).length, 1);
  assert.deepEqual(value.policy, before.policy);
});

test('same UUID with a different amount is an atomic conflict and cannot masquerade as a successful second amount', t => {
  const f = fixture(t); f.wallet.add({ requestId, seconds: 60 }, auth);
  const bytes = fs.readFileSync(f.store.file), revision = f.store.read().revision;
  assert.throws(() => f.wallet.add({ requestId, seconds: 120 }, { ...auth, revision }), { code: 'CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.store.file), bytes); assert.equal(f.store.read().revision, revision);
  assert.equal(f.persisted().transactions.find(row => row.id === 'bonus:' + requestId).seconds, 60);
});

test('grant UUID and amount bindings survive a new wallet and store instance', t => {
  const f = fixture(t); f.wallet.add({ requestId, seconds: 420 }, auth);
  const reloaded = f.restart(), bytes = fs.readFileSync(f.store.file);
  assert.deepEqual(reloaded.add({ requestId, seconds: 420 }, auth).result, { duplicate: true, added: 420, requestId });
  assert.throws(() => reloaded.add({ requestId, seconds: 421 }, auth), { code: 'CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  assert.equal(f.persisted().balance, 18420);
});

test('concurrent submissions from two wallet instances share one atomic same-amount grant', async t => {
  const f = fixture(t), other = f.restart();
  const results = await Promise.all([
    Promise.resolve().then(() => f.wallet.add({ requestId, seconds: 300 }, auth)),
    Promise.resolve().then(() => other.add({ requestId, seconds: 300 }, auth)),
  ]);
  assert.equal(results.filter(value => value.result.duplicate === true).length, 1);
  assert.ok(results.every(value => value.result.added === 300 && value.result.requestId === requestId));
  assert.equal(f.persisted().balance, 18300);
  assert.equal(f.persisted().transactions.filter(row => row.kind === 'bonus').length, 1);
});

test('concurrent different amounts cannot share a grant UUID or partially apply the losing request', async t => {
  const f = fixture(t), other = f.restart();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => f.wallet.add({ requestId, seconds: 60 }, auth)),
    Promise.resolve().then(() => other.add({ requestId, seconds: 120 }, auth)),
  ]);
  const accepted = results.filter(value => value.status === 'fulfilled'), rejected = results.filter(value => value.status === 'rejected');
  assert.equal(accepted.length, 1); assert.equal(rejected.length, 1); assert.equal(rejected[0].reason.code, 'CONFLICT');
  const proof = accepted[0].value.result;
  assert.equal(f.persisted().balance, 18000 + proof.added);
  assert.deepEqual(f.persisted().transactions.filter(row => row.kind === 'bonus'), [{ id: 'bonus:' + requestId, kind: 'bonus', seconds: proof.added }]);
});

test('an occupied shared writer lock rejects a grant without changing money or consuming its UUID', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.store.file);
  fs.mkdirSync(f.store.lock);
  try { assert.throws(() => f.restart().add({ requestId, seconds: 180 }, auth), { code: 'BUSY' }); }
  finally { fs.rmdirSync(f.store.lock); }
  assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  assert.deepEqual(f.wallet.add({ requestId, seconds: 180 }, auth).result, { added: 180, requestId });
  assert.equal(f.persisted().transactions.filter(row => row.kind === 'bonus').length, 1);
});

test('checking an already committed grant in a later month does not mint an unrelated monthly transaction', t => {
  const f = fixture(t); f.wallet.add({ requestId, seconds: 60 }, auth);
  f.clock.value = Date.parse('2026-11-02T00:00:00Z');
  const bytes = fs.readFileSync(f.store.file);
  assert.deepEqual(f.wallet.add({ requestId, seconds: 60 }, auth).result, { duplicate: true, added: 60, requestId });
  assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  assert.equal(f.persisted().transactions.filter(row => row.kind === 'monthly').length, 1);
});
