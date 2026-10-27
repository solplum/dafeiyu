/** Owner-facing projections of the real DSH model and speech services. */
import { randomUUID } from 'node:crypto';

const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PHASES = new Set(['unprepared', 'checking', 'downloading', 'loading', 'waking', 'ready', 'standby', 'failed', 'cancelled', 'cancelling']);
const own = (value, key) => value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeString = (value, limit = 256) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
const stringList = (value, limit = 128) => Array.isArray(value) ? value.slice(0, limit).filter((item) => safeString(item) && !BAD_KEYS.has(item)) : [];
const at = (value, path) => path.reduce((node, key) => BAD_KEYS.has(key) ? undefined : own(node, key), value);

export class ModelPanelError extends Error {
  constructor(code, message) { super(message); this.name = 'ModelPanelError'; this.code = code; }
}

// Schemastery serializes a graph as { uid, refs }; never evaluate schema callbacks.
function schemaNode(schema, path) {
  const refs = plain(schema?.refs) ? schema.refs : null;
  const resolve = (value) => refs && (typeof value === 'number' || typeof value === 'string') ? own(refs, value) : value;
  let node = refs ? resolve(schema.uid) : schema;
  for (const key of path) {
    node = resolve(node);
    if (node?.type === 'object') node = own(node.dict, key);
    else if (node?.type === 'dict' || node?.type === 'array') node = node.inner;
    else return undefined;
  }
  return { node: resolve(node), resolve };
}

function choices(schema, path) {
  const found = schemaNode(schema, path);
  if (found?.node?.type !== 'union' || !Array.isArray(found.node.list)) return [];
  return stringList(found.node.list.map((item) => found.resolve(item)?.value));
}

function validUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

