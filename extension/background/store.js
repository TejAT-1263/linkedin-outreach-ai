// background/store.js — the only module that touches chrome.storage.
// All writes go through a single promise queue, so concurrent read-modify-write
// operations (popup actions, alarms) can never overwrite each other.
import { LIMITS, THEMES, PURPOSES, TONES, FORMATS, STATUS } from '../shared/constants.js';
import { clean } from '../shared/text.js';
import { migrate, defaultSettings, defaultPrefs } from './migrate.js';
import { prune } from './tracker.js';

const local = () => chrome.storage.local;
const session = () => chrome.storage.session;

let queue = Promise.resolve();
/** Run fn exclusively. Errors propagate to the caller but don't break the queue. */
export function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export async function init() {
  return withLock(async () => {
    const all = await local().get(null);
    const { set, remove, from } = migrate(all);
    if (Object.keys(set).length) await local().set(set);
    if (remove.length) await local().remove(remove);
    return { migratedFrom: from };
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────
export async function getSettings() {
  const { settings } = await local().get('settings');
  return { ...defaultSettings(), ...(settings || {}) };
}

export function sanitizeSettings(patch = {}) {
  const out = {};
  if ('name' in patch) out.name = clean(patch.name).slice(0, 80);
  if ('bio' in patch) out.bio = clean(patch.bio).slice(0, 160);
  if ('background' in patch) out.background = String(patch.background ?? '').slice(0, 1000);
  if ('apiKey' in patch) out.apiKey = String(patch.apiKey ?? '').trim().slice(0, 300);
  if ('resumeFileName' in patch) out.resumeFileName = clean(patch.resumeFileName).slice(0, 120);
  if ('followUpDays' in patch) {
    const d = Math.round(Number(patch.followUpDays));
    out.followUpDays = Number.isFinite(d) ? Math.min(LIMITS.MAX_FOLLOWUP_DAYS, Math.max(LIMITS.MIN_FOLLOWUP_DAYS, d)) : LIMITS.DEFAULT_FOLLOWUP_DAYS;
  }
  if ('notifications' in patch) out.notifications = !!patch.notifications;
  if ('theme' in patch) out.theme = THEMES.includes(patch.theme) ? patch.theme : 'system';
  return out;
}

export async function saveSettings(patch) {
  return withLock(async () => {
    const settings = { ...(await getSettings()), ...sanitizeSettings(patch) };
    await local().set({ settings });
    return settings;
  });
}

/** Public view of settings: never send the raw API key back to the UI. */
export function publicSettings(s) {
  const { apiKey, ...rest } = s;
  return { ...rest, hasKey: !!apiKey, keyHint: apiKey ? `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}` : '' };
}

// ─── Prefs ────────────────────────────────────────────────────────────────────
export async function getPrefs() {
  const { prefs } = await local().get('prefs');
  return { ...defaultPrefs(), ...(prefs || {}) };
}

export async function savePrefs(patch = {}) {
  return withLock(async () => {
    const prefs = await getPrefs();
    if (PURPOSES.includes(patch.messageType)) prefs.messageType = patch.messageType;
    if (TONES.includes(patch.tone)) prefs.tone = patch.tone;
    if (FORMATS[patch.format]) prefs.format = patch.format;
    await local().set({ prefs });
    return prefs;
  });
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
async function readContacts() {
  const { contacts } = await local().get('contacts');
  return contacts || {};
}

export async function listContacts() {
  return Object.values(await readContacts()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getContact(id) {
  return (await readContacts())[id] || null;
}

/** Create or update a contact; `mutate(existing|null) → next` runs inside the lock. */
export async function mutateContact(id, mutate) {
  return withLock(async () => {
    const contacts = await readContacts();
    const next = mutate(contacts[id] || null);
    if (next === null) delete contacts[id];
    else contacts[id] = { ...next, id, updatedAt: Date.now() };
    await local().set({ contacts: prune(contacts) });
    return next === null ? null : contacts[id] || null;
  });
}

export async function clearContacts() {
  return withLock(() => local().set({ contacts: {} }));
}

// ─── Templates ────────────────────────────────────────────────────────────────
export async function listTemplates() {
  const { templates } = await local().get('templates');
  return Array.isArray(templates) ? templates : [];
}

export async function saveTemplate(tpl) {
  return withLock(async () => {
    const templates = await listTemplates();
    const existing = templates.findIndex(t => t.id === tpl.id || t.name.toLowerCase() === tpl.name.toLowerCase());
    if (existing >= 0) templates[existing] = { ...templates[existing], ...tpl, id: templates[existing].id, updatedAt: Date.now() };
    else {
      if (templates.length >= LIMITS.MAX_TEMPLATES) throw new Error(`You can keep up to ${LIMITS.MAX_TEMPLATES} templates. Delete one first.`);
      templates.unshift({ ...tpl, id: `tpl_${Date.now().toString(36)}`, uses: 0, createdAt: Date.now(), updatedAt: Date.now() });
    }
    await local().set({ templates });
    return templates;
  });
}

export async function deleteTemplate(id) {
  return withLock(async () => {
    const templates = (await listTemplates()).filter(t => t.id !== id);
    await local().set({ templates });
    return templates;
  });
}

export async function bumpTemplateUse(id) {
  return withLock(async () => {
    const templates = await listTemplates();
    const t = templates.find(x => x.id === id);
    if (t) { t.uses = (t.uses || 0) + 1; await local().set({ templates }); }
  });
}

// ─── Session (in-memory, cleared when the browser closes) ────────────────────
export async function saveSession(data) {
  await session().set({ draft: { ...data, savedAt: Date.now() } });
}

export async function getSession(url) {
  const { draft } = await session().get('draft');
  if (!draft || draft.url !== url) return null;
  if (Date.now() - draft.savedAt > LIMITS.SESSION_TTL_MS) return null;
  return draft;
}

// ─── Reset ────────────────────────────────────────────────────────────────────
export async function resetAll() {
  return withLock(async () => {
    await local().clear();
    await session().clear();
    const { set } = migrate({});
    await local().set(set);
  });
}

export { STATUS };
