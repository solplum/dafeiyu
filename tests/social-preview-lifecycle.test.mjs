import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { SOCIAL_ACCOUNT_ROUTES, SOCIAL_ACCOUNT_ERRORS, socialAccountRoute } from '../packages/dsh-dafeiyu/src/social/account-routes.mjs';

const scriptUrl = new URL('../scripts/social-accounts-preview.mjs', import.meta.url);
const source = fs.readFileSync(scriptUrl, 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(scriptUrl.href));
const ownerToken = 'f'.repeat(43);
const rawPrivate = 'fixture-private-cookie-and-raw-stream';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ResponseFixture extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes = [];
  writeHead(status, headers) {
    assert(!this.destroyed && !this.writableEnded, 'closed response must not be written');
    this.writes.push({ status, headers });
  }
  end(body) {
    assert(!this.destroyed && !this.writableEnded, 'response must end only once');
    this.writes.push({ body });
    this.writableEnded = true;
  }
  close() { this.destroyed = true; this.emit('close'); }
}

function previewFixture(startLogin = async () => ({})) {
  let handler;
  const entered = deferred(), logs = [], listeners = [];
  const configPath = '/offline-fixture/preview.private.json';
  const manager = {
    drivers: { douyin: { runtime: { lastDiagnostic: { phase: 'script-body', name: 'TypeError', raw: rawPrivate } } } },
    snapshot: () => [],
    startLogin: (body, context) => { entered.resolve({ body, context }); return startLogin(body, context); },
    dispose: async () => {},
  };
  const sandbox = vm.createContext({
    fs: {
      readFileSync(file) {
        assert.equal(file, configPath, 'only the in-memory config may be read');
        return JSON.stringify({ directory: '/offline-fixture/data', previewOwnerToken: ownerToken });
      },
      mkdirSync() { assert.fail('fixture must not write files'); },
      writeFileSync() { assert.fail('fixture must not write files'); },
    },
    path, fileURLToPath, timingSafeEqual, AbortController, Buffer, URL,
    randomBytes() { assert.fail('fixture uses a fixed owner token'); },
    createSocialAccounts: () => manager,
    SOCIAL_ACCOUNT_ROUTES, SOCIAL_ACCOUNT_ERRORS, socialAccountRoute,
    http: { createServer(callback) {
      handler = callback;
      return { listen(_port, host) { assert.equal(host, '127.0.0.1'); }, close() {} };
    } },
    process: { argv: ['node', scriptUrl.pathname, configPath], on: (...args) => listeners.push(args) },
    console: { log: value => logs.push(value), error: value => logs.push(value) },
  });
  // Execute the actual script and route handler, replacing only module bindings.
  // The HTTP fixture captures listen; it never opens a socket or calls its callback.
  vm.runInContext(source, sandbox, { filename: fileURLToPath(scriptUrl) });
  const send = vm.runInContext('send', sandbox);
  return {
    entered: entered.promise, logs, send,
    request() {
      const req = new PassThrough();
      Object.assign(req, {
        method: 'POST', url: '/api/social/login/start', aborted: false,
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'content-type': 'application/json', 'x-dafeiyu-owner': ownerToken },
      });
      const res = new ResponseFixture(), finished = handler(req, res);
      req.end(JSON.stringify({ platform: 'douyin' }));
      return { req, res, finished };
    },
  };
}

test('disconnect after the complete body revokes authorization and aborts the active route', async () => {
  const operation = deferred();
  const preview = previewFixture(async (_body, context) => {
    context.signal.addEventListener('abort', () => operation.reject(Object.assign(
      Error(rawPrivate + ownerToken), { code: 'FORBIDDEN' })), { once: true });
    return operation.promise;
  });
  const { req, res, finished } = preview.request();
  const { body, context } = await preview.entered;
  try {
    assert.equal(body.platform, 'douyin');
    assert.equal(req.readableEnded, true);
    assert.equal(req.aborted, false, 'the request body itself was not aborted');
    assert.equal(context.authorize(), true);
    assert.equal(context.signal.aborted, false);
    res.close();
    assert.equal(context.signal.aborted, true);
    assert.equal(context.authorize(), false);
  } finally {
    operation.resolve({});
    await finished;
  }
  assert.deepEqual(res.writes, [], 'late route failure must not write to the disconnected response');
  assert.deepEqual(preview.logs, ['PREVIEW_ERROR_CODE FORBIDDEN', 'PREVIEW_NATIVE_PHASE script-body TypeError']);
  assert(!preview.logs.join('\n').includes(ownerToken));
  assert(!preview.logs.join('\n').includes(rawPrivate));
});

test('complete request-body close and normal response close do not cancel successful work', async () => {
  const operation = deferred(), preview = previewFixture(() => operation.promise);
  const { req, res, finished } = preview.request();
  const { context } = await preview.entered;
  try {
    req.emit('close');
    assert.equal(context.signal.aborted, false, 'body completion is not a response disconnect');
    assert.equal(context.authorize(), true);
  } finally {
    operation.resolve({ loggedIn: true });
    await finished;
  }
  assert.equal(res.writableEnded, true);
  assert.equal(res.writes[0].status, 200);
  assert.deepEqual(JSON.parse(res.writes[1].body), { ok: true, loggedIn: true, accounts: [] });
  res.close();
  assert.equal(context.signal.aborted, false, 'a normal finished response must not revoke its context');
  assert.equal(context.authorize(), true);
  assert.deepEqual(preview.logs, []);
});

test('send ignores destroyed and already ended responses without serialization or another write', () => {
  const { send } = previewFixture();
  const unsafe = { toJSON() { assert.fail('closed response must not serialize a late payload'); } };
  for (const state of [{ destroyed: true }, { writableEnded: true }]) {
    const res = Object.assign(new ResponseFixture(), state);
    assert.doesNotThrow(() => send(res, 400, unsafe));
    assert.deepEqual(res.writes, []);
  }
  const res = new ResponseFixture();
  send(res, 200, { ok: true });
  send(res, 400, unsafe);
  assert.equal(res.writes.length, 2);
  assert.equal(res.writes[0].status, 200);
  assert.equal(res.writes[1].body, '{"ok":true}');
});
