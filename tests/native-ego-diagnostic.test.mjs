import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeEgoDiagnostic } from '../packages/dsh-dafeiyu/src/social/native-ego-diagnostic.mjs';
import { SocialAccounts } from '../packages/dsh-dafeiyu/src/social/accounts.mjs';

const safe = { phase: 'browse-return-video-wait', name: 'TimeoutError', code: 'TIMEOUT' };
test('native diagnostic projection keeps only the fixed phase, error name and code', () => {
  assert.deepEqual(nativeEgoDiagnostic({ ...safe, message: 'PRIVATE_MESSAGE', url: 'PRIVATE_URL', accountId: 'PRIVATE_ACCOUNT', nested: { cookie: 'PRIVATE_COOKIE' } }), safe);
  for (const value of [null, [], {}, { ...safe, phase: 'PRIVATE_STAGE' }, { ...safe, name: 'PRIVATE_NAME' }, { ...safe, code: 'PRIVATE_CODE' }]) {
    assert.equal(nativeEgoDiagnostic(value), null);
  }
});

test('owner account snapshot sanitizes diagnostics without probing or modifying private account records', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-diagnostic-snapshot-'));
  let probes = 0, value = { ...safe, message: 'PRIVATE_MESSAGE', url: 'PRIVATE_URL' };
  const driver = { available: true, idle: true, capabilities: () => ({}), async dispose() {},
    runtime: { backend: 'native-ego', status: () => ({ configured: true, nativeReady: false, canStartNewActivity: false,
      lifecycle: 'unknown', metadata: { ready: false, state: 'unavailable' }, lastDiagnostic: value }) },
    checkBrowser: async () => { probes++; }, browseStatus: () => ({ state: 'unknown' }),
  };
  const manager = new SocialAccounts({ directory, drivers: { douyin: driver }, requestPolicy: null });
  t.after(async () => { await manager.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  manager.store.transact(state => { state.accounts.douyin = { state: 'bound', accountId: 'fixture', name: 'fixture', generation: 1 }; }, { authorize: () => true });
  const before = fs.readFileSync(manager.store.file);
  const row = manager.snapshot().platforms.find(row => row.platform === 'douyin');
  assert.deepEqual(row.browser.lastDiagnostic, safe); assert(!JSON.stringify(row.browser).includes('PRIVATE'));
  value = { ...safe, code: 'PRIVATE_CODE' };
  assert.equal(manager.snapshot().platforms.find(row => row.platform === 'douyin').browser.lastDiagnostic, null);
  assert.equal(probes, 0); assert.deepEqual(fs.readFileSync(manager.store.file), before);
});
