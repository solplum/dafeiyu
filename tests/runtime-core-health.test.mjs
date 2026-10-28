import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectCoreOverrides } from '../scripts/lib/runtime-core-health.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-core-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function core(profile, name, source, extra = {}) {
  const directory = path.join(profile, 'node_modules', '@deepseek-ai', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: `@deepseek-ai/${name}`, version: '0.2.1', type: 'module',
    main: './index.js', exports: { '.': './index.js' }, ...extra,
  }));
  fs.writeFileSync(path.join(directory, 'index.js'), source);
  return directory;
}

test('absent profile core packages use the bundled runtime without reading private profile config', (t) => {
  const profile = fixture(t);
  fs.writeFileSync(path.join(profile, 'package.json'), 'PRIVATE_PROFILE_CANARY_INVALID_JSON');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'PRIVATE_PATCH_CANARY');
  const result = inspectCoreOverrides(profile);
  assert.equal(result.ok, true); assert.equal(result.findings.length, 4);
  assert.ok(result.findings.every((finding) => finding.status === 'absent' && finding.version === null && finding.missing.length === 0));
  assert.equal(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), 'PRIVATE_PROFILE_CANARY_INVALID_JSON');
});

test('the four known two-file shims report exact missing runtime contracts', (t) => {
  const profile = fixture(t);
  core(profile, 'dsh-llm', 'export function createMessage(value) { return value; }\nexport default { createMessage };');
  core(profile, 'dsh-session', 'export function SessionId(value) { return String(value); }\nexport default { SessionId };');
  core(profile, 'dsh-tools', 'export function defineTool(value) { return value; }\nexport default { defineTool };');
  core(profile, 'dsh-settings', 'export function installSettingsSection() {}\nexport default { installSettingsSection };');
  const result = inspectCoreOverrides(profile), byName = Object.fromEntries(result.findings.map((finding) => [finding.name, finding]));
  assert.equal(result.ok, false); assert.ok(result.findings.every((finding) => finding.status === 'shim' && finding.version === '0.2.1'));
  assert.ok(byName['@deepseek-ai/dsh-llm'].missing.includes('ReasoningEffortId'));
  assert.ok(byName['@deepseek-ai/dsh-session'].missing.includes('SESSION_FORMAT_VERSION'));
  assert.ok(byName['@deepseek-ai/dsh-session'].missing.includes('package export ./surface'));
  assert.ok(byName['@deepseek-ai/dsh-tools'].missing.includes('ToolArgsError'));
  assert.ok(byName['@deepseek-ai/dsh-settings'].missing.some((item) => item.includes('service/apply')));
});

test('a complete two-file core override at the same version is only an unknown override', (t) => {
  const profile = fixture(t);
  // A module import would throw. The inspector must only read its source.
  const neverExecute = 'throw new Error("CORE_INSPECTOR_MUST_NOT_EXECUTE");\n';
  core(profile, 'dsh-llm', neverExecute + 'function effort() {}\nexport { effort as ReasoningEffortId };\nexport default class LlmService {}');
  core(profile, 'dsh-session', neverExecute + 'export const SESSION_FORMAT_VERSION = 4;\nexport default class SessionStore {}',
    { exports: { '.': './index.js', './surface': './index.js' } });
  core(profile, 'dsh-tools', neverExecute + 'export class ToolArgsError extends Error {}\nexport default class ToolRuntime {}');
  core(profile, 'dsh-settings', neverExecute + 'export default class SettingsForms {}');
  const result = inspectCoreOverrides(profile);
  assert.equal(result.ok, true);
  assert.ok(result.findings.every((finding) => finding.status === 'override-unknown' && finding.missing.length === 0));
});

test('normal full package layouts and other versions are not rejected by version guessing', (t) => {
  const profile = fixture(t);
  const directory = core(profile, 'dsh-tools', 'export {};');
  fs.mkdirSync(path.join(directory, 'lib'));
  core(profile, 'dsh-session', 'export default {};', { version: '0.2.1-rc.2' });
  core(profile, 'dsh-llm', 'export * from "some-external-core";');
  const result = inspectCoreOverrides(profile);
  assert.equal(result.ok, true);
  assert.ok(result.findings.filter((finding) => finding.status !== 'absent').every((finding) => finding.status === 'override-unknown'));
});

test('corrupt or missing core metadata and broken entry files report unreadable without rewriting', (t) => {
  const profile = fixture(t);
  const badManifest = core(profile, 'dsh-llm', 'export {};');
  fs.writeFileSync(path.join(badManifest, 'package.json'), '{broken');
  const missingManifest = path.join(profile, 'node_modules/@deepseek-ai/dsh-session'); fs.mkdirSync(missingManifest);
  const brokenEntry = core(profile, 'dsh-tools', 'export {};'); fs.unlinkSync(path.join(brokenEntry, 'index.js'));
  fs.symlinkSync(path.join(brokenEntry, 'missing-target.js'), path.join(brokenEntry, 'index.js'));
  const result = inspectCoreOverrides(profile);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.slice(0, 3).map((finding) => finding.status), ['unreadable', 'unreadable', 'unreadable']);
  assert.ok(result.findings[0].missing[0].includes('package.json unreadable'));
  assert.ok(result.findings[2].missing[0].includes('index.js unreadable'));
  assert.equal(fs.readFileSync(path.join(badManifest, 'package.json'), 'utf8'), '{broken');
  assert.ok(fs.lstatSync(path.join(brokenEntry, 'index.js')).isSymbolicLink());
});

test('non-callable default shim is rejected even when a single named contract was added', (t) => {
  const profile = fixture(t);
  core(profile, 'dsh-tools', 'export class ToolArgsError extends Error {}\nexport default { ToolArgsError };');
  const finding = inspectCoreOverrides(profile).findings.find((item) => item.name === '@deepseek-ai/dsh-tools');
  assert.equal(finding.status, 'shim'); assert.equal(finding.missing.length, 1);
  assert.match(finding.missing[0], /service\/apply/);
});
