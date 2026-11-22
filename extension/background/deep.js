// background/deep.js — Deep Mode, layers 1 and 2 (layer 3 is the normal writer).
//   L1 parseProfile:   OpenAI turns the page text into a clean profile (structured output).
//   L2 researchProfile: OpenAI web search finds company news and the person's own public work.
// Both layers are guarded so they can only ADD facts that are backed by evidence:
//   L1 values must appear in the page text; L2 items must cite a URL the search actually returned.
import { OPENAI, LIMITS } from '../shared/constants.js';
import { clean, truncate, norm, uniq } from '../shared/text.js';
import { ApiError } from './anthropic.js';
import { normalizeProfile } from './hooks.js';

// Errors that make the next layer pointless too (same key, same account, same model).
export const FATAL_CODES = Object.freeze(['auth', 'quota', 'model_not_found', 'no_key', 'forbidden']);

/** Keep an MV3 service worker alive while a long request is in flight (Chrome stops idle workers at 30 s). */
export async function keepAlive(promise, intervalMs = 20_000) {
  const ping = () => { try { chrome.runtime.getPlatformInfo?.(() => {}); } catch { /* best effort */ } };
  const timer = setInterval(ping, intervalMs);
  try { return await promise; } finally { clearInterval(timer); }
}

// ─── L1: parser ───────────────────────────────────────────────────────────────
const str = { type: 'string' };
const strList = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });

export const PROFILE_SCHEMA = obj({
  name: str, headline: str, currentTitle: str, currentCompany: str, location: str, about: str,
  experience: { type: 'array', items: obj({ title: str, company: str, duration: str }) },
  education: { type: 'array', items: obj({ school: str, detail: str }) },
  skills: strList,
  recentPosts: strList
});

export const PARSER_INSTRUCTIONS = `You turn the text of one LinkedIn profile page into clean JSON.
Rules:
- Use ONLY the page text and the reader's draft you are given. Never add facts from memory.
- Copy values exactly as they appear on the page (same spelling). Use "" or [] when something isn't there.
- Fix the reader's mistakes: a place is not a job title, a degree is not a school, the person's own headline is not a post.
- experience: newest first, at most 6 entries; company is just the company name (no "· Full-time").
- recentPosts: up to 3 posts or articles the person wrote, as text (not reposts by others, not UI labels).
- skills: up to 15. Ignore page chrome such as "Show all", "Endorse", "People you may know", ads and other people's profiles.`;

/** True when `value` really occurs in the page text (case, accents and punctuation ignored). */
export function appearsIn(value, haystack, prefix = 0) {
  const v = norm(value);
  if (!v) return false;
  return haystack.includes(prefix ? v.slice(0, prefix) : v);
}

/**
 * Merge the parser's answer into what the page reader found.
 * Every parser value must be backed by the page text, otherwise the reader's value wins.
 * @returns {{profile: ReturnType<typeof normalizeProfile>, filled: string[]}}
 */
export function mergeParsed(scraped, parsed, rawText) {
  const hay = norm([rawText, JSON.stringify(scraped)].join('\n'));
  const ok = (v) => typeof v === 'string' && appearsIn(v, hay);
  const okLong = (v) => typeof v === 'string' && clean(v).length > 20 && appearsIn(v, hay, 60);
  const list = (x) => (Array.isArray(x) ? x : []);

  const exp = list(parsed?.experience).filter(e => ok(e?.title) && ok(e?.company));
  const edu = list(parsed?.education).filter(e => ok(e?.school))
    .map(e => ({ school: e.school, detail: ok(e.detail) ? e.detail : '' }));
  const posts = list(parsed?.recentPosts).filter(okLong);
  const skills = list(parsed?.skills).filter(ok);

  const merged = normalizeProfile({
    ...scraped,
    name: scraped.name || (ok(parsed?.name) ? parsed.name : ''),
    headline: ok(parsed?.headline) ? parsed.headline : scraped.headline,
    location: ok(parsed?.location) ? parsed.location : scraped.location,
    about: okLong(parsed?.about) ? parsed.about : scraped.about,
    currentTitle: exp[0]?.title || (ok(parsed?.currentTitle) ? parsed.currentTitle : scraped.currentTitle),
    currentCompany: exp[0]?.company || (ok(parsed?.currentCompany) ? parsed.currentCompany : scraped.currentCompany),
    pastCompanies: exp.length ? uniq(exp.slice(1).map(e => e.company).filter(c => norm(c) !== norm(exp[0].company))) : scraped.pastCompanies,
    educationEntries: edu.length ? edu : scraped.educationEntries,
    skills: uniq([...skills, ...scraped.skills]),
    recentPosts: posts.length ? posts : scraped.recentPosts
  });
  merged.profileUrl = scraped.profileUrl;

  const FIELDS = { headline: 'headline', location: 'location', about: 'about', currentTitle: 'role', currentCompany: 'company', pastCompanies: 'past companies', educationEntries: 'education', skills: 'skills', recentPosts: 'posts' };
  const filled = Object.entries(FIELDS)
    .filter(([k]) => JSON.stringify(merged[k]) !== JSON.stringify(scraped[k]))
    .map(([, label]) => label);
  return { profile: merged, filled };
}

