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

// ─── 2026 layout (measured on live LinkedIn, Nov 2026) ─────────────────────────
// Name in <h2>, hashed class names, no section anchor ids, "(3)" notification count in the
// tab title, the page scrolls inside <main id="workspace">, lower sections mount only when
// scrolled into view, About/post text shares an element with a "…more" button, and link
// cards render their title twice in one element.
const LAYOUT_2026 = `
<style>html,body{height:100%;margin:0;overflow:hidden} #workspace{height:700px;overflow-y:auto} section{min-height:500px}</style>
<div id="app"><main id="workspace" class="bsjx1">
<section class="bsj01"><h2 class="bsja">Priya Sharma</h2><p class="bsjb">Senior PM at Razorpay | ex-Flipkart</p>
  <p class="bsjc">IIT Bombay</p><p class="bsjc">Bengaluru, Karnataka, India</p><a>Contact info</a><p>500+ connections</p></section>
<section class="bsj02"><h2>About</h2><p class="bsjd"><span>I build payments products that small businesses actually enjoy using.<br><br>Previously led checkout at Flipkart for five years.</span><button><span>…more</span></button></p>
  <div><p>Top skills</p><p>Product Management • Payments • SQL</p></div></section>
<section class="bsj03"><h2>Activity</h2><p>2,310 followers</p>
  <p><span>Why most onboarding flows fail: they ask for everything up front.<br><strong>#product</strong> <a>#onboarding</a></span><button>…more</button></p>
  <p><span><span>Pricing teardown: what Stripe gets right about self-serve</span><span>Pricing teardown: what Stripe gets right about self-serve</span></span></p>
  <div class="vjs-control-bar"><span class="vjs-control-text">Seek to live, currently behind live</span><p>Beginning of dialog window. Escape will cancel and close the window.</p></div></section>
<div id="lazy"></div>
</main></div>
<script>
  // Mount Experience/Education/Skills only when the inner container scrolls near them.
  const ws = document.getElementById('workspace');
  const exp = (r) => r.map(t => '<p>' + t + '</p>').join('');
  const later = [
    '<section><h2>Experience</h2>' + exp(['Senior Product Manager', 'Razorpay · Full-time', 'Jan 2022 - Present · 2 yrs 10 mos', 'Bengaluru, Karnataka, India · Hybrid', 'Product Manager', 'Flipkart · Full-time', '2017 - 2021 · 4 yrs']) + '<span>more</span></section>',
    '<section><h2>Education</h2>' + exp(['IIT Bombay', 'B.Tech, Computer Science', '2013 – 2017']) + '</section>',
    '<section><h2>Skills (24)</h2><span>Product Management</span><span>Go-to-market</span><span>Show all</span></section>'
  ];
  ws.addEventListener('scroll', () => {
    while (later.length && ws.scrollTop + ws.clientHeight > ws.scrollHeight - 300) {
      document.getElementById('lazy').insertAdjacentHTML('beforeend', later.shift());
    }
  });
</script>`;

test('2026 layout: h2 name, inner scroll container, lazy sections, "…more" buttons, doubled text', async () => {
  const { page, scrape } = await load(LAYOUT_2026, { title: '(3) Priya Sharma | LinkedIn', url: 'https://www.linkedin.com/in/priya-sharma/' });
  await page.evaluate(() => { document.getElementById('workspace').scrollTop = 120; });
  const d = await scrape();
  assert.equal(d.name, 'Priya Sharma', 'no "(3)" from the title');
  assert.equal(d.headline, 'Senior PM at Razorpay | ex-Flipkart');
  assert.equal(d.location, 'Bengaluru, Karnataka, India');
  assert.equal(d.about, 'I build payments products that small businesses actually enjoy using. Previously led checkout at Flipkart for five years.');
  assert.doesNotMatch(d.about, /more/);
  assert.equal(d.currentTitle, 'Senior Product Manager');
  assert.equal(d.currentCompany, 'Razorpay');
  assert.deepEqual(d.pastCompanies, ['Flipkart']);
  assert.deepEqual(d.educationEntries, [{ school: 'IIT Bombay', detail: 'B.Tech, Computer Science' }]);
  assert.deepEqual(d.skills, ['Product Management', 'Payments', 'SQL', 'Go-to-market'], 'Top skills first, then Skills section, deduped');
  assert.deepEqual(d.recentPosts, ['Why most onboarding flows fail: they ask for everything up front. #product #onboarding', 'Pricing teardown: what Stripe gets right about self-serve']);
  assert.equal(d.diagnostics.foundCount, 8);
  assert.equal(await page.evaluate(() => document.getElementById('workspace').scrollTop), 120, 'inner scroll position restored');
  await page.close();
});

// ─── Messaging contract ───────────────────────────────────────────────────────
// ─── Per-entry containers (measured on live LinkedIn, Nov 22 2026) ─────────────
// Each job/school is wrapped in its own block; entries have 2–4 lines, so a fixed 3-line
// stride misreads them. A location without a comma ("Greater Seattle Area") and a school
// without dates used to shift every following row.
const card = (lines) => `<div componentkey="x"><div><div><a><div>${lines.map(t => `<p>${t}</p>`).join('')}</div></a></div></div></div>`;
const ENTRIES = `
<section><h2>Jordan Lee</h2><p>CEO at Contoso</p><p>Seattle, Washington, United States</p></section>
<section><h2>Experience</h2><div><div>
  ${card(['Chairman and CEO', 'Contoso', 'Feb 2014 - Present · 12 yrs 10 mos', 'Greater Seattle Area'])}
  ${card(['Member Board Of Trustees', 'University of Chicago', '2018 – Present'])}
  ${card(['Board Member', 'Fabrikam', '2017 – 2024'])}
  ${card(['Northwind', 'Full-time · 9 yrs 2 mos', 'Pune, Maharashtra, India', 'Engineering Manager', 'Jan 2019 - Feb 2023 · 4 yrs 2 mos', 'Senior Engineer', 'Jan 2014 - Dec 2018 · 5 yrs'])}
  <p>Show all 6 experiences</p></div></div></section>
<section><h2>Education</h2><div><div>
  ${card(['Booth School of Business', '1994 – 1996'])}
  ${card(['Manipal Institute of Technology', 'Bachelor’s Degree, Electrical Engineering'])}
</div></div></section>`;

