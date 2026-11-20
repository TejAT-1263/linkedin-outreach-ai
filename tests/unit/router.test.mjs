import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, POPUP } from './helpers/chrome-mock.mjs';
import { PRIYA } from './helpers/fixtures.mjs';

let dispatch, store, mock, DAY_MS;
before(async () => {
  mock = installChromeMock();
  ({ dispatch } = await import('../../extension/background/router.js'));
  store = await import('../../extension/background/store.js');
  ({ DAY_MS } = await import('../../extension/shared/constants.js'));
  await store.init();
});

const call = (action, payload = {}, sender = POPUP) => dispatch({ action, payload }, sender);

test('rejects untrusted senders and unknown actions', async () => {
  assert.deepEqual(await call('getState', {}, { id: 'other', url: 'https://evil.example' }), { success: false, error: 'Untrusted sender.' });
  assert.equal((await call('getState', {}, { id: 'testext', url: 'https://www.linkedin.com/in/x' })).success, false, 'content scripts cannot call the router');
  assert.match((await call('dropTables')).error, /Unknown action/);
});

test('settings are validated and the API key never leaves the background', async () => {
  const r = await call('saveSettings', { name: '  Arjun   Mehta ', followUpDays: 99, theme: 'neon', apiKey: 'sk-ant-secret-1234', background: 'Flipkart, SQL' });
  assert.ok(r.success);
  assert.equal(r.data.settings.name, 'Arjun Mehta');
  assert.equal(r.data.settings.followUpDays, 30);
  assert.equal(r.data.settings.theme, 'system');
  assert.equal(r.data.settings.hasKey, true);
  assert.ok(!('apiKey' in r.data.settings));
  assert.equal(r.data.settings.keyHint, 'sk-ant-…1234');
  // empty apiKey on save keeps the stored key; clearKey removes it
  assert.equal((await call('saveSettings', { apiKey: '' })).data.settings.hasKey, true);
  assert.equal((await call('saveSettings', { clearKey: true })).data.settings.hasKey, false);
});

test('full lifecycle: draft → insert-status → due → follow-up → replied', async () => {
  await call('saveSettings', { followUpDays: 5 });
  const gen = await call('generate', { profile: PRIYA, hooks: [{ kind: 'sharedCompany', label: 'You both worked at Flipkart', value: 'Flipkart', selected: true }], messageType: 'Job', tone: 'Neutral', format: 'note', variant: 0 });
  assert.ok(gen.success, gen.error);
  assert.equal(gen.data.source, 'local');
  assert.ok(gen.data.message.length <= 300);
  const id = gen.data.contact.id;
  assert.equal(id, 'in:priya-sharma');
  assert.equal(gen.data.contact.status, 'drafted');

  assert.equal((await call('track', { contactId: id, event: 'copied' })).data.contact.status, 'copied');
  assert.equal((await call('setStatus', { contactId: id, status: 'sent' })).data.contact.status, 'sent');

  // A re-draft after sending must NOT overwrite what was actually sent.
  const before = (await store.getContact(id)).message;
  await call('generate', { profile: PRIYA, hooks: [], messageType: 'Networking', tone: 'Casual', format: 'note', variant: 3 });
  const after = await store.getContact(id);
  assert.equal(after.status, 'sent');
  assert.equal(after.message, before);

  // Time travel: make it due.
  await store.mutateContact(id, c => ({ ...c, lastTouchAt: Date.now() - 6 * DAY_MS }));
  const list = await call('listContacts', { filter: 'due' });
  assert.equal(list.data.total, 1);
  assert.equal(list.data.stats.due, 1);

  const fu = await call('generateFollowUp', { contactId: id, variant: 0 });
  assert.match(fu.data.message, /^Hi Priya,/);
  const marked = await call('markFollowedUp', { contactId: id, message: fu.data.message });
  assert.equal(marked.data.contact.followUps, 1);
  assert.equal(marked.data.contact.due, false);

  await call('setStatus', { contactId: id, status: 'replied' });
  const st = (await call('getState')).data.stats;
  assert.equal(st.replied, 1);
  assert.equal(st.replyRate, 1);
  assert.ok((await store.getContact(id)).history.map(h => h.type).join(',').includes('followed-up'));
});

