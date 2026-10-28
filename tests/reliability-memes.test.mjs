import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemeManager } from '../packages/dsh-dafeiyu/src/meme-manager.js';
import { MemeTools } from '../packages/dsh-dafeiyu/src/meme-tools.js';
import { CompanionToolRegistry } from '../packages/dsh-dafeiyu/src/companion-tool-registry.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aGQAAAAASUVORK5CYII=', 'base64');
const OTHER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6B7EAAAAASUVORK5CYII=', 'base64');
const DESCRIPTION = '测试像素图，表达想吃饭或请求投喂，适合轻松玩笑语境。';
const OWNER = { userId: 'fixture-owner', key: 'private:fixture-owner', isGroup: false };
const metadataPath = (manager, filename) => path.join(manager.metadataDir,
  createHash('sha256').update(filename).digest('hex') + '.json');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-memes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new MemeManager({ desktopMemeDir: path.join(root, 'library') });
  const source = path.join(root, 'source.png');
  fs.writeFileSync(source, PNG);
  return { root, manager, source };
}

function nativeTools(manager, extra = {}) {
  const definitions = new Map();
  const tools = new MemeTools({ memeManager: manager,
    getExecutionContext: () => ({ isOwner: true, scope: 'c2c' }) });
  tools.registerToCordis({ tools: { register(def) { definitions.set(def.name, def); } }, ...extra });
  return definitions;
}

test('broken entries do not hide healthy images, and search/collection retain warnings without replacing sidecars', (t) => {
  const { manager, source } = fixture(t);
  const badFile = path.join(manager.libDir, 'bad-tags.png');
  fs.writeFileSync(badFile, OTHER_PNG);
  const badMetadata = metadataPath(manager, 'bad-tags.png');
  fs.writeFileSync(badMetadata, '{broken');
  fs.symlinkSync(path.join(manager.libDir, 'missing.png'), path.join(manager.libDir, 'broken.png'));
  fs.writeFileSync(path.join(manager.libDir, '吃饭.png'), PNG);
  const result = manager.searchMemes('吃饭');
  assert.equal(result.total, 1);
  assert.equal(result.memes[0].filename, '吃饭.png');
  assert.equal(result.partial, true);
  assert.equal(result.warningCount, 2);
  assert.deepEqual(result.warnings.map((row) => [row.filename, row.stage]), [
    ['bad-tags.png', 'metadata'], ['broken.png', 'image'],
  ]);
  const collected = manager.collectMeme(source, '新收藏', { tags: ['food'], description: DESCRIPTION });
  assert.equal(collected.ok, true);
  assert.equal(collected.partial, true);
  assert.equal(collected.warningCount, 2);
  assert.equal(fs.readFileSync(badMetadata, 'utf8'), '{broken');
});

test('collecting an image with a damaged existing sidecar never overwrites or duplicates that entry', (t) => {
  const { manager, source } = fixture(t);
  const first = manager.collectMeme(source, '旧名字', { description: DESCRIPTION });
  const sidecar = metadataPath(manager, first.filename);
  fs.writeFileSync(sidecar, '{damaged');
  const before = fs.readdirSync(manager.libDir);
  const result = manager.collectMeme(source, '另一个名字', { tags: ['new'], description: DESCRIPTION });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.match(result.error, /未覆盖/);
  assert.deepEqual(fs.readdirSync(manager.libDir), before);
  assert.equal(fs.readFileSync(sidecar, 'utf8'), '{damaged');
  assert.deepEqual(fs.readFileSync(first.path), PNG);
});

test('an orphaned damaged sidecar is preserved before any image is created', (t) => {
  const { manager, source } = fixture(t);
  const hash = createHash('sha256').update(PNG).digest('hex').slice(0, 24);
  const filename = `dafeiyu_${hash}_orphan.png`;
  const sidecar = metadataPath(manager, filename);
  fs.writeFileSync(sidecar, '{orphan');
  const result = manager.collectMeme(source, 'orphan', { description: DESCRIPTION });
  assert.equal(result.ok, false);
  assert.match(result.error, /标签读取失败/);
  assert.equal(fs.existsSync(path.join(manager.libDir, filename)), false);
  assert.equal(fs.readFileSync(sidecar, 'utf8'), '{orphan');
});

