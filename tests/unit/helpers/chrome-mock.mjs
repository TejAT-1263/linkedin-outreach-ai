// In-memory chrome.* mock with failure injection, for background unit tests.
function area() {
  let data = {};
  const faults = [];
  return {
    async get(keys) {
      if (faults.length && faults[0].op === 'get') throw faults.shift().err;
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      await new Promise(r => setTimeout(r, Math.random() * 2)); // widen race windows
      if (faults.length && faults[0].op === 'set') throw faults.shift().err;
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    async clear() { data = {}; },
    /** Make the next get/set throw `err`. */
    failNext(op, err) { faults.push({ op, err }); },
    _raw: () => data,
    _replace: (d) => { data = d; }
  };
}

export function installChromeMock() {
  const notifications = [];
  const opened = [];
  const badge = { text: '', fail: false };
  const tabsState = { tabs: new Map(), active: null, onSend: null, injectFails: false, injected: 0 };
  globalThis.chrome = {
    runtime: { id: 'testext', getManifest: () => ({ version: '3.3.0' }), getURL: (p) => `chrome-extension://testext/${p}` },
    storage: { local: area(), session: area() },
    action: {
      setBadgeText: async ({ text }) => { if (badge.fail) throw new Error('badge'); badge.text = text; },
      setBadgeBackgroundColor: async () => {}, setTitle: async () => {}
    },
    alarms: { created: [], existing: null, get: async function () { return this.existing; }, create: async function (name, info) { this.created.push({ name, info }); } },
    notifications: {
      fail: false,
      create(id, opts) { if (this.fail) throw new Error('blocked'); notifications.push({ id, ...opts }); },
      clear() {}
    },
    tabs: {
      create: ({ url }) => { opened.push(url); },
      get: async (id) => { if (!tabsState.tabs.has(id)) throw new Error('No tab with id'); return tabsState.tabs.get(id); },
      query: async () => (tabsState.active ? [tabsState.active] : []),
      sendMessage: async (id, msg) => tabsState.onSend(id, msg)
    },
    scripting: {
      executeScript: async () => { if (tabsState.injectFails) throw new Error('Cannot access contents'); tabsState.injected += 1; }
    }
  };
  return { notifications, badge, opened, tabsState };
}

export const POPUP = { id: 'testext', url: 'chrome-extension://testext/popup/popup.html' };

/** A tiny seeded PRNG (mulberry32) so fuzz failures are reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (n) => Math.floor(next() * n);
  const pick = (arr) => arr[int(arr.length)];
  const CHARS = ['a', 'Z', ' ', ',', '.', '|', '@', '·', '\n', '"', "'", '<', '>', '&', '{', '}', '$', '\\', 'é', 'ü', 'ñ', '中', '文', '😀', 'ا', '-', '–', '/', '?', '!', '0', '9', '\t'];
  const str = (max = 40) => Array.from({ length: int(max) }, () => pick(CHARS)).join('');
  const junk = () => pick([undefined, null, 0, -1, NaN, Infinity, true, {}, [], [1, 2], { a: 1 }, str(), str(400), () => 1, Symbol.for('x').description]);
  return { next, int, pick, str, junk };
}
