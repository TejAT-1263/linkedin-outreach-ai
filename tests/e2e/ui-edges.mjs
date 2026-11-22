// UI edge cases: every remaining button, keyboard path and failure message in the popup.
import assert from 'node:assert/strict';
import { launch, steps, mockHtml } from './harness.mjs';

const profile = mockHtml('profile.html');
// A LinkedIn chat box that silently refuses programmatic text (some editors do this).
const REJECTING = profile
  .replace(/<div role="dialog" id="note-dialog">[\s\S]*?<\/div>/, '')
  .replace('</body>', `<script>
    const el = document.querySelector('.msg-form__contenteditable');
    // A framework-controlled editor that throws away text it didn't type itself.
    el.addEventListener('input', () => { el.textContent = ''; });
  </script></body>`);
const rename = (html, name) => html.split('Priya Sharma').join(name);
const env = await launch({ pages: { '/in/stubborn': rename(REJECTING, 'Sam Stubborn'), '/in/temp-person': rename(profile, 'Tara Menon') } });
const { storage, errors, api } = env;
const { step, report } = steps();

const priya = await env.tab('https://www.linkedin.com/in/priya-sharma/');
let pop = await env.popup(priya.id);
await storage.msg(pop, 'saveSettings', { name: 'Arjun Mehta', background: 'Flipkart, SQL, Bengaluru' });
await pop.close();
pop = await env.popup(priya.id);
await pop.click('#read-btn');
await pop.waitForSelector('#draft:not(.hidden)');

await step('read-check pill toggles the detail panel', async () => {
  assert.equal(await pop.isVisible('#read-detail'), false);
  await pop.click('#read-pill');
  assert.match(await pop.textContent('#read-detail'), /Read: Name, Headline, Location/);
  await pop.click('#read-pill');
  assert.equal(await pop.isVisible('#read-detail'), false);
});

await step('hooks: deselect, third pick swaps out the oldest, empty custom detail ignored', async () => {
  const sel = () => pop.$$eval('.chip.selected', e => e.map(x => x.textContent));
  const first = await sel();
  assert.equal(first.length, 2);
  await pop.click(`.chip.selected >> nth=1`); await pop.waitForTimeout(200);
  assert.equal((await sel()).length, 1);
  await pop.click('.chip:not(.selected) >> nth=0'); await pop.waitForTimeout(200);
  await pop.click('.chip:not(.selected) >> nth=0'); await pop.waitForTimeout(200);
  const now = await sel();
  assert.equal(now.length, 2);
  assert.ok(!now.includes(first[0]), 'oldest pick was swapped out');
  const n = (await pop.$$('.chip')).length;
  await pop.fill('#custom-hook', '   ');
  await pop.press('#custom-hook', 'Enter'); await pop.waitForTimeout(150);
  assert.equal((await pop.$$('.chip')).length, n);
});

await step('copy button: clipboard + tracker marks Copied', async () => {
  await pop.click('#copy-btn');
  await pop.waitForFunction(() => document.querySelector('#copy-btn').textContent === '✓ Copied');
  assert.equal(await pop.evaluate(() => navigator.clipboard.readText()), await pop.inputValue('#draft-text'));
  const list = (await storage.msg(pop, 'listContacts', {})).data.items;
  assert.equal(list[0].status, 'copied');
});

await step('save-as-template: cancel, empty name blocked, limit reached → clear error', async () => {
  await pop.click('#save-tpl-open');
  await pop.click('#save-tpl-cancel');
  assert.equal(await pop.isVisible('#save-tpl-form'), false);
  await pop.click('#save-tpl-open');
  await pop.click('#save-tpl-form button[type=submit]');
  assert.equal(await pop.isVisible('#save-tpl-form'), true, 'required name blocks submit');
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, text: 'Hello {firstName} there', uses: 0 }));
  await storage.set({ templates: many });
  await pop.fill('#tpl-name', 'One more');
  await pop.click('#save-tpl-form button[type=submit]');
  await pop.waitForSelector('#toast.toast-error');
  assert.match(await pop.textContent('#toast'), /up to 50 templates/);
  await storage.set({ templates: [] });
  await pop.click('#save-tpl-cancel');
});

