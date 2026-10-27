import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BackgroundTaskManager } from '../packages/dsh-dafeiyu/src/background-tasks.js';

const scope = Object.freeze({ selfId: '10001', peerId: '20002', identityId: 'default' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) { const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'workspace fixture did not reach expected state'); await tick(); } }
const success = { status: 'succeeded', text: '离线目录任务完成' };

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-workspaces-')), storeFile = path.join(dir, 'journal.json');
  const paths = { a: path.join(dir, 'a'), b: path.join(dir, 'b'), prefix: path.join(dir, 'a-other') };
  for (const value of Object.values(paths)) fs.mkdirSync(value);
  paths.child = path.join(paths.a, 'child'); fs.mkdirSync(paths.child);
  paths.alias = path.join(dir, 'alias'); fs.symlinkSync(paths.a, paths.alias, 'dir');
  const runs = [], sends = [], availability = [], managers = [], authorized = { value: true }, available = options.available || {};
  const executors = Object.fromEntries(['native', 'codex', 'zcode', 'minimax'].map((name) => [name, {
    async available() { availability.push(name); return { available: available[name] !== false }; },
    async run(input) { const record = { name, input, gate: deferred(), cleanup: null }; runs.push(record);
      const result = await record.gate.promise; if (record.cleanup) await record.cleanup.promise; return result; },
  }]));
  const create = (patch = {}) => {
    const manager = new BackgroundTaskManager({ storeFile, defaultCwd: paths.a, executors,
      isAuthorized: () => authorized.value, async deliver(target, text) { sends.push({ target, text }); return { ok: true }; },
      ...options.manager, ...patch }); managers.push(manager); return manager;
  };
  const manager = create();
  t.after(async () => {
    const disposals = managers.reverse().map((item) => item.dispose());
    for (const record of runs) { record.gate.resolve({ status: 'cancelled' }); record.cleanup?.resolve(); }
    await Promise.allSettled(disposals); fs.rmSync(dir, { recursive: true, force: true });
  });
  const submit = (origin, patch = {}, target = manager) => target.submit({ scope, originId: String(origin), title: '离线工作区任务',
    prompt: '受控离线任务 ' + origin, executor: 'native', ...patch });
  return { dir, storeFile, paths, manager, create, runs, sends, availability, available, authorized, submit };
}

test('submission validates real directories, canonicalizes aliases and preserves one origin proof', async (t) => {
  const f = fixture(t), ordinaryFile = path.join(f.dir, 'file'); fs.writeFileSync(ordinaryFile, 'fixture');
  for (const cwd of [ordinaryFile, path.join(f.dir, 'missing'), 'relative/path', '/bad\0path'])
    await assert.rejects(f.submit(1, { cwd }), { code: 'INVALID_TASK' });
  assert.equal(f.runs.length, 0);
  const job = await f.submit(2, { cwd: f.paths.alias }); await until(() => f.runs.length === 1);
  const duplicate = await f.submit(2, { cwd: path.join(f.paths.a, 'child', '..') });
  assert.equal(duplicate.id, job.id); assert.equal(duplicate.duplicate, true); assert.equal(f.runs.length, 1);
  const canonical = fs.realpathSync(f.paths.a);
  assert.equal(f.runs[0].input.cwd, canonical);
  assert.equal(JSON.parse(fs.readFileSync(f.storeFile)).jobs[0].cwd, canonical);
});

