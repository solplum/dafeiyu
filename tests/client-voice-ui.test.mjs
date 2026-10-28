import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shipped = fs.readFileSync(new URL('../packages/dsh-dafeiyu/src/client.js', import.meta.url), 'utf8');
const entry = '() => h(Panel),';
assert.equal(shipped.split(entry).length, 2, 'fixture must replace only the host entrypoint');
const source = shipped.replace(entry, '() => h(window.__speechTest ? SpeechInputPanel : VoiceOutputPanel, { active: window.__active, refreshKey: window.__refreshKey }),');
const sampleAudio = Buffer.from('isolated-audio-fixture').toString('base64');

// The real shipped components and handlers run here. Only the React host, file
// reader and HTTP boundary are fixtures; this never uses a model, QQ or microphone.
function fixture({ speech = false } = {}) {
  let component, hookIndex, rootRender, tree, dirty = false, effects = [], timerId = 0;
  let gate = null, previewPatch = {}, speechPatch = {}, responseError = null, deferFile = false, failFile = false;
  const instances = new Map(), calls = [], timers = new Map(), readers = [], audioElements = new Map();
  const voice = { config: { revision: 'voice-1', saved: { voiceReplyEnabled: false, ttsProvider: 'openai-compatible',
    ttsBaseURL: 'http://127.0.0.1:55001/v1', ttsModel: 'local-qwen', ttsVoice: 'vivian', ttsAutoVoice: false, ttsLanguage: 'chinese' },
    effective: {}, overriddenFields: [], secretConfigured: { ttsApiKey: true } },
    runtime: { enabled: false, configured: true, readiness: 'not-verified' }, pendingReload: false,
    voices: [{ id: 'vivian', name: '薇薇', description: '明亮自然的女声', language: 'zh', available: true },
      { id: 'serena', name: '小婉', description: '温柔平静的女声', language: 'zh', available: true }], defaultVoiceId: 'vivian', autoVoice: false };
  voice.config.effective = { ...voice.config.saved };
  const speechState = { available: true, providers: [{ id: 'local', name: '本机识别', languages: ['zh', 'en'], preparation: { phase: 'ready' } }],
    selection: { providerId: 'local', language: 'zh' }, selectionEditable: true, canPrepare: true, job: null };
  const host = { __speechTest: speech, __active: true, __refreshKey: 0, __ModuleLoader__: { load({ factory }) {
    factory((name) => { assert.equal(name, 'react'); return React; }).apply({ slots: {
      inject(_name, callback) { callback(); }, register(_definition, render) { rootRender = render; },
    } });
  } } };
  const React = {
    Fragment: Symbol('fragment'), createElement(type, props, ...children) { return { type, props: { ...(props || {}), children: children.flat(Infinity) } }; },
    useState(initial) {
      const instance = component, index = hookIndex++;
      const hook = instance.hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      hook.set ||= (next) => { const value = typeof next === 'function' ? next(hook.value) : next;
        if (!Object.is(value, hook.value)) { hook.value = value; dirty = true; } };
      return [hook.value, hook.set];
    },
    useRef(initial) { return component.hooks[hookIndex++] ||= { current: initial }; },
    useEffect(effect, deps) {
      const instance = component, index = hookIndex++, old = instance.hooks[index];
      if (!old || !deps || deps.some((value, at) => !Object.is(value, old.deps?.[at]))) {
        instance.hooks[index] = { deps, cleanup: old?.cleanup };
        effects.push(() => { old?.cleanup?.(); instance.hooks[index].cleanup = effect(); });
      }
    },
  };
  class FileReader {
    constructor() { readers.push(this); }
    readAsDataURL(file) { this.file = file; if (!deferFile) this.finish(); }
    finish() { if (failFile) this.onerror?.(); else { this.result = 'data:' + (this.file.type || '') + ';base64,' + (this.file.base64 || sampleAudio); this.onload?.(); } }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  vm.runInNewContext(source, { window: host, document: {}, AbortController, TextEncoder, URLSearchParams, URL, Date, Math, FileReader,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => {
      const route = url.split('/api/')[1], method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ route, method, payload });
      let result;
      if (route === 'voice/status') result = { ok: true, voice };
      else if (route === 'voice/config') {
        if (responseError) result = responseError;
        else {
          assert.equal(payload.revision, voice.config.revision);
          Object.assign(voice.config.saved, payload.patch); delete voice.config.saved.ttsApiKey;
          voice.config.revision = 'voice-2'; voice.pendingReload = true;
          result = { ok: true, voice };
        }
      } else if (route === 'voice/test') {
        if (gate) await gate;
        result = responseError || { ok: true, test: { ok: true, generated: true, delivered: false, bytes: 22, voiceId: payload.voiceId,
          audio: { mime: 'audio/mpeg', base64: sampleAudio }, ...previewPatch } };
      } else if (route === 'model/status') result = { ok: true, model: { speech: speechState } };
      else if (route === 'speech/test') {
        if (gate) await gate;
        result = responseError || { ok: true, test: { ok: true, text: '听见了清晰的人声', ...speechPatch }, speech: speechState };
      } else assert.fail('Unexpected API: ' + route);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  function render(node, location = 'root') {
    if (node == null || node === false) return null;
    if (typeof node !== 'object') return String(node);
    if (typeof node.type === 'function') {
      const key = location + ':' + node.type.name, instance = instances.get(key) || { hooks: [] }; instances.set(key, instance);
      const previous = component; component = instance; hookIndex = 0; const child = node.type(node.props); component = previous;
      return render(child, location + 'f');
    }
    if (node.type === 'audio' && node.props.ref) {
      const audio = audioElements.get(location) || { pauses: 0, pause() { this.pauses++; } };
      audioElements.set(location, audio); node.props.ref.current = audio;
    }
    return { ...node, props: { ...node.props, children: node.props.children.map((child, at) => render(child, location + '.' + (child?.props?.key ?? at))) } };
  }
  async function flush() {
    for (let attempt = 0; attempt < 30; attempt++) {
      dirty = false; tree = render(rootRender()); const pending = effects; effects = []; for (const effect of pending) effect();
      await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve));
      if (!dirty && !effects.length) return;
    }
    assert.fail('Voice UI did not settle');
  }
  const nodes = (node = tree) => !node || typeof node !== 'object' || node.props.hidden ? [] : [node, ...node.props.children.flatMap((child) => nodes(child))];
  const text = (node = tree) => typeof node === 'string' ? node : node?.props?.hidden ? '' : node?.props?.children.map((child) => text(child)).join('') || '';
  const button = (label) => nodes().find((node) => node.type === 'button' && text(node) === label);
  const field = (suffix) => nodes().find((node) => node.props.id?.endsWith(suffix));
  async function click(label) { const node = button(label); assert(node, 'Missing button: ' + label); assert.equal(Boolean(node.props.disabled), false, 'Disabled button: ' + label); node.props.onClick(); await flush(); }
  async function change(suffix, value, checked = false) { const node = field(suffix); assert(node, 'Missing field: ' + suffix); node.props.onChange({ target: checked ? { checked: value } : { value } }); await flush(); }
  async function expand() { const node = nodes().find((node) => node.type === 'summary'); assert(node); if (!node.props['aria-expanded']) node.props.onClick({ preventDefault() {} }); await flush(); }
  async function choose(file = { name: 'test.mp3', type: 'audio/mpeg', size: 22 }) {
    const node = nodes().find((node) => node.type === 'input' && node.props.type === 'file'); assert(node);
    node.props.onChange({ target: { files: [file], value: 'test.mp3' } }); await flush();
  }
  return { voice, speech: speechState, calls, readers, nodes, text, button, field, click, change, expand, choose, flush,
    get pauses() { return [...audioElements.values()].reduce((sum, audio) => sum + audio.pauses, 0); },
    setGate(value) { gate = value; }, setPreview(value) { previewPatch = value; }, setSpeech(value) { speechPatch = value; },
    setError(value) { responseError = value; }, deferFile(value) { deferFile = value; }, failFile(value) { failFile = value; },
    async active(value) { host.__active = value; await flush(); },
    async refresh() { host.__refreshKey++; await flush(); },
    dispose() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); },
  };
}

