// router.js — Deep Mode end to end through the router with a fake OpenAI, plus the OpenAI key.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, POPUP } from './helpers/chrome-mock.mjs';
import { PRIYA } from './helpers/fixtures.mjs';

const mock = installChromeMock();
const { dispatch } = await import('../../extension/background/router.js');
const store = await import('../../extension/background/store.js');
const { OPENAI } = await import('../../extension/shared/constants.js');
const call = (action, payload = {}) => dispatch({ action, payload }, POPUP);
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

// ─── Fake OpenAI: queue of replies; each reply is {status, body} | Error | Promise ──
const ai = { queue: [], requests: [] };
const respOk = (output, extra = {}) => ({ status: 200, body: { status: 'completed', model: 'gpt-6.2-sol', output, ...extra } });
const text = (t, annotations = []) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t, annotations }] });
const err = (status, error = {}) => ({ status, body: { error } });
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, init) => {
    ai.requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    let r = ai.queue.shift() ?? respOk([text('OK')]);
    if (r instanceof Promise) r = await r;
    if (r instanceof Error) throw r;
    return { ok: r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.body };
  };
});
after(() => { globalThis.fetch = realFetch; });

const PAGE = 'Priya Sharma\nSenior PM at Razorpay | ex-Flipkart\nBengaluru, Karnataka, India\nExperience\nSenior Product Manager\nRazorpay\nProduct Manager\nFlipkart\nSkills\nGrowth Strategy';
const SCRAPED = { ...PRIYA, currentTitle: 'Bengaluru, Karnataka, India', rawText: PAGE, diagnostics: { foundCount: 5 } };
const L1 = respOk([text(JSON.stringify({ currentTitle: 'Senior Product Manager', experience: [{ title: 'Senior Product Manager', company: 'Razorpay', duration: '' }, { title: 'Product Manager', company: 'Flipkart', duration: '' }], skills: ['Growth Strategy'] }))]);
const L2 = respOk([
  { type: 'web_search_call', action: { type: 'search', query: 'Razorpay news', sources: [{ url: 'https://techcrunch.com/razorpay' }] } },
  text(JSON.stringify({
    companyNews: [{ title: 'Razorpay raises $100M', summary: 'Funding.', hook: "Razorpay's new funding round", url: 'https://techcrunch.com/razorpay', date: '2026-05' }],
    publicWork: [{ title: 'Checkout for trust', summary: 'Talk.', hook: 'your checkout talk at JSConf', url: 'https://jsconf.example/talks/priya', date: '2025', kind: 'talk' }]
  }), [{ type: 'url_citation', url: 'https://jsconf.example/talks/priya', title: 'JSConf' }])
]);

beforeEach(async () => {
  await chrome.storage.local.clear(); await chrome.storage.session.clear(); await store.init();
  ai.queue = []; ai.requests = [];
  mock.tabsState.tabs = new Map([[7, { id: 7, url: 'https://www.linkedin.com/in/priya-sharma/' }]]);
  mock.tabsState.onSend = async () => ({ success: true, data: structuredClone(SCRAPED) });
});

const withKey = () => store.saveSettings({ openaiKey: 'sk-proj-abcdefghijklmnop1234', openaiModel: 'gpt-6.2-sol' });

test('Deep Mode needs an OpenAI key and sends nothing without it', async () => {
  const r = await call('deepParse', { tabId: 7 });
  assert.equal(r.success, false);
  assert.equal(r.code, 'no_openai_key');
  assert.equal(ai.requests.length, 0);
});

