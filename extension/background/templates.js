// background/templates.js — reusable drafts with placeholders. Pure functions.
import { clean } from '../shared/text.js';

export const PLACEHOLDERS = Object.freeze(['{firstName}', '{company}', '{title}', '{hook}', '{myName}']);
const FALLBACK = { firstName: 'there', company: 'your team', title: 'your role', hook: '', myName: '' };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turn a concrete draft into a template by swapping known values for placeholders.
 * Longest values first so "Senior Product Manager" wins over "Product".
 */
export function templatize(text, ctx) {
  const pairs = [
    ['title', ctx.title], ['company', ctx.company], ['myName', ctx.myName], ['firstName', ctx.firstName]
  ].filter(([, v]) => v && v.length >= 2).sort((a, b) => b[1].length - a[1].length);
  let out = String(text);
  if (ctx.hookSentence && out.includes(ctx.hookSentence)) out = out.split(ctx.hookSentence).join('{hook}');
  for (const [key, value] of pairs) {
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(value)}(?=$|[^\\p{L}\\p{N}])`, 'gu'), `$1{${key}}`);
  }
  return out;
}

/** Fill placeholders for a new person. Unknown values fall back gracefully. */
export function applyTemplate(text, ctx) {
  let out = String(text).replace(/\{(firstName|company|title|hook|myName)\}/g, (_, k) => {
    const v = ctx[k];
    return v && String(v).trim() ? String(v).trim() : FALLBACK[k];
  });
  // Tidy up after empty placeholders: double spaces, space before punctuation, empty lines.
  out = out.split('\n').map(l => l.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.!?])/g, '$1').trim()).join('\n');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function validateTemplate({ name, text, purpose }) {
  const n = clean(name).slice(0, 60);
  const t = String(text ?? '').trim().slice(0, 2000);
  if (!n) throw new Error('Give the template a name.');
  if (t.length < 10) throw new Error('That template is too short.');
  return { name: n, text: t, purpose: String(purpose || '') };
}
