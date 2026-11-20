'use strict';

// background.js — service worker
// No company server, no license key. Two ways to write a message:
//   • Free mode: a local writer built from the hooks the user picked (no network).
//   • AI mode:  the user's OWN Anthropic API key (set in Settings).
// Everything is stored in chrome.storage.local on the user's device.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-5-5';
const MAX_RECENT = 20;

// Message formats and their character limits.
// LinkedIn limits change over time; the content script also reads the real
// maxlength from LinkedIn's note box at insert time and reports it back.
const FORMATS = {
  note:        { label: 'connection note',             limit: 300 },
  'note-free': { label: 'connection note (free plan)', limit: 200 },
  dm:          { label: 'direct message',              limit: 600 }
};

// ─── Router ───────────────────────────────────────────────────────────────────
const handlers = {
  scrapeProfile:   ({ tabId }) => scrapeProfile(tabId),
  generateMessage: (payload) => generateMessage(payload),
  insertMessage:   ({ tabId, text, replace }) => insertIntoTab(tabId, text, replace),
  testApiKey:      ({ apiKey }) => testKey(apiKey),
  parseResume:     ({ base64 }) => parseResume(base64),
  saveRecent:      ({ contact }) => saveRecent(contact),
  updateRecent:    ({ profileUrl, patch }) => updateRecent(profileUrl, patch),
  getRecent:       () => getRecent(),
  clearRecent:     () => storageSet({ recentContacts: [] }).then(() => ({}))
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message.action];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message.payload || {}))
    .then(data => sendResponse({ success: true, data }))
    .catch(err => sendResponse({ success: false, error: err.message || String(err) }));
  return true; // async response
});

// ─── Talking to the LinkedIn tab ──────────────────────────────────────────────
async function resolveTab(tabId) {
  const tab = tabId
    ? await chrome.tabs.get(tabId)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) throw new Error('No active tab found.');
  if (!tab.url || !/^https:\/\/www\.linkedin\.com\//.test(tab.url)) {
    throw new Error('Open a LinkedIn profile first.');
  }
  return tab;
}

async function sendToContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    // Page was open before the extension was installed/reloaded → inject now.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_script.js'] });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

async function scrapeProfile(tabId) {
  const tab = await resolveTab(tabId);
  const result = await sendToContent(tab.id, { action: 'scrapeProfile' });
  if (!result?.success) throw new Error(result?.error || 'Could not read this profile.');
  const profile = normalizeProfile(result.data);
  if (!profile.name) throw new Error("Couldn't find a name on this page. Is it a profile page?");
  const me = await getSender();
  return { profile, hooks: buildHooks(profile, me) };
}

async function insertIntoTab(tabId, text, replace) {
  const tab = await resolveTab(tabId);
  const result = await sendToContent(tab.id, { action: 'insertMessage', text, replace });
  return result || { ok: false, reason: 'noComposer' };
}

// ─── Profile + sender helpers ─────────────────────────────────────────────────
function normalizeProfile(raw = {}) {
  const name = (raw.name || '').trim();
  return {
    name,
    firstName: name.split(/\s+/)[0] || 'there',
    headline: raw.headline || '',
    currentTitle: raw.currentTitle || '',
    currentCompany: raw.currentCompany || '',
    location: raw.location || '',
    about: raw.about || '',
    recentPosts: raw.recentPosts || [],
    experienceEntries: raw.experienceEntries || [],
    pastCompanies: raw.pastCompanies || [],
    educationEntries: (raw.educationEntries || []).map(e => typeof e === 'string' ? { school: e } : e),
    skills: raw.skills || [],
    profileUrl: raw.profileUrl || ''
  };
}

// The sender ("me") — from Settings. "Your background" is one editable list
// (companies, schools, skills, city); the resume reader just fills it in.
async function getSender() {
  const s = await storageGet(['userName', 'userBio', 'userBackground']);
  return {
    name: (s.userName || '').trim(),
    bio: (s.userBio || '').trim(),
    terms: uniq(splitList(s.userBackground))
  };
}

