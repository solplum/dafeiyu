import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackgroundTaskManager } from '../packages/dsh-dafeiyu/src/background-tasks.js';

const scope = Object.freeze({ selfId: '10001', peerId: '20002', identityId: 'default' });
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < end, 'background-manager fixture did not reach the expected state'); await tick(); }
}
const request = (originId = '1', patch = {}) => ({ scope: { ...scope }, originId, title: '离线后台测试',
  prompt: '仅执行受控离线任务', difficulty: 'normal', executor: 'native', ...patch });

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-background-ledger-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const separateCwd = (name) => { const cwd = path.join(dir, 'workspace-' + name); fs.mkdirSync(cwd, { recursive: true }); return cwd; };
  const storeFile = path.join(dir, 'tasks.json'), managers = [], runs = [], sends = [], availability = [];
  const authorized = { value: true };
  let inFlight = 0, peak = 0;
  const runner = (name, { available = true, result } = {}) => ({
    async available() { availability.push(name); return { available }; },
    async run(input) {
      const gate = deferred(), record = { name, input, gate, finished: false };
      runs.push(record); inFlight++; peak = Math.max(peak, inFlight);
      try { return result === undefined ? await gate.promise : typeof result === 'function' ? await result(input) : result; }
      finally { record.finished = true; inFlight--; }
    },
  });
  const executors = options.executors?.(runner) || { native: runner('native') };
  const create = (patch = {}) => {
    const manager = new BackgroundTaskManager({ storeFile, executors, defaultCwd: workspace,
      isAuthorized: () => authorized.value,
      async deliver(target, text) { sends.push({ scope: { ...target }, text }); return { ok: true, data: { message_id: sends.length } }; },
      ...options.manager, ...patch });
    managers.push(manager); return manager;
  };
  const manager = create();
  t.after(async () => {
    for (const run of runs) run.gate.resolve({ status: 'cancelled', executor: run.name, text: '' });
    for (const item of managers.reverse()) await item.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, storeFile, manager, create, runner, runs, sends, availability, authorized, separateCwd,
    get peak() { return peak; } };
}

function ledgerJob(index, patch = {}) {
  const suffix = index.toString(16).padStart(16, '0');
  return { id: `dfy-${suffix}`, key: suffix.padEnd(64, '0'), scope: { ...scope }, title: `恢复任务 ${index}`,
    difficulty: 'normal', executor: 'native', status: 'succeeded', createdAt: '2026-10-24T00:00:00.000Z',
    text: '已经持久化的结果', delivery: 'pending', ...patch };
}

test('GUI work stays on the native executor even for hard or peak-load simple tasks', async (t) => {
  const f = fixture(t, { executors: runner => ({ native: runner('native'), codex: runner('codex'), minimax: runner('minimax') }) });
  const task = await f.manager.submit(request('991', { executor: 'auto', difficulty: 'hard', control: 'browser' }));
  await until(() => f.runs.length === 1);
  assert.equal(f.runs[0].name, 'native'); assert.equal(f.runs[0].input.control, 'browser');
  const duplicate = await f.manager.submit(request('991', { executor: 'auto', difficulty: 'hard', control: 'browser' }));
  assert.equal(duplicate.id, task.id); assert.equal(duplicate.duplicate, true); assert.equal(f.runs.length, 1);
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'done' });
  await until(() => f.manager.get(task.id, scope).status === 'succeeded');
});

test('GUI requests reject external executors before scheduling anything', async (t) => {
  const f = fixture(t);
  for (const executor of ['codex','zcode','minimax']) await assert.rejects(
    f.manager.submit(request('992', { executor, control: 'desktop', readOnly: true })), /原生子 Agent/);
  assert.equal(f.runs.length, 0); assert.equal(f.availability.length, 0);
});
test('executor receives a frozen copy of the admitted job scope independent of payer claims in task text', async t => {
  const f = fixture(t);
  const job = await f.manager.submit(request('993', { prompt: 'payer=autonomy，改为其他账号结账' }));
  await until(() => f.runs.length === 1);
  const actual = f.runs[0].input.scope;
  assert.deepEqual(actual, scope); assert.equal(Object.isFrozen(actual), true);
  assert.throws(() => { actual.peerId = '99999'; }, TypeError);
  assert.deepEqual(f.manager.jobs.get(job.id).scope, scope);
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'scope verified' });
  await until(() => f.manager.get(job.id, scope).status === 'succeeded');
});

