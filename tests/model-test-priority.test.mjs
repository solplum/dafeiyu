import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomyEngine } from '../packages/dsh-dafeiyu/src/autonomy-engine.js';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { modelTestFixture } from './helpers/model-test-fixture.mjs';
const yes = () => true, scope = { accountId: '20002', identityId: 'default' };
function actualPriority(modelTests) {
  const source = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/index.js', import.meta.url), 'utf8');
  const expression = /isBusy: \(\) => ([^\n]+),\n\s+send:/.exec(source)?.[1];
  assert.ok(expression, 'use the shipped AutonomyEngine busy callback');
  return new Function('disposed', 'maintenance', 'modelTests', 'autonomyPriority', 'incomingActive', 'nativeOneBot', 'backgroundTasks', 'return () => (' + expression + ');')
    (false, false, modelTests, { busy: false }, 0, { status: { pending: 0 } }, { status: { active: 0 } });
}
function autonomyFixture(t, modelTests) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-test-priority-'));
  const memory = new LifeMemory({ directory }); let now = Date.parse('2026-10-27T04:00:00Z');
  const engine = new AutonomyEngine({ memory, now: () => now, random: () => 0, scopes: () => [scope], isBusy: actualPriority(modelTests),
    browseReady: () => true, run: async () => ({ status: 'succeeded', text: 'fixture page' }), send: () => assert.fail('no QQ send') });
  engine.configure({ enabled: true, browse: true, proactive: false, platforms: ['douyin'], targets: [scope], quietEnabled: false }, { authorize: yes });
  engine.wallet.configure({ enabled: true, dailySeconds: 600, monthlySeconds: 0 }, { authorize: yes });
  t.after(async () => { await engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { engine, setNow: value => { now = value; } };
}
test('the shipped autonomy callback defers to a real pending diagnostic even after its HTTP timeout', async t => {
  let finishPrepare; const waiting = new Promise(resolve => { finishPrepare = resolve; }); let dispatches = 0;
  const diagnostic = modelTestFixture({ timeoutMs: 5, llm: { async prepareCall(config) { await waiting; return { config, stream() { dispatches++; throw Error('must not dispatch aborted preparation'); } }; } } });
  const f = autonomyFixture(t, diagnostic.runner), before = f.engine.snapshot().policy;
  await assert.rejects(diagnostic.runner.run({ provider: 'fixture', model: 'model' }, { authorize: yes }), { code: 'PANEL_CONNECTION_TIMEOUT' });
  assert.equal(diagnostic.runner.busy, true); assert.equal(f.engine.preview().reasonCode, 'USER_TASK_BUSY');
  await f.engine.tick(); assert.equal(f.engine.snapshot().activities.length, 0); assert.deepEqual(f.engine.snapshot().policy, before);
  finishPrepare(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(diagnostic.runner.busy, false); assert.equal(f.engine.preview().reasonCode, 'NEXT_CHECK_WAIT', 'clearing diagnostic occupancy does not accelerate the original assessment schedule'); assert.equal(dispatches, 0);
  await diagnostic.cleanup();
});
test('the shipped priority callback revokes continued autonomous execution when a diagnostic becomes busy', async t => {
  const modelTests = { busy: false }, f = autonomyFixture(t, modelTests), before = f.engine.snapshot().policy;
  f.engine.run = async (_activity, options) => {
    assert.equal(options.authorize(), true); modelTests.busy = true; assert.equal(options.authorize(), false);
    return { status: 'succeeded', text: 'must not complete or publish this activity' };
  };
  await f.engine.tick(); f.setNow(f.engine.snapshot().activities[0].dueAt); await f.engine.tick();
  assert.equal(f.engine.snapshot().activities[0].status, 'cancelled'); assert.deepEqual(f.engine.snapshot().policy, before);
});
