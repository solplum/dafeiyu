import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExternalExecutor } from '../packages/dsh-dafeiyu/src/external-executors.js';

const zresult = text => ({ type: 'result', sessionId: 's1', projection: { status: 'completed' }, response: text });
const mresult = text => ({ schemaVersion: 1, type: 'exec.result', runId: 'r1', sessionId: 's1', turnId: 't1',
  durationMs: 12, status: 'succeeded', output: text });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'external-worker-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The fake launcher is never executed. It lets platform-independent unit
  // tests validate the exact sandbox/CLI invocation without running a model.
  const launcher = join(root, 'sandbox-exec');
  await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const calls = [];
  const make = (kind, behavior, options = {}) => createExternalExecutor({ kind, command: `${kind}-fixture`,
    cwdRoot: root, profileDir: join(root, 'profiles', kind), platform: 'darwin', sandboxCommand: launcher, stopGraceMs: 5,
    spawnImpl(command, args, spawnOptions) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.signals = []; child.kill = signal => {
        child.signals.push(signal);
        if (options.closeOnKill !== false) queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      const call = { command, args, options: spawnOptions, child }; calls.push(call);
      queueMicrotask(() => Promise.resolve(args.at(-1) === '--version'
        ? options.versionBehavior ? options.versionBehavior(child, call) : emit(child, kind === 'zcode' ? '0.17.0' : '0.6.12')
        : behavior?.(child, call)).catch(error => child.emit('error', error)));
      return child;
    }, ...options });
  return { root, calls, make };
}

function emit(child, value, code = 0) {
  child.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  child.emit('close', code, null);
}

