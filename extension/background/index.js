// background/index.js — service worker entry. Listeners must be registered synchronously at top level.
import { ALARM_FOLLOWUPS } from '../shared/constants.js';
import { dispatch } from './router.js';
import * as store from './store.js';
import * as followups from './followups.js';

// Every handler waits for migration to finish, so no request ever sees old-format data.
const ready = store.init().catch(err => console.error('[outreach] init failed', err));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ready.then(() => dispatch(message, sender)).then(sendResponse);
  return true; // keep the channel open for the async response
});

const safely = (label, fn) => async (...args) => {
  try { await ready; await fn(...args); } catch (err) { console.error(`[outreach] ${label} failed`, err); }
};

const boot = safely('startup', async () => {
  await followups.ensureAlarm();
  await followups.refresh({ notify: false });
});
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

chrome.alarms.onAlarm.addListener(safely('alarm', async (alarm) => {
  if (alarm.name === ALARM_FOLLOWUPS) await followups.refresh({ notify: true });
}));

chrome.notifications?.onClicked.addListener(safely('notification', (id) => followups.onNotificationClicked(id)));
