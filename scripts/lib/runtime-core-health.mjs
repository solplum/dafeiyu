import fs from 'node:fs';
import path from 'node:path';

const CONTRACTS = Object.freeze({
  'dsh-llm': ['ReasoningEffortId'],
  'dsh-session': ['SESSION_FORMAT_VERSION'],
  'dsh-tools': ['ToolArgsError'],
  'dsh-settings': [],
});

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function hasNamedExport(source, name) {
  if (new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|class|const|let|var)\\s+${name}\\b`).test(source)) return true;
  return [...source.matchAll(/\bexport\s*\{([^}]*)\}/g)].some(([, body]) => body.split(',').some((item) => {
    const identifiers = item.trim().split(/\s+as\s+/);
    return identifiers.at(-1)?.trim() === name;
  }));
}

function hasSurfaceExport(exports) {
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return false;
  return Object.entries(exports).some(([key, value]) => {
    if (value === null) return false;
    if (key === './surface') return true;
    if (!key.includes('*')) return false;
    const [prefix, suffix] = key.split('*');
    return './surface'.startsWith(prefix) && './surface'.endsWith(suffix || '');
  });
}

function readFailure(name, version, stage, error) {
  return { name, status: 'unreadable', version,
    missing: [`${stage} (${typeof error?.code === 'string' ? error.code : 'invalid data'})`] };
}

function inspectPackage(profile, shortName, exportsRequired) {
  const name = `@deepseek-ai/${shortName}`;
  const directory = path.join(profile, 'node_modules', '@deepseek-ai', shortName);
  const base = { name, status: 'absent', version: null, missing: [] };
  try { fs.lstatSync(directory); }
  catch (error) { return error.code === 'ENOENT' ? base : readFailure(name, null, 'package directory unreadable', error); }

  let manifest, entries;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('invalid manifest');
  } catch (error) { return readFailure(name, null, 'package.json unreadable', error); }
  const version = typeof manifest.version === 'string' ? manifest.version : null;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { return readFailure(name, version, 'package directory unreadable', error); }

  const unknown = { ...base, status: 'override-unknown', version };
  // This is a targeted check for the four hand-written shims from the startup
  // crash, not a general package verifier. Complete or unfamiliar overrides
  // remain warnings; their versions alone must never cause a false rejection.
  const names = entries.map((entry) => entry.name).sort();
  if (version !== '0.2.1' || manifest.type !== 'module'
    || names.length !== 2 || names[0] !== 'index.js' || names[1] !== 'package.json') return unknown;

  let source;
  try { source = withoutComments(fs.readFileSync(path.join(directory, 'index.js'), 'utf8')); }
  catch (error) { return readFailure(name, version, 'index.js unreadable', error); }
  // A star re-export can supply contracts from elsewhere. Static inspection
  // cannot prove those contracts absent without executing or following it.
  if (/\bexport\s*\*/.test(source)) return unknown;
  const missing = exportsRequired.filter((symbol) => !hasNamedExport(source, symbol));
  if (shortName === 'dsh-session' && !hasSurfaceExport(manifest.exports)) missing.push('package export ./surface');

  const literalDefault = source.match(/\bexport\s+default\s*\{([\s\S]*?)\}\s*;?\s*$/);
  if (literalDefault && !literalDefault[1].includes('...') && !hasNamedExport(source, 'apply')
    && !/\bapply\s*(?:\(|:|,|$)/.test(literalDefault[1].trim())) {
    missing.push('callable Cordis service/apply entry (default is a plain object)');
  }
  return missing.length ? { ...base, status: 'shim', version, missing } : unknown;
}

/**
 * Inspect local core-package overrides without importing, executing or changing
 * any package. Absent overrides use the application's bundled runtime.
 * Only the known incomplete shim shape and explicit read failures are errors.
 */
export function inspectCoreOverrides(profile) {
  if (typeof profile !== 'string' || !profile.trim()) throw new TypeError('profile must be a non-empty path');
  const root = path.resolve(profile);
  const findings = Object.entries(CONTRACTS).map(([name, required]) => inspectPackage(root, name, required));
  return { ok: findings.every((finding) => finding.status === 'absent' || finding.status === 'override-unknown'), findings };
}