// ─── Hooks: the specific details a message can be built around ────────────────
// Each hook: { id, kind, label (shown to user), value (used in writing), score }
// Common ground scores highest because it's the strongest reason to reply.
function buildHooks(p, me = {}) {
  const hooks = [];
  const add = (kind, label, value, score) =>
    hooks.push({ id: `${kind}-${hooks.length}`, kind, label, value, score });

  const theirCompanies = uniq([p.currentCompany, ...p.pastCompanies].filter(Boolean));
  const theirSchools = p.educationEntries.map(e => e.school).filter(Boolean);

  const mine = me.terms || [];
  const sharedCo = theirCompanies.find(c => matchesAny(c, mine));
  if (sharedCo) add('sharedCompany', `You both worked at ${sharedCo}`, sharedCo, 10);

  const sharedSchool = theirSchools.find(s => matchesAny(s, mine));
  if (sharedSchool) add('sharedSchool', `You both studied at ${sharedSchool}`, sharedSchool, 9);

  const sharedSkills = p.skills.filter(s => matchesAny(s, mine)).slice(0, 2);
  if (sharedSkills.length) add('sharedSkill', `You share skills: ${sharedSkills.join(', ')}`, sharedSkills.join(' and '), 6);

  const theirCity = (p.location || '').split(',')[0].trim();
  if (theirCity && matchesAny(theirCity, mine)) {
    add('sharedLocation', `You're both in ${theirCity}`, theirCity, 5);
  }

  if (p.recentPosts.length) add('post', `Recent post: "${truncate(p.recentPosts[0], 80)}"`, truncate(p.recentPosts[0], 70), 8);
  if (p.currentTitle && p.currentCompany) add('role', `${p.currentTitle} at ${p.currentCompany}`, { title: p.currentTitle, company: p.currentCompany }, 4);
  else if (p.currentCompany) add('role', `Works at ${p.currentCompany}`, { title: '', company: p.currentCompany }, 3);
  if (p.about) add('about', `About: "${truncate(firstSentence(p.about), 80)}"`, truncate(firstSentence(p.about), 70), 3.5);
  if (p.pastCompanies.length && !sharedCo) add('pastCompany', `Previously at ${p.pastCompanies[0]}`, p.pastCompanies[0], 2);
  if (p.skills.length && !sharedSkills.length) add('skill', `Skilled in ${p.skills.slice(0, 2).join(', ')}`, p.skills.slice(0, 2).join(' and '), 2);
  if (theirSchools.length && !sharedSchool) add('education', `Studied at ${theirSchools[0]}`, theirSchools[0], 1.5);
  if (!hooks.length && p.headline) add('headline', `Headline: ${truncate(p.headline, 80)}`, p.headline, 1);

  hooks.sort((a, b) => b.score - a.score);
  // Pre-select the two strongest; the user can change this in the popup.
  hooks.forEach((h, i) => { h.selected = i < 2; });
  return hooks;
}

// ─── Generate ─────────────────────────────────────────────────────────────────
async function generateMessage({ profile, hooks = [], messageType, tone, format, variant = 0, previousMessage = '' }) {
  const p = normalizeProfile(profile);
  const me = await getSender();
  const fmt = FORMATS[format] || FORMATS.note;
  const chosen = hooks.filter(h => h.selected !== false);
  const apiKey = await getApiKey();

  if (apiKey) {
    const text = await aiMessage(apiKey, { p, me, hooks: chosen, messageType, tone, fmt, previousMessage });
    return { message: text, source: 'ai', limit: fmt.limit };
  }
  return { message: localMessage({ p, me, hooks: chosen, messageType, tone, fmt, variant }), source: 'local', limit: fmt.limit };
}

