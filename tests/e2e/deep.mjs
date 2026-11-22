// Deep Mode + resume e2e: the real popup in Chromium, LinkedIn routed to mocks, a fake OpenAI and Anthropic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launch, steps, ROOT } from './harness.mjs';

const env = await launch();
const { oa, api, storage, errors } = env;
const { step, report } = steps();
const AXE = readFileSync(path.join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8');

const priya = await env.tab('https://www.linkedin.com/in/priya-sharma/');
let pop = await env.popup(priya.id);
const reopen = async () => { await pop.close(); pop = await env.popup(priya.id); };
const layer = async (n) => ({ state: await pop.getAttribute(`#layer-${n}`, 'data-state'), desc: await pop.textContent(`#${n}-desc`) });
const waitLayer = (n, state, timeout = 10000) => pop.waitForFunction(([id, s]) => document.getElementById(`layer-${id}`).dataset.state === s, [n, state], { timeout })
  .catch(async () => { throw new Error(`L${n.slice(1)} never reached "${state}" — now ${JSON.stringify(await layer(n))}, status "${await pop.textContent('#status')}"`); });

const ok = (output, extra = {}) => ({ status: 200, body: { status: 'completed', model: 'gpt-6.2-sol', output, ...extra } });
const text = (t, annotations = []) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t, annotations }] });
const L1 = (delay = 0) => ({ ...ok([text(JSON.stringify({
  headline: 'Senior PM at Razorpay | ex-Flipkart', location: 'Bengaluru, Karnataka, India',
  experience: [{ title: 'Senior Product Manager', company: 'Razorpay', duration: '' }, { title: 'Product Manager', company: 'Flipkart', duration: '' }],
  education: [{ school: 'IIT Bombay', detail: 'B.Tech, Computer Science' }], skills: ['Payments'], recentPosts: []
}))]), delay });
const L2 = (delay = 0) => ({ ...ok([
  { type: 'web_search_call', action: { type: 'search', sources: [{ url: 'https://techcrunch.com/2026/05/razorpay-raises' }] } },
  text(JSON.stringify({
    companyNews: [{ title: 'Razorpay raises $100M Series F', summary: 'New funding to expand into SE Asia.', hook: "Razorpay's Series F news", url: 'https://techcrunch.com/2026/05/razorpay-raises', date: '2026-05' }],
    publicWork: [{ title: 'Designing checkout for trust', summary: 'Conference talk.', hook: 'your checkout-for-trust talk at JSConf India', url: 'https://jsconf.in/talks/priya-sharma', date: '2025', kind: 'talk' }]
  }), [{ type: 'url_citation', url: 'https://jsconf.in/talks/priya-sharma', title: 'JSConf India' }])
]), delay });
const ERR = (status, message = 'error', param) => ({ status, body: { error: { message, ...(param ? { param } : {}) } } });