test('same or ancestor workspaces serialize native and Codex until runner cleanup finishes while sibling prefixes run independently', async (t) => {
  const f = fixture(t);
  const first = await f.submit(10); await until(() => f.runs.length === 1);
  const child = await f.submit(11, { cwd: f.paths.child, executor: 'codex' });
  const sibling = await f.submit(12, { cwd: f.paths.prefix }); await until(() => f.runs.length === 2);
  assert.deepEqual(f.runs.map((record) => record.input.cwd), [fs.realpathSync(f.paths.a), fs.realpathSync(f.paths.prefix)]);
  assert.equal(f.manager.get(child.id, scope).waitingForWorkspace, true);
  assert.match(f.manager.get(child.id, scope).workspaceReason, /执行或清理/);
  const cleanup = deferred(); f.runs[0].cleanup = cleanup; f.runs[0].gate.resolve(success);
  f.runs[1].gate.resolve(success); await until(() => f.manager.get(sibling.id, scope).status === 'succeeded');
  await tick(); assert.equal(f.runs.length, 2); assert.equal(f.manager.get(first.id, scope).status, 'running');
  cleanup.resolve(); await until(() => f.runs.length === 3);
  assert.equal(f.runs[2].name, 'codex'); assert.equal(f.runs[2].input.cwd, fs.realpathSync(f.paths.child));
  f.runs[2].gate.resolve(success); await until(() => f.manager.status.active === 0);
});

test('an ancestor waits for an existing child-directory writer, not only the other direction', async (t) => {
  const f = fixture(t); await f.submit(20, { cwd: f.paths.child }); await until(() => f.runs.length === 1);
  const parent = await f.submit(21, { cwd: f.paths.a, executor: 'codex' });
  await until(() => f.manager.get(parent.id, scope).waitingForWorkspace);
  assert.equal(f.manager.status.running, 1); assert.equal(f.runs.length, 1);
  f.runs[0].gate.resolve(success); await until(() => f.runs.length === 2); assert.equal(f.runs[1].name, 'codex');
});

test('blocked workspace queues release global capacity without spinning and independent directories still dispatch', async (t) => {
  const f = fixture(t); await f.submit(30); await until(() => f.runs.length === 1);
  const waiting = await f.submit(31, { executor: 'codex' });
  await until(() => f.manager.get(waiting.id, scope).waitingForWorkspace);
  const probes = f.availability.length;
  for (let count = 0; count < 10; count++) { f.manager.schedule(); await tick(); }
  assert.equal(f.availability.length, probes); assert.equal(f.manager.status.running, 1); assert.equal(f.runs.length, 1);
  await f.submit(32, { cwd: f.paths.b }); await until(() => f.runs.length === 2);
  assert.equal(f.runs[1].input.cwd, fs.realpathSync(f.paths.b)); assert.equal(f.manager.get(waiting.id, scope).status, 'queued');
});

test('read-only executors share a writer cwd and high-load simple routing is selected before workspace exclusion', async (t) => {
  const f = fixture(t); await f.submit(40); await until(() => f.runs.length === 1);
  const simple = await f.submit(41, { executor: 'auto', difficulty: 'simple', readOnly: true }); await until(() => f.runs.length === 2);
  assert.equal(f.runs[1].name, 'minimax'); assert.equal(f.manager.get(simple.id, scope).waitingForWorkspace, false);
  assert.equal(f.runs[1].input.cwd, f.runs[0].input.cwd);
  f.runs[1].gate.resolve(success); await until(() => f.manager.get(simple.id, scope).status === 'succeeded');
  await f.submit(42, { executor: 'zcode', readOnly: true }); await until(() => f.runs.length === 3); assert.equal(f.runs[2].name, 'zcode');
});

