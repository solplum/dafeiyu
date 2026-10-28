import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemeManager } from '../packages/dsh-dafeiyu/src/meme-manager.js';
import { MemeTools } from '../packages/dsh-dafeiyu/src/meme-tools.js';
import { MemoryBridge } from '../packages/dsh-dafeiyu/src/memory-bridge.js';
import { CompanionToolRegistry } from '../packages/dsh-dafeiyu/src/companion-tool-registry.js';
import { runToolLoop } from '../packages/companion/src/tool-loop.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aGQAAAAASUVORK5CYII=', 'base64');
const DESCRIPTION = '测试像素图，表达想吃饭或请求投喂，适合轻松玩笑语境。';
const OWNER = { userId: '100', key: 'private:100', isGroup: false };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-meme-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imports = path.join(root, 'imports'); fs.mkdirSync(imports);
  const image = path.join(imports, 'actual.png'); fs.writeFileSync(image, PNG);
  const manager = new MemeManager({ desktopMemeDir: path.join(root, 'library') });
  return { root, imports, image, manager };
}

test('collection persists real bytes and searchable labels, deduplicates and matches emotion rather than random images', (t) => {
  const { manager, image } = fixture(t);
  const food = manager.collectMeme(image, '大肥鱼吃饭', { tags: ['food', '大白饭'], description: DESCRIPTION });
  assert.equal(food.ok, true); assert.equal(food.imported, true);
  assert.deepEqual(fs.readFileSync(food.path), PNG);
  assert.equal(manager.collectMeme(image, '大肥鱼吃饭', { description: DESCRIPTION }).imported, false);
  assert.equal(manager.searchMemes('大白饭').total, 1);
  assert.equal(manager.matchMemeForReply('本鱼饿了想吃饭').meme.filename, food.filename);
  assert.equal(manager.matchMemeForReply('躺着睡觉'), null);
  const reloaded = new MemeManager({ desktopMemeDir: manager.desktopMemeDir });
  assert.equal(reloaded.searchMemes('大白饭').total, 1);
});

test('native library collect/search/preview use current identity and actual attachment, never a QQ send', async (t) => {
  const { manager, imports, image, root } = fixture(t);
  let identity = { isOwner: true, trusted: true, scope: 'desktop' }, attached = 0;
  const registered = new Map();
  const tools = new MemeTools({ memeManager: manager, allowedImportRoots: [imports], getExecutionContext: () => identity });
  tools.registerToCordis({ tools: { register(def) { registered.set(def.name, def); return () => registered.delete(def.name); } },
    get() { return { saveImage: async (input) => { assert.deepEqual(input.data, PNG); attached++; return { attachmentId: 'fixture-image' }; } }; } });
  assert.equal(registered.has('dafeiyu_meme_sync'), false);
  const collected = await registered.get('dafeiyu_meme_collect').execute({ path: image, title: '吃饭', description: DESCRIPTION }, {});
  assert.equal(collected.ok, true);
  const search = await registered.get('dafeiyu_meme_search').execute({ replyText: '饿了' }, {});
  assert.equal(search.match.meme.filename, collected.filename);
  const preview = registered.get('dafeiyu_meme_preview');
  const value = await preview.execute({ filename: collected.filename }, {});
  assert.equal(attached, 1); assert.equal(preview.output.render({}, value)[1].type, 'image');
  const outside = path.join(root, 'outside.png'); fs.writeFileSync(outside, PNG);
  fs.symlinkSync(outside, path.join(imports, 'escape.png'));
  await assert.rejects(registered.get('dafeiyu_meme_collect').execute({ path: path.join(imports, 'escape.png'), description: DESCRIPTION }, {}), /已授权/);
  identity = { isOwner: false, scope: 'c2c' };
  await assert.rejects(preview.execute({ filename: collected.filename }, {}), /已验证/);
  tools.dispose(); assert.equal(registered.size, 0);
  await assert.rejects(preview.execute({ filename: collected.filename }, {}), /卸载/);
});

