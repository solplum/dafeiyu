/** Offline host-contract checks. Never touches a desktop profile, device, API or real archive. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanion as apply, apply as cordisApply, inject } from '../src/index.js';

const sourceDir = fileURLToPath(new URL('../../companion/src', import.meta.url));
function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-offline-'));
  fs.mkdirSync(path.join(projectRoot, 'packages/companion'), { recursive: true });
  fs.symlinkSync(sourceDir, path.join(projectRoot, 'packages/companion/src'), 'dir');
  fs.mkdirSync(path.join(projectRoot, 'memory'));
  fs.writeFileSync(path.join(projectRoot, 'memory/user.md'), 'OWNER_PRIVATE_CANARY');
  fs.writeFileSync(path.join(projectRoot, 'memory/timeline.md'), 'TIMELINE_PRIVATE_CANARY');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}
function host() {
  const state = { contexts: new Map(), tools: new Map(), events: new Map(), effects: [], disposed: 0 };
  state.unmount = () => { for (const dispose of state.effects.splice(0).reverse()) dispose(); };
  const ctx = { logger: { info() {}, warn() {} },
    get(name) { return this[name]; },
    systemPrompt: { context(definition) {
      assert.equal(typeof definition, 'object');
      assert.equal(typeof definition.name, 'string');
      assert.ok(Number.isFinite(definition.order), 'actual host rejects missing order');
      assert.equal(typeof definition.text, 'function');
      assert.equal(definition.interpolate, false);
      state.contexts.set(definition.name, definition);
      return () => { state.contexts.delete(definition.name); state.disposed++; };
    } },
    tools: { guard() { return () => {}; }, register(...args) {
      assert.equal(args.length, 1, 'actual host register takes one definition');
      const [definition] = args;
      assert.equal(typeof definition.name, 'string');
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof definition.output?.render, 'function');
      assert.equal(typeof definition.output?.schema, 'object');
      assert.ok(!state.tools.has(definition.name));
      state.tools.set(definition.name, definition);
      return () => { state.tools.delete(definition.name); state.disposed++; };
    } },
    on(event, callback) { state.events.set(event, callback); return () => state.events.delete(event); },
    effect(setup) {
      const dispose = setup();
      assert.equal(typeof dispose, 'function', 'Cordis owns returned effect disposer');
      state.effects.push(dispose);
      return dispose;
    },
  };
  return { ctx, state };
}

test('registers the real DSH prompt/tool contracts and disposes every registration', async (t) => {
  const projectRoot = fixture(t);
  const { ctx, state } = host();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network forbidden in offline lifecycle test'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const instance = await apply(ctx, { projectRoot });
  t.after(() => instance.dispose());
  const text = [...state.contexts.values()][0].text();
  assert.ok(text.includes('大肥鱼'));
  assert.ok(!text.includes('OWNER_PRIVATE_CANARY'));
  assert.ok(!text.includes('TIMELINE_PRIVATE_CANARY'));
  assert.ok(state.tools.has('phone_screenshot'));
  assert.ok(!state.tools.has('phone_type'));
  assert.ok(state.tools.has('dafeiyu_status'));
  assert.ok(state.tools.has('dafeiyu_remember'));
  assert.ok(state.tools.has('phone_key'));
  assert.ok(state.tools.has('phone_get_ui_tree'));
  assert.equal(instance.qqGateway.wsClient, null);
  assert.equal(fs.existsSync(path.join(projectRoot, 'packages/dsh-dafeiyu/data/state.json')), false);
  assert.deepEqual(instance.capabilities, { officialInbound: 'native-host', sidebar: false, widget: false });
  assert.equal((await instance.sidebar.registerToCordis(ctx)).registered, false);
  const count = state.tools.size + state.contexts.size;
  state.unmount();
  assert.equal(state.contexts.size, 0);
  assert.equal(state.tools.size, 0);
  assert.equal(state.disposed, count);
  instance.dispose();
  assert.equal(state.disposed, count, 'idempotent dispose');
});

test('failed registration rolls back earlier prompt registration', async (t) => {
  const projectRoot = fixture(t);
  const { ctx, state } = host();
  ctx.tools.register = () => { throw new Error('host rejected tool'); };
  await assert.rejects(apply(ctx, { projectRoot }), /host rejected tool/);
  assert.equal(state.contexts.size, 0);
});

test('invalid companion config is visible rather than silently ignored', async (t) => {
  const projectRoot = fixture(t);
  fs.writeFileSync(path.join(projectRoot, 'packages/companion/config.json'), '{broken');
  await assert.rejects(apply(host().ctx, { projectRoot }), /伴侣配置无法读取/);
});


test('one failing subsystem cleanup cannot prevent other registrations being removed', async (t) => {
  const projectRoot = fixture(t);
  const { ctx, state } = host();
  const instance = await apply(ctx, { projectRoot });
  const realDispose = instance.phoneTools.dispose.bind(instance.phoneTools);
  instance.phoneTools.dispose = () => { realDispose(); throw new Error('cleanup failed'); };
  assert.doesNotThrow(() => instance.dispose());
  assert.equal(state.contexts.size, 0);
  assert.equal(state.tools.size, 0);
  assert.equal(instance.qqGateway.stopped, true);
  assert.equal(instance.autoReady.stopped, true);
});

test('native owner first turn reads shared memory, saves a real event, and group loses access', async (t) => {
  const projectRoot = fixture(t);
  const { ctx, state } = host();
  const instance = await apply(ctx, { projectRoot, ownerOpenId: 'owner', qqSettingsNs: 'bot', allowMemoryWrites: true });
  t.after(() => instance.dispose());
  const agent = { session: { id: 'session' }, ctx: { get: () => ({ manager }) } };
  const record = { agent, sessionId: 'session', scope: 'c2c', peerId: 'owner', replyTarget: { scope: 'c2c', targetId: 'owner' } };
  const manager = { settingsNs: 'bot', findByAgent: () => record };
  const prompt = [...state.contexts.values()][0];
  const registryContext = { key: 'official:c2c:owner', userId: 'owner', isGroup: false };
  assert.ok(instance.toolRegistry.definitions(registryContext).length > 0);
  assert.match(prompt.text({ agent }), /OWNER_PRIVATE_CANARY/);
  const saved = await state.tools.get('dafeiyu_remember').execute({ summary: 'fixture event', detail: 'ACTUAL_MEMORY_EVENT' }, { agent });
  assert.equal(saved.saved, true);
  assert.match(prompt.text({ agent }), /ACTUAL_MEMORY_EVENT/);
  record.scope = 'group';
  assert.doesNotMatch(prompt.text({ agent }), /OWNER_PRIVATE_CANARY|ACTUAL_MEMORY_EVENT/);
  await assert.rejects(state.tools.get('dafeiyu_remember').execute({ summary: 'forbidden', detail: 'forbidden' }, { agent }), /群聊/);
  instance.dispose();
  assert.equal(instance.toolRegistry.definitions(registryContext).length, 0);
});

test('native desktop can read nonprivate offline status, while phone performs zero operations', async (t) => {
  const projectRoot = fixture(t);
  const { ctx, state } = host();
  const instance = await apply(ctx, { projectRoot, ownerOpenId: 'owner' });
  t.after(() => instance.dispose());
  const agent = { session: { id: 'desktop' }, ctx: { get: () => undefined } };
  const status = await state.tools.get('dafeiyu_status').execute({}, { agent });
  assert.equal(status.phone.enabled, false);
  assert.equal(status.phone.state, 'offline');
  assert.equal(instance.phoneTools.enabled, false);
  const phoneState = await instance.phoneTools.getDeviceState();
  assert.equal(phoneState.online, false);
  await assert.rejects(state.tools.get('phone_screenshot').execute({}, { agent }));
});


test('dependency declaration names the actual vendor Cordis services', () => {
  assert.deepEqual(inject, ['systemPrompt', 'tools']);
  // This fork treats object keys as literal service names; required/optional
  // wrappers otherwise leave the plugin waiting forever for those fake names.
  assert.ok(Array.isArray(inject));
});


test('Cordis apply resolves void instead of an instance object', async (t) => {
  const projectRoot = fixture(t);
  const { ctx, state } = host();
  assert.equal(await cordisApply(ctx, { projectRoot }), undefined);
  state.unmount();
  assert.equal(state.contexts.size, 0);
  assert.equal(state.tools.size, 0);
});
