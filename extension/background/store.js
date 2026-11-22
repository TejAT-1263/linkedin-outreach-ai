// background/store.js — the only module that touches chrome.storage.
// All writes go through a single promise queue, so concurrent read-modify-write
// operations (popup actions, alarms) can never overwrite each other.
import { LIMITS, THEMES, PURPOSES, TONES, FORMATS, STATUS, MODES, OPENAI } from '../shared/constants.js';
import { clean } from '../shared/text.js';
import { UserError } from '../shared/errors.js';
import { migrate, defaultSettings, defaultPrefs } from './migrate.js';
import { prune } from './tracker.js';

const local = () => chrome.storage.local;
const session = () => chrome.storage.session;

/** Writes fail loudly but helpfully (quota, disk, profile errors). */
async function save(obj, area = local()) {
  try {
    await area.set(obj);
  } catch (err) {
    if (/quota/i.test(String(err?.message))) throw new UserError('Storage is full. Export your tracker (Settings → Your data) and clear old contacts.', 'quota');
    throw new UserError('Could not save your changes. Please try again.', 'storage');
  }
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const s = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');
const n = (x) => (Number.isFinite(x) ? x : null);

/** Repair a contact read from storage; returns null if it's beyond saving. */
export function normalizeContact(raw, id) {
  if (!isObj(raw)) return null;
  const statuses = Object.values(STATUS);
  return {
    ...raw,
    id,
    name: s(raw.name, 120) || 'Unknown',
    headline: s(raw.headline, 220),
    company: s(raw.company, 120),
    profileUrl: /^https:\/\/www\.linkedin\.com\/in\//.test(raw.profileUrl) ? raw.profileUrl : '',
    purpose: PURPOSES.includes(raw.purpose) ? raw.purpose : 'Networking',
    format: FORMATS[raw.format] ? raw.format : 'note',
    message: s(raw.message, LIMITS.MAX_TEXT),
    status: statuses.includes(raw.status) ? raw.status : STATUS.DRAFTED,
    hooks: Array.isArray(raw.hooks) ? raw.hooks.filter(isObj).slice(0, 2) : [],
    history: Array.isArray(raw.history) ? raw.history.filter(isObj).slice(-20) : [],
    followUps: Number.isInteger(raw.followUps) && raw.followUps >= 0 ? raw.followUps : 0,
    createdAt: n(raw.createdAt) ?? 0,
    updatedAt: n(raw.updatedAt) ?? 0,
    insertedAt: n(raw.insertedAt),
    sentAt: n(raw.sentAt),
    lastTouchAt: n(raw.lastTouchAt),
    repliedAt: n(raw.repliedAt),
    notifiedAt: n(raw.notifiedAt)
  };
}

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
  return { ...defaultSettings(), ...sanitizeSettings(isObj(settings) ? settings : {}) };
}

export function sanitizeSettings(patch = {}) {
  const out = {};
  const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  if ('name' in patch) out.name = clean(text(patch.name)).slice(0, 80);
  if ('bio' in patch) out.bio = clean(text(patch.bio)).slice(0, 160);
  if ('background' in patch) out.background = text(patch.background).slice(0, 1000);
  if ('apiKey' in patch) out.apiKey = text(patch.apiKey).trim().slice(0, 300);
  if ('openaiKey' in patch) out.openaiKey = text(patch.openaiKey).trim().slice(0, 300);
  if ('openaiModel' in patch) out.openaiModel = validModel(patch.openaiModel);
  if ('resumeFileName' in patch) out.resumeFileName = clean(text(patch.resumeFileName)).slice(0, 120);
  if ('resumeBytes' in patch) out.resumeBytes = Number.isInteger(patch.resumeBytes) && patch.resumeBytes > 0 ? patch.resumeBytes : 0;
  if ('resumeSavedAt' in patch) out.resumeSavedAt = Number.isFinite(patch.resumeSavedAt) ? patch.resumeSavedAt : 0;
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
    await save({ settings });
    return settings;
  });
}

/** OpenAI model ids look like "gpt-6.2-sol"; anything else falls back to the default. */
export function validModel(m) {
  const v = typeof m === 'string' ? m.trim() : '';
  return /^[a-z0-9][a-z0-9._:-]{1,63}$/i.test(v) ? v : OPENAI.DEFAULT_MODEL;
}

const hint = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : '');

/** Public view of settings: never send the raw API keys back to the UI. */
export function publicSettings(s) {
  const { apiKey, openaiKey, ...rest } = s;
  return {
    ...rest,
    hasKey: !!apiKey, keyHint: hint(apiKey),
    hasOpenAIKey: !!openaiKey, openaiKeyHint: hint(openaiKey)
  };
}

// ─── Prefs ────────────────────────────────────────────────────────────────────
export async function getPrefs() {
  const { prefs } = await local().get('prefs');
  const p = isObj(prefs) ? prefs : {};
  const d = defaultPrefs();
  return {
    messageType: PURPOSES.includes(p.messageType) ? p.messageType : d.messageType,
    tone: TONES.includes(p.tone) ? p.tone : d.tone,
    format: FORMATS[p.format] ? p.format : d.format,
    mode: MODES.includes(p.mode) ? p.mode : d.mode
  };
}

