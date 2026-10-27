import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackgroundTaskManager } from '../packages/dsh-dafeiyu/src/background-tasks.js';
import { registerBackgroundTools } from '../packages/dsh-dafeiyu/src/background-tools.js';

const scope = Object.freeze({ selfId: '10001', peerId: '20002', identityId: 'default' });
const args = Object.freeze({ title: '工具入口任务', prompt: '仅运行受控离线任务', executor: 'native' });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
async function until(predicate) { const end = Date.now() + 2000; while (!predicate()) { assert.ok(Date.now() < end); await tick(); } }

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-background-tools-'));
  const workspace = path.join(dir, 'workspace'), outside = path.join(dir, 'outside');
  fs.mkdirSync(workspace); fs.mkdirSync(outside); fs.mkdirSync(path.join(workspace, 'child'));
  fs.symlinkSync(outside, path.join(workspace, 'escape'), 'dir');
  const tools = new Map(), runs = [], sent = [];
  const agent = { session: { id: 'verified-owner-session' } }, parent = { id: 'actual-parent' };
  const state = { active: true, originId: '123', identity: { isOwner: true, channel: 'onebot', scope: 'c2c', ...scope } };
  const manager = new BackgroundTaskManager({ storeFile: path.join(dir, 'journal.json'), defaultCwd: workspace,
    isAuthorized: (target) => target.selfId === scope.selfId && target.peerId === scope.peerId && target.identityId === scope.identityId,
    executors: { native: { available: async () => ({ available: true }), async run(input) {
      const gate = deferred(); runs.push({ input, gate }); return gate.promise;
    } } }, deliver: async (_scope, text) => { sent.push(text); return { ok: true }; } });
  const unregister = registerBackgroundTools({ tools: { register(definition) {
    tools.set(definition.name, definition); return () => tools.delete(definition.name);
  } } }, { manager, workspaceRoots: [workspace], getExecutionContext: () => state.identity,
    bridge: { backgroundOriginForAgent: (candidate) => candidate === agent && state.active
      ? { scope: { ...scope }, originId: state.originId, parent } : null } });
  const definitions = new Map(tools);
  t.after(async () => {
    unregister(); for (const run of runs) run.gate.resolve({ status: 'cancelled' });
    await manager.dispose(); fs.rmSync(dir, { recursive: true, force: true });
  });
  return { manager, tools, definitions, agent, parent, state, runs, sent, workspace, outside, unregister,
    invoke(name, input = {}, execution = {}) { return definitions.get(name).execute(input, { agent, ...execution }); } };
}

test('tool calls derive the source origin and parent from the verified active conversation and remain idempotent across call IDs', async (t) => {
  const f = fixture(t);
  const first = await f.invoke('dafeiyu_task_start', args, { callId: 'host-tool-call-a' });
  const duplicate = await f.invoke('dafeiyu_task_start', args, { callId: 'host-tool-call-b', originId: '999' });
  assert.equal(first.ok, true); assert.equal(duplicate.task.id, first.task.id); assert.equal(duplicate.task.duplicate, true);
  await until(() => f.runs.length === 1);
  assert.equal(f.runs[0].input.parent, f.parent); assert.equal(f.runs[0].input.cwd, fs.realpathSync(f.workspace));
  f.runs[0].gate.resolve({ status: 'succeeded', text: 'ACTUAL_TOOL_JOB_RESULT' });
  await until(() => f.sent.length === 1);
  assert.equal((await f.invoke('dafeiyu_task_start', args)).task.id, first.task.id);
  assert.equal(f.runs.length, 1); assert.equal(f.sent.length, 1);
});

test('tools reject guests, other channels, unregistered agents and ended QQ turns before accepting work', async (t) => {
  const f = fixture(t);
  for (const identity of [{ ...f.state.identity, isOwner: false }, { ...f.state.identity, channel: 'official' },
    { ...f.state.identity, peerId: '30003' }, { ...f.state.identity, selfId: '99999' }]) {
    f.state.identity = identity;
    await assert.rejects(f.invoke('dafeiyu_task_start', args), /已验证的主人 QQ/);
  }
  f.state.identity = { isOwner: true, channel: 'onebot', scope: 'c2c', ...scope };
  await assert.rejects(f.invoke('dafeiyu_task_start', args, { agent: { session: f.agent.session } }), /已验证的主人 QQ/);
  f.state.active = false;
  await assert.rejects(f.invoke('dafeiyu_task_status'), /已验证的主人 QQ/);
  assert.equal(f.manager.status.tasks.length, 0); assert.equal(f.runs.length, 0);
});

test('task arguments cannot replace an owner, identity, source message, parent or manager scope', async (t) => {
  const f = fixture(t);
  for (const patch of [{ scope: { ...scope, peerId: '30003' } }, { originId: '999' }, { parent: {} },
    { qq: '30003' }, { identityId: 'another' }, { executor: 'unrecognized' }, { readOnly: 'true' }, { readOnly: 1 }]) {
    await assert.rejects(f.invoke('dafeiyu_task_start', { ...args, ...patch }));
  }
  assert.equal(f.manager.status.tasks.length, 0); assert.equal(f.runs.length, 0);
});

test('an explicit cwd must resolve to a directory inside the configured workspace, including symlink checks', async (t) => {
  const f = fixture(t), filepath = path.join(f.workspace, 'ordinary-file'); fs.writeFileSync(filepath, 'fixture');
  for (const cwd of [f.outside, path.join(f.workspace, 'escape'), filepath, '../outside', path.join(f.workspace, 'missing')]) {
    await assert.rejects(f.invoke('dafeiyu_task_start', { ...args, cwd }), /任务目录不在已配置工作区内/);
  }
  assert.equal(f.manager.status.tasks.length, 0);
  const valid = await f.invoke('dafeiyu_task_start', { ...args, cwd: path.join(f.workspace, 'child') });
  assert.equal(valid.ok, true); await until(() => f.runs.length === 1);
  assert.equal(f.runs[0].input.cwd, fs.realpathSync(path.join(f.workspace, 'child')));
});

test('status and cancellation use the active account identity and cannot start another execution', async (t) => {
  const f = fixture(t);
  const job = (await f.invoke('dafeiyu_task_start', args)).task; await until(() => f.runs.length === 1);
  const status = await f.invoke('dafeiyu_task_status', { taskId: job.id });
  assert.equal(status.task.id, job.id); assert.equal(status.task.status, 'running');
  const listed = await f.invoke('dafeiyu_task_status'); assert.equal(listed.tasks.length, 1);
  const cancelled = await f.invoke('dafeiyu_task_cancel', { taskId: job.id });
  assert.equal(cancelled.task.status, 'cancelling'); assert.equal(f.runs[0].input.signal.aborted, true);
  f.runs[0].gate.resolve({ status: 'cancelled' }); await until(() => f.manager.get(job.id, scope).status === 'cancelled');
  assert.equal((await f.invoke('dafeiyu_task_cancel', { taskId: job.id })).task.status, 'cancelled');
  assert.equal(f.runs.length, 1);
});

test('cancelled execution signals and unregistered tool definitions cannot accept new jobs', async (t) => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.invoke('dafeiyu_task_start', args, { signal: controller.signal }), /已停止或会话已取消/);
  f.unregister(); assert.equal(f.tools.size, 0);
  await assert.rejects(f.invoke('dafeiyu_task_start', args), /已停止或会话已取消/);
  assert.equal(f.manager.status.tasks.length, 0); assert.equal(f.runs.length, 0);
});
