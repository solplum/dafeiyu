import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../vendor/bili-readonly/mcp_server.py', import.meta.url));
const provenance = JSON.parse(fs.readFileSync(new URL('../vendor/bili-readonly/PROVENANCE.json', import.meta.url)));

test('the registered read paths do not reach upstream ffmpeg, Whisper installers or subprocess helpers', () => {
  const output = execFileSync('python3', ['-c', String.raw`
import ast,json,pathlib,sys
tree=ast.parse(pathlib.Path(sys.argv[1]).read_text())
functions={n.name:n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef))}
pending=['bili_search','bili_subtitle','bili_comments','bili_video_info','bili_cover','bili_frames','bili_danmaku'];seen=set()
def name(node):
    if isinstance(node,ast.Name):return node.id
    if isinstance(node,ast.Attribute):return name(node.value)+'.'+node.attr
    return ''
while pending:
    current=pending.pop()
    if current in seen:continue
    seen.add(current)
    for node in ast.walk(functions[current]):
        if isinstance(node,ast.Call):
            called=name(node.func)
            assert not called.startswith(('subprocess.','asyncio.create_subprocess','os.system','os.spawn')), (current,called)
            if called in functions:pending.append(called)
assert '_extract_cover_from_video' not in seen and '_ensure_whisper' not in seen
print(json.dumps({'reachableFunctions':len(seen),'subprocessPaths':False}))
`, script], { encoding: 'utf8', maxBuffer: 65536 });
  assert.equal(JSON.parse(output).subprocessPaths, false);
});

test('fixed read-only Bilibili fork preserves exact provenance and missing versus damaged credentials without network', () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(script)).digest('hex'), provenance.forkSHA256);
  const output = execFileSync('python3', ['-c', String.raw`
import ast, contextlib, io, json, os, pathlib, sys, tempfile
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text())
selected = []
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(n, ast.Name) and n.id in {'_ALLOWED', '_REQUESTED_TOOLS'} for n in node.targets): selected.append(node)
    elif isinstance(node, ast.If) and any(isinstance(n, ast.Name) and n.id == '_REQUESTED_TOOLS' for n in ast.walk(node.test)): selected.append(node)
    elif isinstance(node, ast.FunctionDef) and node.name in {'tool', '_guard', 'load_credential', 'get_cred'}: selected.append(node)
decorated = [node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
             and any(isinstance(d, ast.Call) and isinstance(d.func, ast.Name) and d.func.id == 'tool' for d in node.decorator_list)]
expected = {'bili_search','bili_subtitle','bili_comments','bili_video_info','bili_cover','bili_frames','bili_danmaku'}
class Credential:
    def __init__(self, **values): self.values = values
class FakeMCP:
    def __init__(self): self.registered = []
    def tool(self):
        def register(fn): self.registered.append(fn.__name__); return fn
        return register
with tempfile.TemporaryDirectory() as directory:
    credential = pathlib.Path(directory) / 'bili_credential.json'
    def scope(requested=None):
        if requested is None: os.environ.pop('BILI_MCP_TOOLS', None)
        else: os.environ['BILI_MCP_TOOLS'] = requested
        ns = {'Credential':Credential,'CRED_FILE':credential,'os':os,'sys':sys,'json':json,'mcp':FakeMCP()}
        exec(compile(ast.Module(body=selected,type_ignores=[]),sys.argv[1],'exec'),ns)
        for name in decorated:
            fn = lambda: None; fn.__name__ = name; ns['tool']()(fn)
        assert set(ns['mcp'].registered) == expected
        with contextlib.redirect_stderr(io.StringIO()):
            assert ns['_guard']('bili_reply') and ns['_guard']('bili_send_message')
        return ns
    for env in [None,'',','.join(sorted(expected))]: scope(env)
    for env in ['bili_reply',','.join(sorted(expected | {'bili_login'})), 'bili_search']:
        try: scope(env); raise AssertionError('A broadened or partial list must fail')
        except RuntimeError: pass
    ns = scope(); assert ns['get_cred']().values == {}
    invalid = ['', '{', '[]', '{}', 'null', json.dumps({'sessdata':'PRIVATE_CANARY','bili_jct':'','dedeuserid':'123'}),
               json.dumps({'sessdata':'PRIVATE_CANARY','bili_jct':'csrf','dedeuserid':'not-numeric'}),
               json.dumps({'sessdata':'PRIVATE_CANARY','bili_jct':'csrf','dedeuserid':'123','buvid3':{}}), ' ' * 65537]
    for contents in invalid:
        credential.write_text(contents)
        try: ns['get_cred'](); raise AssertionError('Invalid existing credential became anonymous')
        except RuntimeError as error: assert 'PRIVATE_CANARY' not in str(error)
        credential.unlink()
    credential.symlink_to(pathlib.Path(directory) / 'missing')
    try: ns['get_cred'](); raise AssertionError('Dangling credential link became anonymous')
    except RuntimeError: pass
    credential.unlink(); credential.mkdir()
    try: ns['get_cred'](); raise AssertionError('Credential directory became anonymous')
    except RuntimeError: pass
    credential.rmdir()
    credential.write_text(json.dumps({'sessdata':'PRIVATE_CANARY','bili_jct':'csrf','dedeuserid':'123'}))
    assert ns['get_cred']().values['sessdata'] == 'PRIVATE_CANARY'
    assert ns['load_credential']().values['dedeuserid'] == '123'
    main = next(node for node in tree.body if isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
                and isinstance(node.test.left, ast.Name) and node.test.left.id == '__name__')
    assert isinstance(main.body[0], ast.Expr) and isinstance(main.body[0].value, ast.Call) and main.body[0].value.func.id == 'get_cred'
print(json.dumps({'registeredReadTools':len(expected),'writesRegistered':False,'missingCredentialUsesSDKDefault':True,
                 'badCredentialCasesRejected':len(invalid)+2,'existingCredentialPreserved':True,'startupValidation':True,'networkUsed':False}))
`, script], { encoding: 'utf8', maxBuffer: 65536 });
  const result = JSON.parse(output);
  assert.equal(result.registeredReadTools, 7); assert.equal(result.writesRegistered, false);
  assert.equal(result.badCredentialCasesRejected, 11); assert.equal(result.startupValidation, true);
});
