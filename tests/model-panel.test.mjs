import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelPanel, ModelPanelError } from '../packages/dsh-dafeiyu/src/model-panel.js';

const PRIVATE = 'MODEL_PANEL_PRIVATE_CANARY';
function fixture() {
  const state = { busy: false, revision: 7, values: { providers: { minimax: {
    api: 'anthropic-messages', baseURL: 'https://api.example.com/anthropic', apiKeyEnv: 'MINIMAX_API_KEY',
    models: [{ id: 'real-model' }], headers: { Authorization: PRIVATE },
  } } }, records: new Map([['MINIMAX_API_KEY', PRIVATE]]), calls: [], mutateError: null };
  // Actual Schemastery wire graph, including a dict whose key is a provider id.
  const schema = { uid: 1, refs: {
    1: { type: 'object', dict: { providers: 2 } }, 2: { type: 'dict', inner: 3 },
    3: { type: 'object', dict: { api: 4, baseURL: 8, apiKeyEnv: 8, models: 9 } },
    4: { type: 'union', list: [5, 6, 7] },
    5: { type: 'const', value: 'openai-completions' }, 6: { type: 'const', value: 'openai-responses' },
    7: { type: 'const', value: 'anthropic-messages' }, 8: { type: 'string' }, 9: { type: 'array' },
  } };
  const services = {
    llm: { listConfigurableProviders: () => [{ provider: 'minimax', displayName: 'MiniMax', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'minimax'],
      defaultBaseURL: 'https://default.example.com/v1', nativeAuth: { env: ['MINIMAX_API_KEY'] } }] },
    settings: { writable: true, describe(options) {
      assert.deepEqual(options, { redactSecrets: true });
      return [{ ns: 'llm-pi-ai', revision: state.revision, value: structuredClone(state.values), schema }];
    }, async mutate(ns, ops, revision) {
      state.calls.push({ type: 'mutate', ns, ops, revision });
      if (revision !== state.revision) throw Object.assign(new Error(PRIVATE), { code: 'SETTINGS_CONFLICT' });
      if (state.mutateError) throw state.mutateError;
      for (const op of ops) {
        assert.equal(op.op, 'set');
        const parent = op.path.slice(0, -1).reduce((node, key) => node[key] ||= {}, state.values);
        parent[op.path.at(-1)] = op.value;
      }
      state.revision++;
    } },
    credentials: { async describe(ref) { state.calls.push({ type: 'describe', ref }); return { configured: state.records.has(ref), writable: true, source: 'stored', value: PRIVATE }; },
      async set(ref, value) { state.calls.push({ type: 'set', ref }); state.records.set(ref, value); },
      async unset(ref) { state.calls.push({ type: 'unset', ref }); state.records.delete(ref); },
      resolve() { throw new Error('read credential must not be called'); } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'minimax', model: 'real-model' }) },
    speechToText: { snapshot: () => ({ providers: [{ id: 'sensevoice', name: 'SenseVoice', languages: ['auto', 'zh', 'en'],
      downloadSources: ['https://models.example.com', 'https://bad.example.com/?token=' + PRIVATE],
      preparation: { phase: 'downloading', resource: '/private/' + PRIVATE, completedBytes: 100, totalBytes: 200,
        steps: [{ kind: 'model', status: 'running' }], error: PRIVATE } }], selection: { providerId: 'sensevoice', language: 'auto' } }),
      prepare(id, options) { state.calls.push({ type: 'prepare', id, options }); },
      transcribe() { throw new Error('must not record or transcribe'); } },
  };
  const panel = new ModelPanel({ getService: (name) => services[name], getBusy: () => state.busy });
  return { state, services, panel };
}
const rejected = (code) => (error) => {
  assert.ok(error instanceof ModelPanelError);
  assert.equal(error.code, code);
  assert.equal(error.message.includes(PRIVATE), false);
  return true;
};

