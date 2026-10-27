/** Owner-facing video platform status. Snapshots perform no platform requests. */
import { ConfigStoreError } from './config-store.js';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class SocialPanel {
  constructor({ getRuntime, getBusy, probeDouyin }) { Object.assign(this, { getRuntime, getBusy, probeDouyin }); this.checking = false; this.requests = new Map(); }
  snapshot() {
    const runtime = this.getRuntime(), browser = runtime?.biliBrowser;
    const rows = runtime?.socialAccounts?.snapshot?.().platforms || [];
    const bound = key => { const row = rows.find(item => item.platform === key); return { configured: row?.state === 'bound', ...(row ? { paused: Boolean(row.safetyPause) } : {}) }; };
    const publication = key => ({ state: bound(key).configured ? 'account-bound-not-verified' : 'prepared-not-connected' });
    return { bilibili: { browse: browser?.status || { configured: false, enabled: false, readiness: 'not-verified' },
      account: bound('bilibili'), publication: publication('bilibili') },
    douyin: { browse: runtime?.douyinBrowser?.status || { configured: false, enabled: false, readiness: 'not-verified' },
      account: bound('douyin'), publication: publication('douyin') }, busy: this.checking };
  }
  async check(body, { authorize = () => false, signal } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['platform', 'requestId'].includes(key))
      || !['bilibili', 'douyin'].includes(body.platform) || !UUID.test(body.requestId || '')) throw new ConfigStoreError('INVALID_PATCH', '请选择可检查的平台');
    if (!authorize()) throw new ConfigStoreError('FORBIDDEN', '平台检查权限已失效');
    const requestId = body.requestId.toLowerCase(), runtime = this.getRuntime();
    const previous = this.requests.get(requestId);
    if (previous) {
      if (previous.runtime !== runtime) throw new ConfigStoreError('CONFLICT', '本次检查属于此前运行实例，请刷新后发起新检查');
      if (previous.platform !== body.platform) throw new ConfigStoreError('CONFLICT', '检查编号所属平台不同，请发起新检查');
      if (previous.revoked) throw new ConfigStoreError('FORBIDDEN', '本次检查的权限已失效，请刷新后发起新检查');
      if (previous.pending) throw new ConfigStoreError('BUSY', '本次检查正在进行'); return { test: previous.result.test, social: this.snapshot() };
    }
    if (this.checking || this.getBusy?.()) throw new ConfigStoreError('BUSY', '当前有任务，请稍后检查浏览');
    const browser = body.platform === 'bilibili' ? runtime?.biliBrowser : runtime?.douyinBrowser;
    if (!browser?.enabled || !browser?.configured || body.platform === 'douyin' && typeof this.probeDouyin !== 'function') throw new ConfigStoreError('UNAVAILABLE', '所选平台的浏览组件尚未就绪');
    const allowed = () => authorize() && this.getRuntime() === runtime;
    this.checking = true; this.requests.set(requestId, { runtime, platform: body.platform, pending: true });
    let test;
    try {
      test = body.platform === 'douyin' ? await this.probeDouyin({ runtime, authorize: allowed, signal }) : await browser.probe({ authorize: allowed, signal });
      if (!allowed()) throw new ConfigStoreError('FORBIDDEN', '平台检查权限或运行实例已变化');
    } catch (error) {
      if (!allowed()) { this.requests.set(requestId, { runtime, platform: body.platform, revoked: true }); throw new ConfigStoreError('FORBIDDEN', '平台检查权限或运行实例已变化'); }
      test = { ok: false, code: ['CANCELLED', 'TIMEOUT', 'CLEANUP_UNCONFIRMED', 'NO_RESULTS', 'NO_CONTENT', 'UNAVAILABLE'].includes(error?.code) ? error.code : 'READ_FAILED',
        note: '本次浏览检查未完成，没有进行登录或发布；可稍后手动检查。' };
    } finally { this.checking = false; }
    const result = { test, social: this.snapshot() }; this.requests.set(requestId, { runtime, platform: body.platform, result });
    while (this.requests.size > 64) this.requests.delete(this.requests.keys().next().value);
    return result;
  }
}