export async function savePrefs(patch = {}) {
  return withLock(async () => {
    const prefs = await getPrefs();
    if (PURPOSES.includes(patch.messageType)) prefs.messageType = patch.messageType;
    if (TONES.includes(patch.tone)) prefs.tone = patch.tone;
    if (FORMATS[patch.format]) prefs.format = patch.format;
    if (MODES.includes(patch.mode)) prefs.mode = patch.mode;
    await save({ prefs });
    return prefs;
  });
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
async function readContacts() {
  const { contacts } = await local().get('contacts');
  if (!isObj(contacts)) return {};
  const out = {};
  for (const [id, raw] of Object.entries(contacts)) {
    const c = normalizeContact(raw, id);
    if (c) out[id] = c;
  }
  return out;
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
    await save({ contacts: prune(contacts) });
    return next === null ? null : contacts[id] || null;
  });
}

export async function clearContacts() {
  return withLock(() => save({ contacts: {} }));
}

// ─── Templates ────────────────────────────────────────────────────────────────
export async function listTemplates() {
  const { templates } = await local().get('templates');
  if (!Array.isArray(templates)) return [];
  return templates.filter(t => isObj(t) && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.text === 'string')
    .map(t => ({ ...t, uses: Number.isInteger(t.uses) ? t.uses : 0, purpose: PURPOSES.includes(t.purpose) ? t.purpose : '' }));
}

export async function saveTemplate(tpl) {
  return withLock(async () => {
    const templates = await listTemplates();
    const existing = templates.findIndex(t => t.id === tpl.id || t.name.toLowerCase() === tpl.name.toLowerCase());
    if (existing >= 0) templates[existing] = { ...templates[existing], ...tpl, id: templates[existing].id, updatedAt: Date.now() };
    else {
      if (templates.length >= LIMITS.MAX_TEMPLATES) throw new UserError(`You can keep up to ${LIMITS.MAX_TEMPLATES} templates. Delete one first.`);
      templates.unshift({ ...tpl, id: `tpl_${Date.now().toString(36)}`, uses: 0, createdAt: Date.now(), updatedAt: Date.now() });
    }
    await save({ templates });
    return templates;
  });
}

export async function deleteTemplate(id) {
  return withLock(async () => {
    const templates = (await listTemplates()).filter(t => t.id !== id);
    await save({ templates });
    return templates;
  });
}

export async function bumpTemplateUse(id) {
  return withLock(async () => {
    const templates = await listTemplates();
    const t = templates.find(x => x.id === id);
    if (t) { t.uses = (t.uses || 0) + 1; await save({ templates }); }
  });
}

// ─── Session (in-memory, cleared when the browser closes) ────────────────────
export async function saveSession(data) {
  await save({ draft: { ...data, savedAt: Date.now() } }, session());
}

export async function getSession(url) {
  const { draft } = await session().get('draft');
  if (!isObj(draft) || draft.url !== url || !Number.isFinite(draft.savedAt)) return null;
  if (Date.now() - draft.savedAt > LIMITS.SESSION_TTL_MS) return null;
  return draft;
}

// ─── Deep Mode results (session: cleared when the browser closes) ─────────────
const MAX_DEEP = 20;

export async function getDeep(id) {
  const { deep } = await session().get('deep');
  const e = isObj(deep) ? deep[id] : null;
  if (!isObj(e) || !Number.isFinite(e.at) || Date.now() - e.at > LIMITS.DEEP_CACHE_TTL_MS) return null;
  return e;
}

/** Merge `patch` into the entry for `id`; keeps the most recent MAX_DEEP profiles. */
export async function saveDeep(id, patch) {
  return withLock(async () => {
    const { deep } = await session().get('deep');
    const all = isObj(deep) ? deep : {};
    all[id] = { ...(isObj(all[id]) ? all[id] : {}), ...patch, at: Date.now() };
    const keep = Object.entries(all).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, MAX_DEEP);
    await save({ deep: Object.fromEntries(keep) }, session());
    return all[id];
  });
}

// ─── Resume (the PDF itself, kept on this device) ─────────────────────────────
export async function getResume() {
  const { resume } = await local().get('resume');
  if (!isObj(resume) || typeof resume.base64 !== 'string' || !resume.base64) return null;
  return { base64: resume.base64, fileName: s(resume.fileName, 120) || 'resume.pdf', bytes: Number(resume.bytes) || 0, savedAt: n(resume.savedAt) ?? 0 };
}

export async function saveResume({ base64, fileName, bytes }) {
  return withLock(async () => {
    const resume = { base64, fileName: s(fileName, 120) || 'resume.pdf', bytes, savedAt: Date.now() };
    await save({ resume });
    return resume;
  });
}

export async function deleteResume() {
  return withLock(() => local().remove('resume'));
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
