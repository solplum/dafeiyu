import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
test('Bili Python worker offline contracts: nested replies, exact recipients, once-only claims, reload, identity and media', async () => {
  const result = await run('python3', ['-I', '-B', fileURLToPath(new URL('../scripts/test-social-bili-worker.py', import.meta.url))], { timeout: 10000, maxBuffer: 65536 });
  assert.match(result.stderr, /Ran 12 tests/); assert.match(result.stderr, /\nOK\n/); assert.equal(result.stdout, '');
});
