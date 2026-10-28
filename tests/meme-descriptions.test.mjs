import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemeManager, normalizeMemeDescription } from '../packages/dsh-dafeiyu/src/meme-manager.js';
import { MemeTools } from '../packages/dsh-dafeiyu/src/meme-tools.js';
import { CompanionToolRegistry } from '../packages/dsh-dafeiyu/src/companion-tool-registry.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aGQAAAAASUVORK5CYII=', 'base64');
const DESCRIPTION = '一张测试像素图，表达想吃饭或请求投喂，适合轻松开玩笑的聊天。';
const AI_DESCRIPTION = '只用于玩笑邀约吃饭；正式讨论营养或健康时避免使用。';
const OWNER = { userId: '100', key: 'private:100', isGroup: false };
const metadataPath = (manager, filename) => path.join(manager.metadataDir, createHash('sha256').update(filename).digest('hex') + '.json');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-description-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imports = path.join(root, 'imports'); fs.mkdirSync(imports);
  const source = path.join(imports, 'source.png'); fs.writeFileSync(source, PNG);
  return { root, imports, source, manager: new MemeManager({ desktopMemeDir: path.join(root, 'library') }) };
}
function native(manager, imports) {
  const definitions = new Map();
  new MemeTools({ memeManager: manager, allowedImportRoots: [imports], phoneEnabled: true, allowPhoneSync: true,
    getExecutionContext: () => ({ isOwner: true, scope: 'c2c' }) }).registerToCordis({ tools: { register(def) { definitions.set(def.name, def); } } });
  return definitions;
}

test('every direct import requires a specific nonblank description before any file write', (t) => {
  const { manager, source } = fixture(t);
  for (const description of [undefined, '', ' \n\t ', null, 17, '字'.repeat(1201)]) {
    for (const result of [manager.collectMeme(source, '有名字', { tags: ['food'], description }), manager.collectImage(PNG, '有名字', { description })]) {
      assert.equal(result.ok, false);
      assert.match(result.error, /描写|含义/);
      assert.deepEqual(fs.readdirSync(manager.libDir), []);
      assert.deepEqual(fs.readdirSync(manager.metadataDir), []);
    }
  }
  assert.equal(manager.collectMeme('/nonexistent.png', '', {}).code, 'DESCRIPTION_REQUIRED');
  assert.equal(normalizeMemeDescription('  画面和使用语境  ', { required: true }), '画面和使用语境');
  assert.throws(() => normalizeMemeDescription(null), /文字|文本/);
});

test('uploaded bytes persist both descriptions, search meaning and AI usage notes after reload', (t) => {
  const { manager } = fixture(t);
  const first = manager.collectImage(PNG, '像素图', { tags: ['测试'], description: ` ${DESCRIPTION} `, aiDescription: AI_DESCRIPTION });
  assert.equal(first.ok, true); assert.equal(first.imported, true);
  assert.deepEqual(fs.readFileSync(first.path), PNG);
  assert.equal(first.metadata.description, DESCRIPTION);
  assert.equal(first.metadata.aiDescription, AI_DESCRIPTION);
  assert.equal(first.metadata.descriptionStatus, 'ready');
  assert.match(first.metadata.revision, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(metadataPath(manager, first.filename)).mode & 0o777, 0o600);
  const reloaded = new MemeManager({ desktopMemeDir: manager.desktopMemeDir });
  for (const query of ['请求投喂', '正式讨论营养']) {
    const row = reloaded.searchMemes(query).memes[0];
    assert.equal(row.filename, first.filename); assert.equal(row.description, DESCRIPTION); assert.equal(row.aiDescription, AI_DESCRIPTION);
  }
  const recommendation = reloaded.matchMemeForReply('饿了');
  assert.equal(recommendation.meme.filename, first.filename);
  assert.equal(recommendation.meme.aiDescription, AI_DESCRIPTION);
});

test('legacy images remain previewable and searchable as missing, and never win automatic recommendation', (t) => {
  const { manager } = fixture(t);
  fs.writeFileSync(path.join(manager.libDir, '吃饭.png'), PNG);
  const old = manager.getMetadata('吃饭.png');
  assert.deepEqual(old, { title: '', tags: [], description: '', aiDescription: '', descriptionStatus: 'missing', revision: 'missing' });
  assert.equal(manager.searchMemes('吃饭').memes[0].descriptionStatus, 'missing');
  assert.deepEqual(manager.readImage('吃饭.png').bytes, PNG);
  assert.equal(manager.matchMemeForReply('饿了要吃饭'), null);
  const saved = manager.updateMetadata('吃饭.png', { revision: 'missing', patch: { description: DESCRIPTION } });
  assert.equal(saved.ok, true); assert.equal(saved.aiDescription, '');
  assert.equal(manager.matchMemeForReply('饿了').meme.filename, '吃饭.png');
});

