import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomyEngine, RECOMMENDATION_TOPIC } from '../packages/dsh-dafeiyu/src/autonomy-engine.js';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { createAutonomyRunner, AUTONOMOUS_DOUYIN_TOOL, createAutonomyUserPriority } from '../packages/dsh-dafeiyu/src/autonomy-runner.js';
import { createControlAccess } from '../packages/dsh-dafeiyu/src/control-access.js';
const scope = { accountId: '200', identityId: 'default' }, yes = () => true;
function engineFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-douyin-auto-'));
  let now = Date.parse('2026-10-27T04:00:00Z'), ready = true;
  const memory = new LifeMemory({ directory, now: () => now }), calls = [];
  const engine = new AutonomyEngine({ memory, scopes: () => [scope], now: () => now, random: () => 0,
    browseReady: platform => platform === 'douyin' && ready,
    run: async (activity, options) => { calls.push({ activity, options }); return { status: 'succeeded', text: '观察到的网页文字' }; },
    send: () => assert.fail('browse must never send QQ') });
  engine.configure({ enabled: true, browse: true, proactive: false, platforms: ['douyin'], targets: [scope], quietEnabled: false }, { authorize: yes });
  engine.wallet.configure({ enabled: true, dailySeconds: 600, monthlySeconds: 0 }, { authorize: yes });
  t.after(async () => { await engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { engine, memory, calls, setReady(value) { ready = value; }, setNow(value) { now = value; } };
}
test('official recommendation is an explicit source type without inventing a user memory or enabling greetings', async t => {
  const f = engineFixture(t), before = fs.readFileSync(f.memory.store.file);
  assert.equal(f.engine.preview().reasonCode, 'RECOMMENDATION_READY');
  assert.deepEqual(fs.readFileSync(f.memory.store.file), before);
  await f.engine.tick(); const row = f.engine.snapshot().activities[0];
  assert.equal(row.origin, 'recommendation'); assert.equal(row.topic, RECOMMENDATION_TOPIC);
  assert.equal(Object.hasOwn(row, 'sourceId'), false); assert.equal(Object.hasOwn(row, 'sourceFingerprint'), false);
  assert.equal(f.engine.snapshot().policy.greetingEnabled, false); assert.equal(f.memory.snapshot().items.length, 0);
  assert.equal(f.engine.sourceCurrent(row), true);
  for (const patch of [{ origin: 'memory' }, { sourceId: 'a'.repeat(64) }, { sourceFingerprint: 'a'.repeat(64) }, { platform: 'bilibili' }, { topic: '伪造用户兴趣' }, { scope: { ...scope, identityId: 'other' } }])
    assert.equal(f.engine.sourceCurrent({ ...row, ...patch }), false);
  f.setNow(row.dueAt); await f.engine.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.context, '');
  assert.equal(f.engine.snapshot().activities[0].status, 'completed');
});
test('recommendation admission respects readiness, targets, quota, pause switches and existing unknown records', async t => {
  const f = engineFixture(t); f.setReady(false);
  assert.equal(f.engine.preview().reasonCode, 'BROWSE_UNAVAILABLE');
  await f.engine.tick(); assert.equal(f.engine.snapshot().activities.length, 0);
  f.setReady(true); f.engine.configure({ browse: false }, { authorize: yes });
  assert.equal(f.engine.preview().reasonCode, 'NO_ACTION');
  f.engine.configure({ browse: true, targets: [] }, { authorize: yes }); assert.equal(f.engine.preview().reasonCode, 'NO_TARGETS');
  f.engine.configure({ targets: [scope] }, { authorize: yes }); f.setNow(f.engine.snapshot().nextAt); await f.engine.tick();
  const row = f.engine.snapshot().activities[0]; f.engine.configure({ platforms: ['bilibili'] }, { authorize: yes });
  assert.equal(f.engine.sourceCurrent(row), false); assert.equal(f.engine.permitted(row), false);
  f.engine.configure({ platforms: ['douyin'] }, { authorize: yes });
  f.memory.store.update(state => { state.autonomy.activities[0].status = 'unknown'; }, { authorize: yes });
  assert.equal(f.engine.preview().reasonCode, 'UNKNOWN_ACTIVITY');
});
function runnerFixture({ actions = ['open', 'current', 'next'], fail, cleanupFails = false, controller = new AbortController(), onStep, cooldown = 0, continueAfterError = false, onSnapshot, beforeDispatchFailure = false, toolSignal, onBrowse, taskSpaceClosed = false, onEvidence, receiptText = '', onUsage } = {}) {
  const handlers = new Map(), registry = new Map(), globalGuards = [], calls = [], creations = [], denied = [], usage = [], budgetEvents = [];
  let currentRuntime = {}, createdAgent, disposed = 0, turn = 0, ready = true, metadataReady = false, checks = 0, followups = 0, snapshots = 0;
  const fire = async (name, ...args) => { for (const fn of handlers.get(name) || []) await fn(...args); };
  const services = { agentDefaultModel: { currentSelection: () => ({ provider: 'offline', model: 'fixture' }) },
    tools: { guard(fn) { globalGuards.push(fn); return () => globalGuards.splice(globalGuards.indexOf(fn), 1); } },
    agents: { get: id => registry.get(id), withoutInitiator: fn => fn(), async create(spec) {
      creations.push(spec); const definitions = new Map(), localGuards = []; let allow = [];
      const tools = { register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); },
        restrict(filter) {
          if (filter.allow.some(name => definitions.has(name))) throw Error('real host: own scope tool is not a restrictable global');
          allow = filter.allow;
        }, presentAs() {}, guard(fn) { localGuards.push(fn); },
        async execute(name, args = {}) {
          const exec = { agent, name, arguments: args, signal: toolSignal || controller.signal, callId: 'tool-' + Math.random() };
          if (!definitions.has(name) && !allow.includes(name)) throw Error('restricted');
          for (const guard of [...globalGuards, ...localGuards]) if (guard(exec)) throw Error('denied');
          let next = () => definitions.get(name).execute(args, exec);
          for (const fn of [...(handlers.get('tools/execute') || [])].reverse()) { const previous = next; next = () => fn(exec, previous); }
          return next();
        } };
      const agent = { id: spec.sessionId, session: { id: spec.sessionId }, ctx: { get: key => key === 'tools' ? tools : services[key] }, cancel() {},
        followup(message) { followups++; return Promise.resolve().then(async () => {
          const n = ++turn; await fire('agent/inbox/claimed', { agent, message, turn: n });
          await fire('session/event', agent.session, { type: 'turn/start', data: { turn: n } });
          for (const name of ['bash', 'ego_space_open', 'dafeiyu_social_execute', 'dafeiyu_social_browse', 'qq_send', 'phone_screenshot']) {
            await assert.rejects(tools.execute(name)); denied.push(name);
          }
          let last;
          try {
            for (const action of actions) {
              try { last = await tools.execute(AUTONOMOUS_DOUYIN_TOOL, { action, ...(action === 'next' ? { expectedVideoId: last?.current?.id } : {}) }); await onStep?.(action, controller, agent); }
              catch (error) { if (!continueAfterError) throw error; }
            }
            await fire('session/event', agent.session, { type: 'assistant/message', surfaceOp: 'append', data: { turn: n, message: { content: [{ type: 'text', text: '仅实际页面文字概括' }] } } });
            await fire('session/event', agent.session, { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } });
          } catch (error) { await fire('session/event', agent.session, { type: 'turn/end', data: { turn: n, reason: { kind: 'failed' } } }); }
        }); } };
      registry.set(agent.id, agent); createdAgent = agent; await spec.setup(agent.ctx, agent);
      return { agent, async dispose() { disposed++; registry.delete(agent.id); } };
    } } };
  const ctx = { get: key => services[key], on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); return () => list.splice(list.indexOf(fn), 1); } };
  const access = createControlAccess({ ctx, getRuntime: () => currentRuntime, resolveOwner: () => false }); access.attach();
  let observed = 0, state = 'stopped';
  const socialAccounts = { snapshot: () => {
      const row = { platform: 'douyin', state: 'bound', accountId: 'bound-platform-account', generation: 1, driverConfigured: true, driverAvailable: metadataReady, safetyPause: null, browse: { state, cooldownRemainingMs: cooldown } };
      onSnapshot?.(row, ++snapshots); return { revision: 'fixture-revision', platforms: [row] };
    },
    async checkBrowser(body, context) { checks++; assert.deepEqual(body, { platform: 'douyin', revision: 'fixture-revision' }); assert.equal(context.authorize(), true); metadataReady = ready; return { browser: { ready } }; },
    async browse(platform, request, context) {
      assert.equal(platform, 'douyin'); assert.equal(context.authorize(), true); calls.push(request.action);
      if (beforeDispatchFailure && request.action === 'open') throw Object.assign(Error('owner claimed feed before actual dispatch'), { code: 'AUTONOMY_PRECONDITION' });
      if (['open', 'current', 'next'].includes(request.action)) context.onBrowseDispatch?.();
      await onBrowse?.(request.action, context);
      if (request.action === fail || request.action === 'stop' && cleanupFails) throw Object.assign(Error('fixture failure'), { code: 'BROWSER_UNKNOWN' });
      if (request.action === 'stop') { state = 'stopped'; return { ok: true, state, browserStopped: false, spaceRetained: !taskSpaceClosed, ...(taskSpaceClosed ? { taskSpaceClosed: true } : {}) }; }
      state = 'active'; if (request.action === 'next' || !observed) observed++;
      return { ok: true, state, accountId: 'bound-platform-account', current: { id: 'media-' + observed, identityKind: 'platform-video-id', caption: receiptText, platformVideoId: String(12345678901234 + observed), media: { muted: true, paused: true } } };
    } };
  const tokenBudget = { snapshot: () => ({ policy: { requestReserveTokens: 16384 } }),
    bindSession(id, value, options) { assert.equal(options.authorize(), true); budgetEvents.push(['bind', value]); },
    context: () => ({ sharedBudgetVisible: false, today: { autonomyTokens: 0 } }), retireSession() { budgetEvents.push(['retire']); } };
  const runner = createAutonomyRunner({ ctx, controlAccess: access, socialAccounts, tokenBudget });
  return { runner, ctx, access, calls, creations, denied, usage, budgetEvents, controller, registry, fire,
    get checks() { return checks; }, get followups() { return followups; }, get agent() { return createdAgent; }, get disposed() { return disposed; }, setReady(value) { ready = value; },
    run() { return runner({ id: 'auto-12345678-1234-4234-8234-123456789012', scope, kind: 'browse', origin: 'recommendation', platform: 'douyin', topic: RECOMMENDATION_TOPIC }, { signal: controller.signal, authorize: () => true, context: '', onUsage: mode => { usage.push(mode); onUsage?.(mode); }, onEvidence }); } };
}
test('native isolated agent performs bounded muted account reads and exact stop without Chrome or owner promotion', async () => {
  const f = runnerFixture(); const result = await f.run();
  assert.equal(result.status, 'succeeded'); assert.deepEqual(f.calls, ['open', 'current', 'next', 'stop']);
  assert.equal(f.checks, 1); assert.equal(f.followups, 1); assert.equal(f.denied.length, 6); assert.equal(f.disposed, 1); assert.equal(f.access.snapshot().busy, false);
  assert.deepEqual(f.budgetEvents[0][1], { origin: 'autonomy', scope, activityId: 'auto-12345678-1234-4234-8234-123456789012' });
  assert.equal(f.budgetEvents.at(-1)[0], 'retire'); assert.equal(f.creations[0].agentOptions.maxTokens, 4096);
  assert.ok(f.usage.includes('playing')); assert.equal(f.usage.at(-1), 'paused');
});
test('extra observations and failed or unavailable account actions never retry and always retain exact cleanup', async () => {
  const capped = runnerFixture({ actions: ['open', 'current', 'next', 'current'] });
  assert.equal((await capped.run()).status, 'failed'); assert.deepEqual(capped.calls, ['open', 'current', 'next', 'stop']);
  const failed = runnerFixture({ fail: 'next' });
  assert.equal((await failed.run()).status, 'failed'); assert.deepEqual(failed.calls, ['open', 'current', 'next', 'stop']);
  const unavailable = runnerFixture(); unavailable.setReady(false);
  assert.equal((await unavailable.run()).status, 'failed'); assert.deepEqual(unavailable.calls, []); assert.equal(unavailable.checks, 1); assert.equal(unavailable.followups, 0);
  const waitTooLong = runnerFixture({ cooldown: 3600000 });
  assert.equal((await waitTooLong.run()).status, 'failed'); assert.deepEqual(waitTooLong.calls, []);
});
test('revoked activity still permits only final account stop, while unknown cleanup holds the browser lease and token reservation', async () => {
  const f = runnerFixture({ onStep(action, controller) { if (action === 'open') controller.abort(); } });
  assert.equal((await f.run()).status, 'cancelled'); assert.deepEqual(f.calls, ['open', 'stop']); assert.equal(f.access.snapshot().busy, false);
  const unknown = runnerFixture({ cleanupFails: true });
  await assert.rejects(unknown.run(), { code: 'CONTROL_CLEANUP_UNCONFIRMED' });
  assert.equal(unknown.access.snapshot().busy, true); assert.equal(unknown.budgetEvents.some(row => row[0] === 'retire'), false);
});
test('real owner turns preempt autonomous work and remain busy until their own matching end', async () => {
  const f = runnerFixture({ actions: [] }), cancelled = [];
  const own = { id: 'owner', session: { id: 'owner' } }, stranger = { id: 'visitor', session: { id: 'visitor' } };
  f.registry.set(own.id, own); f.registry.set(stranger.id, stranger);
  const priority = createAutonomyUserPriority({ ctx: f.ctx, resolveOwner: agent => ({ isOwner: agent === own }), getAutonomy: () => ({ userActivity: () => cancelled.push(true) }) });
  await f.fire('session/event', stranger.session, { type: 'turn/start', data: { turn: 1 } }); assert.equal(priority.busy, false);
  await f.fire('agent/inbox/claimed', { agent: own, turn: 2 }); assert.equal(priority.busy, true); assert.equal(cancelled.length, 1);
  await f.fire('session/event', own.session, { type: 'turn/start', data: { turn: 2 } });
  await f.fire('session/event', own.session, { type: 'turn/end', data: { turn: 1 } }); assert.equal(priority.busy, true);
  await f.fire('session/event', { ...own.session }, { type: 'turn/end', data: { turn: 2 } }); assert.equal(priority.busy, true);
  await f.fire('session/event', own.session, { type: 'turn/end', data: { turn: 2 } }); assert.equal(priority.busy, false);
  priority.dispose(); assert.equal(priority.busy, false);
});