test('full run: L1 fixes the profile, L2 starts at once, enrich returns research hooks', async () => {
  await withKey();
  ai.queue.push(L1, L2);
  const p = await call('deepParse', { tabId: 7 });
  assert.ok(p.success, p.error);
  assert.equal(p.data.l1.status, 'done');
  assert.equal(p.data.l1.model, 'gpt-6.2-sol');
  assert.ok(p.data.l1.filled.includes('role'));
  assert.equal(p.data.profile.currentTitle, 'Senior Product Manager', 'a place is no longer the title');
  assert.deepEqual(p.data.profile.skills.slice(0, 1), ['Growth Strategy']);
  assert.equal(p.data.l2.status, 'running');
  assert.equal(p.data.diagnostics.foundCount, 8, 'read check reflects the merged profile');
  assert.ok(!('rawText' in p.data.profile), 'page text never goes back to the UI');

  // L1 request: strict schema, page text, auth, no data retention.
  const l1req = ai.requests[0];
  assert.equal(l1req.url, OPENAI.URL);
  assert.equal(l1req.headers.authorization, 'Bearer sk-proj-abcdefghijklmnop1234');
  assert.equal(l1req.body.text.format.type, 'json_schema');
  assert.equal(l1req.body.store, false);
  assert.match(l1req.body.input, /PAGE TEXT:\nPriya Sharma/);

  const e = await call('deepEnrich', { profileUrl: p.data.profile.profileUrl });
  assert.ok(e.success, e.error);
  assert.deepEqual({ status: e.data.l2.status, news: e.data.l2.news, work: e.data.l2.work }, { status: 'done', news: 1, work: 1 });
  const l2req = ai.requests[1];
  assert.deepEqual(l2req.body.tools, [{ type: 'web_search', search_context_size: 'medium' }]);
  assert.equal(l2req.body.tool_choice, 'required');
  assert.match(l2req.body.input, /Person: Priya Sharma/);
  const kinds = e.data.hooks.map(h => h.kind);
  assert.ok(kinds.includes('work') && kinds.includes('news'));
  assert.ok(e.data.hooks.find(h => h.kind === 'work').selected, 'their own work is picked by default');
  assert.equal(e.data.research.publicWork[0].url, 'https://jsconf.example/talks/priya');

  // The popup can close: status is restored from the session cache, and enrich doesn't search again.
  const st = await call('deepStatus', { url: 'https://www.linkedin.com/in/priya-sharma/?x=1' });
  assert.equal(st.data.deep.l1.status, 'done');
  assert.equal(st.data.deep.l2.status, 'done');
  assert.equal(st.data.deep.research.companyNews.length, 1);
  const again = await call('deepEnrich', { profileUrl: p.data.profile.profileUrl });
  assert.equal(again.data.l2.status, 'done');
  assert.equal(ai.requests.length, 2, 'cached — no new search');

  // L3: the normal writer uses the research hooks.
  const gen = await call('generate', { profile: p.data.profile, hooks: e.data.hooks, messageType: 'Networking', tone: 'Neutral', format: 'note' });
  assert.match(gen.data.message, /enjoyed your checkout talk at JSConf/);
});

test('research keeps running after the popup closes (no enrich call needed)', async () => {
  await withKey();
  ai.queue.push(L1, L2);
  await call('deepParse', { tabId: 7 });
  for (let i = 0; i < 50 && (await call('deepStatus', { url: PRIYA.profileUrl })).data.deep.l2.status === 'running'; i++) await tick();
  assert.equal((await call('deepStatus', { url: PRIYA.profileUrl })).data.deep.l2.status, 'done');
});

test('L1 failure is not fatal: the page reader profile is used and L2 still runs', async () => {
  await withKey();
  ai.queue.push(err(400, { message: 'Invalid schema' }), L2);
  const p = await call('deepParse', { tabId: 7 });
  assert.ok(p.success);
  assert.equal(p.data.l1.status, 'failed');
  assert.match(p.data.l1.note, /Invalid schema/);
  assert.equal(p.data.profile.currentTitle, 'Bengaluru, Karnataka, India', 'unchanged reader data');
  assert.equal(p.data.l2.status, 'running');
  assert.equal((await call('deepEnrich', { profileUrl: PRIYA.profileUrl })).data.l2.status, 'done');
});