/**
 * L1. Throws ApiError on API failure; the caller falls back to the page reader's profile.
 * @param {{respond: Function}} client
 */
export async function parseProfile(client, apiKey, model, { scraped, rawText }) {
  const page = String(rawText || '').slice(0, LIMITS.MAX_RAW_PROFILE_TEXT);
  const res = await client.respond(apiKey, {
    model,
    instructions: PARSER_INSTRUCTIONS,
    input: `READER'S DRAFT (may contain mistakes):\n${JSON.stringify(scraped)}\n\nPAGE TEXT:\n${page || '(not available — use the draft)'}`,
    format: { type: 'json_schema', name: 'linkedin_profile', strict: true, schema: PROFILE_SCHEMA },
    maxOutputTokens: 3000,
    timeoutMs: OPENAI.PARSE_TIMEOUT_MS
  });
  let parsed;
  try { parsed = JSON.parse(res.text); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('The OpenAI parser returned unreadable data.', { code: 'unreadable' });
  }
  return { ...mergeParsed(scraped, parsed, page), model: res.model };
}

// ─── L2: web research ─────────────────────────────────────────────────────────
export const RESEARCH_INSTRUCTIONS = `You research one person for a single, honest LinkedIn outreach message.
Search the web, then reply with JSON only — no prose, no code fences.
Rules:
- Only include items you found in this search, each with its exact source URL. Never use linkedin.com URLs.
- Only include an item when you are confident it is about this exact company / this exact person (match the name AND the company, role or location). When unsure, leave it out — empty lists are fine.
- summary: one factual sentence, at most 25 words.
- hook: at most 12 words that complete "I saw …" (news) or "I enjoyed …" (their work). Plain, no hype, no trailing period.
- date: "YYYY-MM" or "YYYY" when known, otherwise "".`;

const KINDS = ['article', 'talk', 'podcast', 'paper', 'project', 'award', 'other'];

