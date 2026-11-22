// background/deep.js — Deep Mode L1 (parser) and L2 (web research): evidence guards, parsing, fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.mjs';
import { PRIYA } from './helpers/fixtures.mjs';
import {
  keepAlive, appearsIn, mergeParsed, parseProfile, researchPrompt, safeUrl, parseResearch,
  researchProfile, researchHooks, diagnosticsFor, PROFILE_SCHEMA
} from '../../extension/background/deep.js';
import { normalizeProfile } from '../../extension/background/hooks.js';
import { ApiError } from '../../extension/background/anthropic.js';
import { norm } from '../../extension/shared/text.js';

installChromeMock();
const scraped = normalizeProfile(PRIYA);
const PAGE = `Priya Sharma
Senior PM at Razorpay | ex-Flipkart
Bengaluru, Karnataka, India · Contact info
About
I build payments products that small businesses actually enjoy using. Previously led checkout at Flipkart.
Experience
Senior Product Manager
Razorpay · Full-time
Product Manager
Flipkart
Analyst
Deloitte
Education
IIT Bombay
B.Tech, Computer Science
Skills
Product Management · Payments · SQL · Growth Strategy
Activity
Why most onboarding flows fail: they ask for everything up front instead of earning trust step by step`;

test('keepAlive pings the worker while waiting and stops afterwards', async () => {
  let pings = 0;
  chrome.runtime.getPlatformInfo = (cb) => { pings += 1; cb(); };
  const v = await keepAlive(new Promise(r => setTimeout(() => r('done'), 30)), 5);
  assert.equal(v, 'done');
  const after = pings;
  assert.ok(after >= 2, `pinged ${after} times`);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(pings, after, 'no pings after settling');
  // A throwing ping never breaks the request; rejections pass through.
  chrome.runtime.getPlatformInfo = () => { throw new Error('gone'); };
  await assert.rejects(keepAlive(new Promise((_, rej) => setTimeout(() => rej(new Error('boom')), 15)), 3), /boom/);
  delete chrome.runtime.getPlatformInfo;
  assert.equal(await keepAlive(Promise.resolve(1), 1), 1);
});

test('appearsIn ignores case, accents and punctuation; prefix mode for long text', () => {
  const hay = norm('Zürich, Switzerland · Head of Product @ Acme');
  assert.ok(appearsIn('zurich switzerland', hay));
  assert.ok(appearsIn('Head of Product', hay));
  assert.ok(!appearsIn('Berlin', hay));
  assert.ok(!appearsIn('', hay));
  assert.ok(!appearsIn('...', hay));
  assert.ok(appearsIn('Head of Product @ Acme, and then lots of words not on the page', hay, 20));
});

test('mergeParsed: fixes what the page backs up, rejects anything invented', () => {
  const broken = { ...scraped, currentTitle: 'Bengaluru, Karnataka, India', pastCompanies: ['Member Board'], skills: ['SQL'], location: '' };
  const parsed = {
    name: 'Priya Sharma', headline: 'Senior PM at Razorpay | ex-Flipkart', location: 'Bengaluru, Karnataka, India',
    currentTitle: 'Senior Product Manager', currentCompany: 'Razorpay',
    about: 'I build payments products that small businesses actually enjoy using. Previously led checkout at Flipkart.',
    experience: [
      { title: 'Senior Product Manager', company: 'Razorpay', duration: '' },
      { title: 'Product Manager', company: 'Flipkart', duration: '' },
      { title: 'Analyst', company: 'Deloitte', duration: '' },
      { title: 'CEO', company: 'Google', duration: '' } // invented
    ],
    education: [{ school: 'IIT Bombay', detail: 'B.Tech, Computer Science' }, { school: 'Stanford', detail: '' }], // Stanford invented
    skills: ['Growth Strategy', 'Kubernetes'], // Kubernetes invented
    recentPosts: ['Why most onboarding flows fail: they ask for everything up front instead of earning trust', 'A post that is not on the page at all, made up']
  };
  const { profile, filled } = mergeParsed(broken, parsed, PAGE);
  assert.equal(profile.currentTitle, 'Senior Product Manager', 'a place is no longer the job title');
  assert.equal(profile.currentCompany, 'Razorpay');
  assert.deepEqual(profile.pastCompanies, ['Flipkart', 'Deloitte'], 'Google never appears on the page');
  assert.equal(profile.location, 'Bengaluru, Karnataka, India');
  assert.deepEqual(profile.educationEntries, [{ school: 'IIT Bombay', detail: 'B.Tech, Computer Science' }]);
  assert.deepEqual(profile.skills, ['Growth Strategy', 'SQL'], 'invented skill dropped, page skill kept');
  assert.equal(profile.recentPosts.length, 1);
  assert.equal(profile.profileUrl, scraped.profileUrl);
  assert.ok(filled.includes('role') && filled.includes('location') && filled.includes('past companies') && filled.includes('skills'));
  assert.ok(!filled.includes('headline'), 'unchanged fields are not reported');
});

