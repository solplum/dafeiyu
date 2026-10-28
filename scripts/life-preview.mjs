/** Isolated browser acceptance only: actual React component/services, fictional data, no DSH/QQ/device access. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LifeMemory } from '../packages/dsh-dafeiyu/src/life-memory.js';
import { AutonomyEngine } from '../packages/dsh-dafeiyu/src/autonomy-engine.js';
import { lifeOperation } from '../packages/dsh-dafeiyu/src/life-panel.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const preview = path.join(root, 'tests/preview-runtime');
const { build } = await import(pathToFileURL(path.join(preview, 'node_modules/esbuild/lib/main.js')));
const source = fs.readFileSync(path.join(root, 'packages/dsh-dafeiyu/src/client.js'), 'utf8');
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const component = part('    function LifePanel(', '    function MemoryPanel(');
const api = part('    function usePanelApi()', '    const resourceError');
const style = source.match(/const style = `([\s\S]*?)`;/)[1];
const entry = path.join(preview, '.generated-entry.jsx'), bundle = path.join(preview, '.generated-bundle.js');
fs.writeFileSync(entry, `import React, {useState,useRef,useEffect} from 'react'; import {createRoot} from 'react-dom/client';
const h=React.createElement, equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
${api}\n${component}
createRoot(document.getElementById('app')).render(h(LifePanel,{active:true,accounts:[{qq:'20002',name:'隔离测试账号',enabled:true,activeIdentityId:'default'}],onDirtyChange:()=>{}}));`);
await build({ entryPoints: [entry], bundle: true, platform: 'browser', outfile: bundle, logLevel: 'silent' });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-life-preview-'));
const memory = new LifeMemory({ directory }), scope = { accountId: '20002', identityId: 'default' };
const autonomy = new AutonomyEngine({ memory, scopes: () => [scope], run: async () => ({ status: 'failed' }), send: async () => ({ ok: false, uncertain: false }) });
memory.configure({ learningEnabled: true, growthEnabled: true }, { authorize: () => true });
memory.capture({ phase: 'received', messageId: '1', selfId: '10001', scope, userText: '以后回复简短一点' }, { authorize: () => true });
memory.capture({ phase: 'received', messageId: '2', selfId: '10001', scope, userText: '今天聊了摄影，周末想去拍日落。这是隔离验收数据。' }, { authorize: () => true });
memory.growth.learn({ authorize: () => true });
autonomy.wallet.configure({ enabled: true, dailySeconds: 1200, monthlySeconds: 7200 }, { authorize: () => true });
const runtime = { lifeMemory: memory, autonomy }, token = randomUUID();
let origin;
const server = http.createServer(async (req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const url = new URL(req.url, origin);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `preview=${token}; HttpOnly; SameSite=Strict; Path=/` });
    return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>生活与成长 · 隔离验收</title><style>body{margin:0;background:#f5f7fa}h1,body>p{max-width:940px;margin:20px auto;padding:0 20px;font:16px system-ui} ${style}</style><h1>生活与成长 · 隔离验收</h1><p>虚构测试数据；使用真实面板组件和存储服务。此预览不连接 QQ、模型或手机，自主执行器关闭。</p><div id="app" class="dfy-panel"></div><script src="/bundle.js"></script></html>`);
  }
  if (url.pathname === '/bundle.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return fs.createReadStream(bundle).pipe(res); }
  if (!String(req.headers.cookie || '').includes('preview=' + token) || req.headers.origin && req.headers.origin !== origin) return json(403, { ok: false, error: '仅限当前隔离预览' });
  try {
    if (url.pathname === '/dafeiyu-panel/api/life' && req.method === 'GET') {
      const query = Object.fromEntries(url.searchParams); for (const name of ['offset', 'limit']) if (query[name] !== undefined) query[name] = Number(query[name]);
      return json(200, { ok: true, life: await lifeOperation(() => runtime, 'snapshot', query, { authorize: () => true }) });
    }
    if (url.pathname === '/dafeiyu-panel/api/life/action' && req.method === 'POST') {
      let body = ''; for await (const bytes of req) { body += bytes; if (body.length > 32768) throw new Error('请求过大'); }
      const parsed = JSON.parse(body);
      return json(200, { ok: true, life: await lifeOperation(() => runtime, parsed.action, parsed.input, { authorize: () => true }) });
    }
    return json(404, { ok: false, error: '无此验收路由' });
  } catch (error) { return json(error.code === 'CONFLICT' ? 409 : 400, { ok: false, code: error.code || 'PREVIEW', error: error.message }); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = 'http://127.0.0.1:' + server.address().port;
console.log(JSON.stringify({ previewUrl: origin, mode: 'isolated-fixture', component: 'actual-LifePanel', executionEnabled: false }));
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, async () => { await autonomy.dispose(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); process.exit(0); });