test('metadata edit shares CAS across manager instances, backs up old content, and forbids clearing meaning', (t) => {
  const { manager } = fixture(t);
  const added = manager.collectImage(PNG, '原名', { description: DESCRIPTION });
  const current = manager.getMetadata(added.filename), target = metadataPath(manager, added.filename), original = fs.readFileSync(target);
  const second = new MemeManager({ desktopMemeDir: manager.desktopMemeDir });
  const saved = manager.updateMetadata(added.filename, { revision: current.revision, patch: { title: '新名', aiDescription: AI_DESCRIPTION } });
  assert.equal(saved.ok, true); assert.notEqual(saved.revision, current.revision);
  const stale = second.updateMetadata(added.filename, { revision: current.revision, patch: { description: '过期操作不可覆盖最新内容。' } });
  assert.equal(stale.ok, false); assert.equal(stale.code, 'CONFLICT');
  for (const description of ['', '  ', null]) {
    assert.equal(manager.updateMetadata(added.filename, { revision: saved.revision, patch: { description } }).ok, false);
    assert.equal(manager.getMetadata(added.filename).description, DESCRIPTION);
  }
  assert.equal(manager.updateMetadata(added.filename, { revision: saved.revision, patch: { path: '/tmp/other' } }).ok, false);
  const backups = fs.readdirSync(manager.metadataDir).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1); assert.deepEqual(fs.readFileSync(path.join(manager.metadataDir, backups[0])), original);
  assert.equal(fs.statSync(path.join(manager.metadataDir, backups[0])).mode & 0o777, 0o600);
});

test('duplicate imports preserve curated meaning and editor revision until an explicit CAS edit', (t) => {
  const { manager, source } = fixture(t);
  const first = manager.collectMeme(source, '原名', { description: DESCRIPTION, tags: ['旧标签'] });
  const duplicate = manager.collectImage(PNG, '新名', { description: '测试像素图，用于表达收到消息并礼貌回应。', aiDescription: '', tags: ['新标签'] });
  assert.equal(duplicate.ok, true); assert.equal(duplicate.imported, false); assert.equal(duplicate.filename, first.filename);
  assert.equal(fs.readdirSync(manager.libDir).length, 1);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.metadata, first.metadata);
  assert.equal(manager.getMetadata(first.filename).description, DESCRIPTION);
  assert.equal(manager.updateMetadata(first.filename, { revision: first.metadata.revision, patch: { description: '测试像素图，用于明确确认收到消息。' } }).ok, true);
});

test('reimport can complete an older hash-named image that genuinely has no meaning yet', (t) => {
  const { manager } = fixture(t);
  const added = manager.collectImage(PNG, '旧版收藏', { description: DESCRIPTION });
  fs.writeFileSync(metadataPath(manager, added.filename), JSON.stringify({ title: '旧版收藏', tags: ['既有标签'] }));
  const old = manager.getMetadata(added.filename);
  assert.equal(old.descriptionStatus, 'missing');
  const completed = manager.collectImage(PNG, '补充描写', { description: DESCRIPTION, aiDescription: AI_DESCRIPTION, tags: ['补充标签'] });
  assert.equal(completed.ok, true); assert.equal(completed.imported, false); assert.equal(completed.duplicate, undefined);
  assert.equal(completed.filename, added.filename); assert.equal(completed.metadata.descriptionStatus, 'ready');
  assert.notEqual(completed.metadata.revision, old.revision);
  assert.equal(completed.metadata.description, DESCRIPTION); assert.equal(completed.metadata.aiDescription, AI_DESCRIPTION);
  assert.deepEqual(completed.metadata.tags, ['既有标签', '补充标签']);
  assert.equal(fs.readdirSync(manager.libDir).length, 1);
});