test('mergeParsed: nothing usable → the page reader wins; a missing name is filled from the page', () => {
  const { profile, filled } = mergeParsed(scraped, { name: 'Somebody Else', headline: 'Invented', experience: 'nope', education: null, skills: [1, 2], recentPosts: ['short'] }, PAGE);
  assert.deepEqual({ ...profile }, { ...scraped });
  assert.deepEqual(filled, []);
  const nameless = mergeParsed({ ...scraped, name: '' }, { name: 'Priya Sharma', experience: [{ title: 'Product Manager', company: 'Flipkart' }] }, PAGE);
  assert.equal(nameless.profile.name, 'Priya Sharma');
  assert.equal(nameless.profile.firstName, 'Priya');
  assert.equal(nameless.profile.currentCompany, 'Flipkart');
  assert.deepEqual(nameless.profile.pastCompanies, [], 'one job: no past companies');
  // Without page text the reader's own values still count as evidence.
  assert.equal(mergeParsed(scraped, { location: 'Bengaluru, Karnataka, India' }, '').profile.location, 'Bengaluru, Karnataka, India');
  assert.equal(mergeParsed({ ...scraped, name: '' }, { name: 'Invented Person' }, '').profile.name, '');
  // The current company never shows up again as a past company.
  const again = mergeParsed(scraped, { experience: [{ title: 'Senior Product Manager', company: 'Razorpay' }, { title: 'PM', company: 'Razorpay' }] }, `${PAGE}\nPM`);
  assert.deepEqual(again.profile.pastCompanies, []);
});

test('parseProfile: sends a strict schema and the page text; unreadable output throws', async () => {
  const sent = [];
  const client = { respond: async (key, req) => { sent.push(req); return { text: JSON.stringify({ skills: ['Growth Strategy'] }), model: 'gpt-x' }; } };
  const r = await parseProfile(client, 'sk', 'gpt-x', { scraped, rawText: PAGE });
  assert.equal(r.model, 'gpt-x');
  assert.deepEqual(r.profile.skills, ['Growth Strategy', 'Product Management', 'Payments', 'SQL']);
  assert.equal(sent[0].format.type, 'json_schema');
  assert.equal(sent[0].format.strict, true);
  assert.equal(sent[0].format.schema, PROFILE_SCHEMA);
  assert.match(sent[0].input, /PAGE TEXT:\nPriya Sharma/);
  assert.match(sent[0].instructions, /Never add facts from memory/);
  // Every object in the schema is strict (required = all keys, no extra properties).
  const walk = (s) => {
    if (s.type === 'object') { assert.equal(s.additionalProperties, false); assert.deepEqual(s.required, Object.keys(s.properties)); Object.values(s.properties).forEach(walk); }
    if (s.type === 'array') walk(s.items);
  };
  walk(PROFILE_SCHEMA);

  const noPage = { respond: async (k, req) => { sent.push(req); return { text: '{}', model: 'm' }; } };
  await parseProfile(noPage, 'sk', 'm', { scraped, rawText: undefined });
  assert.match(sent[1].input, /not available/);

  for (const text of ['not json', '[]', 'null']) {
    await assert.rejects(parseProfile({ respond: async () => ({ text, model: 'm' }) }, 'sk', 'm', { scraped, rawText: PAGE }), (e) => e instanceof ApiError && e.code === 'unreadable');
  }
});