test('real host settings and speech snapshots are projected without secret reads, paths, or callbacks', async () => {
  const { panel, state } = fixture();
  const result = await panel.snapshot();
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(JSON.stringify(result).includes('/private/'), false);
  assert.deepEqual(result.currentSelection, { provider: 'minimax', model: 'real-model' });
  assert.deepEqual(result.providers[0].protocolChoices, ['openai-completions', 'openai-responses', 'anthropic-messages']);
  assert.equal(result.providers[0].baseURL, 'https://api.example.com/anthropic');
  assert.equal(result.providers[0].credential.configured, true);
  assert.equal(result.providers[0].editableFields.apiKey, true);
  assert.deepEqual(result.speech.providers[0].downloadSources, ['https://models.example.com']);
  assert.deepEqual(result.speech.providers[0].preparation, { phase: 'downloading', completedBytes: 100, totalBytes: 200,
    steps: [{ kind: 'model', status: 'running' }] });
  assert.equal(Object.hasOwn(result, 'tts'), false);
  assert.equal(state.calls.some((call) => call.type !== 'describe'), false);
});

test('missing or broken host services fail closed and never claim a working model or recognizer', async () => {
  for (const getService of [() => undefined, () => { throw new Error(PRIVATE); }]) {
    const result = await new ModelPanel({ getService }).snapshot();
    assert.equal(result.available, false);
    assert.equal(result.writable, false);
    assert.deepEqual(result.providers, []);
    assert.equal(result.speech.available, false);
    assert.equal(result.currentSelection, null);
  }
});

test('save stages a fresh key then uses native settings CAS with minimal fields and keeps other config', async () => {
  const { panel, state } = fixture();
  const result = await panel.save({ provider: 'minimax', revision: 7, patch: { apiKey: 'new-secret', baseURL: 'https://new.example.com/v1', protocol: 'openai-completions' } });
  const active = state.values.providers.minimax;
  assert.match(active.apiKeyEnv, /^DAFEIYU_MINIMAX_[a-f0-9]+_API_KEY$/);
  assert.equal(state.records.get(active.apiKeyEnv), 'new-secret');
  assert.equal(state.records.get('MINIMAX_API_KEY'), PRIVATE);
  assert.equal(active.headers.Authorization, PRIVATE);
  assert.equal(result.providers[0].revision, 8);
  assert.equal(result.providers[0].protocol, 'openai-completions');
  assert.deepEqual(state.calls.filter((call) => ['set', 'mutate'].includes(call.type)).map((call) => call.type), ['set', 'mutate']);
  assert.equal(JSON.stringify(result).includes('new-secret'), false);
  const mutation = state.calls.find((call) => call.type === 'mutate');
  assert.equal(mutation.ns, 'llm-pi-ai');
  assert.equal(mutation.revision, 7);
  assert.equal(mutation.ops.length, 3);
});

test('blank key preserves credential and a stale revision cannot change keys or URLs', async () => {
  const { panel, state } = fixture();
  await panel.save({ provider: 'minimax', revision: 7, patch: { apiKey: '' } });
  assert.equal(state.calls.some((call) => call.type === 'set' || call.type === 'mutate'), false);
  await assert.rejects(panel.save({ provider: 'minimax', revision: 6, patch: { apiKey: 'new-secret', baseURL: 'https://new.example.com' } }), rejected('CONFLICT'));
  assert.equal(state.records.size, 1);
  assert.equal(state.values.providers.minimax.apiKeyEnv, 'MINIMAX_API_KEY');
});

test('CAS conflict after staging deletes only the new reference and never overwrites the original key', async () => {
  const { panel, state, services } = fixture();
  const originalSet = services.credentials.set;
  services.credentials.set = async (...args) => { await originalSet(...args); state.revision++; };
  await assert.rejects(panel.save({ provider: 'minimax', revision: 7, patch: { apiKey: 'new-secret' } }), rejected('CONFLICT'));
  assert.equal(state.records.size, 1);
  assert.equal(state.records.get('MINIMAX_API_KEY'), PRIVATE);
  assert.equal(state.calls.filter((call) => call.type === 'unset').length, 1);
  assert.notEqual(state.calls.find((call) => call.type === 'unset').ref, 'MINIMAX_API_KEY');
});

test('failure after a native write committed preserves the newly active credential and reports failure', async () => {
  const { panel, state, services } = fixture();
  const mutate = services.settings.mutate;
  services.settings.mutate = async (...args) => { await mutate(...args); throw new Error(PRIVATE); };
  await assert.rejects(panel.save({ provider: 'minimax', revision: 7, patch: { apiKey: 'new-secret' } }), rejected('SAVE_FAILED'));
  assert.equal(state.records.get(state.values.providers.minimax.apiKeyEnv), 'new-secret');
  assert.equal(state.calls.some((call) => call.type === 'unset'), false);
});