test('same-content arbitrary legacy names preserve curated descriptions without cloning or changing revision', (t) => {
  const { manager } = fixture(t), legacy = '8a80c39df102.png';
  fs.writeFileSync(path.join(manager.libDir, legacy), PNG);
  const saved = manager.updateMetadata(legacy, { revision: 'missing', patch: { title: '精修名称', tags: ['精修标签'], description: DESCRIPTION, aiDescription: AI_DESCRIPTION } });
  assert.equal(saved.ok, true);
  const before = manager.getMetadata(legacy), oldBytes = fs.readFileSync(metadataPath(manager, legacy));
  const result = manager.collectImage(PNG, '重新上传名称', { description: '不应覆盖用户精修的含义。', tags: ['新增标签'] });
  assert.equal(result.ok, true); assert.equal(result.duplicate, true); assert.equal(result.imported, false);
  assert.equal(result.filename, legacy); assert.deepEqual(result.metadata, before);
  assert.deepEqual(fs.readFileSync(metadataPath(manager, legacy)), oldBytes);
  assert.deepEqual(fs.readdirSync(manager.libDir), [legacy]);
});

test('same-content arbitrary legacy names with missing meaning are completed in their original entry', (t) => {
  const { manager } = fixture(t), legacy = '用户取的旧名.png';
  fs.writeFileSync(path.join(manager.libDir, legacy), PNG);
  const result = manager.collectImage(PNG, '补充名称', { description: DESCRIPTION, aiDescription: AI_DESCRIPTION });
  assert.equal(result.ok, true); assert.equal(result.imported, false); assert.equal(result.duplicate, undefined);
  assert.equal(result.filename, legacy); assert.equal(result.metadata.description, DESCRIPTION);
  assert.equal(manager.getMetadata(legacy).descriptionStatus, 'ready');
  assert.deepEqual(fs.readdirSync(manager.libDir), [legacy]);
});

test('legacy same-content broken sidecars reject collection instead of bypassing damage with a new filename', (t) => {
  const { manager } = fixture(t), legacy = 'bad-legacy.png';
  fs.writeFileSync(path.join(manager.libDir, legacy), PNG);
  fs.writeFileSync(metadataPath(manager, legacy), '{broken');
  const result = manager.collectImage(PNG, '不应克隆', { description: DESCRIPTION });
  assert.equal(result.ok, false); assert.equal(result.code, 'METADATA_UNREADABLE');
  assert.equal(result.partial, true); assert.deepEqual(fs.readdirSync(manager.libDir), [legacy]);
  assert.equal(fs.readFileSync(metadataPath(manager, legacy), 'utf8'), '{broken');
});

test('hash-prefix entries are verified against actual bytes after external replacement', (t) => {
  const { manager } = fixture(t);
  const added = manager.collectImage(PNG, '原始', { description: DESCRIPTION });
  const changed = Buffer.from(PNG); changed[changed.length - 1] ^= 1; fs.writeFileSync(added.path, changed);
  const result = manager.collectImage(PNG, '另一名称', { description: DESCRIPTION });
  assert.equal(result.ok, false); assert.equal(result.code, 'IMAGE_INDEX_MISMATCH');
  assert.deepEqual(fs.readdirSync(manager.libDir), [added.filename]);
  assert.deepEqual(fs.readFileSync(added.path), changed);
  assert.equal(manager.getMetadata(added.filename).revision, added.metadata.revision);
});

test('explicit dedup checks use size filtering while daily scans retain bounded header reads', (t) => {
  const { manager } = fixture(t), legacy = 'same-content.png';
  fs.writeFileSync(path.join(manager.libDir, legacy), PNG);
  for (let index = 1; index <= 10; index++) fs.writeFileSync(path.join(manager.libDir, `different-size-${index}.png`), Buffer.concat([PNG, Buffer.alloc(index)]));
  const read = fs.readFileSync, imageReads = [], canonicalRoot = fs.realpathSync(manager.libDir);
  fs.readFileSync = (file, ...args) => { if (String(file).startsWith(canonicalRoot + path.sep)) imageReads.push(path.basename(file)); return read(file, ...args); };
  try {
    manager.scanMemes(); assert.deepEqual(imageReads, []);
    const result = manager.collectImage(PNG, '补充旧图', { description: DESCRIPTION });
    assert.equal(result.ok, true); assert.equal(result.filename, legacy);
    assert.deepEqual(imageReads, [legacy]);
  } finally { fs.readFileSync = read; }
});

