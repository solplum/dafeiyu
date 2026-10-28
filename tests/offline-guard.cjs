// Default deny: tests must explicitly provide their own fetch/WebSocket fixtures.
globalThis.fetch = async () => { throw new Error('Offline regression: network fetch is disabled'); };
globalThis.WebSocket = class OfflineWebSocket {
  constructor() { throw new Error('Offline regression: real WebSocket is disabled'); }
};