test('owner revocation or busy transition during credential staging cannot apply model edits', async () => {
  for (const revoke of [true, false]) {
    const { panel, state, services } = fixture();
    let authorized = true;
    const set = services.credentials.set;
    services.credentials.set = async (...args) => { await set(...args); if (revoke) authorized = false; else state.busy = true; };
    await assert.rejects(panel.save({ provider: 'minimax', revision: 7, patch: { apiKey: 'new-secret' } }, { authorize: () => authorized }), rejected(revoke ? 'FORBIDDEN' : 'BUSY'));
    assert.equal(state.records.size, 1);
    assert.equal(state.calls.some((call) => call.type === 'mutate'), false);
  }
});

test('unrecognized fields, paths, protocols, URLs and key whitespace reject before writes', async () => {
  const { panel, state } = fixture();
  for (const patch of [{ baseURL: 'https://u:p@example.com/' }, { baseURL: 'https://example.com/?key=secret' },
    { baseURL: 'http://example.com/' }, { baseURL: 'javascript:alert(1)' }, { protocol: 'invented-protocol' },
    { apiKey: '  ' }, { apiKey: 'secret\nvalue' }, { headers: { Authorization: PRIVATE } }, {}]) {
    await assert.rejects(panel.save({ provider: 'minimax', revision: 7, patch }), rejected('INVALID_PATCH'));
  }
  assert.equal(state.calls.some((call) => ['set', 'mutate'].includes(call.type)), false);
  await assert.rejects(panel.save({ provider: 'other', revision: 7, patch: { apiKey: 'abc' } }), rejected('UNAVAILABLE'));
  await assert.rejects(panel.save({ provider: 'minimax', revision: 7, patch: { apiKey: 'abc' }, ns: 'arbitrary' }), rejected('INVALID_PATCH'));
});

test('native speech preparation uses advertised provider and source without recording', async () => {
  const { panel, state } = fixture();
  await panel.prepareSpeech({ providerId: 'sensevoice', downloadSource: 'https://models.example.com' });
  assert.deepEqual(state.calls.find((call) => call.type === 'prepare'), { type: 'prepare', id: 'sensevoice', options: { downloadSource: 'https://models.example.com' } });
  await assert.rejects(panel.prepareSpeech({ providerId: 'other' }), rejected('UNAVAILABLE'));
  await assert.rejects(panel.prepareSpeech({ providerId: 'sensevoice', downloadSource: 'https://arbitrary.example.com' }), rejected('INVALID_PATCH'));
  await assert.rejects(panel.prepareSpeech({ providerId: 'sensevoice', command: 'arbitrary' }), rejected('INVALID_PATCH'));
});

test('asynchronous provider preparation has bounded request lifetime and safe job failure', async () => {
  const { panel, services } = fixture();
  let reject;
  services.speechToText.prepare = () => new Promise((_resolve, fail) => { reject = fail; });
  const result = await panel.prepareSpeech({ providerId: 'sensevoice' });
  assert.equal(result.speech.job.state, 'running');
  await assert.rejects(panel.prepareSpeech({ providerId: 'sensevoice' }), rejected('BUSY'));
  reject(new Error(PRIVATE));
  await new Promise((resolve) => setImmediate(resolve));
  const after = await panel.snapshot();
  assert.equal(after.speech.job.state, 'failed');
  assert.equal(JSON.stringify(after).includes(PRIVATE), false);
});

test('credential provider refusal cannot echo keys and prevents settings writes', async () => {
  const { panel, services, state } = fixture();
  services.credentials.set = async () => { throw new Error(PRIVATE); };
  await assert.rejects(panel.save({ provider: 'minimax', revision: 7, patch: { apiKey: 'new-secret' } }), rejected('SAVE_FAILED'));
  assert.equal(state.calls.some((call) => call.type === 'mutate'), false);
});

