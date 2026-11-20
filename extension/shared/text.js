// shared/text.js — pure string helpers (no chrome.*), safe to unit test in Node.

export function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Shorten to n chars at a word boundary, ending with an ellipsis. */
export function truncate(s, n) {
  s = clean(s);
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  const atWord = sp > n * 0.6 ? cut.slice(0, sp) : cut;
  return atWord.replace(/[\s,.;:–—-]+$/, '') + '…';
}

export function firstSentence(s) {
  const t = clean(s);
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  return m ? m[1] : t;
}

/** Last-resort fit: cut at a sentence/line end if possible, otherwise at a word. */
export function hardFit(text, limit) {
  text = String(text ?? '');
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('\n'));
  if (end > limit * 0.6) return cut.slice(0, end + 1).trim();
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut).trim() + '…';
}

export function stripQuotes(s) {
  return String(s ?? '').trim().replace(/^["“]([\s\S]*)["”]$/, '$1').trim();
}

export function norm(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Loose entity match: "IIT Bombay" ~ "Indian Institute of Technology, IIT Bombay". */
export function matchesAny(value, list = []) {
  const v = norm(value);
  if (v.length < 3) return false;
  return list.some(item => {
    const i = norm(item);
    if (i.length < 3) return false;
    if (v === i) return true;
    if (i.length < 4 || v.length < 4) return false;
    // whole-word containment, so "SQL" doesn't match "PostgreSQL" by accident
    const re = (x) => new RegExp(`(^| )${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
    return re(i).test(v) || re(v).test(i);
  });
}

export function splitList(s) {
  return String(s ?? '').split(/[,\n;]+/).map(x => x.trim()).filter(Boolean);
}

export function uniq(a) {
  const seen = new Set();
  return a.filter(x => { const k = norm(x); if (!x || seen.has(k)) return false; seen.add(k); return true; });
}

export function aOrAn(word) {
  return /^[aeiou]/i.test(String(word)) ? 'an' : 'a';
}

export function ensurePeriod(s) {
  const t = clean(s);
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** Stable id for a LinkedIn profile: "in:<slug>" (lowercased, decoded). */
export function contactIdFromUrl(url) {
  const m = String(url ?? '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
  return `in:${slug.toLowerCase()}`;
}

export function canonicalProfileUrl(url) {
  const m = String(url ?? '').match(/^(https:\/\/www\.linkedin\.com\/in\/[^/?#]+)/i);
  return m ? `${m[1]}/` : '';
}

/** Deterministic small hash for seeding phrasing choices. */
export function hashString(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function csvCell(v) {
  const s = String(v ?? '');
  // Neutralise spreadsheet formula injection and quote everything.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}
