import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiMessage, aiFollowUp, aiResumeFacts } from '../../extension/background/writer-ai.js';
import { normalizeProfile } from '../../extension/background/hooks.js';
import { FORMATS } from '../../extension/shared/constants.js';
import { PRIYA, ME } from './helpers/fixtures.mjs';

const stub = (replies) => { const calls = []; return { calls, call: async (k, req) => { calls.push(req); return replies.shift(); } }; };
const args = { p: normalizeProfile(PRIYA), me: ME, hooks: [{ kind: 'sharedCompany', label: 'You both worked at Flipkart' }], messageType: 'Networking', tone: 'Neutral', fmt: FORMATS.note };

test('prompt carries limit, hooks and common-ground marker', async () => {
  const c = stub(['"Hi Priya — fellow Flipkart alum."']);
  const out = await aiMessage(c, 'k', args);
  assert.equal(out, 'Hi Priya — fellow Flipkart alum.');
  assert.match(c.calls[0].content, /Hard limit: 300/);
  assert.match(c.calls[0].content, /Flipkart \(common ground\)/);
  assert.match(c.calls[0].system, /Never invent facts/);
});

test('over-limit replies get one shorten pass, then a hard cut', async () => {
  const c = stub(['x '.repeat(300), 'y '.repeat(300)]);
  const out = await aiMessage(c, 'k', args);
  assert.equal(c.calls.length, 2);
  assert.match(c.calls[1].content, /Shorten this to under 300/);
  assert.ok(out.length <= 300);
});

test('regenerate passes the previous draft', async () => {
  const c = stub(['new one']);
  await aiMessage(c, 'k', { ...args, previousMessage: 'old one' });
  assert.match(c.calls[0].content, /clearly different version[\s\S]*old one/);
});

test('follow-up prompt mentions the original and offers an out on #2', async () => {
  const c = stub(['ok']);
  await aiFollowUp(c, 'k', { contact: { name: 'Priya', purpose: 'Job', message: 'orig msg', followUps: 1 }, me: ME, tone: 'Neutral', limit: 400 });
  assert.match(c.calls[0].content, /follow-up #2/);
  assert.match(c.calls[0].content, /polite way out/);
  assert.match(c.calls[0].content, /orig msg/);
});

test('resume facts: parses fenced JSON, sends a document block, rejects junk', async () => {
  const c = stub(['```json\n{"summary":"I build things","companies":["Flipkart"],"schools":["IIT Delhi"],"skills":["React"],"location":"Bengaluru, India"}\n```']);
  const f = await aiResumeFacts(c, 'k', 'JVBER');
  assert.deepEqual(f, { summary: 'I build things', companies: ['Flipkart'], schools: ['IIT Delhi'], skills: ['React'], location: 'Bengaluru' });
  assert.equal(c.calls[0].content[0].type, 'document');
  await assert.rejects(aiResumeFacts(stub(['no json here']), 'k', 'x'), /Couldn't read/);
});