test('unknown completion keeps a durable directory protection until exact-scope acknowledgement without replaying history', async (t) => {
  const f = fixture(t); const old = await f.submit(50); await until(() => f.runs.length === 1);
  const waiting = await f.submit(51, { executor: 'codex' }); await until(() => f.manager.get(waiting.id, scope).waitingForWorkspace);
  f.runs[0].gate.resolve({ status: 'unknown', errorCode: 'cleanup-unconfirmed' });
  await until(() => f.manager.get(old.id, scope).requiresVerification && f.manager.status.running === 0);
  assert.equal(f.manager.get(old.id, scope).status, 'unknown'); assert.equal(f.manager.status.workspacesRequiringVerification, 1);
  assert.match(f.manager.get(waiting.id, scope).workspaceReason, /结果待核实/);
  assert.equal(JSON.parse(fs.readFileSync(f.storeFile)).jobs.find((job) => job.id === old.id).requiresVerification, true);
  await f.submit(52, { cwd: f.paths.b }); await until(() => f.runs.length === 2);
  assert.equal(f.runs[1].input.cwd, fs.realpathSync(f.paths.b)); f.runs[1].gate.resolve(success);
  await assert.rejects(f.manager.acknowledge(old.id, { ...scope, identityId: 'other' }), { code: 'NOT_FOUND' });
  f.authorized.value = false; await assert.rejects(f.manager.acknowledge(old.id, scope), { code: 'FORBIDDEN' }); f.authorized.value = true;
  const acknowledged = await f.manager.acknowledge(old.id, scope);
  assert.equal(acknowledged.status, 'unknown'); assert.equal(acknowledged.requiresVerification, false);
  await until(() => f.runs.length === 3); assert.equal(f.runs[2].name, 'codex');
  const duplicate = await f.submit(50); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.id, old.id);
  await f.manager.acknowledge(old.id, scope); assert.equal(f.runs.length, 3);
  f.runs[2].gate.resolve(success); await until(() => f.manager.status.active === 0);
  assert.equal(f.runs.filter((record) => record.input.id === old.id).length, 1);
});

test('read-only work can proceed on a quarantined cwd but every unknown result still records verification requirement', async (t) => {
  const f = fixture(t); const old = await f.submit(60, { executor: 'zcode', readOnly: true }); await until(() => f.runs.length === 1);
  f.runs[0].gate.resolve({ status: 'unknown' }); await until(() => f.manager.get(old.id, scope).requiresVerification);
  const writer = await f.submit(61); await until(() => f.manager.get(writer.id, scope).waitingForWorkspace);
  await f.submit(62, { executor: 'minimax', readOnly: true }); await until(() => f.runs.length === 2);
  assert.equal(f.runs[1].name, 'minimax'); assert.equal(f.manager.get(writer.id, scope).status, 'queued');
});

test('cancellation retains the live write lock and unknown cleanup remains protected after the runner returns', async (t) => {
  const f = fixture(t); const active = await f.submit(70); await until(() => f.runs.length === 1);
  const waiting = await f.submit(71); await until(() => f.manager.get(waiting.id, scope).waitingForWorkspace);
  await f.manager.cancel(active.id, scope); assert.equal(f.runs[0].input.signal.aborted, true);
  await tick(); assert.equal(f.runs.length, 1);
  f.runs[0].gate.resolve({ status: 'unknown', errorCode: 'cleanup-unconfirmed' });
  await until(() => f.manager.get(active.id, scope).requiresVerification);
  assert.match(f.manager.get(active.id, scope).error, /尚未确认执行器已终止/); assert.equal(f.runs.length, 1);
  await f.manager.acknowledge(active.id, scope); await until(() => f.runs.length === 2);
});

test('unexpected runner rejection is treated as unknown and cannot release the directory to another writer', async (t) => {
  const f = fixture(t); const first = await f.submit(80); await until(() => f.runs.length === 1);
  const waiting = await f.submit(81); await until(() => f.manager.get(waiting.id, scope).waitingForWorkspace);
  f.runs[0].gate.reject(new Error('PRIVATE_EXECUTOR_MAY_STILL_RUN'));
  await until(() => f.manager.get(first.id, scope).requiresVerification);
  assert.equal(f.manager.get(first.id, scope).status, 'unknown'); assert.equal(f.runs.length, 1);
  assert.equal(JSON.stringify(f.manager.status).includes('PRIVATE_EXECUTOR'), false);
});

