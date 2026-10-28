import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { SocialAccounts } from '../packages/dsh-dafeiyu/src/social/accounts.mjs';
import { BrowserAccountDriver } from '../packages/dsh-dafeiyu/src/social/browser-account.mjs';
import { digest } from '../packages/dsh-dafeiyu/src/social/account-store.mjs';
import { douyinInteractionRequest, douyinInteractionBinding, douyinInteractionCapabilities,
  observeDouyinInteraction, interactionSemanticDigest } from '../packages/dsh-dafeiyu/src/social/douyin-interactions.mjs';

const yes = () => true, owner = 'fixture-owner', video = '1234567890123456789';
const current = { id: 'media-' + digest(['platform-video-id', video]), platformVideoId: video,
  identityKind: 'platform-video-id', author: 'fixture nickname', description: 'fixture page text', media: { muted: true, paused: true } };
const request = (action = 'like', extra = {}) => ({ action, expectedVideoId: current.id, ...(action === 'comment' ? { text: 'fixture comment' } : {}), ...extra });
const fixtureRecipe = action => ({ verified: true, scope: 'current-recommendation',
  control: { selector: '.fixture-' + action, text: 'fixture ' + action,
    ...(action === 'comment' ? {} : { stateAttribute: 'aria-pressed', inactiveValue: 'false', activeValue: 'true' }) },
  ...(action === 'comment' ? { editor: '.fixture-editor' } : { setValue: '1' }),
  request: { method: 'POST', encoding: 'json', fields: { target: ['target'], ...(action === 'comment' ? { text: ['text'] } : { state: ['state'] }) } },
  // Deliberately synthetic local schema. This is never a production endpoint.
  response: { url: 'https://www.douyin.com/fixture-only-' + action, okPath: ['ok'], okValue: true,
    idPath: ['id'], actorPath: ['actor'], targetPath: ['target'],
    ...(action === 'comment' ? { textPath: ['text'] } : { statePath: ['state'], stateValue: 1 }) } });
