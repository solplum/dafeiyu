/** Isolated owner preview; never points DSH at this worktree or copies config. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createSocialAccounts } from '../packages/dsh-dafeiyu/src/social/accounts-factory.mjs';
import { SOCIAL_ACCOUNT_ROUTES, SOCIAL_ACCOUNT_ERRORS, socialAccountRoute } from '../packages/dsh-dafeiyu/src/social/account-routes.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const configPath = process.argv[2];
if (!configPath || !path.isAbsolute(configPath)) throw Error('Supply an absolute private preview config path');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!path.isAbsolute(config.directory || '') || path.resolve(config.directory) === root) throw Error('Dedicated private data directory is required');
const accounts = createSocialAccounts({ directory: config.directory, biliPythonPath: config.biliPythonPath });
if (config.previewOwnerToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(config.previewOwnerToken)) throw Error('Invalid private preview owner token');
if (config.previewPort !== undefined && (!Number.isInteger(config.previewPort) || config.previewPort < 1024 || config.previewPort > 65535)) throw Error('Invalid loopback preview port');
const token = config.previewOwnerToken || randomBytes(32).toString('base64url'); let base;
const authenticated = req => {
  const value = req.headers['x-dafeiyu-owner'];
  return typeof value === 'string' && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token))
    && (!req.headers.origin || req.headers.origin === base) && !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
};
const send = (res, status, value) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value));
};
const staticFiles = { '/': ['packages/dsh-dafeiyu/src/social/accounts-preview.html', 'text/html; charset=utf-8'],
  '/client.js': ['packages/dsh-dafeiyu/src/social/accounts-preview-client.js', 'text/javascript; charset=utf-8'] };
const server = http.createServer(async (req, res) => {
  if (!['127.0.0.1', '::1'].includes(req.socket.remoteAddress)) return send(res, 403, { ok: false });
  const url = new URL(req.url, base || 'http://127.0.0.1');
  if (staticFiles[url.pathname] && req.method === 'GET') {
    if (req.headers.origin && req.headers.origin !== base) return send(res, 403, { ok: false });
    const [file, type] = staticFiles[url.pathname];
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    return res.end(fs.readFileSync(path.join(root, file)));
  }
  if (!url.pathname.startsWith('/api/') || !authenticated(req)) return send(res, 403, { ok: false, code: 'FORBIDDEN', error: SOCIAL_ACCOUNT_ERRORS.FORBIDDEN });
  const endpoint = url.pathname.slice(5), method = SOCIAL_ACCOUNT_ROUTES[endpoint];
  if (!method || method !== req.method) return send(res, 405, { ok: false, code: 'INVALID_REQUEST' });
  const controller = new AbortController(); req.once('aborted', () => controller.abort());
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  let body;
  try {
    if (method === 'POST') {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Error('INVALID_REQUEST');
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw Error('INVALID_REQUEST'); chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    const result = await socialAccountRoute(endpoint, accounts, body, { authorize: () => authenticated(req) && !controller.signal.aborted, signal: controller.signal });
    send(res, 200, result);
  } catch (error) {
    const code = /^[A-Z_]{3,64}$/.test(error?.code || '') ? error.code : 'INVALID_REQUEST';
    // Codes only: never log message, stack, payload, cookies or response bodies.
    console.error('PREVIEW_ERROR_CODE ' + code);
    const diagnostic = accounts.drivers[body?.platform]?.runtime?.lastDiagnostic;
    if (['bootstrap', 'binding-list', 'binding-resume', 'identity-tabs', 'script-body', 'state-write'].includes(diagnostic?.phase)
      && ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AbortError'].includes(diagnostic?.name))
      console.error('PREVIEW_NATIVE_PHASE ' + diagnostic.phase + ' ' + diagnostic.name);
    send(res, code === 'COOLDOWN' ? 429 : code === 'RISK_CONTROL' ? 409 : ['FORBIDDEN'].includes(code) ? 403 : ['CONFLICT', 'BUSY', 'RESULT_UNKNOWN', 'NO_REPLAY', 'LOGIN_PENDING'].includes(code) ? 409 : 400,
      { ok: false, code, error: SOCIAL_ACCOUNT_ERRORS[code] || '平台尚未给出完整确认，请核对当前登录状态。' });
  }
});
server.listen(config.previewPort || 0, '127.0.0.1', () => {
  base = 'http://127.0.0.1:' + server.address().port;
  fs.mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config.directory, 'preview-control.private.json'), JSON.stringify({ base, token, pid: process.pid }), { mode: 0o600 });
  console.log('PREVIEW_READY ' + base);
});
async function stop() { server.close(); await accounts.dispose(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
