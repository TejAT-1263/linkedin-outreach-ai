// shared/constants.js — single source of truth used by background, popup and tests.

export const SCHEMA_VERSION = 2;

/** Message formats. `limit` is a hard cap for notes and a soft cap for DMs. */
export const FORMATS = Object.freeze({
  note:        Object.freeze({ id: 'note',      label: 'connection note',             limit: 300, hard: true }),
  'note-free': Object.freeze({ id: 'note-free', label: 'connection note (free plan)', limit: 200, hard: true }),
  dm:          Object.freeze({ id: 'dm',        label: 'direct message',              limit: 600, hard: false })
});
export const DEFAULT_FORMAT = 'note';

export const PURPOSES = Object.freeze(['Networking', 'Job', 'Referral', 'Collaboration']);
export const TONES = Object.freeze(['Formal', 'Neutral', 'Casual']);
export const THEMES = Object.freeze(['system', 'light', 'dark']);

/** Contact lifecycle in the tracker. */
export const STATUS = Object.freeze({
  DRAFTED: 'drafted',
  COPIED: 'copied',
  INSERTED: 'inserted',
  SENT: 'sent',
  REPLIED: 'replied',
  CLOSED: 'closed'
});
/** Statuses that mean "we reached out and are waiting". */
export const AWAITING = Object.freeze([STATUS.INSERTED, STATUS.SENT]);

export const LIMITS = Object.freeze({
  MAX_CONTACTS: 1000,          // tracker cap; oldest inactive entries are pruned past this
  MAX_TEMPLATES: 50,
  MAX_HOOKS: 2,
  MAX_TEXT: 5000,              // any user text crossing the message boundary
  MAX_RESUME_BYTES: 4 * 1024 * 1024,
  SESSION_TTL_MS: 6 * 60 * 60 * 1000,
  DEFAULT_FOLLOWUP_DAYS: 5,
  MIN_FOLLOWUP_DAYS: 1,
  MAX_FOLLOWUP_DAYS: 30,
  PAGE_SIZE: 30                // tracker renders in pages so 1000 contacts stay fast
});

export const ANTHROPIC = Object.freeze({
  URL: 'https://api.anthropic.com/v1/messages',
  MODEL: 'claude-haiku-5-5',
  VERSION: '2023-06-01',
  TIMEOUT_MS: 30_000,
  MAX_RETRIES: 2
});

export const ALARM_FOLLOWUPS = 'followups-check';
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Every action the background accepts. Anything else is rejected. */
export const ACTIONS = Object.freeze({
  READ_PROFILE: 'readProfile',
  GENERATE: 'generate',
  GENERATE_FOLLOWUP: 'generateFollowUp',
  APPLY_TEMPLATE: 'applyTemplate',
  INSERT: 'insert',
  TEST_KEY: 'testKey',
  PARSE_RESUME: 'parseResume',
  GET_STATE: 'getState',
  SAVE_SETTINGS: 'saveSettings',
  SAVE_PREFS: 'savePrefs',
  SAVE_SESSION: 'saveSession',
  GET_SESSION: 'getSession',
  TRACK: 'track',
  SET_STATUS: 'setStatus',
  MARK_FOLLOWED_UP: 'markFollowedUp',
  DELETE_CONTACT: 'deleteContact',
  LIST_CONTACTS: 'listContacts',
  CLEAR_CONTACTS: 'clearContacts',
  EXPORT_CSV: 'exportCsv',
  SAVE_TEMPLATE: 'saveTemplate',
  DELETE_TEMPLATE: 'deleteTemplate',
  RESET_ALL: 'resetAll'
});

/** Hook kinds grouped for reply-rate stats. */
export const HOOK_GROUP = Object.freeze({
  sharedCompany: 'common', sharedSchool: 'common', sharedSkill: 'common', sharedLocation: 'common',
  post: 'post', about: 'post',
  role: 'role', pastCompany: 'role', headline: 'role',
  skill: 'background', education: 'background',
  custom: 'custom', template: 'template'
});
export const GROUP_LABEL = Object.freeze({
  common: 'Common ground', post: 'Their post / About', role: 'Their role',
  background: 'Skills / education', custom: 'Your own detail', template: 'Template', none: 'No specific detail'
});
