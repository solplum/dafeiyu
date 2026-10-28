import { deny } from './platforms.mjs';

// Local ceilings, not a claim about platform thresholds. They apply to one
// platform account and survive reload; unknown and failed attempts still count.
export const DEFAULT_REQUEST_POLICY = Object.freeze({
  read: Object.freeze({ gapMs: 15000, perHour: 60 }),
  write: Object.freeze({ gapMs: 60000, perHour: 6, perDay: 20 }),
  login: Object.freeze({ gapMs: 300000, perHour: 3 }),
  poll: Object.freeze({ gapMs: 2000, perHour: 90 }),
});
export const RISK_CODES = new Set(['RISK_CONTROL', 'VERIFICATION_REQUIRED']);
export function requireNotPaused(row) { if (row?.safetyPause) deny('RISK_CONTROL'); }
export function consumeRequest(row, kind, now, policy = DEFAULT_REQUEST_POLICY) {
  requireNotPaused(row);
  if (!policy) return; // Test-only injection; never exposed as an HTTP/model setting.
  const limit = policy[kind]; if (!limit || !Number.isFinite(now)) deny('INVALID_REQUEST');
  const history = row.requestHistory || [];
  if (!Array.isArray(history) || history.some(event => !event || !Object.hasOwn(DEFAULT_REQUEST_POLICY, event.kind)
    || !Number.isFinite(event.at) || event.at > now + 60000)) deny('STORAGE_INVALID');
  const recent = history.filter(event => now - event.at < 86400000), own = recent.filter(event => event.kind === kind);
  if (own.some(event => now - event.at < limit.gapMs) || own.filter(event => now - event.at < 3600000).length >= limit.perHour
    || limit.perDay && own.length >= limit.perDay) deny('COOLDOWN');
  if (recent.length >= 2000) deny('COOLDOWN');
  row.requestHistory = [...recent, { kind, at: now }];
}
