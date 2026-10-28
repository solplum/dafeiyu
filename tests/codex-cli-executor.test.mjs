import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createCodexCliExecutor } from '../packages/dsh-dafeiyu/src/codex-cli-executor.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const message = (text = '最终受控结果', patch = {}) => ({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text, ...patch } });
const success = (text) => [{ type: 'thread.started', thread_id: 'fixture-thread' }, { type: 'turn.started' }, message(text), { type: 'turn.completed' }];
const emit = (child, events, code = 0, signal = null) => {
  for (const event of events) child.stdout.write(typeof event === 'string' ? event : JSON.stringify(event) + '\n');
  child.emit('close', code, signal);
};

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dafeiyu-codex-cli-'));
  const workspace = join(dir, 'workspace'), outside = join(dir, 'outside'), binDir = join(dir, 'system-bin');
  await Promise.all([fs.mkdir(workspace), fs.mkdir(outside), fs.mkdir(binDir)]);
  await fs.mkdir(join(workspace, 'child')); await fs.symlink(outside, join(workspace, 'escape'), 'dir');
  const command = join(binDir, 'codex'); await fs.writeFile(command, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const calls = [];
  const spawnImpl = (binary, args, spawnOptions) => {
    if (options.spawnThrows) throw new Error('PRIVATE_SPAWN_DETAILS');
    const child = new EventEmitter(); child.pid = 900000 + calls.length; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.signals = [];
    child.kill = (signal) => { child.signals.push(signal);
      if (options.closeOnKill !== false) queueMicrotask(() => child.emit('close', null, signal)); return true; };
    const call = { binary, args, options: spawnOptions, child }; calls.push(call);
    queueMicrotask(() => {
      if (options.behavior) options.behavior(child, call);
      else if (args[0] === '--version') emit(child, ['codex-cli 0.163.0\n']);
      else emit(child, success('最终受控结果'));
    });
    return child;
  };
  const make = (patch = {}) => createCodexCliExecutor({ command, cwdRoot: workspace, spawnImpl, ...options.runner, ...patch });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, workspace, outside, binDir, command, calls, make, worker: make() };
}

test('availability only reads the selected system CLI version and never runs a task or claims authentication', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.worker.available(), { installed: true, available: true, version: '0.163.0' });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].args, ['--version']);
  assert.equal(f.calls[0].options.shell, false);
  const missing = f.make({ command: join(f.dir, 'missing-codex') });
  assert.deepEqual(await missing.available(), { installed: false, available: false, reason: 'executor-unavailable' });
  assert.equal(f.calls.length, 1);
});

test('workspace coding uses never approval and native model configuration without a pinned provider or shell interpolation', async (t) => {
  const f = await fixture(t), prompt = '请检查代码；$(do-not-run) `literal`\n--model private';
  assert.deepEqual(await f.worker.run({ id: 'code-1', prompt }), { executor: 'codex', status: 'succeeded', text: '最终受控结果' });
  const call = f.calls[0]; assert.equal(call.binary, await fs.realpath(f.command));
  assert.deepEqual(call.args, ['-a', 'never', 'exec', '--json', '-C', await fs.realpath(f.workspace),
    '--skip-git-repo-check', '--sandbox', 'workspace-write', '--', prompt]);
  assert.equal(call.options.shell, false); assert.equal(call.options.detached, process.platform !== 'win32');
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(call.args.includes('--model'), false); assert.equal(call.args.includes('--ignore-user-config'), false);
});

test('explicit connectivity probes are read-only while ordinary jobs retain the workspace-write policy', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.worker.run({ id: 'probe', prompt: 'nonce only', probe: true })).status, 'succeeded');
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--sandbox') + 1], 'read-only');
});

