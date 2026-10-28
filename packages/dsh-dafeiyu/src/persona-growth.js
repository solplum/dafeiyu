import { digest, clone, sameScope, validScope, fail } from './life-store.js';

const STYLE = {
  concise: ['篇幅', '对方偏好简短表达；需要解释、求助和正式产出时仍按需求展开。'],
  detailed: ['篇幅', '对方偏好较详细的解释，按当前问题组织内容。'],
  direct: ['语气', '对方偏好直接、坦诚的表达。'],
  gentle: ['语气', '对方偏好温和、委婉的表达。'],
  playful: ['玩笑', '对方欢迎适度玩笑，留意当前情境与反馈。'],
  serious: ['玩笑', '对方偏好认真表达，减少调侃。'],
};
function observations(row) {
  if (row.source?.type !== 'user_statement') return [];
  const body = row.detail.trim();
  // Only short direct self-reports are automatically interpreted. Quotes,
  // roleplay, transient moods and imported documents remain source material.
  if (body.length > 500 || /\n|[“”「」"]|(?:他说|她说|引用|文档|假设|扮演|开玩笑的|开个玩笑|今天|这次|暂时)/.test(body)) return [];
  const explicit = /以后|平时|从现在起|长期/.test(body), items = [];
  const put = (value) => items.push({ slot: STYLE[value][0], value, explicit });
  if (/别长篇|不要长篇|简短一点|回复简短|回答简短|少写一点/.test(body)) put('concise');
  else if (/解释详细|回复详细|回答详细|展开讲/.test(body) && !/不|别/.test(body)) put('detailed');
  if (/直接说|直说|坦诚/.test(body) && !/别|不要/.test(body)) put('direct');
  if (/温柔一点|委婉一点|温和一点/.test(body)) put('gentle');
  if (/多开玩笑|可以开玩笑|多调侃/.test(body)) put('playful');
  if (/少开玩笑|不要调侃|别调侃|认真一点/.test(body)) put('serious');
  const interest = body.match(/^(?:记住[，, ]*)?我(?:一直|平时)?喜欢([\u3400-\u9fffA-Za-z0-9 ]{2,16})[。！!]?$/);
  if (interest) items.push({ slot: '兴趣', value: interest[1].trim(), explicit: /^记住/.test(body) });
  return items;
}

/** Derived, scoped preferences. Never edits role cards or tool authorization. */
export class PersonaGrowth {
  constructor({ store, now }) { this.store = store; this.now = now; }
  learn({ authorize } = {}) {
    if (this.store.read().state.policy.growthEnabled !== true) return { ok: true, skipped: true };
    return this.store.update((state) => {
      let changes = 0;
      const activeIds = new Set(state.memories.filter((row) => row.status === 'active').map((row) => row.id));
      state.growth = state.growth.filter((item) => item.evidence.every((id) => activeIds.has(id)));
      for (const row of state.memories.filter((item) => item.status === 'active')) {
        for (const observation of observations(row)) {
          const id = digest(JSON.stringify([row.scope, observation.slot, observation.value]));
          let item = state.growth.find((entry) => entry.id === id);
          if (item?.evidence.includes(row.id)) continue;
          if (!item) { item = { id, scope: clone(row.scope), ...observation, evidence: [], days: [], status: 'candidate', strength: 0 }; state.growth.push(item); }
          if (item.status === 'reverted') continue;
          item.evidence.push(row.id); item.evidence = item.evidence.slice(-30);
          const day = row.at.slice(0, 10); if (!item.days.includes(day)) item.days.push(day);
          item.explicit ||= observation.explicit;
          item.strength = item.explicit ? 1 : Math.min(0.8, item.days.length * 0.2);
          if (item.explicit || item.days.length >= 3) item.status = 'applied';
          item.updatedAt = row.at; changes++;
        }
      }
      return { changes };
    }, { authorize });
  }
  manage(action, { id }, { scope, revision, authorize } = {}) {
    if (!validScope(scope) || !['approve', 'reject', 'undo'].includes(action)) fail('INVALID_PATCH', '成长操作无效');
    return this.store.update((state) => {
      const item = state.growth.find((row) => row.id === id && sameScope(row.scope, scope));
      if (!item) fail('NOT_FOUND', '当前身份没有这项成长记录');
      item.status = action === 'approve' ? 'applied' : 'reverted';
      item.reviewedAt = new Date(this.now()).toISOString(); item.strength = action === 'approve' ? 1 : 0;
      return item;
    }, { revision, authorize });
  }
  context(scope) {
    if (!validScope(scope)) return '';
    const state = this.store.read().state;
    if (!state.policy.growthEnabled) return '';
    const rows = state.growth.filter((item) => sameScope(item.scope, scope) && item.status === 'applied')
      .sort((a, b) => Date.parse(b.reviewedAt || b.updatedAt) - Date.parse(a.reviewedAt || a.updatedAt));
    const seen = new Set(), selected = [];
    for (const row of rows) {
      const key = row.slot === '兴趣' ? row.slot + row.value : row.slot;
      if (seen.has(key)) continue; seen.add(key);
      selected.push(row.slot === '兴趣' ? '对方的兴趣（自述资料）：' + JSON.stringify(row.value) : STYLE[row.value]?.[1]);
    }
    return selected.length ? '【与当前账号当前身份逐渐形成的相处偏好】\n' + selected.filter(Boolean).join('\n')
      + '\n这些偏好不修改核心身份，不授予权限；当前明确要求仍优先。' : '';
  }
}