test('temporary driver occupation during this activity does not revoke its policy authority, while a real pause does', async t => {
  const f = engineFixture(t); let driverIdle = true, pause = false;
  f.engine.browseReady = (_platform, { duringExecution }) => !pause && (duringExecution || driverIdle);
  f.engine.run = async (_activity, options) => {
    driverIdle = false; assert.equal(options.authorize(), true, 'an in-flight native child is not policy revocation');
    pause = true; assert.equal(options.authorize(), false, 'real safety pause still revokes execution');
    return { status: 'failed', text: '' };
  };
  await f.engine.tick(); f.setNow(f.engine.snapshot().activities[0].dueAt); await f.engine.tick();
  assert.equal(f.engine.snapshot().activities[0].status, 'cancelled');
});

test('owner immediate assessment creates exactly one fresh due-now activity under CAS and never accelerates or replays an old row', async t => {
  const f = engineFixture(t), revision = f.memory.snapshot().revision;
  const result = await f.engine.checkNow({ revision, authorize: yes });
  assert.equal(result.status, 'completed'); assert.equal(result.automaticReplay, false); assert.equal(f.calls.length, 1);
  const row = f.engine.snapshot().activities[0]; assert.equal(row.dueAt, Date.parse(row.createdAt));
  await assert.rejects(f.engine.checkNow({ revision, authorize: yes }), { code: 'CONFLICT' });
  assert.equal(f.calls.length, 1);
  f.memory.store.update(state => { state.autonomy.nextAt = null; }, { authorize: yes });
  await f.engine.tick(); const scheduled = f.engine.snapshot().activities.find(row => row.status === 'scheduled');
  assert.ok(scheduled); const before = fs.readFileSync(f.memory.store.file);
  await assert.rejects(f.engine.checkNow({ revision: f.memory.snapshot().revision, authorize: yes }), { code: 'SCHEDULED_EXISTS' });
  assert.deepEqual(fs.readFileSync(f.memory.store.file), before); assert.equal(f.calls.length, 1);
});
test('immediate assessment cannot bypass disabled, quiet, busy, quota or unknown activity protection', async t => {
  for (const kind of ['disabled', 'quiet', 'busy', 'quota', 'unknown']) {
    const f = engineFixture(t);
    if (kind === 'disabled') f.engine.configure({ enabled: false }, { authorize: yes });
    if (kind === 'quiet') f.engine.configure({ quietEnabled: true, quietStart: 11, quietEnd: 13 }, { authorize: yes });
    if (kind === 'busy') f.engine.isBusy = () => true;
    if (kind === 'quota') f.engine.wallet.configure({ enabled: false }, { authorize: yes });
    if (kind === 'unknown') {
      await f.engine.tick(); f.memory.store.update(state => { state.autonomy.activities[0].status = 'unknown'; }, { authorize: yes });
    }
    const before = fs.readFileSync(f.memory.store.file);
    await assert.rejects(f.engine.checkNow({ revision: f.memory.snapshot().revision, authorize: yes }));
    assert.deepEqual(fs.readFileSync(f.memory.store.file), before); assert.equal(f.calls.length, 0);
  }
});
test('owner revocation cancels the one immediate assessment and cannot leave a ready unowned check', async t => {
  const f = engineFixture(t), controller = new AbortController();
  f.engine.run = async (_activity, options) => { controller.abort(); assert.equal(options.authorize(), false); return { status: 'cancelled', text: '' }; };
  const result = await f.engine.checkNow({ revision: f.memory.snapshot().revision, authorize: yes, signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(f.engine.immediateChecks.size, 0); assert.equal(f.engine.snapshot().running, false);
});

test('a model cannot repeat a failed observation and an unknown explicit stop is never automatically replayed', async () => {
  const retry = runnerFixture({ actions: ['open', 'current', 'current', 'next', 'stop'], fail: 'current', continueAfterError: true });
  assert.equal((await retry.run()).status, 'failed'); assert.deepEqual(retry.calls, ['open', 'current', 'stop']);
  const unknownStop = runnerFixture({ actions: ['open', 'stop', 'stop'], cleanupFails: true, continueAfterError: true });
  await assert.rejects(unknownStop.run(), { code: 'CONTROL_CLEANUP_UNCONFIRMED' });
  assert.deepEqual(unknownStop.calls, ['open', 'stop']); assert.equal(unknownStop.access.snapshot().busy, true);
});
test('a feed claimed while waiting and a lock-time precondition rejection never stop the owner feed', async () => {
  const waited = runnerFixture({ cooldown: 2, onSnapshot(row, count) { if (count >= 3) row.browse.state = 'active'; } });
  assert.equal((await waited.run()).status, 'failed'); assert.deepEqual(waited.calls, []);
  const raced = runnerFixture({ beforeDispatchFailure: true });
  assert.equal((await raced.run()).status, 'failed'); assert.deepEqual(raced.calls, ['open']);
  assert.equal(raced.access.snapshot().busy, false);
});

test('a single host tool cancellation reaches the actual account operation and permits only independent final stop', async () => {
  const tool = new AbortController(); let actualSignalAborted = false, actualAuthorityRevoked = false;
  const f = runnerFixture({ toolSignal: tool.signal, onBrowse(action, context) {
    if (action === 'open') { tool.abort(); actualSignalAborted = context.signal.aborted; actualAuthorityRevoked = !context.authorize(); }
  } });
  assert.equal((await f.run()).status, 'failed');
  assert.equal(f.controller.signal.aborted, false); assert.equal(actualSignalAborted, true); assert.equal(actualAuthorityRevoked, true);
  assert.deepEqual(f.calls, ['open', 'stop']); assert.equal(f.access.snapshot().busy, false);
});

test('confirmed stop accepts closing only this activity task space while retaining the logged-in profile', async () => {
  const f = runnerFixture({ taskSpaceClosed: true }); assert.equal((await f.run()).status, 'succeeded');
  assert.deepEqual(f.calls, ['open', 'current', 'next', 'stop']); assert.equal(f.access.snapshot().busy, false);
});

test('model step receipts persist bounded evidence and a model stop stays distinct from executor cleanup', async () => {
  const persisted = [], secret = 'PRIVATE_CAPTION_OR_CREDENTIAL_MUST_NOT_BE_IN_AUDIT';
  const f = runnerFixture({ actions: ['open', 'current', 'next', 'stop'], taskSpaceClosed: true, receiptText: secret,
    onEvidence: value => persisted.push(structuredClone(value)) });
  const result = await f.run(), evidence = result.browseEvidence;
  assert.equal(evidence.version, 1); assert.equal(evidence.steps.length, 4);
  assert.deepEqual(evidence.steps.map(step => [step.source, step.action]), [['model-tool', 'open'], ['model-tool', 'current'], ['model-tool', 'next'], ['model-tool', 'stop']]);
  const next = evidence.steps[2]; assert.equal(next.expectedObservationMatches, true); assert.equal(next.stableVideoChanged, true);
  assert.match(next.videoIdHash, /^[a-f0-9]{64}$/); assert.notEqual(next.videoIdHash, next.previousVideoIdHash);
  assert.equal(evidence.steps[3].taskSpaceClosed, true); assert.equal(persisted.length, 4); assert.equal(persisted[0].steps.length, 1);
  const bytes = JSON.stringify(evidence); assert.equal(bytes.includes(secret), false); assert.equal(bytes.includes('bound-platform-account'), false); assert.equal(bytes.includes('12345678901235'), false);
  const cleanup = await runnerFixture({ actions: ['open'] }).run();
  assert.deepEqual(cleanup.browseEvidence.steps.map(step => [step.source, step.action]), [['model-tool', 'open'], ['executor-cleanup', 'stop']]);
});
test('failed and unknown runs retain only already confirmed evidence without fabricating a failed action receipt', async () => {
  const failed = await runnerFixture({ fail: 'next' }).run();
  assert.equal(failed.status, 'failed'); assert.deepEqual(failed.browseEvidence.steps.map(step => step.action), ['open', 'current', 'stop']);
  const unknown = runnerFixture({ actions: ['open'], cleanupFails: true });
  await assert.rejects(unknown.run(), error => {
    assert.equal(error.code, 'CONTROL_CLEANUP_UNCONFIRMED');
    assert.deepEqual(error.browseEvidence.steps.map(step => [step.source, step.action]), [['model-tool', 'open']]); return true;
  });
});
test('evidence storage failure stops further model observations but still permits exact cleanup', async () => {
  const f = runnerFixture({ continueAfterError: true, onEvidence() { throw Error('fixture disk failure'); } });
  await assert.rejects(f.run(), error => { assert.equal(error.code, 'EVIDENCE_UNCONFIRMED'); assert.equal(error.browseEvidence.steps.length, 2); return true; });
  assert.deepEqual(f.calls, ['open', 'stop']); assert.equal(f.access.snapshot().busy, false);
});
test('normal model stop pauses metering before waiting for its two-stage browser cleanup', async () => {
  let release, entered; const gate = new Promise(resolve => release = resolve), ready = new Promise(resolve => entered = resolve);
  let f; f = runnerFixture({ actions: ['open', 'stop'], onBrowse: async action => { if (action === 'stop') { assert.equal(f.usage.at(-1), 'paused'); entered(); await gate; assert.equal(f.usage.at(-1), 'paused'); } } });
  const run = f.run(); await ready; assert.equal(f.usage.at(-1), 'paused'); release();
  assert.equal((await run).status, 'succeeded');
});

test('a pause checkpoint fault revokes the model stop and still closes through independent executor cleanup', async () => {
  const controller = new AbortController(); let failed = false;
  const f = runnerFixture({ controller, actions: ['open', 'stop'], onUsage(mode) { if (mode === 'paused' && !failed) { failed = true; controller.abort(); throw Error('fixture pause storage fault'); } } });
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 'TIME_ACCOUNTING_UNCONFIRMED');
    assert.deepEqual(error.browseEvidence.steps.map(row => [row.source, row.action]), [['model-tool', 'open'], ['executor-cleanup', 'stop']]); return true;
  });
  assert.deepEqual(f.calls, ['open', 'stop']); assert.equal(f.access.snapshot().busy, false);
});
