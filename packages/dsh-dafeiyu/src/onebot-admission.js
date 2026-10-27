import { activeQQIdentity } from './account-identities.js';

const exactQQ = (value) => (typeof value === 'string' || Number.isSafeInteger(value))
  && /^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : '';

/** Reject unrelated traffic before transcription, private data or a model call. */
export function isOwnerOneBotMessage(msg, { ownerQq, expectedSelfId, connectedAtMs } = {}) {
  const owner = String(ownerQq || '');
  const self = String(expectedSelfId || '');
  const raw = msg?.raw;
  if (connectedAtMs !== undefined && (!Number.isFinite(connectedAtMs) || connectedAtMs <= 0
    || !Number.isSafeInteger(raw?.time) || raw.time <= 0 || !Number.isSafeInteger(raw.time * 1000)
    || msg?.time !== raw.time * 1000 || raw.time * 1000 < Math.floor(connectedAtMs / 1000) * 1000)) return false;
  return Boolean(exactQQ(owner)) && Boolean(exactQQ(self)) && owner !== self
    && msg?.channel === 'onebot' && msg.isGroup === false
    && raw?.post_type === 'message' && raw.message_type === 'private'
    && raw.group_id === undefined && !msg.groupId
    && (msg.messageType === undefined || msg.messageType === 'private')
    && (msg.selfId === undefined || String(msg.selfId) === self)
    && exactQQ(raw.user_id) === owner && exactQQ(msg.userId) === owner
    && exactQQ(raw.self_id) === self
    && Boolean(String(raw.message_id ?? '')) && String(raw.message_id) === String(msg.messageId);
}

/** Additional configured users get only their own native conversation. */
export function isAllowedOneBotMessage(msg, { ownerQq, qqAccounts, expectedSelfId, connectedAtMs } = {}) {
  const peerId = String(msg?.userId || '');
  if (!activeQQIdentity({ ownerQq, qqAccounts }, peerId)) return false;
  // Reuse the exact envelope, receiver, timestamp and raw-source checks; this
  // parameter is the admitted sender for this check, never private authority.
  return isOwnerOneBotMessage(msg, { ownerQq: peerId, expectedSelfId, connectedAtMs });
}