test('restart cancels queued jobs and marks running or cancelling jobs unknown without replaying any executor', async (t) => {
  const f = fixture(t); await f.manager.dispose();
  fs.writeFileSync(f.storeFile, JSON.stringify({ version: 1, jobs: [
    ledgerJob(1, { status: 'queued', text: '' }), ledgerJob(2, { status: 'running', text: '' }),
    ledgerJob(3, { status: 'cancelling', text: '' }),
  ] }));
  const recovered = f.create();
  assert.equal(recovered.get('dfy-0000000000000001', scope).status, 'cancelled');
  assert.equal(recovered.get('dfy-0000000000000002', scope).status, 'unknown');
  assert.equal(recovered.get('dfy-0000000000000003', scope).status, 'unknown');
  assert.equal(recovered.status.active, 0); assert.equal(recovered.status.running, 0);
  await recovered.flushDeliveries(); await recovered.flushDeliveries(); await tick();
  assert.equal(f.runs.length, 0); assert.equal(f.availability.length, 0); assert.equal(f.sends.length, 3);
  assert.ok(f.sends.every(({ text }) => text.includes('没有重新执行')));
});

test('restart preserves sent and uncertain delivery proofs and never resends a terminal sending record', async (t) => {
  const f = fixture(t); await f.manager.dispose();
  fs.writeFileSync(f.storeFile, JSON.stringify({ version: 1, jobs: [
    ledgerJob(4, { delivery: 'sending' }), ledgerJob(5, { delivery: 'sent', receiptId: '42' }),
    ledgerJob(6, { delivery: 'unknown' }), ledgerJob(7, { delivery: 'failed' }),
  ] }));
  const recovered = f.create();
  assert.equal(recovered.get('dfy-0000000000000004', scope).delivery, 'unknown');
  assert.equal(recovered.get('dfy-0000000000000005', scope).delivery, 'sent');
  await recovered.flushDeliveries(); await tick();
  assert.equal(f.sends.length, 0); assert.equal(f.runs.length, 0);
});

test('a completed source remains deduplicated across restart even if its requested executor changes', async (t) => {
  const f = fixture(t);
  const original = await f.manager.submit(request('21')); await until(() => f.runs.length === 1);
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'DONE_BEFORE_RESTART', executor: 'native' });
  await until(() => f.sends.length === 1); await f.manager.flushDeliveries(); await f.manager.dispose();
  const recovered = f.create();
  const duplicate = await recovered.submit(request('21', { executor: 'codex', difficulty: 'hard', title: '改名称不能重做' }));
  assert.equal(duplicate.id, original.id); assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.status, 'succeeded'); assert.equal(duplicate.executor, 'native');
  await recovered.flushDeliveries(); await tick();
  assert.equal(f.runs.length, 1); assert.equal(f.sends.length, 1);
});

test('hard work chooses Codex when available and only falls back to native before dispatch', async (t) => {
  for (const codexAvailable of [true, false]) {
    const f = fixture(t, { executors: (runner) => ({ codex: runner('codex', { available: codexAvailable }), native: runner('native') }) });
    const job = await f.manager.submit(request(codexAvailable ? '31' : '32', { executor: 'auto', difficulty: 'hard' }));
    await until(() => f.runs.length === 1);
    assert.equal(f.runs[0].name, codexAvailable ? 'codex' : 'native');
    assert.deepEqual(f.availability, codexAvailable ? ['codex'] : ['codex', 'native']);
    f.runs[0].gate.resolve({ status: 'succeeded', text: 'HARD_RESULT', executor: f.runs[0].name });
    await until(() => f.manager.get(job.id, scope).status === 'succeeded');
    assert.equal(f.runs.length, 1);
  }
});

test('explicitly read-only simple work uses MiniMax during measured concurrency while ordinary work stays native', async (t) => {
  const f = fixture(t, { executors: (runner) => ({ native: runner('native'), minimax: runner('minimax'), zcode: runner('zcode') }) });
  await f.manager.submit(request('41')); await until(() => f.runs.length === 1);
  const simple = await f.manager.submit(request('42', { executor: 'auto', difficulty: 'simple', prompt: '第二个简单任务', readOnly: true }));
  await until(() => f.runs.length === 2);
  assert.deepEqual(f.runs.map(({ name }) => name), ['native', 'minimax']);
  assert.equal(f.manager.get(simple.id, scope).executor, 'minimax');
  assert.equal(f.runs[1].input.readOnly, true);
  assert.equal(f.availability.includes('zcode'), false);
});

