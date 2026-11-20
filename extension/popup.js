'use strict';

// popup.js — one flow: Read profile → pick what to mention → draft → Insert / Copy.

const FORMAT_LIMITS = { note: 300, 'note-free': 200, dm: 600 };
const MAX_HOOKS = 2;

const state = {
  tabId: null,
  tabUrl: '',
  profile: null,
  hooks: [],
  format: 'note',
  variant: 0,
  hasKey: false,
  busy: false,
  confirmReplace: false
};

const $ = (id) => document.getElementById(id);

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  wireTabs();
  wireWrite();
  wireSettings();
  wireRecent();
  await loadSettings();
  await loadPrefs();
  await detectTab();
  await restoreSession();
  await renderRecent();
});

async function detectTab() {
  // ?tabId= lets the test harness open the popup as a normal page.
  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  const tab = forced
    ? await chrome.tabs.get(forced)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  state.tabId = tab?.id || null;
  state.tabUrl = (tab?.url || '').split('?')[0];
  const onProfile = /^https:\/\/www\.linkedin\.com\/in\/[^/?#]+/.test(state.tabUrl);
  $('read-btn').disabled = !onProfile;
  $('page-warning').classList.toggle('hidden', onProfile);
  return onProfile;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function wireTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  $('go-settings').addEventListener('click', () => switchTab('settings'));
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
  if (name === 'recent') renderRecent();
}

// ─── Write tab ────────────────────────────────────────────────────────────────
function wireWrite() {
  $('read-btn').addEventListener('click', handleRead);
  $('regenerate-btn').addEventListener('click', () => generate({ regenerate: true }));
  $('copy-btn').addEventListener('click', handleCopy);
  $('insert-btn').addEventListener('click', handleInsert);
  $('generated-message').addEventListener('input', () => { updateMeter(); state.confirmReplace = false; resetInsertLabel(); saveSession(); });

  $('format').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    setFormat(btn.dataset.format);
    savePrefs();
    onOptionsChanged();
  });
  ['message-type', 'tone'].forEach(id => $(id).addEventListener('change', () => { savePrefs(); onOptionsChanged(); }));

  $('custom-hook-add').addEventListener('click', addCustomHook);
  $('custom-hook-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustomHook(); });
}