test('explicit native sync imports real phone images and records partial failures honestly', async (t) => {
  const { manager } = fixture(t);
  let pulls = 0;
  manager.phoneTools = { pull: async (_remote, local) => {
    pulls++; fs.mkdirSync(path.join(local, 'album')); fs.writeFileSync(path.join(local, 'album', '吃饭.png'), PNG);
    fs.writeFileSync(path.join(local, 'album', 'broken.png'), 'not an image'); return { ok: true };
  } };
  const registered = new Map();
  const tools = new MemeTools({ memeManager: manager, phoneEnabled: true, allowPhoneSync: true,
    getExecutionContext: () => ({ isOwner: true, scope: 'c2c' }) });
  tools.registerToCordis({ tools: { register(def) { registered.set(def.name, def); } } });
  const sync = registered.get('dafeiyu_meme_sync');
  const args = { descriptions: [{ filename: 'album/吃饭.png', description: DESCRIPTION }, { filename: 'album/broken.png', description: DESCRIPTION }] };
  const result = await sync.execute(args, {});
  assert.equal(result.ok, false); assert.equal(result.partial, true); assert.equal(result.imported, 1);
  assert.equal(manager.searchMemes('吃饭').total, 1); assert.equal(pulls, 1);
  tools.allowPhoneSync = false; await assert.rejects(sync.execute(args, {}), /禁用/); assert.equal(pulls, 1);
  assert.equal(fs.readdirSync(manager.desktopMemeDir).some((file) => file.startsWith('tmp_pull-')), false);
});

test('independent model tool loop searches, previews and sends the exact selected library image with evidence', async (t) => {
  const { manager, image } = fixture(t);
  const item = manager.collectMeme(image, '大肥鱼吃饭', { description: DESCRIPTION }); let sent = 0, round = 0;
  const registry = new CompanionToolRegistry({ ownerQq: '100', memeManager: manager,
    sendImage: async (key, file) => { assert.equal(key, OWNER.key); assert.equal(file, fs.realpathSync(item.path)); sent++; return { ok: true }; } });
  const result = await runToolLoop({ registry, context: OWNER, messages: [{ role: 'user', content: '发张吃饭的表情' }],
    request: async (messages) => {
      round++;
      if (round <= 3) {
        const name = ['meme_search', 'meme_preview', 'meme_send'][round - 1];
        const args = round === 1 ? { replyText: '饿了要吃饭' } : { filename: item.filename };
        if (round === 3) assert.ok(messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')));
        return { choices: [{ message: { tool_calls: [{ id: String(round), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
      }
      return { choices: [{ message: { content: '已发送实际选中的图片' } }] };
    } });
  assert.equal(sent, 1, JSON.stringify(result.toolResults)); assert.equal(result.toolFailed, false); assert.equal(result.toolResults.length, 3);
});

test('independent memory facts survive later events, and fake transcription callbacks do not imply a provider', async (t) => {
  const { root } = fixture(t);
  const bridge = new MemoryBridge({ projectRoot: root });
  const registry = new CompanionToolRegistry({ ownerQq: '100', memoryBridge: bridge, allowMemoryWrites: true,
    phoneTools: { transcribeAudio: () => { throw new Error('not configured'); } } });
  await registry.execute('remember_fact', { key: 'drink', summary: '喜欢的饮料', detail: '无糖乌龙茶' }, OWNER);
  for (let i = 0; i < 12; i++) await registry.execute('remember_event', { summary: `事件${i}`, detail: '后续日常'.repeat(90) }, OWNER);
  const found = await registry.execute('memory_search', { query: '乌龙茶' }, OWNER);
  assert.equal(found.output.matches[0].kind, 'fact');
  assert.match(bridge.buildSystemPrompt('', { isOwner: true }), /无糖乌龙茶/);
  assert.equal((await registry.execute('companion_status', {}, OWNER)).output.stt.configured, false);
});

test('relocated skill resolves its own checkout and refuses disabled phone without importing runtime', (t) => {
  const { root } = fixture(t);
  const script = path.join(root, 'skills/dafeiyu/scripts/companion.mjs'); fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../skills/dafeiyu/scripts/companion.mjs', import.meta.url)), script);
  const config = path.join(root, 'packages/dsh-dafeiyu/config.json'); fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ phoneEnabled: false, memoryProjectRoot: path.join(root, 'archive') }));
  const status = spawnSync(process.execPath, [script, '--status'], { encoding: 'utf8' });
  assert.equal(status.status, 0); const value = JSON.parse(status.stdout);
  assert.equal(value.codeRoot, fs.realpathSync(root)); assert.equal(value.memoryRoot, path.join(root, 'archive'));
  const start = spawnSync(process.execPath, [script, '--start-phone', '--run'], { encoding: 'utf8' });
  assert.equal(start.status, 1); assert.match(start.stderr, /当前未启动手机服务/); assert.doesNotMatch(start.stderr, /MODULE_NOT_FOUND/);
});