test('explicit API probe uses native discovery only and returns a sanitized count', async () => {
  const { panel, services, state } = fixture();
  services.llm.discoverModels = async (ns, request, signal) => {
    state.calls.push({ type: 'probe', ns, request, signal });
    return [{ id: PRIVATE }, { id: 'other-private-model' }];
  };
  const before = await panel.snapshot();
  assert.equal(state.calls.some((call) => call.type === 'probe'), false);
  assert.equal(Object.hasOwn(before.providers[0], 'lastProbe'), false);
  const result = await panel.probe({ provider: 'minimax' });
  assert.equal(result.ok, true);
  assert.equal(result.probe.ok, true);
  assert.equal(result.probe.modelCount, 2);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  const call = state.calls.find((row) => row.type === 'probe');
  assert.equal(call.ns, 'llm-pi-ai');
  assert.deepEqual(call.request, { provider: 'minimax' });
  assert.equal(call.signal.aborted, true);
  assert.deepEqual((await panel.snapshot()).providers[0].lastProbe, result.probe);
});

test('API probe reports unsupported, rejected, and timed-out outcomes without raw errors', async () => {
  const { panel, services } = fixture();
  assert.equal((await panel.probe({ provider: 'minimax' })).probe.supported, false);
  services.llm.discoverModels = () => { throw Object.assign(new Error(PRIVATE), { code: 'NO_DISCOVERY' }); };
  assert.equal((await panel.probe({ provider: 'minimax' })).probe.supported, false);
  services.llm.discoverModels = () => { throw new Error(PRIVATE); };
  const failed = await panel.probe({ provider: 'minimax' });
  assert.equal(failed.probe.ok, false);
  assert.equal(failed.probe.supported, null);
  assert.equal(JSON.stringify(failed).includes(PRIVATE), false);
  let signal;
  panel.probeTimeoutMs = 5;
  services.llm.discoverModels = (_ns, _request, received) => { signal = received; return new Promise(() => {}); };
  const timeout = await panel.probe({ provider: 'minimax' });
  assert.equal(timeout.probe.ok, false);
  assert.match(timeout.probe.note, /超时/);
  assert.equal(signal.aborted, true);
});

test('API probe refuses arbitrary routes and authorization loss before discovery', async () => {
  const { panel, services, state } = fixture();
  services.llm.discoverModels = async () => { state.calls.push({ type: 'probe' }); return []; };
  await assert.rejects(panel.probe({ provider: 'unknown' }), rejected('UNAVAILABLE'));
  await assert.rejects(panel.probe({ provider: 'minimax', baseURL: 'https://arbitrary.example' }), rejected('INVALID_PATCH'));
  await assert.rejects(panel.probe({ provider: 'minimax' }, { authorize: () => false }), rejected('FORBIDDEN'));
  assert.equal(state.calls.some((call) => call.type === 'probe'), false);
});

test('empty native catalogs remain unverified and changed settings invalidate old probe results', async () => {
  const { panel, services, state } = fixture();
  services.llm.discoverModels = async () => [];
  assert.equal((await panel.probe({ provider: 'minimax' })).probe.ok, false);
  services.llm.discoverModels = async () => [{ id: 'known' }];
  await panel.probe({ provider: 'minimax' });
  state.revision++;
  assert.equal(Object.hasOwn((await panel.snapshot()).providers[0], 'lastProbe'), false);
  await panel.probe({ provider: 'minimax' });
  await panel.save({ provider: 'minimax', revision: state.revision, patch: { baseURL: 'https://new.example.com' } });
  assert.equal(Object.hasOwn((await panel.snapshot()).providers[0], 'lastProbe'), false);
});

