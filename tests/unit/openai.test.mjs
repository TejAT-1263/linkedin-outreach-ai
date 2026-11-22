// background/openai.js — Responses API client: parsing, errors, retries and recoveries, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIClient, readOutput } from '../../extension/background/openai.js';
import { OPENAI } from '../../extension/shared/constants.js';

const msg = (text, annotations = []) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations }] });
const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ status: 'completed', model: 'gpt-6.2-sol', ...body }) });
const fail = (status, error = {}, headers = {}) => ({ ok: false, status, headers: { get: (k) => headers[k] ?? null }, json: async () => ({ error }) });

function client(responses, opts = {}) {
  const calls = [];
  const sleeps = [];
  const c = createOpenAIClient({
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    ...opts
  });
  return { c, calls, sleeps };
}
const REQ = { model: 'gpt-6.2-sol', input: 'hi', maxOutputTokens: 100, timeoutMs: 1000 };

test('readOutput: text, citations, sources, refusals, search flag; tolerates junk', () => {
  const r = readOutput({ output: [
    { type: 'web_search_call', action: { type: 'search', sources: [{ url: 'https://a.example/x' }, { nope: 1 }] } },
    { type: 'reasoning' },
    msg('Hello ', [{ type: 'url_citation', url: 'https://a.example/x', title: 'A' }, { type: 'url_citation', url: 'https://b.example' }, { type: 'other' }]),
    { type: 'message', content: [{ type: 'output_text', text: 'world' }, { type: 'refusal', refusal: 'no' }] },
    { type: 'message', content: [{ type: 'refusal' }] },
    { type: 'message', content: 'not an array' },
    null
  ] });
  assert.equal(r.text, 'Hello world');
  assert.deepEqual(r.citations, [{ url: 'https://a.example/x', title: 'A' }, { url: 'https://b.example', title: '' }]);
  assert.deepEqual(r.sources, ['https://a.example/x']);
  assert.equal(r.searched, true);
  assert.equal(r.refusal, 'refused');
  assert.deepEqual(readOutput(null), { text: '', refusal: '', citations: [], sources: [], searched: false });
  assert.equal(readOutput({ output: [{ type: 'web_search_call' }] }).searched, true);
});

test('request shape: bearer auth, store:false, low reasoning, optional fields only when given', async () => {
  const { c, calls } = client([ok({ output: [msg('OK')] }), ok({ output: [msg('{}')] })]);
  const r = await c.respond('sk-test', REQ);
  assert.equal(r.text, 'OK');
  assert.equal(r.model, 'gpt-6.2-sol');
  assert.equal(calls[0].url, OPENAI.URL);
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body, { model: 'gpt-6.2-sol', input: 'hi', max_output_tokens: 100, store: false, reasoning: { effort: 'low' } });
  await c.respond('sk-test', { ...REQ, instructions: 'be brief', format: { type: 'json_schema' }, tools: [{ type: 'web_search' }], toolChoice: 'required', include: ['x'] });
  const b = calls[1].body;
  assert.equal(b.instructions, 'be brief');
  assert.deepEqual(b.text, { format: { type: 'json_schema' } });
  assert.deepEqual(b.tools, [{ type: 'web_search' }]);
  assert.equal(b.tool_choice, 'required');
  assert.deepEqual(b.include, ['x']);
});

test('no key → clear error without a request', async () => {
  const { c, calls } = client([]);
  await assert.rejects(c.respond('', REQ), (e) => e.code === 'no_key' && /OpenAI key/.test(e.message));
  assert.equal(calls.length, 0);
});

