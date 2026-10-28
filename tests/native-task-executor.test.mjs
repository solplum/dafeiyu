import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeTaskExecutor } from '../packages/dsh-dafeiyu/src/native-task-executor.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const completed = (text = '离线子任务结果') => ({ stopReason: 'completed', output: [{ type: 'text', text }] });
function fixture({ provider = 'spawn', result, start, dispose, selected, tokenBudget, controlAccess } = {}) {
  const terminal = deferred(), calls = [], progress = [];
  const parent = { id: 'real-parent', session: { id: 'real-parent', header: { delegationDepth: 0 }, requestHeader: () => undefined },
    options: { provider: 'host-provider', model: 'host-model', reasoningEffort: 'high', subagentDepth: 0 } };
  const providers = { spawn: { name: 'spawn', capabilities: { depthLimit: true, agentOptions: true, agentPreset: true }, prepareContinuable() {} },
    codex: { name: 'codex', capabilities: {}, start() {} } };
  let disposed = 0;
  const receipt = { childId: 'actual-child', result: result || terminal.promise,
    async dispose() { disposed++; if (dispose) return dispose(); } };
  const services = { agents: { get: (id) => id === parent.id ? parent : undefined }, subagents: {
    getProvider: (name) => selected === undefined ? providers[name] : selected,
    async startActivation(spec) { calls.push(spec); return start ? start(spec, receipt) : receipt; },
  } };
  const executor = createNativeTaskExecutor({ ctx: { get: (name) => services[name] }, provider, tokenBudget, controlAccess });
  return { executor, parent, services, terminal, receipt, calls, progress, get disposed() { return disposed; },
    run: (patch = {}) => executor.run({ id: 'job-1', prompt: '只读离线任务', cwd: '/fixture/workspace', parent,
      onProgress: (event) => progress.push(event), ...patch }) };
}

test('availability uses the registered actual provider and fails closed without required service capabilities', () => {
  for (const provider of ['spawn', 'native', 'codex']) assert.deepEqual(fixture({ provider }).executor.available(), { available: true });
  for (const provider of ['missing', '../bad']) assert.deepEqual(fixture({ provider }).executor.available(), { available: false });
  assert.deepEqual(createNativeTaskExecutor().available(), { available: false });
  assert.deepEqual(fixture({ selected: {} }).executor.available(), { available: false });
});

test('native starts one caller-delivered activation with the exact parent, explicit route and depth, then waits for real cleanup', async () => {
  const cleanup = deferred(), f = fixture({ dispose: () => cleanup.promise }); let finished = false;
  const run = f.run().then((result) => { finished = true; return result; }); await tick();
  assert.equal(f.calls.length, 1); const spec = f.calls[0];
  assert.equal(spec.provider, 'spawn'); assert.equal(spec.delivery, 'caller'); assert.equal(spec.request.parent, f.parent);
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: '只读离线任务' }]); assert.equal(spec.request.cwd, '/fixture/workspace');
  assert.equal(spec.request.maxDepth, 1); assert.deepEqual(spec.request.agentOptions, { provider: 'host-provider', model: 'host-model', reasoningEffort: 'high' });
  assert.equal(spec.request.agentPreset, undefined); assert.equal(spec.signal.aborted, false);
  f.terminal.resolve(completed()); await tick(); assert.equal(f.disposed, 1); assert.equal(finished, false);
  cleanup.resolve(); assert.deepEqual(await run, { status: 'succeeded', executor: 'spawn', text: '离线子任务结果' });
  assert.equal(f.progress.length, 1); assert.equal(f.progress[0].childId, 'actual-child');
});

test('the current request route and monotone persisted delegation depth take precedence over creation options', async () => {
  const f = fixture({ result: Promise.resolve(completed()) });
  f.parent.session.requestHeader = () => ({ config: { provider: 'current-provider', model: 'current-model' } });
  f.parent.session.header.delegationDepth = 3; f.parent.options.subagentDepth = 1;
  await f.run(); assert.equal(f.calls[0].request.maxDepth, 4);
  assert.deepEqual(f.calls[0].request.agentOptions, { provider: 'current-provider', model: 'current-model' });
});