await step('session restores a chosen template across popup reopen', async () => {
  await storage.msg(pop, 'saveTemplate', { name: 'Keep me', text: 'Hey {firstName}, from a template.' });
  await pop.close();
  pop = await env.popup(priya.id);
  const id = await pop.$eval('#source-select optgroup option', o => o.value);
  await pop.selectOption('#source-select', id); await pop.waitForTimeout(300);
  assert.equal(await pop.inputValue('#draft-text'), 'Hey Priya, from a template.');
  await pop.close();
  pop = await env.popup(priya.id);
  assert.equal(await pop.inputValue('#source-select'), id);
  assert.equal(await pop.inputValue('#draft-text'), 'Hey Priya, from a template.');
  await pop.selectOption('#source-select', '__writer__'); await pop.waitForTimeout(300);
});

await step('LinkedIn box refuses the text → honest message + copied', async () => {
  const s = await env.tab('https://www.linkedin.com/in/stubborn/');
  const p = await env.popup(s.id);
  await p.click('.seg[data-format="dm"]');
  await p.click('#read-btn'); await p.waitForSelector('#draft:not(.hidden)');
  await p.click('#insert-btn'); await p.waitForTimeout(300);
  assert.match(await p.textContent('#status'), /didn't accept the text automatically, so it's copied/);
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), await p.inputValue('#draft-text'));
  await p.click('.seg[data-format="note"]');
  await p.close(); await s.page.close();
});

await step('LinkedIn tab closed under the popup → clear errors for read and insert', async () => {
  const t = await env.tab('https://www.linkedin.com/in/temp-person/');
  const p = await env.popup(t.id);
  await p.click('#read-btn'); await p.waitForSelector('#draft:not(.hidden)');
  await t.page.close();
  await p.click('#insert-btn'); await p.waitForTimeout(300);
  assert.match(await p.textContent('#status'), /no longer open/);
  await p.click('#read-btn'); await p.waitForTimeout(300);
  assert.match(await p.textContent('#status'), /no longer open/);
  await p.close();
});

await step('popup without a LinkedIn tab (or a stale tab id) shows the page warning', async () => {
  const p = await env.popup(null);
  assert.ok(await p.isVisible('#page-warning'));
  await p.close();
  const q = await env.popup(999999);
  assert.ok(await q.isVisible('#page-warning'));
  assert.ok(await q.isDisabled('#read-btn'));
  await q.close();
});