const bindings = () => ({ platform: 'douyin', verified: true, accountId: owner,
  identity: { url: 'https://creator.douyin.com/creator-micro/home', selector: '#fixture-own', attribute: 'textContent', pattern: '^own:(.+)$' },
  browse: { videoIdentity: { verified: true, kind: 'platform-video-id', attribute: 'data-fixture-id' },
    authorIdentity: { verified: true, selector: '.fixture-author', attribute: 'href' } },
  interactions: Object.fromEntries(['like', 'follow', 'comment'].map(action => [action, fixtureRecipe(action)])) });

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-interactions-')), calls = [];
  const driver = { idle: true, capabilities: () => ({}), interactionCapabilities: () => ({ like: 'ready', follow: 'ready', comment: 'ready' }),
    browseStatus: () => ({ state: 'active' }),
    async interactionPreflight(input, context) {
      calls.push('preflight');
      if (options.preflight) return options.preflight(input, context, manager);
      return { target: input.action === 'follow' ? 'stable-fixture-author' : video, current: structuredClone(current), bindingDigest: digest('fixture-bindings') };
    },
    async interact(input, context) {
      calls.push('dispatch');
      if (options.interact) return options.interact(input, context, manager);
      return receipt(input, context);
    },
    async browse(input) { calls.push(input.action); return { ok: true, state: 'stopped', browserStopped: false, taskSpaceClosed: true, spaceRetained: false }; },
    async dispose() {},
  };
  const manager = new SocialAccounts({ directory, drivers: { douyin: driver }, requestPolicy: null });
  manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: owner, generation: 3 }; }, { authorize: yes });
  t.after(async () => { await manager.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const context = { authorize: yes, interactionAllowed: yes, activityId: 'auto-' + randomUUID(),
    autonomousExpectation: { accountId: owner, generation: 3, initiallyStopped: false } };
  return { directory, manager, driver, calls, context, run: (input = request(), ctx = context) => manager.interact('douyin', input, ctx) };
}
function receipt(input, context) {
  return { ok: true, status: 'confirmed', action: input.action, accountId: context.accountId,
    operationId: context.operationId, target: context.target, contentDigest: context.contentDigest,
    receiptId: 'fixture-receipt', current: structuredClone(current) };
}

test('interaction input exposes only a latest observation token and bounded exact comment', () => {
  for (const action of ['like', 'follow', 'comment']) assert.deepEqual(douyinInteractionRequest(request(action)), request(action));
  for (const value of [null, request('message'), request('like', { target: 'some-user' }), request('like', { text: 'x' }),
    request('comment', { text: '' }), request('comment', { text: 'a'.repeat(501) }), request('comment', { text: 'line\nbreak' }),
    request('comment', { text: 'tab\t' }), request('like', { expectedVideoId: video }), request('like', { accountId: owner })])
    assert.throws(() => douyinInteractionRequest(value));
  assert.equal(douyinInteractionRequest(request('comment', { text: 'a'.repeat(500) })).text.length, 500);
});

test('capability requires independently verified current-feed controls, request and response bindings', () => {
  const valid = bindings();
  assert.deepEqual(douyinInteractionCapabilities(valid), { like: 'ready', follow: 'ready', comment: 'ready' });
  assert.deepEqual(douyinInteractionCapabilities(null), { like: 'bindings-required', follow: 'bindings-required', comment: 'bindings-required' });
  for (const mutate of [b => delete b.browse.videoIdentity, b => b.verified = false,
    b => b.interactions.like.verified = false, b => delete b.interactions.like.request.fields.state,
    b => delete b.interactions.like.response.targetPath, b => b.interactions.like.response.url = 'https://creator.douyin.com/fixture',
    b => b.interactions.like.response.actorPath = ['__proto__'], b => b.interactions.like.control.activeValue = 'false']) {
    const value = bindings(); mutate(value); assert.equal(douyinInteractionBinding(value, 'like'), null);
  }
  const noAuthor = bindings(); delete noAuthor.browse.authorIdentity;
  assert.equal(douyinInteractionBinding(noAuthor, 'follow'), null);
  const noBody = bindings(); delete noBody.interactions.comment.response.textPath;
  assert.equal(douyinInteractionBinding(noBody, 'comment'), null);
  const driver = new BrowserAccountDriver({ key: 'douyin', directory: '/unused-fixture', runtime: { async dispose() {} },
    bindings: { platform: 'douyin', verified: true, accountId: owner, identity: valid.identity, browse: valid.browse } });
  assert.deepEqual(driver.interactionCapabilities(), { like: 'bindings-required', follow: 'bindings-required', comment: 'bindings-required' });
});

test('follow target is the unique official author link in the same current video card, never the nickname', async () => {
  const recipe = fixtureRecipe('follow'), author = bindings().browse.authorIdentity;
  let href = '/user/stable-fixture-author', state = 'false', links = 1;
  const rect = () => ({ width: 20, height: 20, top: 0, bottom: 20 });
  const control = { getBoundingClientRect: rect, innerText: 'fixture follow', getAttribute: () => state };
  const row = { getBoundingClientRect: rect, querySelectorAll: selector => selector === author.selector
    ? Array.from({ length: links }, () => ({ getBoundingClientRect: rect, getAttribute: () => href })) : [control] };
  const expression = observeDouyinInteraction(JSON.stringify(current), author, recipe, 'follow');
  const run = () => vm.runInNewContext(expression, { document: { querySelectorAll: () => [row] }, URL,
    location: { href: 'https://www.douyin.com/?recommend=1' }, innerHeight: 100, getComputedStyle: () => ({ visibility: 'visible' }) });
  assert.equal((await run()).target, 'stable-fixture-author');
  state = 'true'; assert.equal((await run()).alreadySet, true);
  state = 'unknown'; assert.equal(await run(), null); state = 'false';
  for (const invalid of ['fixture nickname', 'https://evil.example/user/foo', '/user/foo?private=1', 'https://www.douyin.com.evil/user/foo']) {
    href = invalid; assert.equal(await run(), null);
  }
  href = '/user/stable-fixture-author'; links = 2; assert.equal(await run(), null);
});

function scriptedDriver(action, overrides = {}) {
  const source = bindings(), events = [], scripts = []; let active = 'creator', claimed = false, responseReady, dispatches = 0;
  const target = action === 'follow' ? 'stable-fixture-author' : video;
  const projected = { current, target, authorId: action === 'follow' ? target : null, alreadySet: false };
  const payload = { ok: true, id: 'confirmed-fixture-id', actor: owner, target,
    ...(action === 'comment' ? { text: 'fixture comment' } : { state: 1 }), ...(overrides.payload || {}) };
  class Xhr { open() {} send() {} }
  const originalFetch = async () => { dispatches++; const response = new Response(JSON.stringify(payload), { status: overrides.status || 200 });
    Object.defineProperty(response, 'url', { value: source.interactions[action].response.url }); return response; };
  const sandbox = { window: null, location: { href: 'https://www.douyin.com/?recommend=1' }, XMLHttpRequest: Xhr,
    fetch: originalFetch, URL, Request, Response, URLSearchParams, FormData, TextDecoder };
  sandbox.window = sandbox; vm.createContext(sandbox);
  const runtime = { children: new Set(), cleanupPending: false,
    async run(body) {
      scripts.push(body);
      // Only the claim I/O is a local test double; parse and execute the real
      // generated SDK script against deterministic page/response fixtures.
      const executable = body.replace("const fs=await import('node:fs');", '');
      const page = { async url() { return active === 'creator' ? source.identity.url : 'https://www.douyin.com/?recommend=1'; },
        async evaluate(expression) {
          if (expression.includes("state:'login-pending'")) { events.push('identity'); return { loggedIn: true, accountId: owner }; }
          if (expression.includes('iframe[src*=captcha]')) return false;
          if (expression.startsWith('(async()=>{const current=await')) return structuredClone(projected);
          if (expression.includes('function observeDouyinVideo')) return structuredClone(current);
          if (expression.startsWith('(()=>{const rows=')) { events.push('editor-readback'); return true; }
          if (expression.startsWith('(()=>{const result=')) { events.push('guard-install'); assert.match(expression, /UNREVIEWED_MUTATION_BLOCKED/); assert.match(expression, /REQUEST_DRAFT_MISMATCH/); return vm.runInContext(expression, sandbox); }
          if (expression.includes('?.restore();')) { events.push('guard-cleanup'); return vm.runInContext(expression, sandbox); }
          if (expression.startsWith('(() => {const s=window[')) return vm.runInContext(expression, sandbox);
          throw Error('unexpected expression: ' + expression.slice(0, 80));
        },
        locator(selector) { assert.match(selector, new RegExp(video)); return {
          async click() { events.push('click'); assert(claimed); assert(events.includes('guard-install'));
            const body = JSON.stringify({ target, ...(action === 'comment' ? { text: 'fixture comment' } : { state: '1' }), ...(overrides.outgoing || {}) });
            const response = await sandbox.fetch(source.interactions[action].response.url, { method: 'POST', body });
            if (overrides.duplicate) await sandbox.fetch(source.interactions[action].response.url, { method: 'POST', body });
            responseReady({ status: () => response.status, url: () => response.url });
          },
          async fill(value) { assert.equal(value, 'fixture comment'); events.push('fill'); assert(events.includes('guard-install')); },
        }; },
        async waitForResponse(url) { events.push('response-watch'); assert.equal(url, source.interactions[action].response.url); return await new Promise(resolve => { responseReady = resolve; }); },
        async waitForFunction(expression) { events.push('receipt-wait'); for (let i = 0; i < 50; i++) {
          if (vm.runInContext(expression, sandbox)) return;
          await new Promise(resolve => setImmediate(resolve));
        } throw Error('fixture capture timeout'); },
      };
      return await vm.runInNewContext('(async()=>{' + executable + '\nreturn result;})()', { page, URL,
        fs: { openSync(_file, flags) { assert.equal(flags, 'wx'); assert.equal(claimed, false); claimed = true; events.push('claim'); return 1; },
          writeFileSync() {}, fsyncSync() {}, closeSync() {} },
        browser: { async ensureRealTab() {}, async listTabs() { return [{ targetId: 'creator', url: source.identity.url }, { targetId: 'feed', url: 'https://www.douyin.com/?recommend=1' }]; },
          async switchTab(id) { active = id; } },
        taskSpaces: { async list() { return [{ name: 'dfy-social-douyin', ownership: 'agent' }]; }, async useOrCreate() {} },
      });
    }, async dispose() {},
  };
  const driver = new BrowserAccountDriver({ key: 'douyin', directory: '/unused-fixture', runtime, bindings: source });
  driver.browseAccount = owner; driver.browseCurrent = structuredClone(current); driver.browseState = 'active';
  return { driver, events, scripts, sandbox, source, get dispatches() { return dispatches; }, scope: { authorize: yes, accountId: owner },
    execution: { authorize: yes, accountId: owner, operationId: randomUUID(), claimFile: '/fixture-not-written.once',
      target, bindingDigest: digest(source), contentDigest: digest('fixture-request') } };
}

test('native interaction script installs a once claim and exact request guard before edits and one click', async () => {
  for (const action of ['like', 'follow', 'comment']) {
    const f = scriptedDriver(action), input = request(action);
    const preflight = await f.driver.interactionPreflight(input, f.scope);
    assert.equal(preflight.target, f.execution.target); assert.equal(f.events.filter(e => e === 'click').length, 0);
    const result = await f.driver.interact(input, f.execution);
    assert.equal(result.status, 'confirmed'); assert.equal(result.target, f.execution.target); assert.equal(result.current.media.muted, true);
    assert.equal(f.events.filter(e => e === 'click').length, 1);
    assert.equal(f.dispatches, 1);
    assert(f.events.indexOf('claim') < f.events.indexOf('guard-install'));
    assert(f.events.indexOf('guard-install') < f.events.indexOf('click'));
    assert(f.events.indexOf('response-watch') < f.events.indexOf('click'));
    assert(f.events.indexOf('editor-readback') < f.events.indexOf('click'));
    assert.equal(f.events.at(-1), 'identity');
    assert.doesNotMatch(f.scripts.join('\n'), /bringToFront|activate\(|Raise|keyboard|mouse|page\.goto/);
  }
});

test('native script does not promote HTTP 200 or a mismatched response body into interaction success', async () => {
  for (const payload of [{ actor: 'other' }, { target: 'other-work' }, { state: 0 }, { ok: false }, { id: '' }]) {
    const f = scriptedDriver('like', { payload });
    await assert.rejects(f.driver.interact(request(), f.execution), /BINDINGS_REQUIRED/);
    assert.equal(f.events.filter(e => e === 'click').length, 1);
    assert(f.events.includes('guard-cleanup'));
  }
  const comment = scriptedDriver('comment', { payload: { text: 'different text' } });
  await assert.rejects(comment.driver.interact(request('comment'), comment.execution), /BINDINGS_REQUIRED/);
});

test('actual request guard rejects wrong target, comment and reverse state before the first simulated platform send', async () => {
  for (const [action, outgoing] of [['like', { state: '0' }], ['follow', { target: 'nickname' }], ['comment', { text: 'different text' }]]) {
    const f = scriptedDriver(action, { outgoing });
    await assert.rejects(f.driver.interact(request(action), f.execution), /REQUEST_DRAFT_MISMATCH/);
    assert.equal(f.dispatches, 0); assert(f.events.includes('guard-cleanup'));
  }
  const duplicate = scriptedDriver('like', { duplicate: true });
  await assert.rejects(duplicate.driver.interact(request(), duplicate.execution), /DUPLICATE_REQUEST_BLOCKED/);
  assert.equal(duplicate.dispatches, 1); assert(duplicate.events.includes('guard-cleanup'));
  for (const status of [403, 412, 429]) {
    const f = scriptedDriver('like', { status });
    await assert.rejects(f.driver.interact(request(), f.execution), /RISK_CONTROL/);
    assert.equal(f.dispatches, 1); assert(f.events.includes('guard-cleanup'));
  }
});

test('manager requires a current autonomous activity, independent permission, account generation and ready bindings', async t => {
  const f = fixture(t);
  for (const patch of [{ authorize: () => false }, { interactionAllowed: () => false }, { interactionAllowed: () => { throw Error(); } },
    { activityId: 'from-model' }, { autonomousExpectation: undefined },
    { autonomousExpectation: { accountId: owner, generation: 3, initiallyStopped: true } }])
    await assert.rejects(f.run(request(), { ...f.context, ...patch }));
  await assert.rejects(f.run(request(), { ...f.context, autonomousExpectation: { accountId: owner, generation: 4, initiallyStopped: false } }), { code: 'AUTONOMY_PRECONDITION' });
  f.driver.interactionCapabilities = () => ({ like: 'bindings-required' });
  await assert.rejects(f.run(), { code: 'BINDINGS_REQUIRED' });
  assert.deepEqual(f.calls, []); assert.equal(Object.keys(f.manager.store.read().state.operations).length, 0);
});

test('a policy switch off after read preflight prevents dispatch and durable operation creation', async t => {
  let enabled = true;
  const f = fixture(t, { preflight: () => { enabled = false; return { target: video, current, bindingDigest: digest('fixture') }; } });
  await assert.rejects(f.run(request(), { ...f.context, interactionAllowed: () => enabled }), { code: 'FORBIDDEN' });
  assert.deepEqual(f.calls, ['preflight']); assert.equal(Object.keys(f.manager.store.read().state.operations).length, 0);
});

test('each confirmed interaction records exact target/content proof; repeated activities never repeat the effect', async t => {
  for (const action of ['like', 'follow', 'comment']) {
    const f = fixture(t), result = await f.run(request(action));
    assert.equal(result.status, 'confirmed'); assert.equal(result.accountId, owner); assert.equal(result.generation, 3);
    assert.equal(result.targetHash, digest((action === 'follow' ? 'douyin-author\0stable-fixture-author' : 'douyin-video\0' + video)));
    assert.equal(result.contentDigest, action === 'comment' ? digest('fixture comment') : null);
    assert.equal(f.manager.snapshot().operations[0].state, 'sent');
    assert.equal(f.manager.store.read().state.accounts.douyin.activeOperation, null);
    await assert.rejects(f.run(request(action, action === 'comment' ? { text: 'changed wording' } : {}),
      { ...f.context, activityId: 'auto-' + randomUUID() }), { code: 'NO_REPLAY' });
    assert.equal(f.calls.filter(x => x === 'dispatch').length, 1);
  }
  assert.equal(interactionSemanticDigest(owner, 1, 'comment', video), interactionSemanticDigest(owner, 99, 'comment', video));
});

test('post-dispatch unknown results survive reload, stop and owner acknowledgment without replay', async t => {
  const f = fixture(t, { interact: () => { throw Object.assign(Error('private'), { code: 'BROWSER_UNKNOWN' }); } });
  await assert.rejects(f.run(request('comment')), { code: 'INTERACTION_UNCONFIRMED' });
  const original = f.manager.snapshot().operations[0]; assert.equal(original.state, 'unknown');
  const reloaded = new SocialAccounts({ directory: f.directory, drivers: { douyin: f.driver }, requestPolicy: null });
  t.after(() => reloaded.dispose());
  await assert.rejects(reloaded.interact('douyin', request('comment'), f.context), { code: 'RESULT_UNKNOWN' });
  await f.manager.browse('douyin', { action: 'stop' }, { authorize: yes });
  assert.equal(f.manager.store.read().state.accounts.douyin.activeOperation, original.id);
  f.manager.acknowledgeUnknown({ operationId: original.id, revision: f.manager.snapshot().revision,
    executionStopped: true, resultReviewed: true }, { authorize: yes });
  await assert.rejects(f.run(request('comment', { text: 'another wording' })), { code: 'NO_REPLAY' });
  assert.equal(f.manager.snapshot().operations[0].state, 'unknown');
  assert.equal(f.calls.filter(x => x === 'dispatch').length, 1);
  assert.doesNotMatch(JSON.stringify(f.manager.snapshot()), /private/);
});

test('HTTP-like success with wrong business account/target/body/id/state is unknown and blocks later writes', async t => {
  for (const [field, value] of [['accountId', 'other'], ['target', 'other'], ['contentDigest', '0'.repeat(64)],
    ['receiptId', ''], ['status', 'submitted'], ['operationId', randomUUID()], ['action', 'follow'],
    ['current', { ...current, media: { muted: false, paused: true } }]]) {
    const f = fixture(t, { interact: (input, context) => ({ ...receipt(input, context), [field]: value }) });
    await assert.rejects(f.run(), { code: 'INTERACTION_UNCONFIRMED' });
    assert.equal(f.manager.snapshot().operations[0].state, 'unknown');
    await assert.rejects(f.run(request('comment')), { code: 'RESULT_UNKNOWN' });
    assert.equal(f.calls.filter(x => x === 'dispatch').length, 1);
  }
});

test('confirmed business receipt remains confirmed when permission is revoked immediately afterward', async t => {
  let enabled = true;
  const f = fixture(t, { interact: (input, context) => { const result = receipt(input, context); enabled = false; return result; } });
  const result = await f.run(request(), { ...f.context, interactionAllowed: () => enabled });
  assert.equal(result.status, 'confirmed'); assert.equal(f.manager.snapshot().operations[0].state, 'sent');
  await assert.rejects(f.run(request('comment'), { ...f.context, interactionAllowed: () => enabled }), { code: 'FORBIDDEN' });
});

test('failed confirmation persistence keeps dispatch proof and reports unknown instead of ordinary failure', async t => {
  const f = fixture(t, { interact: (input, context, manager) => {
    const result = receipt(input, context);
    fs.writeFileSync(path.join(manager.store.directory, '.write-lock'), 'unrelated-writer', { mode: 0o600 });
    return result;
  } });
  await assert.rejects(f.run(), { code: 'INTERACTION_UNCONFIRMED' });
  assert.equal(f.manager.store.read().state.accounts.douyin.activeOperation, Object.keys(f.manager.store.read().state.operations)[0]);
  assert.equal(f.manager.snapshot().operations[0].state, 'unknown');
  fs.unlinkSync(path.join(f.directory, '.write-lock'));
  await assert.rejects(f.run(), { code: 'RESULT_UNKNOWN' });
  assert.equal(f.calls.filter(x => x === 'dispatch').length, 1);
});

test('failed unknown-result and risk-pause persistence both retain the durable dispatch and unknown error code', async t => {
  for (const code of ['BROWSER_UNKNOWN', 'RISK_CONTROL']) {
    const f = fixture(t, { interact: (_input, _context, manager) => {
      fs.writeFileSync(path.join(manager.store.directory, '.write-lock'), 'unrelated-writer', { mode: 0o600 });
      throw Object.assign(Error('fixture failure'), { code });
    } });
    await assert.rejects(f.run(), { code: 'INTERACTION_UNCONFIRMED' });
    const row = Object.values(f.manager.store.read().state.operations)[0];
    assert.equal(row.state, 'dispatching'); assert.equal(f.manager.store.read().state.accounts.douyin.activeOperation, row.id);
    assert.equal(f.manager.snapshot().operations[0].state, 'unknown');
    fs.unlinkSync(path.join(f.directory, '.write-lock'));
    await assert.rejects(f.run(request('comment')), { code: 'RESULT_UNKNOWN' });
    assert.equal(f.calls.filter(x => x === 'dispatch').length, 1);
  }
});

test('autonomous record corruption fails closed rather than silently removing semantic deduplication', async t => {
  for (const mutate of [row => delete row.autonomousInteraction, row => delete row.origin,
    row => row.autonomousInteraction.semanticDigest = '0'.repeat(64), row => row.autonomousInteraction.expectedVideoId = 'media-' + '0'.repeat(64),
    row => row.autonomousInteraction.activityId = 'from-model', row => row.autonomousInteraction.extra = true]) {
    const f = fixture(t); await f.run(request('comment'));
    assert.equal(f.manager.snapshot().operations[0].origin, 'autonomy');
    const state = JSON.parse(fs.readFileSync(f.manager.store.file)); mutate(Object.values(state.operations)[0]);
    fs.writeFileSync(f.manager.store.file, JSON.stringify(state), { mode: 0o600 });
    assert.throws(() => f.manager.store.read(), { code: 'STORAGE_INVALID' });
  }
});

test('interaction cooldown projects the existing write ceiling without consuming a read or changing settings', t => {
  const f = fixture(t), now = 1000000;
  const manager = new SocialAccounts({ directory: f.directory, drivers: { douyin: f.driver }, now: () => now });
  t.after(() => manager.dispose());
  manager.store.transact(state => { state.accounts.douyin.requestHistory = [{ kind: 'write', at: now - 1000 }]; }, { authorize: yes });
  const before = fs.readFileSync(manager.store.file), row = manager.snapshot().platforms.find(p => p.platform === 'douyin');
  assert.equal(row.browse.interactionCooldownRemainingMs, 59000); assert.equal(row.browse.cooldownRemainingMs, 0);
  assert.deepEqual(fs.readFileSync(manager.store.file), before);
});

test('safety pauses and already-set controls never dispatch an autonomous write', async t => {
  const paused = fixture(t); paused.manager.holdPlatform({ platform: 'douyin', revision: paused.manager.snapshot().revision, reason: 'owner-paused' }, { authorize: yes });
  await assert.rejects(paused.run(), { code: 'RISK_CONTROL' }); assert.deepEqual(paused.calls, []);
  const set = fixture(t, { preflight: () => { throw Object.assign(Error(), { code: 'ALREADY_SET' }); } });
  await assert.rejects(set.run(), { code: 'ALREADY_SET' }); assert.deepEqual(set.calls, ['preflight']);
  assert.equal(Object.keys(set.manager.store.read().state.operations).length, 0);
  const risk = fixture(t, { interact: () => { throw Object.assign(Error(), { code: 'RISK_CONTROL' }); } });
  await assert.rejects(risk.run(), { code: 'INTERACTION_UNCONFIRMED' });
  assert.equal(risk.manager.snapshot().platforms.find(p => p.platform === 'douyin').safetyPause.reason, 'risk-control');
});
