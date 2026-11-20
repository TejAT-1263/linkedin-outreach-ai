// Edge-case e2e scenarios: AI mode via a fake API, failures, settings flows, paging, keyboard, a11y, corrupt data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launch, steps, mockHtml, ROOT } from './harness.mjs';

const BROKEN = mockHtml('broken.html');
const SHORT_NOTE = mockHtml('profile.html').replace('maxlength="300"', 'maxlength="200"').replace('Priya Sharma', 'Dev Rao').replace('Priya Sharma', 'Dev Rao');
const env = await launch({ pages: { '/in/alex-kim': BROKEN, '/in/dev-rao': SHORT_NOTE } });
const { api, storage, errors } = env;
const { step, report } = steps();
const AXE = readFileSync(path.join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8');

const priya = await env.tab('https://www.linkedin.com/in/priya-sharma/');
let pop = await env.popup(priya.id);
const status = () => pop.textContent('#status');
const draft = () => pop.inputValue('#draft-text');

async function a11y(page, label) {
  await page.evaluate(AXE);
  const res = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'], runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] }));
  const serious = res.violations.filter(v => ['serious', 'critical'].includes(v.impact));
  assert.deepEqual(serious.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(' | ')}`), [], `${label} accessibility`);
}

await step('accessibility (axe, WCAG 2 AA): Write, Tracker, Settings — light', async () => {
  await a11y(pop, 'write');
  await pop.click('#tabbtn-tracker'); await pop.waitForTimeout(200); await a11y(pop, 'tracker');
  await pop.click('#tabbtn-settings'); await pop.waitForTimeout(200); await a11y(pop, 'settings');
});

await step('API key: wrong format, rejected (401), accepted → AI badge + masked hint', async () => {
  await pop.click('#tabbtn-settings');
  await pop.fill('#s-key', 'abc123');
  await pop.click('#test-key-btn');
  await pop.waitForSelector('#key-status-note.err');
  assert.match(await pop.textContent('#key-status-note'), /start with "sk-ant-"/);
  api.queue.push({ status: 401 });
  await pop.fill('#s-key', 'sk-ant-bad');
  await pop.click('#test-key-btn');
  await pop.waitForFunction(() => /rejected/.test(document.querySelector('#key-status-note').textContent));
  api.queue.push({ status: 200, text: 'OK' });
  await pop.fill('#s-key', 'sk-ant-good-key-9876');
  await pop.click('#test-key-btn');
  await pop.waitForSelector('#key-status-note.ok');
  assert.match(await pop.textContent('#key-status'), /AI · your key/);
  assert.equal(await pop.textContent('#key-hint'), 'Saved key: sk-ant-…9876');
  assert.equal(await pop.inputValue('#s-key'), '', 'key field cleared, never shown again');
  const stored = await storage.get('settings');
  assert.equal(stored.settings.apiKey, 'sk-ant-good-key-9876');
});

await step('save settings: invalid key format blocked; name/background saved', async () => {
  await pop.click('#tabbtn-settings');
  await pop.fill('#s-name', 'Arjun Mehta');
  await pop.fill('#s-background', 'Flipkart, IIT Delhi');
  await pop.fill('#s-key', 'not-a-key');
  await pop.click('#save-settings-btn');
  await pop.waitForSelector('#settings-status.status-error');
  await pop.fill('#s-key', '');
  await pop.click('#save-settings-btn');
  await pop.waitForSelector('#settings-status.status-success');
  assert.equal((await storage.get('settings')).settings.apiKey, 'sk-ant-good-key-9876', 'blank key field keeps the saved key');
});

await step('resume: non-PDF rejected; PDF read via AI fills background + chips; PDF not stored', async () => {
  await pop.click('#tabbtn-settings');
  await pop.setInputFiles('#resume-input', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await pop.waitForSelector('#resume-status.err');
  api.queue.push({ status: 200, text: '{"summary":"I build AI tools","companies":["Swiggy"],"schools":["IIT Delhi"],"skills":["React"],"location":"Pune, India"}' });
  await pop.setInputFiles('#resume-input', { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF') });
  await pop.waitForSelector('#resume-status.ok');
  assert.equal(await pop.inputValue('#s-background'), 'Flipkart, IIT Delhi, Swiggy, React, Pune');
  assert.match(await pop.textContent('#dropzone-label'), /cv\.pdf/);
  const last = api.requests.at(-1);
  assert.equal(last.messages[0].content[0].type, 'document');
  const all = JSON.stringify(await storage.get(null));
  assert.ok(!all.includes('JVBERi0'), 'no PDF bytes in storage');
});

await step('AI draft: request carries hooks + limit; options change does NOT spend a call', async () => {
  await pop.click('#tabbtn-write');
  api.queue.push({ status: 200, text: 'Hi Priya — fellow Flipkart alum here. Would love to connect.' });
  const before = api.requests.length;
  await pop.click('#read-btn');
  await pop.waitForSelector('#draft:not(.hidden)');
  assert.equal(await draft(), 'Hi Priya — fellow Flipkart alum here. Would love to connect.');
  assert.match(await pop.textContent('#source-select option'), /AI writer/);
  const req = api.requests.at(-1);
  assert.match(req.messages[0].content, /Hard limit: 300/);
  assert.match(req.messages[0].content, /Flipkart \(common ground\)/);
  assert.equal(api.requests.length, before + 1);
  await pop.selectOption('#tone', 'Casual');
  await pop.waitForTimeout(250);
  assert.equal(api.requests.length, before + 1, 'no silent API call');
  assert.match(await status(), /click “↻ New version”/);
});

await step('AI rate-limited (429) then OK → retried transparently', async () => {
  api.queue.push({ status: 429, headers: { 'retry-after': '1' } }, { status: 200, text: 'Second try worked.' });
  await pop.click('#regen-btn');
  await pop.waitForFunction(() => document.querySelector('#draft-text').value === 'Second try worked.', null, { timeout: 15000 });
  assert.match(api.requests.at(-1).messages[0].content, /previous draft/);
});

await step('AI outage (5xx ×3) → clear error, previous draft kept, buttons re-enabled', async () => {
  const keep = await draft();
  api.queue.push({ status: 500 }, { status: 500 }, { status: 500 });
  await pop.click('#regen-btn');
  await pop.waitForSelector('#status.status-error', { timeout: 20000 });
  assert.match(await status(), /busy/);
  assert.equal(await draft(), keep);
  assert.equal(await pop.isDisabled('#regen-btn'), false);
  assert.equal(await pop.isDisabled('#insert-btn'), false);
});

await step('AI over-limit output → shortened to fit', async () => {
  api.queue.push({ status: 200, text: 'word '.repeat(150) }, { status: 200, text: 'Hi Priya, short and sweet. Connect?' });
  await pop.click('#regen-btn');
  await pop.waitForFunction(() => document.querySelector('#draft-text').value.startsWith('Hi Priya, short'), null, { timeout: 15000 });
  assert.match(api.requests.at(-1).messages[0].content, /Shorten this to under 300/);
});

await step('remove key → back to built-in writer, drafts work offline', async () => {
  await pop.click('#tabbtn-settings');
  await pop.click('#remove-key-btn');
  await pop.waitForFunction(() => /Built-in writer/.test(document.querySelector('#key-status').textContent));
  await pop.click('#tabbtn-write');
  const n = api.requests.length;
  await pop.click('#regen-btn'); await pop.waitForTimeout(300);
  assert.equal(api.requests.length, n, 'no network without a key');
  assert.match(await draft(), /^Hey Priya!/);
});

await step('typed draft over the hard limit is blocked before touching LinkedIn', async () => {
  await pop.click('#tabbtn-write');
  await pop.click('.seg[data-format="note"]'); await pop.waitForTimeout(200);
  await pop.fill('#draft-text', 'x'.repeat(320));
  assert.match(await pop.textContent('#char-count'), /320 \/ 300/);
  assert.match(await pop.getAttribute('#char-count', 'class'), /over/);
  await pop.click('#insert-btn'); await pop.waitForTimeout(200);
  assert.match(await status(), /connection note allows 300/);
  assert.equal(await priya.page.inputValue('#custom-message'), '');
});

await step('LinkedIn note box shorter than our format (200) → tells you + suggests Free-plan note', async () => {
  const dev = await env.tab('https://www.linkedin.com/in/dev-rao/');
  const p = await env.popup(dev.id);
  await p.click('.seg[data-format="note"]');
  await p.click('#read-btn'); await p.waitForSelector('#draft:not(.hidden)');
  await p.fill('#draft-text', 'y'.repeat(250));
  await p.click('#insert-btn'); await p.waitForTimeout(250);
  assert.match(await p.textContent('#status'), /allows 200 characters.*Free-plan note/);
  await p.click('.seg[data-format="note-free"]'); await p.waitForTimeout(250);
  await p.click('#insert-btn'); await p.waitForTimeout(250);
  assert.match(await p.textContent('#status'), /Inserted/);
  await p.close(); await dev.page.close();
});

await step('keyboard: arrow keys move between tabs and formats', async () => {
  await pop.click('#tabbtn-write');
  await pop.focus('#tabbtn-write');
  await pop.keyboard.press('ArrowRight');
  assert.equal(await pop.getAttribute('#tabbtn-tracker', 'aria-selected'), 'true');
  await pop.keyboard.press('ArrowLeft');
  assert.equal(await pop.getAttribute('#tabbtn-write', 'aria-selected'), 'true');
  await pop.focus('.seg[data-format="note"]');
  await pop.keyboard.press('ArrowRight');
  assert.equal(await pop.getAttribute('.seg[data-format="note-free"]', 'aria-checked'), 'true');
  await pop.keyboard.press('ArrowLeft');
});

await step('tracker paging + search across 60 contacts', async () => {
  const contacts = {};
  for (let i = 0; i < 60; i++) contacts[`in:bulk${i}`] = { name: `Bulk Person ${i}`, company: i % 3 ? 'Acme' : 'Globex', status: 'drafted', updatedAt: 1000 + i, message: `msg ${i}` };
  const cur = (await storage.get('contacts')).contacts;
  await storage.set({ contacts: { ...cur, ...contacts } });
  await pop.click('#tabbtn-tracker');
  await pop.waitForSelector('.contact');
  assert.equal(await pop.$$eval('.contact', e => e.length), 30);
  assert.match(await pop.textContent('#more-btn'), /Show more \(3\d\)/);
  await pop.click('#more-btn'); await pop.waitForTimeout(300);
  assert.equal(await pop.$$eval('.contact', e => e.length), 60);
  await pop.click('#more-btn'); await pop.waitForTimeout(300);
  assert.equal(await pop.isVisible('#more-btn'), false);
  await pop.fill('#tracker-search', 'globex'); await pop.waitForTimeout(400);
  assert.equal(await pop.$$eval('.contact', e => e.length), 20);
  await pop.fill('#tracker-search', ''); await pop.waitForTimeout(400);
  await pop.click('.seg[data-filter="drafts"]'); await pop.waitForTimeout(300);
  assert.ok(await pop.$$eval('.contact', e => e.length) >= 30);
  await pop.click('.seg[data-filter="all"]'); await pop.waitForTimeout(200);
});

await step('remove a contact needs two clicks', async () => {
  const before = (await storage.msg(pop, 'listContacts', {})).data.total;
  await pop.click('.contact .icon-btn.danger'); await pop.waitForTimeout(200);
  assert.equal((await storage.msg(pop, 'listContacts', {})).data.total, before);
  await pop.click('.contact .icon-btn.danger'); await pop.waitForTimeout(300);
  assert.equal((await storage.msg(pop, 'listContacts', {})).data.total, before - 1);
});

await step('templates: delete in Settings removes it from the draft menu', async () => {
  await storage.msg(pop, 'saveTemplate', { name: 'Temp', text: 'Hello {firstName}, quick one.' });
  await pop.close();
  pop = await env.popup(priya.id);
  assert.ok((await pop.$$eval('#source-select option', o => o.map(x => x.textContent))).includes('☆ Temp'));
  await pop.click('#tabbtn-settings');
  await pop.click('.tpl .icon-btn.danger'); await pop.waitForTimeout(250);
  assert.ok(!(await pop.$$eval('#source-select option', o => o.map(x => x.textContent))).includes('☆ Temp'));
  assert.ok(await pop.isVisible('#tpl-empty'));
});

await step('clear tracker: first click arms, second clears', async () => {
  await pop.click('#tabbtn-tracker'); await pop.waitForSelector('.contact');
  await pop.click('#clear-btn');
  assert.match(await pop.textContent('#clear-btn'), /Click again/);
  await pop.click('#clear-btn'); await pop.waitForTimeout(300);
  assert.ok(await pop.isVisible('#tracker-empty'));
  assert.equal(await pop.textContent('#stat-reached'), '0');
});

await step('export with an empty tracker → friendly message, no file', async () => {
  await pop.click('#export-btn'); await pop.waitForTimeout(200);
  assert.match(await pop.textContent('#toast'), /Nothing to export/);
});

await step('unexpected popup error → safety-net toast, popup keeps working', async () => {
  await pop.evaluate(() => { setTimeout(() => Promise.reject(new Error('Simulated crash')), 0); });
  await pop.waitForFunction(() => /Simulated crash/.test(document.querySelector('#toast').textContent));
  await pop.click('#tabbtn-write');
  assert.equal(await pop.getAttribute('#tabbtn-write', 'aria-selected'), 'true');
});

await step('corrupted storage → popup boots, repairs data, no console errors', async () => {
  await storage.set({
    settings: { name: { evil: true }, theme: 42, followUpDays: 'never' },
    prefs: 'garbage', templates: 'nope',
    contacts: { 'in:ok': { name: 'Still Here', status: 'sent', sentAt: 1, lastTouchAt: 1, updatedAt: 5 }, 'in:bad': 12, 'in:worse': { status: 'exploded', name: ['x'] } }
  });
  await pop.close();
  pop = await env.popup(priya.id);
  await pop.click('#tabbtn-tracker'); await pop.waitForSelector('.contact');
  const names = await pop.$$eval('.contact-name', e => e.map(x => x.textContent));
  assert.deepEqual(names.sort(), ['Still Here', 'Unknown']);
  await pop.click('#tabbtn-settings');
  assert.equal(await pop.inputValue('#s-days'), '5');
});

await step('reset everything: two clicks, back to first-run state', async () => {
  await pop.click('#reset-btn');
  assert.match(await pop.textContent('#reset-btn'), /Click again/);
  await Promise.all([pop.waitForEvent('load'), pop.click('#reset-btn')]);
  await pop.waitForSelector('body.booted');
  assert.match(await pop.textContent('#key-status'), /Built-in writer/);
  const all = await storage.get(null);
  assert.deepEqual(Object.values(all.contacts), []);
  assert.equal(all.settings.name, '');
});

await step('accessibility (axe, WCAG 2 AA): all tabs — dark theme', async () => {
  await storage.msg(pop, 'saveSettings', { theme: 'dark' });
  await pop.close();
  pop = await env.popup(priya.id);
  await pop.click('#read-btn'); await pop.waitForSelector('#draft:not(.hidden)');
  await a11y(pop, 'write-dark');
  await pop.click('#tabbtn-tracker'); await pop.waitForTimeout(250); await a11y(pop, 'tracker-dark');
  await pop.click('#tabbtn-settings'); await pop.waitForTimeout(250); await a11y(pop, 'settings-dark');
});

await step('no console or page errors anywhere', async () => { assert.deepEqual(errors, []); });

await pop.close();
await env.saveCoverage('scenarios');
await env.ctx.close();
process.exit(report('e2e scenarios') ? 1 : 0);