async function a11y(page, label) {
  await page.evaluate(AXE);
  const res = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'], runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] }));
  const serious = res.violations.filter(v => ['serious', 'critical'].includes(v.impact));
  assert.deepEqual(serious.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(' | ')}`), [], `${label} accessibility`);
}

await step('Deep toggle: needs an OpenAI key first; choice is remembered', async () => {
  assert.equal(await pop.isVisible('#deep-panel'), false, 'Quick is the default');
  await pop.click('.seg[data-mode="deep"]');
  assert.ok(await pop.isVisible('#deep-panel'));
  assert.equal(await pop.isVisible('#read-btn'), false);
  assert.ok(await pop.isVisible('#deep-needs-key'));
  assert.ok(await pop.isDisabled('#enrich-btn'));
  assert.ok(await pop.isDisabled('#deep-gen-btn'));
  assert.equal(await pop.textContent('#l1-state'), 'Ready');
  await pop.waitForTimeout(250);
  await reopen();
  assert.ok(await pop.isVisible('#deep-panel'), 'mode persisted');
  assert.equal((await storage.get('prefs')).prefs.mode, 'deep');
});

await step('Settings: OpenAI key format check, rejected key, then Test & save with a model', async () => {
  await pop.click('#deep-needs-key button[data-goto="settings"]');
  assert.equal(await pop.inputValue('#s-openai-model'), 'gpt-6.2-sol');
  assert.match(await pop.textContent('#openai-key-hint'), /Deep Mode is off/);
  await pop.fill('#s-openai-key', 'sk-ant-not-openai-1234567890');
  await pop.click('#save-settings-btn');
  await pop.waitForSelector('#settings-status.status-error');
  assert.match(await pop.textContent('#settings-status'), /OpenAI key/);
  await pop.fill('#s-openai-model', 'bad model!');
  await pop.click('#test-openai-btn');
  await pop.waitForSelector('#openai-status-note.err');
  assert.match(await pop.textContent('#openai-status-note'), /model name/);
  await pop.fill('#s-openai-model', 'gpt-6.2-sol');
  const before = oa.requests.length;
  oa.queue.push(ERR(401, 'Incorrect API key provided'));
  await pop.fill('#s-openai-key', 'sk-proj-wrongwrongwrongwrong');
  await pop.click('#test-openai-btn');
  await pop.waitForFunction(() => /rejected/.test(document.getElementById('openai-status-note').textContent));
  assert.equal(oa.requests.length, before + 1);
  oa.queue.push(ok([text('OK')]));
  await pop.fill('#s-openai-key', 'sk-proj-rightrightright1234');
  await pop.press('#s-openai-key', 'Enter');
  await pop.waitForSelector('#openai-status-note.ok');
  assert.match(await pop.textContent('#openai-key-hint'), /sk-proj…1234/);
  assert.ok(await pop.isVisible('#remove-openai-btn'));
  assert.equal(oa.requests.at(-1).auth, 'Bearer sk-proj-rightrightright1234');
  assert.equal(oa.requests.at(-1).body.model, 'gpt-6.2-sol');
  const all = JSON.stringify(await pop.evaluate(() => document.body.innerText));
  assert.ok(!all.includes('rightrightright'), 'the key is never shown back');
});

await step('Deep run: L1 → L2 (sources) → L3 draft, each layer showing real progress', async () => {
  await pop.click('#tabbtn-write');
  assert.equal(await pop.isVisible('#deep-needs-key'), false);
  assert.match(await pop.textContent('#deep-model'), /gpt-6\.2-sol/);
  const before = oa.requests.length;
  oa.queue.push(L1(700), L2(900));
  await pop.click('#enrich-btn');
  await waitLayer('l1', 'running');
  assert.ok(await pop.isDisabled('#enrich-btn'), 'no double runs');
  await waitLayer('l1', 'done');
  await waitLayer('l2', 'running');
  assert.match((await layer('l2')).desc, /Searching the web/);
  await waitLayer('l2', 'done');
  await waitLayer('l3', 'done');
  assert.match((await layer('l1')).desc, /Checked against the page/);
  assert.match((await layer('l2')).desc, /1 news item and 1 piece of their own work/);
  assert.match((await layer('l3')).desc, /Draft ready · Built-in writer/);
  const links = await pop.$$eval('#source-list a', as => as.map(a => ({ href: a.href, target: a.target, rel: a.rel, text: a.textContent })));
  assert.deepEqual(links.map(l => l.href), ['https://jsconf.in/talks/priya-sharma', 'https://techcrunch.com/2026/05/razorpay-raises']);
  assert.ok(links.every(l => l.target === '_blank' && /noopener/.test(l.rel)));
  const chips = await pop.$$eval('#hook-list .chip', cs => cs.map(c => ({ t: c.textContent, on: c.classList.contains('selected') })));
  assert.ok(chips.some(c => /Their talk: "Designing checkout for trust"/.test(c.t) && c.on), 'their talk is picked');
  assert.ok(chips.some(c => /News: Razorpay raises/.test(c.t)));
  assert.match(await pop.inputValue('#draft-text'), /enjoyed your checkout-for-trust talk at JSConf India/);
  assert.match(await pop.textContent('#read-pill'), /8\/8/);
  assert.equal(await pop.textContent('#enrich-label'), 'Re-run L1 + L2');

  const [l1req, l2req] = oa.requests.slice(before);
  assert.equal(l1req.body.text.format.type, 'json_schema');
  assert.match(l1req.body.input, /PAGE TEXT:\n[\s\S]*Priya Sharma[\s\S]*Senior Product Manager/);
  assert.doesNotMatch(l1req.body.input, /Add a note/, 'only the profile sections are sent');
  assert.equal(l2req.body.tools[0].type, 'web_search');
  assert.equal(l2req.body.store, false);
  assert.equal(oa.requests.length, before + 2);

  // L3 again on demand, and "New version" works as in Quick mode.
  const first = await pop.inputValue('#draft-text');
  await pop.click('#regen-btn');
  await pop.waitForFunction((t) => document.getElementById('draft-text').value !== t, first);
  await pop.click('#deep-gen-btn');
  await waitLayer('l3', 'done');
});

await step('Popup closed mid-research → reopened with the finished research', async () => {
  oa.queue.push(L1(), L2(2500));
  await pop.click('#enrich-btn');
  await waitLayer('l2', 'running');
  await pop.close();
  await new Promise(r => setTimeout(r, 3200));
  pop = await env.popup(priya.id);
  await waitLayer('l2', 'done');
  assert.equal((await layer('l1')).state, 'done');
  assert.equal(await pop.$$eval('#source-list a', as => as.length), 2);
  assert.ok(await pop.$$eval('#hook-list .chip', cs => cs.some(c => /Their talk/.test(c.textContent))), 'research hooks restored');
  // Reopen while research is still running: it waits for the same run, no second search.
  const searches = () => oa.requests.filter(r => r.body.tools).length;
  const n = searches();
  oa.queue.push(L1(), L2(2000));
  await pop.click('#enrich-btn');
  await waitLayer('l2', 'running');
  await reopen();
  await waitLayer('l2', 'done');
  assert.equal(searches(), n + 1);
});

await step('L1 fails → page reader data is used and L2 still runs; L2 fails → still drafts', async () => {
  oa.queue.push(ERR(400, 'Invalid schema for response_format'), L2());
  await pop.click('#enrich-btn');
  await waitLayer('l1', 'failed');
  assert.match((await layer('l1')).desc, /Used the page reader instead — OpenAI: Invalid schema/);
  await waitLayer('l2', 'done');
  await waitLayer('l3', 'done');

  oa.queue.push(L1(), ERR(400, 'web_search is not supported with this model'));
  await pop.click('#enrich-btn');
  await waitLayer('l2', 'failed');
  assert.match((await layer('l2')).desc, /web_search is not supported/);
  await waitLayer('l3', 'done');
  assert.equal(await pop.isVisible('#deep-sources'), false);
  assert.ok((await pop.inputValue('#draft-text')).length > 20);

  oa.queue.push(L1(), ok([text('Sorry, I found nothing.')]));
  await pop.click('#enrich-btn');
  await waitLayer('l2', 'failed');
  assert.match((await layer('l2')).desc, /unreadable/);

  oa.queue.push(L1(), ok([{ type: 'web_search_call', action: { type: 'search' } }, text('{"companyNews":[],"publicWork":[]}')]));
  await pop.click('#enrich-btn');
  await waitLayer('l2', 'done');
  assert.match((await layer('l2')).desc, /Nothing reliable found/);
});

await step('Rejected key / no credit → L2 skipped (no second charge), draft still written', async () => {
  const before = oa.requests.length;
  oa.queue.push({ status: 429, body: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } } });
  await pop.click('#enrich-btn');
  await waitLayer('l2', 'skipped');
  assert.match((await layer('l1')).desc, /no credit left/);
  assert.match((await layer('l2')).desc, /no credit left/);
  await waitLayer('l3', 'done');
  assert.equal(oa.requests.length, before + 1);
});

await step('L3 with the AI writer: the prompt carries the research hooks; a failure is shown on L3', async () => {
  await storage.msg(pop, 'saveSettings', { apiKey: 'sk-ant-deep-test-1234' });
  await reopen();
  assert.match(await pop.textContent('#key-status'), /AI · your key/);
  oa.queue.push(L1(), L2());
  api.queue.push({ status: 200, text: 'Hi Priya, I enjoyed your checkout-for-trust talk at JSConf India. Would love to connect.' });
  await pop.click('#enrich-btn');
  await waitLayer('l3', 'done');
  assert.match((await layer('l3')).desc, /AI writer, with your Anthropic key/);
  assert.match(api.requests.at(-1).messages[0].content, /from public web sources; phrase it as "I enjoyed your checkout-for-trust talk at JSConf India"/);
  api.queue.push({ status: 401, msg: 'bad key' });
  await pop.click('#deep-gen-btn');
  await waitLayer('l3', 'failed');
  assert.match((await layer('l3')).desc, /rejected/);
  await storage.msg(pop, 'saveSettings', { clearKey: true });
  await reopen();
});

await step('Custom detail survives research; switching back to Quick works as before', async () => {
  await pop.fill('#custom-hook', 'We met at the Pune product meetup');
  await pop.click('#custom-hook-form button[type=submit]');
  await pop.waitForFunction(() => /Pune product meetup/.test(document.getElementById('draft-text').value));
  oa.queue.push(L1(), L2());
  await pop.click('#enrich-btn');
  await waitLayer('l3', 'done');
  const chips = await pop.$$eval('#hook-list .chip', cs => cs.map(c => ({ t: c.textContent, on: c.classList.contains('selected') })));
  assert.ok(chips.some(c => /Pune product meetup/.test(c.t) && c.on), 'your own detail stays picked');
  assert.equal(chips.filter(c => c.on).length, 2);

  await pop.click('.seg[data-mode="quick"]');
  assert.ok(await pop.isVisible('#read-btn'));
  assert.equal(await pop.isVisible('#deep-panel'), false);
  const before = oa.requests.length;
  await pop.click('#read-btn');
  await pop.waitForFunction(() => document.getElementById('read-btn').getAttribute('aria-busy') === 'false');
  assert.equal(oa.requests.length, before, 'Quick mode never calls OpenAI');
  await pop.click('.seg[data-mode="deep"]');
});

await step('accessibility (axe): Deep panel and Settings, light and dark', async () => {
  await a11y(pop, 'deep panel light');
  await pop.click('#tabbtn-settings'); await pop.waitForTimeout(150);
  await a11y(pop, 'settings light');
  await storage.msg(pop, 'saveSettings', { theme: 'dark' });
  await reopen(); await pop.waitForTimeout(250);
  await a11y(pop, 'deep panel dark');
  await pop.click('#tabbtn-settings'); await pop.waitForTimeout(250);
  await a11y(pop, 'settings dark');
  await storage.msg(pop, 'saveSettings', { theme: 'system' });
  await reopen();
});

await step('Remove the OpenAI key → Deep Mode asks for it again', async () => {
  await pop.click('#tabbtn-settings');
  await pop.click('#remove-openai-btn');
  await pop.waitForFunction(() => /Deep Mode is off/.test(document.getElementById('openai-key-hint').textContent));
  assert.equal((await storage.get('settings')).settings.openaiKey, '');
  await pop.click('#tabbtn-write');
  assert.ok(await pop.isVisible('#deep-needs-key'));
  assert.ok(await pop.isDisabled('#enrich-btn'));
});

await step('Resume: saved without any key, shown with size, downloads the same bytes, two-click remove', async () => {
  await pop.click('#tabbtn-settings');
  assert.equal(await pop.isVisible('#resume-saved'), false);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const before = api.requests.length;
  await pop.setInputFiles('#resume-input', { name: 'arjun-cv.pdf', mimeType: 'application/pdf', buffer: pdf });
  await pop.waitForSelector('#resume-status.ok');
  assert.match(await pop.textContent('#resume-status'), /Saved on this device/);
  assert.equal(api.requests.length, before, 'nothing sent without a key');
  assert.match(await pop.textContent('#resume-saved-name'), /arjun-cv\.pdf · 1 KB/);
  const stored = (await storage.get('resume')).resume;
  assert.equal(Buffer.from(stored.base64, 'base64').toString(), pdf.toString(), 'exact bytes kept');

  const [dl] = await Promise.all([pop.waitForEvent('download'), pop.click('#resume-download-btn')]);
  assert.equal(dl.suggestedFilename(), 'arjun-cv.pdf');
  const file = await dl.path();
  assert.equal(readFileSync(file).toString(), pdf.toString());

  await reopen(); await pop.click('#tabbtn-settings');
  assert.match(await pop.textContent('#resume-saved-name'), /arjun-cv\.pdf/, 'still there after reopening');
  await pop.click('#resume-remove-btn');
  assert.equal(await pop.textContent('#resume-remove-btn'), 'Click again to remove');
  assert.ok((await storage.get('resume')).resume, 'first click only arms');
  await pop.click('#resume-remove-btn');
  await pop.waitForFunction(() => document.getElementById('resume-saved').classList.contains('hidden'));
  assert.equal((await storage.get('resume')).resume, undefined);
});

await step('Resume: a fake PDF is rejected; with a key it also fills in your background', async () => {
  await pop.setInputFiles('#resume-input', { name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not really a pdf') });
  await pop.waitForSelector('#resume-status.err');
  assert.match(await pop.textContent('#resume-status'), /valid PDF/);
  await storage.msg(pop, 'saveSettings', { apiKey: 'sk-ant-resume-1234', background: '' });
  await reopen(); await pop.click('#tabbtn-settings');
  api.queue.push({ status: 200, text: '{"summary":"I build AI tools","companies":["Swiggy"],"schools":["IIT Delhi"],"skills":["React"],"location":"Pune, India"}' });
  await pop.setInputFiles('#resume-input', { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 real') });
  await pop.waitForFunction(() => /Saved, and added 1 companies/.test(document.getElementById('resume-status').textContent));
  assert.equal(await pop.inputValue('#s-background'), 'Swiggy, IIT Delhi, React, Pune');
  assert.ok((await storage.get('resume')).resume.base64.startsWith('JVBER'), 'PDF kept as well');
  api.queue.push({ status: 200, text: 'cannot read' });
  await pop.setInputFiles('#resume-input', { name: 'cv2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 two') });
  // "Saving and reading…" also uses the pending style, so wait for the final message itself.
  await pop.waitForFunction(() => /Saved\. Couldn't fill in your background/.test(document.getElementById('resume-status').textContent));
  assert.match(await pop.textContent('#resume-saved-name'), /cv2\.pdf/);
});

await step('Settings save keeps the OpenAI model and a pasted key', async () => {
  await pop.fill('#s-openai-key', 'sk-proj-pastedpastedpasted99');
  await pop.fill('#s-openai-model', 'gpt-6.1-terra');
  await pop.click('#save-settings-btn');
  await pop.waitForSelector('#settings-status.status-success');
  const s = (await storage.get('settings')).settings;
  assert.equal(s.openaiModel, 'gpt-6.1-terra');
  assert.equal(s.openaiKey, 'sk-proj-pastedpastedpasted99');
  await pop.fill('#s-openai-model', 'not ok!');
  await pop.click('#save-settings-btn');
  await pop.waitForSelector('#settings-status.status-error');
});

await step('every Deep Mode / resume failure from the background shows a clear message', async () => {
  const fail = (actions) => pop.evaluate((list) => {
    window.__origSend ||= chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, cb) => (list.includes(msg.action) ? setTimeout(() => cb({ success: false, error: `Injected failure: ${msg.action}` }), 0) : window.__origSend(msg, cb));
  }, actions);
  const heal = () => pop.evaluate(() => { if (window.__origSend) chrome.runtime.sendMessage = window.__origSend; });
  const toastIs = (re) => pop.waitForFunction((src) => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout: 5000 });

  await pop.fill('#s-openai-model', 'gpt-6.2-sol');
  await fail(['testOpenAIKey']); await pop.click('#test-openai-btn');
  await pop.waitForFunction(() => /Injected failure: testOpenAIKey/.test(document.getElementById('openai-status-note').textContent));
  await fail(['getResume']); await pop.click('#resume-download-btn'); await toastIs(/getResume/);
  await heal();
  await reopen(); await pop.click('#tabbtn-settings');
  await storage.msg(pop, 'parseResume', { base64: 'JVBERg==', fileName: 'x.pdf' });
  await reopen(); await pop.click('#tabbtn-settings');
  await fail(['deleteResume']); await pop.click('#resume-remove-btn'); await pop.click('#resume-remove-btn'); await toastIs(/deleteResume/);
  await heal(); await storage.msg(pop, 'deleteResume');
  await reopen(); await pop.click('#tabbtn-settings');
  await pop.evaluate(() => { document.getElementById('resume-saved').classList.remove('hidden'); });
  await pop.click('#resume-download-btn'); await toastIs(/No resume saved/);

  await pop.click('#tabbtn-write');
  await fail(['deepParse']); await pop.click('#enrich-btn');
  await waitLayer('l1', 'failed');
  assert.match(await pop.textContent('#status'), /Injected failure: deepParse/);
  await heal(); await fail(['deepEnrich']);
  oa.queue.push(L1(), L2());
  await pop.click('#enrich-btn');
  await waitLayer('l2', 'failed');
  assert.match((await layer('l2')).desc, /Injected failure: deepEnrich/);
  await waitLayer('l3', 'done');
  await heal(); await fail(['deepStatus']); await reopen(); // restoring is best-effort
  assert.ok(await pop.isVisible('#deep-panel'));
  await heal();
  await pop.waitForTimeout(3000); // let the background research from above finish before closing
});

await step('no console or page errors', async () => { assert.deepEqual(errors, []); });

await pop.close();
await env.saveCoverage('deep');
await env.ctx.close();
process.exit(report('e2e deep mode') ? 1 : 0);