test('unavailable MiniMax can fall back to Z Code before launching the simple job', async (t) => {
  const f = fixture(t, { executors: (runner) => ({ native: runner('native'),
    minimax: runner('minimax', { available: false }), zcode: runner('zcode') }) });
  await f.manager.submit(request('43')); await until(() => f.runs.length === 1);
  await f.manager.submit(request('44', { executor: 'auto', difficulty: 'simple', prompt: '备用简单任务', readOnly: true }));
  await until(() => f.runs.length === 2);
  assert.deepEqual(f.runs.map(({ name }) => name), ['native', 'zcode']);
  assert.deepEqual(f.availability, ['native', 'minimax', 'zcode']);
});

test('disabling external routing keeps concurrent simple work with the native executor', async (t) => {
  const f = fixture(t, { manager: { externalRouting: false }, executors: (runner) => ({ native: runner('native'), minimax: runner('minimax') }) });
  await f.manager.submit(request('45')); await until(() => f.runs.length === 1);
  await f.manager.submit(request('46', { executor: 'auto', difficulty: 'simple', prompt: '不分流的任务', readOnly: true, cwd: f.separateCwd('routing-disabled') }));
  await until(() => f.runs.length === 2);
  assert.deepEqual(f.runs.map(({ name }) => name), ['native', 'native']);
  assert.equal(f.availability.includes('minimax'), false);
});

test('simple work that may write or omits a read-only declaration stays with native or Codex during concurrency', async (t) => {
  for (const [index, declaration] of [{}, { readOnly: false }].entries()) {
    const f = fixture(t, { executors: (runner) => ({ native: runner('native'), codex: runner('codex'),
      minimax: runner('minimax'), zcode: runner('zcode') }) });
    await f.manager.submit(request('500')); await until(() => f.runs.length === 1);
    if (index) f.manager.executors.native.available = async () => ({ available: false });
    const job = await f.manager.submit(request('501', { ...declaration, executor: 'auto', difficulty: 'simple',
      prompt: '创建并修改源文件', cwd: f.separateCwd('may-write') }));
    await until(() => f.runs.length === 2);
    assert.equal(f.runs[1].name, index ? 'codex' : 'native'); assert.equal(f.runs[1].input.readOnly, false);
    assert.equal(f.manager.get(job.id, scope).readOnly, false);
    assert.equal(f.availability.some((name) => ['minimax', 'zcode'].includes(name)), false);
    assert.equal(JSON.parse(fs.readFileSync(f.storeFile)).jobs.find((item) => item.id === job.id).readOnly, false);
  }
});

test('external execution requires an explicit boolean read-only declaration before checking or dispatching a new task', async (t) => {
  const f = fixture(t, { executors: (runner) => ({ native: runner('native'), minimax: runner('minimax'), zcode: runner('zcode') }) });
  for (const executor of ['minimax', 'zcode']) for (const declaration of [{}, { readOnly: false }]) {
    await assert.rejects(f.manager.submit(request('510', { executor, ...declaration })),
      (error) => error.code === 'INVALID_TASK' && /只读任务.*原生或 Codex/.test(error.message));
  }
  for (const readOnly of [null, 'true', 1, {}, []])
    await assert.rejects(f.manager.submit(request('511', { readOnly, probe: true })), { code: 'INVALID_TASK' });
  await tick(); assert.equal(f.runs.length, 0); assert.equal(f.availability.length, 0);
  assert.equal(f.manager.status.tasks.length, 0); assert.equal(fs.existsSync(f.storeFile), false);
});

test('explicit read-only external tasks and fixed internal connectivity probes pass the declaration to the runner and ledger', async (t) => {
  const f = fixture(t, { executors: (runner) => ({ minimax: runner('minimax'), zcode: runner('zcode') }) });
  for (const [index, executor] of ['minimax', 'zcode'].entries()) {
    const job = await f.manager.submit(request(String(520 + index), { executor, readOnly: true }));
    await until(() => f.runs.length === index + 1); assert.equal(f.runs[index].input.readOnly, true);
    assert.equal(job.readOnly, true); f.runs[index].gate.resolve({ status: 'succeeded', text: 'READ_ONLY_RESULT' });
    await until(() => f.manager.get(job.id, scope).delivery === 'sent');
  }
  const probe = await f.manager.submit(request('522', { executor: 'minimax', probe: true }));
  await until(() => f.runs.length === 3);
  assert.equal(probe.readOnly, true); assert.equal(f.runs[2].input.readOnly, true); assert.equal(f.runs[2].input.probe, true);
  assert.ok(JSON.parse(fs.readFileSync(f.storeFile)).jobs.every((job) => job.readOnly === true));
});

