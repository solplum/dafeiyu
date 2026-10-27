import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PrivateConfigStore, ConfigStoreError } from '../packages/dsh-dafeiyu/src/config-store.js';

const SECRET = 'PRIVATE_TOKEN_DO_NOT_RETURN';
function fixture(t, config = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-panel-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'private', 'config.json');
  if (config !== null) { fs.mkdirSync(path.dirname(configFile)); fs.writeFileSync(configFile, JSON.stringify(config)); }
  return { root, configFile, store: new PrivateConfigStore({ configFile, ...options }) };
}
function expectCode(code, fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ConfigStoreError);
    assert.equal(error.code, code);
    assert.equal(JSON.stringify({ ...error, message: error.message }).includes(SECRET), false);
    return true;
  });
}

test('opening and reading an absent private config has no filesystem or runtime side effects', (t) => {
  const { root, store } = fixture(t, null);
  const snapshot = store.snapshot();
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(snapshot.effective.autoStartOneBot, false);
  assert.equal(snapshot.effective.onebotEngine, 'native');
  assert.deepEqual(snapshot.saved, {});
  assert.equal(snapshot.secretConfigured.effective.onebotAccessToken, false);
  assert.deepEqual(snapshot.validationErrors, []);
});

test('snapshots separate saved and effective values while hiding secrets and unknown fields', (t) => {
  const { store } = fixture(t, { autoStartOneBot: false, onebotAccessToken: SECRET,
    ownerQq: '123', onebotSelfId: '456', onebotWs: 'ws://127.0.0.1:3001', unknownSecret: SECRET },
  { overrides: { autoStartOneBot: true, onebotAccessToken: 'HOST_PRIVATE_TOKEN', unrelated: SECRET } });
  const view = store.snapshot();
  assert.equal(view.saved.autoStartOneBot, false);
  assert.equal(view.effective.autoStartOneBot, true);
  assert.deepEqual(view.overriddenFields.sort(), ['autoStartOneBot', 'onebotAccessToken']);
  assert.deepEqual(view.secretConfigured, { saved: { onebotAccessToken: true, ttsApiKey: false }, effective: { onebotAccessToken: true, ttsApiKey: false } });
  assert.equal(JSON.stringify(view).includes(SECRET), false);
  assert.equal(JSON.stringify(view).includes('HOST_PRIVATE_TOKEN'), false);
  assert.equal(Object.hasOwn(view.saved, 'onebotAccessToken'), false);
  assert.equal(Object.hasOwn(view.effective, 'unknownSecret'), false);
  assert.equal(JSON.stringify(store), '{}');
  assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(store)), ['constructor', 'snapshot', 'save']);
  view.effective.allowedPhoneKeys.push('home');
  assert.deepEqual(store.snapshot().effective.allowedPhoneKeys, ['back']);
});

test('secret blank means preserve, replacement is private, and only explicit clear removes it', (t) => {
  const { store, configFile } = fixture(t, { onebotAccessToken: SECRET, unknownSetting: { keep: true } });
  let view = store.save({ onebotAccessToken: '', voiceTranscription: true }, { revision: store.snapshot().revision });
  assert.equal(view.requiresReload, true);
  let raw = JSON.parse(fs.readFileSync(configFile));
  assert.equal(raw.onebotAccessToken, SECRET);
  assert.deepEqual(raw.unknownSetting, { keep: true });
  view = store.save({ onebotAccessToken: 'REPLACED_PRIVATE_TOKEN' }, { revision: view.revision });
  assert.equal(JSON.stringify(view).includes('REPLACED_PRIVATE_TOKEN'), false);
  assert.equal(view.secretConfigured.saved.onebotAccessToken, true);
  view = store.save({}, { revision: view.revision, clearSecrets: ['onebotAccessToken'] });
  raw = JSON.parse(fs.readFileSync(configFile));
  assert.equal(Object.hasOwn(raw, 'onebotAccessToken'), false);
  assert.equal(view.secretConfigured.saved.onebotAccessToken, false);
  assert.deepEqual(raw.unknownSetting, { keep: true });
});

