import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PanelLibrary, PanelLibraryError } from '../packages/dsh-dafeiyu/src/panel-library.js';
import { MemeManager } from '../packages/dsh-dafeiyu/src/meme-manager.js';
import { Role } from '../packages/companion/src/role.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
const PRIVATE = 'PANEL_LIBRARY_PRIVATE_CANARY';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-library-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new MemeManager({ desktopMemeDir: path.join(root, 'memes'), phoneTools: {
    pull() { throw new Error('phone must not be called'); },
  } });
  const cardPath = path.join(root, 'private', 'configured-role.md');
  fs.mkdirSync(path.dirname(cardPath));
  fs.writeFileSync(cardPath, '\ufeff' + PRIVATE + '\r\n说话简短，别编造。\r\n', { mode: 0o600 });
  const role = new Role({ cardPath });
  const state = { runtime: { brain: { role }, memeManager: manager } };
  const library = new PanelLibrary({ getRuntime: () => state.runtime, paths: () => ({ configFile: '/must/not/read/config.json' }) });
  const add = (file, title = '', tags = [], extra = {}) => {
    fs.writeFileSync(path.join(manager.libDir, file), PNG);
    fs.writeFileSync(path.join(manager.metadataDir, createHash('sha256').update(file).digest('hex') + '.json'), JSON.stringify({ title, tags, ...extra }));
  };
  return { root, manager, cardPath, role, state, library, add };
}
const rejected = (code) => (error) => {
  assert.ok(error instanceof PanelLibraryError);
  assert.equal(error.code, code);
  assert.equal(error.message.includes(PRIVATE), false);
  return true;
};

test('actual gallery metadata is filtered and paginated with stable opaque IDs and no paths', async (t) => {
  const { library, manager, add } = fixture(t);
  for (let i = 0; i < 26; i++) add(`meme-${String(i).padStart(2, '0')}.png`, `标题 ${i}`, ['blue', i === 4 ? '鲸鱼' : 'ordinary']);
  const first = await library.listMemes();
  assert.equal(first.items.length, 24);
  assert.equal(first.total, 26);
  assert.deepEqual(first.items[0], { id: first.items[0].id, file: 'meme-00.png', title: '标题 0', tags: ['blue', 'ordinary'], description: '', descriptionStatus: 'missing' });
  assert.match(first.items[0].id, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first).includes(manager.libDir), false);
  assert.equal(Object.hasOwn(first.items[0], 'path'), false);
  const next = await library.listMemes({ offset: 24, limit: 24 });
  assert.equal(next.items.length, 2);
  assert.equal(next.offset, 24);
  const same = await library.listMemes({ limit: 1 });
  assert.equal(same.items[0].id, first.items[0].id);
  assert.equal((await library.listMemes({ query: '鲸鱼' })).items[0].file, 'meme-04.png');
  assert.equal((await library.listMemes({ query: '标题 4 blue' })).total, 3);
  assert.equal((await library.listMemes({ query: 'not-present' })).total, 0);
  for (const input of [{ offset: -1 }, { offset: 1.5 }, { limit: 25 }, { limit: 0 }, { query: {} }, { query: 'a'.repeat(257) }]) {
    await assert.rejects(library.listMemes(input), rejected('INVALID_QUERY'));
  }
});

test('preview resolves only current opaque IDs and returns verified bytes and MIME', async (t) => {
  const { library, add } = fixture(t);
  add('real.png');
  const [{ id }] = (await library.listMemes()).items;
  const image = await library.memeImage(id);
  assert.deepEqual(Object.keys(image).sort(), ['bytes', 'mime']);
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(image.bytes, PNG);
  for (const value of ['../real.png', '/tmp/private.png', 'real.png', id + '/../../private', 'A'.repeat(64)]) {
    await assert.rejects(library.memeImage(value), rejected('INVALID_ID'));
  }
  await assert.rejects(library.memeImage('0'.repeat(64)), rejected('NOT_FOUND'));
});

