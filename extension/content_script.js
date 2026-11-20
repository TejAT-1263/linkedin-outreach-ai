'use strict';

// content_script.js — runs on linkedin.com
// Two jobs:
//   1. scrapeProfile  → read the profile the user is looking at
//   2. insertMessage  → put a drafted message into the open LinkedIn compose box
//
// Guard against double-injection (background.js may inject this file again
// with chrome.scripting if the page was open before the extension loaded).
if (!window.__outreachAiLoaded) {
  window.__outreachAiLoaded = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'ping') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.action === 'scrapeProfile') {
      scrapeWithScroll()
        .then(profile => sendResponse({ success: true, data: profile }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (msg.action === 'insertMessage') {
      try {
        sendResponse(insertMessage(msg.text || '', !!msg.replace));
      } catch (err) {
        sendResponse({ ok: false, reason: 'error', error: err.message });
      }
      return false;
    }
    return false;
  });
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

async function scrapeWithScroll() {
  // LinkedIn lazy-loads lower sections, so we scroll to trigger them —
  // but we now put the user back where they were instead of jumping to the top.
  const startY = window.scrollY;
  for (const y of [800, 1600, 2400]) {
    window.scrollTo(0, y);
    await wait(450);
  }
  window.scrollTo(0, startY);
  await wait(200);
  return scrapeProfile();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const DATE_RE = /^(\d{4}|present|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
const DURATION_RE = /\d{4}|present|\byrs?\b|\bmos?\b/i;
const WORKPLACE_RE = /\b(remote|hybrid|on-?site)\b/i;
const UI_NOISE_RE = /dialog|window|escape|cancel|close|beginning|notifications|premium|people you may|you might|show all|see all|followers?$|connections?$/i;

function looksLikeLocation(t) {
  // "City, Region", "City, Country · Remote", "Remote", etc. Works for any country.
  if (!t || t.length > 70 || /\d/.test(t) || t.includes('|') || t.includes('@')) return false;
  return WORKPLACE_RE.test(t) || /^[\p{L} .'-]+,\s*[\p{L} .'-]+/u.test(t);
}

function scrapeProfile() {
  const clean = (str) => (str || '').replace(/\s+/g, ' ').trim();
  const allSections = Array.from(document.querySelectorAll('section'));

  function getSection(heading) {
    return allSections.find(s =>
      s.querySelector('h2')?.innerText?.trim().toLowerCase().includes(heading.toLowerCase())
    ) || null;
  }

  function leafTexts(section, selector = 'p, span') {
    if (!section) return [];
    return Array.from(section.querySelectorAll(selector))
      .filter(el => el.children.length === 0)
      .map(el => clean(el.innerText))
      .filter(t => t.length > 2 && !/^[·•\s]+$/.test(t));
  }

  // ── NAME ──
  const name = clean(document.querySelector('h1')?.innerText) ||
               clean(document.title.split('|')[0]);

  // ── HEADLINE + LOCATION (from the top card, the section containing the h1) ──
  let headline = null;
  let location = null;
  const topCard = allSections.find(s => s.querySelector('h1')) || null;
  if (topCard) {
    const lines = leafTexts(topCard, 'p, div.text-body-medium, span.text-body-small')
      .filter(t => t !== name && !/connections?|followers?|contact info/i.test(t));
    headline = lines.find(t =>
      t.length > 5 && (t.includes('|') || t.includes('@') ||
      /manager|engineer|analyst|developer|designer|founder|director|lead|specialist|consultant|intern|fellow|student|head|vp|chief|officer|recruiter|partner|scientist|researcher/i.test(t))
    ) || lines.find(t => t.length > 5) || null;
    location = lines.find(t => t !== headline && looksLikeLocation(t)) || null;
  }

  // ── ABOUT ──
  let about = null;
  const aboutTexts = leafTexts(getSection('About'));
  const longText = aboutTexts.find(t => t.length > 80);
  if (longText) about = longText;

  // ── EXPERIENCE ──
  const experienceEntries = [];
  const expSection = getSection('Experience');
  if (expSection) {
    const lines = leafTexts(expSection, 'p, span[aria-hidden="true"]')
      .filter(t => t !== 'Experience');
    // Pattern per entry: title, company · type, dates, [location]
    let i = 0;
    while (i < lines.length && experienceEntries.length < 6) {
      const title = lines[i];
      if (DATE_RE.test(title) || looksLikeLocation(title)) { i++; continue; }
      const company = lines[i + 1] || null;
      const dur = lines[i + 2] || null;
      experienceEntries.push({
        title,
        company: company ? company.split('·')[0].trim() : null,
        duration: dur && DURATION_RE.test(dur) ? dur : null
      });
      i += looksLikeLocation(lines[i + 3]) ? 4 : 3;
    }
  }

  const currentEntry = experienceEntries[0] || null;
  const currentTitle = currentEntry?.title || extractFromHeadline(headline, 'title');
  const currentCompany = currentEntry?.company || extractFromHeadline(headline, 'company');
  const pastCompanies = [...new Set(
    experienceEntries.slice(1).map(e => e.company).filter(c => c && c !== currentCompany)
  )];

  // ── SKILLS ──
  const skills = [...new Set(leafTexts(getSection('Skills')).filter(t =>
    t !== 'Skills' && t.length < 60 &&
    !/\d|endorse/i.test(t) && !UI_NOISE_RE.test(t)
  ))];

  // ── EDUCATION ──
  const educationEntries = [];
  const eduLines = leafTexts(getSection('Education'), 'p, span[aria-hidden="true"]')
    .filter(t => t !== 'Education');
  for (let i = 0; i < eduLines.length; i += 3) {
    if (eduLines[i] && !DATE_RE.test(eduLines[i])) {
      educationEntries.push({ school: eduLines[i], detail: eduLines[i + 1] || '' });
    }
  }

  // ── RECENT POSTS ──
  const recentPosts = [];
  leafTexts(getSection('Activity'))
    .filter(t => t.length > 40 && t.length < 500 && !UI_NOISE_RE.test(t))
    .forEach(t => { if (!recentPosts.includes(t)) recentPosts.push(t); });

  return {
    name,
    headline,
    currentTitle,
    currentCompany,
    location,
    about,
    recentPosts: recentPosts.slice(0, 3),
    experienceEntries: experienceEntries.slice(0, 5),
    pastCompanies: pastCompanies.slice(0, 4),
    educationEntries: educationEntries.slice(0, 3),
    skills: skills.slice(0, 10),
    profileUrl: window.location.href.split('?')[0],
    rawTitle: document.title
  };
}

function extractFromHeadline(headline, field) {
  if (!headline) return null;
  const atMatch = headline.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|·].*)?$/i);
  if (atMatch) return field === 'title' ? atMatch[1].trim() : atMatch[2].trim();
  const pipeMatch = headline.match(/^(.+?)\s*[|·]\s*(.+)$/);
  if (pipeMatch) return field === 'title' ? pipeMatch[1].trim() : pipeMatch[2].trim();
  return null;
}

