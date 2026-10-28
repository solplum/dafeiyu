/** Read-through management overlay. Original archives are never migrated. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_BYTES = 8 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const copy = (value) => JSON.parse(JSON.stringify(value));
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string = (value, max, required = false) => typeof value === 'string' && value.length <= max
  && (!required || Boolean(value.trim())) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const fields = (value, allowed) => plain(value) && Reflect.ownKeys(value).every((key) => typeof key === 'string'
  && allowed.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const statuses = ['active', 'forgotten', 'unconfirmed'];

export class MemoryStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'MemoryStoreError'; this.code = code; }
}
const fail = (code, message) => { throw new MemoryStoreError(code, message); };

export function validateMemoryScope(scope) {
  return fields(scope, ['type', 'accountId', 'identityId']) && ['account', 'identity'].includes(scope.type)
    && string(scope.accountId, 200, true) && (scope.type === 'account' ? scope.identityId === undefined
      : string(scope.identityId, 100, true));
}
export function memoryProvenance({ sourceType = 'user_explicit', confirmed, actor = 'tool', sessionId, messageId } = {}) {
  if (!['legacy', 'user_explicit', 'inference'].includes(sourceType) || !['legacy', 'tool', 'panel'].includes(actor)) fail('INVALID_PATCH', '记忆来源无效');
  return { type: sourceType, confirmed: sourceType === 'legacy' ? null : sourceType === 'inference' ? false : confirmed !== false,
    actor, ...(string(sessionId, 200, true) ? { sessionId } : {}), ...(string(messageId, 200, true) ? { messageId } : {}) };
}
function validProvenance(value) {
  return fields(value, ['type', 'confirmed', 'actor', 'sessionId', 'messageId'])
    && ['legacy', 'user_explicit', 'inference'].includes(value.type) && ['legacy', 'tool', 'panel'].includes(value.actor)
    && (value.type === 'legacy' ? value.confirmed === null : typeof value.confirmed === 'boolean')
    && (value.type !== 'inference' || value.confirmed === false)
    && ['sessionId', 'messageId'].every((key) => value[key] === undefined || string(value[key], 200, true));
}
function validState(value) {
  return fields(value, ['summary', 'detail', 'status', 'scope', 'provenance', 'updatedAt'])
    && string(value.summary, MAX_BYTES, true) && string(value.detail, MAX_BYTES, true) && statuses.includes(value.status)
    && validateMemoryScope(value.scope) && validProvenance(value.provenance) && string(value.updatedAt, 100)
    && !(value.status === 'active' && value.provenance.confirmed === false);
}
const stateOf = (record) => Object.fromEntries(['summary', 'detail', 'status', 'scope', 'provenance', 'updatedAt'].map((key) => [key, copy(record[key])]));
const fingerprint = (record) => hash(JSON.stringify({ id: record.id, ...stateOf(record) }));
export const memoryScopeVisible = (record, context = {}, owner = '') => record.scope.accountId === (context.accountId || owner)
  && (record.scope.type === 'account' || Boolean(context.identityId) && record.scope.identityId === context.identityId);

export class MemoryLedger {
  constructor({ directory, accountId }) {
    this.directory = directory; this.accountId = accountId;
    this.paths = { facts: path.join(directory, 'facts.json'), archive: path.join(directory, 'user.md'),
      events: path.join(directory, 'timeline.md'), overlay: path.join(directory, 'memory-overlay.json') };
    this.lockPath = path.join(directory, '.memory-write.lock');
  }
  read(file) {
    try {
      const maximum = file === path.join(this.directory, '.memory-delete.next.json') ? MAX_BYTES * 6 : MAX_BYTES;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error();
      const bytes = fs.readFileSync(file);
      if (bytes.length > maximum) throw new Error();
      return bytes;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail('INVALID_MEMORY', `共享记忆读取失败 (${path.basename(file)})：文件不可读、无效或过大`);
    }
  }
  load({ bytes: supplied, ignorePending = false } = {}) {
    if (!ignorePending && fs.existsSync(path.join(this.directory, '.memory-delete.pending'))) fail('DELETE_PENDING', '记忆删除尚未完成，已停止召回；请核对本地删除事务');
    const bytes = supplied || Object.fromEntries(Object.entries(this.paths).map(([key, file]) => [key, this.read(file)]));
    const revision = hash(Object.entries(bytes).map(([key, value]) => `${key}\0${value === null ? 'missing' : value.toString('base64')}\0`).join(''));
    let facts = [], overlay = { version: 1, entries: {} };
    if (bytes.facts !== null) {
      try {
        if (!bytes.facts.toString('utf8').trim()) fail('INVALID_MEMORY', '共享记忆读取失败 (facts.json)：事实账本已存在但内容为空');
        const value = JSON.parse(bytes.facts.toString('utf8'));
        if (value?.version !== 1 || !Array.isArray(value.facts)) throw new Error();
        const ids = new Set(), keys = new Set();
        for (const fact of value.facts) {
          if (!plain(fact) || !['id', 'key', 'summary', 'detail', 'createdAt', 'updatedAt'].every((key) => string(fact[key], MAX_BYTES, true))) throw new Error();
          if (fact.memoryScope !== undefined && !validateMemoryScope(fact.memoryScope)
            || fact.provenance !== undefined && !validProvenance(fact.provenance)) throw new Error();
          const scope = fact.memoryScope || { type: 'account', accountId: this.accountId };
          const key = JSON.stringify([scope.type, scope.accountId, scope.identityId || '', fact.key]);
          if (ids.has(fact.id) || keys.has(key)) throw new Error();
          ids.add(fact.id); keys.add(key);
        }
        facts = value.facts;
      } catch (error) { if (error instanceof MemoryStoreError) throw error; fail('INVALID_MEMORY', '共享记忆读取失败 (facts.json)：事实账本结构损坏，未修改原文件'); }
    }
    if (bytes.overlay !== null) {
      try {
        overlay = JSON.parse(bytes.overlay.toString('utf8'));
        if (!fields(overlay, ['version', 'entries']) || overlay.version !== 1 || !plain(overlay.entries)
          || Object.keys(overlay.entries).length > 10000) throw new Error();
        for (const [id, entry] of Object.entries(overlay.entries)) {
          if (!/^(fact|archive|event):[a-f0-9-]{16,80}$/.test(id)
            || !fields(entry, ['fingerprint', 'current', 'undo', 'history']) || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
            || !validState(entry.current) || !Array.isArray(entry.undo) || entry.undo.length > 20 || !entry.undo.every(validState)
            || !Array.isArray(entry.history) || entry.history.length > 50 || !entry.history.every((event) =>
              fields(event, ['at', 'action', 'summary', 'reason', 'actor']) && string(event.at, 100, true)
              && ['correct', 'forget', 'restore', 'remember'].includes(event.action) && string(event.summary, 160)
              && string(event.reason, 500) && ['tool', 'panel', 'legacy'].includes(event.actor))) throw new Error();
        }
      } catch { fail('INVALID_MEMORY', '共享记忆读取失败 (memory-overlay.json)：更正记录损坏；未使用原始旧记忆或覆盖损坏文件'); }
    }
    const defaultScope = { type: 'account', accountId: this.accountId };
    const legacy = memoryProvenance({ sourceType: 'legacy', actor: 'legacy' });
    const records = facts.slice().reverse().map((fact) => ({ id: `fact:${hash(fact.id)}`, kind: 'fact', key: fact.key,
      summary: fact.summary, detail: fact.detail, source: 'memory/facts.json', scope: fact.memoryScope || defaultScope,
      provenance: fact.provenance || legacy, status: fact.provenance?.confirmed === false ? 'unconfirmed' : 'active',
      updatedAt: fact.updatedAt, history: (Array.isArray(fact.updates) ? fact.updates : []).slice(-20).filter((entry) =>
        plain(entry) && string(entry.at, 100, true) && string(entry.summary, 160) && ['tool', 'panel', 'legacy'].includes(entry.actor))
        .map((entry) => ({ at: entry.at, action: 'remember', summary: entry.summary, reason: '', actor: entry.actor })),
      canRestore: false, legacyFactId: fact.id }));
    const unique = new Map();
    const stable = (source, text) => { const key = `${source}\0${text}`, occurrence = unique.get(key) || 0;
      unique.set(key, occurrence + 1); return hash(`${key}\0${occurrence}`); };
    for (const section of (bytes.archive?.toString('utf8') || '').split(/(?=^#{1,6}\s)/m).filter((text) => text.trim())) {
      const detail = section.trim(), summary = section.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '') || '主人档案';
      records.push({ id: `archive:${stable('archive', detail)}`, kind: 'fact', summary, detail, source: 'memory/user.md',
        scope: defaultScope, provenance: legacy, status: 'active', updatedAt: '', history: [], canRestore: false });
    }
    const boundary = /(?:^|\r?\n)---[ \t]*\r?\n(?:[ \t]*\r?\n)*(?=###[ \t]*\[[^\]\r\n]+\])/;
    const eventIds = new Set();
    for (const text of (bytes.events?.toString('utf8') || '').split(boundary).filter((entry) => entry.trim()).reverse()) {
      const heading = text.match(/^###\s*\[([^\]]+)\]\s*(.*)$/m);
      let meta;
      const marker = text.match(/^<!-- dsh-memory:([A-Za-z0-9+/=]+) -->\r?$/m);
      if (marker) {
        try {
          meta = JSON.parse(Buffer.from(marker[1], 'base64').toString('utf8'));
          if (!fields(meta, ['id', 'scope', 'provenance', 'createdAt']) || !/^[a-f0-9-]{36}$/.test(meta.id)
            || !validateMemoryScope(meta.scope) || !validProvenance(meta.provenance) || !string(meta.createdAt, 100, true)) throw new Error();
        } catch { fail('INVALID_MEMORY', '共享记忆读取失败 (timeline.md)：事件元数据损坏'); }
      } else if (/^<!-- dsh-memory:/m.test(text)) fail('INVALID_MEMORY', '共享记忆读取失败 (timeline.md)：事件元数据损坏');
      const detail = text.replace(/^<!-- dsh-memory:[^\r\n]*-->\r?\n?/m, '').trim();
      const id = `event:${meta?.id || stable('event', detail)}`;
      if (eventIds.has(id)) fail('INVALID_MEMORY', '共享记忆读取失败 (timeline.md)：事件 ID 重复');
      eventIds.add(id);
      records.push({ id, kind: 'event', summary: heading?.[2]?.trim() || '历史手账', detail, ...(heading ? { date: heading[1] } : {}),
        source: 'memory/timeline.md', scope: meta?.scope || defaultScope, provenance: meta?.provenance || legacy,
        status: meta?.provenance?.confirmed === false ? 'unconfirmed' : 'active', updatedAt: meta?.createdAt || '', history: [], canRestore: false });
    }
    const recordIds = new Set(records.map((record) => record.id));
    if (Object.keys(overlay.entries).some((id) => !recordIds.has(id))) fail('CONFLICT', '有已更正的原始记忆被外部改变或移除，已停止套用；请核对原档案');
    for (const record of records) {
      const entry = overlay.entries[record.id];
      if (!entry) continue;
      if (entry.fingerprint !== fingerprint(record)) fail('CONFLICT', '原始记忆已被外部修改，无法安全套用既有更正；请核对原档案');
      Object.assign(record, copy(entry.current), { history: copy(entry.history), canRestore: entry.undo.length > 0 });
    }
    return { revision, records, facts, overlay, bytes };
  }
  snapshot({ query = '', status = 'all', kind = 'all', scope = 'all', accountId, identityId, offset = 0, limit = 50 } = {}) {
    if (!string(query, 200) || !['all', ...statuses].includes(status) || !['all', 'fact', 'event'].includes(kind)
      || !['all', 'account', 'identity'].includes(scope) || !Number.isInteger(offset) || offset < 0 || offset > 100000
      || !Number.isInteger(limit) || limit < 1 || limit > 100
      || accountId !== undefined && !string(accountId, 200, true) || identityId !== undefined && !string(identityId, 100, true)) fail('INVALID_PATCH', '记忆筛选参数无效');
    const state = this.load(), terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const rows = state.records.filter((record) => (kind === 'all' || record.kind === kind) && (status === 'all' || record.status === status)
      && (scope === 'all' || record.scope.type === scope) && (!accountId || record.scope.accountId === accountId)
      && (!identityId || record.scope.identityId === identityId)
      && terms.every((term) => `${record.key || ''}\n${record.summary}\n${record.detail}`.toLowerCase().includes(term)));
    return { revision: state.revision, items: copy(rows.slice(offset, offset + limit).map(({ legacyFactId, ...record }) => record)),
      total: rows.length, offset, limit, truncated: offset + limit < rows.length,
      note: '停用只阻止长期记忆检索及自动注入，不会擦除原档案、历史聊天或备份；既有聊天里的旧引用仍可能存在。' };
  }
  purge(input, { authorize = () => false, context } = {}) {
    if (!fields(input, ['id', 'revision', 'reason']) || !string(input.id, 100, true)
      || !/^[a-f0-9]{64}$/.test(input.revision || '')) fail('INVALID_PATCH', '删除参数无效');
    const check = () => { if (authorize() !== true) fail('FORBIDDEN', '删除授权已失效'); };
    check();
    return this.withLock(() => {
      const before = this.load();
      if (before.revision !== input.revision) fail('CONFLICT', '记忆已变化，请重新核对删除对象');
      const target = before.records.find((row) => row.id === input.id);
      if (!target || context && !memoryScopeVisible(target, context, this.accountId)) fail('NOT_FOUND', '当前身份没有这条记忆');
      const raw = this.load({ bytes: { ...before.bytes, overlay: null } });
      const original = raw.records.find((row) => row.id === target.id), next = { ...before.bytes, overlay: null };
      if (original.source === 'memory/facts.json') {
        next.facts = Buffer.from(JSON.stringify({ version: 1, facts: before.facts.filter((row) => row.id !== original.legacyFactId) }, null, 2) + '\n');
      } else if (original.source === 'memory/user.md') {
        const sections = before.bytes.archive.toString('utf8').split(/(?=^#{1,6}\s)/m).filter((part) => part.trim());
        const index = raw.records.filter((row) => row.source === original.source).findIndex((row) => row.id === original.id);
        sections.splice(index, 1); next.archive = Buffer.from(sections.join('\n'));
      } else {
        const boundary = /(?:^|\r?\n)---[ \t]*\r?\n(?:[ \t]*\r?\n)*(?=###[ \t]*\[[^\]\r\n]+\])/;
        const sections = before.bytes.events.toString('utf8').split(boundary).filter((part) => part.trim()).reverse();
        const index = raw.records.filter((row) => row.source === original.source).findIndex((row) => row.id === original.id);
        sections.splice(index, 1); next.events = Buffer.from(sections.reverse().join('\n---\n\n'));
      }
      const remaining = this.load({ bytes: next }).records;
      const signature = (row) => JSON.stringify([row.kind, row.source, row.key, row.summary, row.detail, row.scope]);
      const buckets = new Map();
      for (const row of remaining) { const key = signature(row); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row); }
      const entries = {};
      for (const row of raw.records.filter((row) => row.id !== target.id)) {
        const survivor = buckets.get(signature(row))?.shift();
        if (!survivor) fail('CONFLICT', '删除预演改变了其他记忆，未修改文件');
        const entry = before.overlay.entries[row.id];
        if (entry) entries[survivor.id] = { ...copy(entry), fingerprint: fingerprint(survivor) };
      }
      next.overlay = Buffer.from(JSON.stringify({ version: 1, entries }, null, 2) + '\n');
      this.load({ bytes: next }); check();
      const pending = path.join(this.directory, '.memory-delete.pending');
      const staging = path.join(this.directory, '.memory-delete.next.json');
      const encoded = JSON.stringify({ version: 1,
        before: Object.fromEntries(Object.entries(before.bytes).map(([key, value]) => [key, value === null ? null : hash(value)])),
        files: Object.fromEntries(Object.entries(next).map(([key, value]) => [key, value === null ? null : value.toString('base64')])) });
      this.atomic(staging, encoded, () => { check(); if (this.load().revision !== before.revision) fail('CONFLICT', '删除预演后记忆已变化'); });
      this.atomic(pending, JSON.stringify({ id: target.id, hash: hash(encoded), at: new Date().toISOString() }), () => {
        check(); if (this.load().revision !== before.revision) fail('CONFLICT', '删除前记忆已变化');
      });
      // The marker blocks all readers if a crash or revocation interrupts this multi-file operation.
      for (const [key, bytes] of Object.entries(next)) {
        if (bytes === null || before.bytes[key]?.equals(bytes)) continue;
        this.atomic(this.paths[key], bytes, () => { check();
          const actual = this.read(this.paths[key]);
          if (actual === null ? before.bytes[key] !== null : !actual.equals(before.bytes[key])) fail('CONFLICT', '删除期间文件被外部修改，已停止召回');
        });
      }
      check(); fs.unlinkSync(pending); fs.rmSync(staging, { force: true });
      return { ok: true, deleted: true, revision: this.load().revision,
        note: '此条记忆已从受管原档案及更正历史删除；DSH聊天历史和外部备份未清除。' };
    });
  }

  resumeDelete(input, { authorize = () => false } = {}) {
    if (!fields(input, ['confirmed']) || input.confirmed !== true) fail('INVALID_PATCH', '需要明确确认完成中断的删除');
    const check = () => { if (authorize() !== true) fail('FORBIDDEN', '删除授权已失效'); }; check();
    return this.withLock(() => {
      const pending = path.join(this.directory, '.memory-delete.pending'), staging = path.join(this.directory, '.memory-delete.next.json');
      let plan, marker;
      try {
        marker = JSON.parse(this.read(pending));
        const bytes = this.read(staging);
        if (!bytes || marker.hash !== hash(bytes)) throw new Error();
        plan = JSON.parse(bytes);
        if (plan.version !== 1 || !fields(plan.before, Object.keys(this.paths)) || !fields(plan.files, Object.keys(this.paths))
          || Object.keys(plan.files).length !== Object.keys(this.paths).length) throw new Error();
      } catch { fail('INVALID_MEMORY', '删除事务无法安全恢复，请保留文件核对；未恢复旧原文'); }
      const next = Object.fromEntries(Object.entries(plan.files).map(([key, value]) => [key, value === null ? null : Buffer.from(value, 'base64')]));
      this.load({ bytes: next, ignorePending: true });
      for (const [key, bytes] of Object.entries(next)) {
        const current = this.read(this.paths[key]), currentHash = current === null ? null : hash(current);
        if (currentHash !== plan.before[key] && currentHash !== (bytes === null ? null : hash(bytes))) fail('CONFLICT', '中断后档案被外部修改，未覆盖');
      }
      for (const [key, bytes] of Object.entries(next)) {
        if (bytes !== null) this.atomic(this.paths[key], bytes, check);
      }
      check(); fs.unlinkSync(pending); fs.rmSync(staging, { force: true });
      return { ok: true, deleted: true, revision: this.load().revision, note: '中断的受管记忆删除已完成，没有重放聊天或恢复已删除内容。' };
    });
  }

  withLock(write) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let locked = false;
    try {
      try { fs.mkdirSync(this.lockPath, { mode: 0o700 }); locked = true; }
      catch (error) { if (error.code === 'EEXIST') fail('BUSY', '共享记忆正在写入，未保存；请稍后重试'); throw error; }
      return write();
    } finally { if (locked) fs.rmdirSync(this.lockPath); }
  }
  atomic(file, contents, verify = () => {}) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      const bytes = Buffer.from(contents);
      if (bytes.length > (file === path.join(this.directory, '.memory-delete.next.json') ? MAX_BYTES * 6 : MAX_BYTES)) fail('INVALID_PATCH', '记忆更正记录超过大小上限');
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      verify(); fs.renameSync(temporary, file); committed = true;
      const dir = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch (error) { if (committed) fail('SAVE_UNCERTAIN', '记忆文件已替换但持久化确认失败，请重新读取核对'); throw error; }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  mutate(action, input, { authorize = () => true, context, actor = 'panel', provenanceOverride } = {}) {
    if (!['tool', 'panel', 'legacy'].includes(actor)
      || provenanceOverride !== undefined && !validProvenance(provenanceOverride)) fail('INVALID_PATCH', '记忆操作来源无效');
    if (!fields(input, ['id', 'revision', 'summary', 'detail', 'sourceType', 'confirmed', 'reason'])
      || !string(input.id, 100, true) || !/^[a-f0-9]{64}$/.test(input.revision || '') || !string(input.reason ?? '', 500)
      || !['correct', 'forget', 'restore'].includes(action)) fail('INVALID_PATCH', '记忆操作参数无效');
    if (action === 'correct' && (!string(input.summary, 160, true) || !string(input.detail, 2000, true)
      || !['user_explicit', 'inference'].includes(input.sourceType || 'user_explicit')
      || input.confirmed !== undefined && typeof input.confirmed !== 'boolean')) fail('INVALID_PATCH', '更正的标题、内容或来源无效');
    const check = () => { let allowed = false; try { allowed = authorize() === true; } catch {}
      if (!allowed) fail('FORBIDDEN', '当前主人授权或运行实例已变化，未修改记忆'); };
    check();
    const initial = this.load();
    if (initial.revision !== input.revision) fail('CONFLICT', '记忆已变化，请重新读取并核对后再保存');
    return this.withLock(() => {
      check(); const state = this.load();
      if (state.revision !== input.revision) fail('CONFLICT', '记忆已变化，请重新读取并核对后再保存');
      const record = state.records.find((item) => item.id === input.id);
      if (!record || context && !memoryScopeVisible(record, context, this.accountId)) fail('NOT_FOUND', '当前范围没有这条记忆');
      const existing = state.overlay.entries[record.id];
      const entry = existing ? copy(existing) : { fingerprint: fingerprint(record), current: stateOf(record), undo: [], history: [] };
      const at = new Date().toISOString();
      if (action === 'restore') {
        if (!entry.undo.length) fail('NOT_UNDOABLE', '这条记忆没有可撤销的更正或停用操作');
        entry.current = entry.undo.pop();
      } else {
        entry.undo.push(copy(entry.current)); entry.undo = entry.undo.slice(-20);
        if (action === 'forget') entry.current = { ...entry.current, status: 'forgotten', updatedAt: at };
        else {
          if (provenanceOverride !== undefined && !validProvenance(provenanceOverride)) fail('INVALID_PATCH', '可信记忆来源格式无效');
          const provenance = provenanceOverride || memoryProvenance({ sourceType: input.sourceType || 'user_explicit', confirmed: input.confirmed, actor });
          entry.current = { ...entry.current, summary: input.summary.trim(), detail: input.detail.trim(), provenance,
            status: provenance.confirmed === false ? 'unconfirmed' : 'active', updatedAt: at };
        }
      }
      entry.history.push({ at, action, summary: entry.current.summary.slice(0, 160), reason: input.reason || '', actor });
      entry.history = entry.history.slice(-50); state.overlay.entries[record.id] = entry;
      this.atomic(this.paths.overlay, JSON.stringify(state.overlay, null, 2) + '\n', () => {
        check(); if (this.load().revision !== input.revision) fail('CONFLICT', '写入前记忆已被外部修改，未覆盖');
      });
      const after = this.load(), { legacyFactId, ...saved } = after.records.find((item) => item.id === record.id);
      return { ok: true, saved: true, record: copy(saved), revision: after.revision,
        note: '已更新有效记忆视图；原档案、历史聊天和备份未被擦除，既有聊天里的旧引用仍可能存在。' };
    });
  }
}
