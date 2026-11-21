/* Payroll: memory-only, origin-scoped session key relay.
 * Never writes a passphrase, encryption key, or payroll record to storage.
 * Browsers may terminate SharedWorkers; callers must tolerate a cache miss. */
'use strict';
const TTL_MS = 30 * 60 * 1000;
const sessions = new Map();
self.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = (message) => {
    const data = message.data;
    if (!data || typeof data.id !== 'number' || typeof data.scope !== 'string' ||
        data.scope.length > 200 || !/^[A-Za-z0-9:.-]+$/.test(data.scope)) return;
    const { id, action, scope } = data;
    const now = Date.now();
    for (const [name, stored] of sessions) if (now - stored.updated > TTL_MS) sessions.delete(name);
    let result = null;
    if (action === 'get') {
      const current = sessions.get(scope);
      if (current) {
        current.updated = now;
        result = { key: current.key, salt: current.salt };
      }
    } else if (action === 'set') {
      const key = data.key;
      if (key && key.type === 'secret' && key.algorithm?.name === 'AES-GCM' &&
          key.extractable === false && typeof data.salt === 'string' && data.salt.length < 100) {
        sessions.set(scope, {key, salt: data.salt, updated: now});
        result = true;
      }
    } else if (action === 'clear') {
      sessions.delete(scope);
      result = true;
    } else if (action === 'clear-all') {
      sessions.clear();
      result = true;
    }
    port.postMessage({id, result});
  };
  port.start();
};
