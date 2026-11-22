// Deep Mode cache, resume storage, migration of the original's resume, and writers using research hooks.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.mjs';
import { PRIYA, ME } from './helpers/fixtures.mjs';

installChromeMock();
const store = await import('../../extension/background/store.js');
const { migrate } = await import('../../extension/background/migrate.js');
const { localMessage, openerFor } = await import('../../extension/background/writer-local.js');
const { aiMessage } = await import('../../extension/background/writer-ai.js');
const { buildHooks, normalizeProfile } = await import('../../extension/background/hooks.js');
const { LIMITS, FORMATS } = await import('../../extension/shared/constants.js');
before(() => store.init());

test('deep cache: merge per profile, TTL, corrupt data, keeps the 20 most recent', async () => {
  await store.saveDeep('in:a', { l1: { status: 'done' } });
  await store.saveDeep('in:a', { l2: { status: 'running' } });
  const a = await store.getDeep('in:a');
  assert.deepEqual([a.l1.status, a.l2.status], ['done', 'running'], 'patches merge');
  assert.equal(await store.getDeep('in:none'), null);

  const raw = chrome.storage.session._raw();
  raw.deep['in:a'].at = Date.now() - LIMITS.DEEP_CACHE_TTL_MS - 1;
  assert.equal(await store.getDeep('in:a'), null, 'expired');
  raw.deep['in:a'] = 'junk';
  assert.equal(await store.getDeep('in:a'), null);
  await store.saveDeep('in:a', { l1: { status: 'failed' } });
  assert.equal((await store.getDeep('in:a')).l1.status, 'failed', 'junk entry replaced');
  chrome.storage.session._replace({ deep: 'corrupt' });
  assert.equal(await store.getDeep('in:a'), null);

  for (let i = 0; i < 25; i++) { await store.saveDeep(`in:p${i}`, { i }); }
  const all = chrome.storage.session._raw().deep;
  assert.equal(Object.keys(all).length, 20);
  assert.ok(all['in:p24'] && !all['in:p0'], 'oldest dropped');
});

test('resume storage: save, read, defaults for corrupt data, delete', async () => {
  assert.equal(await store.getResume(), null);
  const saved = await store.saveResume({ base64: 'JVBERi0=', fileName: '', bytes: 5 });
  assert.equal(saved.fileName, 'resume.pdf');
  const r = await store.getResume();
  assert.deepEqual({ ...r, savedAt: 0 }, { base64: 'JVBERi0=', fileName: 'resume.pdf', bytes: 5, savedAt: 0 });
  await chrome.storage.local.set({ resume: { base64: 'JVBER', fileName: 7, bytes: 'x', savedAt: 'y' } });
  assert.deepEqual(await store.getResume(), { base64: 'JVBER', fileName: 'resume.pdf', bytes: 0, savedAt: 0 });
  for (const bad of ['str', { base64: '' }, { base64: 5 }, null]) {
    await chrome.storage.local.set({ resume: bad });
    assert.equal(await store.getResume(), null, JSON.stringify(bad));
  }
  await store.saveResume({ base64: 'JVBER', fileName: 'cv.pdf', bytes: 3 });
  await store.deleteResume();
  assert.equal(await store.getResume(), null);
});

test('settings sanitise the new fields', () => {
  const s = store.sanitizeSettings({ openaiKey: '  sk-x  ', openaiModel: 'gpt-6.2-astra', resumeBytes: 12, resumeSavedAt: 99 });
  assert.deepEqual(s, { openaiKey: 'sk-x', openaiModel: 'gpt-6.2-astra', resumeBytes: 12, resumeSavedAt: 99 });
  const bad = store.sanitizeSettings({ openaiKey: 5, openaiModel: 'rm -rf /', resumeBytes: -1, resumeSavedAt: 'soon' });
  assert.deepEqual(bad, { openaiKey: '5', openaiModel: 'gpt-6.2-sol', resumeBytes: 0, resumeSavedAt: 0 });
  assert.equal(store.validModel(null), 'gpt-6.2-sol');
  assert.equal(store.validModel(' gpt-5.4-mini '), 'gpt-5.4-mini');
  assert.deepEqual(store.publicSettings({ apiKey: '', openaiKey: '' }), { hasKey: false, keyHint: '', hasOpenAIKey: false, openaiKeyHint: '' });
});

