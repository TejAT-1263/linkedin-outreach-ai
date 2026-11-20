// popup/api.js — how the popup reacts to every kind of background reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let reply;
globalThis.chrome = { runtime: { lastError: null, sendMessage: (msg, cb) => { const r = reply(msg); chrome.runtime.lastError = r.lastError || null; cb(r.response); chrome.runtime.lastError = null; } } };
const { call, ACTIONS, RequestError } = await import('../../extension/popup/api.js');

test('success resolves data and sends {action, payload}', async () => {
  let sent;
  reply = (m) => { sent = m; return { response: { success: true, data: { x: 1 } } }; };
  assert.deepEqual(await call(ACTIONS.GET_STATE, { a: 1 }), { x: 1 });
  assert.deepEqual(sent, { action: 'getState', payload: { a: 1 } });
});

test('service worker restarted (lastError) → clear message', async () => {
  reply = () => ({ lastError: { message: 'Could not establish connection' }, response: undefined });
  await assert.rejects(call('getState'), (e) => e instanceof RequestError && e.code === 'runtime' && /reopen/.test(e.message));
});

test('no response → clear message', async () => {
  reply = () => ({ response: undefined });
  await assert.rejects(call('getState'), (e) => e.code === 'no_response');
});

test('error response keeps the background message and code', async () => {
  reply = () => ({ response: { success: false, error: 'Rate limited', code: 'rate_limit' } });
  await assert.rejects(call('generate'), (e) => e.message === 'Rate limited' && e.code === 'rate_limit');
  reply = () => ({ response: { success: false } });
  await assert.rejects(call('generate'), /Something went wrong/);
});
