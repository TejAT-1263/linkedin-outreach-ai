// popup/write.js — the Write tab: read profile → pick hooks → draft → insert / copy.
import { call, ACTIONS } from './api.js';
import { $, h, show, setStatus, setSegmented, wireSegmentedKeys, copyText, toast, relativeTime } from './dom.js';
import { FORMATS, LIMITS, STATUS } from '../shared/constants.js';
import { openerFor } from '../background/writer-local.js';

const WRITER = '__writer__';

const st = {
  tabId: null, tabUrl: '', onProfile: false,
  profile: null, hooks: [], diagnostics: null, contact: null,
  variant: 0, source: WRITER, format: 'note',
  busy: false, confirmReplace: false
};
let app;

export async function init(appCtx) {
  app = appCtx;
  wire();
  applyPrefs(app.state.prefs);
  renderSourceOptions();
  await detectTab();
  await restoreSession();
  updateSetupTip();
}

export function onSettingsChanged() {
  renderSourceOptions();
  updateSetupTip();
}

// ─── Setup ────────────────────────────────────────────────────────────────────
function wire() {
  $('read-btn').addEventListener('click', read);
  $('regen-btn').addEventListener('click', () => generate({ regenerate: true }));
  $('copy-btn').addEventListener('click', copy);
  $('insert-btn').addEventListener('click', insert);
  $('draft-text').addEventListener('input', () => { updateMeter(); resetInsert(); persistSoon(); });

  $('format').addEventListener('click', (e) => {
    const b = e.target.closest('.seg'); if (!b) return;
    setFormat(b.dataset.format); savePrefs(); optionsChanged();
  });
  wireSegmentedKeys('format');
  ['message-type', 'tone'].forEach(id => $(id).addEventListener('change', () => { savePrefs(); optionsChanged(); }));
  $('source-select').addEventListener('change', () => { st.source = $('source-select').value; generate({ regenerate: false }); });

  $('custom-hook-form').addEventListener('submit', (e) => { e.preventDefault(); addCustomHook(); });
  $('read-pill').addEventListener('click', () => show('read-detail', $('read-detail').classList.contains('hidden')));

  $('save-tpl-open').addEventListener('click', () => { show('save-tpl-form'); $('tpl-name').focus(); });
  $('save-tpl-cancel').addEventListener('click', () => show('save-tpl-form', false));
  $('save-tpl-form').addEventListener('submit', (e) => { e.preventDefault(); saveTemplate(); });
}

export function handleShortcut(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'Enter' && !$('draft').classList.contains('hidden')) { e.preventDefault(); insert(); return true; }
  if (e.altKey && (e.key === 'n' || e.key === 'N' || e.code === 'KeyN') && st.profile) { e.preventDefault(); generate({ regenerate: true }); return true; }
  return false;
}

