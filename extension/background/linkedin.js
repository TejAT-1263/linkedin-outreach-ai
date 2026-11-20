// background/linkedin.js — talk to the LinkedIn tab (scrape + insert) via the content script.
import { UserError, withTimeout } from '../shared/errors.js';

export { UserError };

const CONTENT_SCRIPT = 'content/content_script.js';
const LINKEDIN_RE = /^https:\/\/www\.linkedin\.com\//;
export const TIMEOUTS = { scrape: 20_000, insert: 5_000 };

export async function resolveTab(tabId) {
  let tab;
  try {
    tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  } catch {
    throw new UserError('That tab is no longer open.', 'no_tab');
  }
  if (!tab) throw new UserError('No active tab found.', 'no_tab');
  if (!tab.url || !LINKEDIN_RE.test(tab.url)) throw new UserError('Open a LinkedIn profile first.', 'not_linkedin');
  return tab;
}

async function sendToContent(tabId, msg, ms, timeoutMessage) {
  const send = () => withTimeout(chrome.tabs.sendMessage(tabId, msg), ms, timeoutMessage);
  try {
    return await send();
  } catch (err) {
    if (err instanceof UserError) throw err; // timed out: the script is there but stuck
    // No content script yet (tab opened before install/update) → inject, then retry once.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
    } catch {
      throw new UserError("Can't reach this LinkedIn tab. Reload the page and try again.", 'inject_failed');
    }
    try {
      return await send();
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError("Can't reach this LinkedIn tab. Reload the page and try again.", 'unreachable');
    }
  }
}

export async function scrape(tabId) {
  const tab = await resolveTab(tabId);
  if (!/linkedin\.com\/in\//.test(tab.url)) throw new UserError('Open someone’s profile (linkedin.com/in/…) first.', 'not_profile');
  const res = await sendToContent(tab.id, { action: 'scrapeProfile' }, TIMEOUTS.scrape, 'Reading the profile took too long. Reload the page and try again.');
  if (!res?.success || !res.data || typeof res.data !== 'object') {
    throw new UserError(res?.error ? `Could not read this profile: ${res.error}` : 'Could not read this profile. Try reloading the page.', 'scrape_failed');
  }
  return res.data;
}

export async function insert(tabId, text, replace) {
  const tab = await resolveTab(tabId);
  const res = await sendToContent(tab.id, { action: 'insertMessage', text, replace: !!replace }, TIMEOUTS.insert, 'LinkedIn didn’t respond. Reload the page and try again.');
  return res && typeof res === 'object' ? res : { ok: false, reason: 'noComposer' };
}