test('ZCode uses explicit plan permissions and accepts only the structured final response', async t => {
  const { root, calls, make } = await fixture(t);
  const worker = make('zcode', (child, call) => {
    child.stdout.write('diagnostic: this is not a result\n');
    emit(child, zresult('checked'));
  });
  assert.deepEqual(await worker.run({ id: 'job-1', prompt: 'Read current state', cwd: root }),
    { status: 'succeeded', executor: 'zcode', text: 'checked' });
  const { command, args, options } = calls[0];
  assert.match(command, /sandbox-exec$/u);
  assert.equal(args[2], 'zcode-fixture');
  assert.equal(args[args.indexOf('--mode') + 1], 'plan');
  assert.equal(args[args.indexOf('--workflow-mode') + 1], 'disabled');
  assert.ok(args.includes('--json'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.match(options.env.ZCODE_SESSION_DB_PATH, /zcode-sessions\.sqlite$/u);
  assert.match(args[args.indexOf('--disallowed-tools') + 1], /Bash,Edit,Write/u);
  assert.equal(options.shell, false); assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('MiniMax parses exec.completed, applies a private config, and isolates runtime data', async t => {
  const { root, calls, make } = await fixture(t);
  let config, profile, temporary;
  const worker = make('minimax', async (child, call) => {
    config = JSON.parse(await readFile(call.args[call.args.indexOf('--config') + 1], 'utf8'));
    profile = await readFile(call.args[1], 'utf8'); temporary = call.options.env.TMPDIR;
    child.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'item.updated', item: { type: 'agent_message', contentDelta: 'draft' } })}\n`);
    emit(child, { schemaVersion: 1, type: 'exec.completed', result: mresult('final result') });
  });
  assert.deepEqual(await worker.run({ id: 'm1', prompt: 'Review only', cwd: root }),
    { status: 'succeeded', executor: 'minimax', text: 'final result' });
  const call = calls[0];
  assert.equal(call.args[3], 'exec');
  assert.equal(call.args[call.args.indexOf('--permission') + 1], 'smart');
  assert.equal(call.args[call.args.indexOf('--mode') + 1], 'lightweight');
  assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'stream-json');
  assert.deepEqual(config.agents.default.tools, ['read', 'grep', 'glob']);
  assert.deepEqual(config.agents.default.builtinTools, []);
  assert.deepEqual(config.agents.default.skills, []);
  assert.equal(config.memory.enabled, false);
  assert.equal(config.skills.external.enabled, false);
  assert.equal(config.agents.default.features.delegation, false);
  assert.equal(call.options.env.MINIMAX_DATA_DIR, join(root, 'profiles', 'minimax'));
  assert.equal(call.options.env.HOME, process.env.HOME || homedir());
  assert.match(profile, /\(deny file-write\*\)/u);
  assert.ok(profile.includes(root));
  assert.ok(profile.includes(join(homedir(), '.dsh')));
  await assert.rejects(access(temporary), { code: 'ENOENT' });
});

test('Only allowlisted operating environment reaches external processes', async t => {
  const { make, calls } = await fixture(t);
  const names = ['DSH_ONEBOT_TOKEN', 'QQ_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS'];
  const before = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = 'must-not-reach-child';
  t.after(() => { for (const [name, value] of before) value === undefined ? delete process.env[name] : process.env[name] = value; });
  await make('zcode', child => emit(child, zresult('ok'))).run({ id: 'env', prompt: 'read' });
  for (const name of names) assert.equal(calls[0].options.env[name], undefined);
});

test('Version probing performs no model request and does not imply authentication', async t => {
  const { make, calls } = await fixture(t);
  const worker = make('zcode', child => emit(child, 'zcode 0.17.0'));
  assert.deepEqual(await worker.available(), { installed: true, available: false, version: '0.17.0', reason: 'execution-unverified' });
  assert.deepEqual(calls[0].args.slice(3), ['--version']);
});

test('Version failure is fixed and does not expose stderr', async t => {
  const { make } = await fixture(t);
  const worker = make('minimax', null, { versionBehavior: child => { child.stderr.write('Authorization: Bearer private-secret'); emit(child, '', 2); } });
  const value = await worker.available();
  assert.deepEqual(value, { installed: false, available: false, reason: 'executor-failed' });
  assert.ok(!JSON.stringify(value).includes('private-secret'));
});

test('Installed MiniMax without native login never becomes an automatic routing candidate', async t => {
  const { make } = await fixture(t);
  const worker = make('minimax', child => emit(child, '0.6.12'));
  assert.deepEqual(await worker.available(), { installed: true, version: '0.6.12', available: false, reason: 'login-required' });
});

test('ZCode needs successful execution proof, retains it across factories, and revokes changed metadata/version', async t => {
  const { make, root, calls } = await fixture(t);
  let cliVersion = '0.17.0';
  const options = { versionBehavior: child => emit(child, cliVersion) };
  const worker = make('zcode', child => emit(child, zresult('verified')), options);
  assert.deepEqual(await worker.available(), { installed: true, version: cliVersion, available: false, reason: 'execution-unverified' });
  assert.equal((await worker.run({ id: 'z-verify', prompt: 'fixture' })).status, 'succeeded');
  const nextFactory = make('zcode', () => assert.fail('availability must not call the model'), options);
  assert.equal((await nextFactory.available()).available, true);
  const path = join(root, 'profiles', 'zcode', '.dafeiyu-health.json');
  const marker = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(marker.cliVersion, '0.17.0');
  assert.ok(marker.authentication.every(item => !('content' in item) && !('token' in item)));
  const changedMetadata = structuredClone(marker);
  changedMetadata.authentication.push({ label: 'stale-provider-metadata', mtimeMs: 1, size: 1 });
  await writeFile(path, JSON.stringify(changedMetadata));
  assert.equal((await nextFactory.available()).reason, 'execution-unverified');
  await writeFile(path, JSON.stringify(marker));
  cliVersion = '0.18.0';
  assert.equal((await nextFactory.available()).reason, 'execution-unverified');
  assert.equal(calls.filter(call => call.args.at(-1) !== '--version').length, 1);
});

test('Failed ZCode tasks never create a ready marker', async t => {
  const { make, root } = await fixture(t);
  const worker = make('zcode', child => emit(child, 'failure', 1));
  assert.equal((await worker.run({ id: 'failed-z', prompt: 'fixture' })).status, 'failed');
  assert.equal((await worker.available()).reason, 'execution-unverified');
  await assert.rejects(access(join(root, 'profiles', 'zcode', '.dafeiyu-health.json')), { code: 'ENOENT' });
});

test('MiniMax authentication namespace persists across tasks and requires real execution verification', async t => {
  const { make, root, calls } = await fixture(t);
  const profile = join(root, 'profiles', 'minimax');
  const auth = join(profile, 'auth', 'prod', 'cn', 'mcode-public');
  await mkdir(auth, { recursive: true });
  const state = join(auth, 'auth-state.json');
  await writeFile(state, '{"status":"fixture-only"}');
  const worker = make('minimax', (child, call) => call.args.at(-1) === '--version'
    ? emit(child, '0.6.12') : emit(child, { type: 'exec.completed', result: mresult('checked') }));
  assert.equal((await worker.available()).reason, 'execution-unverified');
  assert.equal((await worker.run({ id: 'verify-1', prompt: 'fixture' })).status, 'succeeded');
  assert.equal((await worker.available()).available, true);
  assert.equal((await worker.run({ id: 'verify-2', prompt: 'fixture' })).status, 'succeeded');
  assert.equal(calls[1].options.env.MINIMAX_DATA_DIR, calls[3].options.env.MINIMAX_DATA_DIR);
  assert.equal((await stat(profile)).mode & 0o777, 0o700);
  const marker = JSON.parse(await readFile(join(profile, '.dafeiyu-health.json'), 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['authentication', 'cliVersion', 'verifiedAt', 'version']);
  assert.ok(!JSON.stringify(marker).includes('fixture-only'));
  // Logout/login/refresh updates native metadata; no credential payload is read.
  await writeFile(state, '{"status":"native-state-changed-after-logout"}');
  assert.equal((await worker.available()).available, false);
  assert.equal((await worker.available()).reason, 'execution-unverified');
});

test('MiniMax sign-in errors return a fixed actionable code without the original diagnostic', async t => {
  const { make } = await fixture(t);
  const value = await make('minimax', child => {
    child.stderr.write('mcode exec failed: Sign in to MiniMax to use Agent features. Run `mcode login`, then retry.');
    child.emit('close', 1, null);
  }).run({ id: 'needs-login', prompt: 'fixture' });
  assert.deepEqual(value, { executor: 'minimax', status: 'failed', errorCode: 'login-required' });
});

test('Unknown platform and missing sandbox fail closed before creating a child', async t => {
  const { make, calls } = await fixture(t);
  assert.equal((await make('zcode', null, { platform: 'linux' }).available()).reason, 'read-only-launcher-unavailable');
  assert.equal((await make('zcode', null, { sandboxCommand: '/nonexistent/dafeiyu-sandbox' }).available()).reason, 'read-only-launcher-unavailable');
  assert.equal(calls.length, 0);
});

test('Workspace traversal and symlink escape are rejected before spawn', async t => {
  const { root, make, calls } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'worker-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'escape'));
  const worker = make('zcode', child => emit(child, zresult('wrong')));
  assert.equal((await worker.run({ id: 'outside', prompt: 'read', cwd: outside })).errorCode, 'workspace-outside-root');
  assert.equal((await worker.run({ id: 'symlink', prompt: 'read', cwd: join(root, 'escape') })).errorCode, 'workspace-outside-root');
  assert.equal(calls.length, 0);
});

test('Invalid jobs and already cancelled jobs never start an executor', async t => {
  const { make, calls } = await fixture(t);
  const worker = make('zcode');
  for (const input of [{ id: '../escape', prompt: 'read' }, { id: 'j', prompt: '' }, { id: 'j', prompt: 'x'.repeat(65537) }]) {
    assert.equal((await worker.run(input)).errorCode, 'invalid-input');
  }
  const controller = new AbortController(); controller.abort();
  assert.equal((await worker.run({ id: 'cancel', prompt: 'read', signal: controller.signal })).status, 'cancelled');
  assert.equal(calls.length, 0);
});

test('Blocked private paths are host-owned absolute configuration, never job input', async t => {
  const { make, calls } = await fixture(t);
  for (const blockedPaths of [['relative/path'], ['../private'], 'not-an-array', ['/tmp/a\0b']]) {
    assert.throws(() => make('zcode', null, { blockedPaths }), /Invalid host-owned blocked paths/u);
  }
  const value = await make('zcode', child => emit(child, zresult('ok')))
    .run({ id: 'scope', prompt: 'fixture', blockedPaths: [] });
  assert.equal(value.status, 'succeeded'); assert.equal(calls.filter(call => call.args.at(-1) !== '--version').length, 1);
});

test('No final result, arbitrary text, drafts, and conflicting final events are rejected', async t => {
  const { make } = await fixture(t);
  for (const raw of ['this completed successfully', JSON.stringify({ type: 'message', response: 'draft' }),
    JSON.stringify(zresult('')), `${JSON.stringify(zresult('first'))}\n${JSON.stringify(zresult('second'))}`]) {
    const value = await make('zcode', child => emit(child, raw)).run({ id: 'invalid', prompt: 'read' });
    assert.deepEqual(value, { status: 'failed', executor: 'zcode', errorCode: 'invalid-result' });
  }
  for (const output of [null, { text: 'unvalidated object' }, '']) {
    const value = await make('minimax', child => emit(child, mresult(output))).run({ id: 'invalid-m', prompt: 'read' });
    assert.equal(value.errorCode, 'invalid-result');
  }
});

test('A non-zero exit overrides a success-looking stdout record and is never retried', async t => {
  const { make, calls } = await fixture(t);
  const value = await make('zcode', child => { child.stderr.write('token=SECRET'); emit(child, zresult('do not deliver'), 23); })
    .run({ id: 'failure', prompt: 'read' });
  assert.deepEqual(value, { status: 'failed', executor: 'zcode', errorCode: 'executor-failed' });
  assert.equal(calls.filter(call => call.args.at(-1) !== '--version').length, 1);
});

test('Cancellation terminates the child and suppresses a late final result', async t => {
  const { make, calls } = await fixture(t);
  const controller = new AbortController();
  const worker = make('minimax', child => { controller.abort(); child.stdout.write(`${JSON.stringify(mresult('late'))}\n`); });
  assert.equal((await worker.run({ id: 'cancel-running', prompt: 'read', signal: controller.signal })).status, 'cancelled');
  assert.deepEqual(calls[0].child.signals, ['SIGTERM']);
  assert.equal(calls.length, 1);
});

test('Timeout is unknown and cannot cause an automatic second execution', async t => {
  const { make, calls } = await fixture(t);
  const value = await make('zcode', () => {}, { timeoutMs: 5 }).run({ id: 'slow', prompt: 'read' });
  assert.deepEqual(value, { status: 'unknown', executor: 'zcode', errorCode: 'executor-timeout' });
  assert.equal(calls.length, 1);
});

test('Missing termination confirmation remains unknown after forced group-stop attempt', async t => {
  const { make, calls } = await fixture(t);
  const value = await make('zcode', () => {}, { timeoutMs: 5, closeOnKill: false }).run({ id: 'stuck', prompt: 'read' });
  assert.equal(value.status, 'unknown'); assert.equal(value.errorCode, 'termination-unconfirmed');
  assert.deepEqual(calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(calls.length, 1);
});

test('Combined stdout/stderr budgets kill the worker without returning its diagnostics', async t => {
  const { make, calls } = await fixture(t);
  const value = await make('zcode', child => { child.stdout.write('x'.repeat(100)); child.stderr.write('s'.repeat(100)); },
    { maxOutputBytes: 128 }).run({ id: 'flood', prompt: 'read' });
  assert.deepEqual(value, { status: 'unknown', executor: 'zcode', errorCode: 'output-limit' });
  assert.equal(calls.length, 1);
});

test('Chunked UTF-8 and final records without a newline are decoded without truncation', async t => {
  const { make } = await fixture(t);
  const value = await make('zcode', child => {
    const data = Buffer.from(JSON.stringify(zresult('中文结果')));
    for (let n = 0; n < data.length; n++) child.stdout.write(data.subarray(n, n + 1));
    child.emit('close', 0, null);
  }).run({ id: 'utf8', prompt: 'read' });
  assert.equal(value.text, '中文结果');
});

test('Progress callback failures cannot fail or repeat task execution', async t => {
  const { make, calls } = await fixture(t);
  const worker = make('minimax', child => emit(child, { schemaVersion: 1, type: 'exec.completed', result: mresult('ok') }));
  assert.equal((await worker.run({ id: 'progress', prompt: 'read', onProgress: () => Promise.reject(new Error('unavailable')) })).status, 'succeeded');
  assert.equal(calls.filter(call => call.args.at(-1) !== '--version').length, 1);
});

test('Read-only sandbox blocks workspace writes and reads outside the supplied workspace', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'external-real-sandbox-'));
  const outside = await mkdtemp(join(tmpdir(), 'external-private-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sentinel = join(root, 'sentinel'); await writeFile(sentinel, 'original');
  const privateFile = join(outside, 'private'); await writeFile(privateFile, 'must-not-read');
  const script = join(root, 'fixture.mjs');
  await writeFile(script, `#!${process.execPath}\nimport { writeFileSync,readFileSync } from 'node:fs';\nlet blocked=false,privateBlocked=false;try{writeFileSync(${JSON.stringify(sentinel)},'changed')}catch{blocked=true};try{readFileSync(${JSON.stringify(privateFile)})}catch{privateBlocked=true};\nconsole.log(JSON.stringify({type:'result',projection:{status:'completed'},response:blocked&&privateBlocked?'blocked':'unrestricted'}));\n`);
  await chmod(script, 0o700);
  const value = await createExternalExecutor({ kind: 'zcode', command: script, cwdRoot: root }).run({ id: 'real-guard', prompt: 'fixture' });
  assert.equal(value.status, 'succeeded'); assert.equal(value.text, 'blocked');
  assert.equal(await readFile(sentinel, 'utf8'), 'original');
});

test('Real sandbox denies private workspace paths and canonical aliases while allowing ordinary source', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'external-private-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sensitive = ['memory/facts.json', 'packages/companion/config.json', 'packages/companion/role.md',
    'packages/companion/data/private.json', 'packages/dsh-dafeiyu/data/private.json',
    'packages/dsh-dafeiyu/config.json', '.env', 'notes/host-private.md'];
  for (const file of sensitive) {
    const path = join(root, file); await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'private fixture');
  }
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'public.js'), 'export const publicValue = 1;');
  const alias = join(root, 'notes', 'private-alias');
  await symlink(join(root, 'notes', 'host-private.md'), alias);
  const script = join(root, 'fixture.mjs');
  await writeFile(script, `#!${process.execPath}\nimport { readFileSync } from 'node:fs';\nconst privatePaths=${JSON.stringify(sensitive.map(file => join(root, file)))};let denied=0;for(const path of privatePaths){try{readFileSync(path)}catch{denied++}};let source=false;try{source=readFileSync(${JSON.stringify(join(root, 'src', 'public.js'))},'utf8').includes('publicValue')}catch{};console.log(JSON.stringify({type:'result',projection:{status:'completed'},response:JSON.stringify({denied,source})}));\n`);
  await chmod(script, 0o700);
  const value = await createExternalExecutor({ kind: 'zcode', command: script, cwdRoot: root,
    profileDir: join(root, 'worker-state'), blockedPaths: [alias, join(root, 'absent-private-file')] })
    .run({ id: 'private-boundary', prompt: 'fixture' });
  assert.equal(value.status, 'succeeded');
  assert.deepEqual(JSON.parse(value.text), { denied: sensitive.length, source: true });
});