function selectionFixture() {
  const base = fixture();
  const { state, services } = base;
  state.defaultModel = { provider: 'minimax', model: 'real-model', reasoningEffort: 'high' };
  state.defaultRevision = 14;
  state.speechSelection = { defaultProvider: 'sensevoice', language: 'auto' };
  state.speechRevision = 19;
  state.modelCatalogCalls = [];
  const originalDescribe = services.settings.describe;
  const originalMutate = services.settings.mutate;
  const originalSpeechSnapshot = services.speechToText.snapshot;
  services.agentDefaultModel = { ownerContext: { fiber: { entry: { options: { id: 'actual-native-default-72' } } } },
    currentSelection: () => ({ ...state.defaultModel }), saveSelection() { throw new Error('must use native settings CAS'); } };
  services.speechToText.entryId = 'actual-native-speech-83';
  services.speechToText.snapshot = () => ({ ...originalSpeechSnapshot(), selection: {
    providerId: state.speechSelection.defaultProvider, language: state.speechSelection.language }, providers: [
    ...originalSpeechSnapshot().providers, { id: 'alternate-recognizer', name: 'Installed recognizer', languages: ['en'], preparation: { phase: 'ready' } },
  ] });
  const schema = (fields) => ({ uid: 1, refs: { 1: { type: 'object', dict: Object.fromEntries(fields.map((key) => [key, 2])) }, 2: { type: 'string' } } });
  services.settings.describe = (options) => [...originalDescribe(options),
    { ns: 'actual-native-default-72', revision: state.defaultRevision, value: { ...state.defaultModel }, schema: schema(['provider', 'model', 'reasoningEffort']) },
    { ns: 'actual-native-speech-83', revision: state.speechRevision, value: { ...state.speechSelection }, schema: schema(['defaultProvider', 'language']) },
  ];
  services.settings.mutate = async (ns, ops, revision) => {
    if (!['actual-native-default-72', 'actual-native-speech-83'].includes(ns)) return originalMutate(ns, ops, revision);
    state.calls.push({ type: 'selection-mutate', ns, ops, revision });
    const model = ns === 'actual-native-default-72';
    const currentRevision = model ? state.defaultRevision : state.speechRevision;
    if (revision !== currentRevision) throw Object.assign(new Error(PRIVATE), { code: 'SETTINGS_CONFLICT' });
    const target = model ? state.defaultModel : state.speechSelection;
    for (const op of ops) { if (op.op === 'set') target[op.path[0]] = op.value; else delete target[op.path[0]]; }
    if (model) state.defaultRevision++; else state.speechRevision++;
  };
  services.llm.listProviders = () => [{ id: 'minimax', name: 'MiniMax' }];
  services.llm.listModels = async (provider) => { state.modelCatalogCalls.push(provider); return ['real-model', 'actual-host-model-2'].map((id) => ({ provider, id, name: id })); };
  return base;
}

test('host model selection uses the owning native entry and CAS after validating the live catalog', async () => {
  const { panel, state } = selectionFixture();
  assert.equal((await panel.snapshot()).selectionEditable, true);
  const expected = { ...state.defaultModel };
  const result = await panel.saveSelection({ provider: 'minimax', model: 'actual-host-model-2', expectedSelection: expected });
  assert.deepEqual(result.currentSelection, { provider: 'minimax', model: 'actual-host-model-2' });
  const mutation = state.calls.find((call) => call.type === 'selection-mutate');
  assert.equal(mutation.ns, 'actual-native-default-72');
  assert.equal(mutation.revision, 14);
  assert.deepEqual(mutation.ops.map((op) => op.path), [['provider'], ['model'], ['reasoningEffort']]);
  assert.equal(state.modelCatalogCalls.includes('minimax'), true);
});

test('default model edits refuse stale selections, unknown models, dormant providers and missing native ownership', async () => {
  const { panel, state, services } = selectionFixture();
  const expected = { ...state.defaultModel };
  await assert.rejects(panel.saveSelection({ provider: 'minimax', model: 'actual-host-model-2', expectedSelection: { provider: 'minimax', model: 'old' } }), rejected('CONFLICT'));
  await assert.rejects(panel.saveSelection({ provider: 'minimax', model: 'invented-model', expectedSelection: expected }), rejected('INVALID_PATCH'));
  await assert.rejects(panel.saveSelection({ provider: 'dormant', model: 'real-model', expectedSelection: expected }), rejected('INVALID_PATCH'));
  delete services.agentDefaultModel.ownerContext;
  assert.equal((await panel.snapshot()).selectionEditable, false);
  await assert.rejects(panel.saveSelection({ provider: 'minimax', model: 'actual-host-model-2', expectedSelection: expected }), rejected('UNAVAILABLE'));
  assert.equal(state.calls.some((call) => call.type === 'selection-mutate'), false);
});

test('authorization or model selection changes during catalog lookup prevent writes', async () => {
  for (const change of ['authority', 'selection']) {
    const { panel, state, services } = selectionFixture();
    const expected = { ...state.defaultModel };
    let authorized = true;
    services.llm.listModels = async (provider) => {
      if (change === 'authority') authorized = false; else state.defaultModel.model = 'externally-changed';
      return [{ provider, id: 'actual-host-model-2', name: 'Actual' }];
    };
    await assert.rejects(panel.saveSelection({ provider: 'minimax', model: 'actual-host-model-2', expectedSelection: expected }, { authorize: () => authorized }), rejected(change === 'authority' ? 'FORBIDDEN' : 'CONFLICT'));
    assert.equal(state.calls.some((call) => call.type === 'selection-mutate'), false);
  }
});