// ─── Local (free) writer ──────────────────────────────────────────────────────
// Builds the message from the selected hooks with several phrasings per part.
// `variant` changes the phrasing so Regenerate gives a genuinely new draft.
const OPENERS = {
  custom: [
    v => /[.!?]$/.test(v) ? v : `${v}.`
  ],
  sharedCompany: [
    v => `Fellow ${v} alum here — spotted it on your profile.`,
    v => `I noticed we both spent time at ${v}.`,
    v => `Saw we share ${v} on our CVs, which made me want to say hi.`
  ],
  sharedSchool: [
    v => `Fellow ${v} grad here!`,
    v => `Saw we both went to ${v}.`,
    v => `Always nice to find another ${v} alum.`
  ],
  sharedSkill: [
    v => `Looks like we both work with ${v}.`,
    v => `Saw we overlap on ${v}.`
  ],
  sharedLocation: [
    v => `Fellow ${v} local here.`,
    v => `Saw you're in ${v} too.`
  ],
  post: [
    v => `Your recent post — "${v}" — stuck with me.`,
    v => `Enjoyed your recent post: "${v}".`,
    v => `Your post on "${v}" got me thinking.`
  ],
  role: [
    v => `Saw you're ${v.title ? `${aOrAn(v.title)} ${v.title} ` : ''}at ${v.company}.`,
    v => `Your work${v.title ? ` as ${v.title}` : ''} at ${v.company} caught my eye.`,
    v => `Curious about your work${v.title ? ` as ${v.title}` : ''} at ${v.company}.`
  ],
  about: [
    v => `This line from your About section stood out: "${v}".`,
    v => `Liked how you put it in your About: "${v}".`
  ],
  pastCompany: [
    v => `Saw you were at ${v} before your current role.`,
    v => `Your path through ${v} caught my eye.`
  ],
  skill: [
    v => `Your background in ${v} stood out.`,
    v => `Your experience with ${v} caught my eye.`
  ],
  education: [
    v => `Saw you studied at ${v}.`
  ],
  headline: [
    v => `Your headline caught my eye: "${truncate(v, 60)}".`
  ]
};

const ASKS = {
  Networking: [
    () => `Would love to connect.`,
    () => `Happy to connect and swap notes sometime.`,
    () => `Would be great to stay in touch here.`
  ],
  Job: [
    c => `I'm exploring roles${c ? ` at ${c}` : ''} — would you be open to a quick chat about the team?`,
    c => `I'm looking at opportunities${c ? ` at ${c}` : ''} and would value 10 minutes of your perspective.`
  ],
  Referral: [
    c => `I'm applying to a role${c ? ` at ${c}` : ''} — would you be open to a quick look at my profile, and a referral if it seems like a fit?`,
    c => `I'm keen on an opening${c ? ` at ${c}` : ''}. If you're open to it, I'd be grateful for a referral or any pointers.`
  ],
  Collaboration: [
    () => `I think there's an overlap worth exploring — open to a quick chat?`,
    () => `I'm working on something close to this and would love to compare notes. Open to a 15-minute call?`
  ]
};

const SHORT_ASKS = {
  Networking: () => `Would love to connect.`,
  Job: c => `Open to a quick chat about roles${c ? ` at ${c}` : ''}?`,
  Referral: c => `Open to referring me${c ? ` at ${c}` : ''} if I'm a fit?`,
  Collaboration: () => `Open to a quick chat?`
};