test('ambient DSH, QQ and cloud credentials are scrubbed while native config paths and proxy settings remain available', async (t) => {
  const f = await fixture(t), values = { DSH_TOKEN: 'PRIVATE_DSH', ONEBOT_ACCESS_TOKEN: 'PRIVATE_QQ', QQ_BOT_APP_SECRET: 'PRIVATE_QQ_SECRET',
    OPENAI_API_KEY: 'PRIVATE_OPENAI', CODEX_API_KEY: 'PRIVATE_CODEX', MINIMAX_API_KEY: 'PRIVATE_MINIMAX', AWS_SECRET_ACCESS_KEY: 'PRIVATE_AWS',
    NODE_OPTIONS: '--require PRIVATE_PRELOAD', CODEX_HOME: join(f.dir, 'native-codex-home'), HTTPS_PROXY: 'http://127.0.0.1:1080' };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  await f.worker.run({ id: 'environment', prompt: 'fixture' });
  const env = f.calls[0].options.env;
  assert.equal(env.HOME, process.env.HOME); assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.CODEX_HOME, values.CODEX_HOME); assert.equal(env.HTTPS_PROXY, values.HTTPS_PROXY);
  for (const key of Object.keys(values).filter((key) => !['CODEX_HOME', 'HTTPS_PROXY'].includes(key))) assert.equal(Object.hasOwn(env, key), false, key);
  assert.equal(JSON.stringify(env).includes('PRIVATE'), false);
});

test('default executable discovery skips the DSH bundle even when it appears first in PATH', async (t) => {
  const f = await fixture(t), oldDir = join(f.dir, '.dsh', 'bin'); await fs.mkdir(oldDir, { recursive: true });
  await fs.writeFile(join(oldDir, 'codex'), '#!/bin/sh\nexit 88\n', { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = oldDir + delimiter + f.binDir;
  t.after(() => { previous === undefined ? delete process.env.PATH : process.env.PATH = previous; });
  const worker = f.make({ command: undefined }); await worker.available();
  assert.equal(f.calls[0].binary, await fs.realpath(f.command));
  assert.equal((await f.make({ command: join(oldDir, 'codex') }).available()).installed, false);
});

test('workspace traversal, symlink escapes, missing paths and invalid task inputs never start Codex', async (t) => {
  const f = await fixture(t);
  for (const cwd of [f.outside, join(f.workspace, 'escape'), '../outside']) {
    assert.equal((await f.worker.run({ id: 'outside', prompt: 'fixture', cwd })).errorCode, 'workspace-outside-root');
  }
  assert.equal((await f.worker.run({ id: 'missing', prompt: 'fixture', cwd: join(f.workspace, 'missing') })).errorCode, 'workspace-unavailable');
  for (const input of [{ id: '../invalid', prompt: 'fixture' }, { id: 'bad', prompt: '' }, { id: 'bad', prompt: 'x'.repeat(65537) },
    { id: 'bad', prompt: 'bad\0prompt' }, { id: 'bad', prompt: 'fixture', signal: {} }, { id: 'bad', prompt: 'fixture', readOnly: 'true' }]) {
    assert.equal((await f.worker.run(input)).errorCode, 'invalid-input');
  }
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.worker.run({ id: 'cancelled', prompt: 'fixture', signal: controller.signal })).status, 'cancelled');
  assert.equal(f.calls.length, 0);
});

