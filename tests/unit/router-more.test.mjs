// router.js — AI paths with a stubbed network, malformed requests, every action's edge cases.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, POPUP } from './helpers/chrome-mock.mjs';
import { PRIYA } from './helpers/fixtures.mjs';

const mock = installChromeMock();
const { dispatch } = await import('../../extension/background/router.js');
const store = await import('../../extension/background/store.js');
const call = (action, payload = {}) => dispatch({ action, payload }, POPUP);

// Network stub: queue of responses; records requests.
const net = { queue: [], requests: [] };
const realFetch = globalThis.fetch;
const realError = console.error;
before(() => {
  globalThis.fetch = async (url, init) => {
    net.requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = net.queue.shift() ?? { status: 200, text: 'OK' };
    if (r instanceof Error) throw r;
    return { ok: r.status < 300, status: r.status, headers: { get: () => null }, json: async () => (r.status < 300 ? { content: [{ type: 'text', text: r.text }] } : { error: { message: r.msg || 'err' } }) };
  };
});
after(() => { globalThis.fetch = realFetch; console.error = realError; });
beforeEach(async () => {
  await chrome.storage.local.clear(); await store.init();
  net.queue = []; net.requests = [];
  mock.tabsState.tabs = new Map([[7, { id: 7, url: 'https://www.linkedin.com/in/priya-sharma/' }]]);
});

test('malformed requests are rejected without throwing', async () => {
  for (const msg of [null, undefined, 'getState', 42, {}, { action: 5 }, { action: '__proto__' }, { action: 'constructor' }, { action: 'toString' }, { action: 'hasOwnProperty' }]) {
    const r = await dispatch(msg, POPUP);
    assert.equal(r.success, false, JSON.stringify(msg));
  }
  const arr = await dispatch({ action: 'getState', payload: [1, 2] }, POPUP);
  assert.equal(arr.success, true, 'array payload treated as empty object');
  assert.equal((await dispatch({ action: 'getState' }, undefined)).error, 'Untrusted sender.');
});

test('unexpected internal errors are masked and logged', async () => {
  const logs = []; console.error = (...a) => logs.push(a);
  chrome.storage.local.failNext('get', new TypeError('secret internal detail'));
  const r = await call('listContacts');
  console.error = realError;
  assert.deepEqual(r, { success: false, error: 'Something went wrong. Please try again.', code: null });
  assert.equal(logs.length, 1);
});