test('native selection CAS conflicts are reported without leaking host errors', async () => {
  const { panel, state, services } = selectionFixture();
  services.settings.mutate = async () => { throw Object.assign(new Error(PRIVATE), { code: 'SETTINGS_CONFLICT' }); };
  await assert.rejects(panel.saveSelection({ provider: 'minimax', model: 'actual-host-model-2', expectedSelection: { ...state.defaultModel } }), rejected('CONFLICT'));
  await assert.rejects(panel.saveSpeechSelection({ providerId: 'alternate-recognizer', language: 'en', expectedSelection: { providerId: 'sensevoice', language: 'auto' } }), rejected('CONFLICT'));
});

test('selecting an installed recognizer persists actual host routing and language without preparation or recording', async () => {
  const { panel, state } = selectionFixture();
  assert.equal(panel.speechSnapshot().selectionEditable, true);
  const result = await panel.saveSpeechSelection({ providerId: 'alternate-recognizer', language: 'en', expectedSelection: { providerId: 'sensevoice', language: 'auto' } });
  assert.deepEqual(result.speech.selection, { providerId: 'alternate-recognizer', language: 'en' });
  const mutation = state.calls.find((call) => call.type === 'selection-mutate');
  assert.equal(mutation.ns, 'actual-native-speech-83');
  assert.equal(mutation.revision, 19);
  assert.equal(state.calls.some((call) => call.type === 'prepare'), false);
});

test('recognizer routing edits refuse unsupported languages, stale views and arbitrary fields', async () => {
  const { panel, state } = selectionFixture();
  const expectedSelection = { providerId: 'sensevoice', language: 'auto' };
  for (const body of [{ providerId: 'alternate-recognizer', language: 'zh', expectedSelection },
    { providerId: 'invented', language: 'en', expectedSelection },
    { providerId: 'alternate-recognizer', language: 'en', expectedSelection, ns: 'arbitrary' }]) {
    await assert.rejects(panel.saveSpeechSelection(body), rejected('INVALID_PATCH'));
  }
  await assert.rejects(panel.saveSpeechSelection({ providerId: 'alternate-recognizer', language: 'en', expectedSelection: { providerId: 'old', language: 'auto' } }), rejected('CONFLICT'));
  assert.equal(state.calls.some((call) => call.type === 'selection-mutate'), false);
});

test('visible model ids come from the installed adapter catalog and are cached without paid calls', async () => {
  const { panel, state } = selectionFixture();
  assert.deepEqual((await panel.snapshot()).providers[0].modelIds, ['real-model', 'actual-host-model-2']);
  await panel.snapshot();
  assert.deepEqual(state.modelCatalogCalls, ['minimax']);
});

function connectionFixture() {
  const base = selectionFixture();
  const { state, services } = base;
  state.preparations = []; state.dispatches = [];
  services.llm.prepareCall = async (input, signal, configure) => {
    state.preparations.push({ input, signal });
    const chosen = configure({ maxTokens: input.maxTokens }, { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } });
    return { config: { ...input, ...chosen }, stream(options) {
      state.dispatches.push(options);
      return { async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', index: 0, text: PRIVATE };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    } };
  };
  return base;
}

test('explicit actual API test uses one prepared native request with fixed input, no history/tools, and a 16-token cap', async () => {
  const { panel, state } = connectionFixture();
  await panel.snapshot();
  assert.equal(state.preparations.length, 0);
  const result = await panel.testConnection({ provider: 'minimax', model: 'real-model' });
  assert.equal(result.ok, true);
  assert.equal(result.test.ok, true);
  assert.ok(result.test.latencyMs >= 0);
  assert.equal(state.preparations.length, 1);
  assert.equal(state.dispatches.length, 1);
  assert.deepEqual(state.preparations[0].input, { provider: 'minimax', model: 'real-model', maxTokens: 16 });
  const options = state.dispatches[0];
  assert.equal(options.maxTokens, 16);
  assert.equal(options.reasoningEffort, 'off');
  assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }]);
  assert.deepEqual(options.tools, []);
  assert.equal(Object.hasOwn(options, 'sessionId'), false);
  assert.equal(Object.hasOwn(options, 'system'), false);
  assert.equal(options.signal.aborted, true);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.deepEqual((await panel.snapshot()).providers[0].lastTest, result.test);
});