test('restart converts old running records without cwd into protected default directories and never replays them', async (t) => {
  const f = fixture(t); await f.manager.dispose();
  const old = { id: 'dfy-0000000000000001', key: 'a'.repeat(64), scope, executor: 'native', status: 'running',
    title: '旧任务', createdAt: '2026-10-24T00:00:00Z', text: '', delivery: 'pending' };
  fs.writeFileSync(f.storeFile, JSON.stringify({ version: 1, jobs: [old] })); const restored = f.create();
  assert.equal(restored.get(old.id, scope).status, 'unknown'); assert.equal(restored.get(old.id, scope).requiresVerification, true);
  const saved = JSON.parse(fs.readFileSync(f.storeFile)).jobs[0]; assert.equal(saved.cwd, fs.realpathSync(f.paths.a));
  const waiting = await f.submit(90, {}, restored); await until(() => restored.get(waiting.id, scope).waitingForWorkspace);
  assert.equal(f.runs.length, 0); await restored.acknowledge(old.id, scope); await until(() => f.runs.length === 1);
  f.runs[0].gate.resolve(success); await until(() => restored.status.running === 0); await restored.dispose();
  const again = f.create(); assert.equal(again.get(old.id, scope).status, 'unknown'); assert.equal(again.get(old.id, scope).requiresVerification, false);
  assert.equal(f.runs.length, 1, 'neither acknowledged history nor queued work is replayed on restart');
});

test('legacy source keys remain deduplicated after canonical cwd migration', async (t) => {
  const f = fixture(t); await f.manager.dispose();
  const prompt = '升级前已执行的请求', originId = '100';
  const key = createHash('sha256').update(JSON.stringify([`${scope.selfId}:${scope.peerId}:${scope.identityId}`, originId, prompt, ''])).digest('hex');
  const old = { id: 'dfy-' + key.slice(0, 16), key, scope, executor: 'native', status: 'succeeded', title: '旧成功任务',
    createdAt: '2026-10-24T00:00:00Z', text: '旧结果', delivery: 'sent' };
  fs.writeFileSync(f.storeFile, JSON.stringify({ version: 1, jobs: [old] }));
  const restored = f.create({ defaultCwd: undefined });
  const result = await restored.submit({ scope, originId, prompt, executor: 'codex' });
  assert.equal(result.id, old.id); assert.equal(result.duplicate, true); assert.equal(result.status, 'succeeded');
  assert.equal(f.runs.length, 0); assert.equal(f.sends.length, 0);
});

test('a waiting alias stays pinned to its admitted canonical directory even if the symlink changes', async (t) => {
  const f = fixture(t); await f.submit(110); await until(() => f.runs.length === 1);
  const waiting = await f.submit(111, { cwd: f.paths.alias }); await until(() => f.manager.get(waiting.id, scope).waitingForWorkspace);
  fs.unlinkSync(f.paths.alias); fs.symlinkSync(f.paths.b, f.paths.alias, 'dir');
  f.runs[0].gate.resolve(success); await until(() => f.runs.length === 2);
  assert.equal(f.runs[1].input.cwd, fs.realpathSync(f.paths.a));
});

test('diagnostic facts copy only fixed stage/category/HTTP fields and error notices never expose provider diagnostics', async (t) => {
  const f = fixture(t); const first = await f.submit(120); await until(() => f.runs.length === 1);
  f.runs[0].gate.resolve({ status: 'failed', errorCode: 'login-required', diagnostic: 'PRIVATE_RAW_PROVIDER_DIAGNOSTIC',
    diagnosticFacts: { stage: 'turn-start', category: 'transport', httpStatus: 401, token: 'PRIVATE_TOKEN', message: 'PRIVATE_MESSAGE' } });
  await until(() => f.manager.get(first.id, scope).status === 'failed');
  const result = f.manager.get(first.id, scope);
  assert.deepEqual(result.diagnosticFacts, { stage: 'turn-start', category: 'transport', httpStatus: 401 });
  assert.match(result.error, /认证失败.*登录.*仍需核实/);
  assert.equal(JSON.stringify({ result, sends: f.sends, ledger: JSON.parse(fs.readFileSync(f.storeFile)) }).includes('PRIVATE'), false);
  const next = await f.submit(121); await until(() => f.runs.length === 2);
  f.runs[1].gate.resolve({ status: 'failed', errorCode: 'service', diagnosticFacts: { stage: 'PRIVATE', category: 'PRIVATE', httpStatus: '503' } });
  await until(() => f.manager.get(next.id, scope).status === 'failed');
  assert.equal(f.manager.get(next.id, scope).diagnosticFacts, undefined); assert.match(f.manager.get(next.id, scope).error, /服务暂时异常.*可能已执行/);
});