async function detectTab() {
  const forced = Number(new URLSearchParams(location.search).get('tabId')); // test harness only
  const tab = forced ? await chrome.tabs.get(forced).catch(() => null)
                     : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  st.tabId = tab?.id ?? null;
  st.tabUrl = (tab?.url || '').split(/[?#]/)[0];
  st.onProfile = /^https:\/\/www\.linkedin\.com\/in\/[^/]+/.test(st.tabUrl);
  $('read-btn').disabled = !st.onProfile;
  show('page-warning', !st.onProfile);
}

function applyPrefs(prefs) {
  $('message-type').value = prefs.messageType;
  $('tone').value = prefs.tone;
  setFormat(prefs.format);
}

function setFormat(f) {
  st.format = FORMATS[f] ? f : 'note';
  setSegmented('format', 'format', st.format);
  updateMeter();
}

function savePrefs() {
  call(ACTIONS.SAVE_PREFS, { messageType: $('message-type').value, tone: $('tone').value, format: st.format }).catch(() => {});
}

function updateSetupTip() {
  const s = app.state.settings;
  show('setup-tip', st.onProfile && !s.name && !s.background);
}

// The built-in writer is instant, so changes redraft live. AI calls cost money: ask first.
function optionsChanged() {
  if (!st.profile) return;
  if (st.source === WRITER && app.state.settings.hasKey) setStatus('status', 'Options changed — click “↻ New version” to redraft.', 'info');
  else generate({ regenerate: false });
}

// ─── Read ─────────────────────────────────────────────────────────────────────
async function read() {
  if (st.busy) return;
  setBusy(true, 'read');
  setStatus('status', '');
  show('profile-card', false); show('profile-skeleton');
  try {
    const res = await call(ACTIONS.READ_PROFILE, { tabId: st.tabId });
    Object.assign(st, { profile: res.profile, hooks: res.hooks, diagnostics: res.diagnostics, contact: res.contact, variant: 0 });
    renderProfile(); renderHooks(); renderContactBanner();
    setBusy(false, 'read');
    await generate({ regenerate: false });
  } catch (err) {
    setStatus('status', err.message, 'error');
  } finally {
    show('profile-skeleton', false);
    if (st.profile) show('profile-card');
    setBusy(false, 'read');
  }
}

// ─── Generate ─────────────────────────────────────────────────────────────────
async function generate({ regenerate }) {
  if (!st.profile || st.busy) return;
  if (regenerate) st.variant += 1;
  setBusy(true, 'regen');
  try {
    const common = { profile: st.profile, hooks: st.hooks, format: st.format, variant: st.variant };
    const res = st.source === WRITER
      ? await call(ACTIONS.GENERATE, {
          ...common, messageType: $('message-type').value, tone: $('tone').value,
          previousMessage: regenerate ? $('draft-text').value : ''
        })
      : await call(ACTIONS.APPLY_TEMPLATE, { ...common, templateId: st.source });
    st.contact = res.contact || st.contact;
    renderDraft(res.message, res.source);
    setStatus('status', '');
    persist();
  } catch (err) {
    setStatus('status', err.message, 'error');
  } finally {
    setBusy(false, 'regen');
  }
}

// ─── Insert / copy ────────────────────────────────────────────────────────────
let inserting = false;
async function insert() {
  const text = $('draft-text').value.trim();
  if (!text || inserting || st.busy) return;
  inserting = true;
  try { await doInsert(text); } finally { inserting = false; }
}

async function doInsert(text) {
  const fmt = FORMATS[st.format];
  if (fmt.hard && text.length > fmt.limit) {
    setStatus('status', `This is ${text.length} characters — a connection note allows ${fmt.limit}. Trim it or click “↻ New version”.`, 'error');
    return;
  }
  try {
    const res = await call(ACTIONS.INSERT, { tabId: st.tabId, text, replace: st.confirmReplace, contactId: st.contact?.id });
    if (res.ok) {
      resetInsert();
      setStatus('status', `Inserted into the LinkedIn ${res.kind === 'connection-note' ? 'connection note' : 'message box'}. Give it a read, then hit Send — we'll remind you to follow up in ${app.state.settings.followUpDays} days if they don't reply.`, 'success');
      app.refreshStats();
    } else if (res.reason === 'notEmpty') {
      st.confirmReplace = true;
      $('insert-btn').textContent = 'Replace LinkedIn text';
      setStatus('status', 'That LinkedIn box already has text in it. Click again to replace it.', 'warning');
    } else if (res.reason === 'tooLong') {
      const hint = res.maxLength <= 200 && st.format === 'note' ? ' Switch to “Free-plan note”.' : '';
      setStatus('status', `LinkedIn allows ${res.maxLength} characters here and this draft is ${text.length}.${hint}`, 'error');
    } else if (res.reason === 'notVerified') {
      await copyText(text, $('draft-text'));
      setStatus('status', "LinkedIn didn't accept the text automatically, so it's copied — click into the box and paste (Ctrl/⌘+V).", 'warning');
    } else {
      await copyText(text, $('draft-text'));
      await track('copied');
      setStatus('status', 'No open LinkedIn box found, so it’s copied instead. On the profile click “Message” (or “Connect → Add a note”), then reopen this and click Insert — your draft will still be here.', 'warning');
    }
  } catch (err) {
    setStatus('status', err.message, 'error');
  }
}

async function copy() {
  const text = $('draft-text').value;
  if (!text) return;
  await copyText(text, $('draft-text'));
  await track('copied');
  const b = $('copy-btn');
  b.textContent = '✓ Copied';
  setTimeout(() => { b.textContent = 'Copy'; }, 1600);
}

async function track(event) {
  if (!st.contact?.id) return;
  await call(ACTIONS.TRACK, { contactId: st.contact.id, event, message: $('draft-text').value }).catch(() => {});
}

function resetInsert() {
  st.confirmReplace = false;
  $('insert-btn').textContent = 'Insert into LinkedIn';
}

// ─── Hooks ────────────────────────────────────────────────────────────────────
function renderHooks() {
  const list = $('hook-list');
  list.replaceChildren(...st.hooks.map(hk => {
    const common = hk.kind.startsWith('shared');
    return h('button', {
      type: 'button',
      class: `chip${hk.selected ? ' selected' : ''}${common ? ' common' : ''}`,
      'aria-pressed': String(!!hk.selected),
      title: common ? 'Something you have in common — the strongest kind of opener' : hk.label,
      onclick: () => toggleHook(hk.id)
    }, common ? '★ ' : '', hk.label);
  }));
  show('hooks', !!st.profile);
}

function toggleHook(id) {
  const hk = st.hooks.find(x => x.id === id);
  if (!hk) return;
  if (hk.selected) hk.selected = false;
  else {
    const selected = st.hooks.filter(x => x.selected);
    if (selected.length >= LIMITS.MAX_HOOKS) selected.sort((a, b) => (a.pickedAt || 0) - (b.pickedAt || 0))[0].selected = false;
    hk.selected = true;
    hk.pickedAt = Date.now();
  }
  renderHooks();
  optionsChanged();
}

function addCustomHook() {
  const input = $('custom-hook');
  const text = input.value.trim();
  if (!text || !st.profile) return;
  const hk = { id: `custom-${Date.now()}`, kind: 'custom', label: text, value: text, score: 11, selected: false };
  st.hooks.unshift(hk);
  input.value = '';
  toggleHook(hk.id);
}

// ─── Templates ────────────────────────────────────────────────────────────────
export function renderSourceOptions() {
  const sel = $('source-select');
  const purpose = $('message-type').value;
  const tpls = [...app.state.templates].sort((a, b) => (b.purpose === purpose) - (a.purpose === purpose) || (b.uses || 0) - (a.uses || 0));
  sel.replaceChildren(
    h('option', { value: WRITER }, app.state.settings.hasKey ? '✦ AI writer (your key)' : '✎ Built-in writer'),
    tpls.length ? h('optgroup', { label: 'Your templates' }, tpls.map(t => h('option', { value: t.id }, `☆ ${t.name}`))) : null
  );
  if (st.source !== WRITER && !tpls.some(t => t.id === st.source)) st.source = WRITER;
  sel.value = st.source;
}

async function saveTemplate() {
  const name = $('tpl-name').value.trim();
  if (!name) return;
  const selected = st.hooks.filter(x => x.selected);
  try {
    const { templates } = await call(ACTIONS.SAVE_TEMPLATE, {
      name, text: $('draft-text').value, purpose: $('message-type').value,
      ctx: {
        firstName: st.profile?.firstName, company: st.profile?.currentCompany, title: st.profile?.currentTitle,
        hookSentence: st.source === WRITER ? openerFor(selected[0], st.variant, 0) : ''
      }
    });
    app.state.templates = templates;
    renderSourceOptions();
    app.renderTemplates();
    $('tpl-name').value = '';
    show('save-tpl-form', false);
    toast(`Saved “${name}”. Pick it from the menu above the draft next time.`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderProfile() {
  const p = st.profile;
  $('profile-avatar').textContent = (p.name || '?').charAt(0).toUpperCase();
  $('profile-name').textContent = p.name;
  $('profile-headline').textContent = p.headline || [p.currentTitle, p.currentCompany].filter(Boolean).join(' at ');
  show('profile-card');
  $('read-label').textContent = 'Re-read profile';
  renderReadCheck();
}

const PART_LABEL = { name: 'Name', headline: 'Headline', location: 'Location', about: 'About', experience: 'Experience', education: 'Education', skills: 'Skills', activity: 'Recent posts' };

function renderReadCheck() {
  const d = st.diagnostics;
  if (!d) { show('read-pill', false); show('read-detail', false); show('layout-warning', false); return; }
  const pill = $('read-pill');
  pill.textContent = `${d.foundCount}/${d.total} read`;
  pill.className = `read-pill ${d.layoutSuspect ? 'bad' : d.foundCount >= 5 ? 'good' : 'ok'}`;
  pill.title = 'What we could read from this profile — click for details';
  const found = Object.entries(d.found).filter(([, v]) => v).map(([k]) => PART_LABEL[k]);
  const missing = Object.entries(d.found).filter(([, v]) => !v).map(([k]) => PART_LABEL[k]);
  $('read-detail').replaceChildren(
    h('div', {}, h('strong', {}, 'Read: '), found.join(', ') || '—'),
    missing.length ? h('div', {}, h('strong', {}, 'Not found: '), missing.join(', '), h('span', { class: 'muted' }, ' — often just empty on this profile.')) : null
  );
  show('read-detail', false);
  show('layout-warning', d.layoutSuspect);
}

const STATUS_TEXT = { inserted: 'inserted a note for', sent: 'sent a note to', replied: 'heard back from', closed: 'closed out' };

function renderContactBanner() {
  const c = st.contact;
  const contacted = c && [STATUS.INSERTED, STATUS.SENT, STATUS.REPLIED, STATUS.CLOSED].includes(c.status);
  show('contact-banner', !!contacted);
  if (!contacted) return;
  const when = relativeTime(c.lastTouchAt || c.insertedAt || c.sentAt || c.updatedAt);
  $('contact-banner-text').textContent = `You ${STATUS_TEXT[c.status]} ${c.name.split(' ')[0]} ${when}${c.due ? ' — a follow-up is due.' : '.'}`;
}

function renderDraft(text, source) {
  $('draft-text').value = text;
  show('draft');
  $('draft').classList.remove('appear'); void $('draft').offsetWidth; $('draft').classList.add('appear');
  $('draft').dataset.source = source || 'local';
  resetInsert();
  updateMeter();
}

function updateMeter() {
  const len = $('draft-text').value.length;
  const fmt = FORMATS[st.format];
  const ratio = len / fmt.limit;
  $('char-count').textContent = `${len} / ${fmt.limit}`;
  const level = ratio > 1 ? (fmt.hard ? 'over' : 'warn') : ratio > 0.9 ? 'warn' : 'ok';
  $('meter-fill').style.width = `${Math.min(100, ratio * 100)}%`;
  $('meter-fill').className = `meter-fill ${level}`;
  $('char-count').className = `char-count ${level}`;
}

function setBusy(on, which) {
  st.busy = on;
  if (which === 'read') {
    $('read-btn').disabled = on || !st.onProfile;
    $('read-btn').setAttribute('aria-busy', String(on));
    if (on) $('read-label').textContent = 'Reading profile…';
    else $('read-label').textContent = st.profile ? 'Re-read profile' : 'Read profile & draft';
    show('read-spinner', on);
  } else {
    $('regen-btn').disabled = on;
    $('insert-btn').disabled = on;
    $('regen-btn').setAttribute('aria-busy', String(on));
    show('regen-spinner', on);
  }
}

// ─── Session: survive the popup closing ───────────────────────────────────────
let persistTimer;
function persistSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 300); }

function persist() {
  if (!st.profile) return;
  call(ACTIONS.SAVE_SESSION, {
    url: st.tabUrl, profile: st.profile, hooks: st.hooks, variant: st.variant,
    message: $('draft-text').value, source: $('draft').dataset.source || 'local',
    diagnostics: st.diagnostics, templateId: st.source === WRITER ? '' : st.source
  }).catch(() => {});
}

async function restoreSession() {
  if (!st.onProfile) return;
  const { session } = await call(ACTIONS.GET_SESSION, { url: st.tabUrl }).catch(() => ({ session: null }));
  if (!session?.profile) return;
  Object.assign(st, { profile: session.profile, hooks: session.hooks || [], variant: session.variant || 0, diagnostics: session.diagnostics });
  if (session.templateId && app.state.templates.some(t => t.id === session.templateId)) st.source = session.templateId;
  renderSourceOptions();
  renderProfile(); renderHooks();
  if (session.message) renderDraft(session.message, session.source);
  // The tracker may know this person; refresh the banner quietly.
  const { items } = await call(ACTIONS.LIST_CONTACTS, { query: st.profile.name, limit: 5 }).catch(() => ({ items: [] }));
  st.contact = items.find(c => c.profileUrl && st.profile.profileUrl && c.profileUrl === st.profile.profileUrl) || null;
  renderContactBanner();
}
