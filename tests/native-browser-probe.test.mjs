import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { withBrowserFixture, probeNativeBrowser } from '../packages/dsh-dafeiyu/src/native-browser-probe.js';

const nonce = 'DFY-CAP-' + 'a'.repeat(24);
test('browser fixture rejects an invalid nonce before opening a listener', async () => {
  await assert.rejects(withBrowserFixture('invalid', () => {}), /invalid-nonce/);
});

test('browser probe rejects unowned task-space names before any tool dispatch', async () => {
  let calls = 0;
  await assert.rejects(probeNativeBrowser({ nonce, space: 'default', callTool: () => { calls++; } }), /invalid-space/);
  assert.equal(calls, 0);
});

const space = 'dfy-probe-0123456789';
function fixtureCase({ failAt, duplicate = false, closeUnknown = false, foreignPage = false,
  hangAt, signal, cancelAt, badReadback = false, delayedReadback = false } = {}) {
  const calls = []; let clicks = 0, blocked = false;
  let pendingReadback = delayedReadback;
  const url = 'http://127.0.0.1:12345/' + nonce;
  const options = { nonce, space, signal,
    withFixture: async (_nonce, run) => run({ url, receipt: () => clicks }),
    onCleanupUnknown: () => { blocked = true; },
    callTool: async ({ name, arguments: args, signal: toolSignal }) => {
      calls.push({ name, args });
      assert.equal(args.space || args.name, space);
      if (name === hangAt) return new Promise(() => {});
      if (name === cancelAt) {
        signal.controller.abort();
        assert.equal(toolSignal.aborted, true);
        throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      }
      if (name === 'ego_click') clicks += duplicate ? 2 : 1;
      if (name === failAt) throw Object.assign(new Error('unknown'), { code: 'EGO_EXECUTION_UNKNOWN' });
      if (name === 'ego_space_open') return { ok: true, name: space };
      if (name === 'ego_space_close') return { ok: true, done: !closeUnknown };
      if (name === 'ego_page_info') return { ok: true, page: { url: foreignPage ? 'https://example.invalid/' : url } };
      if (name === 'ego_snapshot') return { ok: true, text: clicks ? '浏览器控制回读：' + nonce : '浏览器测试输入 验证浏览器输入' };
      if (name === 'ego_read_element') {
        if (args.selector === '#result' && pendingReadback) { pendingReadback = false; return { ok: true, value: '尚未验证' }; }
        return { ok: true, value: args.selector === '#result' ? '浏览器控制回读：' + (badReadback ? 'wrong' : nonce) : nonce };
      }
      return { ok: true };
    } };
  return { options, calls, blocked: () => blocked };
}
test('canonical browser sequence binds every action and closes its own space after exact readback', async () => {
  const state = fixtureCase();
  const result = await probeNativeBrowser(state.options);
  assert.equal(result.ok, true);
  assert.deepEqual(state.calls.map(c => c.name), ['ego_space_open','ego_navigate','ego_page_info','ego_snapshot','ego_fill',
    'ego_read_element','ego_page_info','ego_click','ego_read_element','ego_snapshot','ego_space_close']);
});
test('unknown click is never replayed; only exact owned cleanup follows', async () => {
  const state = fixtureCase({ failAt: 'ego_click' });
  await assert.rejects(probeNativeBrowser(state.options), /unknown/);
  assert.equal(state.calls.filter(c => c.name === 'ego_click').length, 1);
  assert.equal(state.calls.at(-1).name, 'ego_space_close');
});
test('duplicate dispatch receipt fails acceptance even if page text matches', async () => {
  const state = fixtureCase({ duplicate: true });
  await assert.rejects(probeNativeBrowser(state.options), /readback-unconfirmed/);
  assert.equal(state.calls.at(-1).name, 'ego_space_close');
});
test('unconfirmed browser cleanup blocks subsequent control rather than claiming success', async () => {
  const state = fixtureCase({ closeUnknown: true });
  await assert.rejects(probeNativeBrowser(state.options), /cleanup-unconfirmed/);
  assert.equal(state.blocked(), true);
});

test('page URL must match exact owned localhost route before any input or click', async () => {
  const state = fixtureCase({ foreignPage: true });
  await assert.rejects(probeNativeBrowser(state.options), /target-unconfirmed/);
  assert.equal(state.calls.some((call) => ['ego_fill', 'ego_click'].includes(call.name)), false);
  assert.equal(state.calls.at(-1).name, 'ego_space_close');
});

