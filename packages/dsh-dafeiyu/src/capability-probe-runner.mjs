/** Fixed, disposable tests run by DSH's actual terminal tool, never on page load. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDesktopFixture } from './native-desktop-fixture.js';

const execAsync = promisify(execFile);
const execute = (binary,args,options) => {
  const pending = execAsync(binary,args,options);
  // Fixed probes are non-interactive. Close stdin so a CLI cannot wait for EOF.
  pending.child.stdin?.end();
  return pending;
};
export const PROOF_PREFIX = 'DFY_CAPABILITY_PROOF ';
const validNonce = (value) => typeof value === 'string' && /^DFY-CAP-[a-f0-9]{24}$/.test(value);
const failure = (code) => Object.assign(new Error(code), { code });
const safeEnvironment = () => Object.fromEntries(['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].filter((key) => typeof process.env[key] === 'string')
  .map((key) => [key, process.env[key]]));

async function executable(name) {
  const candidates = [...(process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map((dir) => path.join(dir, name)),
    path.join(homedir(), '.local/bin', name), path.join('/opt/homebrew/bin', name), path.join('/usr/local/bin', name)];
  for (const candidate of new Set(candidates)) {
    try { if ((await fs.stat(candidate)).isFile()) { await fs.access(candidate, constants.X_OK); return candidate; } } catch {}
  }
  throw failure('UNAVAILABLE');
}
// Ego's successful nodejs console output is written to stderr in current builds.
// These streams stay internal: only exact fixed markers or nonce receipts escape.
const outputOf = (result) => [result?.stdout,result?.stderr].filter(value=>typeof value==='string').join('\n');
const proof = (kind, nonce) => ({ kind, nonce, matched: true });
const assertNonce = (nonce) => { if (!validNonce(nonce)) throw failure('FAILED'); };

export async function computerProbe(nonce) {
  assertNonce(nonce);
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'dafeiyu-capability-'));
  await fs.chmod(directory, 0o700);
  try {
    const target = path.join(directory, 'owned-test.txt');
    await fs.writeFile(target, nonce, { flag: 'wx', mode: 0o600 });
    if (await fs.readFile(target, 'utf8') !== nonce) throw failure('FAILED');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  return proof('computer', nonce);
}

export function findFixtureIndex(tree, label, { input = false } = {}) {
  if (typeof tree !== 'string' || tree.length > 1024 * 1024) throw failure('UNCONFIRMED');
  const found = [];
  for (const line of tree.split('\n')) {
    if (!line.includes(label) || !(input ? /text field|textfield|textbox|input|edit/i : /button|按钮/i).test(line)) continue;
    const match = /^\s*(?:\[(\d+)\]|(\d+)[.:]?)\s+/.exec(line);
    if (match) found.push(Number(match[1] || match[2]));
  }
  if (found.length !== 1 || !Number.isSafeInteger(found[0])) throw failure('UNCONFIRMED');
  return found[0];
}

export async function desktopProbe(nonce, { run = execute, resolveExecutable = executable,
  withFixture = withDesktopFixture, signal, authorize } = {}) {
  assertNonce(nonce);
  return withFixture(async ({ pid, signal: fixtureSignal, isAlive }) => {
    const guard = () => {
      let allowed = false;
      try { allowed = !signal?.aborted && !fixtureSignal?.aborted && isAlive?.() === true
        && (authorize === undefined || authorize() === true); } catch {}
      if (!allowed) throw failure('CANCELLED');
    };
    guard();
    if (!Number.isSafeInteger(pid) || pid <= 0) throw failure('UNCONFIRMED');
    const binary = await resolveExecutable('orca'); guard();
    const call = async (args) => {
      guard();
      const { stdout } = await run(binary, ['computer', ...args, '--json'], { timeout: 14000, maxBuffer: 1024 * 1024,
        env: safeEnvironment(), ...(fixtureSignal ? {signal:fixtureSignal} : {}) });
      guard();
      let value; try { value = JSON.parse(stdout); } catch { throw failure('UNCONFIRMED'); }
      if (value?.ok !== true) throw failure('UNCONFIRMED');
      return value.result;
    };
    const app = 'pid:' + pid;
    const inventory = await call(['list-windows','--app',app]);
    const windows = inventory?.windows?.filter(window => window && window.isMinimized !== true && window.isOffscreen !== true);
    if ((inventory?.app?.pid ?? windows?.[0]?.app?.pid) !== pid || !Array.isArray(windows) || windows.length !== 1
      || windows[0].title !== '本机桌面能力安全测试') throw failure('DESKTOP_TARGET_UNCONFIRMED');
    const window = windows[0];
    const selectors = [
      ...(Number.isSafeInteger(window.id) && window.id > 0 ? [['--window-id',String(window.id)]] : []),
      ...(Number.isSafeInteger(window.index) && window.index >= 0 ? [['--window-index',String(window.index)]] : []), []];
    let target, state, input;
    for (const selected of selectors) {
      guard(); target = ['--app',app,...selected,'--no-screenshot'];
      try { state = await call(['get-app-state',...target,'--restore-window']); } catch { guard(); state = null; }
      if (!state?.snapshot?.treeText?.includes('本机能力验证输入')) continue;
      try { input = findFixtureIndex(state.snapshot.treeText,'本机能力验证输入',{input:true}); }
      catch { throw failure('DESKTOP_TARGET_UNCONFIRMED'); }
      break;
    }
    if (input === undefined) throw failure('DESKTOP_TARGET_UNCONFIRMED');
    await call(['set-value',...target,'--element-index',String(input),'--value',nonce]);
    state = await call(['get-app-state',...target]);
    if (!state?.snapshot?.treeText?.includes(nonce)) throw failure('UNCONFIRMED');
    const button = findFixtureIndex(state.snapshot.treeText,'确认本机能力测试');
    await call(['click',...target,'--element-index',String(button)]);
    state = await call(['get-app-state',...target]);
    if (!state?.snapshot?.treeText?.includes('本机界面验证已收到 ' + nonce)) throw failure('UNCONFIRMED');
    guard(); return proof('desktop',nonce);
  }, { signal, authorize });
}

export function browserScript(url, nonce) {
  assertNonce(nonce);
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) throw failure('FAILED');
  return `const task = await taskSpace("大肥鱼能力安全验证");
const page = task.page("p1");
await page.goto(${JSON.stringify(url)});
const initial = await page.snapshot();
if (!JSON.stringify(initial).includes("大肥鱼本地能力测试")) throw new Error("LOCAL_FIXTURE_MISSING");
await page.fill("loc=css:#capability-value", ${JSON.stringify(nonce)});
await page.click("loc=css:#capability-submit", {label:"验证本地测试按钮"});
await page.waitForFunction((expected) => document.getElementById("capability-result")?.textContent === expected, ${JSON.stringify(nonce)}, {timeout:8000});
const matched = await page.evaluate((expected) => document.getElementById("capability-result")?.textContent === expected, ${JSON.stringify(nonce)});
if (!matched) throw new Error("READBACK_FAILED");
await task.finish({keep:[]});
console.log(${JSON.stringify(PROOF_PREFIX)} + JSON.stringify({kind:"browser",nonce:${JSON.stringify(nonce)},matched:true}));`;
}

export function extractProof(stdout, kind, nonce) {
  assertNonce(nonce);
  const matches = String(stdout || '').split(/\r?\n/).filter((line) => line.startsWith(PROOF_PREFIX));
  if (matches.length !== 1) throw failure('UNCONFIRMED');
  let value; try { value = JSON.parse(matches[0].slice(PROOF_PREFIX.length)); } catch { throw failure('UNCONFIRMED'); }
  if (value?.kind !== kind || value.nonce !== nonce || value.matched !== true) throw failure('UNCONFIRMED');
  return value;
}

export async function browserProbe(nonce, { run = execute, resolveExecutable = executable } = {}) {
  assertNonce(nonce);
  const binary = await resolveExecutable('ego-browser');
  let bootstrap;
  try { bootstrap = await run(binary, ['nodejs','-e','console.log("DFY_EGO_BOOTSTRAP_READY")'], {timeout:10000,maxBuffer:16384,env:safeEnvironment()}); }
  catch { throw failure('UNAVAILABLE'); }
  if (outputOf(bootstrap).split(/\r?\n/).filter(line=>line==='DFY_EGO_BOOTSTRAP_READY').length !== 1) throw failure('UNAVAILABLE');
  const token = nonce.slice(8);
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>大肥鱼本地能力测试</title>'
    + '<h1>大肥鱼本地能力测试</h1><p>这是自建临时页面，不会提交到外部网站。</p>'
    + '<label>验证文本<input id="capability-value" autocomplete="off"></label>'
    + '<button id="capability-submit" type="button">确认测试</button><output id="capability-result"></output>'
    + '<script>document.getElementById("capability-submit").addEventListener("click",()=>{document.getElementById("capability-result").textContent=document.getElementById("capability-value").value;});</script></html>';
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/' + token) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"});
    res.end(html);
  });
  await new Promise((yes,no) => { server.once('error',no); server.listen(0,'127.0.0.1',yes); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/${token}`;
    const receipt = await run(binary, ['nodejs','-e',browserScript(url,nonce)], {timeout:45000,maxBuffer:1024*1024,env:safeEnvironment()});
    return extractProof(outputOf(receipt),'browser',nonce);
  } finally {
    server.closeAllConnections?.();
    await new Promise((yes) => server.close(yes));
  }
}

async function main() {
  const [kind,nonce] = process.argv.slice(2);
  const methods = {computer:computerProbe,desktop:desktopProbe,browser:browserProbe};
  try {
    if (!Object.hasOwn(methods,kind)) throw failure('FAILED');
    console.log(PROOF_PREFIX + JSON.stringify(await methods[kind](nonce)));
  } catch (error) {
    console.log('DFY_CAPABILITY_FAILURE ' + (['UNAVAILABLE','UNCONFIRMED','ACCESSIBILITY_REQUIRED','DESKTOP_INIT_UNCONFIRMED','DESKTOP_TARGET_UNCONFIRMED'].includes(error.code) ? error.code : 'FAILED'));
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
