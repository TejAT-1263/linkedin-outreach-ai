// content/content_script.js in a real Chrome page: scraping + inserting across many LinkedIn-like layouts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension/content/content_script.js');
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

/** Open `html`, stub chrome.runtime, load the content script; returns { page, send }. */
async function load(html, { title = 'Profile | LinkedIn', before: setup, url = 'https://www.linkedin.com/in/test-user/' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', e => { throw e; });
  await page.addInitScript(() => {
    window.__listeners = 0;
    window.chrome = { runtime: { id: 'ext', onMessage: { addListener(fn) { window.__listeners += 1; window.__cs = fn; } } } };
  });
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main>${html}</main></body></html>`;
  await page.route('https://www.linkedin.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body }));
  await page.goto(url);
  if (setup) await page.evaluate(setup);
  await page.addScriptTag({ path: SCRIPT });
  const send = (msg, senderId = 'ext') => page.evaluate(([m, id]) => new Promise((resolve) => {
    const keepOpen = window.__cs(m, { id }, resolve);
    if (!keepOpen) setTimeout(() => resolve('__no_response__'), 50);
  }), [msg, senderId]);
  return { page, send, scrape: async () => (await send({ action: 'scrapeProfile' })).data };
}

const exp = (rows) => rows.map(r => r.map(t => `<p><span aria-hidden="true">${t}</span><span class="visually-hidden">${t}</span></p>`).join('')).join('');
const FULL = `
<section><h1>Priya Sharma</h1><div class="text-body-medium">Senior PM at Razorpay | ex-Flipkart</div>
  <span class="text-body-small">Bengaluru, Karnataka, India</span><span class="text-body-small">500+ connections</span><span class="text-body-small">She/Her</span></section>
<section><div id="about"></div><h2>About</h2><p><span>I build payments products that small businesses actually enjoy using every single day.</span></p></section>
<section><div id="content_collections"></div><h2>Activity</h2><p><span>Why most onboarding flows fail: they ask for everything up front instead of earning trust.</span></p><p><span>Show all posts</span></p></section>
<section><div id="experience"></div><h2>Experience</h2>${exp([
  ['Senior Product Manager', 'Razorpay · Full-time', 'Jan 2022 - Present · 2 yrs 10 mos', 'Bengaluru, Karnataka, India · Hybrid'],
  ['Product Manager', 'Flipkart · Full-time', '2017 - 2021 · 4 yrs'],
  ['Analyst', 'Deloitte', '2015 - 2017 · 2 yrs', 'Remote']])}</section>
<section><div id="education"></div><h2>Education</h2>${exp([['IIT Bombay', 'B.Tech, Computer Science', '2013 - 2017']])}</section>
<section><div id="skills"></div><h2>Skills</h2><p><span>Product Management</span></p><p><span>Payments</span></p><p><span>SQL</span></p><p><span>Show all 24 skills</span></p><p><span>12 endorsements</span></p></section>`;

// ─── Scraping ─────────────────────────────────────────────────────────────────
test('full modern profile: every part found and parsed correctly', async () => {
  const { page, scrape } = await load(FULL);
  const d = await scrape();
  assert.equal(d.name, 'Priya Sharma');
  assert.equal(d.headline, 'Senior PM at Razorpay | ex-Flipkart');
  assert.equal(d.location, 'Bengaluru, Karnataka, India');
  assert.match(d.about, /^I build payments/);
  assert.equal(d.currentTitle, 'Senior Product Manager');
  assert.equal(d.currentCompany, 'Razorpay');
  assert.deepEqual(d.pastCompanies, ['Flipkart', 'Deloitte']);
  assert.deepEqual(d.experienceEntries.map(e => e.title), ['Senior Product Manager', 'Product Manager', 'Analyst'], 'screen-reader duplicates collapsed');
  assert.deepEqual(d.educationEntries, [{ school: 'IIT Bombay', detail: 'B.Tech, Computer Science' }]);
  assert.deepEqual(d.skills, ['Product Management', 'Payments', 'SQL'], 'UI noise ("Show all", endorsements) filtered');
  assert.deepEqual(d.recentPosts, ['Why most onboarding flows fail: they ask for everything up front instead of earning trust.']);
  assert.equal(d.diagnostics.foundCount, 8);
  assert.equal(d.diagnostics.layoutSuspect, false);
  await page.close();
});

test('older layout (headings only, no anchor ids) still works', async () => {
  const { page, scrape } = await load(FULL.replace(/<div id="[a-z_]+"><\/div>/g, ''));
  const d = await scrape();
  assert.equal(d.diagnostics.foundCount, 8);
  assert.equal(d.currentCompany, 'Razorpay');
  await page.close();
});

test('non-English profile: anchor ids work without English headings', async () => {
  const de = FULL.replace('<h2>About</h2>', '<h2>Info</h2>').replace('<h2>Experience</h2>', '<h2>Berufserfahrung</h2>')
    .replace('<h2>Education</h2>', '<h2>Ausbildung</h2>').replace('<h2>Skills</h2>', '<h2>Kenntnisse</h2>').replace('<h2>Activity</h2>', '<h2>Aktivitäten</h2>');
  const { page, scrape } = await load(de);
  const d = await scrape();
  assert.equal(d.diagnostics.foundCount, 8);
  assert.equal(d.experienceEntries.length, 3);
  await page.close();
});

test('layout changed (only a name) → flagged, nothing invented', async () => {
  const { page, scrape } = await load('<div><h1>Alex Kim</h1></div><div style="height:3000px"></div>');
  const d = await scrape();
  assert.equal(d.name, 'Alex Kim');
  assert.equal(d.diagnostics.foundCount, 1);
  assert.equal(d.diagnostics.layoutSuspect, true);
  assert.deepEqual([d.headline, d.currentCompany, d.about], ['', '', '']);
  await page.close();
});

test('no h1 at all → name falls back to the page title', async () => {
  const { page, scrape } = await load('<p>nothing here</p>', { title: 'Jordan Lee | LinkedIn' });
  const d = await scrape();
  assert.equal(d.name, 'Jordan Lee');
  assert.equal(d.diagnostics.layoutSuspect, true);
  await page.close();
});

test('title/company from the headline when there is no Experience section', async () => {
  for (const [headline, title, company] of [
    ['Staff Engineer at Stripe', 'Staff Engineer', 'Stripe'],
    ['Founder @ Acme | Angel investor', 'Founder', 'Acme'],
    ['Designer | Figma', 'Designer', 'Figma'],
    ['Professional dreamer', '', '']
  ]) {
    const { page, scrape } = await load(`<section><h1>Sam</h1><div class="text-body-medium">${headline}</div></section>`);
    const d = await scrape();
    assert.equal(d.currentTitle, title, headline);
    assert.equal(d.currentCompany, company, headline);
    await page.close();
  }
});

test('locations anywhere in the world; job titles are not mistaken for places', async () => {
  for (const [loc, expected] of [['Berlin, Germany', 'Berlin, Germany'], ['São Paulo, Brazil', 'São Paulo, Brazil'], ['Remote', 'Remote'], ['Product Manager', '']]) {
    const { page, scrape } = await load(`<section><h1>Sam</h1><div class="text-body-medium">Engineer at X</div><span class="text-body-small">${loc}</span></section>`);
    assert.equal((await scrape()).location, expected, loc);
    await page.close();
  }
});

test('script-injection text on the page is returned as inert text', async () => {
  const evil = '&lt;img src=x onerror="window.__xss=1"&gt;';
  const { page, scrape } = await load(`<section><h1>${evil} Evil</h1><div class="text-body-medium">${evil} at Corp</div></section>`);
  const d = await scrape();
  assert.match(d.name, /^<img src=x onerror="window.__xss=1"> Evil$/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await page.close();
});

test('unicode, RTL and emoji names survive intact', async () => {
  const { page, scrape } = await load('<section><h1>José Ñúñez 中文 مرحبا 🚀</h1><div class="text-body-medium">Ingeniero at Mercado Libre</div></section>');
  assert.equal((await scrape()).name, 'José Ñúñez 中文 مرحبا 🚀');
  await page.close();
});

test('profile URL drops query and hash; user scroll position is restored', async () => {
  const { page, scrape } = await load(FULL + '<div style="height:4000px"></div>', { url: 'https://www.linkedin.com/in/priya-sharma/?miniProfile=1#x' });
  await page.evaluate(() => window.scrollTo(0, 333));
  const d = await scrape();
  assert.match(d.profileUrl, /\/in\/priya-sharma\/$/);
  assert.equal(await page.evaluate(() => window.scrollY), 333);
  await page.close();
});

test('very large pages are scraped quickly with bounded output', async () => {
  const many = Array.from({ length: 400 }, (_, i) => `<section><h2>Section ${i}</h2>${'<p><span>filler text here</span></p>'.repeat(10)}</section>`).join('');
  const skills = `<section><div id="skills"></div><h2>Skills</h2>${Array.from({ length: 200 }, (_, i) => `<p><span>Skill${'abcdefghij'[i % 10]}${'xyz'[i % 3]}</span></p>`).join('')}</section>`;
  const { page, scrape } = await load(FULL + many + skills);
  const t0 = Date.now();
  const d = await scrape();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `took ${elapsed}ms`);
  assert.ok(d.skills.length <= 10 && d.recentPosts.length <= 3 && d.experienceEntries.length <= 5);
  await page.close();
});

// ─── Messaging contract ───────────────────────────────────────────────────────
test('ping, unknown actions, foreign senders, double injection', async () => {
  const { page, send } = await load('<p>x</p>');
  assert.deepEqual(await send({ action: 'ping' }), { ok: true });
  assert.equal(await send({ action: 'selfDestruct' }), '__no_response__');
  assert.equal(await send(null), '__no_response__');
  assert.equal(await send({ action: 'ping' }, 'evil-extension'), '__no_response__');
  await page.addScriptTag({ path: SCRIPT });
  assert.equal(await page.evaluate(() => window.__listeners), 1, 'second injection is a no-op');
  await page.close();
});

// ─── Inserting ────────────────────────────────────────────────────────────────
const NOTE = '<div role="dialog"><textarea id="custom-message" name="message" maxlength="300"></textarea></div>';
const MSG = (n = 1) => Array.from({ length: n }, (_, i) => `<div class="msg-form__contenteditable" contenteditable="true" role="textbox" data-i="${i}" style="min-height:40px"></div>`).join('');
const insert = (send, text, replace = false) => send({ action: 'insertMessage', text, replace });

test('connection note: inserts, fires input/change, reports the real maxlength', async () => {
  const { page, send } = await load(NOTE, { before: () => { window.__ev = []; document.addEventListener('input', () => window.__ev.push('input'), true); document.addEventListener('change', () => window.__ev.push('change'), true); } });
  const res = await insert(send, 'Hi Priya,\n\nFellow Flipkart alum.');
  assert.deepEqual(res, { ok: true, reason: undefined, kind: 'connection-note', maxLength: 300 });
  assert.equal(await page.inputValue('#custom-message'), 'Hi Priya,\n\nFellow Flipkart alum.');
  assert.deepEqual(await page.evaluate(() => window.__ev), ['input', 'change']);
  await page.close();
});

test('connection note: too long, already has text, replace', async () => {
  const { page, send } = await load(NOTE.replace('maxlength="300"', 'maxlength="200"'));
  assert.deepEqual(await insert(send, 'x'.repeat(201)), { ok: false, reason: 'tooLong', kind: 'connection-note', maxLength: 200 });
  await page.fill('#custom-message', 'my own words');
  assert.equal((await insert(send, 'Hello')).reason, 'notEmpty');
  assert.equal(await page.inputValue('#custom-message'), 'my own words', 'user text untouched');
  assert.equal((await insert(send, 'Hello', true)).ok, true);
  assert.equal(await page.inputValue('#custom-message'), 'Hello');
  await page.close();
});

test('message box: multi-line text via insertText; latest visible window wins', async () => {
  const { page, send } = await load(MSG(3));
  const res = await insert(send, 'Line one\n\nLine three');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'message');
  const texts = await page.$$eval('[contenteditable]', els => els.map(e => e.innerText.trim()));
  assert.equal(texts[0], '');
  assert.match(texts[2], /Line one\n+Line three/);
  await page.close();
});

test('hidden boxes are ignored (display:none, visibility:hidden, zero size)', async () => {
  const html = `<div role="dialog" style="display:none"><textarea id="custom-message"></textarea></div>
    <textarea name="message" style="visibility:hidden"></textarea>
    <div class="msg-form__contenteditable" contenteditable="true" role="textbox" style="width:0;height:0;overflow:hidden"></div>
    ${MSG(1)}`;
  const { page, send } = await load(html);
  const res = await insert(send, 'Hello');
  assert.equal(res.kind, 'message');
  assert.equal(await page.$eval('[data-i="0"]', e => e.innerText.trim()), 'Hello');
  await page.close();
});

test('note dialog takes priority over an open chat window', async () => {
  const { page, send } = await load(MSG(1) + NOTE);
  assert.equal((await insert(send, 'Hi')).kind, 'connection-note');
  await page.close();
});

test('if insertText is unavailable, falls back to safe paragraphs (no HTML injection)', async () => {
  const { page, send } = await load(MSG(1), { before: () => { document.execCommand = () => false; } });
  const res = await insert(send, 'Hi <b>there</b>\n\nBye');
  assert.equal(res.ok, true);
  const out = await page.$eval('[data-i="0"]', e => ({ html: e.innerHTML, bold: e.querySelectorAll('b').length, paras: e.querySelectorAll('p').length }));
  assert.equal(out.bold, 0, 'markup in the draft stays text');
  assert.equal(out.paras, 3);
  assert.match(out.html, /&lt;b&gt;there&lt;\/b&gt;/);
  await page.close();
});

test('if LinkedIn rejects the text, we report it instead of claiming success', async () => {
  const { page, send } = await load(MSG(1), { before: () => {
    const el = document.querySelector('[contenteditable]');
    Object.defineProperty(el, 'innerText', { get: () => '', set() {} });
    el.replaceChildren = () => {};
    document.execCommand = () => true;
  } });
  assert.deepEqual(await insert(send, 'Hello there'), { ok: false, reason: 'notVerified', kind: 'message', maxLength: null });
  await page.close();
});

test('no box open → noComposer; errors inside insert are caught', async () => {
  const { page, send } = await load('<p>feed</p>');
  assert.deepEqual(await insert(send, 'Hi'), { ok: false, reason: 'noComposer' });
  await page.evaluate(() => { document.querySelectorAll = () => { throw new Error('DOM exploded'); }; });
  assert.deepEqual(await insert(send, 'Hi'), { ok: false, reason: 'error', error: 'DOM exploded' });
  await page.close();
});

test('scrape errors are returned, not thrown into the page', async () => {
  const { page, send } = await load('<section><h1>X</h1></section>');
  await page.evaluate(() => { Element.prototype.closest = () => { throw new Error('closest broke'); }; });
  assert.deepEqual(await send({ action: 'scrapeProfile' }), { success: false, error: 'closest broke' });
  await page.close();
});