test('traversal rows, outside/inside symlinks and stale IDs cannot escape the configured library', async (t) => {
  const { root, library, manager, add } = fixture(t);
  add('inside.png');
  const id = (await library.listMemes()).items[0].id;
  fs.writeFileSync(path.join(root, 'private.png'), PNG);
  fs.symlinkSync(path.join(root, 'private.png'), path.join(manager.libDir, 'outside.png'));
  fs.symlinkSync(path.join(manager.libDir, 'inside.png'), path.join(manager.libDir, 'alias.png'));
  const originalScan = manager.scanMemes.bind(manager);
  manager.scanMemes = () => { const scan = originalScan(); return { ...scan, memes: [...scan.memes, { filename: '../private.png', path: path.join(root, 'private.png') }] }; };
  const list = await library.listMemes();
  assert.deepEqual(list.items.map(({ file }) => file), ['inside.png']);
  assert.equal(list.partial, true);
  fs.unlinkSync(path.join(manager.libDir, 'inside.png'));
  fs.symlinkSync(path.join(root, 'private.png'), path.join(manager.libDir, 'inside.png'));
  await assert.rejects(library.memeImage(id), rejected('NOT_FOUND'));
});

test('fake images and corrupt metadata are partial warnings without private error text', async (t) => {
  const { library, manager, add } = fixture(t);
  add('valid.png');
  const valid = (await library.listMemes()).items[0].id;
  fs.writeFileSync(path.join(manager.libDir, 'fake.png'), Buffer.from('<svg>not a PNG</svg>'));
  add('bad-metadata.png');
  fs.writeFileSync(path.join(manager.metadataDir, createHash('sha256').update('bad-metadata.png').digest('hex') + '.json'), `{"private":"${PRIVATE}"`);
  const list = await library.listMemes();
  assert.deepEqual(list.items.map(({ file }) => file), ['valid.png']);
  assert.equal(list.partial, true);
  assert.ok(list.warnings.length > 0);
  assert.equal(JSON.stringify(list).includes(PRIVATE), false);
  fs.writeFileSync(path.join(manager.libDir, 'valid.png'), Buffer.from('<svg>replaced file</svg>'));
  await assert.rejects(library.memeImage(valid), rejected('NOT_FOUND'));
});

test('bounded display does not skip pagination and the complete JSON stays below 24k bytes', async (t) => {
  const { library, add } = fixture(t);
  for (let i = 0; i < 30; i++) add(`${i}-${'\x01'.repeat(180)}.png`, '\x02'.repeat(160), Array(30).fill('\x03'.repeat(80)), { description: '\x04'.repeat(1200) });
  const first = await library.listMemes();
  const next = await library.listMemes({ offset: 24 });
  assert.equal(first.items.length, 24);
  assert.equal(next.items.length, 6);
  assert.equal(first.total, 30);
  assert.equal(first.partial, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 24000);
  assert.equal(new Set([...first.items, ...next.items].map(({ id }) => id)).size, 30);
});

test('persona reads the exact current role file and does not fall back to unrelated config or memory', async (t) => {
  const { root, library, cardPath, state } = fixture(t);
  const expected = fs.readFileSync(cardPath, 'utf8');
  const view = await library.persona();
  assert.equal(view.text, expected);
  assert.equal(view.configured, true);
  assert.equal(view.editable, true);
  assert.equal(view.appliesNextTurn, true);
  assert.equal(view.injectionMaxChars, 12000);
  assert.equal(view.sourceLabel, 'configured-role.md');
  assert.match(view.revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify({ ...view, text: '' }).includes(root), false);
  state.runtime = null;
  assert.deepEqual(await library.persona(), { text: '', revision: null, configured: false, sourceLabel: '', editable: false, appliesNextTurn: false });
  await assert.rejects(library.savePersona({ text: 'replacement', revision: view.revision }), rejected('UNAVAILABLE'));
  await assert.rejects(library.listMemes(), rejected('UNAVAILABLE'));
});