test('durable probe declarations classify tasks independently of their titles and survive reload and duplicate requests', async t => {
  const f = fixture(t);
  const business = await f.manager.submit(request('601', { title: 'native 只读连通测试' }));
  assert.equal(business.kind, 'task', 'a business title containing test words cannot change its origin');
  await until(() => f.runs.length === 1); f.runs[0].gate.resolve({ status: 'succeeded', text: 'BUSINESS_RESULT' });
  await until(() => f.manager.get(business.id, scope).delivery === 'sent');
  const probe = await f.manager.submit(request('602', { title: '完全不同的标题', probe: true }));
  assert.equal(probe.kind, 'connectivity-test', 'test provenance does not depend on its visible title');
  await until(() => f.runs.length === 2); f.runs[1].gate.resolve({ status: 'succeeded', text: 'PROBE_RESULT' });
  await until(() => f.manager.get(probe.id, scope).delivery === 'sent');
  const bytes = fs.readFileSync(f.storeFile), durable = JSON.parse(bytes);
  assert.deepEqual(durable.jobs.map(job => job.probe), [false, true]);
  assert.ok(durable.jobs.every(job => !Object.hasOwn(job, 'kind')), 'classification is a derived view rather than a journal rewrite');
  await f.manager.dispose(); const reloaded = f.create();
  for (const jobs of [reloaded.list(scope), reloaded.status.tasks]) {
    assert.equal(jobs.find(job => job.id === business.id).kind, 'task');
    assert.equal(jobs.find(job => job.id === probe.id).kind, 'connectivity-test');
  }
  assert.deepEqual(fs.readFileSync(f.storeFile), bytes, 'reloading valid declarations does not modify history');
  const changedBusiness = await reloaded.submit(request('601', { title: '更改标题', probe: true }));
  const changedProbe = await reloaded.submit(request('602', { title: '改成正式任务', probe: false }));
  assert.equal(changedBusiness.duplicate, true); assert.equal(changedBusiness.kind, 'task');
  assert.equal(changedProbe.duplicate, true); assert.equal(changedProbe.kind, 'connectivity-test');
  await reloaded.flushDeliveries(); assert.equal(f.runs.length, 2); assert.equal(f.sends.length, 2);
  assert.deepEqual(fs.readFileSync(f.storeFile), bytes);
});

test('legacy missing probe declarations remain unknown while unresolved test protections and delivery proofs stay visible without writes', async t => {
  const f = fixture(t); await f.manager.dispose();
  const jobs = [ledgerJob(611, { probe: true, status: 'unknown', requiresVerification: true, delivery: 'unknown', cwd: path.join(f.dir, 'workspace') }),
    ledgerJob(612, { probe: false, title: '连通测试', requiresVerification: false, delivery: 'unknown', cwd: path.join(f.dir, 'workspace') }),
    ledgerJob(613, { title: 'native 只读连通测试', requiresVerification: false, delivery: 'sent', cwd: path.join(f.dir, 'workspace') })];
  fs.writeFileSync(f.storeFile, JSON.stringify({ version: 1, jobs })); const before = fs.readFileSync(f.storeFile), reloaded = f.create();
  assert.equal(reloaded.status.ready, true);
  const visible = reloaded.list(scope);
  assert.equal(visible.find(job => job.id === jobs[0].id).kind, 'connectivity-test');
  assert.equal(visible.find(job => job.id === jobs[1].id).kind, 'task');
  assert.equal(visible.find(job => job.id === jobs[2].id).kind, 'legacy-unknown');
  const unknown = reloaded.get(jobs[0].id, scope);
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.requiresVerification, true); assert.equal(unknown.delivery, 'unknown');
  assert.ok(unknown.workspaceReason.includes('旧执行器是否已停止尚未确认'));
  assert.equal(reloaded.status.workspacesRequiringVerification, 1); assert.equal(reloaded.status.deliveryUnknown, 2);
  await reloaded.flushDeliveries(); assert.equal(f.runs.length, 0); assert.equal(f.sends.length, 0);
  assert.deepEqual(fs.readFileSync(f.storeFile), before, 'classification never fills in a missing historical declaration');
});