export function researchPrompt(p) {
  const role = [p.currentTitle, p.currentCompany].filter(Boolean).join(' at ');
  const n = LIMITS.MAX_RESEARCH_ITEMS;
  return `Person: ${p.name}
Headline: ${p.headline || '—'}
Current role: ${role || '—'}
Location: ${p.location || '—'}

Find:
1. companyNews — ${p.currentCompany ? `up to ${n} notable news items about ${p.currentCompany} from the last 12 months (funding, launches, acquisitions, awards, expansion).` : 'none (no current company) — return [].'}
2. publicWork — up to ${n} things ${p.name} personally published or presented: articles, blog posts, talks, podcasts, papers, open-source projects, awards.

Reply with exactly this JSON shape:
{"companyNews":[{"title":"","summary":"","hook":"","url":"","date":""}],
 "publicWork":[{"title":"","summary":"","hook":"","url":"","date":"","kind":"${KINDS.join('|')}"}]}`;
}

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_[a-z]+|ref|ref_src|igshid|si)$/i;
/** Comparable form of a URL: no scheme, www, trailing slash, fragment or tracking parameters. */
const urlKey = (u) => {
  try {
    const x = new URL(u);
    const q = [...x.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    return `${x.hostname.replace(/^www\./, '').toLowerCase()}${x.pathname.replace(/\/+$/, '')}${q ? `?${q}` : ''}`;
  } catch { return ''; }
};
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

/** A public https URL that isn't LinkedIn (their own profile isn't news). */
export function safeUrl(u) {
  if (typeof u !== 'string' || u.length > 500) return '';
  try {
    const x = new URL(u.trim());
    if (x.protocol !== 'https:' || !x.hostname.includes('.') || /(^|\.)linkedin\.com$/i.test(x.hostname)) return '';
    return x.href;
  } catch { return ''; }
}

function extractJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(t.slice(a, b + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

const tidyHook = (h) => clean(h).replace(/^i (saw|enjoyed)\s+/i, '').replace(/[.!…\s]+$/, '');

/**
 * Validate L2's answer: well-formed items, real https links, and each link backed by the search
 * (a cited URL or a source the web_search call returned). No evidence → nothing kept.
 */
export function parseResearch(res) {
  const json = extractJson(res.text);
  if (!json) throw new ApiError('The OpenAI web research returned unreadable data.', { code: 'unreadable' });
  const evidence = [...res.citations.map(c => c.url), ...res.sources];
  const keys = new Set(evidence.map(urlKey).filter(Boolean));
  const hosts = new Set(evidence.map(hostOf).filter(Boolean));
  const backed = (url) => (evidence.length ? keys.has(urlKey(url)) || hosts.has(hostOf(url)) : res.searched);

  const seen = new Set();
  const items = (list, withKind) => (Array.isArray(list) ? list : []).map(it => {
    const url = safeUrl(it?.url);
    const title = truncate(it?.title, 160);
    const hook = truncate(tidyHook(it?.hook || it?.title), 100);
    if (!url || !title || !hook || !backed(url) || seen.has(urlKey(url))) return null;
    seen.add(urlKey(url));
    const item = { title, summary: truncate(it?.summary, 220), hook, url, date: /^\d{4}(-\d{2})?$/.test(it?.date) ? it.date : '' };
    if (withKind) item.kind = KINDS.includes(it?.kind) ? it.kind : 'other';
    return item;
  }).filter(Boolean).slice(0, LIMITS.MAX_RESEARCH_ITEMS);

  const companyNews = items(json.companyNews, false);
  const publicWork = items(json.publicWork, true);
  const titles = new Map(res.citations.map(c => [urlKey(c.url), c.title]));
  const sources = [...companyNews, ...publicWork].map(i => ({ url: i.url, title: titles.get(urlKey(i.url)) || i.title }));
  return { companyNews, publicWork, sources, searched: res.searched };
}

/**
 * L2. Some models/accounts reject forcing the tool or the sources option — retry once without each.
 * @param {{respond: Function}} client
 */
export async function researchProfile(client, apiKey, model, profile) {
  const req = {
    model,
    instructions: RESEARCH_INSTRUCTIONS,
    input: researchPrompt(profile),
    tools: [{ type: 'web_search', search_context_size: 'medium' }],
    toolChoice: 'required',
    include: ['web_search_call.action.sources'],
    maxOutputTokens: 4000,
    timeoutMs: OPENAI.SEARCH_TIMEOUT_MS,
    retryOnTimeout: false
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return parseResearch(await client.respond(apiKey, req));
    } catch (err) {
      const msg = `${err?.apiMessage || ''} ${err?.param || ''}`;
      if (attempt < 2 && err?.code === 'bad_request' && /tool_choice/i.test(msg) && req.toolChoice !== 'auto') { req.toolChoice = 'auto'; continue; }
      if (attempt < 2 && err?.code === 'bad_request' && /include/i.test(msg) && req.include) { delete req.include; continue; }
      throw err;
    }
  }
}

const KIND_LABEL = { article: 'article', talk: 'talk', podcast: 'podcast', paper: 'paper', project: 'project', award: 'award', other: 'work' };

/** Hooks from research: their own work scores just above a recent post; company news just below. */
export function researchHooks(research) {
  if (!research) return [];
  const work = (research.publicWork || []).map((w, i) => ({
    kind: 'work', label: `Their ${KIND_LABEL[w.kind] || 'work'}: "${truncate(w.title, 70)}"`, value: w.hook, score: 8.5 - i * 0.3
  }));
  const news = (research.companyNews || []).map((n, i) => ({
    kind: 'news', label: `News: ${truncate(n.title, 80)}`, value: n.hook, score: 7 - i * 0.3
  }));
  return [...work, ...news];
}

/** The read check for a Deep Mode profile (what the merged profile actually contains). */
export function diagnosticsFor(p) {
  const found = {
    name: !!p.name, headline: !!p.headline, location: !!p.location, about: !!p.about,
    experience: !!(p.currentCompany || p.currentTitle || p.pastCompanies.length),
    education: p.educationEntries.length > 0, skills: p.skills.length > 0, activity: p.recentPosts.length > 0
  };
  const foundCount = Object.values(found).filter(Boolean).length;
  return { found, foundCount, total: 8, layoutSuspect: !found.name || (!found.headline && !found.experience) };
}