test('migration keeps the original version\'s resume PDF', () => {
  const { set, remove } = migrate({ userName: 'A', resumeBase64: 'JVBERi0xLjQK', resumeFileName: 'me.pdf' });
  assert.equal(set.resume.base64, 'JVBERi0xLjQK');
  assert.equal(set.resume.fileName, 'me.pdf');
  assert.equal(set.resume.bytes, 9);
  assert.equal(set.settings.resumeFileName, 'me.pdf');
  assert.equal(set.settings.resumeBytes, 9);
  assert.ok(remove.includes('resumeBase64'), 'moved, not duplicated');
  const noName = migrate({ resumeBase64: 'JVBER' });
  assert.equal(noName.set.resume.fileName, 'resume.pdf');
  assert.ok(!('resume' in migrate({ userName: 'A', resumeBase64: '' }).set));
  assert.ok(!('resume' in migrate({ userName: 'A', resumeBase64: 42 }).set));
  assert.equal(migrate({}).set.settings.openaiModel, 'gpt-6.2-sol');
  assert.equal(migrate({}).set.prefs.mode, 'quick');
});

const p = normalizeProfile(PRIYA);
const research = [
  { kind: 'work', label: 'Their talk: "Checkout for trust"', value: 'your checkout talk at JSConf', score: 8.5 },
  { kind: 'news', label: 'News: Razorpay raises $100M', value: "Razorpay's new funding round", score: 7 }
];

test('buildHooks ranks research among the profile hooks', () => {
  const hooks = buildHooks(p, ME, research);
  const kinds = hooks.map(h => h.kind);
  assert.equal(kinds[0], 'sharedCompany', 'common ground still first');
  assert.equal(kinds[1], 'work', 'their own work next');
  assert.ok(hooks[1].selected && !hooks.find(h => h.kind === 'news').selected);
  assert.ok(hooks.every(h => typeof h.id === 'string'));
  assert.deepEqual(buildHooks(p, ME).map(h => h.kind), buildHooks(p, ME, []).map(h => h.kind), 'no extra → unchanged');
});

test('built-in writer phrases research hooks and rotates them', () => {
  assert.equal(openerFor(research[0], 0), 'I enjoyed your checkout talk at JSConf.');
  assert.equal(openerFor(research[0], 1), 'Really enjoyed your checkout talk at JSConf.');
  assert.equal(openerFor(research[1], 0), "I saw Razorpay's new funding round.");
  assert.equal(openerFor(research[1], 1), "Caught Razorpay's new funding round recently.");
  const msg = localMessage({ p, me: ME, hooks: [research[0], research[1]].map(h => ({ ...h, selected: true })), messageType: 'Networking', tone: 'Neutral', fmt: FORMATS.note, variant: 0 });
  assert.match(msg, /I enjoyed your checkout talk at JSConf\./);
  assert.ok(msg.length <= 300);
});

test('AI writer is told research hooks are public-web facts and how to phrase them', async () => {
  const sent = [];
  const client = { call: async (key, req) => { sent.push(req); return 'Hi Priya, I enjoyed your checkout talk at JSConf. Would love to connect.'; } };
  await aiMessage(client, 'sk-ant-x', { p, me: ME, hooks: research, messageType: 'Networking', tone: 'Neutral', fmt: FORMATS.note, previousMessage: '' });
  assert.match(sent[0].content, /Their talk: "Checkout for trust" — from public web sources; phrase it as "I enjoyed your checkout talk at JSConf"/);
  assert.match(sent[0].content, /News: Razorpay raises \$100M — from public web sources; phrase it as "I saw Razorpay's new funding round"/);
  // A research hook without a text value is listed plainly.
  await aiMessage(client, 'sk-ant-x', { p, me: ME, hooks: [{ kind: 'news', label: 'News: X', value: { title: 'x' } }], messageType: 'Networking', tone: 'Neutral', fmt: FORMATS.note, previousMessage: '' });
  assert.match(sent[1].content, /- News: X\n/);
});
