// In-memory chrome.* mock: enough of storage/action/alarms/notifications/runtime for router + store tests.
function area() {
  let data = {};
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) { await new Promise(r => setTimeout(r, Math.random() * 2)); Object.assign(data, structuredClone(obj)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    async clear() { data = {}; },
    _dump: () => data
  };
}

export function installChromeMock() {
  const notifications = [];
  const badge = { text: '' };
  globalThis.chrome = {
    runtime: { id: 'testext', getManifest: () => ({ version: '3.3.0' }), getURL: (p) => `chrome-extension://testext/${p}` },
    storage: { local: area(), session: area() },
    action: { setBadgeText: async ({ text }) => { badge.text = text; }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    alarms: { get: async () => null, create: async () => {} },
    notifications: { create: (id, opts) => notifications.push({ id, ...opts }), clear: () => {} },
    tabs: { create: () => {}, get: async () => { throw new Error('no tabs in unit tests'); }, query: async () => [] }
  };
  return { notifications, badge };
}

export const POPUP = { id: 'testext', url: 'chrome-extension://testext/popup/popup.html' };