test('researchPrompt names the company, or says there is none', () => {
  assert.match(researchPrompt(scraped), /notable news items about Razorpay/);
  assert.match(researchPrompt(scraped), /Current role: Senior Product Manager at Razorpay/);
  const p = researchPrompt({ ...scraped, currentCompany: '', currentTitle: '', headline: '', location: '' });
  assert.match(p, /none \(no current company\)/);
  assert.match(p, /Current role: —/);
});

test('safeUrl: public https only, never LinkedIn', () => {
  assert.equal(safeUrl('https://techcrunch.com/x'), 'https://techcrunch.com/x');
  for (const bad of ['http://a.com', 'javascript:alert(1)', 'https://localhost/x', 'https://www.linkedin.com/in/x', 'https://linkedin.com/posts', 'nope', 5, null, `https://a.com/${'x'.repeat(600)}`]) {
    assert.equal(safeUrl(bad), '', String(bad).slice(0, 40));
  }
});

const RESULT = {
  companyNews: [
    { title: 'Razorpay raises $100M', summary: 'Funding round.', hook: "I saw Razorpay's new funding round.", url: 'https://techcrunch.com/razorpay?utm_source=x', date: '2026-05' },
    { title: 'Made up', summary: 'x', hook: 'x', url: 'https://invented.example/news', date: 'May' },
    { title: 'LinkedIn post', hook: 'y', url: 'https://www.linkedin.com/posts/x' },
    { title: 'Duplicate', hook: 'z', url: 'https://techcrunch.com/razorpay/' },
    { title: '', hook: 'no title', url: 'https://techcrunch.com/other' }
  ],
  publicWork: [
    { title: 'Designing checkout for trust', summary: 'Talk.', hook: 'your checkout talk at JSConf', url: 'https://youtube.com/watch?v=1', date: '2025', kind: 'talk' },
    { title: 'Same host, other page', hook: 'your blog post', url: 'https://youtube.com/watch?v=2', kind: 'nonsense' }
  ]
};
const evidence = { citations: [{ url: 'https://techcrunch.com/razorpay', title: 'TechCrunch: Razorpay raises' }], sources: ['https://www.youtube.com/watch?v=1'], searched: true };

test('parseResearch keeps only well-formed items backed by the search', () => {
  const r = parseResearch({ text: '```json\n' + JSON.stringify(RESULT) + '\n```', ...evidence });
  assert.deepEqual(r.companyNews, [{ title: 'Razorpay raises $100M', summary: 'Funding round.', hook: "Razorpay's new funding round", url: 'https://techcrunch.com/razorpay?utm_source=x', date: '2026-05' }]);
  assert.equal(r.publicWork.length, 2, 'same host as a returned source is accepted');
  assert.equal(r.publicWork[0].kind, 'talk');
  assert.equal(r.publicWork[1].kind, 'other');
  assert.equal(r.publicWork[0].hook, 'your checkout talk at JSConf');
  assert.deepEqual(r.sources[0], { url: 'https://techcrunch.com/razorpay?utm_source=x', title: 'TechCrunch: Razorpay raises' });
  assert.equal(r.sources[1].title, 'Designing checkout for trust');
  assert.equal(r.searched, true);
  // Bad URL in evidence is ignored, not fatal.
  assert.equal(parseResearch({ text: JSON.stringify(RESULT), citations: [{ url: 'not a url', title: '' }, ...evidence.citations], sources: evidence.sources, searched: true }).companyNews.length, 1);
});