test('excessive same-size candidate counts fail before comparison or any import write', (t) => {
  const { manager } = fixture(t);
  for (let index = 0; index < 129; index++) fs.writeFileSync(path.join(manager.libDir, `candidate-${index}.png`), PNG);
  const before = fs.readdirSync(manager.libDir), read = fs.readFileSync, canonicalRoot = fs.realpathSync(manager.libDir);
  fs.readFileSync = (file, ...args) => { if (String(file).startsWith(canonicalRoot + path.sep)) throw new Error('comparison must remain bounded'); return read(file, ...args); };
  let result;
  try { result = manager.collectImage(PNG, '不应导入', { description: DESCRIPTION }); }
  finally { fs.readFileSync = read; }
  assert.equal(result.ok, false); assert.equal(result.code, 'DEDUPLICATION_LIMIT'); assert.match(result.error, /先排查同图/);
  assert.deepEqual(fs.readdirSync(manager.libDir), before); assert.deepEqual(fs.readdirSync(manager.metadataDir), []);
});

test('dedup comparison bytes are capped at 64 MiB even below the candidate count limit', (t) => {
  const { manager } = fixture(t);
  // A valid GIF comment makes a large fixture without changing its one-pixel image.
  const base = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const payload = 6 * 1024 * 1024, blocks = Math.ceil(payload / 255), comment = Buffer.alloc(payload + blocks + 3, 32);
  comment[0] = 0x21; comment[1] = 0xfe;
  let remaining = payload, offset = 2;
  while (remaining) { const size = Math.min(255, remaining); comment[offset] = size; offset += size + 1; remaining -= size; }
  comment[offset] = 0;
  const bytes = Buffer.concat([base.subarray(0, 19), comment, base.subarray(19)]);
  assert.ok(bytes.length < 8 * 1024 * 1024 && bytes.length * 11 > 64 * 1024 * 1024);
  const first = path.join(manager.libDir, 'candidate-0.gif'); fs.writeFileSync(first, bytes);
  for (let index = 1; index < 11; index++) fs.linkSync(first, path.join(manager.libDir, `candidate-${index}.gif`));
  const before = fs.readdirSync(manager.libDir), read = fs.readFileSync, canonicalRoot = fs.realpathSync(manager.libDir);
  fs.readFileSync = (file, ...args) => { if (String(file).startsWith(canonicalRoot + path.sep)) throw new Error('large comparison must not start'); return read(file, ...args); };
  let result;
  try { result = manager.collectImage(bytes, '不得超预算', { description: '测试像素图，用于验证大图查重预算。' }); }
  finally { fs.readFileSync = read; }
  assert.equal(result.ok, false); assert.equal(result.code, 'DEDUPLICATION_LIMIT');
  assert.deepEqual(fs.readdirSync(manager.libDir), before); assert.deepEqual(fs.readdirSync(manager.metadataDir), []);
});

test('new upload rejects invalid format and oversize bytes and removes a new image if metadata commit fails', (t) => {
  const { manager } = fixture(t);
  assert.equal(manager.collectImage(Buffer.from('not a real picture'), '错误', { description: DESCRIPTION }).ok, false);
  assert.equal(manager.collectImage(Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]), '过大', { description: DESCRIPTION }).ok, false);
  assert.equal(manager.collectImage(PNG, '错误选图补充', { description: DESCRIPTION, aiDescription: '字'.repeat(1201) }).ok, false);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).startsWith(manager.metadataDir)) throw new Error('fixture commit failure'); return rename(from, to); };
  try { assert.equal(manager.collectImage(PNG, '回滚', { description: DESCRIPTION }).ok, false); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readdirSync(manager.libDir), []);
  assert.deepEqual(fs.readdirSync(manager.metadataDir), []);
});

test('failed metadata edits and legacy completion preserve existing bytes and sidecars', (t) => {
  const { manager } = fixture(t);
  const added = manager.collectImage(PNG, '原图', { description: DESCRIPTION });
  const target = metadataPath(manager, added.filename), original = fs.readFileSync(target), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === target) throw new Error('fixture rename denied'); return rename(from, to); };
  try {
    const updated = manager.updateMetadata(added.filename, { revision: added.metadata.revision, patch: { description: '不能写入的更新含义。' } });
    assert.equal(updated.ok, false);
    assert.deepEqual(fs.readFileSync(target), original);
    const legacy = JSON.stringify({ title: '旧条目', tags: [] }); fs.writeFileSync(target, legacy);
    const completed = manager.collectImage(PNG, '原图', { description: '同样不能写入的旧条目补充。' });
    assert.equal(completed.ok, false);
    assert.equal(fs.readFileSync(target, 'utf8'), legacy);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(added.path), PNG);
  assert.equal(manager.getMetadata(added.filename).descriptionStatus, 'missing');
  assert.equal(fs.readdirSync(manager.metadataDir).some((name) => name.endsWith('.tmp') || name === '.write-lock'), false);
});