test('external Codex omits unsupported native route, preset and depth fields and does not inherit parent turn cancellation', async () => {
  const parentTurn = new AbortController(), job = new AbortController();
  const f = fixture({ provider: 'codex', result: Promise.resolve(completed('外部结果')) });
  f.parent.options.signal = parentTurn.signal; parentTurn.abort();
  assert.deepEqual(await f.run({ signal: job.signal }), { status: 'succeeded', executor: 'codex', text: '外部结果' });
  const spec = f.calls[0]; assert.equal(spec.signal.aborted, false); assert.notEqual(spec.signal, job.signal);
  assert.deepEqual(Object.keys(spec.request).sort(), ['cwd', 'parent', 'prompt']); assert.equal(f.disposed, 1);
});

test('unknown or copied parent objects and invalid inputs never start an activation', async () => {
  const f = fixture();
  for (const patch of [{ parent: { ...f.parent } }, { parent: { id: 'foreign', session: { id: 'foreign' } } },
    { id: '' }, { prompt: '' }, { prompt: 'x'.repeat(64001) }, { cwd: 'relative/path' }, { cwd: '/bad\0path' }, { signal: {} }]) {
    assert.equal((await f.run(patch)).status, 'failed');
  }
  assert.equal(f.calls.length, 0);
});

