// Remaining branches: tones, follow-up topics, API status codes, text edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localFollowUp, localMessage, greeting } from '../../extension/background/writer-local.js';
import { createClient } from '../../extension/background/anthropic.js';
import { contactIdFromUrl, firstSentence, stripQuotes, hashString, aOrAn } from '../../extension/shared/text.js';
import { normalizeProfile, buildHooks } from '../../extension/background/hooks.js';
import { FORMATS } from '../../extension/shared/constants.js';
import { withTimeout } from '../../extension/shared/errors.js';

test('greetings per tone, with fallback', () => {
  assert.equal(greeting('Sam', 'Formal'), 'Hello Sam,');
  assert.equal(greeting('Sam', 'Casual'), 'Hey Sam!');
  assert.equal(greeting('', 'Weird'), 'Hi there,');
});

test('follow-up topics for each hook kind', () => {
  const base = { name: 'Sam Lee', purpose: 'Networking', followUps: 0 };
  assert.match(localFollowUp({ contact: { ...base, hooks: [{ kind: 'sharedCompany', value: 'Acme' }] }, tone: 'Neutral' }), /time at Acme/);
  assert.match(localFollowUp({ contact: { ...base, hooks: [{ kind: 'sharedSchool', value: 'MIT' }] }, tone: 'Neutral' }), /shared school/);
  assert.match(localFollowUp({ contact: { ...base, hooks: [{ kind: 'sharedSkill', value: 'Go' }] }, tone: 'Neutral' }), /shared background/);
  const none = localFollowUp({ contact: { ...base, purpose: 'Unknown', hooks: [] }, tone: 'Casual', variant: 2 });
  assert.match(none, /^Hey Sam!/);
  assert.match(localFollowUp({ contact: { name: '', hooks: [{ kind: 'role' }] }, tone: 'Formal' }), /^Hello there,/);
});

test('every hook kind produces a sentence', () => {
  const p = normalizeProfile({ name: 'A B', currentCompany: 'Acme', pastCompanies: ['Old Co', 'Older'], skills: ['Go', 'Rust'], educationEntries: ['MIT'], about: 'I love building developer tools for small teams everywhere.', headline: 'x' });
  const hooks = buildHooks(p, {});
  for (const h of hooks) {
    for (let v = 0; v < 3; v++) {
      const m = localMessage({ p, me: {}, hooks: [h], messageType: 'Networking', tone: 'Neutral', fmt: FORMATS.dm, variant: v });
      assert.ok(m.split('\n\n')[1].length > 10, `${h.kind}: ${m}`);
    }
  }
  const t = buildHooks(normalizeProfile({ name: 'A', currentCompany: 'Acme' }), {});
  assert.equal(t[0].label, 'Works at Acme');
});

test('API client: 403, unknown 4xx, empty content retried, temperature passed', async () => {
  const mk = (responses) => { const sent = []; return { sent, c: createClient({ sleep: async () => {}, fetchImpl: async (u, i) => { sent.push(JSON.parse(i.body)); return responses.shift(); } }) }; };
  const res = (status, body = {}) => ({ ok: status < 300, status, json: async () => body, headers: { get: () => null } });
  await assert.rejects(mk([res(403)]).c.call('k', { content: 'x', maxTokens: 1 }), /not allowed/);
  await assert.rejects(mk([res(418, { error: { message: 'teapot' } })]).c.call('k', { content: 'x', maxTokens: 1 }), /teapot/);
  await assert.rejects(mk([res(418)]).c.call('k', { content: 'x', maxTokens: 1 }), /API error \(418\)/);
  const e = mk([res(200, { content: [] }), res(200, { content: [{ type: 'tool_use' }, { type: 'text', text: 'ok' }] })]);
  assert.equal(await e.c.call('k', { content: 'x', maxTokens: 1, temperature: 0.2 }), 'ok');
  assert.equal(e.sent[0].temperature, 0.2);
  const bad = mk([{ ok: false, status: 502, json: async () => { throw new Error('not json'); }, headers: { get: () => null } }, res(200, { content: [{ type: 'text', text: 'recovered' }] })]);
  assert.equal(await bad.c.call('k', { content: 'x', maxTokens: 1 }), 'recovered');
});

test('text odds and ends', () => {
  assert.equal(contactIdFromUrl('https://www.linkedin.com/in/%E0%A4%A/'), 'in:%e0%a4%a', 'bad percent-encoding kept raw');
  assert.equal(firstSentence('Short. Then more'), 'Short. Then more');
  assert.equal(firstSentence('This sentence is long enough to count. Next one.'), 'This sentence is long enough to count.');
  assert.equal(stripQuotes('“quoted”'), 'quoted');
  assert.equal(hashString('a'), hashString('a'));
  assert.notEqual(hashString('a'), hashString('b'));
  assert.equal(aOrAn('Engineer'), 'an');
});

test('withTimeout resolves fast promises and rejects slow ones', async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 50, 'slow'), 1);
  await assert.rejects(withTimeout(new Promise(() => {}), 10, 'too slow'), (e) => e.code === 'timeout' && e.message === 'too slow');
});