test('a partial local opt-in uses existing identity fields and explicit profile overrides stay authoritative', (t) => {
  const { store, configFile } = fixture(t, { ownerQq: '123', onebotSelfId: '456', onebotWs: 'ws://[::1]:3001' },
    { overrides: { autoStartOneBot: false } });
  const view = store.save({ autoStartOneBot: true }, { revision: store.snapshot().revision });
  assert.equal(view.saved.autoStartOneBot, true);
  assert.equal(view.effective.autoStartOneBot, false);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).autoStartOneBot, true);
});

test('unknown edits, secret ambiguity, prototype keys and type coercion are rejected before writes', (t) => {
  const { store, configFile } = fixture(t, { onebotAccessToken: SECRET });
  const revision = store.snapshot().revision, original = fs.readFileSync(configFile, 'utf8');
  for (const patch of [{ projectRoot: '/tmp' }, { stt: { command: 'sh' } }, { phoneEnabled: 'true' },
    { ownerQq: 123 }, { maxListenSeconds: '3' }, JSON.parse('{"__proto__":{"bad":true}}')]) {
    expectCode('INVALID_PATCH', () => store.save(patch, { revision }));
  }
  expectCode('INVALID_PATCH', () => store.save({ onebotAccessToken: SECRET }, { revision, clearSecrets: ['onebotAccessToken'] }));
  expectCode('INVALID_PATCH', () => store.save({}, { revision, clearSecrets: ['apiKey'] }));
  const accessor = Object.defineProperty({}, 'phoneEnabled', { enumerable: true, get() { throw new Error(SECRET); } });
  expectCode('INVALID_PATCH', () => store.save(accessor, { revision }));
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(configFile)), ['config.json']);
});

test('QQ identity, native history policy and explicit device requirements are validated together', (t) => {
  const { store } = fixture(t);
  const revision = store.snapshot().revision;
  for (const patch of [{ ownerQq: '123', onebotSelfId: '123' }, { autoStartOneBot: true },
    { catchUpUnread: true }, { phoneEnabled: true }, { autoConnectPhone: true }]) {
    expectCode('INVALID_CONFIG', () => store.save(patch, { revision }));
  }
  for (const ownerQq of ['0', ' 123', '123 ', '-123', '123.0', '1e8', SECRET]) {
    expectCode('INVALID_PATCH', () => store.save({ ownerQq }, { revision }));
  }
  const view = store.save({ onebotEngine: 'legacy', catchUpUnread: true, ownerQq: '123' }, { revision });
  assert.equal(view.effective.catchUpUnread, true);
});

test('only loopback OneBot endpoints without userinfo, fragments or token queries may be saved', (t) => {
  const { store } = fixture(t);
  let revision = store.snapshot().revision;
  for (const patch of [
    { onebotWs: 'ws://example.org/ws' }, { onebotWs: 'ws://192.168.1.1:3001' },
    { onebotWs: `ws://u:${SECRET}@127.0.0.1:3001` }, { onebotWs: `ws://127.0.0.1:3001?access_token=${SECRET}` },
    { onebotWs: `ws://127.0.0.1:3001#${SECRET}` }, { onebotHttp: 'file:///tmp/private' },
    { onebotHttp: 'https://127.0.0.1@remote.example' }, { onebotWs: 'ws://localhost.evil:3001' },
    { onebotHttp: 'http://127.0.0.1:3000?hello=1' },
  ]) expectCode('INVALID_PATCH', () => store.save(patch, { revision }));
  for (const patch of [{ onebotWs: 'ws://127.0.0.1:3001/ws', onebotHttp: 'http://localhost:3000' },
    { onebotWs: 'wss://[::1]:3001', onebotHttp: 'https://[::1]:3000' }]) {
    const view = store.save(patch, { revision }); revision = view.revision;
    assert.deepEqual(view.validationErrors, []);
  }
});

test('phone permissions remain subsets of existing authorization and listen time is an integer up to three seconds', (t) => {
  const { store } = fixture(t);
  const revision = store.snapshot().revision;
  for (const patch of [{ allowedPhoneTools: ['phone_tap'] }, { allowedPhoneTools: ['phone_listen', 'phone_listen'] },
    { allowedPhoneKeys: ['home'] }, { allowedPhoneKeys: ['BACK'] }, { maxListenSeconds: 0 },
    { maxListenSeconds: 4 }, { maxListenSeconds: 2.5 }, { phoneDevice: 'device;echo bad' }]) {
    expectCode('INVALID_PATCH', () => store.save(patch, { revision }));
  }
  const view = store.save({ allowedPhoneTools: ['phone_listen'], allowedPhoneKeys: [], maxListenSeconds: 2,
    phoneDevice: '192.168.1.2:5555', phoneEnabled: true }, { revision });
  assert.deepEqual(view.effective.allowedPhoneTools, ['phone_listen']);
  assert.equal(view.effective.maxListenSeconds, 2);
});