test('per-entry containers: uneven entries, comma-less locations, schools without dates, several roles at one company', async () => {
  const { page, scrape } = await load(ENTRIES, { title: 'Jordan Lee | LinkedIn' });
  const d = await scrape();
  assert.deepEqual(d.experienceEntries, [
    { title: 'Chairman and CEO', company: 'Contoso', duration: 'Feb 2014 - Present · 12 yrs 10 mos' },
    { title: 'Member Board Of Trustees', company: 'University of Chicago', duration: '2018 – Present' },
    { title: 'Board Member', company: 'Fabrikam', duration: '2017 – 2024' },
    { title: 'Engineering Manager', company: 'Northwind', duration: 'Jan 2019 - Feb 2023 · 4 yrs 2 mos' },
    { title: 'Senior Engineer', company: 'Northwind', duration: 'Jan 2014 - Dec 2018 · 5 yrs' }
  ]);
  assert.equal(d.currentCompany, 'Contoso');
  assert.deepEqual(d.pastCompanies, ['University of Chicago', 'Fabrikam', 'Northwind']);
  assert.deepEqual(d.educationEntries, [
    { school: 'Booth School of Business', detail: '' },
    { school: 'Manipal Institute of Technology', detail: 'Bachelor’s Degree, Electrical Engineering' }
  ]);
  await page.close();
});

test('single-name locations are read from the line before "Contact info"; the headline byline is not a post', async () => {
  const html = `<section><h2>Reid Doe</h2><p>He/Him</p><p>· 3rd</p><p>Co-Founder, Acme. Author of Big Ideas.</p><p>United States</p><span>·</span><a>Contact info</a><p>2,803,559 followers</p></section>
    <section><h2>Activity</h2><p><span>Co-Founder, Acme. Author of Big Ideas.</span></p><p><span>We experimented with a four-day week for a quarter; here is what changed.</span></p></section>`;
  const { page, scrape } = await load(html, { title: 'Reid Doe | LinkedIn' });
  const d = await scrape();
  assert.equal(d.location, 'United States');
  assert.deepEqual(d.recentPosts, ['We experimented with a four-day week for a quarter; here is what changed.']);
  await page.close();
  // Not a place: a title-like line before Contact info is not taken as a location.
  const { page: p2, scrape: s2 } = await load('<section><h2>Ann Bo</h2><p>Designer</p><p>Head of Design</p><a>Contact info</a></section>', { title: 'Ann Bo | LinkedIn' });
  assert.equal((await s2()).location, '');
  await p2.close();
});

test('Deep Mode page text: the profile’s own sections only (no sidebar), bounded, with a fallback', async () => {
  const html = `<section><h2>Jordan Lee</h2><p>CEO at Contoso</p><p>Seattle, Washington, United States</p></section>
    <section><h2>About</h2><p>I like building things that last.</p></section>
    <section><h2>Experience</h2><p>CEO</p><p>Contoso</p></section>
    <aside><section><h2>People you may know</h2><p>Someone Else — Recruiter at Evil Corp</p></section></aside>`;
  const { page, scrape } = await load(html, { title: 'Jordan Lee | LinkedIn' });
  const d = await scrape();
  assert.match(d.rawText, /Jordan Lee/);
  assert.match(d.rawText, /I like building things that last\./);
  assert.match(d.rawText, /CEO\nContoso/);
  assert.doesNotMatch(d.rawText, /Evil Corp/, 'sidebar profiles are not sent to the parser');
  await page.close();

  // Nothing recognisable: fall back to the main column, capped at 15,000 characters.
  const big = `<div><p>Mystery Person</p><p>${'word '.repeat(5000)}</p></div>`;
  const { page: p2, scrape: s2 } = await load(big, { title: 'Mystery Person | LinkedIn' });
  const d2 = await s2();
  assert.match(d2.rawText, /^Mystery Person/);
  assert.equal(d2.rawText.length, 15000);
  await p2.close();
});

test('a single wrapped entry is read as one entry, not split into its parts', async () => {
  const one = `<section><h2>Sam Roy</h2><p>Analyst at Acme</p></section>
    <section><h2>Experience</h2><div componentkey="a"><div><p>Analyst</p><p>Acme · Full-time</p></div><div><p>Mar 2024 - Present · 2 yrs 8 mos</p></div></div></section>
    <section><h2>Education</h2><div componentkey="b"><div><p>Nirma University</p></div><div><p>B.Tech, IT</p><p>2019 – 2023</p></div></div></section>`;
  const { page, scrape } = await load(one, { title: 'Sam Roy | LinkedIn' });
  const d = await scrape();
  assert.deepEqual(d.experienceEntries, [{ title: 'Analyst', company: 'Acme', duration: 'Mar 2024 - Present · 2 yrs 8 mos' }]);
  assert.deepEqual(d.educationEntries, [{ school: 'Nirma University', detail: 'B.Tech, IT' }]);
  await page.close();
});

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
