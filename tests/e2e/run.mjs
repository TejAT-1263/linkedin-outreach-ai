// End-to-end: real Chrome + the unpacked extension; linkedin.com is routed to local mock pages.
// Usage: node tests/e2e/run.mjs [screenshotsDir]   (CHROME_PATH to use a specific Chrome binary)
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../../extension');
const SHOTS = path.resolve(process.argv[2] || path.join(here, '../../screenshots'));
mkdirSync(SHOTS, { recursive: true });
const MOCK = readFileSync(path.join(here, 'mock/profile.html'), 'utf8');
const BROKEN = readFileSync(path.join(here, 'mock/broken.html'), 'utf8');

const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (err) { results.push(['FAIL', name, err.message.split('\n')[0]]); }
};

const ctx = await chromium.launchPersistentContext('', {
  executablePath: process.env.CHROME_PATH || undefined,
  channel: process.env.CHROME_PATH ? undefined : 'chromium',
  headless: true,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  permissions: ['clipboard-read', 'clipboard-write']
});
await ctx.route('https://www.linkedin.com/**', r => {
  const url = r.request().url();
  r.fulfill({ status: 200, contentType: 'text/html', body: url.includes('/in/alex-kim') ? BROKEN : MOCK });
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const errors = [];

const li = await ctx.newPage();
await li.goto('https://www.linkedin.com/in/priya-sharma/');
await li.waitForTimeout(600);
const tabIdOf = (pattern) => sw.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0].id, pattern);
const tabId = await tabIdOf('https://www.linkedin.com/in/priya-sharma/*');