test('unreadable description sidecars and active directory locks are preserved without bypass writes', (t) => {
  const { manager } = fixture(t);
  const added = manager.collectImage(PNG, '原图', { description: DESCRIPTION });
  const target = metadataPath(manager, added.filename), bad = '{broken'; fs.writeFileSync(target, bad);
  assert.equal(manager.collectImage(PNG, '另一个名字', { description: DESCRIPTION }).ok, false);
  assert.equal(manager.updateMetadata(added.filename, { revision: added.metadata.revision, patch: { description: DESCRIPTION } }).code, 'METADATA_UNREADABLE');
  assert.equal(fs.readFileSync(target, 'utf8'), bad);
  fs.mkdirSync(path.join(manager.metadataDir, '.write-lock'));
  const blocked = manager.collectImage(PNG, '原图', { description: DESCRIPTION });
  assert.equal(blocked.code, 'BUSY'); assert.equal(fs.readFileSync(target, 'utf8'), bad);
  assert.equal(fs.readdirSync(manager.libDir).length, 1);
});

test('native and standalone collection schemas require descriptions and outputs give humans and AI the same meaning', async (t) => {
  const { manager, imports, source } = fixture(t);
  const definitions = native(manager, imports), collect = definitions.get('dafeiyu_meme_collect');
  assert.ok(collect.parameters.required.includes('description'));
  await assert.rejects(collect.execute({ path: source, title: '不能代替描写' }, {}), /description/);
  const registry = new CompanionToolRegistry({ ownerQq: '100', memeManager: manager, memeImportRoots: [imports] });
  const standalone = registry.definitions(OWNER).find((entry) => entry.function.name === 'meme_collect');
  assert.ok(standalone.function.parameters.required.includes('description'));
  await assert.rejects(registry.execute('meme_collect', { path: source, tags: ['不会写入'] }, OWNER), /description/);
  assert.deepEqual(fs.readdirSync(manager.libDir), []);
  const added = await collect.execute({ path: source, description: DESCRIPTION, aiDescription: AI_DESCRIPTION }, {});
  assert.equal(added.metadata.description, DESCRIPTION);
  const listed = (await registry.execute('meme_list', {}, OWNER)).output.memes[0];
  assert.equal(listed.description, DESCRIPTION); assert.equal(listed.aiDescription, AI_DESCRIPTION);
  const preview = await registry.execute('meme_preview', { filename: added.filename }, OWNER);
  assert.equal(preview.output.description, DESCRIPTION); assert.equal(preview.output.descriptionStatus, 'ready');
  assert.ok(definitions.get('dafeiyu_meme_sync').parameters.required.includes('descriptions'));
});

test('phone sync rejects every missing or malformed mapping before pulling or creating temporary files', async (t) => {
  const { manager } = fixture(t); let pulls = 0;
  manager.phoneTools = { pull: async () => { pulls++; return { ok: true }; } };
  const item = { filename: 'album/image.png', description: DESCRIPTION };
  const invalid = [undefined, {}, null, [], { unexpected: true },
    { descriptions: [] }, { descriptions: null }, { descriptions: {} },
    { descriptions: [{ filename: item.filename }] },
    ...['', ' \n\t ', null, 12, '字'.repeat(1201), '含\0空字符'].map((description) => ({ descriptions: [{ ...item, description }] })),
    ...[null, 12, '字'.repeat(1201), '含\0空字符'].map((aiDescription) => ({ descriptions: [{ ...item, aiDescription }] })),
    ...['../image.png', '/tmp/image.png', 'album/../image.png', 'album//image.png', 'album\\image.png', 'bad\0name.png'].map((filename) => ({ descriptions: [{ ...item, filename }] })),
    { descriptions: [{ ...item, unsupported: '拒绝未知字段' }] },
    { descriptions: [item, { filename: 'other.png', description: ' ' }] },
  ];
  for (const args of invalid) {
    const result = await manager.syncFromPhone(args);
    assert.equal(result.ok, false, JSON.stringify(args)); assert.equal(result.imported, 0);
    assert.equal(pulls, 0); assert.deepEqual(fs.readdirSync(manager.libDir), []);
    assert.equal(fs.readdirSync(manager.desktopMemeDir).some((name) => name.startsWith('tmp_pull-')), false);
  }
});

