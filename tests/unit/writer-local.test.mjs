import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localMessage, localFollowUp, openerFor } from '../../extension/background/writer-local.js';
import { normalizeProfile, buildHooks } from '../../extension/background/hooks.js';
import { FORMATS, PURPOSES, TONES } from '../../extension/shared/constants.js';
import { PRIYA, ME } from './helpers/fixtures.mjs';

const p = normalizeProfile(PRIYA);
const hooks = buildHooks(p, ME).filter(h => h.selected);

test('every format × purpose × tone × variant fits its limit and has no template junk', () => {
  let n = 0;
  for (const fmt of Object.values(FORMATS)) for (const messageType of PURPOSES) for (const tone of TONES) for (let variant = 0; variant < 5; variant++) {
    const msg = localMessage({ p, me: ME, hooks, messageType, tone, fmt, variant });
    assert.ok(msg.length <= fmt.limit, `${fmt.id}/${messageType}/${tone}/${variant}: ${msg.length}`);
    assert.doesNotMatch(msg, /undefined|null|\[object|\{\w+\}/);
    assert.match(msg, /^(Hi|Hello|Hey) Priya/);
    n++;
  }
  assert.equal(n, 180);
});

test('"New version" produces a different draft', () => {
  const a = localMessage({ p, me: ME, hooks, messageType: 'Networking', tone: 'Neutral', fmt: FORMATS.dm, variant: 0 });
  const b = localMessage({ p, me: ME, hooks, messageType: 'Networking', tone: 'Neutral', fmt: FORMATS.dm, variant: 1 });
  assert.notEqual(a, b);
});

test('uses the selected hook, not a generic opener', () => {
  const msg = localMessage({ p, me: ME, hooks, messageType: 'Networking', tone: 'Neutral', fmt: FORMATS.note, variant: 0 });
  assert.match(msg, /Flipkart/);
  assert.doesNotMatch(msg, /impressed by your/i);
});

test('custom hook is used verbatim', () => {
  const msg = localMessage({ p, me: {}, hooks: [{ kind: 'custom', value: 'Loved your talk at the Pune meetup' }], messageType: 'Networking', tone: 'Casual', fmt: FORMATS.note, variant: 0 });
  assert.match(msg, /Loved your talk at the Pune meetup\./);
});

test('sparse profile, no sender, tight limit', () => {
  const sp = normalizeProfile({ name: 'Sam' });
  const msg = localMessage({ p: sp, me: {}, hooks: [], messageType: 'Referral', tone: 'Formal', fmt: FORMATS['note-free'], variant: 0 });
  assert.ok(msg.length <= 200);
  assert.match(msg, /^Hello Sam,/);
});

test('openerFor handles role hooks without a company', () => {
  assert.equal(openerFor({ kind: 'role', value: { title: 'PM', company: '' } }), '');
  assert.equal(openerFor(null), '');
});

test('follow-ups are short, polite, and the second one offers an out', () => {
  const contact = { name: 'Priya Sharma', company: 'Razorpay', purpose: 'Job', hooks: [{ kind: 'post', value: 'x' }], followUps: 0 };
  const first = localFollowUp({ contact, me: ME, tone: 'Neutral', limit: 400 });
  assert.ok(first.length <= 400);
  assert.match(first, /^Hi Priya,/);
  assert.match(first, /your post/);
  const second = localFollowUp({ contact: { ...contact, followUps: 1 }, me: ME, tone: 'Neutral', limit: 400 });
  assert.match(second, /won't keep pinging/);
});
