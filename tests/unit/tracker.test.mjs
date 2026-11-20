import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUpDueAt, isDue, computeStats, prune, toCsv } from '../../extension/background/tracker.js';
import { DAY_MS } from '../../extension/shared/constants.js';

const now = Date.UTC(2026, 10, 20);
const c = (o) => ({ id: o.id || Math.random().toString(36), name: 'X', updatedAt: now, ...o });

test('follow-up due dates back off after each follow-up and cap at 3', () => {
  const base = c({ status: 'inserted', insertedAt: now - 6 * DAY_MS, lastTouchAt: now - 6 * DAY_MS });
  assert.ok(isDue(base, now, 5));
  assert.ok(!isDue({ ...base, followUps: 1 }, now, 5), 'second wait is 7 days');
  assert.equal(followUpDueAt({ ...base, followUps: 1 }, 5), now - 6 * DAY_MS + 7 * DAY_MS);
  assert.ok(!isDue({ ...base, followUps: 3, lastTouchAt: now - 60 * DAY_MS }, now, 5));
  assert.equal(followUpDueAt(c({ status: 'replied', insertedAt: now }), 5), null);
  assert.equal(followUpDueAt(c({ status: 'drafted' }), 5), null);
});

test('stats: reply rate and best opener group', () => {
  const contacts = [
    c({ status: 'replied', sentAt: now, hooks: [{ kind: 'sharedCompany' }] }),
    c({ status: 'replied', sentAt: now, hooks: [{ kind: 'sharedSchool' }] }),
    c({ status: 'sent', sentAt: now, hooks: [{ kind: 'sharedSkill' }] }),
    c({ status: 'sent', sentAt: now, hooks: [{ kind: 'role' }] }),
    c({ status: 'drafted' })
  ];
  const s = computeStats(contacts, now, 5);
  assert.equal(s.reached, 4);
  assert.equal(s.replied, 2);
  assert.equal(s.replyRate, 0.5);
  assert.equal(s.best.group, 'common');
  assert.equal(s.best.replied, 2);
});

test('prune keeps the newest and keeps awaiting contacts over old drafts', () => {
  const map = {};
  for (let i = 0; i < 10; i++) map[`d${i}`] = c({ id: `d${i}`, status: 'drafted', updatedAt: i });
  map.w = c({ id: 'w', status: 'sent', updatedAt: -1 });
  const out = prune(map, 5);
  assert.equal(Object.keys(out).length, 5);
  assert.ok(out.w, 'awaiting reply is kept even though it is oldest');
  assert.ok(out.d9 && !out.d0);
});

test('CSV has a header, one row per contact, and is injection-safe', () => {
  const csv = toCsv([c({ name: '=cmd()', status: 'sent', message: 'Hi "there"\nline 2' })]);
  const [head, row] = csv.split('\r\n');
  assert.match(head, /^"name","headline"/);
  assert.match(row, /^"'=cmd\(\)"/);
  assert.match(row, /"Hi ""there""\nline 2"$/);
});