test('many bad entries and non-string tags remain visible without escaping the search output budget', (t) => {
  const { manager } = fixture(t);
  fs.writeFileSync(path.join(manager.libDir, 'bad-tags.png'), PNG);
  fs.writeFileSync(metadataPath(manager, 'bad-tags.png'), JSON.stringify({ title: 'bad', tags: [{}] }));
  for (let index = 0; index < 40; index++) {
    fs.symlinkSync(path.join(manager.libDir, 'missing.png'),
      path.join(manager.libDir, `${String(index).padStart(2, '0')}${'\u0001'.repeat(170)}.png`));
  }
  const result = manager.searchMemes();
  assert.equal(result.total, 0);
  assert.equal(result.partial, true);
  assert.equal(result.warningCount, 41);
  assert.equal(result.warningsTruncated, true);
  assert.ok(result.warnings.length <= 20);
  assert.ok(JSON.stringify(result).length < 24000);
  const scan = manager.scanMemes();
  assert.equal(scan.memes.length, 0);
  assert.equal(scan.warningCount, 41);
});

test('unreadable library root remains an error, while malformed and unsupported images report partial results', (t) => {
  const { manager, source } = fixture(t);
  fs.writeFileSync(path.join(manager.libDir, 'invalid.png'), 'not an image');
  fs.writeFileSync(path.join(manager.libDir, 'unsupported.avif'), 'unsupported fixture');
  const result = manager.searchMemes();
  assert.equal(result.total, 0);
  assert.equal(result.partial, true);
  assert.equal(result.warningCount, 2);
  assert.match(result.warnings.map((row) => row.error).join('\n'), /不支持|受支持/);
  const readdir = fs.readdirSync;
  const libraryPath = fs.realpathSync(manager.libDir);
  fs.readdirSync = (directory, ...args) => {
    if (directory === libraryPath || directory === manager.libDir) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
    return readdir(directory, ...args);
  };
  try {
    assert.throws(() => manager.searchMemes(), { code: 'EACCES' });
    const collected = manager.collectMeme(source, '未写入', { description: DESCRIPTION });
    assert.equal(collected.ok, false);
    assert.match(collected.error, /permission denied/);
  } finally { fs.readdirSync = readdir; }
  assert.equal(fs.readdirSync(manager.libDir).length, 2);
});

test('native and independent search/list include scan warnings even when emotion search has no match', async (t) => {
  const { manager } = fixture(t);
  fs.writeFileSync(path.join(manager.libDir, 'invalid.png'), 'not an image');
  const defs = nativeTools(manager);
  const native = await defs.get('dafeiyu_meme_search').execute({ replyText: '饿了要吃饭' }, {});
  assert.equal(native.match, null);
  assert.equal(native.partial, true);
  assert.equal(native.warnings.length, 1);
  const registry = new CompanionToolRegistry({ ownerQq: OWNER.userId, memeManager: manager });
  for (const [name, args] of [['meme_search', { replyText: '饿了要吃饭' }], ['meme_list', {}]]) {
    const { output } = await registry.execute(name, args, OWNER);
    assert.equal(output.partial, true, name);
    assert.equal(output.warnings.length, 1, name);
  }
});

test('both previews pass the exact once-read bytes with detected MIME for an image named with the wrong extension', async (t) => {
  const { manager } = fixture(t);
  const imagePath = path.join(manager.libDir, 'old.jpg');
  fs.writeFileSync(imagePath, PNG);
  const canonicalImagePath = fs.realpathSync(imagePath);
  let captured;
  const reference = { id: 'fixture-image-reference', mediaType: 'image/png' };
  const defs = nativeTools(manager, { get: () => ({ saveImage: async (input) => {
    captured = input;
    assert.equal(input.mediaType, 'image/png');
    assert.deepEqual(input.data, PNG);
    return reference;
  } }) });
  const registry = new CompanionToolRegistry({ ownerQq: OWNER.userId, memeManager: manager });
  const readFile = fs.readFileSync;
  let imageReads = 0;
  fs.readFileSync = (file, ...args) => { if (file === canonicalImagePath) imageReads++; return readFile(file, ...args); };
  try {
    const preview = defs.get('dafeiyu_meme_preview');
    const native = await preview.execute({ filename: 'old.jpg' }, {});
    assert.equal(imageReads, 1);
    assert.equal(captured.name, 'old.jpg');
    assert.deepEqual(preview.output.render({}, native)[1], { type: 'image', attachment: reference });
    imageReads = 0;
    const independent = await registry.execute('meme_preview', { filename: 'old.jpg' }, OWNER);
    assert.equal(imageReads, 1);
    assert.equal(independent.output.imageAttached, true);
    assert.equal(independent.content[0].image_url.url, 'data:image/png;base64,' + PNG.toString('base64'));
  } finally { fs.readFileSync = readFile; }
});