test('native depth and route errors fail before service startup without expanding delegated capabilities', async () => {
  for (const value of [-1, -0, NaN, 1.5, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(); f.parent.options.subagentDepth = value;
    assert.equal((await f.run()).errorCode, 'invalid-parent-depth'); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.parent.options.model = '';
  assert.equal((await f.run()).errorCode, 'model-unavailable'); assert.equal(f.calls.length, 0);
});

test('only selected final text is returned; thoughts, tool output, diagnostics and non-completed partial text never become success', async () => {
  const f = fixture({ result: Promise.resolve({ stopReason: 'completed', output: [
    { type: 'thinking', text: 'PRIVATE_THOUGHT' }, { type: 'text', text: '最终一' }, { type: 'image', path: '/private/image' }, { type: 'text', text: '最终二' },
  ], diagnostic: 'PRIVATE_DIAGNOSTIC' }) });
  assert.deepEqual(await f.run(), { status: 'succeeded', executor: 'spawn', text: '最终一\n最终二' });
  for (const [stopReason, status, errorCode] of [['error', 'failed', 'execution'], ['refusal', 'failed', 'refusal'],
    ['max-tokens', 'failed', 'max-tokens'], ['aborted', 'cancelled', 'cancelled'], ['unrecognized', 'unknown', 'invalid-result']]) {
    const current = fixture({ result: Promise.resolve({ stopReason, output: [{ type: 'text', text: 'PRIVATE_PARTIAL' }], diagnostic: 'PRIVATE_ERROR' }) });
    assert.deepEqual(await current.run(), { status, executor: 'spawn', errorCode }); assert.equal(current.disposed, 1);
  }
  for (const output of [[], [{ type: 'text', text: ' ' }], [{ type: 'text', text: '准备执行' }, { type: 'tool-call' }], [{ type: 'text', text: 'x'.repeat(64001) }]]) {
    assert.equal((await fixture({ result: Promise.resolve({ stopReason: 'completed', output }) }).run()).errorCode, 'no-result');
  }
});

test('pre-aborted jobs do not start any child', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture();
  assert.deepEqual(await f.run({ signal: controller.signal }), { status: 'cancelled', executor: 'spawn', errorCode: 'cancelled' });
  assert.equal(f.calls.length, 0); assert.equal(f.disposed, 0);
});

test('accepted cancellation disposes the exact activation and waits for both terminal result and cleanup before confirming cancellation', async () => {
  const controller = new AbortController(), cleanup = deferred(); const f = fixture({ dispose: () => cleanup.promise }); let finished = false;
  const run = f.run({ signal: controller.signal }).then((result) => { finished = true; return result; }); await tick();
  controller.abort(); await tick(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.disposed, 1); assert.equal(finished, false);
  cleanup.resolve(); await tick(); assert.equal(finished, false, 'cleanup alone does not prove result settlement');
  f.terminal.resolve({ stopReason: 'aborted', output: [] });
  assert.deepEqual(await run, { status: 'cancelled', executor: 'spawn', errorCode: 'cancelled' }); assert.equal(f.calls.length, 1);
});

test('cancellation during pending startup waits for a late receipt and cleans it instead of leaking a child', async () => {
  const startup = deferred(), controller = new AbortController();
  const f = fixture({ start: () => startup.promise }); let finished = false;
  const run = f.run({ signal: controller.signal }).then((result) => { finished = true; return result; }); await tick();
  controller.abort(); await tick(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(finished, false); assert.equal(f.disposed, 0);
  startup.resolve(f.receipt); await tick(); assert.equal(f.disposed, 1); assert.equal(finished, false);
  f.terminal.resolve({ stopReason: 'aborted', output: [] });
  assert.equal((await run).status, 'cancelled'); assert.equal(f.progress.length, 0); assert.equal(f.calls.length, 1);
});

test('startup rollback and capacity errors remain sanitized, with no retries or provider substitution', async () => {
  for (const [code, errorCode] of [['ACTIVATION_LIMIT_REACHED', 'capacity'], ['UNAUTHORIZED', 'parent-unavailable'],
    ['NO_PROVIDER', 'unavailable'], ['PRIVATE_CODE', 'start-failed']]) {
    const f = fixture({ start: () => { throw Object.assign(new Error('PRIVATE_START_DETAILS'), { code }); } });
    assert.deepEqual(await f.run(), { status: 'failed', executor: 'spawn', errorCode }); assert.equal(f.calls.length, 1);
  }
  const controller = new AbortController();
  const f = fixture({ start: () => { controller.abort(); throw new DOMException('PRIVATE_ROLLBACK', 'AbortError'); } });
  assert.equal((await f.run({ signal: controller.signal })).status, 'cancelled');
});

test('cleanup rejection returns unknown even if the result claimed completion or cancellation', async () => {
  for (const stopReason of ['completed', 'aborted']) {
    const f = fixture({ result: Promise.resolve({ stopReason, output: [{ type: 'text', text: 'UNCONFIRMED' }] }),
      dispose: () => { throw new Error('PRIVATE_CLEANUP_FAILURE'); } });
    assert.deepEqual(await f.run(), { status: 'unknown', executor: 'spawn', errorCode: 'cleanup-unconfirmed' });
  }
  const controller = new AbortController();
  const f = fixture({ dispose: () => { throw new Error('PRIVATE_CLEANUP_FAILURE'); } });
  const run = f.run({ signal: controller.signal }); await tick(); controller.abort();
  assert.equal((await run).status, 'unknown'); f.terminal.resolve({ stopReason: 'aborted', output: [] });
});

test('result rejection is contained, cleanup is awaited, and progress observer exceptions never alter execution', async () => {
  const failed = Promise.reject(new Error('PRIVATE_PROVIDER_FAILURE'));
  const f = fixture({ result: failed });
  assert.deepEqual(await f.run({ onProgress: () => { throw new Error('PRIVATE_LISTENER'); } }), { status: 'failed', executor: 'spawn', errorCode: 'execution' });
  assert.equal(f.disposed, 1);
  const succeeded = fixture({ result: Promise.resolve(completed()) });
  assert.equal((await succeeded.run({ onProgress: async () => { throw new Error('PRIVATE_ASYNC_LISTENER'); } })).status, 'succeeded');
  await tick();
});

test('invalid receipts fail closed and still invoke a provided cleanup capability', async () => {
  const f = fixture({ start: (_spec, receipt) => ({ ...receipt, childId: undefined }) });
  f.terminal.resolve(completed()); assert.equal((await f.run()).status, 'unknown'); assert.equal(f.disposed, 1);
  const g = fixture({ start: () => ({ childId: 'missing-capability', result: Promise.resolve(completed()) }) });
  assert.equal((await g.run()).errorCode, 'invalid-receipt');
});

const diagnostic = (stage = 'turn', category = 'service', httpStatus) =>
  `Product subagent failure (product: Codex; stage: ${stage}; category: ${category}${httpStatus === undefined ? '' : '; HTTP status: ' + httpStatus})`;

test('Codex failures expose only fixed stage, category and numeric HTTP facts after actual activation cleanup', async () => {
  const f = fixture({ provider: 'codex', result: Promise.resolve({ stopReason: 'error',
    output: [{ type: 'text', text: 'PRIVATE_PARTIAL_OUTPUT' }], error: 'PRIVATE_RAW_ERROR',
    diagnostic: diagnostic('turn', 'service', 400) + '\nPRIVATE_API_KEY_AND_PERMISSION_DETAILS',
  }) });
  const result = await f.run();
  assert.deepEqual(result, { status: 'failed', executor: 'codex', errorCode: 'service',
    diagnosticFacts: { stage: 'turn', category: 'service', httpStatus: 400 } });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(f.disposed, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].delivery, 'caller'); assert.equal(f.calls[0].request.parent, f.parent);
});

test('Codex classifies fixed HTTP and provider categories without treating access policy as a login failure', async () => {
  for (const [category, httpStatus, errorCode] of [
    ['transport', 401, 'login-required'], ['transport', 403, 'access-policy'], ['transport', 429, 'quota'],
    ['unknown', 503, 'service'], ['transport', 408, 'transport'], ['service', 400, 'service'],
    ['access-policy', undefined, 'access-policy'], ['limit', undefined, 'quota'],
    ['product-error', undefined, 'product-error'], ['invalid-result', undefined, 'no-result'], ['unknown', undefined, 'execution'],
  ]) {
    const f = fixture({ provider: 'codex', result: Promise.resolve({ stopReason: 'error', output: [], diagnostic: diagnostic('turn', category, httpStatus) }) });
    const result = await f.run();
    assert.equal(result.errorCode, errorCode); assert.equal(result.status, 'failed');
    assert.deepEqual(result.diagnosticFacts, { stage: 'turn', category, ...(httpStatus === undefined ? {} : { httpStatus }) });
    assert.equal(f.calls.length, 1, 'diagnosis must not start another activation');
  }
});

test('unknown diagnostic strings and secrets cannot supply arbitrary facts, while other providers never parse Codex facts', async () => {
  for (const value of [
    'PRIVATE_KEY sk-fixture-123 HTTP status: 401', diagnostic('PRIVATE_STAGE', 'service', 400),
    diagnostic('turn', 'PRIVATE_CATEGORY', 400), diagnostic('turn', 'service', 'PRIVATE_KEY'),
    diagnostic('turn', 'service', '400; token: PRIVATE_TOKEN'), diagnostic('turn', 'service', 65536),
    diagnostic('turn', 'service', -1), diagnostic('turn', 'service', 4.5),
    diagnostic().replace('product: Codex', 'product: PRIVATE_PRODUCT'),
    diagnostic() + ' PRIVATE_TRAILING_SECRET', 'x'.repeat(4097),
    { diagnostic: diagnostic(), secret: 'PRIVATE_OBJECT' }, undefined,
  ]) {
    const f = fixture({ provider: 'codex', result: Promise.resolve({ stopReason: 'error', output: [], diagnostic: value }) });
    const result = await f.run();
    assert.deepEqual(result, { status: 'failed', executor: 'codex', errorCode: 'execution' });
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
  const native = fixture({ result: Promise.resolve({ stopReason: 'error', output: [], diagnostic: diagnostic('turn', 'transport', 401) }) });
  assert.deepEqual(await native.run(), { status: 'failed', executor: 'spawn', errorCode: 'execution' });
});

test('fixed Codex process diagnostics drop process details and accept only the installed stage and category enums', async () => {
  for (const stage of ['initialize', 'thread-start', 'turn-start', 'turn', 'teardown', 'process']) {
    const f = fixture({ provider: 'codex', result: Promise.resolve({ stopReason: 'error', output: [],
      diagnostic: diagnostic(stage, 'process').replace(/\)$/, '; exit code: 23; signal: SIGTERM)'),
    }) });
    assert.deepEqual((await f.run()).diagnosticFacts, { stage, category: 'process' });
  }
  for (const httpStatus of [0, 65535]) {
    const f = fixture({ provider: 'codex', result: Promise.resolve({ stopReason: 'error', output: [], diagnostic: diagnostic('turn', 'transport', httpStatus) }) });
    assert.deepEqual((await f.run()).diagnosticFacts, { stage: 'turn', category: 'transport', httpStatus });
  }
});

test('Codex diagnostics preserve refusal, token limits and no-result behavior and never qualify a failed cleanup as stopped', async () => {
  for (const stopReason of ['refusal', 'max-tokens']) {
    const f = fixture({ provider: 'codex', result: Promise.resolve({ stopReason, output: [], diagnostic: diagnostic('turn', 'limit') }) });
    assert.deepEqual(await f.run(), { status: 'failed', executor: 'codex', errorCode: stopReason,
      diagnosticFacts: { stage: 'turn', category: 'limit' } });
  }
  const empty = fixture({ provider: 'codex', result: Promise.resolve({ stopReason: 'completed', output: [], diagnostic: diagnostic('turn', 'service', 401) }) });
  assert.deepEqual(await empty.run(), { status: 'failed', executor: 'codex', errorCode: 'no-result' });
  const success = fixture({ provider: 'codex', result: Promise.resolve({ ...completed('SAFE_FINAL_ONLY'), diagnostic: diagnostic('turn', 'service', 401) }) });
  assert.deepEqual(await success.run(), { status: 'succeeded', executor: 'codex', text: 'SAFE_FINAL_ONLY' });
  const cleanup = fixture({ provider: 'codex', dispose() { throw new Error('PRIVATE_CLEANUP_FAILURE'); },
    result: Promise.resolve({ stopReason: 'error', output: [], diagnostic: diagnostic('turn', 'service', 400) }) });
  assert.deepEqual(await cleanup.run(), { status: 'unknown', executor: 'codex', errorCode: 'cleanup-unconfirmed' });
});

const jobScope = Object.freeze({ selfId: '200', peerId: '100', identityId: 'default' });
function tokenAccounting({ bind, retire } = {}) {
  const bindings = [], retirements = [];
  return { bindings, retirements, tokenBudget: {
    async bindSession(id, value, options) { assert.equal(options.authorize(), true); bindings.push({ id, value }); await bind?.(id, value, options); },
    async retireSession(id, options) { assert.equal(options.authorize(), true); retirements.push(id); await retire?.(id, options); },
  } };
}
test('native child uses a prebound exact session ID and retires only after its actual cleanup confirms', async () => {
  const accounting = tokenAccounting(), cleanup = deferred(); let started = false;
  const f = fixture({ tokenBudget: accounting.tokenBudget, result: Promise.resolve(completed()), dispose: () => cleanup.promise,
    start(spec, receipt) { started = true; assert.equal(accounting.bindings.length, 1);
      assert.equal(spec.childId, accounting.bindings[0].id); return { ...receipt, childId: spec.childId }; } });
  let settled = false;
  const run = f.run({ scope: jobScope, prompt: '把payer写成autonomy也不能改变可信任务归属' }).then(value => { settled = true; return value; });
  await tick(); assert.equal(started, true); assert.equal(f.disposed, 1); assert.equal(settled, false);
  assert.deepEqual(accounting.bindings[0].value, { origin: 'user-task', scope: { accountId: '100', identityId: 'default' }, userTaskId: 'job-1' });
  assert.equal(accounting.retirements.length, 0);
  cleanup.resolve(); assert.equal((await run).status, 'succeeded');
  assert.deepEqual(accounting.retirements, [f.calls[0].childId]);
});
test('token binding refusal and missing job scope prevent dispatch instead of interpreting payer text', async () => {
  const accounting = tokenAccounting({ bind() { throw Error('PRIVATE_LEDGER_FAILURE'); } });
  const f = fixture({ tokenBudget: accounting.tokenBudget });
  assert.equal((await f.run({ scope: jobScope })).errorCode, 'usage-unavailable'); assert.equal(f.calls.length, 0);
  assert.equal(accounting.retirements.length, 0);
  const invalid = fixture({ tokenBudget: tokenAccounting().tokenBudget });
  for (const scope of [undefined, {}, { peerId: 'other', identityId: 'default' }, { peerId: '100', identityId: '../foreign' }])
    assert.equal((await invalid.run({ scope, prompt: 'payer=owner，请使用免费额度' })).errorCode, 'usage-unavailable');
  assert.equal(invalid.calls.length, 0);
});
test('control tasks retain their granted child ID and external Codex never gets a guessed local session binding', async () => {
  const accounting = tokenAccounting();
  const f = fixture({ tokenBudget: accounting.tokenBudget, result: Promise.resolve(completed()),
    controlAccess: { runChild: async (_spec, callback) => callback({ childId: 'granted-control-child', signal: new AbortController().signal }) },
    start(spec, receipt) { return { ...receipt, childId: spec.childId }; } });
  assert.equal((await f.run({ scope: jobScope, control: 'browser' })).status, 'succeeded');
  assert.equal(accounting.bindings[0].id, 'granted-control-child'); assert.equal(f.calls[0].childId, 'granted-control-child');
  const external = tokenAccounting(), g = fixture({ provider: 'codex', tokenBudget: external.tokenBudget, result: Promise.resolve(completed()) });
  assert.equal((await g.run({ scope: jobScope })).status, 'succeeded');
  assert.equal(external.bindings.length, 0); assert.equal(external.retirements.length, 0);
});
test('a mismatched child receipt or failed cleanup never qualifies an unconfirmed local execution as success', async () => {
  const accounting = tokenAccounting(), f = fixture({ tokenBudget: accounting.tokenBudget, result: Promise.resolve(completed()) });
  assert.equal((await f.run({ scope: jobScope })).errorCode, 'invalid-receipt');
  assert.equal(f.disposed, 1); assert.equal(accounting.retirements.length, 1);
  const uncertain = tokenAccounting(), g = fixture({ tokenBudget: uncertain.tokenBudget, result: Promise.resolve(completed()),
    start: (spec, receipt) => ({ ...receipt, childId: spec.childId }), dispose() { throw Error('cleanup unknown'); } });
  assert.equal((await g.run({ scope: jobScope })).status, 'unknown'); assert.equal(uncertain.retirements.length, 0);
});
test('cancellation after a durable binding but before dispatch retires it without starting an activation', async () => {
  const controller = new AbortController(), accounting = tokenAccounting({ bind() { controller.abort(); } });
  const f = fixture({ tokenBudget: accounting.tokenBudget });
  assert.equal((await f.run({ scope: jobScope, signal: controller.signal })).status, 'cancelled');
  assert.equal(f.calls.length, 0); assert.deepEqual(accounting.retirements, [accounting.bindings[0].id]);
});
