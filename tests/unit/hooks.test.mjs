import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile, buildHooks, sanitizeHooks } from '../../extension/background/hooks.js';
import { PRIYA, ME } from './helpers/fixtures.mjs';

test('common ground ranks first and the top two are pre-selected', () => {
  const hooks = buildHooks(normalizeProfile(PRIYA), ME);
  assert.equal(hooks[0].kind, 'sharedCompany');
  assert.equal(hooks[0].value, 'Flipkart');
  assert.deepEqual(hooks.filter(h => h.selected).map(h => h.kind), ['sharedCompany', 'post']);
  const kinds = hooks.map(h => h.kind);
  assert.ok(kinds.includes('sharedSkill') && kinds.includes('sharedLocation'));
  assert.ok(!kinds.includes('pastCompany'), 'shared past company is not listed twice');
});

test('no sender background → no common-ground hooks, still useful hooks', () => {
  const hooks = buildHooks(normalizeProfile(PRIYA), {});
  assert.ok(hooks.every(h => !h.kind.startsWith('shared')));
  assert.equal(hooks[0].kind, 'post');
});

test('sparse profile falls back to the headline', () => {
  const hooks = buildHooks(normalizeProfile({ name: 'Sam', headline: 'Builder of things' }), {});
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].kind, 'headline');
});

test('normalizeProfile rejects junk types and caps lengths', () => {
  const p = normalizeProfile({ name: { evil: 1 }, skills: 'notarray', recentPosts: [1, 'x'.repeat(900)], about: 'a'.repeat(5000) });
  assert.equal(p.name, '');
  assert.equal(p.firstName, 'there');
  assert.deepEqual(p.skills, []);
  assert.equal(p.recentPosts[0].length, 500);
  assert.equal(p.about.length, 2000);
});

test('sanitizeHooks strips unknown fields and bad entries', () => {
  const out = sanitizeHooks([{ kind: 'custom', value: 'Met at a meetup', selected: true, evil: '<script>' }, { nope: 1 }, null]);
  assert.equal(out.length, 1);
  assert.ok(!('evil' in out[0]));
});
