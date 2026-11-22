// background/store.js — corrupted data, quota/IO errors, lock recovery, limits.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.mjs';
import { LIMITS } from '../../extension/shared/constants.js';

installChromeMock();
const store = await import('../../extension/background/store.js');
const local = chrome.storage.local;

beforeEach(async () => { await local.clear(); await chrome.storage.session.clear(); await store.init(); });

test('corrupted contacts are repaired or dropped, never crash', async () => {
  local._replace({ ...local._raw(), contacts: {
    'in:ok': { name: 'Ok', status: 'sent', updatedAt: 5 },
    'in:junk-types': { name: 42, status: 'exploded', followUps: -3, hooks: 'x', history: [null, 1, { type: 'a' }], profileUrl: 'javascript:alert(1)', createdAt: 'yesterday', purpose: 'Spam', format: 'fax' },
    'in:null': null, 'in:arr': [1, 2], 'in:str': 'hello'
  } });
  const list = await store.listContacts();
  assert.deepEqual(list.map(c => c.id).sort(), ['in:junk-types', 'in:ok']);
  const j = list.find(c => c.id === 'in:junk-types');
  assert.equal(j.name, 'Unknown');
  assert.equal(j.status, 'drafted');
  assert.equal(j.followUps, 0);
  assert.deepEqual(j.hooks, []);
  assert.deepEqual(j.history, [{ type: 'a' }]);
  assert.equal(j.profileUrl, '', 'non-LinkedIn URLs are never kept (no javascript: links)');
  assert.equal(j.createdAt, 0);
  assert.equal(j.purpose, 'Networking');
  assert.equal(j.format, 'note');
});

test('contacts stored as the wrong type entirely → empty list', async () => {
  for (const bad of [null, 'x', [1], 5]) {
    local._replace({ ...local._raw(), contacts: bad });
    assert.deepEqual(await store.listContacts(), []);
  }
});

test('corrupted settings / prefs / templates fall back to safe defaults', async () => {
  local._replace({ ...local._raw(), settings: { name: { x: 1 }, followUpDays: 'lots', theme: 'neon', notifications: 'yes', apiKey: 12 }, prefs: 'oops', templates: [null, { id: 1 }, { id: 't', name: 'ok', text: 'Hello {firstName}', uses: 'many', purpose: 'Spam' }] });
  const s = await store.getSettings();
  assert.equal(s.name, '');
  assert.equal(s.followUpDays, LIMITS.DEFAULT_FOLLOWUP_DAYS);
  assert.equal(s.theme, 'system');
  assert.equal(s.notifications, true);
  assert.equal(s.apiKey, '12');
  assert.deepEqual(await store.getPrefs(), { messageType: 'Networking', tone: 'Neutral', format: 'note', mode: 'quick' });
  local._replace({ ...local._raw(), prefs: { messageType: 'Job', tone: 'Shouty', format: 'dm', mode: 'turbo' } });
  assert.deepEqual(await store.getPrefs(), { messageType: 'Job', tone: 'Neutral', format: 'dm', mode: 'quick' });
  local._replace({ ...local._raw(), prefs: { mode: 'deep' } });
  assert.equal((await store.getPrefs()).mode, 'deep');
  const t = await store.listTemplates();
  assert.equal(t.length, 1);
  assert.equal(t[0].uses, 0);
  assert.equal(t[0].purpose, '');
  local._replace({ ...local._raw(), settings: 'garbage', templates: 'nope' });
  assert.equal((await store.getSettings()).followUpDays, 5);
  assert.deepEqual(await store.listTemplates(), []);
});

test('quota errors become a helpful message; other write errors too', async () => {
  local.failNext('set', new Error('QUOTA_BYTES quota exceeded'));
  await assert.rejects(store.saveSettings({ name: 'x' }), (e) => e.code === 'quota' && /Export your tracker/.test(e.message));
  local.failNext('set', new Error('IO error: disk'));
  await assert.rejects(store.mutateContact('in:a', () => ({ name: 'A' })), (e) => e.code === 'storage');
});

test('the lock keeps working after a failed write (no deadlock, no lost data)', async () => {
  local.failNext('set', new Error('IO'));
  const results = await Promise.allSettled([
    store.mutateContact('in:a', () => ({ name: 'A', followUps: 0 })),
    store.mutateContact('in:b', () => ({ name: 'B', followUps: 0 })),
    store.mutateContact('in:b', (c) => ({ ...c, followUps: c.followUps + 1 }))
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal((await store.getContact('in:b')).followUps, 1);
  assert.equal(await store.getContact('in:a'), null);
});

test('read errors propagate (so the router can mask them)', async () => {
  local.failNext('get', new TypeError('boom'));
  await assert.rejects(store.listContacts(), /boom/);
});

test('session: per-URL, expires after TTL, ignores junk', async () => {
  await store.saveSession({ url: 'u1', message: 'm' });
  assert.equal((await store.getSession('u1')).message, 'm');
  assert.equal(await store.getSession('u2'), null);
  chrome.storage.session._replace({ draft: { url: 'u1', savedAt: Date.now() - LIMITS.SESSION_TTL_MS - 1 } });
  assert.equal(await store.getSession('u1'), null);
  chrome.storage.session._replace({ draft: 'junk' });
  assert.equal(await store.getSession('u1'), null);
  chrome.storage.session._replace({ draft: { url: 'u1' } });
  assert.equal(await store.getSession('u1'), null);
});

test('templates: same name updates in place; limit enforced; delete', async () => {
  await store.saveTemplate({ name: 'Warm', text: 'v1 {firstName}', purpose: 'Job' });
  const t = await store.saveTemplate({ name: 'warm', text: 'v2 {firstName}', purpose: 'Job' });
  assert.equal(t.length, 1);
  assert.equal(t[0].text, 'v2 {firstName}');
  for (let i = 1; i < LIMITS.MAX_TEMPLATES; i++) await store.saveTemplate({ name: `T${i}`, text: 'Hello there {firstName}' });
  await assert.rejects(store.saveTemplate({ name: 'one too many', text: 'Hello there' }), /up to 50/);
  assert.equal((await store.deleteTemplate(t[0].id)).length, LIMITS.MAX_TEMPLATES - 1);
  await store.bumpTemplateUse('missing-id'); // no-op, no throw
});

test('contacts are pruned at the cap', async () => {
  const contacts = {};
  for (let i = 0; i < LIMITS.MAX_CONTACTS + 5; i++) contacts[`in:c${i}`] = { name: `C${i}`, status: 'drafted', updatedAt: i };
  local._replace({ ...local._raw(), contacts });
  await store.mutateContact('in:new', () => ({ name: 'New' }));
  const list = await store.listContacts();
  assert.equal(list.length, LIMITS.MAX_CONTACTS);
  assert.ok(list.some(c => c.id === 'in:new'));
  assert.ok(!list.some(c => c.id === 'in:c0'));
});

test('publicSettings hides the key; resetAll restores defaults', async () => {
  const s = await store.saveSettings({ apiKey: 'sk-ant-abcdefgh12345' });
  assert.deepEqual(Object.keys(store.publicSettings(s)).includes('apiKey'), false);
  assert.equal(store.publicSettings({ ...s, apiKey: '' }).keyHint, '');
  await store.resetAll();
  assert.equal((await store.getSettings()).apiKey, '');
});