test('MiniMax native sibling migration lock is permitted without granting its parent directory', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'external-lock-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'managed', 'minimax');
  await mkdir(join(profile, 'agents'), { recursive: true });
  await writeFile(join(profile, 'agents', 'custom-private.md'), 'must not read custom agents');
  const script = join(root, 'fixture.mjs');
  await writeFile(script, `#!${process.execPath}\nimport {mkdirSync,rmdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';\nif(process.argv.includes('--version')){console.log('0.6.12')}else{let lock=false,parentBlocked=false,builtin=false,customBlocked=false,agentDirectory=false;try{mkdirSync(${JSON.stringify(`${profile}.lock`)});rmdirSync(${JSON.stringify(`${profile}.lock`)});lock=true}catch{};try{writeFileSync(${JSON.stringify(join(root, 'managed', 'other-file'))},'must-not-write')}catch{parentBlocked=true};try{agentDirectory=Array.isArray(readdirSync(${JSON.stringify(join(profile, 'agents'))}))}catch{};try{mkdirSync(${JSON.stringify(join(profile, 'agents', '.builtin', 'mavis'))},{recursive:true});writeFileSync(${JSON.stringify(join(profile, 'agents', '.builtin', 'mavis', '.agent.md.publish'))},'public builtin template');builtin=readFileSync(${JSON.stringify(join(profile, 'agents', '.builtin', 'mavis', '.agent.md.publish'))},'utf8')==='public builtin template'}catch{};try{readFileSync(${JSON.stringify(join(profile, 'agents', 'custom-private.md'))})}catch{customBlocked=true};console.log(JSON.stringify({schemaVersion:1,type:'exec.result',runId:'r',sessionId:'s',turnId:'t',status:'succeeded',durationMs:1,output:JSON.stringify({lock,parentBlocked,builtin,customBlocked,agentDirectory})}));}\n`);
  await chmod(script, 0o700);
  const value = await createExternalExecutor({ kind: 'minimax', command: script, cwdRoot: root, profileDir: profile })
    .run({ id: 'migration-lock', prompt: 'fixture' });
  assert.equal(value.status, 'succeeded');
  assert.deepEqual(JSON.parse(value.text), { lock: true, parentBlocked: true, builtin: true, customBlocked: true, agentDirectory: true });
});