test('voice opening only reads status and shows ordinary voice choices with advanced connection details collapsed', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  assert.deepEqual(f.calls, [{ route: 'voice/status', method: 'GET', payload: undefined }]);
  for (const value of ['未开启', '默认音色', '薇薇', '小婉', '明亮自然的女声', '允许大肥鱼自己选音色', '不会发到 QQ']) assert.ok(f.text().includes(value), value);
  assert.equal(f.field('-auto-voice').props.checked, false); assert.equal(f.field('-enabled').props.checked, false);
  assert.equal(f.field('-ttsBaseURL'), undefined); assert.equal(f.field('-key'), undefined);
  assert.equal(f.text().includes('可能产生费用'), false);
  await f.expand(); assert.equal(f.field('-ttsBaseURL').props.value, 'http://127.0.0.1:55001/v1');
  assert.equal(f.field('-key').props.value, ''); assert.match(f.field('-key').props.placeholder, /已配置/);
});

test('manual defaults and automatic per-message choice save one revisioned patch and wait for apply', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  await f.change('-default-voice', 'serena'); await f.change('-auto-voice', true, true);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  await f.click('保存声音设置');
  assert.deepEqual(f.calls.find((call) => call.route === 'voice/config').payload, { revision: 'voice-1', patch: { ttsVoice: 'serena', ttsAutoVoice: true } });
  assert.equal(f.voice.config.saved.voiceReplyEnabled, false, 'saving sound choice does not enable outbound voice');
  assert.ok(f.text().includes('尚未生效')); assert.equal(f.button('试听这个声音').props.disabled, true);
});