test('only the last non-commentary completed agent message before one successful turn becomes the result', async (t) => {
  const f = await fixture(t, { behavior: (child) => emit(child, [
    { type: 'turn.started' }, message('PRIVATE_COMMENTARY', { phase: 'commentary' }),
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'PRIVATE_TOOL_OUTPUT' } },
    { type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE_REASONING' } },
    message('较早结果'), message('真正最终结果', { phase: 'final_answer' }), message('PRIVATE_CHANNEL_COMMENTARY', { channel: 'commentary' }),
    message('PRIVATE_CONFLICTING_COMMENTARY', { phase: 'final', channel: 'commentary' }),
    { type: 'turn.completed' }, message('PRIVATE_AFTER_COMPLETION'),
  ]) });
  const result = await f.worker.run({ id: 'selection', prompt: 'fixture' });
  assert.deepEqual(result, { executor: 'codex', status: 'succeeded', text: '真正最终结果' });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('missing final text, commentary-only output, missing or multiple terminal turns never count as success', async (t) => {
  for (const events of [[{ type: 'turn.started' }, message('draft', { phase: 'commentary' }), { type: 'turn.completed' }],
    [{ type: 'turn.started' }, message('not terminal')], [message('unclaimed'), { type: 'turn.completed' }],
    [{ type: 'turn.started' }, message('conflicting'), { type: 'turn.completed' }, { type: 'turn.completed' }],
    ['plain log saying success\n'], [{ type: 'turn.started' }, { type: 'item.completed', item: { type: 'tool_result', text: 'tool-only' } }, { type: 'turn.completed' }]]) {
    const f = await fixture(t, { behavior: (child) => emit(child, events) });
    assert.deepEqual(await f.worker.run({ id: 'invalid', prompt: 'fixture' }), { executor: 'codex', status: 'failed', errorCode: 'invalid-result' });
  }
});

test('structured errors and turn.failed override apparent success and return only fixed actionable classifications', async (t) => {
  for (const [hint, errorCode] of [
    ["The model 'gpt-fixture' is not supported when using Codex", 'model-unavailable'],
    ['HTTP 401 unauthorized PRIVATE_TOKEN', 'login-required'], ['HTTP 403 forbidden PRIVATE_TOKEN', 'access-policy'],
    ['HTTP 429 rate limit PRIVATE_TOKEN', 'quota'], ['HTTP 503 service unavailable PRIVATE_TOKEN', 'service'],
    ['network connection disconnected PRIVATE_TOKEN', 'transport'], ['PRIVATE_UNKNOWN_FAILURE', 'execution'],
  ]) {
    const f = await fixture(t, { behavior: (child) => emit(child, [
      { type: 'turn.started' }, message('PRIVATE_PARTIAL'), { type: 'error', message: hint },
      { type: 'turn.failed', error: { message: hint } }, { type: 'turn.completed' },
    ]) });
    const result = await f.worker.run({ id: 'failed', prompt: 'fixture' });
    assert.deepEqual(result, { executor: 'codex', status: 'failed', errorCode });
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(f.calls.length, 1);
  }
});

test('nonzero process exit and stderr cannot turn success-looking stdout into a result or leak private diagnostics', async (t) => {
  const f = await fixture(t, { behavior(child) { child.stderr.write('PRIVATE_TOKEN model gpt-fixture is not supported'); emit(child, success('PRIVATE_SUCCESS'), 23); } });
  assert.deepEqual(await f.worker.run({ id: 'nonzero', prompt: 'fixture' }), { executor: 'codex', status: 'failed', errorCode: 'model-unavailable' });
  const logs = await fixture(t, { behavior(child) { child.stderr.write('PRIVATE_TOKEN 401 unauthorized warning only'); emit(child, success('CONFIRMED_RESULT')); } });
  assert.equal((await logs.worker.run({ id: 'normal', prompt: 'fixture' })).text, 'CONFIRMED_RESULT');
});

test('cancellation waits for the exact child close and suppresses every late final message', async (t) => {
  const controller = new AbortController(), f = await fixture(t, { closeOnKill: false, behavior() {} });
  let settled = false; const running = f.worker.run({ id: 'cancel', prompt: 'fixture', signal: controller.signal }).then((result) => { settled = true; return result; });
  while (!f.calls.length) await tick(); controller.abort(); await tick();
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']); assert.equal(settled, false);
  emit(f.calls[0].child, success('PRIVATE_LATE_SUCCESS')); const result = await running;
  assert.deepEqual(result, { executor: 'codex', status: 'cancelled', errorCode: 'cancelled' }); assert.equal(f.calls.length, 1);
});

test('timeout is unknown even after close and missing termination confirmation remains unknown after group escalation', async (t) => {
  const timed = await fixture(t, { behavior() {}, runner: { timeoutMs: 5 } });
  assert.deepEqual(await timed.worker.run({ id: 'timed', prompt: 'fixture' }), { executor: 'codex', status: 'unknown', errorCode: 'executor-timeout' });
  assert.equal(timed.calls.length, 1);
  const stuck = await fixture(t, { behavior() {}, closeOnKill: false, runner: { timeoutMs: 5 } });
  assert.deepEqual(await stuck.worker.run({ id: 'stuck', prompt: 'fixture' }), { executor: 'codex', status: 'unknown', errorCode: 'termination-unconfirmed' });
  assert.deepEqual(stuck.calls[0].child.signals, ['SIGTERM', 'SIGKILL']); assert.equal(stuck.calls.length, 1);
});

test('combined stdout and stderr budgets stop flooding without returning partial output', async (t) => {
  const f = await fixture(t, { runner: { maxOutputBytes: 128 }, behavior(child) { child.stdout.write('x'.repeat(100)); child.stderr.write('PRIVATE'.repeat(30)); } });
  assert.deepEqual(await f.worker.run({ id: 'flood', prompt: 'fixture' }), { executor: 'codex', status: 'unknown', errorCode: 'output-limit' });
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
});

test('streamed UTF-8, no trailing newline, observer errors and process spawn errors remain bounded and never retry', async (t) => {
  const f = await fixture(t, { behavior(child) {
    const bytes = Buffer.from(success('中文完整结果').map((event) => JSON.stringify(event)).join('\n'));
    for (let index = 0; index < bytes.length; index++) child.stdout.write(bytes.subarray(index, index + 1));
    child.emit('exit', 0); child.emit('close', 0, null);
  } });
  assert.equal((await f.worker.run({ id: 'utf8', prompt: 'fixture', onProgress: async () => { throw new Error('PRIVATE_OBSERVER'); } })).text, '中文完整结果');
  const failed = await fixture(t, { spawnThrows: true });
  assert.deepEqual(await failed.worker.run({ id: 'spawn-failed', prompt: 'fixture' }), { executor: 'codex', status: 'failed', errorCode: 'executor-unavailable' });
  assert.equal(failed.calls.length, 0);
});

test('a real CLI fixture cannot release a workspace while a same-group grandchild survives its normal close',
  { skip: process.platform === 'win32' }, async (t) => {
    for (const exitCode of [0, 23]) {
      const dir = await fs.mkdtemp(join(tmpdir(), 'dafeiyu-codex-owned-group-'));
      const command = join(dir, 'fixture-cli.mjs'), groupMarker = join(dir, 'owned-group.pid');
      const childMarker = join(dir, 'owned-child.pid'), readyMarker = join(dir, 'owned-child.ready');
      let cleanupNeeded = true;
      t.after(async () => {
        // Only the detached process group created by this exact temporary CLI
        // is eligible for cleanup, including if an assertion fails early.
        const group = Number(await fs.readFile(groupMarker, 'utf8').catch(() => ''));
        if (cleanupNeeded && Number.isSafeInteger(group) && group > 1) { try { process.kill(-group, 'SIGKILL'); } catch {} }
        await fs.rm(dir, { recursive: true, force: true });
      });
      const childSource = 'const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync('
        + JSON.stringify(readyMarker) + ',"ready");setInterval(()=>{},1000);';
      await fs.writeFile(command, '#!' + process.execPath + '\n'
        + 'import {spawn} from "node:child_process";import {existsSync,writeFileSync} from "node:fs";\n'
        + 'writeFileSync(' + JSON.stringify(groupMarker) + ',String(process.pid));\n'
        + 'const child=spawn(process.execPath,["-e",' + JSON.stringify(childSource) + '],{stdio:"ignore"});child.unref();\n'
        + 'writeFileSync(' + JSON.stringify(childMarker) + ',String(child.pid));\n'
        + 'const ready=setInterval(()=>{if(!existsSync(' + JSON.stringify(readyMarker) + '))return;clearInterval(ready);'
        + 'process.stdout.end(' + JSON.stringify(success('OWNED_FIXTURE_FINAL').map((event) => JSON.stringify(event)).join('\n') + '\n')
        + ',()=>process.exit(' + exitCode + '));},5);\n', { mode: 0o700 });
      const begin = Date.now();
      const result = await createCodexCliExecutor({ command, cwdRoot: dir, timeoutMs: 5000 }).run({ id: 'owned-group-' + exitCode, prompt: 'temporary fixture only' });
      const pid = Number(await fs.readFile(childMarker, 'utf8')); assert.ok(Number.isSafeInteger(pid) && pid > 1);
      let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
      cleanupNeeded = alive;
      t.diagnostic(`Owned fixture exit ${exitCode}: ${result.status}; descendant alive after return: ${alive}`);
      assert.ok(Date.now() - begin >= 800, 'the worker must wait through the TERM grace period for the known TERM-ignoring child');
      assert.ok(result.status === 'unknown' || !alive, 'success or known failure cannot release the writer while an owned descendant is still alive');
      if (result.status === 'unknown') {
        assert.equal(result.errorCode, 'termination-unconfirmed'); assert.equal(Object.hasOwn(result, 'text'), false);
      } else assert.deepEqual(result, exitCode === 0
        ? { executor: 'codex', status: 'succeeded', text: 'OWNED_FIXTURE_FINAL' }
        : { executor: 'codex', status: 'failed', errorCode: 'execution' });
    }
  });

test('declared read-only tasks receive a hard read-only Codex sandbox', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.worker.run({ id: 'read-only-task', prompt: '只读分析', readOnly: true })).status, 'succeeded');
  const args = f.calls[0].args;
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
});
