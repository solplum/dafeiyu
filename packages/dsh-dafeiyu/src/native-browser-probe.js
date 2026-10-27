import http from 'node:http';
import { canonicalToolCall } from './native-control-probes.js';

/** Owned local page. A server receipt proves the button ran exactly once. */
export async function withBrowserFixture(nonce, operation) {
  if (!/^DFY-CAP-[a-f0-9]{24}$/.test(nonce)) throw new Error('invalid-nonce');
  let clicks = 0;
  const route = '/' + nonce;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'");
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method === 'GET' && req.url === route) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>大肥鱼浏览器验证</title></head><body>
<h1>大肥鱼浏览器验证</h1><label for="value">浏览器测试输入</label><input id="value" aria-label="浏览器测试输入" maxlength="64">
<button id="verify">验证浏览器输入</button><output id="result" aria-live="polite">尚未验证</output>
<script>document.querySelector('#verify').addEventListener('click',async()=>{const response=await fetch(location.pathname+'/proof',{method:'POST',body:document.querySelector('#value').value});document.querySelector('#result').textContent=await response.text();});</script></body></html>`);
    } else if (req.method === 'POST' && req.url === route + '/proof') {
      let body = '';
      try { for await (const data of req) { body += data; if (body.length > 128) { res.writeHead(413); res.end(); return; } } }
      catch { res.destroy(); return; }
      if (body !== nonce) { res.writeHead(400); res.end('标记不匹配'); return; }
      clicks++; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('浏览器控制回读：' + body);
    } else { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { return await operation({ url: `http://127.0.0.1:${server.address().port}${route}`, receipt: () => clicks }); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
}

/** All actions go through DSH's canonical tool pipeline; no script evaluation. */
export async function probeNativeBrowser({ ctx, agent, parent, signal, authorize, nonce, space, onCleanupUnknown,
  callTool = canonicalToolCall, withFixture = withBrowserFixture,
  toolTimeoutMs = 30000, cleanupTimeoutMs = 5000, settleTimeoutMs = 1000, deadlineMs = 120000 } = {}) {
  if (typeof space !== 'string' || !/^(?:dfy-[a-z0-9-]{8,120}|dafeiyu-task-[a-f0-9-]{36})$/.test(space)) throw new Error('invalid-space');
  if (!/^DFY-CAP-[a-f0-9]{24}$/.test(nonce)) throw new Error('invalid-nonce');
  for (const timeout of [toolTimeoutMs, cleanupTimeoutMs, settleTimeoutMs, deadlineMs]) {
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error('invalid-timeout');
  }
  const deadline = Date.now() + deadlineMs;
  const pending = new Set();
  let cleanupUnknown = false;
  const unknownCleanup = () => {
    if (!cleanupUnknown) { cleanupUnknown = true; try { onCleanupUnknown?.(); } catch {} }
    return Object.assign(new Error('cleanup-unconfirmed'), { code: 'cleanup-unconfirmed' });
  };
  const call = async (name, args, cleanup = false) => {
    if (!cleanup && signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    const timeoutMs = cleanup ? cleanupTimeoutMs : Math.min(toolTimeoutMs, deadline - Date.now());
    if (timeoutMs <= 0) throw Object.assign(new Error('probe-deadline'), { code: 'UNCONFIRMED' });
    const controller = new AbortController();
    let settled = false, timer, abort;
    const execution = Promise.resolve().then(() => callTool({ ctx, agent, parent,
      signal: controller.signal, timeoutMs,
      authorize: cleanup ? () => ctx?.get?.('agents')?.get(agent?.id) === agent : authorize,
      name, arguments: args }));
    pending.add(execution);
    const settlement = execution.then(() => { settled = true; pending.delete(execution); },
      () => { settled = true; pending.delete(execution); });
    const interrupted = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); };
      timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('tool-deadline'), { code: 'UNCONFIRMED' })); }, timeoutMs);
      if (!cleanup) { signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); }
    });
    try { return await Promise.race([execution, interrupted]); }
    catch (error) {
      if (!settled) {
        let grace;
        try { await Promise.race([settlement, new Promise((resolve) => { grace = setTimeout(resolve, settleTimeoutMs); })]); }
        finally { clearTimeout(grace); }
      }
      // Never close a space concurrently with an action still running there.
      if (!settled) throw unknownCleanup();
      throw error;
    } finally { clearTimeout(timer); if (!cleanup) signal?.removeEventListener('abort', abort); }
  };
  return withFixture(nonce, async ({ url, receipt }) => {
    const target = new URL(url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
      || target.pathname !== '/' + nonce || target.search || target.hash || target.username || target.password) throw new Error('invalid-fixture');
    let opened = false, closed = false;
    const pageIsOwned = async () => {
      const info = await call('ego_page_info', { space });
      if (info?.ok !== true || info.page?.url !== url) throw new Error('target-unconfirmed');
    };
    try {
      opened = true;
      const open = await call('ego_space_open', { name: space });
      if (open?.ok !== true || open.name !== space) throw new Error('space-unconfirmed');
      const navigate = await call('ego_navigate', { space, url, timeout: 15000 });
      if (navigate?.ok !== true) throw new Error('navigate-unconfirmed');
      await pageIsOwned();
      const before = await call('ego_snapshot', { space });
      if (before?.ok !== true || typeof before.text !== 'string' || !before.text.includes('浏览器测试输入')
        || !before.text.includes('验证浏览器输入') || receipt() !== 0) throw new Error('target-unconfirmed');
      const fill = await call('ego_fill', { space, selector: '#value', text: nonce });
      if (fill?.ok !== true) throw new Error('input-unconfirmed');
      const value = await call('ego_read_element', { space, selector: '#value', what: 'value' });
      if (value?.ok !== true || value.value !== nonce) throw new Error('input-unconfirmed');
      await pageIsOwned();
      const click = await call('ego_click', { space, selector: '#verify', label: '验证浏览器输入' });
      if (click?.ok !== true) throw new Error('click-unconfirmed');
      let result;
      // The one click's fetch handler is asynchronous. Only reread its result;
      // a delayed DOM update must never cause another click or script replay.
      for (let attempt = 0; attempt < 5; attempt++) {
        result = await call('ego_read_element', { space, selector: '#result', what: 'text' });
        if (result?.ok !== true || result.value === '浏览器控制回读：' + nonce) break;
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 40));
      }
      if (result?.ok !== true || result.value !== '浏览器控制回读：' + nonce) throw new Error('readback-unconfirmed');
      const after = await call('ego_snapshot', { space });
      if (after?.ok !== true || typeof after.text !== 'string' || !after.text.includes('浏览器控制回读：' + nonce) || receipt() !== 1) throw new Error('readback-unconfirmed');
      return { ok: true, evidence: { kind: 'readback', matched: true, backend: 'dsh-ego-browser', scope: 'owned-local-page', actions: ['fill', 'click', 'readback'], clicks: 1 } };
    } finally {
      if (opened) {
        if (pending.size) throw unknownCleanup();
        try { const result = await call('ego_space_close', { name: space, keep: false }, true); closed = result?.ok === true && result.done === true; } catch {}
        if (!closed) throw unknownCleanup();
      }
    }
  });
}