function setFormat(format) {
  state.format = FORMAT_LIMITS[format] ? format : 'note';
  document.querySelectorAll('#format .seg-btn').forEach(b => {
    const on = b.dataset.format === state.format;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  updateMeter();
}

// When purpose/tone/format/hooks change: the free writer is instant, so redraft.
// With an API key we don't spend a call silently — we ask the user to click.
function onOptionsChanged() {
  if (!state.profile) return;
  if (!state.hasKey) generate({ regenerate: false });
  else showStatus('Options changed — click “↻ New version” to redraft.', 'info');
}

async function handleRead() {
  if (state.busy) return;
  setBusy(true, 'read', 'Reading profile…');
  clearStatus();
  try {
    const { profile, hooks } = await send('scrapeProfile', { tabId: state.tabId });
    state.profile = profile;
    state.hooks = hooks;
    state.variant = 0;
    renderProfile(profile);
    renderHooks();
    setBusy(false, 'read');
    await generate({ regenerate: false });
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    setBusy(false, 'read');
  }
}

async function generate({ regenerate }) {
  if (!state.profile || state.busy) return;
  if (regenerate) state.variant += 1;
  const previousMessage = regenerate ? $('generated-message').value : '';
  setBusy(true, 'regen', state.hasKey ? 'Writing…' : '');
  try {
    const { message, source } = await send('generateMessage', {
      profile: state.profile,
      hooks: state.hooks.filter(h => h.selected),
      messageType: $('message-type').value,
      tone: $('tone').value,
      format: state.format,
      variant: state.variant,
      previousMessage
    });
    renderMessage(message, source);
    clearStatus();
    await send('saveRecent', { contact: {
      profileUrl: state.profile.profileUrl || state.tabUrl,
      name: state.profile.name,
      headline: state.profile.headline || state.profile.currentCompany || '',
      message,
      format: state.format,
      purpose: $('message-type').value,
      status: 'drafted',
      timestamp: Date.now()
    }});
    saveSession();
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    setBusy(false, 'regen');
  }
}

// ─── Hooks ────────────────────────────────────────────────────────────────────
function renderHooks() {
  const list = $('hooks-list');
  list.innerHTML = '';
  state.hooks.forEach(h => {
    const chip = document.createElement('button');
    chip.className = `hook-chip${h.selected ? ' selected' : ''}${/^shared/.test(h.kind) ? ' common' : ''}`;
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(!!h.selected));
    chip.title = /^shared/.test(h.kind) ? 'Something you have in common — the strongest kind of opener' : '';
    chip.textContent = (/^shared/.test(h.kind) ? '★ ' : '') + h.label;
    chip.addEventListener('click', () => toggleHook(h.id));
    list.appendChild(chip);
  });
  $('hooks-panel').classList.toggle('hidden', !state.hooks.length && !state.profile);
}

function toggleHook(id) {
  const hook = state.hooks.find(h => h.id === id);
  if (!hook) return;
  if (hook.selected) {
    hook.selected = false;
  } else {
    const selected = state.hooks.filter(h => h.selected);
    if (selected.length >= MAX_HOOKS) {
      // Drop the one picked longest ago so the newest choice always sticks.
      selected.sort((a, b) => (a.pickedAt || 0) - (b.pickedAt || 0))[0].selected = false;
    }
    hook.selected = true;
    hook.pickedAt = Date.now();
  }
  renderHooks();
  onOptionsChanged();
}

function addCustomHook() {
  const input = $('custom-hook-input');
  const text = input.value.trim();
  if (!text || !state.profile) return;
  state.hooks.forEach(h => { if (h.selected) h.pickedAt = h.pickedAt || 0; });
  state.hooks.unshift({ id: `custom-${Date.now()}`, kind: 'custom', label: text, value: text, score: 11, selected: false });
  input.value = '';
  toggleHook(state.hooks[0].id);
}

// ─── Insert / Copy ────────────────────────────────────────────────────────────
async function handleInsert() {
  const text = $('generated-message').value.trim();
  if (!text) return;
  const limit = FORMAT_LIMITS[state.format];
  if (state.format !== 'dm' && text.length > limit) {
    showStatus(`This is ${text.length} characters — connection notes allow ${limit}. Trim it or click “↻ New version”.`, 'error');
    return;
  }
  try {
    const res = await send('insertMessage', { tabId: state.tabId, text, replace: state.confirmReplace });
    if (res.ok) {
      state.confirmReplace = false;
      resetInsertLabel();
      const where = res.kind === 'connection-note' ? 'connection note' : 'message box';
      showStatus(`Inserted into the LinkedIn ${where}. Give it a read, then hit Send.`, 'success');
      await markRecent('inserted');
    } else if (res.reason === 'notEmpty') {
      state.confirmReplace = true;
      $('insert-btn').textContent = 'Replace LinkedIn text';
      showStatus('That LinkedIn box already has text in it. Click again to replace it.', 'warning');
    } else if (res.reason === 'tooLong') {
      const hint = res.maxLength <= 200 && state.format === 'note' ? ' Try the “Free-plan note” format.' : '';
      showStatus(`LinkedIn allows ${res.maxLength} characters here and this draft is ${text.length}.${hint}`, 'error');
    } else {
      await copyText(text);
      await markRecent('copied');
      showStatus('No open LinkedIn message box found, so it’s copied instead. On the profile click “Message” (or “Connect → Add a note”), then click Insert again or paste.', 'warning');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  }
}

function resetInsertLabel() { $('insert-btn').textContent = 'Insert into LinkedIn'; }

async function handleCopy() {
  const text = $('generated-message').value;
  if (!text) return;
  await copyText(text);
  await markRecent('copied');
  const btn = $('copy-btn');
  btn.textContent = '✓ Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (_) { const ta = $('generated-message'); ta.select(); document.execCommand('copy'); }
}

async function markRecent(status) {
  if (!state.profile) return;
  const url = state.profile.profileUrl || state.tabUrl;
  const recent = await send('getRecent');
  const existing = recent.find(c => c.profileUrl === url);
  // Don't downgrade "inserted" to "copied".
  if (existing && existing.status === 'inserted' && status === 'copied') return;
  await send('updateRecent', { profileUrl: url, patch: { status, message: $('generated-message').value } });
}

// ─── Session: survive the popup closing ───────────────────────────────────────
// Chrome closes the popup the moment you click into LinkedIn (e.g. to open
// "Add a note"). We keep the draft per profile so reopening picks up where you were.
function saveSession() {
  if (!state.profile) return;
  chrome.storage.local.set({ session: {
    url: state.tabUrl,
    profile: state.profile,
    hooks: state.hooks,
    variant: state.variant,
    message: $('generated-message').value,
    source: $('source-badge').dataset.source || 'local',
    savedAt: Date.now()
  }});
}

async function restoreSession() {
  const { session } = await chrome.storage.local.get(['session']);
  if (!session || session.url !== state.tabUrl) return;
  if (Date.now() - session.savedAt > 6 * 60 * 60 * 1000) return; // stale after 6h
  state.profile = session.profile;
  state.hooks = session.hooks || [];
  state.variant = session.variant || 0;
  renderProfile(state.profile);
  renderHooks();
  if (session.message) renderMessage(session.message, session.source);
  $('read-label').textContent = 'Re-read profile';
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderProfile(p) {
  $('profile-section').classList.remove('hidden');
  const name = p.name || 'Unknown';
  $('profile-avatar').textContent = name.charAt(0).toUpperCase();
  $('profile-name').textContent = name;
  $('profile-headline').textContent = p.headline || [p.currentTitle, p.currentCompany].filter(Boolean).join(' at ');
}

function renderMessage(text, source) {
  $('generated-message').value = text;
  $('message-section').classList.remove('hidden');
  const badge = $('source-badge');
  badge.dataset.source = source;
  badge.textContent = source === 'ai' ? 'AI' : 'Built-in writer';
  state.confirmReplace = false;
  resetInsertLabel();
  updateMeter();
}

function updateMeter() {
  const len = $('generated-message').value.length;
  const limit = FORMAT_LIMITS[state.format];
  const ratio = len / limit;
  $('char-count').textContent = `${len} / ${limit}`;
  const fill = $('meter-fill');
  fill.style.width = `${Math.min(100, ratio * 100)}%`;
  const level = ratio > 1 ? 'over' : ratio > 0.9 ? 'warn' : 'ok';
  fill.className = `meter-fill ${level}`;
  $('char-count').className = `char-count ${level}`;
}

function setBusy(on, which, label) {
  state.busy = on;
  if (which === 'read') {
    $('read-btn').disabled = on;
    if (label) $('read-label').textContent = label;
    if (!on) $('read-label').textContent = state.profile ? 'Re-read profile' : 'Read profile & draft';
    $('read-spinner').classList.toggle('hidden', !on);
  } else {
    $('regenerate-btn').disabled = on;
    $('regen-spinner').classList.toggle('hidden', !on);
  }
}

function showStatus(msg, type = 'info') {
  const el = $('status-message');
  el.textContent = msg;
  el.className = `status-bar status-${type}`;
}
function clearStatus() { $('status-message').className = 'status-bar hidden'; }

// ─── Prefs (remember purpose / tone / format) ─────────────────────────────────
async function loadPrefs() {
  const { prefs } = await chrome.storage.local.get(['prefs']);
  if (prefs?.messageType) $('message-type').value = prefs.messageType;
  if (prefs?.tone) $('tone').value = prefs.tone;
  setFormat(prefs?.format || 'note');
}
function savePrefs() {
  chrome.storage.local.set({ prefs: { messageType: $('message-type').value, tone: $('tone').value, format: state.format } });
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function wireSettings() {
  $('save-settings-btn').addEventListener('click', handleSaveSettings);
  $('validate-btn').addEventListener('click', handleValidateKey);
  $('api-key').addEventListener('keydown', e => { if (e.key === 'Enter') handleValidateKey(); });

  const drop = $('file-upload-area');
  drop.addEventListener('click', () => $('resume-upload').click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') $('resume-upload').click(); });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) processResume(e.dataTransfer.files[0]);
  });
  $('resume-upload').addEventListener('change', e => { if (e.target.files[0]) processResume(e.target.files[0]); });
}

async function loadSettings() {
  const s = await chrome.storage.local.get(['userApiKey', 'userName', 'userBio', 'userBackground', 'resumeFileName']);
  $('api-key').value = s.userApiKey || '';
  $('user-name').value = s.userName || '';
  $('user-bio').value = s.userBio || '';
  $('user-background').value = s.userBackground || '';
  if (s.resumeFileName) {
    $('file-label').textContent = s.resumeFileName;
    $('file-upload-area').classList.add('has-file');
  }
  state.hasKey = !!(s.userApiKey || '').trim();
  renderKeyStatus();
  $('setup-tip').classList.toggle('hidden', !!(s.userName || s.userBackground));
}

function renderKeyStatus() {
  const el = $('key-status');
  el.textContent = state.hasKey ? '● AI · your key' : '● Built-in writer';
  el.title = state.hasKey ? 'Drafts are written by Claude using your API key' : 'Drafts are written locally — no API key, nothing leaves your device';
  el.className = `key-status ${state.hasKey ? 'ai' : 'local'}`;
}

async function handleSaveSettings() {
  const payload = {
    userApiKey: $('api-key').value.trim(),
    userName: $('user-name').value.trim(),
    userBio: $('user-bio').value.trim(),
    userBackground: $('user-background').value.trim()
  };
  await chrome.storage.local.set(payload);
  state.hasKey = !!payload.userApiKey;
  renderKeyStatus();
  $('setup-tip').classList.toggle('hidden', !!(payload.userName || payload.userBackground));
  showSettingsStatus('Saved.', 'success');
}

async function handleValidateKey() {
  const apiKey = $('api-key').value.trim();
  if (!apiKey) return;
  const btn = $('validate-btn');
  btn.textContent = '…';
  btn.disabled = true;
  const res = await send('testApiKey', { apiKey }).catch(err => ({ valid: false, reason: err.message }));
  btn.textContent = 'Test';
  btn.disabled = false;
  const el = $('key-validation-status');
  el.classList.remove('hidden');
  if (res.valid) {
    el.textContent = '✓ Key works — AI drafts are on';
    el.className = 'key-validation-status valid';
    await chrome.storage.local.set({ userApiKey: apiKey });
    state.hasKey = true;
    renderKeyStatus();
  } else {
    el.textContent = `✗ ${res.reason || 'Key did not work'}`;
    el.className = 'key-validation-status invalid';
  }
}

// Resume: read once with the user's key, merge the facts into "Your background"
// (which the user can see and edit), and don't keep the PDF itself.
async function processResume(file) {
  const status = $('resume-status');
  const show = (msg, cls) => { status.textContent = msg; status.className = `resume-status ${cls}`; };
  if (file.type !== 'application/pdf') return show('Please upload a PDF.', 'error');
  if (file.size > 4 * 1024 * 1024) return show('That file is over 4 MB.', 'error');

  const key = $('api-key').value.trim();
  if (key) await chrome.storage.local.set({ userApiKey: key });

  show('Reading your resume…', 'pending');
  try {
    const base64 = await fileToBase64(file);
    const facts = await send('parseResume', { base64 });
    const existing = splitList($('user-background').value);
    const merged = [...new Set([...existing, ...facts.companies, ...facts.schools, ...facts.skills, facts.location].filter(Boolean))];
    $('user-background').value = merged.join(', ');
    if (!$('user-bio').value.trim() && facts.summary) $('user-bio').value = facts.summary;
    await chrome.storage.local.set({
      userBackground: $('user-background').value,
      userBio: $('user-bio').value.trim(),
      resumeFileName: file.name
    });
    $('file-label').textContent = file.name;
    $('file-upload-area').classList.add('has-file');
    renderChips([...facts.companies, ...facts.schools].slice(0, 8));
    show(`Added ${facts.companies.length} companies, ${facts.schools.length} schools and ${facts.skills.length} skills to your background. Edit them above anytime.`, 'success');
    $('setup-tip').classList.add('hidden');
  } catch (err) {
    show(err.message, 'error');
  }
}

function renderChips(items) {
  const box = $('resume-chips');
  box.innerHTML = '';
  items.forEach(t => { const c = document.createElement('span'); c.className = 'chip'; c.textContent = t; box.appendChild(c); });
  box.classList.toggle('hidden', !items.length);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.readAsDataURL(file);
  });
}

function showSettingsStatus(msg, type) {
  const el = $('settings-status');
  el.textContent = msg;
  el.className = `status-bar status-${type}`;
  setTimeout(() => el.classList.add('hidden'), 2200);
}

// ─── Recent ───────────────────────────────────────────────────────────────────
function wireRecent() {
  $('clear-recent-btn').addEventListener('click', async () => { await send('clearRecent'); renderRecent(); });
  $('recent-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.contact-card');
    const contacts = await send('getRecent');
    const c = contacts[Number(card.dataset.idx)];
    if (!c) return;
    if (btn.dataset.act === 'expand') {
      const full = card.classList.toggle('expanded');
      btn.textContent = full ? 'Show less' : 'Show full message';
    } else if (btn.dataset.act === 'copy') {
      await copyText(c.message || '');
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    } else if (btn.dataset.act === 'open' && c.profileUrl) {
      chrome.tabs.create({ url: c.profileUrl });
    }
  });
}

