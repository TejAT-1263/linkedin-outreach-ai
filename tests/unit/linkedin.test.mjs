// background/linkedin.js — every way talking to the LinkedIn tab can go wrong.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.mjs';

const mock = installChromeMock();
const li = await import('../../extension/background/linkedin.js');
const PROFILE = { id: 7, url: 'https://www.linkedin.com/in/priya/' };

beforeEach(() => {
  mock.tabsState.tabs = new Map([[7, PROFILE], [8, { id: 8, url: 'https://www.linkedin.com/feed/' }], [9, { id: 9, url: 'https://example.com/' }], [10, { id: 10 }]]);
  mock.tabsState.active = PROFILE;
  mock.tabsState.injectFails = false;
  mock.tabsState.injected = 0;
  mock.tabsState.onSend = async () => ({ success: true, data: { name: 'Priya' } });
  li.TIMEOUTS.scrape = 200; li.TIMEOUTS.insert = 200;
});

test('resolveTab: explicit id, active tab, closed tab, no tab, non-LinkedIn, missing url', async () => {
  assert.equal((await li.resolveTab(7)).id, 7);
  assert.equal((await li.resolveTab(undefined)).id, 7);
  await assert.rejects(li.resolveTab(99), /no longer open/);
  mock.tabsState.active = null;
  await assert.rejects(li.resolveTab(undefined), /No active tab/);
  await assert.rejects(li.resolveTab(9), /Open a LinkedIn profile/);
  await assert.rejects(li.resolveTab(10), /Open a LinkedIn profile/);
});

test('scrape: success, LinkedIn non-profile page, content-script error, malformed reply', async () => {
  assert.deepEqual(await li.scrape(7), { name: 'Priya' });
  await assert.rejects(li.scrape(8), /someone’s profile/);
  mock.tabsState.onSend = async () => ({ success: false, error: 'boom' });
  await assert.rejects(li.scrape(7), /Could not read this profile: boom/);
  mock.tabsState.onSend = async () => ({ success: true, data: 'not an object' });
  await assert.rejects(li.scrape(7), /Could not read this profile/);
  mock.tabsState.onSend = async () => undefined;
  await assert.rejects(li.scrape(7), /Try reloading/);
});

test('scrape: no content script yet → injects once and retries', async () => {
  let calls = 0;
  mock.tabsState.onSend = async () => { calls += 1; if (calls === 1) throw new Error('Receiving end does not exist'); return { success: true, data: { name: 'P' } }; };
  assert.deepEqual(await li.scrape(7), { name: 'P' });
  assert.equal(mock.tabsState.injected, 1);
  assert.equal(calls, 2);
});

test('scrape: injection blocked, or still unreachable after injection', async () => {
  mock.tabsState.onSend = async () => { throw new Error('Receiving end does not exist'); };
  mock.tabsState.injectFails = true;
  await assert.rejects(li.scrape(7), (e) => e.code === 'inject_failed' && /Reload the page/.test(e.message));
  mock.tabsState.injectFails = false;
  await assert.rejects(li.scrape(7), (e) => e.code === 'unreachable');
});

test('scrape and insert time out instead of hanging forever', async () => {
  mock.tabsState.onSend = () => new Promise(() => {});
  const t0 = Date.now();
  await assert.rejects(li.scrape(7), (e) => e.code === 'timeout' && /took too long/.test(e.message));
  await assert.rejects(li.insert(7, 'hi'), (e) => e.code === 'timeout');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(mock.tabsState.injected, 0, 'a stuck script is not re-injected');
});

test('timeout after injection is reported as a timeout', async () => {
  let calls = 0;
  mock.tabsState.onSend = () => { calls += 1; return calls === 1 ? Promise.reject(new Error('no receiver')) : new Promise(() => {}); };
  await assert.rejects(li.insert(7, 'hi'), (e) => e.code === 'timeout');
});

test('insert: passes text + replace flag; bad replies become noComposer', async () => {
  let got;
  mock.tabsState.onSend = async (id, msg) => { got = msg; return { ok: true, kind: 'message' }; };
  assert.deepEqual(await li.insert(7, 'Hello', 1), { ok: true, kind: 'message' });
  assert.deepEqual(got, { action: 'insertMessage', text: 'Hello', replace: true });
  mock.tabsState.onSend = async () => undefined;
  assert.deepEqual(await li.insert(7, 'x'), { ok: false, reason: 'noComposer' });
  mock.tabsState.onSend = async () => 'weird';
  assert.deepEqual(await li.insert(8, 'x'), { ok: false, reason: 'noComposer' }, 'insert works on any LinkedIn page (e.g. messaging)');
});
