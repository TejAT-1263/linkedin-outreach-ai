// popup/tracker.js — the Tracker tab: who you reached out to, who replied, who needs a follow-up.
import { call, ACTIONS } from './api.js';
import { $, h, show, setSegmented, wireSegmentedKeys, copyText, toast, relativeTime, download } from './dom.js';
import { LIMITS, STATUS } from '../shared/constants.js';

const st = { filter: 'all', query: '', offset: 0, items: [], total: 0, followUpVariant: {} };
let app;
let searchTimer;

const STATUS_LABEL = { drafted: 'Draft', copied: 'Copied', inserted: 'Inserted', sent: 'Sent', replied: 'Replied', closed: 'Closed' };

export function init(appCtx) {
  app = appCtx;
  $('tracker-filter').addEventListener('click', (e) => {
    const b = e.target.closest('.seg'); if (!b) return;
    st.filter = b.dataset.filter;
    setSegmented('tracker-filter', 'filter', st.filter);
    load();
  });
  wireSegmentedKeys('tracker-filter');
  $('tracker-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { st.query = $('tracker-search').value; load(); }, 150);
  });
  $('more-btn').addEventListener('click', () => load({ append: true }));
  $('export-btn').addEventListener('click', exportCsv);
  $('clear-btn').addEventListener('click', clearAll);
}

export async function load({ append = false } = {}) {
  st.offset = append ? st.items.length : 0;
  try {
    const res = await call(ACTIONS.LIST_CONTACTS, { query: st.query, filter: st.filter, offset: st.offset, limit: LIMITS.PAGE_SIZE });
    st.items = append ? [...st.items, ...res.items] : res.items;
    st.total = res.total;
    app.applyStats(res.stats);
    render(append ? res.items : null);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function renderStats(stats) {
  $('stat-reached').textContent = stats.reached;
  $('stat-replied').textContent = stats.replied;
  $('stat-rate').textContent = stats.reached ? `${Math.round(stats.replyRate * 100)}%` : '–';
  $('due-count').textContent = stats.due ? `(${stats.due})` : '';
  const ins = $('insight');
  if (stats.best && stats.reached >= 3) {
    ins.textContent = `What's working: “${stats.best.label}” openers — ${stats.best.replied} of ${stats.best.reached} replied.`;
    show(ins);
  } else if (stats.reached > 0 && stats.reached < 3) {
    ins.textContent = `Reach out to ${3 - stats.reached} more ${3 - stats.reached === 1 ? 'person' : 'people'} to see which openers get replies.`;
    show(ins);
  } else show(ins, false);
}

function render(appended) {
  const list = $('contact-list');
  if (appended) list.append(...appended.map(card));
  else list.replaceChildren(...st.items.map(card));
  show('more-btn', st.items.length < st.total);
  $('more-btn').textContent = `Show more (${st.total - st.items.length})`;
  const empty = st.total === 0;
  show('tracker-empty', empty);
  if (empty) {
    const filtered = st.query || st.filter !== 'all';
    $('tracker-empty-title').textContent = filtered ? 'Nothing matches.' : 'No one here yet.';
    $('tracker-empty-hint').textContent = filtered
      ? (st.filter === 'due' ? 'No follow-ups are due. Nice.' : 'Try a different filter or search.')
      : "People you write to show up here. Insert a note and you'll get a reminder to follow up if they don't reply.";
  }
}

function timeline(c) {
  if (c.status === STATUS.REPLIED) return `Replied ${relativeTime(c.repliedAt)}`;
  if (c.due) return `Follow-up due${c.followUps ? ` · ${c.followUps} sent` : ''}`;
  if ([STATUS.INSERTED, STATUS.SENT].includes(c.status) && c.dueAt) return `Follow up ${relativeTime(c.dueAt)}${c.followUps ? ` · ${c.followUps} sent` : ''}`;
  return `Updated ${relativeTime(c.updatedAt)}`;
}

function card(c) {
  const el = h('article', { class: `contact${c.due ? ' due' : ''}`, dataset: { id: c.id } });
  const awaiting = [STATUS.INSERTED, STATUS.SENT].includes(c.status);

  const actions = h('div', { class: 'contact-actions' },
    [STATUS.DRAFTED, STATUS.COPIED, STATUS.INSERTED].includes(c.status)
      ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => setStatus(c, STATUS.SENT) }, 'Mark sent') : null,
    awaiting || c.status === STATUS.CLOSED
      ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => setStatus(c, STATUS.REPLIED) }, '✓ Replied') : null,
    awaiting
      ? h('button', { class: `btn btn-sm ${c.due ? 'btn-primary' : 'btn-secondary'}`, type: 'button', onclick: () => followUp(c, el) }, 'Write follow-up') : null,
    c.status === STATUS.REPLIED
      ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => setStatus(c, STATUS.SENT) }, 'Undo') : null,
    h('span', { class: 'spacer' }),
    c.profileUrl ? h('button', { class: 'icon-btn', type: 'button', title: 'Open profile', 'aria-label': `Open ${c.name}'s profile`, onclick: () => chrome.tabs.create({ url: c.profileUrl }) }, '↗') : null,
    h('button', { class: 'icon-btn', type: 'button', title: 'Copy message', 'aria-label': 'Copy message', onclick: async () => { await copyText(c.message || ''); toast('Copied'); } }, '⧉'),
    h('button', { class: 'icon-btn danger', type: 'button', title: 'Remove from tracker', 'aria-label': `Remove ${c.name}`, onclick: () => remove(c, el) }, '×')
  );

  const msg = h('p', { class: 'contact-msg', tabindex: '0', title: 'Click to expand', onclick: () => el.classList.toggle('expanded'),
    onkeydown: (e) => { if (e.key === 'Enter') el.classList.toggle('expanded'); } }, c.message || '');

  el.append(
    h('div', { class: 'contact-top' },
      h('div', { class: 'contact-who' },
        h('div', { class: 'contact-name' }, c.name),
        h('div', { class: 'contact-meta' }, c.headline || c.company || '')),
      h('div', { class: 'contact-side' },
        h('span', { class: `pill pill-${c.status}` }, STATUS_LABEL[c.status] || c.status),
        h('span', { class: `contact-when${c.due ? ' due' : ''}` }, timeline(c)))),
    msg,
    actions,
    h('div', { class: 'followup hidden' })
  );
  return el;
}

