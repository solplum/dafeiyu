// Selectors below were observed on the official recommendation page on 2026-10-26.
// This reads DOM text and playback metadata; it does not recognize video frames,
// audio, comments or recipients. Stable video identity requires a separate
// owner-local verified binding; no platform attribute name is guessed here.
export const DOUYIN_RECOMMEND = 'https://www.douyin.com/?recommend=1';
export const DOUYIN_RECOMMEND_LINK = 'a[href="https://www.douyin.com/?recommend=1&from_nav=1"]';
export const DOUYIN_NEXT = '[data-e2e="video-switch-next-arrow"]';
export function isRecommendationUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'www.douyin.com' && !u.port && !u.username && !u.password
    && u.pathname === '/' && u.searchParams.get('recommend') === '1' && !u.hash; } catch { return false; }
}
export function isDouyinLandingUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'www.douyin.com' && !u.port && !u.username && !u.password
    && ['/', '/jingxuan'].includes(u.pathname) && !u.hash
    && [...u.searchParams].every(([key, item]) => key === 'from_nav' && item === '1'); } catch { return false; }
}
export function douyinVideoIdentityBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'attribute,kind,verified'
    || value.verified !== true || value.kind !== 'platform-video-id'
    || typeof value.attribute !== 'string' || value.attribute.length > 80
    || !/^data-[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/.test(value.attribute)) return null;
  return { verified: true, kind: 'platform-video-id', attribute: value.attribute };
}
export function observeDouyinVideo(videoIdentity = null) {
  const visible = n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(n).visibility !== 'hidden'; };
  const active = [...document.querySelectorAll('[data-e2e="feed-active-video"]')].filter(visible);
  // Keep this document in manual-step mode, including dynamically inserted
  // media. This is a playback guard, not proof of whole-browser audio muting.
  const pauseMedia = root => {
    if (root.matches?.('video,audio')) { root.muted = true; root.pause(); }
    root.querySelectorAll?.('video,audio').forEach(v => { v.muted = true; v.pause(); });
  };
  if (!window.__dfy_manual_browse_pause_v1) {
    document.addEventListener('play', event => { if (event.target?.matches?.('video,audio')) { event.target.muted = true; event.target.pause(); } }, true);
    const observer = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(pauseMedia)));
    observer.observe(document.documentElement, { childList: true, subtree: true });
    Object.defineProperty(window, '__dfy_manual_browse_pause_v1', { value: true });
  }
  pauseMedia(document);
  const allVideos = [...document.querySelectorAll('video')];
  allVideos.forEach(v => { v.muted = true; v.pause(); });
  if (active.length !== 1) return null;
  const row = active[0], videos = [...row.querySelectorAll('video')].filter(visible);
  if (videos.length !== 1) return null;
  const video = videos[0];
  const text = (selector, limit) => { const nodes = [...row.querySelectorAll(selector)].filter(visible); return nodes.length === 1 ? (nodes[0].innerText || '').trim().slice(0, limit) : ''; };
  const author = text('[data-e2e="feed-video-nickname"]', 100), description = text('[data-e2e="video-desc"]', 700);
  if (!author || !description) return null;
  const rawId = videoIdentity ? row.getAttribute(videoIdentity.attribute) : null;
  const platformVideoId = typeof rawId === 'string' && /^[0-9]{10,25}(?![\s\S])/.test(rawId) ? rawId : null;
  const source = typeof video.currentSrc === 'string' && video.currentSrc ? video.currentSrc : null;
  const readyState = Number.isInteger(video.readyState) && video.readyState >= 0 && video.readyState <= 4 ? video.readyState : null;
  // A visible player can use srcObject while currentSrc is empty. A verified
  // stable work ID still identifies the row; an absent source proves no media
  // source fingerprint and cannot be used as a fallback identity.
  if (source === null && (platformVideoId === null || readyState === null || readyState < 2)) return null;
  const fingerprint = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    .then(bytes => 'media-' + [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join(''));
  return Promise.all([source === null ? null : fingerprint(source),
    fingerprint(platformVideoId === null ? source : JSON.stringify(['platform-video-id', platformVideoId]))]).then(([mediaSourceFingerprint, id]) => ({
    // Retain the historical media-* wire format. With verified stable identity,
    // id hashes the work ID alone and survives source/quality changes. Playback
    // metadata and a source fingerprint do not prove that a video was watched.
    id, mediaSourceFingerprint,
    identityKind: platformVideoId === null ? 'media-source-fingerprint' : 'platform-video-id', platformVideoId,
    url: 'https://www.douyin.com/?recommend=1', author, description,
    media: { muted: video.muted === true, paused: video.paused === true,
      readyState,
      currentTime: Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) / 1000 : null,
      duration: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) / 1000 : null }
  }));
}
export function douyinVideoObservation(videoIdentity) {
  return '(' + observeDouyinVideo.toString() + ')(' + JSON.stringify(douyinVideoIdentityBinding(videoIdentity)) + ')';
}
// Source availability can precede the visible author/description by a render.
// Reuse the full observation contract, including manual playback protection,
// rather than allowing an incomplete currentSrc-only projection through.
// A direct recommendation navigation can asynchronously settle on the official
// selection page. Wait for that state before choosing one observed navigation
// control; no repeated click, reload, arbitrary href, or current/next fallback.
export function douyinBrowseExpressions(videoIdentity) {
  const videoExpression = douyinVideoObservation(videoIdentity);
  const videoReady = `(async()=>Boolean(await (${videoExpression})))()`;
  const openNavigationExpression = `(async()=>{const isFeed=(${isRecommendationUrl.toString()}),isLanding=(${isDouyinLandingUrl.toString()});
  if(isFeed(location.href))return (await (${videoReady}))?'feed':'waiting';
  if(!isLanding(location.href))return 'invalid';
  const links=[...document.querySelectorAll(${JSON.stringify(DOUYIN_RECOMMEND_LINK)})].filter(n=>{const r=n.getBoundingClientRect(),style=getComputedStyle(n);return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&style.visibility!=='hidden'&&style.display!=='none'&&(n.innerText||'').trim()==='推荐';});
  return links.length===1?'landing':links.length>1?'ambiguous':'waiting';})()`;
  return { videoExpression, videoReady, openNavigationExpression,
    openNavigationReady: `(async()=>(await (${openNavigationExpression}))!=='waiting')()`,
    feedReady: `(async()=>(${isRecommendationUrl.toString()})(location.href)&&await (${videoReady}))()` };
}
export const { videoExpression: douyinVideoExpression, videoReady: douyinVideoReady,
  openNavigationExpression: douyinOpenNavigationExpression, openNavigationReady: douyinOpenNavigationReady,
  feedReady: douyinFeedReady } = douyinBrowseExpressions(null);