for (const refresh of ['automatic', 'manual']) test(refresh + ' status refresh reconciles only a saved voice notice after apply without claiming tested delivery', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  await f.change('-default-voice', 'serena'); await f.click('保存声音设置');
  await f.refresh(); assert.ok(f.text().includes('点击下方“生效”后接入当前运行'));
  assert.equal(f.text().includes('声音设置已生效。'), false, 'a pending snapshot still requires explicit apply');
  f.voice.pendingReload = false; f.voice.defaultVoiceId = 'serena'; f.voice.runtime.enabled = true;
  if (refresh === 'automatic') await f.refresh(); else await f.click('检查');
  assert.ok(f.text().includes('声音设置已生效。'));
  assert.equal(f.text().includes('点击下方“生效”后接入当前运行'), false);
  assert.equal(f.text().includes('尚未生效'), false);
  assert.ok(f.text().includes('待测试')); assert.equal(f.text().includes('已确认可发送'), false);
  assert.equal(f.field('-default-voice').props.value, 'serena');
  assert.deepEqual(f.calls.filter((call) => call.method === 'POST').map((call) => call.route), ['voice/config'],
    'reconciling the notice neither reapplies config nor synthesizes or sends audio');
});

test('automatic status refresh retains an existing generated preview and its playback notice', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.click('试听这个声音');
  const audio = () => f.nodes().find((node) => node.type === 'audio');
  const previousSrc = audio().props.src;
  await f.refresh();
  assert.equal(audio().props.src, previousSrc); assert.ok(f.text().includes('声音已生成，点击下方播放按钮试听。'));
  assert.equal(f.text().includes('声音设置已生效。'), false);
  assert.equal(f.calls.filter((call) => call.route === 'voice/test').length, 1);
});

