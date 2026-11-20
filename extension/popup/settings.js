// popup/settings.js — Settings tab.
import { call, ACTIONS } from './api.js';
import { $, h, show, setStatus, setSegmented, wireSegmentedKeys, toast } from './dom.js';
import { LIMITS } from '../shared/constants.js';
import { exportCsv } from './tracker.js';

let app;
let theme = 'system';

export function init(appCtx) {
  app = appCtx;
  fill(app.state.settings);
  renderTemplates();
  $('version').textContent = `LinkedIn Outreach AI v${app.state.version}`;

  $('settings-form').addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('test-key-btn').addEventListener('click', testKey);
  $('s-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); testKey(); } });
  $('remove-key-btn').addEventListener('click', removeKey);
  $('s-theme').addEventListener('click', (e) => {
    const b = e.target.closest('.seg'); if (!b) return;
    theme = b.dataset.theme;
    setSegmented('s-theme', 'theme', theme);
    app.applyTheme(theme); // live preview; persisted on save (and right away below)
    call(ACTIONS.SAVE_SETTINGS, { theme }).then(r => { app.state.settings = r.settings; }).catch(() => {});
  });
  wireSegmentedKeys('s-theme');
  $('export-btn-2').addEventListener('click', exportCsv);
  $('reset-btn').addEventListener('click', reset);

  const dz = $('dropzone');
  dz.addEventListener('click', () => $('resume-input').click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('resume-input').click(); } });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) resume(e.dataTransfer.files[0]); });
  $('resume-input').addEventListener('change', (e) => { if (e.target.files[0]) resume(e.target.files[0]); e.target.value = ''; });
}

function fill(s) {
  $('s-name').value = s.name || '';
  $('s-bio').value = s.bio || '';
  $('s-background').value = s.background || '';
  $('s-days').value = s.followUpDays;
  $('s-notify').checked = !!s.notifications;
  $('s-key').value = '';
  $('s-key').placeholder = s.hasKey ? 'Key saved — paste a new one to replace' : 'sk-ant-…';
  $('key-hint').textContent = s.hasKey ? `Saved key: ${s.keyHint}` : 'No key — using the built-in writer.';
  show('remove-key-btn', s.hasKey);
  theme = s.theme || 'system';
  setSegmented('s-theme', 'theme', theme);
  if (s.resumeFileName) { $('dropzone-label').textContent = `✓ ${s.resumeFileName} — drop another to update`; $('dropzone').classList.add('done'); }
}

async function save() {
  const days = Number($('s-days').value);
  if (!Number.isInteger(days) || days < LIMITS.MIN_FOLLOWUP_DAYS || days > LIMITS.MAX_FOLLOWUP_DAYS) {
    setStatus('settings-status', `Follow-up days must be between ${LIMITS.MIN_FOLLOWUP_DAYS} and ${LIMITS.MAX_FOLLOWUP_DAYS}.`, 'error');
    $('s-days').focus();
    return;
  }
  const key = $('s-key').value.trim();
  if (key && !/^sk-ant-/.test(key)) {
    setStatus('settings-status', 'That doesn’t look like an Anthropic key (they start with “sk-ant-”). Use “Test & save” to check it.', 'error');
    return;
  }
  try {
    const { settings } = await call(ACTIONS.SAVE_SETTINGS, {
      name: $('s-name').value, bio: $('s-bio').value, background: $('s-background').value,
      followUpDays: days, notifications: $('s-notify').checked, theme,
      ...(key ? { apiKey: key } : {})
    });
    applySettings(settings);
    setStatus('settings-status', 'Saved.', 'success');
    setTimeout(() => setStatus('settings-status', ''), 2000);
  } catch (err) {
    setStatus('settings-status', err.message, 'error');
  }
}

function applySettings(settings) {
  app.state.settings = settings;
  fill(settings);
  app.onSettingsChanged();
}

async function testKey() {
  const btn = $('test-key-btn');
  const note = $('key-status-note');
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    const res = await call(ACTIONS.TEST_KEY, { apiKey: $('s-key').value.trim() });
    note.textContent = res.valid ? '✓ Key works — AI drafts are on.' : `✗ ${res.reason}`;
    note.className = `note ${res.valid ? 'ok' : 'err'}`;
    if (res.valid) { const { settings } = await call(ACTIONS.GET_STATE); applySettings(settings); }
  } catch (err) {
    note.textContent = `✗ ${err.message}`; note.className = 'note err';
  } finally {
    btn.disabled = false; btn.textContent = 'Test & save';
  }
}

async function removeKey() {
  const { settings } = await call(ACTIONS.SAVE_SETTINGS, { clearKey: true });
  applySettings(settings);
  $('key-status-note').className = 'note hidden';
  toast('Key removed. Using the built-in writer.');
}

async function resume(file) {
  const status = $('resume-status');
  const say = (msg, cls) => { status.textContent = msg; status.className = `note ${cls}`; };
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return say('Please choose a PDF.', 'err');
  if (file.size > LIMITS.MAX_RESUME_BYTES) return say('That file is over 4 MB.', 'err');
  if (!app.state.settings.hasKey) return say('Add and test your API key below first — or just type your background above.', 'err');
  say('Reading your resume…', 'pending');
  try {
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('Could not read that file.'));
      r.readAsDataURL(file);
    });
    const { facts, settings } = await call(ACTIONS.PARSE_RESUME, { base64, fileName: file.name });
    applySettings(settings);
    say(`Added ${facts.companies.length} companies, ${facts.schools.length} schools and ${facts.skills.length} skills to your background. Edit them above anytime. (The PDF itself isn't stored.)`, 'ok');
  } catch (err) {
    say(err.message, 'err');
  }
}

export function renderTemplates() {
  const list = $('tpl-list');
  const tpls = app.state.templates;
  show('tpl-empty', !tpls.length);
  list.replaceChildren(...tpls.map(t => h('div', { class: 'tpl' },
    h('div', { class: 'tpl-head' },
      h('strong', {}, t.name),
      h('span', { class: 'muted small' }, [t.purpose, `used ${t.uses || 0}×`].filter(Boolean).join(' · ')),
      h('button', { class: 'icon-btn danger', type: 'button', title: 'Delete template', 'aria-label': `Delete template ${t.name}`, onclick: () => delTemplate(t) }, '×')),
    h('pre', { class: 'tpl-text' }, t.text))));
}

async function delTemplate(t) {
  const { templates } = await call(ACTIONS.DELETE_TEMPLATE, { id: t.id });
  app.state.templates = templates;
  renderTemplates();
  app.onSettingsChanged();
  toast(`Deleted “${t.name}”.`);
}

let resetArmed = false;
async function reset() {
  if (!resetArmed) {
    resetArmed = true;
    $('reset-btn').textContent = 'Click again to erase all data';
    setTimeout(() => { resetArmed = false; $('reset-btn').textContent = 'Reset everything'; }, 3500);
    return;
  }
  await call(ACTIONS.RESET_ALL);
  location.reload();
}