test('templates: save from a concrete draft, apply to a new person', async () => {
  const save = await call('saveTemplate', { name: 'Warm referral', purpose: 'Referral', text: 'Hi Priya,\n\nLoved your work at Razorpay. Could you refer me?\n\nThanks,\nArjun Mehta', ctx: { firstName: 'Priya', company: 'Razorpay' } });
  assert.ok(save.success, save.error);
  const tpl = save.data.templates[0];
  assert.equal(tpl.text, 'Hi {firstName},\n\nLoved your work at {company}. Could you refer me?\n\nThanks,\n{myName}', 'sender name becomes {myName}');
  const res = await call('applyTemplate', { templateId: tpl.id, profile: { name: 'Sam Lee', currentCompany: 'Zerodha', profileUrl: 'https://www.linkedin.com/in/sam-lee/' }, hooks: [] });
  assert.equal(res.data.message, 'Hi Sam,\n\nLoved your work at Zerodha. Could you refer me?\n\nThanks,\nArjun Mehta');
  assert.equal(res.data.source, 'template');
  assert.equal((await store.listTemplates())[0].uses, 1);
  assert.equal((await call('applyTemplate', { templateId: 'nope', profile: {} })).error, 'That template no longer exists.');
});

test('the write lock prevents lost updates under concurrency', async () => {
  await store.mutateContact('in:race', () => ({ name: 'Race', followUps: 0, status: 'sent' }));
  await Promise.all(Array.from({ length: 50 }, () => store.mutateContact('in:race', c => ({ ...c, followUps: c.followUps + 1 }))));
  assert.equal((await store.getContact('in:race')).followUps, 50);
});

test('list paging, search and CSV export', async () => {
  for (let i = 0; i < 45; i++) await store.mutateContact(`in:bulk${i}`, () => ({ name: `Bulk ${i}`, company: i % 2 ? 'Acme' : 'Globex', status: 'drafted' }));
  const page1 = await call('listContacts', { limit: 30 });
  assert.equal(page1.data.items.length, 30);
  const page2 = await call('listContacts', { offset: 30, limit: 30 });
  assert.equal(page1.data.total, page2.data.items.length + 30);
  assert.equal((await call('listContacts', { query: 'globex' })).data.total, 23);
  const csv = await call('exportCsv');
  assert.equal(csv.data.csv.split('\r\n').length, csv.data.count + 1);
});

test('badge reflects due follow-ups; notifications fire once per due cycle', async () => {
  const followups = await import('../../extension/background/followups.js');
  await call('saveSettings', { notifications: true, followUpDays: 5 });
  await store.mutateContact('in:due1', () => ({ name: 'Due One', status: 'inserted', insertedAt: 1, lastTouchAt: Date.now() - 10 * DAY_MS }));
  const n = await followups.refresh({ notify: true });
  assert.ok(n >= 1);
  assert.equal(mock.badge.text, String(n));
  const sent = mock.notifications.length;
  assert.ok(sent >= 1);
  await followups.refresh({ notify: true });
  assert.equal(mock.notifications.length, sent, 'no duplicate notifications');
});

test('errors are user-safe; internal errors are masked', async () => {
  const r = await call('readProfile', { tabId: 1 });
  assert.equal(r.success, false);
  assert.equal(r.error, 'That tab is no longer open.');
  const bad = await call('parseResume', { base64: 'x'.repeat(6_000_000) });
  assert.match(bad.error, /over 4 MB/);
});

test('reset wipes everything back to defaults', async () => {
  await call('resetAll');
  const s = (await call('getState')).data;
  assert.equal(s.stats.total, 0);
  assert.equal(s.templates.length, 0);
  assert.equal(s.settings.name, '');
});
