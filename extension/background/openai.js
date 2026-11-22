// background/openai.js — minimal OpenAI Responses API client for Deep Mode (the user's own key).
// Same shape as anthropic.js: injectable deps, timeout, retry with backoff, clear user-facing errors.
import { OPENAI } from '../shared/constants.js';
import { ApiError } from './anthropic.js';

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Pull the answer text, refusals and URL citations out of a Responses API result. */
export function readOutput(data) {
  const out = Array.isArray(data?.output) ? data.output : [];
  let text = '';
  let refusal = '';
  const citations = [];
  const sources = [];
  let searched = false;
  for (const item of out) {
    if (item?.type === 'web_search_call') {
      searched = true;
      for (const s of Array.isArray(item.action?.sources) ? item.action.sources : []) {
        if (typeof s?.url === 'string') sources.push(s.url);
      }
    }
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (c?.type === 'output_text' && typeof c.text === 'string') {
        text += c.text;
        for (const a of Array.isArray(c.annotations) ? c.annotations : []) {
          if (a?.type === 'url_citation' && typeof a.url === 'string') citations.push({ url: a.url, title: typeof a.title === 'string' ? a.title : '' });
        }
      } else if (c?.type === 'refusal') {
        refusal = typeof c.refusal === 'string' ? c.refusal : 'refused';
      }
    }
  }
  return { text, refusal, citations, sources, searched };
}

/**
 * @param {{fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>, maxRetries?: number, random?: () => number}} deps
 */
export function createOpenAIClient(deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
  const sleep = deps.sleep || defaultSleep;
  const maxRetries = deps.maxRetries ?? OPENAI.MAX_RETRIES;
  const random = deps.random || Math.random;

  async function once(apiKey, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(OPENAI.URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      throw new ApiError(timedOut ? 'OpenAI took too long to respond.' : 'Network error reaching OpenAI — check your connection.',
        { retryable: true, code: timedOut ? 'timeout' : 'network' });
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;

    const apiMsg = typeof data?.error?.message === 'string' ? data.error.message : '';
    const apiCode = typeof data?.error?.code === 'string' ? data.error.code : '';
    const retryAfter = Number(res.headers?.get?.('retry-after')) || 0;
    if (res.status === 401) throw new ApiError('Your OpenAI key was rejected. Check it in Settings.', { status: 401, code: 'auth' });
    if (res.status === 403) throw new ApiError('This OpenAI key is not allowed to use this model or region.', { status: 403, code: 'forbidden' });
    if (res.status === 404 || apiCode === 'model_not_found') {
      throw new ApiError(`The OpenAI model "${body.model}" isn't available to this key. Pick another model in Settings.`, { status: res.status, code: 'model_not_found' });
    }
    if (res.status === 429 && (apiCode === 'insufficient_quota' || /quota|billing/i.test(apiMsg))) {
      throw new ApiError('Your OpenAI account has no credit left. Add billing at platform.openai.com, then try again.', { status: 429, code: 'quota' });
    }
    if (res.status === 429) { const e = new ApiError('OpenAI rate limit — trying again shortly.', { status: 429, retryable: true, code: 'rate_limit' }); e.retryAfter = retryAfter; throw e; }
    if (res.status >= 500) { const e = new ApiError('OpenAI is busy right now. Please try again.', { status: res.status, retryable: true, code: 'overloaded' }); e.retryAfter = retryAfter; throw e; }
    const e = new ApiError(apiMsg ? `OpenAI: ${apiMsg}` : `OpenAI error (${res.status})`, { status: res.status, code: res.status === 400 ? 'bad_request' : 'api_error' });
    e.param = typeof data?.error?.param === 'string' ? data.error.param : '';
    e.apiMessage = apiMsg;
    throw e;
  }

  async function withRetry(apiKey, body, timeoutMs, retryOnTimeout) {
    let attempt = 0;
    for (;;) {
      try {
        return await once(apiKey, body, timeoutMs);
      } catch (err) {
        if (!(err instanceof ApiError) || !err.retryable || attempt >= maxRetries) throw err;
        if (err.code === 'timeout' && !retryOnTimeout) throw err;
        const backoff = Math.min(8000, 500 * 2 ** attempt) * (0.5 + random());
        await sleep(err.retryAfter ? err.retryAfter * 1000 : backoff);
        attempt += 1;
      }
    }
  }

  /**
   * One Responses API call with every recovery we can do safely:
   * - a model that rejects the `reasoning` option is retried once without it;
   * - an answer cut off by the token limit is retried once with double the budget.
   * @param {string} apiKey
   * @param {{model: string, instructions?: string, input: string, maxOutputTokens: number,
   *          format?: object, tools?: object[], toolChoice?: string, include?: string[], timeoutMs: number,
   *          retryOnTimeout?: boolean}} req
   */
  async function respond(apiKey, req) {
    if (!apiKey) throw new ApiError('Add your OpenAI key in Settings to use Deep Mode.', { code: 'no_key' });
    const body = {
      model: req.model,
      input: req.input,
      max_output_tokens: req.maxOutputTokens,
      store: false,
      reasoning: { effort: 'low' }
    };
    if (req.instructions) body.instructions = req.instructions;
    if (req.format) body.text = { format: req.format };
    if (req.tools) body.tools = req.tools;
    if (req.toolChoice) body.tool_choice = req.toolChoice;
    if (req.include) body.include = req.include;

    let triedWithoutReasoning = false;
    let triedBiggerBudget = false;
    for (;;) {
      let data;
      try {
        data = await withRetry(apiKey, body, req.timeoutMs, req.retryOnTimeout !== false);
      } catch (err) {
        const aboutReasoning = err.code === 'bad_request' && (err.param === 'reasoning' || err.param === 'reasoning.effort' || /reasoning/i.test(err.apiMessage || ''));
        if (aboutReasoning && !triedWithoutReasoning && body.reasoning) {
          triedWithoutReasoning = true;
          delete body.reasoning;
          continue;
        }
        throw err;
      }
      if (data?.status === 'failed') {
        throw new ApiError(data?.error?.message ? `OpenAI: ${data.error.message}` : 'OpenAI could not complete the request.', { code: 'failed' });
      }
      const out = readOutput(data);
      if (out.refusal) throw new ApiError('OpenAI declined this request.', { code: 'refusal' });
      if (data?.status === 'incomplete') {
        if (data?.incomplete_details?.reason === 'max_output_tokens' && !triedBiggerBudget) {
          triedBiggerBudget = true;
          body.max_output_tokens = req.maxOutputTokens * 2;
          continue;
        }
        if (!out.text.trim()) throw new ApiError('OpenAI stopped before finishing. Please try again.', { code: 'incomplete' });
      }
      if (!out.text.trim()) throw new ApiError('OpenAI returned an empty answer. Please try again.', { code: 'empty' });
      return { ...out, model: typeof data?.model === 'string' ? data.model : req.model, usage: data?.usage || null };
    }
  }

  return { respond };
}
