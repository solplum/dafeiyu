import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { BiliBrowser, BILI_READ_TOOLS, registerBiliBrowserTools } from '../packages/dsh-dafeiyu/src/bili-browser.js';

const BV = 'BV1d8pU6xEZX', OTHER = 'BV1uNk1YxEJQ', PRIVATE = 'BILI_PRIVATE_CANARY';
const jpeg = Buffer.from([255, 216, 255, 224, 0, 1, 255, 217]).toString('base64');
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function fixture(t, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bili-browser-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pythonPath = path.join(directory, 'python'), scriptPath = path.join(directory, 'source.py'), stateDir = path.join(directory, 'state');
  fs.writeFileSync(pythonPath, '# fixture', { mode: 0o700 }); fs.writeFileSync(scriptPath, '# fixed fixture');
  const scriptSha256 = createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex');
  const state = { calls: [], spawns: [], children: [], toolNames: [...BILI_READ_TOOLS], noClose: false, reply: null, block: false };
  const spawnImpl = (command, args, spawnOptions) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk)); state.calls.push(message);
      if (message.id !== undefined && !state.block) queueMicrotask(() => {
        let result = message.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {} }
          : message.method === 'tools/list' ? { tools: state.toolNames.map((name) => ({ name })) }
            : state.reply ? state.reply(message.params) : text(message.params.name === 'bili_search'
              ? { keyword: 'DSH', videos: [{ bvid: BV, title: 'Public video' }] } : { bvid: message.params.arguments.bvid, text: 'public subtitle' });
        child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
      }); callback();
    } });
    child.kill = (signal) => { child.kills ||= []; child.kills.push(signal); if (!state.noClose) queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); }); return true; };
    state.spawns.push({ command, args, options: spawnOptions }); state.children.push(child); return child;
  };
  const browser = new BiliBrowser({ pythonPath, scriptPath, stateDir, scriptSha256, enabled: true, spawnImpl, timeoutMs: 1000, ...options });
  t.after(() => browser.dispose().catch(() => {}));
  return { browser, state, directory, pythonPath, scriptPath, stateDir };
}
const authorized = { authorize: () => true };

test('passive status neither prepares state nor launches a process and does not reveal configured paths', (t) => {
  const f = fixture(t); const first = f.browser.status;
  assert.equal(first.configured, true); assert.equal(first.toolsVerified, false); assert.equal(f.state.spawns.length, 0);
  assert.equal(fs.existsSync(f.stateDir), false); assert(!JSON.stringify(first).includes(f.directory));
});

test('actual tools/list must match the seven-item allowlist before any body and fixed environment never inherits secrets', async (t) => {
  const f = fixture(t); const result = await f.browser.check(authorized);
  assert.deepEqual(result.tools, [...BILI_READ_TOOLS]); assert.equal(f.state.calls.some((item) => item.method === 'tools/call'), false);
  const spawn = f.state.spawns[0]; assert.equal(spawn.command, f.pythonPath); assert.equal(spawn.options.shell, false);
  assert.deepEqual(spawn.args, ['-I', '-B', path.join(f.stateDir, 'mcp_server.py')]);
  assert.equal(spawn.options.env.BILI_MCP_TOOLS, BILI_READ_TOOLS.join(','));
  assert.deepEqual(Object.keys(spawn.options.env).sort(), ['BILI_MCP_TOOLS', 'HOME', 'PATH', 'PYTHONIOENCODING', 'PYTHONUTF8', 'TMPDIR'].sort());
  assert.equal(fs.statSync(f.stateDir).mode & 0o777, 0o700); assert.equal(fs.statSync(spawn.args.at(-1)).mode & 0o777, 0o600);
  assert.equal(f.browser.status.active, 0); assert.equal(f.browser.status.toolsVerified, true);
  await f.browser.dispose(); assert.equal(f.browser.status.toolsVerified, false);
});

