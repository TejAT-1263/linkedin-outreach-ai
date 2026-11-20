// background/templates.js — reusable drafts with placeholders. Pure functions.
import { clean } from '../shared/text.js';
import { UserError } from '../shared/errors.js';

export const PLACEHOLDERS = Object.freeze(['{firstName}', '{company}', '{title}', '{hook}', '{myName}']);
const FALLBACK = { firstName: 'there', company: 'your team', title: 'your role', hook: '', myName: '' };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turn a concrete draft into a template by swapping known values for placeholders.
 * Longest values first so "Senior Product Manager" wins over "Product".
 */
export function templatize(text, ctx) {
  // Only real words are swapped: values need a letter/digit and no braces, so a stray
  // "}" or "," can never be mistaken for a name and corrupt the placeholders.
  const usable = (v, min) => typeof v === 'string' && v.trim().length >= min && /[\p{L}\p{N}]/u.test(v) && !/[{}]/.test(v);
  const pairs = [
    ['title', ctx.title], ['company', ctx.company], ['myName', ctx.myName], ['firstName', ctx.firstName]
  ].filter(([, v]) => usable(v, 2)).map(([k, v]) => [k, v.trim()]).sort((a, b) => b[1].length - a[1].length);
  // Work only on the text between existing placeholders, never inside them.
  const parts = String(text).split(PLACEHOLDER_RE);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part; // an existing {placeholder}
    let out = part;
    if (usable(ctx.hookSentence, 10)) out = out.split(ctx.hookSentence).join('{hook}');
    for (const [key, value] of pairs) {
      out = out.split(/(\{(?:firstName|company|title|hook|myName)\})/).map((seg, j) => (j % 2 ? seg :
        seg.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(value)}(?=$|[^\\p{L}\\p{N}])`, 'gu'), `$1{${key}}`))).join('');
    }
    return out;
  }).join('');
}

const PLACEHOLDER_RE = /(\{(?:firstName|company|title|hook|myName)\})/;

/** Fill placeholders for a new person. Unknown values fall back gracefully. */
export function applyTemplate(text, ctx) {
  // Values are inserted once (no re-scan) and can't smuggle in placeholders of their own.
  const value = (k) => {
    const v = typeof ctx[k] === 'string' || typeof ctx[k] === 'number' ? String(ctx[k]).trim() : '';
    return (v || FALLBACK[k]).replace(/\{(firstName|company|title|hook|myName)\}/g, '$1');
  };
  let out = String(text).replace(/\{(firstName|company|title|hook|myName)\}/g, (_, k) => value(k));
  // Tidy up after empty placeholders: double spaces, space before punctuation, empty lines.
  out = out.split('\n').map(l => l.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.!?])/g, '$1').trim()).join('\n');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function validateTemplate({ name, text, purpose }) {
  const n = clean(name).slice(0, 60);
  const t = String(text ?? '').trim().slice(0, 2000);
  if (!n) throw new UserError('Give the template a name.');
  if (t.length < 10) throw new UserError('That template is too short.');
  return { name: n, text: t, purpose: String(purpose || '') };
}
