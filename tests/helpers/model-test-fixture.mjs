import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeStore } from '../../packages/dsh-dafeiyu/src/life-store.js';
import { TokenBudget } from '../../packages/dsh-dafeiyu/src/token-budget.js';
import { createContextGuard } from '../../packages/dsh-dafeiyu/src/context-guard.js';
import { createTokenAccounting } from '../../packages/dsh-dafeiyu/src/token-accounting.js';
import { createModelTestRunner } from '../../packages/dsh-dafeiyu/src/model-test-runner.js';

export function modelTestFixture({ llm, timeoutMs = 15000, cleanupTimeoutMs = 20, contextWindow = 10000, disposeAgent, scope = { accountId: '20002', identityId: 'default' } } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-test-accounting-'));
  const store = new LifeStore({ directory }), budget = new TokenBudget({ store });
  budget.configure({ dailyTokens: 100, monthlyTokens: 0, requestReserveTokens: 16 }, { revision: budget.snapshot().revision, authorize: () => true });
  const registry = new Map(), handlers = new Map(), creations = [], restrictions = [], guards = [];
  let open = true, currentScope = scope;
  const services = { llm, agents: { get: id => registry.get(id), withoutInitiator: fn => fn(), async create(spec) {
    creations.push(spec);
    const agent = { id: spec.sessionId, session: { id: spec.sessionId, header: { id: spec.sessionId, origin: 'test' } },
      followup() { throw Error('diagnostics must not enter a model loop'); } };
    const agentCtx = { get: key => key === 'tools' ? { restrict: value => restrictions.push(value), guard: value => guards.push(value), presentAs() {} } : services[key] };
    agent.ctx = agentCtx; registry.set(agent.id, agent);
    await spec.setup(agentCtx, agent);
    return { agent, async dispose() { await disposeAgent?.(agent); registry.delete(agent.id); } };
  } } };
  if (!llm.resolveModelInfo) llm.resolveModelInfo = async (provider, model) => ({ provider, id: model, context: { contextWindow }, defaultMaxTokens: 16 });
  const ctx = { get: key => services[key], on(name, listener) { const rows = handlers.get(name) || []; rows.push(listener); handlers.set(name, rows); return () => rows.splice(rows.indexOf(listener), 1); } };
  const guard = createContextGuard({ ctx });
  const accounting = createTokenAccounting({ ctx, budget, ownerQq: scope.accountId, getExecutionContext: () => ({ isOwner: false }), contextGuard: guard, isOpen: () => open });
  const wrappedBudget = Object.create(budget);
  wrappedBudget.bindSession = (...args) => { const result = budget.bindSession(...args); accounting.markSession(args[0]); return result; };
  const runner = createModelTestRunner({ ctx, tokenBudget: wrappedBudget, getScope: () => currentScope, isOpen: () => open, timeoutMs, cleanupTimeoutMs });
  const prepare = llm.prepareCall;
  llm.prepareCall = async (...args) => {
    const prepared = await prepare(...args);
    return { ...prepared, stream(options) {
      let next = () => prepared.stream(options);
      for (const listener of [...(handlers.get('llm/stream') || [])].reverse()) { const previous = next; next = () => listener(options, previous); }
      return next();
    } };
  };
  return { runner, budget, executionBudget: wrappedBudget, ctx, store, registry, creations, restrictions, guards, llm,
    setScope(value) { currentScope = value; }, setOpen(value) { open = value; },
    async cleanup() { await runner.dispose(); accounting.dispose(); guard.dispose(); fs.rmSync(directory, { recursive: true, force: true }); },
    // For deliberately stalled cleanup tests, dispose external fixtures only
    // after resolving the pending stream; never turn a timeout into a success.
  };
}