test('a parked automatic task rechecks executor health before dispatch after the workspace becomes free', async (t) => {
  const f = fixture(t); await f.submit(130); await until(() => f.runs.length === 1);
  const waiting = await f.submit(131, { executor: 'auto' }); await until(() => f.manager.get(waiting.id, scope).waitingForWorkspace);
  assert.equal(f.manager.get(waiting.id, scope).executor, 'native'); f.available.native = false;
  f.runs[0].gate.resolve(success); await until(() => f.runs.length === 2);
  assert.equal(f.runs[1].name, 'codex'); assert.equal(f.manager.get(waiting.id, scope).executor, 'codex');
  assert.equal(f.runs.filter((record) => record.name === 'native').length, 1);
});

test('old workspace protection, queued work and uncertain delivery remain visible beyond recent history with scope filtering before the limit', async (t) => {
  const f = fixture(t, { manager: { async deliver(target, text) {
    return text.includes('送达待确认') ? { ok: false, uncertain: true } : { ok: true };
  } } });
  const old = await f.submit(200); await until(() => f.runs.length === 1);
  f.runs[0].gate.resolve({ status: 'unknown' }); await until(() => f.manager.get(old.id, scope).requiresVerification);
  const waiting = await f.submit(201); await until(() => f.manager.get(waiting.id, scope).waitingForWorkspace);
  const complete = async (origin, patch = {}) => {
    const count = f.runs.length, job = await f.submit(origin, { executor: 'minimax', readOnly: true, ...patch });
    await until(() => f.runs.length === count + 1); f.runs[count].gate.resolve(success);
    await until(() => !['pending', 'sending'].includes(f.manager.get(job.id, patch.scope || scope).delivery)); return job;
  };
  const uncertain = await complete(202, { title: '送达待确认' });
  assert.equal(f.manager.get(uncertain.id, scope).delivery, 'unknown');
  const otherScope = { ...scope, identityId: 'other' }, other = await complete(203, { scope: otherScope });
  const unresolved = [old.id, waiting.id, uncertain.id];
  let latest;
  for (let count = 0; count < 70; count++) {
    latest = await complete(300 + count);
    if (count === 34) for (const jobs of [f.manager.status.tasks, f.manager.list(scope)])
      assert.deepEqual(jobs.slice(0, 3).map((job) => job.id), unresolved, '35 later successful jobs must not hide actionable tasks');
  }
  for (const jobs of [f.manager.status.tasks, f.manager.list(scope)]) {
    assert.equal(jobs.length, 64); assert.deepEqual(jobs.slice(0, 3).map((job) => job.id), unresolved);
    assert.equal(jobs[3].id, latest.id, 'the remaining history stays newest first');
    assert.equal(jobs.find((job) => job.id === waiting.id).canCancel, true);
  }
  assert.deepEqual(f.manager.list(otherScope).map((job) => job.id), [other.id]);
  assert.equal(f.manager.list(scope).some((job) => job.id === other.id), false);
  await f.manager.acknowledge(old.id, scope); await until(() => f.runs.length === 74);
  assert.equal(f.runs.filter((record) => record.input.id === old.id).length, 1, 'visibility never replays unknown execution');
});
