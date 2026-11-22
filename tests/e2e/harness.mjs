// Shared e2e harness: Chrome + unpacked extension, LinkedIn routed to mocks, fake Anthropic and OpenAI APIs,
// popup helpers, a step runner, and V8 coverage of popup scripts.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1'; // let routes see service-worker fetches
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const EXT = path.join(ROOT, 'extension');
export const mockHtml = (name) => readFileSync(path.join(here, 'mock', name), 'utf8');

export async function launch({ pages = {} } = {}) {
  // Branded Google Chrome (v137+) ignores --load-extension, so the extension would never start.
  if (/Google Chrome(\.app| Beta| Dev| Canary)?|google-chrome/i.test(process.env.CHROME_PATH || '')) {
    throw new Error('CHROME_PATH points to branded Google Chrome, which no longer loads unpacked extensions from the command line (Chrome 137+). ' +
      'Unset CHROME_PATH and run `npx playwright install chromium` once — the e2e suites use Playwright\'s Chromium by default.');
  }
  const ctx = await chromium.launchPersistentContext('', {
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.CHROME_PATH ? undefined : 'chromium',
    headless: true,
    acceptDownloads: true,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
    permissions: ['clipboard-read', 'clipboard-write']
  });
  const profile = mockHtml('profile.html');
  await ctx.route('https://www.linkedin.com/**', r => {
    const url = r.request().url();
    const hit = Object.entries(pages).find(([frag]) => url.includes(frag));
    r.fulfill({ status: 200, contentType: 'text/html', body: hit ? hit[1] : profile });
  });

  // Fake Anthropic API: push responses onto `api.queue`; requests land in `api.requests`.
  const api = { queue: [], requests: [], fallback: { status: 200, text: 'OK' } };
  await ctx.route('https://api.anthropic.com/**', async r => {
    api.requests.push(JSON.parse(r.request().postData() || '{}'));
    const next = api.queue.shift() || api.fallback;
    if (next.hang) return; // never answer → exercises client timeout
    const body = next.status < 300 ? { content: [{ type: 'text', text: next.text }] } : { error: { message: next.msg || 'error' } };
    await r.fulfill({ status: next.status, contentType: 'application/json', headers: next.headers || {}, body: JSON.stringify(body) });
  });

  // Fake OpenAI Responses API (Deep Mode): push replies onto `oa.queue` — {status, body, delay} or
  // {hang:true}; requests land in `oa.requests`. Default reply: a completed "OK".
  const oa = { queue: [], requests: [] };
  await ctx.route('https://api.openai.com/**', async r => {
    oa.requests.push({ body: JSON.parse(r.request().postData() || '{}'), auth: r.request().headers().authorization || '' });
    const next = oa.queue.shift() || { status: 200, body: { status: 'completed', model: 'gpt-6.2-sol', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }] } };
    if (next.hang) return;
    if (next.delay) await new Promise(res => setTimeout(res, next.delay));
    await r.fulfill({ status: next.status, contentType: 'application/json', body: JSON.stringify(next.body) }).catch(() => {});
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) {
    sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!sw) throw new Error('The extension did not start in the test browser. Check extension/manifest.json loads in chrome://extensions, and that this Chromium allows --load-extension.');
  }
  const extId = sw.url().split('/')[2];
  const errors = [];
  const coverage = [];

  async function tab(url) {
    const p = await ctx.newPage();
    await p.goto(url);
    await p.waitForTimeout(300);
    const id = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find(t => t.url === u)?.id, p.url());
    return { page: p, id };
  }

  // Coverage: all extension pages share one V8 isolate, so per-page coverage sessions reset each
  // other. Instead, one CDP profiler session on an anchor page samples the whole isolate.
  const anchor = await ctx.newPage();
  await anchor.goto(`chrome-extension://${extId}/popup/popup.html?coverage-anchor=1`);
  const cdp = await ctx.newCDPSession(anchor);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  const sources = new Map();
  async function takeCoverage() {
    const { result } = await cdp.send('Profiler.takePreciseCoverage'); // also resets counters
    for (const r of result) {
      const m = r.url.match(/^chrome-extension:\/\/[^/]+\/((?:popup|shared|background)\/[^?#]+\.js)$/);
      if (!m) continue;
      if (!sources.has(m[1])) sources.set(m[1], readFileSync(path.join(EXT, m[1]), 'utf8'));
      coverage.push({ url: m[1], source: sources.get(m[1]), functions: r.functions });
    }
  }

  async function popup(tabId, { expectErrors = false } = {}) {
    const p = await ctx.newPage();
    p.on('filechooser', () => {}); // enable chooser interception up front (avoids a first-use race)
    if (!expectErrors) {
      p.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
      p.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    }
    await p.setViewportSize({ width: 400, height: 590 });
    await p.goto(`chrome-extension://${extId}/popup/popup.html${tabId ? `?tabId=${tabId}` : ''}`);
    await p.waitForSelector('body.booted');
    const close = p.close.bind(p);
    p.close = async () => { await takeCoverage(); await close(); };
    return p;
  }

  const storage = {
    get: (k) => sw.evaluate((key) => chrome.storage.local.get(key), k),
    set: (obj) => sw.evaluate((o) => chrome.storage.local.set(o), obj),
    msg: (page, action, payload = {}) => page.evaluate(([a, p]) => new Promise(r => chrome.runtime.sendMessage({ action: a, payload: p }, r)), [action, payload])
  };

  async function saveCoverageAs(name) {
    await takeCoverage();
    saveCoverage(name, coverage);
  }

  return { ctx, sw, extId, api, oa, errors, coverage, tab, popup, storage, saveCoverage: saveCoverageAs };
}

/** Step runner that keeps going after a failure and prints a summary. */
export function steps() {
  const results = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); results.push(['PASS', name, `${Date.now() - t0}ms`]); }
    catch (err) { results.push(['FAIL', name, String(err.message).split('\n').slice(0, process.env.E2E_VERBOSE ? 12 : 1).join(' ⏎ ')]); }
  };
  const report = (label) => {
    for (const r of results) console.log(r.join('  '));
    const failed = results.filter(r => r[0] === 'FAIL').length;
    console.log(`\n${label}: ${results.length - failed}/${results.length} passed`);
    return failed;
  };
  return { step, report };
}

/** Save raw V8 coverage for popup scripts so runs can be merged (scripts/coverage-report.mjs). */
export function saveCoverage(name, entries) {
  const dir = path.join(ROOT, 'coverage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `e2e-${name}.json`), JSON.stringify(entries));
}
