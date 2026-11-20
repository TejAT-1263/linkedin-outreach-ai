// Property-based fuzzing with a seeded PRNG: thousands of hostile inputs, invariants must hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rng } from './helpers/chrome-mock.mjs';
import { normalizeProfile, buildHooks, sanitizeHooks } from '../../extension/background/hooks.js';
import { localMessage, localFollowUp } from '../../extension/background/writer-local.js';
import { templatize, applyTemplate } from '../../extension/background/templates.js';
import { truncate, hardFit, matchesAny, contactIdFromUrl, csvCell, splitList } from '../../extension/shared/text.js';
import { migrate } from '../../extension/background/migrate.js';
import { computeStats, toCsv, prune, isDue } from '../../extension/background/tracker.js';
import { FORMATS, PURPOSES, TONES, STATUS } from '../../extension/shared/constants.js';

const SEED = Number(process.env.FUZZ_SEED) || 20261120;
const N = Number(process.env.FUZZ_N) || 1500;

function randomProfile(r) {
  const field = () => (r.next() < 0.7 ? r.str(r.pick([5, 30, 300])) : r.junk());
  const list = () => (r.next() < 0.8 ? Array.from({ length: r.int(6) }, field) : r.junk());
  return {
    name: r.next() < 0.9 ? r.str(30) : r.junk(), headline: field(), currentTitle: field(), currentCompany: field(),
    location: field(), about: field(), recentPosts: list(), pastCompanies: list(), skills: list(),
    educationEntries: r.next() < 0.8 ? Array.from({ length: r.int(4) }, () => (r.next() < 0.5 ? { school: field(), detail: field() } : field())) : r.junk(),
    profileUrl: field()
  };
}

test(`writer never throws, never exceeds limits, never leaks junk (${N} random profiles, seed ${SEED})`, () => {
  const r = rng(SEED);
  for (let i = 0; i < N; i++) {
    const p = normalizeProfile(randomProfile(r));
    const me = { name: r.next() < 0.5 ? r.str(20) : '', bio: r.next() < 0.5 ? r.str(200) : '', terms: splitList(r.str(60)) };
    const hooks = sanitizeHooks(buildHooks(p, me)).filter(() => r.next() < 0.6);
    if (r.next() < 0.2) hooks.unshift({ kind: 'custom', value: r.str(140), label: 'c' });
    const fmt = r.pick(Object.values(FORMATS));
    const ctx = `case ${i}: ${JSON.stringify({ p, hooks, fmt: fmt.id })}`;
    let msg;
    assert.doesNotThrow(() => { msg = localMessage({ p, me, hooks, messageType: r.pick([...PURPOSES, 'Bogus']), tone: r.pick([...TONES, undefined]), fmt, variant: r.int(50) }); }, ctx);
    assert.ok(typeof msg === 'string' && msg.length > 0 && msg.length <= fmt.limit, ctx);
    assert.doesNotMatch(msg, /undefined|\bnull\b|\[object Object\]|NaN/, ctx);
    const fu = localFollowUp({ contact: { name: p.name, company: p.currentCompany, purpose: r.pick(PURPOSES), hooks, followUps: r.int(4) }, me, tone: r.pick(TONES), variant: r.int(9), limit: 400 });
    assert.ok(fu.length <= 400 && !/undefined/.test(fu), ctx);
  }
});

test('text helpers hold their contracts on random input', () => {
  const r = rng(SEED + 1);
  for (let i = 0; i < N * 2; i++) {
    const s = r.str(r.pick([0, 5, 50, 500]));
    const n = 2 + r.int(400);
    assert.ok(truncate(s, n).length <= n);
    assert.ok(hardFit(s, n).length <= n);
    assert.doesNotThrow(() => matchesAny(r.junk(), [r.str(10), r.junk(), '(.*)[', '\\']));
    assert.doesNotThrow(() => contactIdFromUrl(`https://www.linkedin.com/in/${s}`));
    const cell = csvCell(s);
    assert.ok(cell.startsWith('"') && cell.endsWith('"') && !/^"[=+\-@]/.test(cell));
  }
});

test('templates never leave placeholders behind', () => {
  const r = rng(SEED + 2);
  for (let i = 0; i < N; i++) {
    const ctx = { firstName: r.str(10), company: r.str(12), title: r.str(15), myName: r.str(10), hookSentence: r.str(20) };
    const tpl = templatize(`Hi ${ctx.firstName}, ${r.str(80)} ${ctx.company} {title} {hook}`, ctx);
    const out = applyTemplate(tpl, { firstName: r.next() < 0.5 ? r.str(8) : '', company: r.junk(), title: '', hook: r.str(30), myName: undefined });
    assert.doesNotMatch(out, /\{(firstName|company|title|hook|myName)\}/);
  }
});

test('migration and tracker maths survive arbitrary stored junk', () => {
  const r = rng(SEED + 3);
  for (let i = 0; i < N; i++) {
    const data = { userName: r.junk(), userApiKey: r.junk(), prefs: r.junk(), recentContacts: r.next() < 0.7 ? Array.from({ length: r.int(5) }, () => ({ profileUrl: r.next() < 0.5 ? `https://www.linkedin.com/in/${r.str(8)}/` : r.junk(), name: r.junk(), status: r.pick([...Object.values(STATUS), 'x']), timestamp: r.junk() })) : r.junk() };
    let out;
    assert.doesNotThrow(() => { out = migrate(data); });
    const contacts = Object.values(out.set.contacts || {});
    assert.doesNotThrow(() => { computeStats(contacts, Date.now(), 5); toCsv(contacts); prune(out.set.contacts || {}, 2); contacts.forEach(c => isDue(c, Date.now(), 5)); });
  }
});