function localMessage({ p, me, hooks, messageType, tone, fmt, variant }) {
  const pick = (arr, salt) => arr[(variant + salt) % arr.length];
  const company = p.currentCompany;

  const greet = { Formal: `Hello ${p.firstName},`, Neutral: `Hi ${p.firstName},`, Casual: `Hey ${p.firstName}!` }[tone] || `Hi ${p.firstName},`;
  const signoff = { Formal: 'Best regards,', Neutral: 'Best,', Casual: 'Cheers,' }[tone] || 'Best,';
  const sign = me.name ? `${signoff}\n${me.name}` : '';

  const openers = hooks.slice(0, 2).map((h, i) => {
    const templates = OPENERS[h.kind] || OPENERS.headline;
    return pick(templates, i * 7)(h.value);
  });
  if (!openers.length) openers.push(`Came across your profile${company ? ` while looking into ${company}` : ''}.`);

  const meLine = me.bio ? `A bit about me: ${truncate(firstSentence(me.bio), 110)}` : '';
  const ask = pick(ASKS[messageType] || ASKS.Networking, 3)(company);
  const shortAsk = (SHORT_ASKS[messageType] || SHORT_ASKS.Networking)(company);

  // Try richest version first, then shed optional parts until it fits.
  const attempts = [
    { openers, meLine, ask, sign },
    { openers, meLine: '', ask, sign },
    { openers: openers.slice(0, 1), meLine: '', ask, sign },
    { openers: openers.slice(0, 1), meLine: '', ask, sign: me.name ? `– ${me.name}` : '' },
    { openers: openers.slice(0, 1), meLine: '', ask: shortAsk, sign: me.name ? `– ${me.name}` : '' },
    { openers: openers.slice(0, 1), meLine: '', ask: shortAsk, sign: '' }
  ];
  for (const a of attempts) {
    const text = assemble(greet, a);
    if (text.length <= fmt.limit) return text;
  }
  return hardFit(assemble(greet, attempts[attempts.length - 1]), fmt.limit);
}

function assemble(greet, { openers, meLine, ask, sign }) {
  const body = [openers.join(' '), meLine].filter(Boolean).join(' ');
  return [greet, body, ask, sign].filter(Boolean).join('\n\n');
}

// ─── AI writer (user's own key) ───────────────────────────────────────────────
const SYSTEM_PROMPT = `You write LinkedIn outreach that real people reply to.
Rules:
- Lead with ONE specific detail from the hooks provided. Never invent facts about either person.
- No flattery clichés ("I came across your impressive profile", "I was blown away", "I hope this finds you well").
- One clear, low-effort ask that matches the purpose.
- Sound like a person typing, not a template. Short sentences. No emojis unless tone is Casual, and at most one.
- Respect the hard character limit, counting every character including line breaks.
- Return only the message text.`;

async function aiMessage(apiKey, { p, me, hooks, messageType, tone, fmt, previousMessage }) {
  const recipient = {
    name: p.name, headline: p.headline, title: p.currentTitle, company: p.currentCompany,
    location: p.location, about: truncate(p.about, 400), recentPosts: p.recentPosts.slice(0, 2)
  };
  const sender = { name: me.name || null, about: me.bio || null };
  const hookLines = hooks.length
    ? hooks.map(h => `- ${h.label}`).join('\n')
    : '- (none selected — use the most specific thing in the recipient profile)';

  const prompt =
`Write a LinkedIn ${fmt.label}.
Hard limit: ${fmt.limit} characters. Aim for ${Math.round(fmt.limit * 0.85)} or fewer.
Purpose: ${messageType}. Tone: ${tone}.

Build the message around these hooks (common-ground hooks are the strongest):
${hookLines}

Recipient: ${JSON.stringify(recipient)}
Sender: ${JSON.stringify(sender)}
${previousMessage ? `\nThe previous draft was below. Write a clearly different version (different opening and wording):\n"""${previousMessage}"""\n` : ''}`;

  let text = (await callClaude(apiKey, { system: SYSTEM_PROMPT, content: prompt, maxTokens: 400 })).trim();
  text = stripQuotes(text);

  if (text.length > fmt.limit) {
    // One shortening pass, then a safe hard cut as a last resort.
    const shorter = await callClaude(apiKey, {
      system: SYSTEM_PROMPT,
      content: `Shorten this to under ${fmt.limit} characters, keeping the specific detail and the ask. Return only the message.\n\n${text}`,
      maxTokens: 300
    });
    text = stripQuotes(shorter.trim());
  }
  return text.length > fmt.limit ? hardFit(text, fmt.limit) : text;
}