test('a rejected key stops after L1 (L2 skipped, no second charge)', async () => {
  await withKey();
  ai.queue.push(err(401));
  const p = await call('deepParse', { tabId: 7 });
  assert.equal(p.data.l1.status, 'failed');
  assert.equal(p.data.l2.status, 'skipped');
  assert.match(p.data.l2.note, /rejected/);
  const e = await call('deepEnrich', { profileUrl: PRIYA.profileUrl });
  assert.equal(e.data.l2.status, 'skipped');
  assert.equal(ai.requests.length, 1);
  assert.equal((await call('deepStatus', { url: PRIYA.profileUrl })).data.deep.l2.status, 'skipped');
});

test('L2 failure is reported as it is (never searched again silently); Read + research retries', async () => {
  await withKey();
  ai.queue.push(L1, err(400, { message: 'web_search is not available for this model' }));
  await call('deepParse', { tabId: 7 });
  // The research fails before the popup asks for it (a slow machine): the same failure, no second search.
  for (let i = 0; i < 50 && (await call('deepStatus', { url: PRIYA.profileUrl })).data.deep.l2.status === 'running'; i++) await tick();
  const searches = () => ai.requests.filter(r => r.body.tools).length;
  const e = await call('deepEnrich', { profileUrl: PRIYA.profileUrl });
  assert.equal(e.data.l2.status, 'failed');
  assert.match(e.data.l2.note, /web_search is not available/);
  assert.ok(e.data.hooks.every(h => !['news', 'work'].includes(h.kind)));
  assert.equal((await call('deepEnrich', { profileUrl: PRIYA.profileUrl })).data.l2.status, 'failed');
  assert.equal(searches(), 1, 'asking again never triggers another paid search');
  ai.queue.push(L1, L2);
  await call('deepParse', { tabId: 7 });
  const retry = await call('deepEnrich', { profileUrl: PRIYA.profileUrl });
  assert.equal(retry.data.l2.status, 'done');
  assert.equal(searches(), 2);
  // Unreadable research text is a failure, not a crash.
  ai.queue.push(L1, respOk([text('I could not find anything useful.')]));
  await call('deepParse', { tabId: 7 });
  assert.match((await call('deepEnrich', { profileUrl: PRIYA.profileUrl })).data.l2.note, /unreadable/);
});

test('one research run per profile at a time; an interrupted run is reported and restarted', async () => {
  await withKey();
  let release;
  ai.queue.push(L1, new Promise(r => { release = () => r(L2); }));
  await call('deepParse', { tabId: 7 });
  await tick();
  ai.queue.unshift(L1);
  const second = await call('deepParse', { tabId: 7 }); // re-run while L2 is still searching
  assert.equal(second.data.l2.status, 'running');
  const enrich = call('deepEnrich', { profileUrl: PRIYA.profileUrl });
  release();
  assert.equal((await enrich).data.l2.status, 'done');
  assert.equal(ai.requests.filter(r => r.body.tools).length, 1, 'only one web search');

  // Simulate a worker restart mid-run: cache says running, nothing in flight.
  await store.saveDeep('in:priya-sharma', { l2: { status: 'running' } });
  const st = await call('deepStatus', { url: PRIYA.profileUrl });
  assert.equal(st.data.deep.l2.status, 'failed');
  assert.match(st.data.deep.l2.note, /interrupted/);
  ai.queue.push(L2);
  assert.equal((await call('deepEnrich', { profileUrl: PRIYA.profileUrl })).data.l2.status, 'done', 'restarted');
});

