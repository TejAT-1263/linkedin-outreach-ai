// popup/settings.js — Settings tab.
import { call, ACTIONS } from './api.js';
import { $, h, show, setStatus, setSegmented, wireSegmentedKeys, toast, downloadBase64 } from './dom.js';
import { LIMITS, OPENAI } from '../shared/constants.js';
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
  $('test-openai-btn').addEventListener('click', testOpenAIKey);
  $('s-openai-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); testOpenAIKey(); } });
  $('remove-openai-btn').addEventListener('click', removeOpenAIKey);
  $('openai-models').replaceChildren(...OPENAI.SUGGESTED_MODELS.map(m => h('option', { value: m })));
  $('openai-default-model').textContent = OPENAI.DEFAULT_MODEL;
  $('resume-download-btn').addEventListener('click', downloadResume);
  $('resume-remove-btn').addEventListener('click', removeResume);
  $('s-theme').addEventListener('click', (e) => {
    const b = e.target.closest('.seg'); if (!b) return;
    theme = b.dataset.theme;
    setSegmented('s-theme', 'theme', theme);
    app.applyTheme(theme); // live preview; persisted on save (and right away below)
    call(ACTIONS.SAVE_SETTINGS, { theme }).then(r => { app.state.settings = r.settings; }).catch(err => toast(`Couldn't save the theme: ${err.message}`, 'error'));
  });
  wireSegmentedKeys('s-theme');
  $('export-btn-2').addEventListener('click', exportCsv);
  $('reset-btn').addEventListener('click', reset);

  const dz = $('dropzone');
  dz.addEventListener('click', () => $('resume-input').click());
  // Like a native button: Enter activates on keydown, Space on keyup (Chrome only grants the
  // user activation a file picker needs on Space's keyup).
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('resume-input').click(); }
    if (e.key === ' ') e.preventDefault(); // don't scroll
  });
  dz.addEventListener('keyup', (e) => { if (e.key === ' ') { e.preventDefault(); $('resume-input').click(); } });
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
  $('s-openai-key').value = '';
  $('s-openai-key').placeholder = s.hasOpenAIKey ? 'Key saved — paste a new one to replace' : 'sk-proj-…';
  $('s-openai-model').value = s.openaiModel || OPENAI.DEFAULT_MODEL;
  $('openai-key-hint').textContent = s.hasOpenAIKey ? `Saved key: ${s.openaiKeyHint}` : 'No key — Deep Mode is off.';
  show('remove-openai-btn', s.hasOpenAIKey);
  const hasResume = !!s.resumeFileName;
  $('dropzone-label').textContent = hasResume ? 'Drop another PDF to replace it' : 'Click or drop a PDF';
  $('dropzone').classList.toggle('done', hasResume);
  $('resume-saved-name').textContent = hasResume ? `✓ ${s.resumeFileName}${s.resumeBytes ? ` · ${kb(s.resumeBytes)}` : ''}` : '';
  show('resume-saved', hasResume);
}

const kb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const MODEL_RE = /^[a-z0-9][a-z0-9._:-]{1,63}$/i;

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
  const okey = $('s-openai-key').value.trim();
  if (okey && (/^sk-ant-/.test(okey) || !/^sk-[\w-]{16,}$/.test(okey))) {
    setStatus('settings-status', 'That doesn’t look like an OpenAI key (they start with “sk-”, often “sk-proj-”). Use “Test & save” to check it.', 'error');
    return;
  }
  const model = $('s-openai-model').value.trim() || OPENAI.DEFAULT_MODEL;
  if (!MODEL_RE.test(model)) {
    setStatus('settings-status', 'That model name doesn’t look right — use an OpenAI model id such as gpt-6.2-sol.', 'error');
    $('s-openai-model').focus();
    return;
  }
  try {
    const { settings } = await call(ACTIONS.SAVE_SETTINGS, {
      name: $('s-name').value, bio: $('s-bio').value, background: $('s-background').value,
      followUpDays: days, notifications: $('s-notify').checked, theme, openaiModel: model,
      ...(key ? { apiKey: key } : {}),
      ...(okey ? { openaiKey: okey } : {})
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

async function testOpenAIKey() {
  const btn = $('test-openai-btn');
  const note = $('openai-status-note');
  const model = $('s-openai-model').value.trim() || OPENAI.DEFAULT_MODEL;
  if (!MODEL_RE.test(model)) { note.textContent = '✗ That model name doesn’t look right — e.g. gpt-6.2-sol.'; note.className = 'note err'; return; }
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    const res = await call(ACTIONS.TEST_OPENAI_KEY, { apiKey: $('s-openai-key').value.trim(), model });
    note.textContent = res.valid ? `✓ Key works with ${model} — Deep Mode is on.` : `✗ ${res.reason}`;
    note.className = `note ${res.valid ? 'ok' : 'err'}`;
    if (res.valid) applySettings(res.settings);
  } catch (err) {
    note.textContent = `✗ ${err.message}`; note.className = 'note err';
  } finally {
    btn.disabled = false; btn.textContent = 'Test & save';
  }
}

async function removeOpenAIKey() {
  const { settings } = await call(ACTIONS.SAVE_SETTINGS, { clearOpenAIKey: true });
  applySettings(settings);
  $('openai-status-note').className = 'note hidden';
  toast('OpenAI key removed. Deep Mode is off.');
}

async function downloadResume() {
  try {
    const { resume } = await call(ACTIONS.GET_RESUME);
    if (!resume) { toast('No resume saved.', 'error'); return; }
    downloadBase64(resume.fileName, resume.base64, 'application/pdf');
  } catch (err) {
    toast(err.message, 'error');
  }
}

let removeResumeArmed = false;
async function removeResume() {
  const btn = $('resume-remove-btn');
  if (!removeResumeArmed) {
    removeResumeArmed = true;
    btn.textContent = 'Click again to remove';
    setTimeout(() => { removeResumeArmed = false; btn.textContent = 'Remove'; }, 3500);
    return;
  }
  removeResumeArmed = false;
  btn.textContent = 'Remove';
  try {
    const { settings } = await call(ACTIONS.DELETE_RESUME);
    applySettings(settings);
    $('resume-status').className = 'note hidden';
    toast('Resume removed from this device.');
  } catch (err) {
    toast(err.message, 'error');
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
  say(app.state.settings.hasKey ? 'Saving and reading your resume…' : 'Saving your resume…', 'pending');
  try {
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('Could not read that file.'));
      r.readAsDataURL(file);
    });
    const { facts, parseError, settings } = await call(ACTIONS.PARSE_RESUME, { base64, fileName: file.name });
    applySettings(settings);
    if (facts) say(`Saved, and added ${facts.companies.length} companies, ${facts.schools.length} schools and ${facts.skills.length} skills to your background. Edit them above anytime.`, 'ok');
    else if (parseError) say(`Saved. Couldn't fill in your background from it: ${parseError}`, 'pending');
    else say('Saved on this device. Add your Anthropic key below to fill in your background from it automatically.', 'ok');
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
