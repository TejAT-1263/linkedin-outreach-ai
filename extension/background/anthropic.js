// background/anthropic.js — minimal Messages API client with timeout, retry and clear errors.
// Dependencies are injectable so the retry logic is unit-testable without network.
import { ANTHROPIC } from '../shared/constants.js';

export class ApiError extends Error {
  constructor(message, { status = 0, retryable = false, code = 'api_error' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {{fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>, timeoutMs?: number, maxRetries?: number, random?: () => number}} deps
 */
export function createClient(deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
  const sleep = deps.sleep || defaultSleep;
  const timeoutMs = deps.timeoutMs ?? ANTHROPIC.TIMEOUT_MS;
  const maxRetries = deps.maxRetries ?? ANTHROPIC.MAX_RETRIES;
  const random = deps.random || Math.random;

  async function once(apiKey, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(ANTHROPIC.URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC.VERSION,
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      throw new ApiError(timedOut ? 'The AI took too long to respond.' : 'Network error — check your connection.',
        { retryable: true, code: timedOut ? 'timeout' : 'network' });
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = (data.content || []).map(c => (c.type === 'text' ? c.text : '')).join('');
      if (!text.trim()) throw new ApiError('The AI returned an empty response.', { retryable: true, code: 'empty' });
      return text;
    }
    const apiMsg = data?.error?.message;
    const retryAfter = Number(res.headers?.get?.('retry-after')) || 0;
    switch (res.status) {
      case 401: throw new ApiError('Your API key was rejected. Check it in Settings.', { status: 401, code: 'auth' });
      case 403: throw new ApiError('This API key is not allowed to use this model.', { status: 403, code: 'forbidden' });
      case 400: throw new ApiError(apiMsg || 'The request was rejected by the API.', { status: 400, code: 'bad_request' });
      case 429: { const e = new ApiError('Rate limited by the API — trying again shortly.', { status: 429, retryable: true, code: 'rate_limit' }); e.retryAfter = retryAfter; throw e; }
      default:
        if (res.status >= 500 || res.status === 529) {
          const e = new ApiError('The AI service is busy. Please try again.', { status: res.status, retryable: true, code: 'overloaded' });
          e.retryAfter = retryAfter;
          throw e;
        }
        throw new ApiError(apiMsg || `API error (${res.status})`, { status: res.status, code: 'api_error' });
    }
  }

  /**
   * @param {string} apiKey
   * @param {{system?: string, content: string|object[], maxTokens: number, temperature?: number}} req
   */
  async function call(apiKey, { system, content, maxTokens, temperature }) {
    if (!apiKey) throw new ApiError('No API key set.', { code: 'no_key' });
    const body = { model: ANTHROPIC.MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
    if (system) body.system = system;
    if (typeof temperature === 'number') body.temperature = temperature;

    let attempt = 0;
    for (;;) {
      try {
        return await once(apiKey, body);
      } catch (err) {
        if (!(err instanceof ApiError) || !err.retryable || attempt >= maxRetries) throw err;
        // Exponential backoff with jitter; honour Retry-After when the API sends it.
        const backoff = Math.min(8000, 500 * 2 ** attempt) * (0.5 + random());
        await sleep(err.retryAfter ? err.retryAfter * 1000 : backoff);
        attempt += 1;
      }
    }
  }

  return { call };
}
