import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, ApiError } from '../../extension/background/anthropic.js';

const reply = (status, body, headers = {}) => ({ ok: status < 300, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
const okText = (t) => reply(200, { content: [{ type: 'text', text: t }] });

function client(responses, opts = {}) {
  const calls = [];
  const sleeps = [];
  const c = createClient({
    fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); const r = responses.shift(); if (r instanceof Error) throw r; return r; },
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, ...opts
  });
  return { c, calls, sleeps };
}

test('retries 429 / 529 with backoff, honouring Retry-After', async () => {
  const { c, calls, sleeps } = client([reply(429, {}, { 'retry-after': '2' }), reply(529, {}), okText('done')]);
  assert.equal(await c.call('sk-ant-x', { content: 'hi', maxTokens: 5 }), 'done');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [2000, 1000]);
});

test('does not retry auth errors and gives a clear message', async () => {
  const { c, calls } = client([reply(401, { error: { message: 'invalid x-api-key' } })]);
  await assert.rejects(c.call('sk-ant-x', { content: 'hi', maxTokens: 5 }), (e) => e instanceof ApiError && e.code === 'auth' && /rejected/.test(e.message));
  assert.equal(calls.length, 1);
});

test('gives up after max retries', async () => {
  const { c, calls } = client([reply(500, {}), reply(500, {}), reply(500, {})]);
  await assert.rejects(c.call('k', { content: 'x', maxTokens: 5 }), /busy/);
  assert.equal(calls.length, 3);
});

test('network errors and timeouts are retryable', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const { c } = client([new TypeError('Failed to fetch'), abort, okText('ok')]);
  assert.equal(await c.call('k', { content: 'x', maxTokens: 5 }), 'ok');
});

test('real timeout aborts a hanging request', async () => {
  const c = createClient({
    timeoutMs: 20, maxRetries: 0,
    fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))
  });
  await assert.rejects(c.call('k', { content: 'x', maxTokens: 5 }), (e) => e.code === 'timeout');
});

test('sends system prompt and model; rejects missing key', async () => {
  const { c, calls } = client([okText('ok')]);
  await c.call('k', { system: 'S', content: 'x', maxTokens: 9 });
  assert.equal(calls[0].system, 'S');
  assert.equal(calls[0].max_tokens, 9);
  assert.ok(calls[0].model);
  await assert.rejects(c.call('', { content: 'x', maxTokens: 5 }), (e) => e.code === 'no_key');
});