function publicUrl(value) { return validUrl(value) ? value : ''; }
function credentialRef(entry, profile) {
  const named = own(profile, 'apiKeyEnv');
  if (typeof named === 'string' && REF.test(named)) return named;
  return `${entry.provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}
function safePreparation(value) {
  const result = { phase: PHASES.has(value?.phase) ? value.phase : 'unknown' };
  for (const key of ['completedBytes', 'totalBytes']) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = value[key];
  // Resource basenames and error causes can contain private paths or signed URLs.
  if (value?.phase === 'failed') result.error = '语音识别资源准备失败，请检查下载来源和磁盘空间后重试';
  if (Array.isArray(value?.steps)) result.steps = value.steps.slice(0, 8).map((step) => ({
    kind: ['check', 'model', 'vad', 'verify', 'load'].includes(step?.kind) ? step.kind : 'unknown',
    status: ['pending', 'running', 'complete', 'failed', 'cancelled'].includes(step?.status) ? step.status : 'unknown',
  }));
  return result;
}
function sourceList(value) {
  // These are public provider-advertised origins, never a caller-supplied URL.
  return stringList(value, 8).filter((item) => {
    try { const u = new URL(item); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; }
    catch { return false; }
  });
}

function sameSelection(actual, expected, keys) {
  return keys.every((key) => actual?.[key] === expected?.[key]);
}

function expectedSelection(value, keys, required) {
  return plain(value) && Object.keys(value).every((key) => keys.includes(key))
    && required.every((key) => safeString(value[key]))
    && Object.values(value).every((item) => safeString(item));
}

export class ModelPanel {
  constructor({ getService = () => undefined, getBusy = () => false, probeTimeoutMs = 15000 } = {}) {
    this.getService = getService;
    this.getBusy = getBusy;
    this.saving = false;
    this.speechJob = null;
    this.probeTimeoutMs = Math.min(15000, Math.max(1, Number(probeTimeoutMs) || 15000));
    this.lastProbes = new Map();
    this.lastProbeRevisions = new Map();
    this.probing = new Set();
    this.modelCatalogCache = new Map();
    this.connectionTesting = false;
    this.connectionTimeoutMs = 15000;
    this.lastTests = new Map();
  }

  service(name) { try { return this.getService(name); } catch { return undefined; } }

  selectionEntry(kind) {
    const service = this.service(kind === 'model' ? 'agentDefaultModel' : 'speechToText');
    // These fields are owned by the actual bundled services. Never guess an ns.
    const ns = kind === 'model' ? service?.ownerContext?.fiber?.entry?.options?.id : service?.entryId;
    const settings = this.service('settings');
    if (!safeString(ns) || settings?.writable !== true || typeof settings.mutate !== 'function') return null;
    let descriptor;
    try { descriptor = settings.describe({ redactSecrets: true }).find((row) => row.ns === ns); } catch { return null; }
    const fields = kind === 'model' ? ['provider', 'model'] : ['defaultProvider', 'language'];
    if (!descriptor || !Number.isSafeInteger(descriptor.revision)
      || !fields.every((field) => schemaNode(descriptor.schema, [field])?.node)) return null;
    return { service, settings, descriptor };
  }

  async modelCatalog(llm, entry, revision, registered) {
    // Account-based DeepSeek may refresh a remote account catalog. Keep that
    // operation explicit; generic pi-ai catalogs are local metadata reads.
    if (!registered.has(entry.provider) || entry.provider === 'deepseek-account' || typeof llm?.listModels !== 'function') return null;
    const cacheKey = `${entry.settingsNs}\n${entry.provider}\n${revision}`;
    const cached = this.modelCatalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return [...cached.ids];
    let timer;
    try {
      const models = await Promise.race([
        Promise.resolve().then(() => llm.listModels(entry.provider)),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error()), 2000); }),
      ]);
      if (!Array.isArray(models)) return null;
      const ids = stringList(models.filter((row) => row?.provider === entry.provider).map((row) => row.id), 512);
      if (this.modelCatalogCache.size >= 128) this.modelCatalogCache.clear();
      this.modelCatalogCache.set(cacheKey, { ids, expiresAt: Date.now() + 30000 });
      return [...ids];
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  describe() {
    const llm = this.service('llm');
    const settings = this.service('settings');
    let descriptors = [], directory = [], selection = null;
    try { descriptors = settings?.describe?.({ redactSecrets: true }) || []; } catch {}
    try { directory = llm?.listConfigurableProviders?.() || []; } catch {}
    try {
      const current = this.service('agentDefaultModel')?.currentSelection?.();
      if (safeString(current?.provider) && safeString(current?.model)) selection = { provider: current.provider, model: current.model,
        ...(safeString(current.reasoningEffort) ? { reasoningEffort: current.reasoningEffort } : {}) };
    } catch {}
    if (!Array.isArray(descriptors)) descriptors = [];
    if (!Array.isArray(directory)) directory = [];
    const entries = directory.slice(0, 128).flatMap((entry) => {
      if (!safeString(entry?.provider) || BAD_KEYS.has(entry.provider) || !safeString(entry.settingsNs)
        || !Array.isArray(entry.settingsPath) || entry.settingsPath.length > 8
        || !entry.settingsPath.every((key) => safeString(key) && !BAD_KEYS.has(key))) return [];
      const namespace = descriptors.find((row) => row.ns === entry.settingsNs);
      const profile = at(namespace?.value, entry.settingsPath);
      const protocolChoices = choices(namespace?.schema, [...entry.settingsPath, 'api']);
      const editableUrl = Boolean(schemaNode(namespace?.schema, [...entry.settingsPath, 'baseURL'])?.node);
      const editableKey = Boolean(schemaNode(namespace?.schema, [...entry.settingsPath, 'apiKeyEnv'])?.node);
      return [{ entry, namespace, profile: plain(profile) ? profile : {}, protocolChoices, editableUrl, editableKey }];
    });
    return { llm, settings, entries, selection };
  }

  async snapshot() {
    const { llm, settings, entries, selection } = this.describe();
    const credentials = this.service('credentials');
    let registered = new Set();
    try { registered = new Set((llm?.listProviders?.() || []).map((row) => row?.id).filter((id) => safeString(id))); } catch {}
    const providers = await Promise.all(entries.map(async ({ entry, namespace, profile, protocolChoices, editableUrl, editableKey }) => {
      const refs = own(profile, 'apiKeyEnv') ? [credentialRef(entry, profile)] : [credentialRef(entry, profile), ...stringList(entry.nativeAuth?.env, 8).filter((ref) => REF.test(ref))];
      let configured = false, writable = false, credentialSource = '', credentialKnown = false;
      if (typeof credentials?.describe === 'function') for (const ref of [...new Set(refs)]) {
        try {
          const info = await credentials.describe(ref);
          if (typeof info?.configured !== 'boolean' || typeof info?.writable !== 'boolean') continue;
          credentialKnown = true;
          writable ||= info.writable;
          if (info.configured) {
            configured = true;
            credentialSource = ['stored', 'environment', 'env-file', 'process', 'file', 'profile'].includes(info.source) ? info.source : 'host';
          }
        } catch {}
      }
      const catalog = await this.modelCatalog(llm, entry, namespace?.revision, registered);
      const modelIds = catalog ?? stringList(Array.isArray(profile.models) ? profile.models.map((row) => row?.id) : []);
      if (selection?.provider === entry.provider && !modelIds.includes(selection.model)) modelIds.push(selection.model);
      return { provider: entry.provider, name: safeString(entry.displayName) || entry.provider,
        settingsNs: entry.settingsNs, revision: Number.isSafeInteger(namespace?.revision) ? namespace.revision : null,
        baseURL: publicUrl(profile.baseURL) || publicUrl(entry.defaultBaseURL),
        protocol: safeString(profile.api) || safeString(entry.defaultApi), protocolChoices, modelIds,
        credential: { configured, writable, known: credentialKnown, ...(credentialSource ? { source: credentialSource } : {}) },
        editable: Boolean(namespace && settings?.writable === true && typeof settings.mutate === 'function' && (editableUrl || editableKey)),
        editableFields: { baseURL: editableUrl, protocol: protocolChoices.length > 0, apiKey: editableKey && writable },
        configured: plain(at(namespace?.value, entry.settingsPath)) && Object.keys(profile).length > 0,
        ...(this.lastProbes.has(entry.provider) && this.lastProbeRevisions.get(entry.provider) === namespace?.revision
          ? { lastProbe: { ...this.lastProbes.get(entry.provider) } } : {}),
        ...(this.lastTests.has(entry.provider) && this.lastTests.get(entry.provider)?.revision === namespace?.revision
          ? { lastTest: { ...this.lastTests.get(entry.provider).test } } : {}),
        ...(safeString(entry.error) ? { error: '宿主报告此服务商配置不可用，请修正后保存' } : {}),
      };
    }));
    return { ok: true, available: Boolean(llm), writable: settings?.writable === true,
      currentSelection: selection, selectionEditable: Boolean(selection && this.selectionEntry('model')),
      providers, speech: this.speechSnapshot() };
  }

  /** One explicit, tiny real model request using the installed adapter only. */
  async testConnection(body, { authorize } = {}) {
    this.checkWrite(authorize);
    if (!plain(body) || Object.keys(body).some((key) => !['provider', 'model'].includes(key))
      || !safeString(body.provider) || !safeString(body.model)) throw new ModelPanelError('INVALID_PATCH', '实际 API 测试请求无效');
    if (this.connectionTesting || this.saving) throw new ModelPanelError('BUSY', '正在测试或保存模型配置，请稍后再试');
    const { llm, entries } = this.describe();
    const found = entries.find(({ entry }) => entry.provider === body.provider);
    let registered;
    try { registered = llm?.listProviders?.(); } catch {}
    if (!found || !Array.isArray(registered) || !registered.some((row) => row?.id === body.provider)) {
      throw new ModelPanelError('UNAVAILABLE', '此模型服务商尚未在宿主启用');
    }
    const started = Date.now();
    const result = (ok, note) => {
      const test = { provider: body.provider, model: body.model, ok, checkedAt: new Date().toISOString(), latencyMs: Math.max(0, Date.now() - started), note };
      this.lastTests.set(body.provider, { revision: found.namespace?.revision, test });
      return { ok: true, test: { ...test } };
    };
    if (typeof llm.prepareCall !== 'function') return result(false, '宿主缺少原生模型请求准备接口，实际 API 状态尚未验证');
    this.connectionTesting = true;
    const controller = new AbortController();
    let timer, iterator, completed = false;
    try {
      const request = (async () => {
        this.checkWrite(authorize);
        controller.signal.throwIfAborted();
        const prepared = await llm.prepareCall({ provider: body.provider, model: body.model, maxTokens: 16 }, controller.signal,
          (controls, model) => {
            const effort = model?.reasoning?.efforts?.[0];
            return { ...controls, maxTokens: 16, ...(safeString(effort?.id) ? { reasoningEffort: effort.id } : {}) };
          });
        this.checkWrite(authorize);
        controller.signal.throwIfAborted();
        if (!prepared?.config || prepared.config.provider !== body.provider || prepared.config.model !== body.model
          || prepared.config.maxTokens !== 16 || typeof prepared.stream !== 'function') throw new Error();
        const stream = prepared.stream({ ...prepared.config,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }], tools: [], signal: controller.signal });
        if (typeof stream?.[Symbol.asyncIterator] !== 'function') throw new Error();
        iterator = stream[Symbol.asyncIterator]();
        let visible = false, terminal = '', chunks = 0, characters = 0;
        while (true) {
          this.checkWrite(authorize);
          controller.signal.throwIfAborted();
          const next = await iterator.next();
          this.checkWrite(authorize);
          controller.signal.throwIfAborted();
          if (next.done) { completed = true; break; }
          if (++chunks > 128) throw new Error();
          const chunk = next.value;
          if (['text-delta', 'reasoning-delta'].includes(chunk?.type) && typeof chunk.text === 'string') {
            visible ||= Boolean(chunk.text.trim()); characters += chunk.text.length;
          } else if (chunk?.type === 'block-end' && ['text', 'reasoning'].includes(chunk.block?.type) && typeof chunk.block.text === 'string') {
            visible ||= Boolean(chunk.block.text.trim()); characters += chunk.block.text.length;
          }
          if (characters > 8192) throw new Error();
          if (chunk?.type === 'finish') {
            terminal = chunk.reason?.kind || '';
            if (!['stop', 'max-tokens'].includes(terminal)) throw new Error();
          }
        }
        if (!visible || !['stop', 'max-tokens'].includes(terminal)) throw new Error();
        const latest = this.describe().entries.find(({ entry }) => entry.provider === body.provider);
        if (latest?.namespace?.revision !== found.namespace?.revision) return result(false, '测试期间服务商配置已变化，请使用当前配置重新测试');
        return result(true, terminal === 'max-tokens' ? '实际 API 已返回模型响应，达到 16 token 测试上限' : '实际 API 已返回模型响应，地址、凭据和协议本次请求可用');
      })();
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(), { code: 'PANEL_CONNECTION_TIMEOUT' })); }, Math.min(15000, this.connectionTimeoutMs));
      });
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (error instanceof ModelPanelError) throw error;
      return result(false, error?.code === 'PANEL_CONNECTION_TIMEOUT' ? '实际 API 测试超时，不能确认可用' : '实际 API 测试未通过，请检查地址、凭据、协议和模型配置');
    } finally {
      clearTimeout(timer); controller.abort();
      if (iterator && !completed) {
        try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch {}
      }
      this.connectionTesting = false;
    }
  }

  async saveSelection(body, { authorize } = {}) {
    this.checkWrite(authorize);
    if (this.saving) throw new ModelPanelError('BUSY', '正在保存模型配置，请稍后再试');
    if (!plain(body) || Object.keys(body).some((key) => !['provider', 'model', 'expectedSelection'].includes(key))
      || !safeString(body.provider) || !safeString(body.model)
      || !expectedSelection(body.expectedSelection, ['provider', 'model', 'reasoningEffort'], ['provider', 'model'])) {
      throw new ModelPanelError('INVALID_PATCH', '默认模型选择请求无效');
    }
    this.saving = true;
    let timer;
    try {
      if (!this.selectionEntry('model')) throw new ModelPanelError('UNAVAILABLE', '宿主未提供可写的默认模型配置入口');
      const llm = this.service('llm');
      let registered;
      try { registered = llm?.listProviders?.(); } catch {}
      if (!Array.isArray(registered) || !registered.some((row) => row?.id === body.provider)
        || typeof llm?.listModels !== 'function') throw new ModelPanelError('INVALID_PATCH', '请选择已在宿主启用的模型服务商');
      const models = await Promise.race([
        Promise.resolve().then(() => llm.listModels(body.provider)),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new ModelPanelError('UNAVAILABLE', '读取宿主模型目录超时，请稍后再试')), 15000); }),
      ]);
      this.checkWrite(authorize);
      if (!Array.isArray(models) || !models.some((row) => row?.provider === body.provider && row?.id === body.model)) {
        throw new ModelPanelError('INVALID_PATCH', '模型不在此服务商当前可用的宿主目录中，请先保存凭据和服务商配置');
      }
      const current = this.describe().selection;
      if (!sameSelection(current, body.expectedSelection, ['provider', 'model', 'reasoningEffort'])) {
        throw new ModelPanelError('CONFLICT', '默认模型已在其他界面修改，请刷新后重试');
      }
      const entry = this.selectionEntry('model');
      if (!entry || !sameSelection(entry.descriptor.value, current, ['provider', 'model', 'reasoningEffort'])) {
        throw new ModelPanelError('CONFLICT', '宿主默认模型状态已变化，请刷新后重试');
      }
      this.checkWrite(authorize);
      const ops = [{ op: 'set', path: ['provider'], value: body.provider }, { op: 'set', path: ['model'], value: body.model }];
      if (schemaNode(entry.descriptor.schema, ['reasoningEffort'])?.node) ops.push({ op: 'unset', path: ['reasoningEffort'] });
      await entry.settings.mutate(entry.descriptor.ns, ops, entry.descriptor.revision);
      if (!sameSelection(this.describe().selection, body, ['provider', 'model'])) {
        throw new ModelPanelError('SAVE_FAILED', '宿主未确认默认模型已切换，请刷新后核实');
      }
      return await this.snapshot();
    } catch (error) {
      if (error instanceof ModelPanelError) throw error;
      if (error?.code === 'SETTINGS_CONFLICT') throw new ModelPanelError('CONFLICT', '默认模型已在其他界面修改，请刷新后重试');
      throw new ModelPanelError('SAVE_FAILED', '宿主未能保存默认模型，请检查服务商配置后重试');
    } finally { clearTimeout(timer); this.saving = false; }
  }

  /** Explicit metadata/authentication probe; never starts chat or sends QQ. */
  async probe(body, { authorize } = {}) {
    this.checkWrite(authorize);
    if (!plain(body) || Object.keys(body).some((key) => key !== 'provider') || !safeString(body.provider)) {
      throw new ModelPanelError('INVALID_PATCH', '模型检测请求无效');
    }
    const { llm, entries } = this.describe();
    const found = entries.find(({ entry }) => entry.provider === body.provider);
    if (!found) throw new ModelPanelError('UNAVAILABLE', '此服务商未在宿主注册');
    if (this.probing.has(body.provider)) throw new ModelPanelError('BUSY', '正在检测此服务商，请稍后刷新');
    const checked = (result) => {
      const probe = { provider: body.provider, ...result, checkedAt: new Date().toISOString() };
      this.lastProbes.set(body.provider, probe);
      this.lastProbeRevisions.set(body.provider, found.namespace?.revision);
      return { ok: true, probe: { ...probe } };
    };
    if (typeof llm?.discoverModels !== 'function') return checked({ ok: false, supported: false, note: '宿主未提供 API 元数据检测，连接状态尚未验证' });
    this.probing.add(body.provider);
    const controller = new AbortController();
    let timer;
    try {
      this.checkWrite(authorize);
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(), { code: 'PANEL_PROBE_TIMEOUT' })); }, this.probeTimeoutMs);
      });
      const models = await Promise.race([
        Promise.resolve().then(() => {
          this.checkWrite(authorize);
          return llm.discoverModels(found.entry.settingsNs, { provider: body.provider }, controller.signal);
        }), timeout,
      ]);
      this.checkWrite(authorize);
      if (!Array.isArray(models)) return checked({ ok: false, supported: null, note: 'API 返回格式无法确认，连接状态尚未验证' });
      if (!models.length) return checked({ ok: false, supported: null, modelCount: 0, note: '宿主返回空模型目录，无法确认凭据或 API 可用性' });
      return checked({ ok: true, supported: true, modelCount: models.length,
        note: '宿主已返回模型目录；部分服务商使用本地目录，实际 API 对话仍需以回复为准' });
    } catch (error) {
      if (error instanceof ModelPanelError) throw error;
      if (error?.code === 'NO_DISCOVERY' || error?.code === 'UNSUPPORTED_DISCOVERY') return checked({ ok: false, supported: false, note: '此服务商不提供模型列表检测，连接状态尚未验证' });
      return checked({ ok: false, supported: null,
        note: error?.code === 'PANEL_PROBE_TIMEOUT' ? 'API 检测超时，连接状态尚未验证' : 'API 检测未通过，请检查地址、凭据和服务商支持情况' });
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.probing.delete(body.provider);
    }
  }

  speechSnapshot() {
    const speech = this.service('speechToText');
    let snapshot;
    try { snapshot = speech?.snapshot?.(); } catch {}
    const providers = Array.isArray(snapshot?.providers) ? snapshot.providers.slice(0, 32).flatMap((row) => {
      if (!safeString(row?.id)) return [];
      const result = { id: row.id, name: safeString(row.name) || row.id,
        languages: stringList(row.languages, 32), downloadSources: sourceList(row.downloadSources),
        preparation: safePreparation(row.preparation) };
      if (plain(row.setupEstimate)) result.setupEstimate = Object.fromEntries(['recommendedDiskBytes', 'expectedMemoryBytes', 'minimumMinutes', 'maximumMinutes']
        .filter((key) => Number.isFinite(row.setupEstimate[key]) && row.setupEstimate[key] >= 0)
        .map((key) => [key, row.setupEstimate[key]]));
      return [result];
    }) : [];
    const selected = snapshot?.selection;
    return { available: Boolean(speech && snapshot), providers,
      selection: safeString(selected?.providerId) && safeString(selected?.language) ? { providerId: selected.providerId, language: selected.language } : null,
      selectionEditable: Boolean(this.selectionEntry('speech')),
      canPrepare: typeof speech?.prepare === 'function',
      job: this.speechJob ? { ...this.speechJob } : null };
  }

  async saveSpeechSelection(body, { authorize } = {}) {
    this.checkWrite(authorize);
    if (this.saving) throw new ModelPanelError('BUSY', '正在保存配置，请稍后再试');
    if (!plain(body) || Object.keys(body).some((key) => !['providerId', 'language', 'expectedSelection'].includes(key))
      || !safeString(body.providerId) || !safeString(body.language)
      || !expectedSelection(body.expectedSelection, ['providerId', 'language'], ['providerId', 'language'])) {
      throw new ModelPanelError('INVALID_PATCH', '默认语音识别选择请求无效');
    }
    this.saving = true;
    try {
      const current = this.speechSnapshot();
      const provider = current.providers.find((row) => row.id === body.providerId);
      if (!provider || !provider.languages.includes(body.language)) throw new ModelPanelError('INVALID_PATCH', '请选择已注册的识别服务及其支持的语言');
      if (!sameSelection(current.selection, body.expectedSelection, ['providerId', 'language'])) throw new ModelPanelError('CONFLICT', '语音识别选择已变化，请刷新后重试');
      const entry = this.selectionEntry('speech');
      if (!entry) throw new ModelPanelError('UNAVAILABLE', '宿主未提供可写的默认语音识别入口');
      if (entry.descriptor.value?.defaultProvider !== current.selection?.providerId || entry.descriptor.value?.language !== current.selection?.language) {
        throw new ModelPanelError('CONFLICT', '宿主语音识别状态已变化，请刷新后重试');
      }
      this.checkWrite(authorize);
      await entry.settings.mutate(entry.descriptor.ns, [
        { op: 'set', path: ['defaultProvider'], value: body.providerId }, { op: 'set', path: ['language'], value: body.language },
      ], entry.descriptor.revision);
      if (!sameSelection(this.speechSnapshot().selection, body, ['providerId', 'language'])) {
        throw new ModelPanelError('SAVE_FAILED', '宿主未确认语音识别已切换，请刷新后核实');
      }
      return await this.snapshot();
    } catch (error) {
      if (error instanceof ModelPanelError) throw error;
      if (error?.code === 'SETTINGS_CONFLICT') throw new ModelPanelError('CONFLICT', '语音识别选择已变化，请刷新后重试');
      throw new ModelPanelError('SAVE_FAILED', '宿主未能保存语音识别选择，请刷新后重试');
    } finally { this.saving = false; }
  }

  checkWrite(authorize) {
    if (typeof authorize === 'function' && authorize() === false) throw new ModelPanelError('FORBIDDEN', '当前会话已无配置权限');
    if (this.getBusy()) throw new ModelPanelError('BUSY', '正在回复或应用配置，请稍后再试');
  }

  async save(body, { authorize } = {}) {
    this.checkWrite(authorize);
    if (this.saving) throw new ModelPanelError('BUSY', '正在保存模型配置，请稍后再试');
    if (!plain(body) || Object.keys(body).some((key) => !['provider', 'revision', 'patch'].includes(key))
      || !safeString(body.provider) || !Number.isSafeInteger(body.revision) || body.revision < 0 || !plain(body.patch)
      || !Object.keys(body.patch).length || Object.keys(body.patch).some((key) => !['baseURL', 'protocol', 'apiKey'].includes(key))) {
      throw new ModelPanelError('INVALID_PATCH', '模型配置请求无效');
    }
    this.saving = true;
    let stagedRef, stagedProvider, mutationAttempted = false, committed = false;
    const credentials = this.service('credentials');
    try {
      const { settings, entries } = this.describe();
      const found = entries.find(({ entry }) => entry.provider === body.provider);
      if (!found?.namespace || settings?.writable !== true || typeof settings?.mutate !== 'function') throw new ModelPanelError('UNAVAILABLE', '宿主未提供此服务商的可写配置');
      const { entry, namespace, profile, editableUrl, editableKey, protocolChoices } = found;
      if (namespace.revision !== body.revision) throw new ModelPanelError('CONFLICT', '模型配置已被其他界面修改，请刷新后重试');
      const ops = [];
      if (Object.hasOwn(body.patch, 'baseURL')) {
        if (!editableUrl || !validUrl(body.patch.baseURL)) throw new ModelPanelError('INVALID_PATCH', 'API URL 必须为不含凭据和查询参数的 HTTPS 地址，本机服务可用 HTTP');
        ops.push({ op: 'set', path: [...entry.settingsPath, 'baseURL'], value: body.patch.baseURL });
      }
      if (Object.hasOwn(body.patch, 'protocol')) {
        if (!protocolChoices.includes(body.patch.protocol)) throw new ModelPanelError('INVALID_PATCH', '协议不在当前宿主支持的范围内');
        ops.push({ op: 'set', path: [...entry.settingsPath, 'api'], value: body.patch.protocol });
      }
      if (Object.hasOwn(body.patch, 'apiKey')) {
        const value = body.patch.apiKey;
        if (typeof value !== 'string' || value.length > 8192 || /\s/.test(value)) throw new ModelPanelError('INVALID_PATCH', 'API key 不能包含空白或超过长度上限');
        if (value) {
          if (!editableKey || typeof credentials?.set !== 'function' || typeof credentials?.unset !== 'function' || typeof credentials?.describe !== 'function') throw new ModelPanelError('UNAVAILABLE', '宿主凭据存储不可写，无法保存 API key');
          const info = await credentials.describe(credentialRef(entry, profile));
          if (info?.writable !== true) throw new ModelPanelError('UNAVAILABLE', '宿主凭据存储不可写，无法保存 API key');
          this.checkWrite(authorize);
          // A unique staged reference prevents CAS failure from replacing an active key.
          stagedRef = `DAFEIYU_${entry.provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${randomUUID().replaceAll('-', '')}_API_KEY`;
          stagedProvider = entry.provider;
          await credentials.set(stagedRef, value);
          this.checkWrite(authorize);
          ops.push({ op: 'set', path: [...entry.settingsPath, 'apiKeyEnv'], value: stagedRef });
        }
      }
      this.checkWrite(authorize);
      if (ops.length) {
        mutationAttempted = true;
        await settings.mutate(entry.settingsNs, ops, body.revision);
        this.lastProbes.delete(entry.provider);
        this.lastProbeRevisions.delete(entry.provider);
        this.lastTests.delete(entry.provider);
      }
      committed = true;
      return await this.snapshot();
    } catch (error) {
      if (error instanceof ModelPanelError) throw error;
      if (error?.code === 'SETTINGS_CONFLICT') throw new ModelPanelError('CONFLICT', '模型配置已被其他界面修改，请刷新后重试');
      throw new ModelPanelError('SAVE_FAILED', '宿主拒绝了模型配置，请检查 URL、协议和服务商配置后重试');
    } finally {
      if (stagedRef && !committed) {
        // A provider can throw after its write committed. Never delete a key the
        // resulting configuration references, or guess after its namespace vanished.
        const current = mutationAttempted ? this.describe().entries.find(({ entry }) => entry.provider === stagedProvider) : null;
        if (!mutationAttempted || current?.namespace && current.profile.apiKeyEnv !== stagedRef) {
          try { await credentials.unset(stagedRef); }
          catch { /* Only this unreferenced staging key was eligible for deletion. */ }
        }
      }
      this.saving = false;
    }
  }

  async prepareSpeech(body, { authorize } = {}) {
    this.checkWrite(authorize);
    if (!plain(body) || Object.keys(body).some((key) => !['providerId', 'downloadSource'].includes(key)) || !safeString(body.providerId)) {
      throw new ModelPanelError('INVALID_PATCH', '语音资源准备请求无效');
    }
    const speech = this.service('speechToText');
    const snapshot = this.speechSnapshot();
    const provider = snapshot.providers.find((row) => row.id === body.providerId);
    if (!provider || typeof speech?.prepare !== 'function') throw new ModelPanelError('UNAVAILABLE', '语音识别服务未安装或未接入宿主');
    if (Object.hasOwn(body, 'downloadSource') && !provider.downloadSources.includes(body.downloadSource)) throw new ModelPanelError('INVALID_PATCH', '下载来源不在当前识别服务提供的列表内');
    if (this.speechJob?.state === 'running') throw new ModelPanelError('BUSY', '语音资源正在准备，请稍后刷新状态');
    this.checkWrite(authorize);
    try {
      this.speechJob = { state: 'running', providerId: provider.id };
      // Native DSH starts a Host-owned task synchronously; do not wait for downloads.
      const pending = speech.prepare(provider.id, body.downloadSource === undefined ? undefined : { downloadSource: body.downloadSource });
      if (pending?.then) Promise.resolve(pending).then(() => {
        this.speechJob = { state: 'completed', providerId: provider.id };
      }, () => { this.speechJob = { state: 'failed', providerId: provider.id, error: '语音资源准备失败，请刷新检查服务状态' }; });
      else this.speechJob = null;
      return await this.snapshot();
    } catch (error) {
      this.speechJob = { state: 'failed', providerId: provider.id, error: '语音资源准备失败，请刷新检查服务状态' };
      if (error instanceof ModelPanelError) throw error;
      throw new ModelPanelError('PREPARE_FAILED', '宿主拒绝准备语音资源，请检查识别服务后重试');
    }
  }
}