test('actual API tests refuse unregistered routes and arbitrary inputs before a model request', async () => {
  const { panel, state } = connectionFixture();
  await assert.rejects(panel.testConnection({ provider: 'other', model: 'real-model' }), rejected('UNAVAILABLE'));
  await assert.rejects(panel.testConnection({ provider: 'minimax', model: 'real-model', messages: [{ content: PRIVATE }] }), rejected('INVALID_PATCH'));
  await assert.rejects(panel.testConnection({ provider: 'minimax', model: 'real-model' }, { authorize: () => false }), rejected('FORBIDDEN'));
  assert.equal(state.preparations.length, 0);
});

test('native request failures, error finishes, empty streams and missing finish chunks cannot count as a usable API', async () => {
  for (const events of [[], [{ type: 'finish', reason: { kind: 'stop' } }], [{ type: 'text-delta', text: 'OK' }],
    [{ type: 'text-delta', text: 'OK' }, { type: 'finish', reason: { kind: 'error', failure: { message: PRIVATE } } }]]) {
    const { panel, state, services } = connectionFixture();
    services.llm.prepareCall = async (input) => ({ config: input, stream: () => ({ async *[Symbol.asyncIterator]() { for (const event of events) yield event; } }) });
    const result = await panel.testConnection({ provider: 'minimax', model: 'real-model' });
    assert.equal(result.test.ok, false);
    assert.equal(JSON.stringify(result).includes(PRIVATE), false);
    assert.equal(state.dispatches.length, 0);
  }
  const { panel, services } = connectionFixture();
  services.llm.prepareCall = async () => { throw new Error(PRIVATE); };
  const failed = await panel.testConnection({ provider: 'minimax', model: 'invented-model' });
  assert.equal(failed.test.ok, false);
  assert.equal(JSON.stringify(failed).includes(PRIVATE), false);
});

test('timed-out preparation cannot dispatch later and a stalled stream cannot hang the panel', async () => {
  const { panel, state, services } = connectionFixture();
  panel.connectionTimeoutMs = 5;
  const original = services.llm.prepareCall;
  let release;
  services.llm.prepareCall = (...args) => new Promise((resolve) => { release = async () => resolve(await original(...args)); });
  const timeout = await panel.testConnection({ provider: 'minimax', model: 'real-model' });
  assert.equal(timeout.test.ok, false);
  assert.match(timeout.test.note, /超时/);
  await release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.dispatches.length, 0);
  let closed = false;
  services.llm.prepareCall = async (config) => ({ config, stream: () => ({ [Symbol.asyncIterator]() {
    return { next: () => new Promise(() => {}), return: async () => { closed = true; return { done: true }; } };
  } }) });
  assert.equal((await panel.testConnection({ provider: 'minimax', model: 'real-model' })).test.ok, false);
  assert.equal(closed, true);
});

test('authorization loss after preparation prevents paid dispatch and changed configuration invalidates test evidence', async () => {
  const { panel, state, services } = connectionFixture();
  const prepare = services.llm.prepareCall;
  let authorized = true;
  services.llm.prepareCall = async (...args) => { const prepared = await prepare(...args); authorized = false; return prepared; };
  await assert.rejects(panel.testConnection({ provider: 'minimax', model: 'real-model' }, { authorize: () => authorized }), rejected('FORBIDDEN'));
  assert.equal(state.dispatches.length, 0);
  services.llm.prepareCall = async (...args) => {
    const prepared = await prepare(...args);
    return { ...prepared, stream: (options) => {
      state.revision++;
      return prepared.stream(options);
    } };
  };
  const result = await panel.testConnection({ provider: 'minimax', model: 'real-model' });
  assert.equal(result.test.ok, false);
  assert.match(result.test.note, /配置已变化/);
  assert.equal(Object.hasOwn((await panel.snapshot()).providers[0], 'lastTest'), false);
});
