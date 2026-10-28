import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PhoneTools } from '../packages/dsh-dafeiyu/src/phone-tools.js';
import { DeviceBinding } from '../packages/phone-mcp/src/phone-device.js';
import { normalizeMemeDescription } from '../packages/phone-mcp/src/shared/meme-description.js';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 217]);
const meaning = '鲸鱼挥动小鳍，表示开心欢迎；适合朋友间打招呼。';
const aiMeaning = '避免在争吵或需要严肃道歉时使用。';
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-meme-meaning-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function nativeFixture(t, { command, enabled = true } = {}) {
  const dir = temporary(t), calls = [], metadata = [];
  const phone = new PhoneTools({ device: 'fixture-phone', adbPath: 'fixture-adb', shotDir: dir, enabled,
    allowedTools: ['phone_steal_meme'], getExecutionContext: () => ({ scope: 'c2c', isOwner: true }),
    runCommand: async (bin, args, options) => {
      calls.push({ bin, args, options });
      if (command) await command(args, { phone, dir, metadata });
      if (args.includes('pull')) fs.writeFileSync(args.at(-1), PNG);
      if (args.includes('push')) metadata.push({ remote: args.at(-1), local: args.at(-2), value: JSON.parse(fs.readFileSync(args.at(-2), 'utf8')) });
      return { stdout: '', stderr: '' };
    },
  });
  t.after(() => phone.dispose());
  return { dir, phone, calls, metadata };
}

test('native phone collection requires meaning before any command, including direct API calls', async (t) => {
  const f = nativeFixture(t);
  for (const description of [undefined, '', '   ', 3, 'x'.repeat(1201)]) await assert.rejects(f.phone.stealMeme('欢迎', { description }));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.dir), []);
  const definitions = f.phone.registerToCordis({ logger: {}, tools: { register: () => () => {} } });
  const tool = definitions.find((row) => row.name === 'phone_steal_meme');
  assert.deepEqual(tool.parameters.required, ['description']);
  assert.equal(tool.parameters.properties.aiDescription.maxLength, 1200);
  await assert.rejects(tool.execute({}), /描写/);
  assert.equal(f.calls.length, 0);
});

