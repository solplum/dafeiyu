// Only trusted, fixed vocabulary crosses the native process boundary. Never
// project browser exception messages, URLs, selectors, account IDs or DOM text.
export const NATIVE_EGO_PHASES = Object.freeze([
  'bootstrap', 'binding-list', 'binding-resume', 'identity-tabs', 'script-body', 'state-write',
  'native-process', 'native-receipt',
  'browse-identity-navigation', 'browse-identity-wait', 'browse-identity-read',
  'browse-feed-select', 'browse-feed-navigation', 'browse-navigation-wait',
  'browse-navigation-read', 'browse-navigation-click', 'browse-feed-wait',
  'browse-video-wait', 'browse-video-read', 'browse-next-before', 'browse-next-click', 'browse-next-wait',
  'browse-return-identity-navigation', 'browse-return-identity-wait', 'browse-return-identity-read',
  'browse-return-feed', 'browse-return-video-wait', 'browse-return-video-read', 'browse-receipt',
]);
export const NATIVE_EGO_ERROR_NAMES = Object.freeze([
  'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AbortError', 'TimeoutError',
]);
export const NATIVE_EGO_DIAGNOSTIC_CODES = Object.freeze([
  'BROWSER_UNKNOWN', 'RISK_CONTROL', 'ACCOUNT_MISMATCH', 'BINDINGS_REQUIRED', 'CLEANUP_UNCONFIRMED',
  'TIMEOUT', 'CANCELLED', 'OUTPUT_LIMIT', 'PROCESS_ERROR', 'PROCESS_EXIT', 'INVALID_RECEIPT',
]);
export function nativeEgoDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !NATIVE_EGO_PHASES.includes(value.phase) || !NATIVE_EGO_ERROR_NAMES.includes(value.name)
    || !NATIVE_EGO_DIAGNOSTIC_CODES.includes(value.code)) return null;
  return { phase: value.phase, name: value.name, code: value.code };
}
