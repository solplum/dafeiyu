#!/usr/bin/env python3
"""Build a narrow, auditable local helper override. Never execute the helper."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
UPSTREAM = ROOT / 'upstream'
SOURCE = UPSTREAM / 'native/macos/Sources/Helper'
TARGET = ROOT / 'Sources/Helper'
BIN = ROOT / 'bin/dsh-computer-use-helper'
BUILD = ROOT / 'build'
EXPECTED = '122ee568fecdd4b09850dbdb771155e27a44d5c89f2e0ffe1243f39541daa532'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def source_hash(files):
    h = hashlib.sha256()
    for name, contents in sorted(files.items()):
        h.update(name.encode()); h.update(b'\0'); h.update(contents); h.update(b'\0')
    return h.hexdigest()

os.umask(0o077)
ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(ROOT, 0o700)
original = {p.name: p.read_bytes() for p in SOURCE.glob('*.swift')}
assert source_hash(original) == EXPECTED, 'audited upstream source mismatch'
before = original['main.swift'].decode()
first = '        if setSelectedText(text, app: app) {'
second = '        if current.activation == "activated", setSelectedText(text, app: app) {'
assert before.count(first) == 1 and before.count(second) == 1, 'patch target mismatch'
after = before.replace(first, '        if keyboardPolicy != "activate", setSelectedText(text, app: app) {', 1)
after = after.replace(second, '        if keyboardPolicy != "activate", current.activation == "activated", setSelectedText(text, app: app) {', 1)
start = after.index('private func typeTextWithKeyboard(')
end = after.index('\nprivate func targetRecord(', start)
chunk_function = '''private func keyboardTextChunks(_ text: String) -> [String] {
    text.unicodeScalars.map { String($0) }
}
'''
keyboard_function = '''
private func typeTextWithKeyboard(_ text: String, app: NSRunningApplication) throws {
    let source = try targetedEventSource()
    for chunk in keyboardTextChunks(text) {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw fail("COMPUTER_ACTION_BLOCKED", "CoreGraphics could not create Unicode keyboard events")
        }
        down.flags = []
        up.flags = []
        let units = Array(chunk.utf16)
        units.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
        }
        down.postToPid(app.processIdentifier)
        usleep(5_000)
        up.postToPid(app.processIdentifier)
        usleep(15_000)
    }
}
'''
after = after[:start] + chunk_function + keyboard_function + after[end:]
patched = dict(original, **{'main.swift': after.encode()})
for directory in [TARGET, BIN.parent, BUILD, BUILD / 'module-cache', BUILD / 'tmp']:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
for name, contents in patched.items():
    (TARGET / name).write_bytes(contents)
(ROOT / 'keyboard-activate.patch').write_text(''.join(difflib.unified_diff(
    before.splitlines(keepends=True), after.splitlines(keepends=True),
    fromfile='upstream/native/macos/Sources/Helper/main.swift',
    tofile='managed/Sources/Helper/main.swift')))
shutil.copyfile(UPSTREAM / 'LICENSE', ROOT / 'UPSTREAM-LICENSE')
env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(BUILD),
       'TMPDIR': str(BUILD / 'tmp') + '/', 'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8',
       'CLANG_MODULE_CACHE_PATH': str(BUILD / 'module-cache'),
       'SWIFT_MODULECACHE_PATH': str(BUILD / 'module-cache')}
commands = []
def run(argv, *, timeout=300):
    commands.append(argv)
    result = subprocess.run(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    with (ROOT / 'build.log').open('ab') as output:
        output.write(result.stdout); output.write(result.stderr)
    if result.returncode:
        raise RuntimeError('build or metadata verification failed; inspect build.log')
    return result.stdout.decode().strip()

developer = run(['/usr/bin/xcode-select', '--print-path'], timeout=5)
assert Path(developer).is_dir(), 'developer directory missing'
# Compile and run only the exact pure splitter from the patched source, never
# the AppKit helper. This catches scalar/UTF-16 errors without GUI or AX input.
actual_start = after.index('private func keyboardTextChunks(')
actual_end = after.index('\nprivate func typeTextWithKeyboard(', actual_start)
test_source = ROOT / 'algorithm-tests.swift'
test_source.write_text(after[actual_start:actual_end] + '''

@main struct AlgorithmTests {
    static func main() {
        let ascii32 = String(repeating: "A", count: 32)
        let chinese = String(repeating: "中", count: 21)
        let pairs = String(repeating: "😀", count: 11)
        let edge = String(repeating: "A", count: 19) + "😀Z"
        let zwj = String(repeating: "👨‍👩‍👧‍👦", count: 4)
        let cases = [ascii32, chinese, pairs, edge, zwj, "", String(repeating: "Z", count: 20)]
        for value in cases {
            let chunks = keyboardTextChunks(value)
            precondition(chunks.joined() == value)
            precondition(chunks.allSatisfy { !$0.isEmpty && $0.utf16.count <= 2 })
            precondition(chunks.flatMap { $0.unicodeScalars.map(\\.value) } == value.unicodeScalars.map(\\.value))
        }
        precondition(keyboardTextChunks(ascii32).map { $0.utf16.count } == Array(repeating: 1, count: 32))
        precondition(keyboardTextChunks(chinese).map { $0.utf16.count } == Array(repeating: 1, count: 21))
        precondition(keyboardTextChunks(pairs).map { $0.utf16.count } == Array(repeating: 2, count: 11))
        precondition(keyboardTextChunks(edge).map { $0.utf16.count } == Array(repeating: 1, count: 19) + [2, 1])
        precondition(keyboardTextChunks("").isEmpty)
        print("{\\"ok\\":true,\\"cases\\":7,\\"guiExecuted\\":false}")
    }
}
''')
test_binary = BUILD / 'algorithm-tests'
run(['/usr/bin/xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library',
     '-target', 'arm64-apple-macos14.0', '-module-cache-path', str(BUILD / 'module-cache'),
     str(test_source), '-o', str(test_binary)])
algorithm_result = json.loads(run([str(test_binary)], timeout=5))
assert algorithm_result == {'ok': True, 'cases': 7, 'guiExecuted': False}
(ROOT / 'algorithm-tests.json').write_text(json.dumps(algorithm_result, indent=2) + '\n')
argv = ['/usr/bin/xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', '-O',
        '-target', 'arm64-apple-macos14.0', '-module-cache-path', str(BUILD / 'module-cache'),
        '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'CoreGraphics',
        '-framework', 'QuartzCore', '-framework', 'ScreenCaptureKit', '-lproc',
        *[str(TARGET / name) for name in sorted(patched)], '-o', str(BIN)]
run(argv)
os.chmod(BIN, 0o700)
run(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', str(BIN)], timeout=30)
run(['/usr/bin/codesign', '--verify', '--strict', str(BIN)], timeout=30)
architectures = run(['/usr/bin/xcrun', 'lipo', '-archs', str(BIN)], timeout=10).split()
assert architectures == ['arm64'], 'unexpected compiled architecture'
assert source_hash({p.name: p.read_bytes() for p in SOURCE.glob('*.swift')}) == EXPECTED, 'upstream changed'
manifest = {
    'schemaVersion': 1,
    'kind': 'reviewed-local-helper-override',
    'upstream': {'name': '@anionex/dsh-computer-use', 'version': '0.3.4',
                 'sourceSha256': EXPECTED,
                 'packagedBinarySha256': 'b1369bc511084958d70fa5bb9f61ba4bebf62b268d4185169b52b78a27b529b2'},
    'helperVersion': '0.3.4',
    'preparedVersionLabel': 'external',
    'healthHelperVersion': '0.3.4',
    'sourceSha256': source_hash(patched),
    'patchSha256': digest((ROOT / 'keyboard-activate.patch').read_bytes()),
    'binary': {'path': 'bin/dsh-computer-use-helper', 'sha256': digest(BIN.read_bytes()),
               'architectures': architectures, 'minimumMacOS': '14.0', 'mode': '0700'},
    'change': 'keyboardPolicy=activate bypasses AXSelectedText shortcuts. One Unicode scalar per targeted down/up pair (<=2 UTF16), empty flags, 5ms before release and 15ms after release. No replay. Preserve policy remains AX-first.',
    'validation': {'compiled': True, 'adHocCodeSignatureVerified': True,
                   'upstreamSourceUnchanged': True, 'helperExecuted': False,
                   'guiInputVerified': False, 'algorithmTests': algorithm_result},
    'integration': {'configField': 'helper.path', 'value': str(BIN),
                    'requiresPreApplyDigestCheck': True,
                    'providerManifestAppliesToExternalOverride': False,
                    'changesActiveProfile': False},
    'commands': commands,
}
(ROOT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
shutil.rmtree(BUILD)
print(json.dumps({'ok': True, 'binary': str(BIN), 'sha256': manifest['binary']['sha256'],
                  'sourceSha256': manifest['sourceSha256'], 'architectures': architectures,
                  'helperExecuted': False, 'manifest': str(ROOT / 'manifest.json')}))