async function openPopup(tid) {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await p.setViewportSize({ width: 400, height: 590 });
  await p.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tid}`);
  await p.waitForSelector('body.booted');
  return p;
}

let pop = await openPopup(tabId);
const shot = async (name, page = pop) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

await step('first run shows setup tip and built-in writer badge', async () => {
  assert.ok(await pop.isVisible('#setup-tip'));
  assert.match(await pop.textContent('#key-status'), /Built-in writer/);
  await shot('01-first-run');
});

await step('settings: save profile + background through the UI', async () => {
  await pop.click('#tabbtn-settings');
  await pop.fill('#s-name', 'Arjun Mehta');
  await pop.fill('#s-bio', "I'm a product engineer building AI tools for students.");
  await pop.fill('#s-background', 'Flipkart, IIT Delhi, SQL, Bengaluru');
  await pop.fill('#s-days', '5');
  await pop.click('#save-settings-btn');
  await pop.waitForSelector('#settings-status.status-success');
  await shot('02-settings');
  await pop.fill('#s-days', '99');
  await pop.click('#save-settings-btn');
  await pop.waitForSelector('#settings-status.status-error');
  await pop.fill('#s-days', '5');
  await pop.click('#tabbtn-write');
  assert.ok(!(await pop.isVisible('#setup-tip')));
});

await step('read profile → read check 8/8, common-ground hooks, draft within limit', async () => {
  await pop.click('#read-btn');
  await pop.waitForSelector('#draft:not(.hidden)', { timeout: 15000 });
  assert.equal(await pop.textContent('#read-pill'), '8/8 read');
  const chips = await pop.$$eval('.chip', els => els.map(e => (e.classList.contains('selected') ? '[x]' : '[ ]') + e.textContent));
  assert.match(chips[0], /^\[x\]★ You both worked at Flipkart/);
  assert.ok(chips.some(c => /You both studied/.test(c)) === false, 'no false school match');
  const draft = await pop.inputValue('#draft-text');
  assert.ok(draft.length <= 300 && /Flipkart/.test(draft));
  assert.match(await pop.textContent('#char-count'), /^\d+ \/ 300$/);
  await shot('03-drafted');
});

await step('toggling hooks / custom detail redrafts; New version + Alt+N change text', async () => {
  const d0 = await pop.inputValue('#draft-text');
  await pop.click('.chip:has-text("Senior Product Manager")');
  await pop.waitForTimeout(250);
  const d1 = await pop.inputValue('#draft-text');
  assert.notEqual(d1, d0);
  assert.equal(await pop.$$eval('.chip.selected', e => e.length), 2, 'max two selected');
  await pop.fill('#custom-hook', 'Loved your talk at the Pune product meetup');
  await pop.press('#custom-hook', 'Enter');
  await pop.waitForTimeout(250);
  assert.match(await pop.inputValue('#draft-text'), /Pune product meetup/);
  const d2 = await pop.inputValue('#draft-text');
  await pop.click('#regen-btn'); await pop.waitForTimeout(250);
  const d3 = await pop.inputValue('#draft-text');
  assert.notEqual(d3, d2);
  await pop.keyboard.press('Alt+KeyN'); await pop.waitForTimeout(250);
  assert.notEqual(await pop.inputValue('#draft-text'), d3);
});

await step('format switch re-fits the draft (free plan ≤ 200)', async () => {
  await pop.click('.seg[data-format="note-free"]'); await pop.waitForTimeout(250);
  assert.ok((await pop.inputValue('#draft-text')).length <= 200);
  assert.match(await pop.textContent('#char-count'), /\/ 200$/);
  await pop.click('.seg[data-format="note"]'); await pop.waitForTimeout(250);
});

await step('save as template, then draft from it', async () => {
  await pop.click('#save-tpl-open');
  await pop.fill('#tpl-name', 'Warm intro');
  await pop.click('#save-tpl-form button[type=submit]');
  await pop.waitForSelector('#toast.toast-success');
  const opts = await pop.$$eval('#source-select option', o => o.map(x => x.textContent));
  assert.ok(opts.includes('☆ Warm intro'));
  const tplId = await pop.$eval('#source-select optgroup option', o => o.value);
  await pop.selectOption('#source-select', tplId); await pop.waitForTimeout(300);
  const t = await pop.inputValue('#draft-text');
  assert.match(t, /^Hi Priya,/);
  assert.doesNotMatch(t, /\{\w+\}/);
  await pop.selectOption('#source-select', '__writer__'); await pop.waitForTimeout(300);
});

await step('insert into "Add a note" (Ctrl+Enter), replace guard, then message box', async () => {
  await pop.focus('#draft-text');
  await pop.keyboard.press('Control+Enter'); await pop.waitForTimeout(300);
  assert.match(await pop.textContent('#status'), /Inserted into the LinkedIn connection note/);
  assert.equal(await li.inputValue('#custom-message'), (await pop.inputValue('#draft-text')).trim());
  await pop.click('#insert-btn'); await pop.waitForTimeout(250);
  assert.equal(await pop.textContent('#insert-btn'), 'Replace LinkedIn text');
  await shot('04-inserted');
  await li.evaluate(() => { document.getElementById('note-dialog').style.display = 'none'; });
  await pop.click('.seg[data-format="dm"]'); await pop.waitForTimeout(300);
  await pop.click('#insert-btn'); await pop.waitForTimeout(300);
  const dm = await li.$eval('.msg-form__contenteditable', el => el.innerText);
  assert.match(dm, /Hi Priya/);
  await li.evaluate(() => { document.getElementById('msg').style.display = 'none'; });
  await pop.click('#insert-btn'); await pop.waitForTimeout(300);
  assert.match(await pop.textContent('#status'), /copied instead/);
});

await step('popup closes and reopens → draft restored + "already contacted" banner', async () => {
  const before = await pop.inputValue('#draft-text');
  await pop.close();
  pop = await openPopup(tabId);
  await pop.waitForSelector('#draft:not(.hidden)');
  assert.equal(await pop.inputValue('#draft-text'), before);
  await pop.waitForSelector('#contact-banner:not(.hidden)');
  assert.match(await pop.textContent('#contact-banner-text'), /You inserted a note for Priya/);
});

await step('tracker: stats, mark sent, follow-up becomes due (badge), write + log follow-up, replied', async () => {
  await pop.click('#tabbtn-tracker');
  await pop.waitForSelector('.contact');
  assert.equal(await pop.textContent('#stat-reached'), '1');
  assert.match(await pop.textContent('.contact .pill'), /Inserted/);
  await pop.click('.contact button:has-text("Mark sent")'); await pop.waitForTimeout(250);
  assert.match(await pop.textContent('.contact .pill'), /Sent/);
  // time travel 6 days
  await sw.evaluate(async () => {
    const { contacts } = await chrome.storage.local.get('contacts');
    for (const c of Object.values(contacts)) c.lastTouchAt = Date.now() - 6 * 864e5;
    await chrome.storage.local.set({ contacts });
  });
  await pop.click('.seg[data-filter="due"]'); await pop.waitForTimeout(300);
  assert.equal(await pop.$$eval('.contact.due', e => e.length), 1);
  assert.match(await pop.textContent('#due-count'), /\(1\)/);
  await pop.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ action: 'getState', payload: {} }, r)));
  assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '1');
  await pop.click('.contact button:has-text("Write follow-up")');
  await pop.waitForSelector('.followup-text');
  assert.match(await pop.inputValue('.followup-text'), /^Hi Priya,/);
  await shot('05-followup');
  await pop.click('.followup button:has-text("Mark as sent")'); await pop.waitForTimeout(300);
  await pop.click('.seg[data-filter="all"]'); await pop.waitForTimeout(250);
  assert.match(await pop.textContent('.contact .contact-when'), /1 sent/);
  await pop.click('.contact button:has-text("Replied")'); await pop.waitForTimeout(300);
  assert.equal(await pop.textContent('#stat-rate'), '100%');
  assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '');
  await shot('06-tracker');
});

await step('tracker search + CSV export download', async () => {
  await pop.fill('#tracker-search', 'nobody'); await pop.waitForTimeout(300);
  assert.ok(await pop.isVisible('#tracker-empty'));
  await pop.fill('#tracker-search', ''); await pop.waitForTimeout(300);
  const [dl] = await Promise.all([pop.waitForEvent('download'), pop.click('#export-btn')]);
  assert.match(dl.suggestedFilename(), /^outreach-tracker-\d{4}-\d{2}-\d{2}\.csv$/);
});

await step('dark theme applies and persists', async () => {
  await pop.click('#tabbtn-settings');
  await pop.click('.seg[data-theme="dark"]'); await pop.waitForTimeout(200);
  assert.equal(await pop.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await shot('07-settings-dark');
  await pop.close();
  pop = await openPopup(tabId);
  assert.equal(await pop.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await pop.click('.seg[data-format="note"]').catch(() => {});
  await pop.waitForTimeout(200);
  await shot('08-write-dark');
  await pop.click('#tabbtn-tracker'); await pop.waitForSelector('.contact');
  await shot('09-tracker-dark');
});

await step('broken LinkedIn layout → read check flags it', async () => {
  const b = await ctx.newPage();
  await b.goto('https://www.linkedin.com/in/alex-kim/');
  await b.waitForTimeout(400);
  const bp = await openPopup(await tabIdOf('https://www.linkedin.com/in/alex-kim/*'));
  await bp.click('#read-btn');
  await bp.waitForSelector('#layout-warning:not(.hidden)', { timeout: 15000 });
  assert.match(await bp.textContent('#read-pill'), /^1\/8 read$/);
  await bp.evaluate(() => { delete document.documentElement.dataset.theme; });
  await shot('10-layout-warning', bp);
  await bp.close();
});

await step('non-profile page disables reading', async () => {
  const f = await ctx.newPage();
  await f.goto('https://www.linkedin.com/feed/');
  const fp = await openPopup(await tabIdOf('https://www.linkedin.com/feed/*'));
  const dbg = await fp.evaluate(() => ({ warn: !document.getElementById('page-warning').classList.contains('hidden'), disabled: document.getElementById('read-btn').disabled, active: document.querySelector('.tab-content.active').id, url: location.href }));
  assert.ok(dbg.warn && dbg.disabled, JSON.stringify(dbg));
  await fp.close();
});

await step('no console or page errors', async () => { assert.deepEqual(errors, []); });

await ctx.close();
for (const r of results) console.log(r.join('  '));
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} e2e steps passed`);
process.exit(failed ? 1 : 0);
