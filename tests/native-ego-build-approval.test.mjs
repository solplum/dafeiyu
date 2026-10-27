import test from 'node:test';
import assert from 'node:assert/strict';
import { isApprovedNativeEgoBuild } from '../packages/dsh-dafeiyu/src/social/native-ego-account-runtime.mjs';

const base = '/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/';
const builds = [
  [base + '0.6.1.11/Helpers/ego-browser', '975f8fb7b8e64f8a619af631491d86096730697b7e2ada5defa92ddf91b32353'],
  [base + '0.6.1.13/Helpers/ego-browser', 'fc1da0bbf2f8b78b4f171d59ee5a869f4bb8839cf46e5b02a711e82dc1706535'],
];

test('only individually verified native Ego build path/hash pairs are approved', () => {
  for (const [realpath, sha256] of builds) assert.equal(isApprovedNativeEgoBuild(realpath, sha256), true);
});

test('a known hash at another path or unknown version is rejected', () => {
  for (const [, sha256] of builds) {
    assert.equal(isApprovedNativeEgoBuild(base + '0.6.1.14/Helpers/ego-browser', sha256), false);
    assert.equal(isApprovedNativeEgoBuild('/tmp/ego-browser', sha256), false);
    assert.equal(isApprovedNativeEgoBuild('/Users/example/.local/bin/ego-browser', sha256), false);
  }
});

test('approved build hashes cannot be mixed across versions or modified', () => {
  assert.equal(isApprovedNativeEgoBuild(builds[0][0], builds[1][1]), false);
  assert.equal(isApprovedNativeEgoBuild(builds[1][0], builds[0][1]), false);
  for (const [realpath, sha256] of builds) {
    assert.equal(isApprovedNativeEgoBuild(realpath, '0'.repeat(64)), false);
    assert.equal(isApprovedNativeEgoBuild(realpath, sha256.toUpperCase()), false);
    assert.equal(isApprovedNativeEgoBuild(realpath, sha256.slice(0, -1)), false);
  }
});

test('invalid build metadata cannot obtain approval through coercion', () => {
  const [realpath, sha256] = builds[1];
  for (const value of [null, undefined, 13, {}, [realpath], { toString: () => realpath }]) {
    assert.equal(isApprovedNativeEgoBuild(value, sha256), false);
  }
  for (const value of [null, undefined, 13, {}, [sha256], { toString: () => sha256 }]) {
    assert.equal(isApprovedNativeEgoBuild(realpath, value), false);
  }
});