test('native collection binds local and phone sidecars before publishing the screenshot', async (t) => {
  const f = nativeFixture(t);
  const tool = f.phone.registerToCordis({ logger: {}, tools: { register: () => () => {} } })[0];
  const result = await tool.execute({ name: '欢迎', description: '  ' + meaning + '  ', aiDescription: aiMeaning });
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readFileSync(result.path), PNG);
  assert.equal(result.metadataPath, result.path + '.json');
  assert.equal(result.remoteMetadataPath, result.remotePath + '.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.metadataPath, 'utf8')), { title: '欢迎', tags: [], description: meaning, aiDescription: aiMeaning });
  assert.equal(fs.statSync(result.metadataPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.equal(f.metadata[0].remote, result.remoteMetadataPath);
  const pushed = f.calls.findIndex(({ args }) => args.includes('push'));
  const published = f.calls.findIndex(({ args }) => args.at(-1).includes("'mv'"));
  assert.ok(pushed >= 0 && pushed < published);
  assert.ok(f.calls.find(({ args }) => args.at(-1).includes("'screencap'")).args.at(-1).includes('.pending'));
  assert.equal(f.phone.lastToolResult.name, 'phone_steal_meme');
});

test('native metadata push failure prevents publication and cannot report collection success', async (t) => {
  const f = nativeFixture(t, { command: (args) => { if (args.includes('push')) throw new Error('fixture metadata push failed'); } });
  await assert.rejects(f.phone.stealMeme('欢迎', { description: meaning }), /metadata push failed/);
  assert.ok(!f.calls.some(({ args }) => args.at(-1).includes("'mv'")));
  assert.ok(f.calls.at(-1).args.at(-1).includes("'rm' '-f'"));
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('native disabled, cancelled and interrupted collection never continues device writes', async (t) => {
  const disabled = nativeFixture(t, { enabled: false });
  await assert.rejects(disabled.phone.stealMeme('', { description: meaning }), /离线/);
  assert.equal(disabled.calls.length, 0);
  const aborted = new AbortController(); aborted.abort();
  const f = nativeFixture(t);
  await assert.rejects(f.phone.stealMeme('', { description: meaning, signal: aborted.signal }));
  assert.equal(f.calls.length, 0);
  const cancelling = new AbortController();
  const during = nativeFixture(t, { command: (args) => { if (args.includes('push')) cancelling.abort(); } });
  await assert.rejects(during.phone.stealMeme('', { description: meaning, signal: cancelling.signal }));
  assert.ok(!during.calls.some(({ args }) => args.at(-1).includes("'mv'")));
  assert.ok(!during.calls.some(({ args }) => args.at(-1).includes("'rm'")));
  assert.deepEqual(fs.readdirSync(during.dir), []);
});

const packageFile = process.env.PHONE_TEST_DEPENDENCY_ROOT
  ? path.join(path.resolve(process.env.PHONE_TEST_DEPENDENCY_ROOT), 'package.json')
  : fileURLToPath(new URL('../packages/phone-mcp/package.json', import.meta.url));
let dependencies;
try {
  const require = createRequire(packageFile);
  dependencies = { ...require('@modelcontextprotocol/sdk/server/mcp.js'), ...require('@modelcontextprotocol/sdk/client/index.js'),
    ...require('@modelcontextprotocol/sdk/inMemory.js'), z: require('zod').z };
} catch (error) { if (process.env.PHONE_TEST_DEPENDENCY_ROOT) throw error; }
const sdkTest = dependencies ? test : (name, fn) => test(name, { skip: 'Existing real SDK dependencies required; set PHONE_TEST_DEPENDENCY_ROOT' }, fn);
async function mcpFixture(t, { command, allowedTools = ['phone_steal_meme'] } = {}) {
  const dir = temporary(t), calls = [], metadata = [];
  const source = fs.readFileSync(new URL('../packages/phone-mcp/src/phone-mcp.js', import.meta.url), 'utf8')
    .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replace('const execFileAsync = promisify(execFile);', '');
  const body = source.slice(0, source.lastIndexOf("if (process.argv.includes('--selftest'))"));
  const env = { PHONE_ADB: 'fixture-adb', PHONE_SERIAL: 'fixture-phone', PHONE_SHOT_DIR: path.join(dir, 'shots'),
    PHONE_ALLOWED_TOOLS: JSON.stringify(allowedTools), PHONE_FFMPEG: 'fixture-ffmpeg' };
  const sandbox = { ...dependencies, fs, path, os: { ...os, homedir: () => dir }, Buffer, randomUUID, DeviceBinding, normalizeMemeDescription,
    console: { error() {} }, process: { env, cwd: () => dir, argv: [] }, ncm: {},
    execFileAsync: async (bin, args, options) => {
      calls.push({ bin, args, options });
      if (command) {
        const result = await command(args, { dir, metadata });
        if (result !== undefined) return result;
      }
      if (args.includes('get-state')) return { stdout: 'device', stderr: '' };
      if (args.includes('pull')) fs.writeFileSync(args.at(-1), PNG);
      if (args.includes('push') && args.at(-2).endsWith('.json')) metadata.push({ remote: args.at(-1), value: JSON.parse(fs.readFileSync(args.at(-2), 'utf8')) });
      return { stdout: '', stderr: '' };
    },
    execFile: (bin, args, options, callback) => {
      calls.push({ bin, args, options });
      fs.writeFileSync(args.at(-1), JPEG);
      callback(null, '', '');
    },
  };
  const server = await vm.runInNewContext(`(async () => { ${body}\nreturn server; })()`, sandbox);
  const [clientTransport, serverTransport] = dependencies.InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new dependencies.Client({ name: 'meme-meaning-fixture', version: '1' });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { dir, calls, metadata, client, call: (args, options) => client.callTool({ name: 'phone_steal_meme', arguments: args }, undefined, options) };
}

sdkTest('actual MCP schema requires descriptions and long_press refuses before any device actions', async (t) => {
  const f = await mcpFixture(t), tool = (await f.client.listTools()).tools.find((row) => row.name === 'phone_steal_meme');
  assert.ok(tool.inputSchema.required.includes('description'));
  assert.equal((await f.call({})).isError, true);
  assert.equal((await f.call({ description: '   ' })).isError, true);
  const longPress = await f.call({ mode: 'long_press', description: meaning });
  assert.equal(longPress.isError, true); assert.match(longPress.content[0].text, /crop_save/);
  assert.equal(f.calls.length, 0);
});

sdkTest('actual MCP crop_save binds exact JSON to local and remote filenames before publishing', async (t) => {
  const f = await mcpFixture(t), result = await f.call({ mode: 'crop_save', bounds: 'fullscreen', name: '欢迎', description: meaning, aiDescription: aiMeaning });
  assert.equal(result.isError, undefined);
  const saved = JSON.parse(result.content[0].text);
  assert.equal(saved.ok, true);
  assert.deepEqual(fs.readFileSync(saved.path), JPEG);
  assert.equal(saved.metadataPath, saved.path + '.json');
  assert.equal(saved.remoteMetadataPath, saved.remotePath + '.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(saved.metadataPath, 'utf8')), { title: '欢迎', tags: [], description: meaning, aiDescription: aiMeaning });
  assert.equal(fs.statSync(saved.metadataPath).mode & 0o777, 0o600);
  const metaPush = f.calls.findIndex(({ args }) => args.includes('push') && args.at(-2).endsWith('.json'));
  const imagePush = f.calls.findIndex(({ args }) => args.includes('push') && !args.at(-2).endsWith('.json'));
  const published = f.calls.findIndex(({ args }) => args.at(-1).startsWith('mv '));
  assert.ok(metaPush >= 0 && metaPush < imagePush && imagePush < published);
  assert.equal(f.metadata[0].remote, saved.remoteMetadataPath);
  assert.equal(fs.readdirSync(path.dirname(saved.path)).filter((name) => name.startsWith('shot-')).length, 0);
});

sdkTest('actual MCP metadata failure returns error and never publishes an album image', async (t) => {
  const f = await mcpFixture(t, { command: (args) => { if (args.includes('push') && args.at(-2).endsWith('.json')) throw new Error('fixture metadata failure'); } });
  const result = await f.call({ description: meaning });
  assert.equal(result.isError, true);
  assert.ok(!f.calls.some(({ args }) => args.at(-1).startsWith('mv ')));
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'shots')), []);
});

sdkTest('actual MCP disabled tool remains unavailable and offline selected device cannot capture', async (t) => {
  const disabled = await mcpFixture(t, { allowedTools: ['phone_status'] });
  assert.ok(!(await disabled.client.listTools()).tools.some((row) => row.name === 'phone_steal_meme'));
  assert.equal(disabled.calls.length, 0);
  const offline = await mcpFixture(t, { command: (args) => args.includes('get-state') ? { stdout: 'offline', stderr: '' } : undefined });
  const result = await offline.call({ description: meaning });
  assert.equal(result.isError, true);
  assert.equal(offline.calls.length, 1);
  assert.deepEqual(Array.from(offline.calls[0].args), ['-s', 'fixture-phone', 'get-state']);
});

sdkTest('actual MCP cancellation during metadata push prevents publication and further cleanup commands', async (t) => {
  let entered, release, finished;
  const started = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const complete = new Promise((resolve) => { finished = resolve; });
  const f = await mcpFixture(t, { command: async (args, { dir }) => {
    if (args.includes('push') && args.at(-2).endsWith('.json')) {
      entered(); await barrier;
      // Finish waiting only after the handler has observed its cancelled signal.
      setTimeout(finished, 15);
    }
  } });
  const abort = new AbortController();
  const pending = f.call({ description: meaning }, { signal: abort.signal });
  await started;
  abort.abort();
  await assert.rejects(pending);
  await new Promise((resolve) => setImmediate(resolve));
  release(); await complete;
  assert.ok(!f.calls.some(({ args }) => args.at(-1).startsWith('mv ')));
  assert.ok(!f.calls.some(({ args }) => args.at(-1).startsWith('rm ')));
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'shots')), []);
});

test('native device reconfiguration during capture cannot move description writes to another phone', async (t) => {
  const f = nativeFixture(t, { command: (args, { phone }) => { if (args.includes('pull')) phone.device = 'different-fixture-phone'; } });
  await assert.rejects(f.phone.stealMeme('', { description: meaning }), /设备配置已变化/);
  assert.ok(!f.calls.some(({ args }) => args.includes('push')));
  assert.ok(f.calls.every(({ args }) => args[1] === 'fixture-phone'));
  assert.deepEqual(fs.readdirSync(f.dir), []);
});
