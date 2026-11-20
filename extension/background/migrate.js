// background/migrate.js — upgrade stored data from older versions. Pure: data in → patch out.
// v3.1 (original): userApiKey, userName, userBio, resumeBase64, resumeFileName, recentContacts[]
// v3.2:            + userBackground, prefs, session, recentContacts[].status
// v3.3 (schema 2): settings{}, prefs{}, contacts{id→contact}, templates[], schemaVersion
import { SCHEMA_VERSION, STATUS, LIMITS, DEFAULT_FORMAT } from '../shared/constants.js';
import { contactIdFromUrl, canonicalProfileUrl } from '../shared/text.js';

export const LEGACY_KEYS = ['userApiKey', 'userName', 'userBio', 'userBackground', 'resumeBase64', 'resumeFileName', 'recentContacts', 'session'];

export function defaultSettings() {
  return {
    name: '', bio: '', background: '', apiKey: '', resumeFileName: '',
    followUpDays: LIMITS.DEFAULT_FOLLOWUP_DAYS, notifications: true, theme: 'system'
  };
}

export function defaultPrefs() {
  return { messageType: 'Networking', tone: 'Neutral', format: DEFAULT_FORMAT };
}

/**
 * @param {Record<string, any>} data everything currently in chrome.storage.local
 * @returns {{set: Record<string, any>, remove: string[], from: number}}
 */
export function migrate(data = {}) {
  const from = Number(data.schemaVersion) || (Object.keys(data).length ? 1 : 0);
  if (from >= SCHEMA_VERSION) return { set: {}, remove: [], from };

  const settings = { ...defaultSettings(), ...(data.settings || {}) };
  if (data.userName) settings.name = String(data.userName);
  if (data.userBio) settings.bio = String(data.userBio);
  if (data.userBackground) settings.background = String(data.userBackground);
  if (data.userApiKey) settings.apiKey = String(data.userApiKey);
  if (data.resumeFileName) settings.resumeFileName = String(data.resumeFileName);

  const prefs = { ...defaultPrefs(), ...(data.prefs || {}) };

  const contacts = { ...(data.contacts || {}) };
  for (const old of Array.isArray(data.recentContacts) ? data.recentContacts : []) {
    const id = contactIdFromUrl(old.profileUrl) || (old.name ? `name:${String(old.name).toLowerCase()}` : null);
    if (!id || contacts[id]) continue;
    const ts = Number(old.timestamp);
    const t = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
    const status = Object.values(STATUS).includes(old.status) ? old.status : STATUS.DRAFTED;
    contacts[id] = {
      id,
      profileUrl: canonicalProfileUrl(old.profileUrl) || '',
      name: String(old.name || 'Unknown'),
      headline: String(old.headline || ''),
      company: String(old.company || ''),
      purpose: String(old.purpose || 'Networking'),
      format: String(old.format || DEFAULT_FORMAT),
      message: String(old.message || ''),
      hooks: [],
      status,
      followUps: 0,
      createdAt: t,
      updatedAt: t,
      insertedAt: status === STATUS.INSERTED ? t : null,
      sentAt: null,
      lastTouchAt: status === STATUS.INSERTED ? t : null
    };
  }

  return {
    from,
    set: {
      schemaVersion: SCHEMA_VERSION,
      settings,
      prefs,
      contacts,
      templates: Array.isArray(data.templates) ? data.templates : []
    },
    // resumeBase64 is deliberately dropped: we no longer keep the PDF.
    remove: LEGACY_KEYS.filter(k => k in data)
  };
}
