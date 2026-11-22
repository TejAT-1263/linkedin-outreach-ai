// background/router.js — every popup request lands here. Validates, dispatches, shapes errors.
import { ACTIONS, FORMATS, PURPOSES, TONES, STATUS, LIMITS, DEFAULT_FORMAT, OPENAI } from '../shared/constants.js';
import { splitList, uniq, contactIdFromUrl, canonicalProfileUrl, clean } from '../shared/text.js';
import { normalizeProfile, buildHooks, sanitizeHooks } from './hooks.js';
import { localMessage, localFollowUp, openerFor } from './writer-local.js';
import { aiMessage, aiFollowUp, aiResumeFacts } from './writer-ai.js';
import { templatize, applyTemplate, validateTemplate } from './templates.js';
import { computeStats, isDue, followUpDueAt, toCsv } from './tracker.js';
import { createClient, ApiError } from './anthropic.js';
import { createOpenAIClient } from './openai.js';
import { parseProfile, researchProfile, researchHooks, diagnosticsFor, keepAlive, FATAL_CODES } from './deep.js';
import { UserError } from '../shared/errors.js';
import * as linkedin from './linkedin.js';
import * as store from './store.js';
import * as followups from './followups.js';

const client = createClient();
const openai = createOpenAIClient();
/** Deep Mode web research in flight, by contact id — survives the popup closing. */
const deepRuns = new Map();

// ─── Input guards ─────────────────────────────────────────────────────────────
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const text = (v, max = LIMITS.MAX_TEXT) => String(v ?? '').slice(0, max);
const int = (v) => (Number.isInteger(v) ? v : undefined);
const fmtOf = (id) => FORMATS[id] || FORMATS[DEFAULT_FORMAT];

async function sender() {
  const s = await store.getSettings();
  return { name: s.name, bio: s.bio, terms: uniq(splitList(s.background)), apiKey: s.apiKey, followUpDays: s.followUpDays };
}

function pushHistory(c, type) {
  return [...(c.history || []), { at: Date.now(), type }].slice(-20);
}

/** Record a fresh draft without downgrading someone we've already contacted. */
async function trackDraft({ profile, message, purpose, format, hooks, fromTemplate }) {
  const id = contactIdFromUrl(profile.profileUrl);
  if (!id) return null;
  return store.mutateContact(id, (prev) => {
    const now = Date.now();
    const base = prev || { createdAt: now, status: STATUS.DRAFTED, followUps: 0, history: [] };
    const contacted = [STATUS.INSERTED, STATUS.SENT, STATUS.REPLIED, STATUS.CLOSED].includes(base.status);
    return {
      ...base,
      profileUrl: canonicalProfileUrl(profile.profileUrl),
      name: profile.name || base.name || 'Unknown',
      headline: profile.headline || base.headline || '',
      company: profile.currentCompany || base.company || '',
      // Once contacted, keep the message that was actually sent.
      ...(contacted ? {} : {
        message, purpose, format, fromTemplate: !!fromTemplate,
        hooks: hooks.slice(0, 2).map(h => ({ kind: h.kind, label: h.label, value: typeof h.value === 'string' ? h.value : h.label }))
      }),
      history: prev ? base.history : pushHistory(base, 'drafted')
    };
  });
}