test('invalid existing URL credentials are never exposed by snapshot and can be repaired without losing unrelated settings', (t) => {
  const { store, configFile } = fixture(t, { onebotWs: `ws://user:${SECRET}@127.0.0.1:3001?token=${SECRET}`,
    ownerQq: { secret: SECRET }, onebotAccessToken: SECRET, untouched: { nested: SECRET } });
  const view = store.snapshot();
  assert.equal(JSON.stringify(view).includes(SECRET), false);
  assert.equal(view.saved.onebotWs, '');
  assert.equal(view.saved.ownerQq, '');
  assert.ok(view.validationErrors.some((error) => error.field === 'onebotWs'));
  store.save({ onebotWs: 'ws://127.0.0.1:3001', ownerQq: '123' }, { revision: view.revision });
  assert.equal(JSON.parse(fs.readFileSync(configFile)).untouched.nested, SECRET);
});

test('revisions detect another store and external edits, including whitespace-only changes', (t) => {
  const { store, configFile } = fixture(t, { onebotAccessToken: SECRET });
  const stale = store.snapshot().revision;
  const other = new PrivateConfigStore({ configFile });
  other.save({ voiceTranscription: true }, { revision: stale });
  expectCode('CONFLICT', () => store.save({ allowMemoryWrites: true }, { revision: stale }));
  const current = store.snapshot().revision;
  fs.appendFileSync(configFile, '\n');
  expectCode('CONFLICT', () => store.save({ allowMemoryWrites: true }, { revision: current }));
  assert.equal(JSON.parse(fs.readFileSync(configFile)).allowMemoryWrites, undefined);
});

test('an existing save lock is never stolen and stale revision is mandatory', (t) => {
  const { store, configFile } = fixture(t);
  expectCode('CONFLICT', () => store.save({ voiceTranscription: true }));
  fs.writeFileSync(configFile + '.lock', 'other writer');
  expectCode('BUSY', () => store.save({ voiceTranscription: true }, { revision: store.snapshot().revision }));
  assert.equal(fs.readFileSync(configFile + '.lock', 'utf8'), 'other writer');
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), {});
});

test('two separate processes saving the same revision cannot overwrite each other', { timeout: 10000 }, async (t) => {
  const { store, configFile } = fixture(t, { onebotAccessToken: SECRET });
  const revision = store.snapshot().revision;
  const moduleUrl = new URL('../packages/dsh-dafeiyu/src/config-store.js', import.meta.url).href;
  const script = `import { PrivateConfigStore } from ${JSON.stringify(moduleUrl)};
    const [configFile,revision,key]=process.argv.slice(1);
    const store=new PrivateConfigStore({configFile});
    process.stdout.write('ready\\n');
    process.stdin.once('data',()=>{
      try { store.save({[key]:true},{revision}); process.stdout.write('saved\\n'); }
      catch(error) { process.stdout.write(error.code+'\\n'); }
      process.stdin.destroy();
    });`;
  const workers = ['voiceTranscription', 'allowMemoryWrites'].map((key) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, configFile, revision, key],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let output = '', stderr = '';
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    child.stdout.on('data', (data) => { output += data; if (output.includes('ready\n')) readyResolve(); });
    child.stderr.on('data', (data) => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(output.trim().split('\n').at(-1)) : reject(new Error(`worker failed: ${stderr}`)));
    });
    return { child, ready, done };
  });
  await Promise.all(workers.map((worker) => worker.ready));
  workers.forEach((worker) => worker.child.stdin.write('go\n'));
  const outcomes = await Promise.all(workers.map((worker) => worker.done));
  assert.equal(outcomes.filter((value) => value === 'saved').length, 1);
  assert.ok(outcomes.every((value) => ['saved', 'BUSY', 'CONFLICT'].includes(value)));
  const raw = JSON.parse(fs.readFileSync(configFile));
  assert.equal([raw.voiceTranscription, raw.allowMemoryWrites].filter((value) => value === true).length, 1);
  assert.equal(raw.onebotAccessToken, SECRET);
});

