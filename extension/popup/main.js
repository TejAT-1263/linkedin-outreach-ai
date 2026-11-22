// popup/main.js — boot, tabs, theme, shortcuts. Each tab lives in its own module.
import { call, ACTIONS } from './api.js';
import { $, show, toast } from './dom.js';
import * as write from './write.js';
import * as tracker from './tracker.js';
import * as settings from './settings.js';

const app = {
  state: { settings: {}, prefs: {}, templates: [], stats: {}, version: '' },
  applyTheme,
  applyStats,
  async refreshStats() {
    const s = await call(ACTIONS.GET_STATE).catch(() => null);
    if (s) applyStats(s.stats);
  },
  onSettingsChanged() {
    renderKeyBadge();
    write.onSettingsChanged();
  },
  renderTemplates: () => settings.renderTemplates()
};

document.addEventListener('DOMContentLoaded', boot);

// Safety net: an unexpected error should never leave the popup silently broken.
window.addEventListener('error', () => toast('Something went wrong. Please try again.', 'error'));
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  toast(e.reason?.message || 'Something went wrong. Please try again.', 'error');
});

async function boot() {
  try {
    Object.assign(app.state, await call(ACTIONS.GET_STATE));
  } catch (err) {
    document.body.classList.add('booted');
    $('status').textContent = err.message;
    $('status').className = 'status status-error';
    return;
  }
  applyTheme(app.state.settings.theme);
  renderKeyBadge();
  applyStats(app.state.stats);
  wireTabs();
  settings.init(app);
  tracker.init(app);
  await write.init(app);
  document.addEventListener('keydown', onKey);
  // Open straight on the tracker when follow-ups are due and we're not on a profile.
  if (app.state.stats.due && $('read-btn').disabled) switchTab('tracker');
  document.body.classList.add('booted');
}

function wireTabs() {
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.goto)));
  $('key-status').addEventListener('click', () => switchTab('settings'));
  document.querySelector('.tab-nav').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const tabs = [...document.querySelectorAll('.tab-btn')];
    const i = tabs.indexOf(document.activeElement);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus(); switchTab(next.dataset.tab);
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
  if (name === 'tracker') tracker.load();
}

function onKey(e) {
  if ($('tab-write').classList.contains('active')) write.handleShortcut(e);
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function applyStats(stats) {
  app.state.stats = stats;
  const badge = $('due-badge');
  badge.textContent = stats.due || '';
  badge.title = stats.due ? `${stats.due} follow-up${stats.due > 1 ? 's' : ''} due` : '';
  show(badge, stats.due > 0);
  tracker.renderStats(stats);
}

function renderKeyBadge() {
  const s = app.state.settings;
  const el = $('key-status');
  el.textContent = s.hasKey ? '✦ AI · your key' : '✎ Built-in writer';
  el.title = s.hasKey ? 'Drafts are written by AI with your Anthropic key. Click to manage.' : 'Drafts are written locally — nothing leaves your browser. Click to add an AI key.';
  el.className = `key-status ${s.hasKey ? 'ai' : 'local'}`;
}
