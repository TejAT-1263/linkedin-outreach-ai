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

chrome.runtime.onInstalled.addListener(async () => {
  await ready;
  await followups.ensureAlarm();
  await followups.refresh({ notify: false });
});

chrome.runtime.onStartup.addListener(async () => {
  await ready;
  await followups.ensureAlarm();
  await followups.refresh({ notify: false });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_FOLLOWUPS) return;
  await ready;
  await followups.refresh({ notify: true });
});

chrome.notifications?.onClicked.addListener((id) => { followups.onNotificationClicked(id); });