const safeMessage = (err) => (err instanceof UserError || err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

async function openaiSettings() {
  const s = await store.getSettings();
  if (!s.openaiKey) throw new UserError('Add your OpenAI key in Settings to use Deep Mode.', 'no_openai_key');
  return s;
}

/** Start L2 for a profile (once per profile at a time). Never rejects. */
function startResearch(id, profile, s) {
  if (deepRuns.has(id)) return deepRuns.get(id);
  const run = (async () => {
    const t0 = Date.now();
    let l2;
    let research = null;
    try {
      research = await keepAlive(researchProfile(openai, s.openaiKey, s.openaiModel, profile));
      l2 = { status: 'done', news: research.companyNews.length, work: research.publicWork.length, ms: Date.now() - t0 };
    } catch (err) {
      if (!(err instanceof ApiError || err instanceof UserError)) console.error('[outreach] deep research failed', err);
      l2 = { status: 'failed', note: safeMessage(err), ms: Date.now() - t0 };
    }
    try { await store.saveDeep(id, { l2, research }); } catch { /* the result is still returned below */ }
    return { l2, research };
  })();
  deepRuns.set(id, run);
  run.finally(() => deepRuns.delete(id));
  return run;
}

function contactView(c, followUpDays, now = Date.now()) {
  if (!c) return null;
  return { ...c, due: isDue(c, now, followUpDays), dueAt: followUpDueAt(c, followUpDays) };
}

async function afterContactChange() {
  try { await followups.refresh({ notify: false }); } catch { /* badge is best-effort */ }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────
const handlers = {
  async [ACTIONS.GET_STATE]() {
    await afterContactChange(); // keep the toolbar badge accurate whenever the popup opens
    const [settings, prefs, templates, contacts] = await Promise.all([
      store.getSettings(), store.getPrefs(), store.listTemplates(), store.listContacts()
    ]);
    return {
      settings: store.publicSettings(settings),
      prefs,
      templates,
      stats: computeStats(contacts, Date.now(), settings.followUpDays),
      version: chrome.runtime.getManifest().version
    };
  },

  async [ACTIONS.READ_PROFILE]({ tabId }) {
    const raw = await linkedin.scrape(int(tabId));
    const profile = normalizeProfile(raw);
    if (!profile.name) throw new UserError("Couldn't find a name on this page. Is it a profile page?");
    profile.profileUrl = canonicalProfileUrl(profile.profileUrl) || profile.profileUrl;
    const me = await sender();
    const id = contactIdFromUrl(profile.profileUrl);
    const existing = id ? await store.getContact(id) : null;
    return {
      profile,
      hooks: buildHooks(profile, me),
      diagnostics: raw.diagnostics || null,
      contact: contactView(existing, me.followUpDays)
    };
  },

  // ─── Deep Mode ───────────────────────────────────────────────────────────────
  /** L1: read the page, then let OpenAI clean it up. Kicks off L2 right away. */
  async [ACTIONS.DEEP_PARSE]({ tabId }) {
    const s = await openaiSettings();
    const raw = await linkedin.scrape(int(tabId));
    const scraped = normalizeProfile(raw);
    if (!scraped.name) throw new UserError("Couldn't find a name on this page. Is it a profile page?");
    scraped.profileUrl = canonicalProfileUrl(scraped.profileUrl) || scraped.profileUrl;
    const id = contactIdFromUrl(scraped.profileUrl);
    if (!id) throw new UserError('Open someone’s profile (linkedin.com/in/…) first.', 'not_profile');

    const t0 = Date.now();
    let profile = scraped;
    let l1;
    try {
      const parsed = await keepAlive(parseProfile(openai, s.openaiKey, s.openaiModel, { scraped, rawText: text(raw.rawText, LIMITS.MAX_RAW_PROFILE_TEXT) }));
      profile = parsed.profile;
      l1 = { status: 'done', model: parsed.model, filled: parsed.filled, ms: Date.now() - t0 };
    } catch (err) {
      if (!(err instanceof ApiError || err instanceof UserError)) console.error('[outreach] deep parse failed', err);
      l1 = { status: 'failed', note: safeMessage(err), code: err?.code || null, ms: Date.now() - t0 };
    }

    // A rejected key, empty account or unknown model would fail L2 the same way: don't spend the call.
    const fatal = l1.status === 'failed' && FATAL_CODES.includes(l1.code);
    const l2 = fatal ? { status: 'skipped', note: l1.note } : { status: 'running' };
    await store.saveDeep(id, { url: profile.profileUrl, profile, l1, l2, research: null });
    if (!fatal) startResearch(id, profile, s);

    const me = await sender();
    const existing = await store.getContact(id);
    return {
      profile,
      hooks: buildHooks(profile, me),
      diagnostics: diagnosticsFor(profile),
      contact: contactView(existing, me.followUpDays),
      l1, l2
    };
  },

  /** L2: wait for (or restart) the web research for this profile, then rebuild the hooks. */
  async [ACTIONS.DEEP_ENRICH]({ profileUrl }) {
    const id = contactIdFromUrl(canonicalProfileUrl(text(profileUrl, 300)));
    const cached = id ? await store.getDeep(id) : null;
    if (!cached?.profile) throw new UserError('Run “Read + research” first.', 'no_deep');
    let result;
    if (deepRuns.has(id)) result = await deepRuns.get(id);
    else if (cached.l2 && !['running', 'failed'].includes(cached.l2.status)) result = { l2: cached.l2, research: cached.research };
    else result = await startResearch(id, cached.profile, await openaiSettings()); // interrupted or retrying a failure

    const me = await sender();
    return {
      l2: result.l2,
      research: result.research,
      hooks: buildHooks(cached.profile, me, researchHooks(result.research))
    };
  },

  /** Restore the Deep Mode panel when the popup reopens. */
  async [ACTIONS.DEEP_STATUS]({ url }) {
    const id = contactIdFromUrl(canonicalProfileUrl(text(url, 300)));
    const cached = id ? await store.getDeep(id) : null;
    if (!cached) return { deep: null };
    let l2 = cached.l2 || null;
    // The background restarted mid-run: report it instead of spinning forever.
    if (l2?.status === 'running' && !deepRuns.has(id)) l2 = { status: 'failed', note: 'The research was interrupted. Click “Read + research” to run it again.' };
    return { deep: { l1: cached.l1 || null, l2, research: cached.research || null } };
  },

  async [ACTIONS.TEST_OPENAI_KEY]({ apiKey, model }) {
    const key = text(apiKey, 300).trim() || (await store.getSettings()).openaiKey;
    if (!key) return { valid: false, reason: 'Enter a key first.' };
    if (/^sk-ant-/.test(key)) return { valid: false, reason: 'That is an Anthropic key. OpenAI keys start with "sk-" (often "sk-proj-").' };
    if (!/^sk-[\w-]{16,}$/.test(key)) return { valid: false, reason: 'OpenAI keys start with "sk-" (often "sk-proj-").' };
    const m = store.validModel(model);
    try {
      await openai.respond(key, { model: m, input: 'Reply with the single word: OK', maxOutputTokens: 300, timeoutMs: OPENAI.TEST_TIMEOUT_MS });
    } catch (err) {
      // The key and model were accepted even if the tiny test answer was cut short.
      if (!(err instanceof ApiError) || !['incomplete', 'empty', 'refusal'].includes(err.code)) return { valid: false, reason: safeMessage(err) };
    }
    const settings = await store.saveSettings({ openaiKey: key, openaiModel: m });
    return { valid: true, settings: store.publicSettings(settings) };
  },

  async [ACTIONS.GENERATE](p) {
    const profile = normalizeProfile(p.profile);
    const hooks = sanitizeHooks(p.hooks).filter(h => h.selected);
    const messageType = oneOf(p.messageType, PURPOSES, 'Networking');
    const tone = oneOf(p.tone, TONES, 'Neutral');
    const fmt = fmtOf(p.format);
    const me = await sender();
    const args = { p: profile, me, hooks, messageType, tone, fmt };
    const message = me.apiKey
      ? await aiMessage(client, me.apiKey, { ...args, previousMessage: text(p.previousMessage, 2000) })
      : localMessage({ ...args, variant: int(p.variant) || 0 });
    const contact = await trackDraft({ profile, message, purpose: messageType, format: fmt.id, hooks });
    await afterContactChange();
    return { message, source: me.apiKey ? 'ai' : 'local', limit: fmt.limit, contact: contactView(contact, me.followUpDays) };
  },

  async [ACTIONS.APPLY_TEMPLATE](p) {
    const templates = await store.listTemplates();
    const tpl = templates.find(t => t.id === p.templateId);
    if (!tpl) throw new UserError('That template no longer exists.');
    const profile = normalizeProfile(p.profile);
    const hooks = sanitizeHooks(p.hooks).filter(h => h.selected);
    const me = await sender();
    const message = applyTemplate(tpl.text, {
      firstName: profile.firstName, company: profile.currentCompany, title: profile.currentTitle,
      hook: openerFor(hooks[0], int(p.variant) || 0), myName: me.name
    });
    await store.bumpTemplateUse(tpl.id);
    const contact = await trackDraft({ profile, message, purpose: tpl.purpose || 'Networking', format: oneOf(p.format, Object.keys(FORMATS), DEFAULT_FORMAT), hooks, fromTemplate: true });
    await afterContactChange();
    return { message, source: 'template', templateName: tpl.name, contact: contactView(contact, me.followUpDays) };
  },

  async [ACTIONS.GENERATE_FOLLOWUP]({ contactId, variant }) {
    const c = await store.getContact(text(contactId, 300));
    if (!c) throw new UserError('Contact not found.');
    const me = await sender();
    const prefs = await store.getPrefs();
    const limit = c.format === 'dm' ? FORMATS.dm.limit : 400;
    const message = me.apiKey
      ? await aiFollowUp(client, me.apiKey, { contact: c, me, tone: prefs.tone, limit })
      : localFollowUp({ contact: c, me, tone: prefs.tone, variant: int(variant) || 0, limit });
    return { message, source: me.apiKey ? 'ai' : 'local' };
  },

  async [ACTIONS.INSERT]({ tabId, text: t, replace, contactId }) {
    const body = text(t).trim();
    if (!body) throw new UserError('Nothing to insert.');
    const res = await linkedin.insert(int(tabId), body, !!replace);
    if (res.ok && contactId) {
      await store.mutateContact(text(contactId, 300), prev => {
        if (!prev) return null;
        if ([STATUS.SENT, STATUS.REPLIED, STATUS.CLOSED].includes(prev.status)) return prev;
        const now = Date.now();
        return { ...prev, status: STATUS.INSERTED, message: body, insertedAt: now, lastTouchAt: now, history: pushHistory(prev, 'inserted') };
      });
      await afterContactChange();
    }
    return res;
  },

  async [ACTIONS.TRACK]({ contactId, event, message }) {
    if (event !== 'copied') throw new UserError('Unknown event.');
    const c = await store.mutateContact(text(contactId, 300), prev => {
      if (!prev) return null;
      const next = { ...prev, message: message ? text(message) : prev.message };
      if (prev.status === STATUS.DRAFTED) { next.status = STATUS.COPIED; next.history = pushHistory(prev, 'copied'); }
      return next;
    });
    return { contact: c };
  },

  async [ACTIONS.SET_STATUS]({ contactId, status }) {
    const allowed = [STATUS.SENT, STATUS.REPLIED, STATUS.CLOSED, STATUS.DRAFTED];
    if (!allowed.includes(status)) throw new UserError('Unknown status.');
    const now = Date.now();
    const c = await store.mutateContact(text(contactId, 300), prev => {
      if (!prev) return null;
      const next = { ...prev, status, history: pushHistory(prev, status) };
      if (status === STATUS.SENT) { next.sentAt = prev.sentAt || now; next.lastTouchAt = now; }
      if (status === STATUS.REPLIED) next.repliedAt = now;
      return next;
    });
    await afterContactChange();
    const s = await store.getSettings();
    return { contact: contactView(c, s.followUpDays) };
  },

  async [ACTIONS.MARK_FOLLOWED_UP]({ contactId, message }) {
    const now = Date.now();
    const c = await store.mutateContact(text(contactId, 300), prev => prev && ({
      ...prev,
      status: STATUS.SENT,
      sentAt: prev.sentAt || prev.insertedAt || now,
      lastTouchAt: now,
      followUps: (prev.followUps || 0) + 1,
      lastFollowUp: text(message, 2000),
      notifiedAt: null,
      history: pushHistory(prev, 'followed-up')
    }));
    await afterContactChange();
    const s = await store.getSettings();
    return { contact: contactView(c, s.followUpDays) };
  },

  async [ACTIONS.DELETE_CONTACT]({ contactId }) {
    await store.mutateContact(text(contactId, 300), () => null);
    await afterContactChange();
    return {};
  },

  async [ACTIONS.LIST_CONTACTS]({ query = '', filter = 'all', offset = 0, limit = LIMITS.PAGE_SIZE }) {
    const [all, s] = await Promise.all([store.listContacts(), store.getSettings()]);
    const now = Date.now();
    const q = clean(query).toLowerCase();
    const views = all.map(c => contactView(c, s.followUpDays, now));
    const filtered = views.filter(c => {
      if (q && !`${c.name} ${c.headline} ${c.company}`.toLowerCase().includes(q)) return false;
      if (filter === 'due') return c.due;
      if (filter === 'waiting') return [STATUS.INSERTED, STATUS.SENT].includes(c.status);
      if (filter === 'replied') return c.status === STATUS.REPLIED;
      if (filter === 'drafts') return [STATUS.DRAFTED, STATUS.COPIED].includes(c.status);
      return true;
    });
    // Due follow-ups float to the top of "All".
    if (filter === 'all') filtered.sort((a, b) => (b.due - a.due) || (b.updatedAt - a.updatedAt));
    const start = Math.max(0, int(offset) || 0);
    const size = Math.min(100, Math.max(1, int(limit) || LIMITS.PAGE_SIZE));
    return {
      items: filtered.slice(start, start + size),
      total: filtered.length,
      stats: computeStats(all, now, s.followUpDays)
    };
  },

  async [ACTIONS.CLEAR_CONTACTS]() { await store.clearContacts(); await afterContactChange(); return {}; },

  async [ACTIONS.EXPORT_CSV]() {
    const contacts = await store.listContacts();
    return { csv: toCsv(contacts), filename: `outreach-tracker-${new Date().toISOString().slice(0, 10)}.csv`, count: contacts.length };
  },

  async [ACTIONS.SAVE_SETTINGS](patch = {}) {
    const p = { ...patch };
    if (p.clearKey) p.apiKey = '';
    else if (typeof p.apiKey !== 'string' || !p.apiKey.trim()) delete p.apiKey; // keep the stored key
    if (p.clearOpenAIKey) p.openaiKey = '';
    else if (typeof p.openaiKey !== 'string' || !p.openaiKey.trim()) delete p.openaiKey;
    for (const k of ['clearKey', 'clearOpenAIKey', 'resumeFileName', 'resumeBytes', 'resumeSavedAt']) delete p[k]; // resume fields follow the stored PDF
    const s = await store.saveSettings(p);
    await afterContactChange(); // follow-up days may have changed
    return { settings: store.publicSettings(s) };
  },

  async [ACTIONS.SAVE_PREFS](patch) { return { prefs: await store.savePrefs(patch) }; },

  async [ACTIONS.SAVE_SESSION](data = {}) {
    await store.saveSession({
      url: text(data.url, 300), profile: data.profile ? normalizeProfile(data.profile) : null,
      hooks: sanitizeHooks(data.hooks), variant: int(data.variant) || 0,
      message: text(data.message), source: text(data.source, 20), diagnostics: data.diagnostics || null,
      templateId: text(data.templateId, 40)
    });
    return {};
  },

  async [ACTIONS.GET_SESSION]({ url }) { return { session: await store.getSession(text(url, 300)) }; },

  async [ACTIONS.TEST_KEY]({ apiKey }) {
    const key = text(apiKey, 300).trim() || (await store.getSettings()).apiKey;
    if (!key) return { valid: false, reason: 'Enter a key first.' };
    if (!/^sk-ant-/.test(key)) return { valid: false, reason: 'Anthropic keys start with "sk-ant-".' };
    try {
      await client.call(key, { content: 'Reply with the single word: OK', maxTokens: 5 });
      await store.saveSettings({ apiKey: key });
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: err.message };
    }
  },

  /** Keep the PDF on this device; with an Anthropic key, also fill in "Your background" from it. */
  async [ACTIONS.PARSE_RESUME]({ base64, fileName }) {
    const b64 = String(base64 || '');
    if (!b64 || b64.length > Math.ceil(LIMITS.MAX_RESUME_BYTES * 4 / 3) + 16) throw new UserError('That file is over 4 MB.');
    if (!b64.startsWith('JVBER')) throw new UserError("That file isn't a valid PDF.", 'not_pdf'); // "%PDF" in base64
    const name = text(fileName, 120) || 'resume.pdf';
    const bytes = Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    const saved = await store.saveResume({ base64: b64, fileName: name, bytes });
    const patch = { resumeFileName: saved.fileName, resumeBytes: bytes, resumeSavedAt: saved.savedAt };

    const s = await store.getSettings();
    let facts = null;
    let parseError = '';
    if (s.apiKey) {
      try {
        facts = await aiResumeFacts(client, s.apiKey, b64);
        patch.background = uniq([...splitList(s.background), ...facts.companies, ...facts.schools, ...facts.skills, facts.location].filter(Boolean)).join(', ');
        patch.bio = s.bio || facts.summary;
      } catch (err) {
        parseError = safeMessage(err); // the PDF is saved either way
      }
    }
    const settings = await store.saveSettings(patch);
    return { stored: true, facts, parseError, settings: store.publicSettings(settings) };
  },

  async [ACTIONS.GET_RESUME]() { return { resume: await store.getResume() }; },

  async [ACTIONS.DELETE_RESUME]() {
    await store.deleteResume();
    const settings = await store.saveSettings({ resumeFileName: '', resumeBytes: 0, resumeSavedAt: 0 });
    return { settings: store.publicSettings(settings) };
  },

  async [ACTIONS.SAVE_TEMPLATE]({ name, text: draft, purpose, ctx = {} }) {
    const me = await sender();
    const tpl = validateTemplate({
      name,
      purpose: oneOf(purpose, PURPOSES, ''),
      text: templatize(text(draft, 2000), {
        firstName: text(ctx.firstName, 80), company: text(ctx.company, 120), title: text(ctx.title, 120),
        myName: me.name, hookSentence: text(ctx.hookSentence, 400)
      })
    });
    return { templates: await store.saveTemplate(tpl) };
  },

  async [ACTIONS.DELETE_TEMPLATE]({ id }) { return { templates: await store.deleteTemplate(text(id, 40)) }; },

  async [ACTIONS.RESET_ALL]() { await store.resetAll(); await afterContactChange(); return {}; }
};

// ─── Dispatch ─────────────────────────────────────────────────────────────────
export function isTrustedSender(sender) {
  // Only our own extension pages (popup) may call the background.
  return sender?.id === chrome.runtime.id && typeof sender.url === 'string' &&
    sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

export async function dispatch(message, sender) {
  if (!isTrustedSender(sender)) return { success: false, error: 'Untrusted sender.' };
  if (!message || typeof message !== 'object' || typeof message.action !== 'string') return { success: false, error: 'Malformed request.' };
  const handler = Object.hasOwn(handlers, message.action) ? handlers[message.action] : null;
  if (!handler) return { success: false, error: `Unknown action: ${String(message?.action)}` };
  try {
    const data = await handler(message.payload && typeof message.payload === 'object' ? message.payload : {});
    return { success: true, data };
  } catch (err) {
    const expected = err instanceof UserError || err instanceof ApiError;
    if (!expected) console.error(`[outreach] ${message.action} failed`, err);
    return { success: false, error: expected ? err.message : 'Something went wrong. Please try again.', code: err.code || null };
  }
}
