// background/tracker.js — pure logic for contacts: follow-up due dates, stats, CSV, pruning.
import { STATUS, AWAITING, DAY_MS, HOOK_GROUP, GROUP_LABEL, LIMITS } from '../shared/constants.js';
import { csvCell } from '../shared/text.js';

export function isAwaiting(c) {
  return AWAITING.includes(c.status);
}

/** When is the next follow-up due? null if not waiting on a reply. */
export function followUpDueAt(c, followUpDays) {
  if (!isAwaiting(c)) return null;
  const base = c.lastTouchAt || c.sentAt || c.insertedAt;
  if (!base) return null;
  // Each further follow-up waits a bit longer (5d, then 7d, then 10d…).
  const days = followUpDays * (1 + 0.4 * (c.followUps || 0));
  return base + Math.round(days * DAY_MS);
}

export function isDue(c, now, followUpDays) {
  const at = followUpDueAt(c, followUpDays);
  return at !== null && now >= at && (c.followUps || 0) < 3;
}

export function primaryGroup(c) {
  const kind = c.hooks?.[0]?.kind;
  return kind ? (HOOK_GROUP[kind] || 'none') : (c.fromTemplate ? 'template' : 'none');
}

/** Reply-rate stats. Only counts people we actually reached out to. */
export function computeStats(contacts, now, followUpDays) {
  const reached = contacts.filter(c => c.sentAt || c.insertedAt || c.status === STATUS.REPLIED);
  const replied = reached.filter(c => c.status === STATUS.REPLIED);
  const due = contacts.filter(c => isDue(c, now, followUpDays));
  const byGroup = {};
  for (const c of reached) {
    const g = primaryGroup(c);
    byGroup[g] ||= { group: g, label: GROUP_LABEL[g] || g, reached: 0, replied: 0 };
    byGroup[g].reached += 1;
    if (c.status === STATUS.REPLIED) byGroup[g].replied += 1;
  }
  const groups = Object.values(byGroup).map(g => ({ ...g, rate: g.reached ? g.replied / g.reached : 0 }))
    .sort((a, b) => b.rate - a.rate || b.reached - a.reached);
  const best = groups.find(g => g.reached >= 2 && g.replied > 0) || null;
  return {
    total: contacts.length,
    reached: reached.length,
    replied: replied.length,
    replyRate: reached.length ? replied.length / reached.length : 0,
    due: due.length,
    groups,
    best
  };
}

/** Keep the store bounded: drop the oldest, least-active contacts past the cap. */
export function prune(contactsMap, max = LIMITS.MAX_CONTACTS) {
  const list = Object.values(contactsMap);
  if (list.length <= max) return contactsMap;
  const weight = (c) => (isAwaiting(c) ? 2 : c.status === STATUS.REPLIED ? 1 : 0);
  list.sort((a, b) => weight(a) - weight(b) || (a.updatedAt || 0) - (b.updatedAt || 0));
  const drop = new Set(list.slice(0, list.length - max).map(c => c.id));
  return Object.fromEntries(Object.entries(contactsMap).filter(([id]) => !drop.has(id)));
}

export function toCsv(contacts) {
  const cols = ['name', 'headline', 'company', 'profileUrl', 'purpose', 'status', 'opener', 'followUps', 'created', 'sent', 'message'];
  const iso = (t) => (Number.isFinite(t) && t > 0 && t < 8.64e15 ? new Date(t).toISOString() : '');
  const rows = contacts.map(c => [
    c.name, c.headline, c.company, c.profileUrl, c.purpose, c.status,
    GROUP_LABEL[primaryGroup(c)], c.followUps || 0, iso(c.createdAt), iso(c.sentAt || c.insertedAt), c.message
  ].map(csvCell).join(','));
  return [cols.map(csvCell).join(','), ...rows].join('\r\n');
}