for (const label of ['extra', 'missing', 'duplicate']) test('rejects ' + label + ' MCP tools without dispatching a platform call', async (t) => {
  const f = fixture(t);
  if (label === 'extra') f.state.toolNames.push('bili_reply');
  if (label === 'missing') f.state.toolNames.pop();
  if (label === 'duplicate') f.state.toolNames[0] = f.state.toolNames[1];
  await assert.rejects(f.browser.call('bili_search', { keyword: 'DSH' }, authorized), { code: 'TOOLSET_MISMATCH' });
  assert.equal(f.state.calls.some((item) => item.method === 'tools/call'), false); assert.equal(f.browser.status.active, 0);
});

test('rejects writes, excessive values, invalid BV numbers, unknown fields and unowned work before spawn', async (t) => {
  const f = fixture(t);
  for (const [name, args] of [['bili_reply', { bvid: BV }], ['bili_search', { keyword: 'a'.repeat(101) }], ['bili_search', { keyword: '  ' }],
    ['bili_search', { keyword: 'DSH', endpoint: 'https://other.example' }], ['bili_frames', { bvid: BV, num: 4 }],
    ['bili_frames', { bvid: BV, at: [1, 2, 3, 4] }], ['bili_video_info', { bvid: '../../secret' }]]) {
    await assert.rejects(f.browser.call(name, args, authorized), { code: 'INVALID_ARGS' });
  }
  await assert.rejects(f.browser.check({ authorize: () => false }), { code: 'FORBIDDEN' });
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.browser.check({ ...authorized, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(f.state.spawns.length, 0);
});

test('fixed source hash and symlink checks prevent modified launch artifacts', async (t) => {
  const f = fixture(t); fs.writeFileSync(f.scriptPath, '# changed');
  await assert.rejects(f.browser.check(authorized), { code: 'SOURCE_CHANGED' }); assert.equal(f.state.spawns.length, 0);
  const g = fixture(t); fs.mkdirSync(g.stateDir); fs.symlinkSync(g.scriptPath, path.join(g.stateDir, 'mcp_server.py'));
  await assert.rejects(g.browser.check(authorized), { code: 'SOURCE_CHANGED' }); assert.equal(g.state.spawns.length, 0);
});

test('successful public image reads are bounded, preserve matching BV identity and strip diagnostic or credential fields', async (t) => {
  const f = fixture(t);
  f.state.reply = () => ({ content: [...text({ bvid: BV, ok: true, title: 'Public', sessdata: PRIVATE, localPath: PRIVATE }).content,
    { type: 'image', mimeType: 'image/jpeg', data: jpeg }] });
  const result = await f.browser.call('bili_frames', { bvid: BV, num: 1 }, authorized);
  assert.equal(result.data.bvid, BV); assert.equal(result.images.length, 1); assert(!JSON.stringify(result).includes(PRIVATE));
  assert.equal(f.browser.status.readiness, 'read-verified'); assert.equal(f.browser.status.lastResult.bvid, BV);
});

test('large canonical base64 images use a linear validation path and stale status never refreshes itself', async (t) => {
  const f = fixture(t); const bytes = Buffer.alloc(1024 * 1024, 85); bytes.set([255, 216, 255]);
  f.state.reply = () => ({ content: [...text({ bvid: BV, ok: true }).content, { type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }] });
  const result = await f.browser.call('bili_frames', { bvid: BV }, authorized);
  assert.equal(Buffer.from(result.images[0].data, 'base64').length, bytes.length);
  f.browser.lastCheck.at = f.browser.lastResult.at = new Date(Date.now() - 601000).toISOString();
  assert.equal(f.browser.status.toolsVerified, false); assert.equal(f.browser.status.readiness, 'not-verified'); assert.equal(f.state.spawns.length, 1);
});

test('a mismatched BV, malformed image or upstream error cannot become successful evidence or leak diagnostics', async (t) => {
  for (const reply of [text({ bvid: OTHER }), { content: [...text({ bvid: BV }).content, { type: 'image', mimeType: 'image/jpeg', data: Buffer.from(PRIVATE).toString('base64') }] },
    { isError: true, content: [{ type: 'text', text: PRIVATE }] }, text({ bvid: BV, error: PRIVATE })]) {
    const f = fixture(t); f.state.reply = () => reply;
    await assert.rejects(f.browser.call('bili_frames', { bvid: BV }, authorized), (error) => !error.message.includes(PRIVATE));
    assert.equal(f.browser.status.lastResult.ok, false); assert(!JSON.stringify(f.browser.status).includes(PRIVATE));
  }
});

test('revocation after an asynchronous request drops the response and still waits for child exit', async (t) => {
  const f = fixture(t); let owner = true;
  f.state.reply = () => { owner = false; return text({ bvid: BV }); };
  await assert.rejects(f.browser.call('bili_video_info', { bvid: BV }, { authorize: () => owner }), { code: 'FORBIDDEN' });
  assert.equal(f.browser.status.active, 0); assert(f.state.children[0].kills.includes('SIGTERM'));
});

test('timeout aborts pending RPC and terminates the process without retrying', async (t) => {
  const f = fixture(t, { timeoutMs: 10 }); f.state.block = true;
  await assert.rejects(f.browser.check(authorized), { code: 'TIMEOUT' });
  assert.equal(f.state.spawns.length, 1); assert.equal(f.browser.status.active, 0);
});

test('cancellation and disposal stop accepted work and never start replacement operations', async (t) => {
  const f = fixture(t); f.state.block = true; const controller = new AbortController();
  const first = f.browser.check({ ...authorized, signal: controller.signal }); controller.abort();
  await assert.rejects(first, { code: 'CANCELLED' }); assert.equal(f.browser.status.active, 0);
  const pending = f.browser.check(authorized); await f.browser.dispose();
  await assert.rejects(pending); assert.equal(f.state.spawns.length, 2); assert.equal(f.browser.status.active, 0);
  await assert.rejects(f.browser.check(authorized), { code: 'UNAVAILABLE' }); assert.equal(f.state.spawns.length, 2);
});

test('bounded parallel reads reject a third process and release capacity only after cleanup', async (t) => {
  const f = fixture(t); f.state.block = true;
  const controllers = [new AbortController(), new AbortController()];
  const active = controllers.map((controller) => f.browser.check({ ...authorized, signal: controller.signal }));
  await assert.rejects(f.browser.check(authorized), { code: 'BUSY' }); assert.equal(f.state.spawns.length, 2);
  controllers.forEach((controller) => controller.abort()); await Promise.all(active.map((task) => assert.rejects(task)));
  assert.equal(f.browser.status.active, 0); assert.equal(f.browser.status.cleanupPending, false);
});

test('unconfirmed process cleanup remains blocked and cannot cause a duplicate spawn', async (t) => {
  const f = fixture(t, { timeoutMs: 10 }); f.state.block = true; f.state.noClose = true;
  await assert.rejects(f.browser.check(authorized), { code: 'CLEANUP_UNCONFIRMED' });
  assert.equal(f.browser.status.cleanupPending, true); assert.equal(f.browser.status.active, 1);
  await assert.rejects(f.browser.check(authorized), { code: 'BUSY' }); assert.equal(f.state.spawns.length, 1);
  f.state.noClose = false; f.state.children[0].emit('close', 0); await f.browser.dispose();
});

test('truncated or oversized stdio is rejected without a second process or platform call', async (t) => {
  const f = fixture(t); f.state.block = true;
  const pending = f.browser.check(authorized); queueMicrotask(() => f.state.children[0].stdout.write('not json\n'));
  await assert.rejects(pending, { code: 'INVALID_RESPONSE' }); assert.equal(f.state.spawns.length, 1);
  const g = fixture(t); g.state.block = true;
  const large = g.browser.check(authorized); queueMicrotask(() => g.state.children[0].stdout.write('a'.repeat(10 * 1024 * 1024 + 1)));
  await assert.rejects(large, { code: 'RESPONSE_TOO_LARGE' }); assert.equal(g.state.spawns.length, 1);
});

test('probe reads a selected search BV and falls back from unavailable subtitles only to read-only frames', async (t) => {
  const f = fixture(t);
  f.state.reply = ({ name, arguments: args }) => name === 'bili_search' ? text({ videos: [{ bvid: BV, title: 'Public' }] })
    : name === 'bili_video_info' ? text({ bvid: BV, title: 'Public details' })
    : name === 'bili_subtitle' ? { isError: true, content: [{ type: 'text', text: 'No login' }] }
      : { content: [...text({ bvid: args.bvid, ok: true }).content, { type: 'image', mimeType: 'image/jpeg', data: jpeg }] };
  const result = await f.browser.probe(authorized);
  assert.equal(result.bvid, BV); assert.equal(result.readBackBvid, BV); assert.equal(result.kind, 'frames');
  assert.equal(result.title, 'Public details');
  assert.deepEqual(f.state.calls.filter((item) => item.method === 'tools/call').map((item) => item.params.name), ['bili_search', 'bili_video_info', 'bili_subtitle', 'bili_frames']);
});

test('empty subtitles cannot pass a content check and fall back to actual sampled images', async (t) => {
  const f = fixture(t);
  f.state.reply = ({ name, arguments: args }) => name === 'bili_search' ? text({ videos: [{ bvid: BV, title: 'Public' }] })
    : name === 'bili_video_info' ? text({ bvid: BV, title: 'Public details' })
      : name === 'bili_subtitle' ? text({ bvid: BV, text: '   ', segments: 0 })
        : { content: [...text({ bvid: args.bvid }).content, { type: 'image', mimeType: 'image/jpeg', data: jpeg }] };
  assert.equal((await f.browser.probe(authorized)).kind, 'frames');
  f.state.reply = ({ name }) => name === 'bili_search' ? text({ videos: [{ bvid: BV }] })
    : name === 'bili_video_info' ? text({ bvid: BV, title: 'Public details' }) : text({ bvid: BV, text: '' });
  await assert.rejects(f.browser.probe(authorized), { code: 'NO_CONTENT' });
});

test('registered tool requires current owner identity, exact live control task, and rechecks before attaching images', async (t) => {
  const f = fixture(t); let tool, owner = true, task = 'turn:one', saved = 0;
  let identity = { isOwner: true, sessionId: 'session', peerId: 'owner', selfId: 'receiver' };
  const controlAccess = { scopeFor: () => owner ? { kind: 'owner', taskId: task, capabilities: ['browser'], leaseBusy: false } : null };
  const stop = registerBiliBrowserTools({ tools: { register(value) { tool = value; return () => {}; } }, get: () => ({ async saveImage() { saved++; task = 'turn:changed'; return { id: 'image' }; } }) },
    { browser: f.browser, getExecutionContext: () => identity, controlAccess });
  identity = { ...identity, isOwner: false };
  await assert.rejects(tool.execute({ operation: 'search', keyword: 'DSH' }, { agent: {} }), { code: 'FORBIDDEN' }); assert.equal(f.state.spawns.length, 0);
  identity = { ...identity, isOwner: true }; owner = false;
  await assert.rejects(tool.execute({ operation: 'search', keyword: 'DSH' }, { agent: {} }), { code: 'FORBIDDEN' }); owner = true;
  f.state.reply = () => ({ content: [...text({ bvid: BV, ok: true }).content, { type: 'image', mimeType: 'image/jpeg', data: jpeg }] });
  await assert.rejects(tool.execute({ operation: 'frames', bvid: BV }, { agent: {} }), { code: 'FORBIDDEN' }); assert.equal(saved, 1);
  stop(); await assert.rejects(tool.execute({ operation: 'search', keyword: 'DSH' }, { agent: {} }), { code: 'FORBIDDEN' });
});