test('readProfile: builds hooks, flags missing name, reports existing contact', async () => {
  await call('saveSettings', { background: 'Flipkart' });
  mock.tabsState.onSend = async () => ({ success: true, data: { ...PRIYA, profileUrl: 'https://www.linkedin.com/in/priya-sharma/?trk=x', diagnostics: { foundCount: 8, total: 8 } } });
  const r = await call('readProfile', { tabId: 7 });
  assert.ok(r.success, r.error);
  assert.equal(r.data.profile.profileUrl, 'https://www.linkedin.com/in/priya-sharma/');
  assert.equal(r.data.hooks[0].kind, 'sharedCompany');
  assert.equal(r.data.diagnostics.foundCount, 8);
  assert.equal(r.data.contact, null);
  await store.mutateContact('in:priya-sharma', () => ({ name: 'Priya', status: 'sent', sentAt: 1, lastTouchAt: 1 }));
  assert.equal((await call('readProfile', { tabId: 7 })).data.contact.due, true);
  mock.tabsState.onSend = async () => ({ success: true, data: { name: '' } });
  assert.match((await call('readProfile', { tabId: 7 })).error, /Couldn't find a name/);
  mock.tabsState.onSend = async () => ({ success: true, data: { name: 'No Url Person' } });
  const noUrl = await call('readProfile', { tabId: 7 });
  assert.equal(noUrl.data.diagnostics, null);
});

test('AI mode: generate uses the key, passes previous draft, fits the limit', async () => {
  await call('saveSettings', { apiKey: 'sk-ant-test' });
  net.queue.push({ status: 200, text: 'Hi Priya — fellow Flipkart alum. Open to connecting?' });
  const r = await call('generate', { profile: PRIYA, hooks: [{ kind: 'post', label: 'Recent post', value: 'x', selected: true }], format: 'note', previousMessage: 'OLD DRAFT' });
  assert.equal(r.data.source, 'ai');
  assert.equal(net.requests[0].headers['x-api-key'], 'sk-ant-test');
  assert.match(net.requests[0].body.messages[0].content, /OLD DRAFT/);
  net.queue.push({ status: 200, text: 'z'.repeat(900) }, { status: 200, text: 'w '.repeat(400) });
  const long = await call('generate', { profile: PRIYA, hooks: [], format: 'note-free' });
  assert.ok(long.data.message.length <= 200);
});

test('AI errors surface clearly (auth, bad request, outage after retries)', async () => {
  await call('saveSettings', { apiKey: 'sk-ant-test' });
  net.queue.push({ status: 401 });
  assert.match((await call('generate', { profile: PRIYA })).error, /API key was rejected/);
  net.queue.push({ status: 400, msg: 'messages: too long' });
  assert.equal((await call('generate', { profile: PRIYA })).error, 'messages: too long');
  net.queue.push({ status: 503 }, { status: 503 }, { status: 503 });
  const r = await call('generate', { profile: PRIYA });
  assert.match(r.error, /busy/);
  assert.equal(r.code, 'overloaded');
  assert.equal(net.requests.length, 5, '1 + 1 + 3 attempts');
});

test('AI follow-up and missing contact', async () => {
  await call('saveSettings', { apiKey: 'sk-ant-test' });
  await store.mutateContact('in:p', () => ({ name: 'Priya', status: 'sent', message: 'orig', format: 'dm', purpose: 'Job' }));
  net.queue.push({ status: 200, text: 'Following up!' });
  const r = await call('generateFollowUp', { contactId: 'in:p' });
  assert.deepEqual(r.data, { message: 'Following up!', source: 'ai' });
  assert.match(net.requests[0].body.messages[0].content, /Hard limit: 600/);
  assert.match((await call('generateFollowUp', { contactId: 'in:none' })).error, /not found/);
});

test('testKey: empty, wrong prefix, valid (saved), rejected', async () => {
  assert.deepEqual((await call('testKey', {})).data, { valid: false, reason: 'Enter a key first.' });
  assert.match((await call('testKey', { apiKey: 'sk-openai-123' })).data.reason, /start with/);
  net.queue.push({ status: 200, text: 'OK' });
  assert.deepEqual((await call('testKey', { apiKey: 'sk-ant-good' })).data, { valid: true });
  assert.equal((await store.getSettings()).apiKey, 'sk-ant-good');
  net.queue.push({ status: 200, text: 'OK' });
  assert.equal((await call('testKey', {})).data.valid, true, 'tests the stored key when none typed');
  net.queue.push({ status: 401 });
  const bad = await call('testKey', { apiKey: 'sk-ant-bad' });
  assert.equal(bad.data.valid, false);
  assert.equal((await store.getSettings()).apiKey, 'sk-ant-good', 'a failed test never overwrites the working key');
});

test('parseResume: needs key; merges facts; keeps an existing bio; bad output', async () => {
  assert.match((await call('parseResume', { base64: 'JVBER' })).error, /API key first/);
  assert.match((await call('parseResume', {})).error, /over 4 MB/, 'empty upload rejected');
  await call('saveSettings', { apiKey: 'sk-ant-x', background: 'React, flipkart', bio: '' });
  net.queue.push({ status: 200, text: '{"summary":"I build","companies":["Flipkart","Swiggy"],"schools":["IIT Delhi"],"skills":["React","Go"],"location":"Pune, India"}' });
  const r = await call('parseResume', { base64: 'JVBER', fileName: 'cv.pdf' });
  assert.equal(r.data.settings.background, 'React, flipkart, Swiggy, IIT Delhi, Go, Pune');
  assert.equal(r.data.settings.bio, 'I build');
  assert.equal(r.data.settings.resumeFileName, 'cv.pdf');
  assert.equal(net.requests[0].body.messages[0].content[0].type, 'document');
  await call('saveSettings', { bio: 'Mine' });
  net.queue.push({ status: 200, text: '{"summary":"Other"}' });
  assert.equal((await call('parseResume', { base64: 'JVBER' })).data.settings.bio, 'Mine');
  net.queue.push({ status: 200, text: 'sorry, cannot' });
  assert.match((await call('parseResume', { base64: 'JVBER' })).error, /Couldn't read the resume/);
});

test('insert: status transitions, never downgrades, ignores failures', async () => {
  await store.mutateContact('in:p', () => ({ name: 'P', status: 'drafted' }));
  mock.tabsState.onSend = async () => ({ ok: true, kind: 'connection-note' });
  assert.match((await call('insert', { tabId: 7, text: '   ' })).error, /Nothing to insert/);
  await call('insert', { tabId: 7, text: 'Hello', contactId: 'in:p' });
  let c = await store.getContact('in:p');
  assert.equal(c.status, 'inserted');
  assert.ok(c.insertedAt && c.lastTouchAt);
  await call('setStatus', { contactId: 'in:p', status: 'replied' });
  await call('insert', { tabId: 7, text: 'Again', contactId: 'in:p' });
  c = await store.getContact('in:p');
  assert.equal(c.status, 'replied');
  mock.tabsState.onSend = async () => ({ ok: false, reason: 'noComposer' });
  await store.mutateContact('in:q', () => ({ name: 'Q', status: 'drafted' }));
  await call('insert', { tabId: 7, text: 'x', contactId: 'in:q' });
  assert.equal((await store.getContact('in:q')).status, 'drafted');
  assert.equal((await call('insert', { tabId: 7, text: 'x', contactId: 'in:ghost' })).success, true);
});

test('track / setStatus / delete validation', async () => {
  await store.mutateContact('in:p', () => ({ name: 'P', status: 'inserted', message: 'm' }));
  assert.match((await call('track', { contactId: 'in:p', event: 'sent' })).error, /Unknown event/);
  assert.equal((await call('track', { contactId: 'in:p', event: 'copied' })).data.contact.status, 'inserted', 'copy after insert keeps inserted');
  assert.match((await call('setStatus', { contactId: 'in:p', status: 'hacked' })).error, /Unknown status/);
  assert.equal((await call('setStatus', { contactId: 'in:ghost', status: 'sent' })).data.contact, null);
  assert.equal((await call('setStatus', { contactId: 'in:p', status: 'closed' })).data.contact.status, 'closed');
  assert.equal((await call('setStatus', { contactId: 'in:p', status: 'drafted' })).data.contact.status, 'drafted');
  await call('deleteContact', { contactId: 'in:p' });
  assert.equal(await store.getContact('in:p'), null);
  assert.equal((await call('markFollowedUp', { contactId: 'in:ghost' })).data.contact, null);
});

test('list filters, clamped paging, contacts without LinkedIn URLs are not tracked', async () => {
  const mk = (id, status) => store.mutateContact(id, () => ({ name: id, status }));
  await mk('in:a', 'drafted'); await mk('in:b', 'copied'); await mk('in:c', 'inserted'); await mk('in:d', 'sent'); await mk('in:e', 'replied');
  const total = async (filter) => (await call('listContacts', { filter })).data.total;
  assert.equal(await total('drafts'), 2);
  assert.equal(await total('waiting'), 2);
  assert.equal(await total('replied'), 1);
  assert.equal(await total('nonsense'), 5);
  const r = await call('listContacts', { offset: -5, limit: 100000 });
  assert.equal(r.data.items.length, 5);
  assert.equal((await call('listContacts', { offset: 'x', limit: 'y' })).data.items.length, 5);
  const g = await call('generate', { profile: { name: 'No URL' }, hooks: [] });
  assert.equal(g.data.contact, null);
});

test('session + prefs round-trip with validation', async () => {
  await call('saveSession', { url: 'https://www.linkedin.com/in/p/', profile: PRIYA, hooks: [{ kind: 'post', value: 'x', selected: true }], message: 'draft', variant: 2 });
  const s = (await call('getSession', { url: 'https://www.linkedin.com/in/p/' })).data.session;
  assert.equal(s.message, 'draft');
  assert.equal(s.profile.name, 'Priya Sharma');
  assert.equal((await call('getSession', { url: 'other' })).data.session, null);
  await call('saveSession', {});
  const p = (await call('savePrefs', { messageType: 'Hack', tone: 'Casual', format: 'xx' })).data.prefs;
  assert.deepEqual(p, { messageType: 'Networking', tone: 'Casual', format: 'note' });
});

test('template edge cases: empty name, short text, delete', async () => {
  assert.match((await call('saveTemplate', { name: '', text: 'Hello {firstName}!' })).error, /name/);
  assert.match((await call('saveTemplate', { name: 'x', text: 'hi' })).error, /too short/);
  const t = (await call('saveTemplate', { name: 'A', text: 'Hello there friend', purpose: 'Bogus' })).data.templates[0];
  assert.equal(t.purpose, '');
  assert.equal((await call('deleteTemplate', { id: t.id })).data.templates.length, 0);
});

test('applyTemplate fills the {hook} from the selected hook', async () => {
  const t = (await call('saveTemplate', { name: 'H', text: 'Hi {firstName}, {hook} Chat?' })).data.templates[0];
  const r = await call('applyTemplate', { templateId: t.id, profile: PRIYA, hooks: [{ kind: 'sharedSchool', value: 'IIT Bombay', selected: true }], variant: 1 });
  assert.equal(r.data.message, 'Hi Priya, Saw we both went to IIT Bombay. Chat?');
});
