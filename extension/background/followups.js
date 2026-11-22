// background/followups.js — follow-up reminders: toolbar badge + optional notifications.
import { ALARM_FOLLOWUPS } from '../shared/constants.js';
import { isDue, followUpDueAt } from './tracker.js';
import * as store from './store.js';

export async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_FOLLOWUPS);
  if (!existing) await chrome.alarms.create(ALARM_FOLLOWUPS, { delayInMinutes: 1, periodInMinutes: 60 });
}

/** Recompute due follow-ups, update the badge, and (optionally) notify once per due cycle. */
export async function refresh({ notify = false } = {}) {
  const [contacts, settings] = await Promise.all([store.listContacts(), store.getSettings()]);
  const now = Date.now();
  const due = contacts.filter(c => isDue(c, now, settings.followUpDays));

  try {
    await chrome.action.setBadgeText({ text: due.length ? String(Math.min(due.length, 99)) : '' });
    if (due.length) await chrome.action.setBadgeBackgroundColor({ color: '#1A56DB' });
    await chrome.action.setTitle({ title: due.length ? `LinkedIn Outreach AI — ${due.length} follow-up${due.length > 1 ? 's' : ''} due` : 'LinkedIn Outreach AI' });
  } catch { /* badge is cosmetic; never fail the caller over it */ }

  if (!notify || !settings.notifications || !chrome.notifications) return due.length;

  const fresh = due.filter(c => !c.notifiedAt || c.notifiedAt < followUpDueAt(c, settings.followUpDays));
  if (!fresh.length) return due.length;

  try {
    // Await creation so a rejected OS/browser notification isn't recorded as delivered.
    await notifyUser(fresh);
  } catch { return due.length; /* notifications blocked by the OS/browser: badge still works */ }
  for (const c of fresh) await store.mutateContact(c.id, prev => (prev ? { ...prev, notifiedAt: now } : null));
  return due.length;
}

async function notifyUser(fresh) {
  if (fresh.length === 1) {
    const c = fresh[0];
    await chrome.notifications.create(`fu:${c.id}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `Follow up with ${c.name}?`,
      message: `No reply yet to your ${c.purpose?.toLowerCase() || ''} note. Open the extension to draft a follow-up.`,
      priority: 0
    });
  } else {
    await chrome.notifications.create('fu:summary', {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `${fresh.length} follow-ups due`,
      message: fresh.slice(0, 3).map(c => c.name).join(', ') + (fresh.length > 3 ? '…' : ''),
      priority: 0
    });
  }
}

export async function onNotificationClicked(id) {
  if (!id.startsWith('fu:')) return;
  chrome.notifications.clear(id);
  if (id === 'fu:summary') return chrome.tabs.create({ url: 'https://www.linkedin.com/messaging/' });
  const c = await store.getContact(id.slice(3));
  if (c?.profileUrl) chrome.tabs.create({ url: c.profileUrl });
}