test('exact result element readback is required even if the snapshot contains the expected text', async () => {
  const state = fixtureCase({ badReadback: true });
  await assert.rejects(probeNativeBrowser(state.options), /readback-unconfirmed/);
  assert.equal(state.calls.filter((call) => call.name === 'ego_click').length, 1);
});

test('delayed click receipt is reread without another mutation', async () => {
  const state = fixtureCase({ delayedReadback: true });
  assert.equal((await probeNativeBrowser(state.options)).ok, true);
  assert.equal(state.calls.filter((call) => call.name === 'ego_click').length, 1);
  assert.equal(state.calls.filter((call) => call.name === 'ego_read_element' && call.args.selector === '#result').length, 2);
});

test('cleanup uses independent cancellation signal, remains exact-space, and is bounded', async () => {
  const state = fixtureCase({ hangAt: 'ego_space_close' });
  await assert.rejects(probeNativeBrowser({ ...state.options, cleanupTimeoutMs: 15, settleTimeoutMs: 5 }), /cleanup-unconfirmed/);
  assert.equal(state.blocked(), true);
  assert.equal(state.calls.filter((call) => call.name === 'ego_space_close').length, 1);
  assert.deepEqual(state.calls.at(-1).args, { name: space, keep: false });
});

test('unsettled action deadline blocks lease without racing a cleanup or repeating a script', async () => {
  const state = fixtureCase({ hangAt: 'ego_click' });
  await assert.rejects(probeNativeBrowser({ ...state.options, toolTimeoutMs: 15, settleTimeoutMs: 5 }), /cleanup-unconfirmed/);
  assert.equal(state.blocked(), true);
  assert.equal(state.calls.filter((call) => call.name === 'ego_click').length, 1);
  assert.equal(state.calls.some((call) => call.name === 'ego_space_close'), false);
});

test('completed cancellation attempts only exact owned cleanup with a fresh signal', async () => {
  const controller = new AbortController();
  controller.signal.controller = controller;
  const state = fixtureCase({ signal: controller.signal, cancelAt: 'ego_fill' });
  await assert.rejects(probeNativeBrowser(state.options), /cancelled/);
  assert.equal(state.calls.at(-1).name, 'ego_space_close');
  assert.equal(state.calls.some((call) => call.name === 'ego_click'), false);
});

test('space-open unknown still attempts only that generated space cleanup', async () => {
  const state = fixtureCase({ failAt: 'ego_space_open' });
  await assert.rejects(probeNativeBrowser(state.options), /unknown/);
  assert.deepEqual(state.calls.map((call) => call.name), ['ego_space_open', 'ego_space_close']);
});

test('real fixture rejects cross-origin proof, counts exact valid receipts, and closes active incomplete requests', async () => {
  let pendingRequest;
  const localRequest = (address, options = {}) => new Promise((resolve, reject) => {
    const target = new URL(address); assert.equal(target.hostname, '127.0.0.1');
    const request = http.request(target, options, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', data => { text += data; });
      response.on('end', () => resolve({ status: response.statusCode, text: async () => text }));
    });
    request.once('error', reject); request.end(options.body);
  });
  await withBrowserFixture(nonce, async ({ url, receipt }) => {
    const page = await localRequest(url);
    assert.equal(page.status, 200);
    const rejected = await localRequest(url + '/proof', { method: 'POST', headers: { origin: 'https://example.invalid' }, body: nonce });
    assert.equal(rejected.status, 403);
    assert.equal(receipt(), 0);
    const accepted = await localRequest(url + '/proof', { method: 'POST', body: nonce });
    assert.equal(await accepted.text(), '浏览器控制回读：' + nonce);
    assert.equal(receipt(), 1);
    await new Promise((resolve) => {
      pendingRequest = http.request(url + '/proof', { method: 'POST', headers: { 'content-length': 128 } });
      pendingRequest.on('error', () => {});
      pendingRequest.flushHeaders();
      pendingRequest.write('unfinished');
      pendingRequest.on('socket', (socket) => { if (socket.connecting) socket.once('connect', resolve); else resolve(); });
    });
  });
  pendingRequest.destroy();
});