test('automatic status refresh preserves a previous preview failure instead of treating a status read as a new synthesis result', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.setPreview({ ok: false, generated: false, note: '试听服务暂时不可用' });
  await f.flush(); await f.click('试听这个声音');
  assert.ok(f.nodes().some((node) => node.props.role === 'alert' && f.text(node).includes('试听服务暂时不可用')));
  await f.refresh();
  assert.ok(f.nodes().some((node) => node.props.role === 'alert' && f.text(node).includes('试听服务暂时不可用')));
  assert.equal(f.nodes().some((node) => node.type === 'audio'), false);
  assert.equal(f.calls.filter((call) => call.route === 'voice/test').length, 1);
});

test('applied status refresh keeps a later independent voice draft unsaved', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  await f.change('-default-voice', 'serena'); await f.click('保存声音设置');
  await f.change('-auto-voice', true, true);
  f.voice.pendingReload = false; f.voice.defaultVoiceId = 'serena';
  await f.refresh();
  assert.equal(f.field('-auto-voice').props.checked, true); assert.equal(f.voice.config.saved.ttsAutoVoice, false);
  assert.equal(f.button('保存声音设置').props.disabled, false); assert(f.button('放弃语音草稿'));
  assert.equal(f.calls.filter((call) => call.route === 'voice/config').length, 1);
});

test('preview of a draft voice is explicit and returns controls without changing the saved default or claiming QQ delivery', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.change('-default-voice', 'serena');
  assert.equal(f.nodes().some((node) => node.type === 'audio'), false);
  await f.click('试听这个声音');
  assert.deepEqual(f.calls.filter((call) => call.method === 'POST'), [{ route: 'voice/test', method: 'POST', payload: { voiceId: 'serena' } }]);
  assert.equal(f.voice.config.saved.ttsVoice, 'vivian');
  const audio = f.nodes().find((node) => node.type === 'audio'); assert(audio); assert.equal(audio.props.controls, true);
  assert.equal(audio.props.preload, 'none'); assert.equal(audio.props.autoPlay, undefined); assert.equal(audio.props.autoplay, undefined);
  assert.equal(audio.props.src, 'data:audio/mpeg;base64,' + sampleAudio);
  assert.equal(f.text().includes('已发送'), false); assert.ok(f.text().includes('点击下方播放按钮试听'));
  await f.active(false); assert.ok(f.pauses > 0); await f.active(true);
  await f.change('-default-voice', 'vivian'); assert.equal(f.nodes().some((node) => node.type === 'audio'), false);
});

test('preview cannot bypass a changed connection or pending reload through a stale click handler', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); const stale = f.button('试听这个声音').props.onClick;
  await f.expand(); await f.change('-ttsModel', 'another-model'); stale(); await f.flush();
  assert.equal(f.calls.some((call) => call.route === 'voice/test'), false); assert.equal(f.button('试听这个声音').props.disabled, true);
  await f.click('放弃语音草稿'); f.voice.pendingReload = true; await f.click('检查'); stale(); await f.flush();
  assert.equal(f.calls.some((call) => call.route === 'voice/test'), false);
});

test('voice preview serializes double clicks and never repeats a failed operation', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush();
  let release; f.setGate(new Promise((resolve) => { release = resolve; })); f.setPreview({ ok: false, generated: false, note: '服务暂时不可用' });
  const run = f.button('试听这个声音').props.onClick; run(); run(); await f.flush();
  assert.equal(f.calls.filter((call) => call.route === 'voice/test').length, 1);
  assert.equal(f.button('生成试听中…').props.disabled, true); release(); await f.flush();
  assert.ok(f.text().includes('服务暂时不可用')); assert.equal(f.nodes().some((node) => node.type === 'audio'), false);
  assert.equal(f.calls.filter((call) => call.route === 'voice/test').length, 1);
});