test('successful atomic save retains a byte-exact private backup and uses mode 0600', (t) => {
  const { store, configFile } = fixture(t, { onebotAccessToken: SECRET, custom: 9 });
  const original = fs.readFileSync(configFile);
  const view = store.save({ voiceTranscription: true }, { revision: store.snapshot().revision });
  assert.equal(view.backupCreated, true);
  const files = fs.readdirSync(path.dirname(configFile));
  const backups = files.filter((name) => name.startsWith('config.json.bak-'));
  assert.equal(backups.length, 1);
  const backup = path.join(path.dirname(configFile), backups[0]);
  assert.deepEqual(fs.readFileSync(backup), original);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(files.some((name) => name.endsWith('.tmp') || name.endsWith('.lock')), false);
  const beforeFiles = files.slice();
  const unchanged = store.save({ onebotAccessToken: '' }, { revision: view.revision });
  assert.equal(unchanged.requiresReload, false);
  assert.deepEqual(fs.readdirSync(path.dirname(configFile)), beforeFiles);
});

test('rename failure leaves the original intact, removes temporary files and never exposes underlying errors', (t) => {
  const { configFile } = fixture(t, { onebotAccessToken: SECRET });
  const original = fs.readFileSync(configFile);
  const store = new PrivateConfigStore({ configFile, fsImpl: { ...fs, renameSync() { throw new Error(SECRET); } } });
  expectCode('IO_ERROR', () => store.save({ voiceTranscription: true }, { revision: store.snapshot().revision }));
  assert.deepEqual(fs.readFileSync(configFile), original);
  assert.equal(fs.readdirSync(path.dirname(configFile)).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('an outside edit during staging is detected before atomic replacement', (t) => {
  const { configFile } = fixture(t, { custom: 'before', onebotAccessToken: SECRET });
  let edited = false;
  const store = new PrivateConfigStore({ configFile, fsImpl: { ...fs, writeFileSync(file, bytes) {
    fs.writeFileSync(file, bytes);
    if (!edited) { edited = true; fs.writeFileSync(configFile, JSON.stringify({ custom: 'external', onebotAccessToken: SECRET })); }
  } } });
  expectCode('CONFLICT', () => store.save({ voiceTranscription: true }, { revision: store.snapshot().revision }));
  assert.equal(JSON.parse(fs.readFileSync(configFile)).custom, 'external');
});

test('directory fsync failure after replacement is reported as uncertain with reload required', (t) => {
  const { configFile } = fixture(t, {});
  let writes = 0;
  const store = new PrivateConfigStore({ configFile, fsImpl: { ...fs, fsyncSync(fd) {
    if (++writes === 3) throw new Error(SECRET);
    fs.fsyncSync(fd);
  } } });
  assert.throws(() => store.save({ voiceTranscription: true }, { revision: store.snapshot().revision }), (error) => {
    assert.equal(error.code, 'SAVE_UNCERTAIN'); assert.equal(error.saved, true); assert.equal(error.requiresReload, true);
    assert.equal(error.message.includes(SECRET), false); return true;
  });
  assert.equal(JSON.parse(fs.readFileSync(configFile)).voiceTranscription, true);
});

test('malformed files, read failures and symlink destinations fail closed without echoing private data', (t) => {
  const { configFile } = fixture(t, {});
  fs.writeFileSync(configFile, `{ "token": "${SECRET}"`);
  const store = new PrivateConfigStore({ configFile });
  expectCode('INVALID_CONFIG', () => store.snapshot());
  const failing = new PrivateConfigStore({ configFile, fsImpl: { ...fs, readFileSync() { throw new Error(SECRET); } } });
  expectCode('IO_ERROR', () => failing.snapshot());
  const target = configFile + '.target'; fs.renameSync(configFile, target); fs.symlinkSync(target, configFile);
  expectCode('INVALID_CONFIG', () => store.snapshot());
  assert.equal(fs.readFileSync(target, 'utf8').includes(SECRET), true);
});