await step('tracker: expand by click and Enter, copy, open profile, undo replied', async () => {
  await pop.click('#tabbtn-write');
  await pop.click('#read-btn');
  assert.equal(await pop.isDisabled('#insert-btn'), true, 'insert is disabled while reading');
  await pop.waitForFunction(() => !document.querySelector('#read-btn').disabled);
  await pop.click('#insert-btn');
  await pop.waitForFunction(() => /Inserted into the LinkedIn/.test(document.querySelector('#status').textContent), null, { timeout: 5000 })
    .catch(async () => { throw new Error(`insert did not succeed: ${await pop.textContent('#status')}`); });
  await pop.click('#tabbtn-tracker'); await pop.waitForSelector('.contact');
  const card = '.contact:has(.contact-name:text-is("Priya Sharma"))';
  await pop.click(`${card} >> .contact-msg`);
  assert.match(await pop.getAttribute(card, 'class'), /expanded/);
  assert.equal(await pop.getAttribute(`${card} >> .contact-msg`, 'aria-expanded'), 'true');
  await pop.focus(`${card} >> .contact-msg`); await pop.keyboard.press('Enter');
  assert.doesNotMatch(await pop.getAttribute(card, 'class'), /expanded/);
  await pop.keyboard.press('Space');
  assert.match(await pop.getAttribute(card, 'class'), /expanded/);
  await pop.keyboard.press('Space');
  await pop.click(`${card} >> [aria-label="Copy message"]`);
  await pop.waitForFunction(() => /Copied/.test(document.querySelector('#toast').textContent));
  // Verify from Chrome's side: a new tab really opened on the right profile. (Playwright's page
  // handle for extension-created tabs can report an empty URL on macOS.)
  const countTabs = () => env.sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.linkedin.com/in/priya-sharma/*' })).length);
  const before = await countTabs();
  const [newPage] = await Promise.all([env.ctx.waitForEvent('page'), pop.click(`${card} >> [aria-label^="Open "]`)]);
  for (const t0 = Date.now(); (await countTabs()) <= before && Date.now() - t0 < 10000;) await new Promise(r => setTimeout(r, 100));
  assert.equal(await countTabs(), before + 1, 'a new tab opened on the profile');
  await newPage.close();
  await pop.click(`${card} >> button:has-text("Replied")`); await pop.waitForTimeout(300);
  await pop.click(`${card} >> button:has-text("Undo")`); await pop.waitForTimeout(300);
  assert.match(await pop.textContent(`${card} >> .pill`), /Sent/);
});

await step('follow-up: Another gives a new draft, Copy, Open profile; deleted contact → error in place', async () => {
  const card = '.contact:has(.contact-name:text-is("Priya Sharma"))';
  await pop.click(`${card} >> button:has-text("Write follow-up")`);
  await pop.waitForSelector('.followup-text');
  const a = await pop.inputValue('.followup-text');
  await pop.click('.followup button:has-text("Another")');
  await pop.waitForFunction((prev) => document.querySelector('.followup-text')?.value && document.querySelector('.followup-text').value !== prev, a);
  await pop.click('.followup button:has-text("Copy")');
  assert.equal(await pop.evaluate(() => navigator.clipboard.readText()), await pop.inputValue('.followup-text'));
  const [np] = await Promise.all([env.ctx.waitForEvent('page'), pop.click('.followup button:has-text("Open profile")')]);
  await np.close();
  const { contacts } = await storage.get('contacts');
  await storage.set({ contacts: {} });
  await pop.click('.followup button:has-text("Another")'); await pop.waitForTimeout(300);
  assert.match(await pop.textContent('.followup .status-error'), /Contact not found/);
  await storage.set({ contacts });
});

await step('settings: Enter tests key; network failure is reported; theme click saves', async () => {
  await pop.click('#tabbtn-settings');
  api.queue.push({ status: 200, text: 'OK' });
  await pop.fill('#s-key', 'sk-ant-enter-key');
  await pop.press('#s-key', 'Enter');
  await pop.waitForSelector('#key-status-note.ok');
  const offline = r => r.abort('internetdisconnected');
  await env.ctx.route('https://api.anthropic.com/**', offline);
  await pop.fill('#s-key', 'sk-ant-offline');
  await pop.click('#test-key-btn');
  await pop.waitForFunction(() => /Network error/.test(document.querySelector('#key-status-note').textContent), null, { timeout: 20000 });
  await env.ctx.unroute('https://api.anthropic.com/**', offline);
  await pop.click('.seg[data-theme="light"]'); await pop.waitForTimeout(250);
  assert.equal((await storage.get('settings')).settings.theme, 'light');
  await pop.click('.seg[data-theme="system"]'); await pop.waitForTimeout(250);
});

await step('resume dropzone: keyboard opens picker, drag styles, drop works, >4 MB rejected, no key → saved only', async () => {
  await pop.bringToFront();
  await pop.click('#tabbtn-settings');
  await pop.focus('#dropzone');
  assert.ok(await Promise.all([pop.waitForEvent('filechooser'), pop.keyboard.press('Enter')]));
  assert.ok(await Promise.all([pop.waitForEvent('filechooser'), pop.keyboard.press('Space')]), 'Space works like a button');
  await pop.dispatchEvent('#dropzone', 'dragover');
  assert.match(await pop.getAttribute('#dropzone', 'class'), /over/);
  await pop.dispatchEvent('#dropzone', 'dragleave');
  assert.doesNotMatch(await pop.getAttribute('#dropzone', 'class'), /over/);
  await pop.setInputFiles('#resume-input', { name: 'big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(4 * 1024 * 1024 + 1, 65) });
  await pop.waitForFunction(() => /over 4 MB/.test(document.querySelector('#resume-status').textContent));
  api.queue.push({ status: 200, text: '{"summary":"x","companies":["DropCo"],"schools":[],"skills":[],"location":""}' });
  await pop.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['%PDF-1.4 tiny'], 'dropped.pdf', { type: 'application/pdf' }));
    document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await pop.waitForFunction(() => /DropCo/.test(document.querySelector('#s-background').value), null, { timeout: 10000 });
  await pop.click('#remove-key-btn'); await pop.waitForTimeout(250);
  await pop.setInputFiles('#resume-input', { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
  await pop.waitForFunction(() => /Saved on this device/.test(document.querySelector('#resume-status').textContent));
});

await step('navigation links: header badge, setup tip, "View in Tracker"', async () => {
  await pop.click('#tabbtn-write');
  await pop.click('#key-status');
  assert.equal(await pop.getAttribute('#tabbtn-settings', 'aria-selected'), 'true');
  const fresh = await env.tab('https://www.linkedin.com/in/tara-new/');
  await storage.msg(pop, 'saveSettings', { name: '', background: '' });
  const p = await env.popup(fresh.id);
  await p.click('#setup-tip [data-goto="settings"]');
  assert.equal(await p.getAttribute('#tabbtn-settings', 'aria-selected'), 'true');
  await storage.msg(p, 'saveSettings', { name: 'Arjun Mehta', background: 'Flipkart, SQL, Bengaluru' });
  await p.close(); await fresh.page.close();
  const { contacts } = await storage.get('contacts');
  const id = 'in:priya-sharma';
  contacts[id] = { ...contacts[id], status: 'sent', lastTouchAt: Date.now() - 2 * 3600e3, sentAt: Date.now() - 2 * 3600e3, followUps: 0 };
  await storage.set({ contacts });
  await pop.close();
  pop = await env.popup(priya.id);
  await pop.waitForSelector('#contact-banner:not(.hidden)');
  assert.match(await pop.textContent('#contact-banner-text'), /You sent a note to Priya 2 hours ago\./);
  await pop.click('#contact-banner [data-goto="tracker"]');
  assert.equal(await pop.getAttribute('#tabbtn-tracker', 'aria-selected'), 'true');
});

await step('due + already followed up shows the count; armed buttons disarm after a pause', async () => {
  const { contacts } = await storage.get('contacts');
  contacts['in:priya-sharma'] = { ...contacts['in:priya-sharma'], followUps: 1, lastTouchAt: Date.now() - 20 * 864e5 };
  await storage.set({ contacts });
  await pop.click('#tabbtn-write'); await pop.click('#tabbtn-tracker');
  await pop.waitForSelector('.contact');
  assert.match(await pop.textContent('.contact:has(.contact-name:text-is("Priya Sharma")) .contact-when'), /Follow-up due · 1 sent/);
  await pop.click('#clear-btn');
  await pop.click('.contact:has(.contact-name:text-is("Priya Sharma")) .icon-btn.danger');
  await pop.click('#tabbtn-settings'); await pop.click('#reset-btn');
  await pop.waitForTimeout(3700);
  assert.equal(await pop.textContent('#reset-btn'), 'Reset everything');
  await pop.click('#tabbtn-tracker'); await pop.waitForSelector('.contact');
  assert.equal(await pop.textContent('#clear-btn'), 'Clear tracker');
  assert.ok(await pop.isVisible('.contact:has(.contact-name:text-is("Priya Sharma"))'), 'single click never deletes');
});

await step('clipboard permission denied → copy still works via fallback', async () => {
  await env.ctx.clearPermissions();
  await pop.click('#tabbtn-write');
  await pop.click('#copy-btn');
  await pop.waitForFunction(() => document.querySelector('#copy-btn').textContent === '✓ Copied');
  await env.ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
});

await step('fault injection: every background failure shows a clear message and the popup stays usable', async () => {
  // Make chosen background actions fail from inside the popup, as if storage or the worker broke.
  const fail = (actions) => pop.evaluate((list) => {
    window.__origSend ||= chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, cb) => (list.includes(msg.action)
      ? setTimeout(() => cb({ success: false, error: `Injected failure: ${msg.action}` }), 0)
      : window.__origSend(msg, cb));
  }, actions);
  const heal = () => pop.evaluate(() => { if (window.__origSend) chrome.runtime.sendMessage = window.__origSend; });
  const expectToast = (re) => pop.waitForFunction((src) => new RegExp(src).test(document.querySelector("#toast").textContent), re.source, { timeout: 5000 }).catch(async () => { throw new Error(`expected toast ${re}, got "${await pop.textContent("#toast")}" / status "${await pop.textContent("#status")}"`); });

  await fail(['listContacts']);
  await pop.click('#tabbtn-write'); await pop.click('#tabbtn-tracker');
  await expectToast(/Injected failure: listContacts/);
  await heal(); await pop.click('#tabbtn-write'); await pop.click('#tabbtn-tracker'); await pop.waitForSelector('.contact');
  const card = '.contact:has(.contact-name:text-is("Priya Sharma"))';

  await fail(['setStatus']); await pop.click(`${card} >> button:has-text("Replied")`); await expectToast(/setStatus/);
  await fail(['generateFollowUp']); await pop.click(`${card} >> button:has-text("Write follow-up")`);
  await pop.waitForSelector(`${card} .followup .status-error`);
  await heal(); await pop.click(`${card} >> button:has-text("Write follow-up")`); await pop.waitForSelector(`${card} .followup-text`);
  await fail(['markFollowedUp']); await pop.click(`${card} .followup button:has-text("Mark as sent")`); await expectToast(/markFollowedUp/);
  await fail(['deleteContact']);
  await pop.click(`${card} .icon-btn.danger`); await pop.click(`${card} .icon-btn.danger`); await expectToast(/deleteContact/);
  await fail(['exportCsv']); await pop.click('#export-btn'); await expectToast(/exportCsv/);
  await fail(['clearContacts']); await pop.click('#clear-btn'); await pop.click('#clear-btn'); await expectToast(/clearContacts/);

  await heal(); await pop.click('#tabbtn-settings');
  await fail(['saveSettings']); await pop.click('#save-settings-btn');
  await pop.waitForFunction(() => /saveSettings/.test(document.querySelector('#settings-status').textContent), null, { timeout: 5000 }).catch(() => { throw new Error('wait #1 timed out'); });
  await fail(['testKey']); await pop.fill('#s-key', 'sk-ant-x'); await pop.click('#test-key-btn');
  await pop.waitForFunction(() => /testKey/.test(document.querySelector('#key-status-note').textContent), null, { timeout: 5000 }).catch(() => { throw new Error('wait #2 timed out'); });
  await pop.fill('#s-key', '');
  await heal(); await storage.msg(pop, 'saveSettings', { apiKey: 'sk-ant-has-key' });
  await pop.close(); pop = await env.popup(priya.id); await pop.click('#tabbtn-settings');
  await fail(['parseResume']);
  await pop.setInputFiles('#resume-input', { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
  await pop.waitForFunction(() => /parseResume/.test(document.querySelector('#resume-status').textContent), null, { timeout: 5000 }).catch(() => { throw new Error('wait #3 timed out'); });
  await fail(['deleteTemplate', 'saveTemplate']);
  await pop.click('#tabbtn-write');
  await fail(['generate', 'saveTemplate', 'saveSession', 'track', 'savePrefs']);
  await pop.click('#regen-btn');
  await pop.waitForFunction(() => /Injected failure: generate/.test(document.querySelector('#status').textContent), null, { timeout: 5000 }).catch(() => { throw new Error('wait #4 timed out'); });
  await pop.click('#copy-btn'); // track fails silently by design (copy still works)
  await pop.waitForFunction(() => document.querySelector('#copy-btn').textContent === '✓ Copied');
  await pop.selectOption('#tone', 'Formal'); // savePrefs fails silently by design
  await pop.click('#save-tpl-open'); await pop.fill('#tpl-name', 'X'); await pop.click('#save-tpl-form button[type=submit]');
  await expectToast(/saveTemplate/);
  await heal();
  await storage.msg(pop, 'saveSettings', { clearKey: true });
  await pop.close(); pop = await env.popup(priya.id);
  assert.equal(await pop.isDisabled('#read-btn'), false, 'popup fully usable afterwards');
});

await step('worker unreachable at boot → popup explains instead of showing a blank screen', async () => {
  const p = await env.ctx.newPage();
  await p.addInitScript(() => {
    const realChrome = window.chrome;
    Object.defineProperty(window, 'chrome', { get: () => ({ ...realChrome, runtime: { ...realChrome.runtime, lastError: { message: 'Could not establish connection' }, sendMessage: (m, cb) => setTimeout(() => cb(undefined), 0) } }) });
  });
  await p.goto(`chrome-extension://${env.extId}/popup/popup.html`);
  await p.waitForSelector('body.booted');
  assert.match(await p.textContent('#status'), /restarted — please reopen/);
  await p.close();
});

await step('a plain script error triggers the safety-net toast', async () => {
  await pop.evaluate(() => setTimeout(() => { throw new Error('boom'); }, 0));
  await pop.waitForFunction(() => /Something went wrong/.test(document.querySelector('#toast').textContent));
  errors.splice(errors.findIndex(e => /boom/.test(e)), 1); // expected for this step only
});

await step('no unexpected console or page errors', async () => { assert.deepEqual(errors, []); });

await pop.close();
await env.saveCoverage('ui-edges');
await env.ctx.close();
process.exit(report('e2e ui edges') ? 1 : 0);