test('a hidden voice panel rejects stale preview clicks and ignores a late generated preview', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); const stale = f.button('试听这个声音').props.onClick;
  await f.active(false); stale(); await f.flush(); assert.equal(f.calls.some((call) => call.method === 'POST'), false);
  await f.active(true); let release; f.setGate(new Promise((resolve) => { release = resolve; }));
  f.button('试听这个声音').props.onClick(); await f.flush(); await f.active(false); release(); await f.flush();
  assert.equal(f.nodes().some((node) => node.type === 'audio'), false);
});

for (const [label, patch] of [
  ['unexpected delivery', { delivered: true }], ['wrong voice', { voiceId: 'wrong' }], ['unsafe audio URL', { audio: { mime: 'audio/mpeg', base64: 'https://example.com/track.mp3' } }],
  ['missing file', { audio: null }], ['invalid base64', { audio: { mime: 'audio/mpeg', base64: '!!!!' } }], ['wrong MIME', { audio: { mime: 'text/html', base64: sampleAudio } }],
]) test('voice preview rejects ' + label, async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.setPreview(patch); await f.flush(); await f.click('试听这个声音');
  assert.equal(f.nodes().some((node) => node.type === 'audio'), false); assert.ok(f.text().includes('没有返回有效的声音文件'));
});

test('remote preview costs are direct and managed fields remain effective and read only', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.voice.config.saved.ttsBaseURL = 'https://speech.example.test/v1';
  f.voice.config.overriddenFields = ['ttsVoice', 'ttsAutoVoice']; f.voice.config.effective.ttsAutoVoice = true;
  await f.flush(); assert.ok(f.text().includes('可能产生费用'));
  assert.equal(f.field('-default-voice').props.disabled, true); assert.equal(f.field('-auto-voice').props.checked, true);
  f.field('-default-voice').props.onChange({ target: { value: 'serena' } }); await f.flush();
  assert.equal(f.field('-default-voice').props.value, 'vivian'); assert.equal(f.button('保存声音设置').props.disabled, true);
});

test('refresh preserves voice drafts and requires adopting a new revision before save', async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.flush(); await f.change('-default-voice', 'serena');
  f.voice.config.revision = 'voice-new'; await f.click('检查');
  assert.equal(f.field('-default-voice').props.value, 'serena'); assert.equal(f.button('保存声音设置').props.disabled, true);
  await f.click('采用最新版本，保留语音草稿'); await f.click('保存声音设置');
  assert.equal(f.calls.find((call) => call.route === 'voice/config').payload.revision, 'voice-new');
});

test('speech file selection stays local until explicit recognition and renders text without treating it as markup', async (t) => {
  const f = fixture({ speech: true }); t.after(() => f.dispose()); await f.flush();
  assert.deepEqual(f.calls, [{ route: 'model/status', method: 'GET', payload: undefined }]);
  await f.choose(); assert.equal(f.calls.some((call) => call.method === 'POST'), false);
  f.setSpeech({ text: '<script>do not execute</script> 你好' }); await f.click('开始识别测试');
  assert.deepEqual(f.calls.filter((call) => call.method === 'POST'), [{ route: 'speech/test', method: 'POST', payload: {
    fileName: 'test.mp3', audio: { mime: 'audio/mpeg', base64: sampleAudio },
  } }]);
  assert.ok(f.text().includes('<script>do not execute</script> 你好')); assert.equal(f.nodes().some((node) => node.type === 'script' || node.props.dangerouslySetInnerHTML), false);
});

for (const [label, file] of [
  ['oversize', { name: 'large.mp3', type: 'audio/mpeg', size: 5 * 1024 * 1024 + 1 }], ['empty', { name: 'empty.wav', type: 'audio/wav', size: 0 }],
  ['non audio', { name: 'notes.txt', type: 'text/plain', size: 10 }], ['unknown', { name: 'file.bin', type: '', size: 10 }],
]) test('speech rejects ' + label + ' before reading or transmitting it', async (t) => {
  const f = fixture({ speech: true }); t.after(() => f.dispose()); await f.flush(); await f.choose(file);
  assert.equal(f.readers.length, 0); assert.equal(f.calls.some((call) => call.method === 'POST'), false); assert.equal(f.button('开始识别测试').props.disabled, true);
  assert.ok(f.nodes().some((node) => node.props.role === 'alert'));
});