test('parseResearch: no evidence at all → only trusted when a search really ran; caps and junk', () => {
  const items = { companyNews: [{ title: 'A', hook: 'a', url: 'https://a.example/1' }], publicWork: [] };
  assert.equal(parseResearch({ text: JSON.stringify(items), citations: [], sources: [], searched: true }).companyNews.length, 1);
  assert.equal(parseResearch({ text: JSON.stringify(items), citations: [], sources: [], searched: false }).companyNews.length, 0);
  const many = { companyNews: Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, hook: `h${i}`, url: `https://n.example/${i}` })) };
  assert.equal(parseResearch({ text: JSON.stringify(many), citations: [], sources: [], searched: true }).companyNews.length, 3);
  assert.deepEqual(parseResearch({ text: 'Here you go: {"companyNews": "x"} thanks', citations: [], sources: [], searched: true }).companyNews, []);
  const hookless = parseResearch({ text: JSON.stringify({ publicWork: [{ title: 'My essay', url: 'https://e.example/1' }] }), citations: [], sources: [], searched: true });
  assert.equal(hookless.publicWork[0].hook, 'My essay', 'falls back to the title');
  for (const text of ['no json here', '{broken', '[1,2]', '']) {
    assert.throws(() => parseResearch({ text, citations: [], sources: [], searched: true }), (e) => e.code === 'unreadable');
  }
});

test('researchProfile: forces a web search, asks for sources; falls back when the account rejects options', async () => {
  const sent = [];
  const good = { respond: async (k, req) => { sent.push(structuredClone(req)); return { text: JSON.stringify(RESULT), ...evidence }; } };
  const r = await researchProfile(good, 'sk', 'gpt-x', scraped);
  assert.equal(r.companyNews.length, 1);
  assert.deepEqual(sent[0].tools, [{ type: 'web_search', search_context_size: 'medium' }]);
  assert.equal(sent[0].toolChoice, 'required');
  assert.deepEqual(sent[0].include, ['web_search_call.action.sources']);
  assert.equal(sent[0].retryOnTimeout, false);

  const bad = (param, message) => Object.assign(new ApiError(`OpenAI: ${message}`, { code: 'bad_request' }), { param, apiMessage: message });
  const replies = [bad('tool_choice', 'Unsupported tool_choice'), bad('include', 'Invalid include value'), { text: '{"companyNews":[],"publicWork":[]}', citations: [], sources: [], searched: true }];
  const seen = [];
  const picky = { respond: async (k, req) => { seen.push(structuredClone(req)); const x = replies.shift(); if (x instanceof Error) throw x; return x; } };
  const r2 = await researchProfile(picky, 'sk', 'm', scraped);
  assert.deepEqual(r2.companyNews, []);
  assert.equal(seen[1].toolChoice, 'auto');
  assert.ok(!('include' in seen[2]));

  await assert.rejects(researchProfile({ respond: async () => { throw new ApiError('nope', { code: 'auth' }); } }, 'sk', 'm', scraped), /nope/);
  await assert.rejects(researchProfile({ respond: async () => { throw bad('tools', 'web_search is not supported'); } }, 'sk', 'm', scraped), /not supported/);
  await assert.rejects(researchProfile({ respond: async () => { throw new TypeError('weird'); } }, 'sk', 'm', scraped), /weird/);
});

test('researchHooks: their own work above company news; nothing when no research', () => {
  const r = parseResearch({ text: JSON.stringify(RESULT), ...evidence });
  const hooks = researchHooks(r);
  assert.deepEqual(hooks.map(x => x.kind), ['work', 'work', 'news']);
  assert.equal(hooks[0].label, 'Their talk: "Designing checkout for trust"');
  assert.equal(hooks[1].label, 'Their work: "Same host, other page"');
  assert.equal(hooks[2].label, 'News: Razorpay raises $100M');
  assert.ok(hooks[0].score > 8 && hooks[2].score < 8);
  assert.deepEqual(researchHooks(null), []);
  assert.deepEqual(researchHooks({}), []);
});

test('diagnosticsFor reflects the merged profile', () => {
  assert.deepEqual(diagnosticsFor(scraped).foundCount, 8);
  const thin = normalizeProfile({ name: 'X' });
  const d = diagnosticsFor(thin);
  assert.equal(d.foundCount, 1);
  assert.equal(d.layoutSuspect, true);
  assert.equal(diagnosticsFor(normalizeProfile({ name: 'X', pastCompanies: ['A'] })).found.experience, true);
});