test('deep actions reject bad input clearly', async () => {
  assert.match((await call('deepEnrich', { profileUrl: 'https://evil.example' })).error, /Read \+ research/);
  assert.match((await call('deepEnrich', {})).error, /Read \+ research/);
  assert.equal((await call('deepStatus', { url: 'nope' })).data.deep, null);
  assert.equal((await call('deepStatus', { url: 'https://www.linkedin.com/in/nobody/' })).data.deep, null);
  await withKey();
  mock.tabsState.onSend = async () => ({ success: true, data: { name: '' } });
  assert.match((await call('deepParse', { tabId: 7 })).error, /Couldn't find a name/);
  mock.tabsState.onSend = async () => ({ success: true, data: { name: 'X', profileUrl: 'https://example.com/x' } });
  assert.match((await call('deepParse', { tabId: 7 })).error, /linkedin\.com\/in/);
  assert.equal(ai.requests.length, 0);
});

test('OpenAI key: format checks, live test, stored key reused, model saved, never returned', async () => {
  assert.equal((await call('testOpenAIKey', {})).data.reason, 'Enter a key first.');
  assert.match((await call('testOpenAIKey', { apiKey: 'sk-ant-api03-xxxxxxxxxxxxxxxx' })).data.reason, /Anthropic key/);
  assert.match((await call('testOpenAIKey', { apiKey: 'pk-123' })).data.reason, /start with "sk-"/);
  assert.equal(ai.requests.length, 0, 'format errors never hit the network');

  ai.queue.push(err(401));
  const bad = await call('testOpenAIKey', { apiKey: 'sk-proj-badbadbadbadbadbad', model: 'gpt-6.2-sol' });
  assert.equal(bad.data.valid, false);
  assert.match(bad.data.reason, /rejected/);
  assert.equal((await store.getSettings()).openaiKey, '', 'a failed test saves nothing');

  ai.queue.push(err(404, { message: 'The model does not exist' }));
  assert.match((await call('testOpenAIKey', { apiKey: 'sk-proj-goodgoodgoodgood1234', model: 'gpt-9' })).data.reason, /"gpt-9" isn't available/);

  ai.queue.push(respOk([text('OK')]));
  const good = await call('testOpenAIKey', { apiKey: 'sk-proj-goodgoodgoodgood1234', model: 'gpt-6.1-terra' });
  assert.equal(good.data.valid, true);
  assert.equal(good.data.settings.hasOpenAIKey, true);
  assert.equal(good.data.settings.openaiModel, 'gpt-6.1-terra');
  assert.equal(good.data.settings.openaiKeyHint, 'sk-proj…1234');
  assert.ok(!('openaiKey' in good.data.settings));
  assert.equal(ai.requests.at(-1).body.model, 'gpt-6.1-terra');

  // No key typed → tests the stored one; a cut-off tiny answer still proves the key works; bad model → default.
  ai.queue.push(respOk([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), respOk([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
  const stored = await call('testOpenAIKey', { model: 'not a model!' });
  assert.equal(stored.data.valid, true);
  assert.equal(stored.data.settings.openaiModel, OPENAI.DEFAULT_MODEL);
  assert.equal(ai.requests.at(-1).headers.authorization, 'Bearer sk-proj-goodgoodgoodgood1234');

  // Network failure: a clear reason, not a crash.
  ai.queue.push(new TypeError('Failed to fetch'), new TypeError('Failed to fetch'), new TypeError('Failed to fetch'));
  assert.match((await call('testOpenAIKey', {})).data.reason, /Network error reaching OpenAI/);
});

test('settings: OpenAI key kept unless replaced or cleared; state exposes only hints', async () => {
  const r = await call('saveSettings', { openaiKey: 'sk-proj-abcdefghijklmnop9999', openaiModel: 'gpt-6-luna' });
  assert.equal(r.data.settings.hasOpenAIKey, true);
  assert.equal(r.data.settings.openaiModel, 'gpt-6-luna');
  assert.equal((await call('saveSettings', { openaiKey: '  ' })).data.settings.hasOpenAIKey, true);
  const state = await call('getState');
  assert.equal(state.data.settings.hasOpenAIKey, true);
  assert.ok(!JSON.stringify(state.data).includes('abcdefghijklmnop'), 'the key never reaches the UI');
  assert.equal((await call('saveSettings', { clearOpenAIKey: true })).data.settings.hasOpenAIKey, false);
  assert.equal((await call('saveSettings', { openaiModel: '../../etc' })).data.settings.openaiModel, OPENAI.DEFAULT_MODEL);
});