// ─── Inserting into LinkedIn ──────────────────────────────────────────────────

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

// Find the box the user most likely wants to fill, in priority order:
//   1. "Add a note" textarea in the Connect / invite dialog
//   2. An open messaging window (the most recently opened one)
//   3. Any other visible text box inside a dialog
function findComposer() {
  const noteBox = Array.from(document.querySelectorAll(
    'textarea#custom-message, textarea[name="message"], [role="dialog"] textarea'
  )).filter(isVisible);
  if (noteBox.length) return { el: noteBox[noteBox.length - 1], kind: 'connection-note' };

  const msgBox = Array.from(document.querySelectorAll(
    '.msg-form__contenteditable[contenteditable="true"], [contenteditable="true"][role="textbox"]'
  )).filter(isVisible);
  if (msgBox.length) return { el: msgBox[msgBox.length - 1], kind: 'message' };

  return null;
}

function currentText(el) {
  return (el.tagName === 'TEXTAREA' ? el.value : el.innerText || '').trim();
}

function insertMessage(text, replace) {
  const target = findComposer();
  if (!target) return { ok: false, reason: 'noComposer' };

  const { el, kind } = target;
  const maxLength = el.tagName === 'TEXTAREA' && el.maxLength > 0 ? el.maxLength : null;

  // LinkedIn's own limit wins — tell the popup instead of silently truncating.
  if (maxLength && text.length > maxLength) {
    return { ok: false, reason: 'tooLong', kind, maxLength };
  }
  // Never overwrite something the user already typed without asking.
  if (!replace && currentText(el).length > 0) {
    return { ok: false, reason: 'notEmpty', kind, maxLength };
  }

  el.focus();
  if (el.tagName === 'TEXTAREA') {
    // Use the native setter so LinkedIn's framework sees the change.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('insertText', false, text);
    if (!ok || currentText(el).length === 0) {
      // Fallback: write paragraphs directly and announce the change.
      el.innerHTML = text.split('\n').map(line =>
        `<p>${line ? line.replace(/&/g, '&amp;').replace(/</g, '&lt;') : '<br>'}</p>`
      ).join('');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }
  return { ok: true, kind, maxLength };
}
