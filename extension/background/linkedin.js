// background/linkedin.js — talk to the LinkedIn tab (scrape + insert) via the content script.
const CONTENT_SCRIPT = 'content/content_script.js';
const LINKEDIN_RE = /^https:\/\/www\.linkedin\.com\//;

export class UserError extends Error {}

export async function resolveTab(tabId) {
  let tab;
  try {
    tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  } catch {
    throw new UserError('That tab is no longer open.');
  }
  if (!tab) throw new UserError('No active tab found.');
  if (!tab.url || !LINKEDIN_RE.test(tab.url)) throw new UserError('Open a LinkedIn profile first.');
  return tab;
}

async function sendToContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Tab was open before the extension was installed/updated → inject, then retry once.
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

export async function scrape(tabId) {
  const tab = await resolveTab(tabId);
  if (!/linkedin\.com\/in\//.test(tab.url)) throw new UserError('Open someone’s profile (linkedin.com/in/…) first.');
  const res = await sendToContent(tab.id, { action: 'scrapeProfile' });
  if (!res?.success) throw new UserError(res?.error || 'Could not read this profile. Try reloading the page.');
  return res.data;
}

export async function insert(tabId, text, replace) {
  const tab = await resolveTab(tabId);
  const res = await sendToContent(tab.id, { action: 'insertMessage', text, replace: !!replace });
  return res || { ok: false, reason: 'noComposer' };
}