test('speech infers a recognized extension and cannot test a draft service via a stale handler', async (t) => {
  const f = fixture({ speech: true }); t.after(() => f.dispose()); await f.flush(); await f.choose({ name: 'sample.m4a', type: '', size: 22 });
  const stale = f.button('开始识别测试').props.onClick;
  const language = f.nodes().find((node) => node.type === 'select' && node.props.value === 'zh');
  language.props.onChange({ target: { value: 'en' } }); await f.flush(); stale(); await f.flush();
  assert.equal(f.calls.some((call) => call.route === 'speech/test'), false);
  await f.click('放弃识别选择'); await f.click('开始识别测试');
  assert.equal(f.calls.find((call) => call.route === 'speech/test').payload.audio.mime, 'audio/mp4');
});

test('speech serializes test clicks, reports no recognition, and never retries or contacts QQ/chat', async (t) => {
  const f = fixture({ speech: true }); t.after(() => f.dispose()); await f.flush(); await f.choose();
  let release; f.setGate(new Promise((resolve) => { release = resolve; })); f.setSpeech({ ok: false, text: '', note: '没有听清人声' });
  const run = f.button('开始识别测试').props.onClick; run(); run(); await f.flush();
  assert.equal(f.calls.filter((call) => call.route === 'speech/test').length, 1); release(); await f.flush();
  assert.ok(f.text().includes('没有听清人声')); assert.equal(f.text().includes('识别结果'), false);
  assert.deepEqual(f.calls.map((call) => call.route), ['model/status', 'speech/test']);
});

for (const state of ['disabled', 'unprepared', 'preparing']) test('speech test refuses ' + state + ' service through its handler too', async (t) => {
  const f = fixture({ speech: true }); t.after(() => f.dispose());
  if (state === 'disabled') f.speech.available = false;
  else f.speech.providers[0].preparation.phase = state === 'preparing' ? 'downloading' : 'unprepared';
  await f.flush(); await f.choose(); assert.equal(f.button('开始识别测试').props.disabled, true);
  f.button('开始识别测试').props.onClick(); await f.flush(); assert.equal(f.calls.some((call) => call.method === 'POST'), false);
});

test('speech cancels file reading on hide and ignores a late read or recognition result', async (t) => {
  const f = fixture({ speech: true }); t.after(() => f.dispose()); await f.flush(); f.deferFile(true); await f.choose();
  const reader = f.readers[0]; await f.active(false); assert.equal(reader.aborted, true); reader.finish(); await f.flush();
  assert.equal(f.text().includes('已选择：'), false); assert.equal(f.calls.some((call) => call.method === 'POST'), false);
  f.deferFile(false); await f.active(true); await f.choose();
  let release; f.setGate(new Promise((resolve) => { release = resolve; })); f.button('开始识别测试').props.onClick(); await f.flush();
  await f.active(false); release(); await f.flush(); assert.equal(f.text().includes('听见了清晰的人声'), false);
});

test('a failed speech file read clears the previous selection and cannot send stale audio', async (t) => {
  const f = fixture({ speech: true }); t.after(() => f.dispose()); await f.flush(); await f.choose();
  f.failFile(true); await f.choose({ name: 'broken.mp3', type: 'audio/mpeg', size: 22 });
  assert.ok(f.text().includes('读取失败')); assert.equal(f.button('开始识别测试').props.disabled, true);
  f.button('开始识别测试').props.onClick(); await f.flush(); assert.equal(f.calls.some((call) => call.method === 'POST'), false);
});