// ─── Resume → short sender profile (needs the user's key) ─────────────────────
// We send the PDF once, keep only the extracted facts, and never store the PDF.
async function parseResume(base64) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Add your API key above to read your resume. Or type your background in the field below instead.');

  const raw = await callClaude(apiKey, {
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text:
`Extract facts from this resume as JSON only, no prose:
{"summary": "<one first-person sentence, max 20 words, e.g. I'm a product engineer building AI tools>",
 "companies": ["<employers>"], "schools": ["<universities/colleges>"],
 "skills": ["<up to 10 skills>"], "location": "<city, country or empty>"}` }
    ],
    maxTokens: 500
  });
  const json = parseJson(raw);
  // Returned to the popup, which merges it into the editable "Your background".
  return {
    summary: String(json.summary || '').slice(0, 160),
    companies: arr(json.companies).slice(0, 10),
    schools: arr(json.schools).slice(0, 5),
    skills: arr(json.skills).slice(0, 10),
    location: String(json.location || '').split(',')[0].trim()
  };
}

async function testKey(apiKey) {
  try {
    await callClaude(apiKey, { content: 'Reply with the single word: OK', maxTokens: 10 });
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

async function callClaude(apiKey, { system, content, maxTokens }) {
  const body = { model: ANTHROPIC_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  if (system) body.system = system;
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('Your API key was rejected. Check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited by the API. Try again in a moment.');
    throw new Error(data?.error?.message || `API error (${res.status})`);
  }
  return (data.content || []).map(c => c.text || '').join('');
}

// ─── Recent contacts ──────────────────────────────────────────────────────────
async function getRecent() {
  const { recentContacts } = await storageGet(['recentContacts']);
  return recentContacts || [];
}

async function saveRecent(contact) {
  const recent = await getRecent();
  const key = contact.profileUrl || contact.name;
  const updated = [contact, ...recent.filter(c => (c.profileUrl || c.name) !== key)].slice(0, MAX_RECENT);
  await storageSet({ recentContacts: updated });
  return updated;
}

async function updateRecent(profileUrl, patch) {
  const recent = await getRecent();
  const updated = recent.map(c => c.profileUrl === profileUrl ? { ...c, ...patch } : c);
  await storageSet({ recentContacts: updated });
  return updated;
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function storageGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function storageSet(obj) { return new Promise(r => chrome.storage.local.set(obj, r)); }
async function getApiKey() { return ((await storageGet(['userApiKey'])).userApiKey || '').trim(); }

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const atWord = cut.lastIndexOf(' ') > n * 0.6 ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
  return atWord.replace(/[\s,.;:–—-]+$/, '') + '…';
}
function firstSentence(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  return m ? m[1] : t;
}
function hardFit(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('\n'));
  return end > limit * 0.6 ? cut.slice(0, end + 1).trim() : cut.slice(0, cut.lastIndexOf(' ')).trim() + '…';
}
function stripQuotes(s) { return s.replace(/^["“]([\s\S]*)["”]$/, '$1').trim(); }
function norm(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim(); }
function matchesAny(value, list = []) {
  const v = norm(value);
  if (v.length < 3) return false;
  return list.some(item => {
    const i = norm(item);
    return i.length >= 3 && (v === i || (i.length >= 4 && (v.includes(i) || i.includes(v))));
  });
}
function splitList(s) { return String(s || '').split(/[,\n;]+/).map(x => x.trim()).filter(Boolean); }
function uniq(a) { return [...new Set(a.filter(Boolean))]; }
function arr(x) { return Array.isArray(x) ? x.map(String).filter(Boolean) : []; }
function aOrAn(word) { return /^[aeiou]/i.test(word) ? 'an' : 'a'; }
function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Couldn't read the resume. Try typing your background instead.");
  return JSON.parse(m[0]);
}

// Exposed for the test harness (no effect in Chrome).
if (typeof module !== 'undefined') {
  module.exports = { buildHooks, localMessage, normalizeProfile, matchesAny, hardFit, truncate, FORMATS };
}
