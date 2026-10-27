import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh script's fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(file, args = []) {
  return execFileSync(process.execPath, [path.join(root, 'scripts', file), ...args], { encoding: 'utf8', timeout: 10000 });
}

test('doctor defaults to read-only and preserves real skill directories', t => {
  const home = fixture(t);
  const existing = path.join(home, '.agents/skills/dafeiyu');
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, 'keep.txt'), 'original');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/doctor.mjs'), '--agent-home', home], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(home, '.minimax')), false);
  assert.match(result.stdout, /未验证/);
});

test('doctor can explicitly fix missing links without replacing a real directory', t => {
  const home = fixture(t);
  run('doctor.mjs', ['--fix-links', '--agent-home', home]);
  const link = path.join(home, '.agents/skills/dafeiyu');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), path.join(root, 'skills/dafeiyu'));
});

test('installer dry run preserves profile, handles quoted paths, never calls apply', t => {
  const profile = fixture(t);
  const original = '{"name":"fixture"}\n';
  fs.writeFileSync(path.join(profile, 'package.json'), original);
  const output = run('install-dsh.mjs', ['--dry-run', '--profile', profile]);
  assert.match(output, /DRY_RUN/);
  assert.equal(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(profile, 'node_modules')), false);
});

test('installer migrates only legacy insertion, backs up and remains idempotent', t => {
  const profile = fixture(t);
  const pkgPath = path.join(profile, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify({ name: 'fixture', dependencies: { existing: '1' }, dsh: { profile: { bundles: ['base'] } } }));
  const patchPath = path.join(profile, 'cordis.patch.yml');
  fs.writeFileSync(patchPath, '- insert:\n    - id: unrelated\n      name: other\n\n- insert:\n    - id: dsh-dafeiyu\n      name: dsh-dafeiyu\n      config:\n        projectRoot: old\n');
  run('install-dsh.mjs', ['--profile', profile]);
  const pkg = JSON.parse(fs.readFileSync(pkgPath));
  assert.deepEqual(pkg.dsh.profile.bundles, ['base', 'dsh-dafeiyu']);
  assert.equal(pkg.dependencies.existing, '1');
  assert.match(fs.readFileSync(patchPath, 'utf8'), /id: unrelated/);
  assert.doesNotMatch(fs.readFileSync(patchPath, 'utf8'), /id: dsh-dafeiyu/);
  assert.ok(fs.readdirSync(profile).some(n => n.startsWith('package.json.bak-')));
  assert.ok(fs.readdirSync(profile).some(n => n.startsWith('cordis.patch.yml.bak-')));
  run('install-dsh.mjs', ['--profile', profile]);
  assert.equal(JSON.parse(fs.readFileSync(pkgPath)).dsh.profile.bundles.filter(n => n === 'dsh-dafeiyu').length, 1);
});

test('installer refuses real node_modules package directory before mutation', t => {
  const profile = fixture(t);
  const pkgPath = path.join(profile, 'package.json');
  fs.writeFileSync(pkgPath, '{"name":"fixture"}');
  const keep = path.join(profile, 'node_modules/dsh-dafeiyu');
  fs.mkdirSync(keep, { recursive: true });
  fs.writeFileSync(path.join(keep, 'keep.txt'), 'preserve');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/install-dsh.mjs'), '--profile', profile], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(pkgPath, 'utf8'), '{"name":"fixture"}');
  assert.equal(fs.readFileSync(path.join(keep, 'keep.txt'), 'utf8'), 'preserve');
});

test('installer leaves a valid empty YAML list after removing its only legacy insert', t => {
  const profile = fixture(t);
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"fixture"}');
  const patch = path.join(profile, 'cordis.patch.yml');
  fs.writeFileSync(patch, '- insert:\n    - id: dsh-dafeiyu\n      name: dsh-dafeiyu\n');
  run('install-dsh.mjs', ['--profile', profile]);
  assert.equal(fs.readFileSync(patch, 'utf8'), '[]\n');
});

test('doctor reports core shims without fixing links and installer refuses before any mutation', t => {
  const profile = fixture(t), home = fixture(t);
  const core = path.join(profile, 'node_modules/@deepseek-ai/dsh-tools');
  fs.mkdirSync(core, { recursive: true });
  const shim = '/** @deepseek-ai/dsh-tools shim */\nexport function defineTool(spec) { return spec; }\nexport default { defineTool };\n';
  fs.writeFileSync(path.join(core, 'index.js'), shim);
  fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.1', type: 'module', exports: { '.': './index.js' } }));
  const packageFile = path.join(profile, 'package.json'), original = '{"name":"fixture"}\n';
  fs.writeFileSync(packageFile, original);
  const doctor = spawnSync(process.execPath, [path.join(root, 'scripts/doctor.mjs'), '--profile', profile, '--agent-home', home, '--fix-links'], { encoding: 'utf8' });
  assert.equal(doctor.status, 1); assert.match(doctor.stdout, /dsh-tools.*shim/);
  assert.equal(fs.existsSync(path.join(home, '.agents')), false);
  const install = spawnSync(process.execPath, [path.join(root, 'scripts/install-dsh.mjs'), '--profile', profile], { encoding: 'utf8' });
  assert.equal(install.status, 1); assert.match(install.stderr, /宿主核心包存在异常覆盖/);
  assert.equal(fs.readFileSync(packageFile, 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(core, 'index.js'), 'utf8'), shim);
  assert.equal(fs.existsSync(path.join(profile, 'node_modules/dsh-dafeiyu')), false);
});