test('HTTP errors map to clear, non-retried messages', async () => {
  const cases = [
    [fail(401), 'auth', /rejected/],
    [fail(403), 'forbidden', /not allowed/],
    [fail(404, { message: 'no model' }), 'model_not_found', /gpt-6\.2-sol.*isn't available/],
    [fail(400, { code: 'model_not_found', message: 'x' }), 'model_not_found', /Pick another model/],
    [fail(429, { code: 'insufficient_quota', message: 'You exceeded your current quota' }), 'quota', /no credit/],
    [fail(429, { message: 'check your plan and billing details' }), 'quota', /no credit/],
    [fail(400, { message: 'Unsupported value', param: 'temperature' }), 'bad_request', /OpenAI: Unsupported value/],
    [fail(400), 'bad_request', /OpenAI error \(400\)/],
    [fail(418, { message: 'teapot' }), 'api_error', /OpenAI: teapot/]
  ];
  for (const [res, code, re] of cases) {
    const { c, calls } = client([res]);
    await assert.rejects(c.respond('sk', REQ), (e) => e.code === code && re.test(e.message), code);
    assert.equal(calls.length, 1, `${code} is not retried`);
  }
  // A body that isn't JSON still yields a clean error.
  const { c } = client([{ ok: false, status: 400, headers: { get: () => null }, json: async () => { throw new Error('html'); } }]);
  await assert.rejects(c.respond('sk', REQ), /OpenAI error \(400\)/);
});

test('rate limits, outages, network errors and timeouts are retried with backoff', async () => {
  const { c, calls, sleeps } = client([fail(429, {}, { 'retry-after': '2' }), fail(503), new TypeError('Failed to fetch'), ok({ output: [msg('done')] })], { maxRetries: 3 });
  assert.equal((await c.respond('sk', REQ)).text, 'done');
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [2000, 1000, 2000], 'Retry-After honoured, then exponential backoff');

  const gaveUp = client([fail(500), fail(500), fail(500)]);
  await assert.rejects(gaveUp.c.respond('sk', REQ), (e) => e.code === 'overloaded' && /busy/.test(e.message));
  assert.equal(gaveUp.calls.length, 3, 'stops after MAX_RETRIES');

  const net = client([new TypeError('x'), new TypeError('x'), new TypeError('x')]);
  await assert.rejects(net.c.respond('sk', REQ), (e) => e.code === 'network');
});

test('timeouts abort the request; only retried when allowed', async () => {
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
  let n = 0;
  const c = createOpenAIClient({ sleep: async () => {}, fetchImpl: (u, i) => { n += 1; return hang(u, i); } });
  await assert.rejects(c.respond('sk', { ...REQ, timeoutMs: 5, retryOnTimeout: false }), (e) => e.code === 'timeout' && /too long/.test(e.message));
  assert.equal(n, 1, 'a long web search is not repeated after a timeout');
  n = 0;
  await assert.rejects(c.respond('sk', { ...REQ, timeoutMs: 5 }), (e) => e.code === 'timeout');
  assert.equal(n, 1 + OPENAI.MAX_RETRIES, 'short calls retry timeouts');
});

test('a model that rejects the reasoning option is retried once without it', async () => {
  const { c, calls } = client([fail(400, { message: "Unsupported parameter: 'reasoning.effort'", param: 'reasoning.effort' }), ok({ output: [msg('fine')] })]);
  assert.equal((await c.respond('sk', REQ)).text, 'fine');
  assert.equal(calls.length, 2);
  assert.ok(!('reasoning' in calls[1].body));
  // By message only, too — and a second rejection is surfaced.
  const twice = client([fail(400, { message: 'reasoning is not supported' }), fail(400, { message: 'reasoning is not supported' })]);
  await assert.rejects(twice.c.respond('sk', REQ), /reasoning is not supported/);
  assert.equal(twice.calls.length, 2);
  const byParam = client([fail(400, { message: 'bad', param: 'reasoning' }), ok({ output: [msg('ok')] })]);
  assert.equal((await byParam.c.respond('sk', REQ)).text, 'ok');
});

test('failed, refused, empty and cut-off answers', async () => {
  await assert.rejects(client([ok({ status: 'failed', error: { message: 'server_error' } })]).c.respond('sk', REQ), (e) => e.code === 'failed' && /server_error/.test(e.message));
  await assert.rejects(client([ok({ status: 'failed' })]).c.respond('sk', REQ), /could not complete/);
  await assert.rejects(client([ok({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] })]).c.respond('sk', REQ), (e) => e.code === 'refusal');
  await assert.rejects(client([ok({ output: [msg('   ')] })]).c.respond('sk', REQ), (e) => e.code === 'empty');

  // Cut off by the token limit → one retry with double the budget.
  const { c, calls } = client([ok({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), ok({ output: [msg('{"a":1}')] })]);
  assert.equal((await c.respond('sk', REQ)).text, '{"a":1}');
  assert.equal(calls[1].body.max_output_tokens, 200);
  // Still cut off after the retry: keep partial text if any, otherwise a clear error.
  const still = client([ok({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), ok({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })]);
  await assert.rejects(still.c.respond('sk', REQ), (e) => e.code === 'incomplete');
  const partial = client([ok({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [msg('partial')] })]);
  assert.equal((await partial.c.respond('sk', REQ)).text, 'partial');
});

test('default dependencies use the global fetch', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ok({ output: [msg('global')] });
  try {
    assert.equal((await createOpenAIClient().respond('sk', REQ)).text, 'global');
  } finally {
    globalThis.fetch = real;
  }
});