async function renderRecent() {
  const contacts = await send('getRecent').catch(() => []);
  const list = $('recent-list');
  list.innerHTML = '';
  $('no-recent').classList.toggle('hidden', contacts.length > 0);
  $('recent-actions').classList.toggle('hidden', contacts.length === 0);
  $('recent-subtitle').textContent = `${contacts.length} ${contacts.length === 1 ? 'person' : 'people'}`;
  contacts.forEach((c, i) => list.appendChild(contactCard(c, i)));
}

const STATUS_LABEL = { drafted: 'Drafted', copied: 'Copied', inserted: 'Inserted' };

function contactCard(c, idx) {
  const card = document.createElement('div');
  card.className = 'contact-card';
  card.dataset.idx = idx;
  const date = new Date(c.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const status = c.status || 'drafted';
  card.innerHTML = `
    <div class="contact-header">
      <div class="contact-info">
        <div class="contact-name">${esc(c.name || 'Unknown')}</div>
        <div class="contact-meta">${esc(c.headline || '')}</div>
      </div>
      <div class="contact-side">
        <span class="pill pill-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>
        <span class="contact-date">${esc(date)}</span>
      </div>
    </div>
    <div class="contact-message">${esc(c.message || '')}</div>
    <div class="contact-actions">
      <button class="btn-link" data-act="expand">Show full message</button>
      <span class="contact-buttons">
        ${c.profileUrl ? '<button class="btn btn-sm btn-secondary" data-act="open">Open profile</button>' : ''}
        <button class="btn btn-sm btn-primary" data-act="copy">Copy</button>
      </span>
    </div>`;
  return card;
}

// ─── Messaging ────────────────────────────────────────────────────────────────
function send(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error('No response from the extension. Try reopening it.'));
      if (!response.success) return reject(new Error(response.error || 'Something went wrong.'));
      resolve(response.data);
    });
  });
}

function splitList(s) { return String(s || '').split(/[,\n;]+/).map(x => x.trim()).filter(Boolean); }
function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
