import { deny, exactKeys, safeUrl } from './platforms.mjs';
import { digest } from './account-store.mjs';
import { requestReceipt } from './request-receipt.mjs';
import { douyinVideoObservation, douyinVideoIdentityBinding } from './douyin-browse.mjs';

export const DOUYIN_INTERACTIONS = Object.freeze(['like', 'follow', 'comment']);
const pathBinding = value => Array.isArray(value) && value.length > 0 && value.length <= 8
  && value.every(part => typeof part === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part));
const text = (value, max = 300) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const selector = value => text(value, 500);

/** The model supplies an observation token, never a URL, account or recipient. */
export function douyinInteractionRequest(value) {
  exactKeys(value, ['action', 'expectedVideoId', 'text']);
  if (!DOUYIN_INTERACTIONS.includes(value.action)) deny('INVALID_OPERATION');
  if (typeof value.expectedVideoId !== 'string' || !/^media-[a-f0-9]{64}$/.test(value.expectedVideoId)) deny('INVALID_TARGET');
  if (value.action === 'comment') {
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 500
      || /[\x00-\x1f\x7f]/.test(value.text)) deny('INVALID_REQUEST');
  } else if (value.text !== undefined) deny('INVALID_REQUEST');
  return { action: value.action, expectedVideoId: value.expectedVideoId, ...(value.action === 'comment' ? { text: value.text } : {}) };
}

/** Only separately verified, owner-local bindings can enable a write. No
 * selector or platform endpoint is guessed from an offline fixture. */
export function douyinInteractionBinding(bindings, action) {
  if (!DOUYIN_INTERACTIONS.includes(action) || bindings?.platform !== 'douyin' || bindings.verified !== true
    || !bindings.accountId || !bindings.identity?.url || !douyinVideoIdentityBinding(bindings.browse?.videoIdentity)) return null;
  const value = bindings.interactions?.[action];
  try {
    if (!value || value.verified !== true || value.scope !== 'current-recommendation' || !value.control
      || !selector(value.control.selector) || !text(value.control.text)
      || !value.response || !pathBinding(value.response.okPath) || !pathBinding(value.response.idPath)
      || !pathBinding(value.response.actorPath) || !pathBinding(value.response.targetPath)
      || !['string', 'number', 'boolean'].includes(typeof value.response.okValue)) return null;
    const responseUrl = safeUrl('douyin', value.response.url);
    if (new URL(responseUrl).hostname !== 'www.douyin.com') return null;
    if (action === 'comment') {
      if (!selector(value.editor) || !pathBinding(value.response.textPath)) return null;
      if (value.opener && (!selector(value.opener.selector) || !text(value.opener.text))) return null;
    } else if (!['aria-pressed', 'data-state'].includes(value.control.stateAttribute)
      || !text(value.control.inactiveValue, 40) || !text(value.control.activeValue, 40)
      || value.control.inactiveValue === value.control.activeValue || !text(value.setValue, 40)
      || !pathBinding(value.response.statePath) || !['string', 'number', 'boolean'].includes(typeof value.response.stateValue)) return null;
    if (action === 'follow') {
      const author = bindings.browse?.authorIdentity;
      if (author?.verified !== true || author.attribute !== 'href' || !selector(author.selector)) return null;
    }
    requestReceipt(responseUrl, '__dfy_receipt_interaction_binding_check', value.request,
      { target: 'fixture-target', ...(action === 'comment' ? { text: 'fixture-text' } : { state: value.setValue }) });
    return structuredClone({ ...value, response: { ...value.response, url: responseUrl } });
  } catch { return null; }
}

export function douyinInteractionCapabilities(bindings) {
  return Object.fromEntries(DOUYIN_INTERACTIONS.map(action => [action, douyinInteractionBinding(bindings, action) ? 'ready' : 'bindings-required']));
}

// Evaluated only inside the currently owned recommendation tab. Stable author
// identity comes from a verified link in the same unique visible video card.
export function observeDouyinInteraction(videoExpression, authorIdentity, recipe, action) {
  return `(async()=>{const current=await (${videoExpression});if(!current||current.identityKind!=='platform-video-id'||!current.platformVideoId||current.media?.muted!==true||current.media?.paused!==true)return null;
    const visible=n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&getComputedStyle(n).visibility!=='hidden';};
    const rows=[...document.querySelectorAll('[data-e2e="feed-active-video"]')].filter(visible);if(rows.length!==1)return null;const row=rows[0];
    let authorId=null;const author=${JSON.stringify(authorIdentity || null)};
    if(author){const links=[...row.querySelectorAll(author.selector)].filter(visible);if(links.length!==1)return null;try{const u=new URL(links[0].getAttribute('href')||'',location.href);const m=/^\\/user\\/([A-Za-z0-9_-]{1,128})\\/?$/.exec(u.pathname);if(u.protocol!=='https:'||u.hostname!=='www.douyin.com'||u.port||u.username||u.password||u.search||u.hash||!m)return null;authorId=m[1];}catch{return null;}}
    const action=${JSON.stringify(action)},recipe=${JSON.stringify(recipe)},spec=action==='comment'&&recipe.opener?recipe.opener:recipe.control;
    const controls=[...row.querySelectorAll(spec.selector)].filter(visible);if(controls.length!==1)return null;const control=controls[0];
    if((control.innerText||control.textContent||'').trim()!==spec.text||control.disabled===true)return null;
    let alreadySet=false;if(action!=='comment'){const state=control.getAttribute(recipe.control.stateAttribute);if(state===recipe.control.activeValue)alreadySet=true;else if(state!==recipe.control.inactiveValue)return null;}
    return{current,authorId,target:action==='follow'?authorId:current.platformVideoId,alreadySet};})()`;
}

export function douyinInteractionObservation(bindings, action, recipe) {
  return observeDouyinInteraction(douyinVideoObservation(bindings.browse.videoIdentity),
    action === 'follow' ? bindings.browse.authorIdentity : null, recipe, action);
}

export function interactionSemanticDigest(accountId, generation, action, target) {
  // One autonomous comment per work, even if a model changes its wording or
  // starts another activity. Confirmed and unknown records are never replayed.
  return digest(['autonomous-douyin-interaction', accountId, action, target]);
}

export function validateInteractionCurrent(value, expectedVideoId) {
  return value?.id === expectedVideoId && value.identityKind === 'platform-video-id'
    && typeof value.platformVideoId === 'string' && /^[0-9]{10,25}$/.test(value.platformVideoId)
    && value.id === 'media-' + digest(['platform-video-id', value.platformVideoId])
    && value.media?.muted === true && value.media?.paused === true;
}