test('invalid stored probe declarations fail closed without classifying, selecting or replaying work', async t => {
  const f = fixture(t); await f.manager.dispose();
  for (const probe of [null, 'true', 'false', 1, 0, {}, []]) {
    const bytes = JSON.stringify({ version: 1, jobs: [ledgerJob(621, { probe, cwd: path.join(f.dir, 'workspace'), requiresVerification: false, delivery: 'sent' })] });
    fs.writeFileSync(f.storeFile, bytes); const invalid = f.create();
    assert.equal(invalid.status.ready, false, JSON.stringify(probe));
    await assert.rejects(invalid.submit(request('622')), { code: 'UNAVAILABLE' });
    await invalid.flushDeliveries(); assert.equal(fs.readFileSync(f.storeFile, 'utf8'), bytes);
  }
  assert.equal(f.runs.length, 0); assert.equal(f.availability.length, 0); assert.equal(f.sends.length, 0);
});

test('changing read-only or executor declarations deduplicates the original source before capability rejection and never upgrades or reruns it', async (t) => {
  const f = fixture(t); const original = await f.manager.submit(request('530')); await until(() => f.runs.length === 1);
  for (const patch of [{ executor: 'minimax', readOnly: false }, { executor: 'zcode', readOnly: true }]) {
    const duplicate = await f.manager.submit(request('530', patch));
    assert.equal(duplicate.id, original.id); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.readOnly, false);
  }
  assert.equal(f.runs.length, 1); f.runs[0].gate.resolve({ status: 'succeeded', text: 'ONCE_ONLY' });
  await until(() => f.manager.get(original.id, scope).delivery === 'sent'); await f.manager.dispose();
  const recovered = f.create();
  const duplicate = await recovered.submit(request('530', { executor: 'minimax', readOnly: true, probe: true }));
  assert.equal(duplicate.id, original.id); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.readOnly, false);
  assert.equal(f.runs.length, 1); assert.equal(f.sends.length, 1);
});

test('legacy journals may omit read-only declarations but invalid stored declaration types fail closed', async (t) => {
  const f = fixture(t); await f.manager.dispose();
  fs.writeFileSync(f.storeFile, JSON.stringify({ version: 1, jobs: [ledgerJob(540, { delivery: 'sent' })] }));
  const legacy = f.create(); assert.equal(legacy.status.ready, true);
  assert.equal(legacy.get('dfy-000000000000021c', scope).readOnly, false); await legacy.dispose();
  const data = JSON.parse(fs.readFileSync(f.storeFile)); data.jobs[0].readOnly = 'true';
  fs.writeFileSync(f.storeFile, JSON.stringify(data)); const invalid = f.create();
  assert.equal(invalid.status.ready, false); await assert.rejects(invalid.submit(request('541')), { code: 'UNAVAILABLE' });
  assert.equal(f.runs.length, 0); assert.equal(f.availability.length, 0); assert.equal(f.sends.length, 0);
});

test('execution slots stay bounded and release one queued job only after a running worker ends', async (t) => {
  const f = fixture(t, { manager: { maxConcurrent: 2 } });
  const jobs = await Promise.all(['51', '52', '53', '54'].map((origin) => f.manager.submit(request(origin, { cwd: f.separateCwd(origin) }))));
  await until(() => f.runs.length === 2);
  assert.equal(f.manager.status.running, 2); assert.equal(f.manager.status.queued, 2); assert.equal(f.peak, 2);
  for (let index = 0; index < jobs.length; index++) {
    await until(() => f.runs.length > index);
    f.runs[index].gate.resolve({ status: 'succeeded', text: `RESULT_${index}`, executor: 'native' });
  }
  await until(() => f.manager.status.active === 0 && f.manager.status.running === 0);
  assert.equal(f.runs.length, 4); assert.equal(f.peak, 2);
});