test('native and standalone sync schemas require at least one valid mapping before any phone pull', async (t) => {
  const { manager, imports } = fixture(t); let pulls = 0;
  const phoneTools = { enabled: true, pull: async () => { pulls++; return { ok: true }; } }; manager.phoneTools = phoneTools;
  const definitions = native(manager, imports), sync = definitions.get('dafeiyu_meme_sync');
  const registry = new CompanionToolRegistry({ ownerQq: '100', memeManager: manager, phoneTools, phoneEnabled: true, allowMemeSync: true });
  const standalone = registry.definitions(OWNER).find((entry) => entry.function.name === 'meme_sync');
  assert.equal(sync.parameters.properties.descriptions.minItems, 1);
  assert.equal(standalone.function.parameters.properties.descriptions.minItems, 1);
  await assert.rejects(sync.execute({ descriptions: [] }, {}), /元素数量不足/);
  await assert.rejects(registry.execute('meme_sync', { descriptions: [] }, OWNER), /元素数量不足/);
  for (const description of [' ', 42, '字'.repeat(1201)]) {
    const args = { descriptions: [{ filename: 'image.png', description }] };
    if (typeof description === 'string' && description.length <= 1200) {
      assert.equal((await sync.execute(args, {})).ok, false);
      assert.equal((await registry.execute('meme_sync', args, OWNER)).output.ok, false);
    } else {
      await assert.rejects(sync.execute(args, {})); await assert.rejects(registry.execute('meme_sync', args, OWNER));
    }
  }
  assert.equal(pulls, 0);
});

test('phone sync uses the normalized mapping snapshot across the asynchronous pull', async (t) => {
  const { manager } = fixture(t), item = { filename: 'image.png', description: ` ${DESCRIPTION} `, aiDescription: ` ${AI_DESCRIPTION} ` };
  manager.phoneTools = { pull: async (_remote, local) => {
    item.description = ' '; item.aiDescription = null;
    fs.writeFileSync(path.join(local, 'image.png'), PNG); return { ok: true };
  } };
  const result = await manager.syncFromPhone({ descriptions: [item] });
  assert.equal(result.ok, true); assert.equal(result.imported, 1);
  const saved = manager.listMemes()[0]; assert.equal(saved.description, DESCRIPTION); assert.equal(saved.aiDescription, AI_DESCRIPTION);
});

test('phone sync requires an explicit exact relative-path description for every imported item', async (t) => {
  const { manager } = fixture(t); let calls = 0;
  manager.phoneTools = { pull: async (_remote, local) => {
    calls++; fs.mkdirSync(path.join(local, 'album'));
    fs.writeFileSync(path.join(local, 'album', '描述完整.png'), PNG);
    fs.writeFileSync(path.join(local, 'album', '未填写.png'), PNG);
    fs.writeFileSync(path.join(local, '描述完整.png'), PNG);
    return { ok: true };
  } };
  const result = await manager.syncFromPhone({ descriptions: [{ filename: 'album/描述完整.png', description: DESCRIPTION }] });
  assert.equal(result.ok, false); assert.equal(result.partial, true); assert.equal(result.imported, 1);
  assert.deepEqual(result.errors.map((row) => row.filename).sort(), ['album/未填写.png', '描述完整.png']);
  assert.ok(result.errors.every((row) => row.code === 'DESCRIPTION_REQUIRED'));
  assert.equal(manager.listMemes()[0].description, DESCRIPTION);
  assert.equal(fs.readdirSync(manager.desktopMemeDir).some((name) => name.startsWith('tmp_pull-')), false);
  const ambiguous = await manager.syncFromPhone({ descriptions: [{ filename: 'a.png', description: DESCRIPTION }, { filename: 'a.png', description: DESCRIPTION }] });
  assert.equal(ambiguous.ok, false); assert.equal(calls, 1);
});

test('standalone phone screenshot collection cannot bypass the required meaning', async () => {
  let invoked;
  const registry = new CompanionToolRegistry({ ownerQq: '100', phoneEnabled: true, allowedPhoneTools: ['phone_steal_meme'],
    phoneTools: { enabled: true, stealMeme: async (name, options) => { invoked = { name, options }; return { ok: true }; } } });
  await assert.rejects(registry.execute('phone_steal_meme', {}, OWNER), /description/);
  assert.equal(invoked, undefined);
  await registry.execute('phone_steal_meme', { description: DESCRIPTION, aiDescription: AI_DESCRIPTION }, OWNER);
  assert.equal(invoked.name, undefined); assert.equal(invoked.options.description, DESCRIPTION); assert.equal(invoked.options.aiDescription, AI_DESCRIPTION);
});