test('persona CAS creates a byte-exact private backup and invalidates the running Role cache', async (t) => {
  const { root, library, cardPath, role } = fixture(t);
  const original = fs.readFileSync(cardPath), before = await library.persona();
  assert.equal(role.read(), original.toString('utf8'));
  fs.mkdirSync(path.join(root, 'memory')); fs.writeFileSync(path.join(root, 'memory', 'user.md'), PRIVATE);
  const next = '新的说话方式\n不要编造。\n';
  const result = await library.savePersona({ text: next, revision: before.revision });
  assert.equal(result.text, next);
  assert.equal(result.backupCreated, true);
  assert.equal(result.appliesNextTurn, true);
  assert.equal(result.injectionMaxChars, role.maxChars);
  assert.notEqual(result.revision, before.revision);
  assert.equal(role.read(), next, 'next prompt render must see the new role without five-second stale cache');
  assert.equal(fs.readFileSync(path.join(root, 'memory', 'user.md'), 'utf8'), PRIVATE);
  const files = fs.readdirSync(path.dirname(cardPath)), backups = files.filter((name) => name.startsWith('configured-role.md.bak-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(cardPath), backups[0])), original);
  assert.equal(fs.statSync(cardPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(path.dirname(cardPath), backups[0])).mode & 0o777, 0o600);
  assert.equal(files.some((name) => name.endsWith('.tmp') || name.endsWith('.lock')), false);
  await assert.rejects(library.savePersona({ text: 'stale', revision: before.revision }), rejected('CONFLICT'));
  assert.equal(fs.readFileSync(cardPath, 'utf8'), next);
});

test('persona refuses outside edits, explicit path injection and an existing writer lock', async (t) => {
  const { library, cardPath } = fixture(t);
  const before = await library.persona();
  await assert.rejects(library.savePersona({ text: 'new', revision: before.revision, path: '/tmp/other.md' }), rejected('INVALID_PERSONA'));
  await assert.rejects(library.savePersona({ text: 'x'.repeat(128 * 1024 + 1), revision: before.revision }), rejected('INVALID_PERSONA'));
  fs.appendFileSync(cardPath, 'outside edit');
  await assert.rejects(library.savePersona({ text: 'stale', revision: before.revision }), rejected('CONFLICT'));
  const current = await library.persona();
  fs.writeFileSync(cardPath + '.panel.lock', 'other writer');
  await assert.rejects(library.savePersona({ text: 'new', revision: current.revision }), rejected('BUSY'));
  assert.equal(fs.readFileSync(cardPath + '.panel.lock', 'utf8'), 'other writer');
  assert.equal(fs.readFileSync(cardPath, 'utf8'), current.text);
});

test('a role larger than the prompt budget is saved intact and reports that budget to the UI', async (t) => {
  const { library, cardPath, role } = fixture(t);
  role.maxChars = 512;
  const before = await library.persona(), text = '说话自然，别编造。\n'.repeat(1000);
  const saved = await library.savePersona({ text, revision: before.revision });
  assert.equal(saved.injectionMaxChars, 512);
  assert.ok(text.length > saved.injectionMaxChars);
  assert.equal(saved.text, text);
  assert.equal(fs.readFileSync(cardPath, 'utf8'), text, 'editing budget warnings must never truncate the role file');
});

test('a configured missing card can be created, while a changed runtime source invalidates its revision', async (t) => {
  const { library, cardPath, role } = fixture(t);
  fs.unlinkSync(cardPath);
  const absent = await library.persona();
  assert.equal(absent.configured, false); assert.equal(absent.editable, true);
  const result = await library.savePersona({ text: '说话自然，别编造。', revision: absent.revision });
  assert.equal(result.configured, true); assert.equal(result.backupCreated, false);
  role.cardPath = path.join(path.dirname(cardPath), 'another-role.md');
  fs.writeFileSync(role.cardPath, result.text);
  await assert.rejects(library.savePersona({ text: 'wrong target', revision: result.revision }), rejected('CONFLICT'));
  assert.equal(fs.readFileSync(role.cardPath, 'utf8'), result.text);
});

test('symlink, binary and oversized role sources fail closed without exposing content', async (t) => {
  const { library, cardPath } = fixture(t);
  const original = fs.readFileSync(cardPath);
  fs.renameSync(cardPath, cardPath + '.target'); fs.symlinkSync(cardPath + '.target', cardPath);
  await assert.rejects(library.persona(), rejected('PERSONA_UNREADABLE'));
  await assert.rejects(library.savePersona({ text: 'bad', revision: '0'.repeat(64) }), rejected('PERSONA_UNREADABLE'));
  assert.deepEqual(fs.readFileSync(cardPath + '.target'), original);
  fs.unlinkSync(cardPath); fs.writeFileSync(cardPath, Buffer.from([0xff, 0xfe, 0xff]));
  await assert.rejects(library.persona(), rejected('PERSONA_UNREADABLE'));
  fs.writeFileSync(cardPath, 'a'.repeat(128 * 1024 + 1));
  await assert.rejects(library.persona(), rejected('PERSONA_UNREADABLE'));
});

test('library-level failures are generic errors rather than an empty healthy gallery', async (t) => {
  const { library, manager } = fixture(t);
  manager.scanMemes = () => { throw new Error(PRIVATE); };
  await assert.rejects(library.listMemes(), rejected('LIBRARY_UNREADABLE'));
});

test('description summaries are searchable while details preserve full human and AI text', async (t) => {
  const { library, manager, add } = fixture(t);
  const description = '一只鲸鱼抱着枕头，表示现在很困、想休息。'.repeat(20);
  add('sleep.png', '困困', ['晚安'], { description, aiDescription: '用于表达困倦和温柔告别；不要用于讽刺。' });
  const result = await library.listMemes({ query: '枕头 困' });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].descriptionStatus, 'ready');
  assert.ok(result.items[0].description.length < description.length);
  assert.equal(Object.hasOwn(result.items[0], 'aiDescription'), false);
  assert.equal((await library.listMemes({ query: '温柔告别' })).total, 1);
  const detail = await library.memeDetail(result.items[0].id);
  assert.equal(detail.description, description);
  assert.equal(detail.aiDescription, '用于表达困倦和温柔告别；不要用于讽刺。');
  assert.match(detail.revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(detail).includes(manager.libDir), false);
  assert.equal(Object.hasOwn(detail, 'path'), false);
});