async function setStatus(c, status) {
  try {
    await call(ACTIONS.SET_STATUS, { contactId: c.id, status });
    if (status === STATUS.REPLIED) toast(`Nice — ${c.name.split(' ')[0]} replied.`, 'success');
    await load();
  } catch (err) { toast(err.message, 'error'); }
}

async function followUp(c, el) {
  const box = el.querySelector('.followup');
  const variant = (st.followUpVariant[c.id] = (st.followUpVariant[c.id] ?? -1) + 1);
  box.replaceChildren(h('div', { class: 'muted small' }, 'Writing follow-up…'));
  show(box);
  try {
    const { message } = await call(ACTIONS.GENERATE_FOLLOWUP, { contactId: c.id, variant });
    const ta = h('textarea', { class: 'input followup-text', rows: '5', 'aria-label': `Follow-up for ${c.name}` });
    ta.value = message;
    box.replaceChildren(
      ta,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => followUp(c, el) }, '↻ Another'),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: async () => { await copyText(ta.value, ta); toast('Copied — paste it in your LinkedIn chat'); } }, 'Copy'),
        c.profileUrl ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => chrome.tabs.create({ url: c.profileUrl }) }, 'Open profile') : null,
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => markFollowedUp(c, ta.value) }, 'Mark as sent'))
    );
    ta.focus();
  } catch (err) {
    box.replaceChildren(h('div', { class: 'status status-error' }, err.message));
  }
}

async function markFollowedUp(c, message) {
  try {
    await call(ACTIONS.MARK_FOLLOWED_UP, { contactId: c.id, message });
    toast(`Logged. Next reminder in ${app.state.settings.followUpDays}+ days.`, 'success');
    await load();
  } catch (err) { toast(err.message, 'error'); }
}

async function remove(c, el) {
  if (el.dataset.confirm !== '1') {
    el.dataset.confirm = '1';
    toast(`Click × again to remove ${c.name}.`, 'warning');
    setTimeout(() => { delete el.dataset.confirm; }, 3000);
    return;
  }
  await call(ACTIONS.DELETE_CONTACT, { contactId: c.id }).catch(err => toast(err.message, 'error'));
  await load();
}

export async function exportCsv() {
  try {
    const { csv, filename, count } = await call(ACTIONS.EXPORT_CSV);
    if (!count) return toast('Nothing to export yet.');
    download(filename, '﻿' + csv); // BOM so Excel reads UTF-8 names correctly
    toast(`Exported ${count} contacts.`, 'success');
  } catch (err) { toast(err.message, 'error'); }
}

let clearArmed = false;
async function clearAll() {
  if (!clearArmed) {
    clearArmed = true;
    $('clear-btn').textContent = 'Click again to clear everything';
    setTimeout(() => { clearArmed = false; $('clear-btn').textContent = 'Clear tracker'; }, 3500);
    return;
  }
  clearArmed = false;
  $('clear-btn').textContent = 'Clear tracker';
  await call(ACTIONS.CLEAR_CONTACTS).catch(err => toast(err.message, 'error'));
  await load();
  toast('Tracker cleared.');
}
