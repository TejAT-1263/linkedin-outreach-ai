// background/followups.js — badge, notifications, alarm, click handling, failure tolerance.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.mjs';
import { DAY_MS } from '../../extension/shared/constants.js';

const mock = installChromeMock();
const store = await import('../../extension/background/store.js');
const fu = await import('../../extension/background/followups.js');
await store.init();

const due = (id, name, extra = {}) => store.mutateContact(id, () => ({ name, status: 'sent', sentAt: 1, lastTouchAt: Date.now() - 10 * DAY_MS, profileUrl: `https://www.linkedin.com/in/${id.slice(3)}/`, purpose: 'Job', ...extra }));

beforeEach(async () => {
  await store.clearContacts();
  await store.saveSettings({ followUpDays: 5, notifications: true });
  mock.notifications.length = 0;
  mock.opened.length = 0;
  mock.badge.fail = false;
  chrome.notifications.fail = false;
});

test('ensureAlarm creates the hourly alarm only when missing', async () => {
  chrome.alarms.existing = null; chrome.alarms.created.length = 0;
  await fu.ensureAlarm();
  assert.equal(chrome.alarms.created.length, 1);
  assert.equal(chrome.alarms.created[0].info.periodInMinutes, 60);
  chrome.alarms.existing = { name: 'followups-check' };
  await fu.ensureAlarm();
  assert.equal(chrome.alarms.created.length, 1);
});

test('no contacts → empty badge, no notifications', async () => {
  assert.equal(await fu.refresh({ notify: true }), 0);
  assert.equal(mock.badge.text, '');
  assert.equal(mock.notifications.length, 0);
});

test('one due → personal notification; second refresh does not repeat it', async () => {
  await due('in:priya', 'Priya Sharma');
  assert.equal(await fu.refresh({ notify: true }), 1);
  assert.equal(mock.badge.text, '1');
  assert.equal(mock.notifications.length, 1);
  assert.equal(mock.notifications[0].id, 'fu:in:priya');
  assert.match(mock.notifications[0].title, /Priya Sharma/);
  assert.match(mock.notifications[0].message, /job note/);
  await fu.refresh({ notify: true });
  assert.equal(mock.notifications.length, 1);
});

test('several due → one summary notification listing up to 3 names', async () => {
  for (const n of ['a', 'b', 'c', 'd']) await due(`in:${n}`, `Person ${n}`);
  await fu.refresh({ notify: true });
  assert.equal(mock.notifications.length, 1);
  assert.equal(mock.notifications[0].id, 'fu:summary');
  assert.equal(mock.notifications[0].title, '4 follow-ups due');
  assert.match(mock.notifications[0].message, /^Person [a-d], Person [a-d], Person [a-d]…$/);
});

test('notify=false or notifications turned off → badge only', async () => {
  await due('in:x', 'X');
  await fu.refresh({ notify: false });
  assert.equal(mock.notifications.length, 0);
  await store.saveSettings({ notifications: false });
  await fu.refresh({ notify: true });
  assert.equal(mock.notifications.length, 0);
  assert.equal(mock.badge.text, '1');
});

test('blocked notifications or a failing badge never break refresh; retry later', async () => {
  await due('in:x', 'X');
  chrome.notifications.fail = true;
  mock.badge.fail = true;
  assert.equal(await fu.refresh({ notify: true }), 1);
  assert.equal((await store.getContact('in:x')).notifiedAt, null, 'not marked notified, so it retries next hour');
  chrome.notifications.fail = false;
  await fu.refresh({ notify: true });
  assert.equal(mock.notifications.length, 1);
});

test('missing notifications API (permission removed) is tolerated', async () => {
  await due('in:x', 'X');
  const saved = chrome.notifications;
  chrome.notifications = undefined;
  assert.equal(await fu.refresh({ notify: true }), 1);
  chrome.notifications = saved;
});

test('badge caps at 99', async () => {
  await Promise.all(Array.from({ length: 120 }, (_, i) => due(`in:p${i}`, `P${i}`)));
  await fu.refresh({ notify: false });
  assert.equal(mock.badge.text, '99');
});

test('clicking notifications opens the right page; foreign ids ignored', async () => {
  await due('in:priya', 'Priya');
  await fu.onNotificationClicked('other:1');
  await fu.onNotificationClicked('fu:in:priya');
  await fu.onNotificationClicked('fu:summary');
  await fu.onNotificationClicked('fu:in:ghost');
  assert.deepEqual(mock.opened, ['https://www.linkedin.com/in/priya/', 'https://www.linkedin.com/messaging/']);
});