test('legacy memes remain previewable and require real descriptions on their first edit', async (t) => {
  const { library, manager, add } = fixture(t);
  add('legacy.png', '旧图', ['开心']);
  const { id } = (await library.listMemes()).items[0], detail = await library.memeDetail(id);
  assert.equal(detail.descriptionStatus, 'missing');
  assert.equal((await library.memeImage(id)).mime, 'image/png');
  await assert.rejects(library.saveMemeMetadata({ id, revision: detail.revision, patch: { title: '改名' } }), rejected('INVALID_DESCRIPTION'));
  const saved = await library.saveMemeMetadata({ id, revision: detail.revision,
    patch: { title: '开心', description: ' 鲸鱼挥动小鳍，表达开心和欢迎。 ', aiDescription: ' 打招呼时使用。 ', tags: ['问好'] } });
  assert.equal(saved.description, '鲸鱼挥动小鳍，表达开心和欢迎。');
  assert.equal(saved.aiDescription, '打招呼时使用。');
  assert.equal(saved.descriptionStatus, 'ready');
  assert.notEqual(saved.revision, detail.revision);
  assert.equal(manager.getMetadata('legacy.png').description, saved.description);
  const reload = new MemeManager({ desktopMemeDir: manager.desktopMemeDir });
  assert.equal(reload.getMetadata('legacy.png').description, saved.description);
  await assert.rejects(library.saveMemeMetadata({ id, revision: detail.revision, patch: { description: '过时修改' } }), rejected('CONFLICT'));
  assert.equal((await library.listMemes({ query: '小鳍 欢迎' })).total, 1);
});

test('metadata revisions bind both current runtime and manager instead of only reusable image IDs', async (t) => {
  const { library, manager, state, add } = fixture(t);
  add('one.png', '同图', [], { description: '鲸鱼摊开小鳍，表示无奈。' });
  const detail = await library.memeDetail((await library.listMemes()).items[0].id);
  state.runtime = { ...state.runtime };
  await assert.rejects(library.saveMemeMetadata({ id: detail.id, revision: detail.revision, patch: { description: '错写旧实例' } }), rejected('CONFLICT'));
  const second = await library.memeDetail(detail.id);
  assert.notEqual(second.revision, detail.revision);
  state.runtime.memeManager = new MemeManager({ desktopMemeDir: manager.desktopMemeDir });
  await assert.rejects(library.saveMemeMetadata({ id: second.id, revision: second.revision, patch: { description: '错写旧管理器' } }), rejected('CONFLICT'));
  assert.equal(manager.getMetadata('one.png').description, '鲸鱼摊开小鳍，表示无奈。');
});