test('a corrupt ledger fails closed without executor selection or notification', async (t) => {
  const f = fixture(t); await f.manager.dispose();
  fs.writeFileSync(f.storeFile, '{broken-json');
  const broken = f.create();
  assert.equal(broken.status.ready, false);
  await assert.rejects(broken.submit(request('61')), { code: 'UNAVAILABLE' });
  await broken.flushDeliveries(); await tick();
  assert.equal(f.runs.length, 0); assert.equal(f.availability.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(fs.readFileSync(f.storeFile, 'utf8'), '{broken-json');
});

test('an externally changed ledger prevents dispatch and preserves the other writer bytes', async (t) => {
  const f = fixture(t);
  const otherWriter = JSON.stringify({ version: 1, jobs: [], otherWriter: 'changed after manager construction' });
  fs.writeFileSync(f.storeFile, otherWriter);
  await assert.rejects(f.manager.submit(request('62')), { code: 'STORAGE_UNAVAILABLE' });
  await tick(); assert.equal(f.manager.status.ready, false);
  assert.equal(f.runs.length, 0); assert.equal(f.availability.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(fs.readFileSync(f.storeFile, 'utf8'), otherWriter);
});

test('dispose aborts active workers, closes submission, and fences their late successful output', async (t) => {
  const f = fixture(t);
  await f.manager.submit(request('71')); await until(() => f.runs.length === 1);
  const disposal = f.manager.dispose();
  assert.equal(f.runs[0].input.signal.aborted, true); assert.equal(f.manager.status.ready, false);
  await assert.rejects(f.manager.submit(request('72')), { code: 'UNAVAILABLE' });
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'LATE_DISPOSED_RESULT', executor: 'native' });
  await disposal; await f.manager.flushDeliveries(); await tick();
  assert.equal(f.sends.length, 0); assert.equal(f.runs.length, 1);
});

test('a worker success without final text becomes a failed result notice and never another execution', async (t) => {
  const f = fixture(t, { executors: (runner) => ({ native: runner('native', { result: { status: 'succeeded', text: '  ', executor: 'native' } }) }) });
  const job = await f.manager.submit(request('81'));
  await until(() => f.sends.length === 1); await f.manager.flushDeliveries();
  const result = f.manager.get(job.id, scope);
  assert.equal(result.status, 'failed'); assert.match(result.error, /没有生成可确认的结果说明/);
  assert.match(f.sends[0].text, /没有生成可确认的结果说明/);
  await f.manager.submit(request('81')); await f.manager.flushDeliveries();
  assert.equal(f.runs.length, 1); assert.equal(f.sends.length, 1);
});

test('known worker failure or unknown completion never reroutes an already dispatched task to another executor', async (t) => {
  for (const status of ['failed', 'unknown']) {
    const f = fixture(t, { executors: (runner) => ({ codex: runner('codex', {
      result: { status, text: 'PRIVATE_EXECUTOR_FAILURE_MUST_NOT_LEAK', errorCode: 'execution', executor: 'codex' },
    }), native: runner('native') }) });
    const input = request(status === 'failed' ? '91' : '92', { executor: 'auto', difficulty: 'hard' });
    const job = await f.manager.submit(input); await until(() => f.sends.length === 1);
    assert.equal(f.manager.get(job.id, scope).status, status);
    await f.manager.submit(input); await f.manager.flushDeliveries(); await tick();
    assert.deepEqual(f.runs.map(({ name }) => name), ['codex']); assert.deepEqual(f.availability, ['codex']);
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0].text.includes('PRIVATE_EXECUTOR_FAILURE_MUST_NOT_LEAK'), false);
  }
});

test('task lookup and cancellation require the exact account identity while independent scopes stay separate', async (t) => {
  const f = fixture(t);
  const first = await f.manager.submit(request('101')); await until(() => f.runs.length === 1);
  for (const other of [{ ...scope, peerId: '30003' }, { ...scope, identityId: 'another' }, { ...scope, selfId: '10002' }]) {
    assert.deepEqual(f.manager.list(other), []);
    assert.throws(() => f.manager.get(first.id, other), { code: 'NOT_FOUND' });
    await assert.rejects(f.manager.cancel(first.id, other), { code: 'NOT_FOUND' });
  }
  const second = await f.manager.submit(request('101', { scope: { ...scope, identityId: 'another' }, cwd: f.separateCwd('other-identity') }));
  assert.notEqual(second.id, first.id); await until(() => f.runs.length === 2);
  assert.equal(f.manager.get(first.id, scope).status, 'running'); assert.equal(f.runs[0].input.signal.aborted, false);
});

test('revoking a task scope suppresses completion delivery until that exact scope is authorized again', async (t) => {
  const f = fixture(t);
  const job = await f.manager.submit(request('111')); await until(() => f.runs.length === 1);
  f.authorized.value = false;
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'REVOKED_SCOPE_RESULT', executor: 'native' });
  await until(() => f.runs[0].finished); await f.manager.flushDeliveries();
  assert.equal(f.sends.length, 0); assert.throws(() => f.manager.get(job.id, scope), { code: 'FORBIDDEN' });
  f.authorized.value = true;
  assert.equal(f.manager.get(job.id, scope).status, 'succeeded');
  await f.manager.flushDeliveries(); assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0].scope, scope); assert.equal(f.runs.length, 1);
});