test('metadata operations recheck owner and busy state before local writes and sanitize core errors', async (t) => {
  const { library, manager, add } = fixture(t);
  add('one.png', '', [], { description: '表示欢迎。' });
  const detail = await library.memeDetail((await library.listMemes()).items[0].id);
  const input = { id: detail.id, revision: detail.revision, patch: { description: '新的描写' } };
  for (const method of [() => library.memeDetail(detail.id, { authorize: () => false }),
    () => library.saveMemeMetadata(input, { authorize: () => false })]) await assert.rejects(method(), rejected('FORBIDDEN'));
  await assert.rejects(library.saveMemeMetadata(input, { getBusy: () => true }), rejected('BUSY'));
  let calls = 0;
  await assert.rejects(library.saveMemeMetadata(input, { authorize: () => ++calls < 2 }), rejected('FORBIDDEN'));
  assert.equal(manager.getMetadata('one.png').description, '表示欢迎。');
  manager.updateMetadata = () => ({ ok: false, code: 'INVALID_METADATA', error: PRIVATE });
  await assert.rejects(library.saveMemeMetadata(input), rejected('INVALID_METADATA'));
  for (const patch of [{ description: '' }, { description: ' '.repeat(4) }, { description: 'x'.repeat(1201) },
    { description: 42 }, { aiDescription: 'x'.repeat(1201) }, { title: 'x'.repeat(161) },
    { tags: Array(31).fill('a') }, { tags: ['x'.repeat(81)] }, { path: '/tmp/private' }]) {
    await assert.rejects(library.saveMemeMetadata({ ...input, patch }), (error) => error instanceof PanelLibraryError && error.code.startsWith('INVALID_'));
  }
});

test('manual upload imports actual bytes and descriptions, returning only current opaque metadata', async (t) => {
  const { library, manager } = fixture(t);
  const input = { filename: '欢迎.png', title: '欢迎', tags: ['你好'], description: '鲸鱼挥手，表示欢迎新朋友。',
    aiDescription: '适合初次问候；不要在道歉时使用。', imageBase64: PNG.toString('base64') };
  const imported = await library.importMeme(input);
  assert.equal(imported.imported, true);
  assert.equal(imported.descriptionStatus, 'ready');
  assert.equal(imported.description, input.description);
  assert.equal(Object.hasOwn(imported, 'path'), false);
  assert.equal(JSON.stringify(imported).includes(manager.libDir), false);
  assert.deepEqual((await library.memeImage(imported.id)).bytes, PNG);
  assert.equal((await library.listMemes({ query: '新朋友 初次' })).total, 1);
  const duplicate = await library.importMeme({ ...input, title: '重复提交新标题', tags: ['不要自动合并'], description: '更新的表情含义。', aiDescription: '不要自动覆盖。' });
  assert.equal(duplicate.imported, false);
  assert.equal(duplicate.duplicate, true);
  assert.match(duplicate.note, /保留原有描写/);
  assert.equal(duplicate.id, imported.id);
  assert.equal(duplicate.description, input.description);
  assert.equal(duplicate.aiDescription, input.aiDescription);
  assert.equal(duplicate.title, input.title);
  assert.deepEqual(duplicate.tags, input.tags);
  assert.equal(duplicate.revision, imported.revision);
  const edited = await library.saveMemeMetadata({ id: imported.id, revision: imported.revision, patch: { description: '更新的表情含义。' } });
  assert.equal(edited.description, '更新的表情含义。');
  assert.notEqual(edited.revision, imported.revision);
  assert.equal((await library.listMemes()).total, 1);
});

test('manual upload rejects unsafe names, missing meaning, oversized or malformed byte encodings before writing', async (t) => {
  const { library, manager } = fixture(t);
  const input = { filename: 'ok.png', title: '', tags: [], description: '鲸鱼微笑，表示开心。', imageBase64: PNG.toString('base64') };
  const cases = [
    { filename: '../outside.png' }, { filename: '/tmp/outside.png' }, { filename: 'a\\b.png' }, { filename: 'a\u0001.png' },
    { filename: 'x'.repeat(256) + '.png' }, { filename: 'script.svg' }, { path: '/tmp/private' },
    { imageBase64: 'data:image/png;base64,' + input.imageBase64 }, { imageBase64: input.imageBase64 + '\n' },
    { imageBase64: input.imageBase64.replace(/=+$/, '') }, { imageBase64: 'not bytes!' }, { imageBase64: 'AAAA===' },
    { imageBase64: Buffer.from('<script>not actual image</script>').toString('base64') },
    { imageBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') },
    { description: '' }, { description: undefined }, { description: 'x'.repeat(1201) },
  ];
  for (const patch of cases) await assert.rejects(library.importMeme({ ...input, ...patch }), (error) => error instanceof PanelLibraryError && error.code.startsWith('INVALID_'));
  await assert.rejects(library.importMeme(input, { authorize: () => false }), rejected('FORBIDDEN'));
  await assert.rejects(library.importMeme(input, { getBusy: () => true }), rejected('BUSY'));
  assert.equal(fs.readdirSync(manager.libDir).length, 0);
});
