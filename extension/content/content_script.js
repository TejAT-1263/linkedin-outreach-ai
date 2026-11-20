'use strict';

// content/content_script.js — runs on linkedin.com (classic script; content scripts can't be modules).
//   scrapeProfile → read the profile + report which sections were found (read check)
//   insertMessage → put a draft into the open "Add a note" box or message box
//
// All LinkedIn-specific selectors live in SELECTORS. When LinkedIn changes its markup,
// this is the one place to update — and the read check in the popup tells you when.

(() => {
  if (window.__outreachAiLoaded) return; // injected twice (manifest + scripting fallback)
  window.__outreachAiLoaded = true;

  const SELECTORS = {
    name: 'main h1, h1',
    topCard: 'main section:first-of-type, section',
    topCardLines: 'p, div.text-body-medium, span.text-body-small',
    section: 'section',
    sectionHeading: 'h2',
    // LinkedIn marks profile sections with anchor ids — language-independent, preferred over headings.
    anchors: { about: 'about', experience: 'experience', education: 'education', skills: 'skills', activity: 'content_collections' },
    headings: { about: 'About', experience: 'Experience', education: 'Education', skills: 'Skills', activity: 'Activity' },
    leafText: 'p, span[aria-hidden="true"]',
    noteBox: ['textarea#custom-message', 'textarea[name="message"]', '[role="dialog"] textarea'],
    messageBox: ['.msg-form__contenteditable[contenteditable="true"]', '[contenteditable="true"][role="textbox"]']
  };

  const DATE_RE = /^(\d{4}|present|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
  const DURATION_RE = /\d{4}|present|\byrs?\b|\bmos?\b/i;
  const WORKPLACE_RE = /\b(remote|hybrid|on-?site)\b/i;
  const UI_NOISE_RE = /dialog|window|escape|cancel|close|beginning|notifications|premium|people you may|you might|show all|see all|followers?$|connections?$|endorse/i;
  const TITLE_WORDS_RE = /manager|engineer|analyst|developer|designer|founder|director|lead|specialist|consultant|intern|fellow|student|head|vp|chief|officer|recruiter|partner|scientist|researcher|architect|product|marketing|sales|teacher|professor/i;

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.action === 'ping') { sendResponse({ ok: true }); return false; }
    if (msg?.action === 'scrapeProfile') {
      scrapeWithScroll()
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (msg?.action === 'insertMessage') {
      try { sendResponse(insertMessage(String(msg.text || ''), !!msg.replace)); }
      catch (err) { sendResponse({ ok: false, reason: 'error', error: err.message }); }
      return false;
    }
    return false;
  });

  // ─── Scraping ───────────────────────────────────────────────────────────────
  async function scrapeWithScroll() {
    // Lower sections lazy-load; scroll to trigger them, then put the user back.
    const startY = window.scrollY;
    const maxY = Math.max((document.body?.scrollHeight || 0) - window.innerHeight, 0);
    for (const y of [800, 1600, 2400].filter(y => y <= maxY + 800)) {
      window.scrollTo(0, y);
      await wait(450);
    }
    window.scrollTo(0, startY);
    await wait(150);
    return scrapeProfile();
  }

  function leafTexts(root, selector = 'p, span') {
    if (!root) return [];
    return Array.from(root.querySelectorAll(selector))
      .filter(el => el.children.length === 0)
      .map(el => clean(el.innerText || el.textContent))
      .filter(t => t.length > 2 && !/^[·•\s]+$/.test(t));
  }

  function findSection(key) {
    const anchor = document.getElementById(SELECTORS.anchors[key]);
    if (anchor) return anchor.closest(SELECTORS.section) || anchor.parentElement;
    const heading = SELECTORS.headings[key].toLowerCase();
    return Array.from(document.querySelectorAll(SELECTORS.section)).find(s =>
      clean(s.querySelector(SELECTORS.sectionHeading)?.innerText || s.querySelector(SELECTORS.sectionHeading)?.textContent).toLowerCase().startsWith(heading)
    ) || null;
  }

  function looksLikeLocation(t) {
    if (!t || t.length > 70 || /\d/.test(t) || t.includes('|') || t.includes('@')) return false;
    return WORKPLACE_RE.test(t) || /^[\p{L} .'-]+,\s*[\p{L} .'-]+/u.test(t);
  }

  function scrapeProfile() {
    const name = clean(document.querySelector(SELECTORS.name)?.innerText) || clean(document.title.split('|')[0]);
    const h1 = document.querySelector(SELECTORS.name);
    const topCard = h1 ? (h1.closest(SELECTORS.section) || h1.parentElement?.parentElement) : null;

    // Headline + location from the top card
    let headline = '';
    let location = '';
    if (topCard) {
      const lines = [...new Set(leafTexts(topCard, SELECTORS.topCardLines))]
        .filter(t => t !== name && !/connections?|followers?|contact info|^he\/him|^she\/her|^they\/them/i.test(t));
      headline = lines.find(t => t.length > 5 && (t.includes('|') || t.includes('@') || TITLE_WORDS_RE.test(t))) || lines.find(t => t.length > 5) || '';
      location = lines.find(t => t !== headline && looksLikeLocation(t)) || '';
    }

    const sections = {
      about: findSection('about'), experience: findSection('experience'), education: findSection('education'),
      skills: findSection('skills'), activity: findSection('activity')
    };

    const about = leafTexts(sections.about).find(t => t.length > 80) || '';

    // Experience: title, company · type, dates, [location]
    const experienceEntries = [];
    const expLines = [...dedupeAdjacent(leafTexts(sections.experience, SELECTORS.leafText))].filter(t => t !== 'Experience');
    for (let i = 0; i < expLines.length && experienceEntries.length < 6;) {
      const title = expLines[i];
      if (DATE_RE.test(title) || looksLikeLocation(title) || UI_NOISE_RE.test(title)) { i++; continue; }
      const company = expLines[i + 1] || '';
      const dur = expLines[i + 2] || '';
      experienceEntries.push({
        title,
        company: company.split('·')[0].trim(),
        duration: DURATION_RE.test(dur) ? dur : ''
      });
      i += looksLikeLocation(expLines[i + 3]) ? 4 : 3;
    }

    const current = experienceEntries[0] || null;
    const currentTitle = current?.title || fromHeadline(headline, 'title');
    const currentCompany = current?.company || fromHeadline(headline, 'company');
    const pastCompanies = [...new Set(experienceEntries.slice(1).map(e => e.company).filter(c => c && c !== currentCompany))];

    const skills = [...new Set(leafTexts(sections.skills).filter(t =>
      t !== 'Skills' && t.length < 60 && !/\d/.test(t) && !UI_NOISE_RE.test(t)))];

    const educationEntries = [];
    const eduLines = [...dedupeAdjacent(leafTexts(sections.education, SELECTORS.leafText))].filter(t => t !== 'Education');
    for (let i = 0; i < eduLines.length; i += 3) {
      if (eduLines[i] && !DATE_RE.test(eduLines[i])) educationEntries.push({ school: eduLines[i], detail: eduLines[i + 1] || '' });
    }

    const recentPosts = [...new Set(leafTexts(sections.activity).filter(t => t.length > 40 && t.length < 500 && !UI_NOISE_RE.test(t)))];

    // Read check: which parts did we actually find?
    const found = {
      name: !!name, headline: !!headline, location: !!location, about: !!about,
      experience: experienceEntries.length > 0, education: educationEntries.length > 0,
      skills: skills.length > 0, activity: recentPosts.length > 0
    };
    const foundCount = Object.values(found).filter(Boolean).length;
    // "Layout changed" = the essentials are missing even though the page clearly is a profile.
    const layoutSuspect = !found.name || (!found.headline && !found.experience);

    return {
      name, headline, currentTitle, currentCompany, location, about,
      recentPosts: recentPosts.slice(0, 3),
      experienceEntries: experienceEntries.slice(0, 5),
      pastCompanies: pastCompanies.slice(0, 4),
      educationEntries: educationEntries.slice(0, 3),
      skills: skills.slice(0, 10),
      profileUrl: location_href(),
      diagnostics: { found, foundCount, total: Object.keys(found).length, layoutSuspect }
    };
  }

  // LinkedIn renders visible + screen-reader copies of the same text side by side.
  function* dedupeAdjacent(lines) {
    let prev = null;
    for (const l of lines) { if (l !== prev) yield l; prev = l; }
  }

  function location_href() { return window.location.href.split(/[?#]/)[0]; }

  function fromHeadline(headline, field) {
    if (!headline) return '';
    const at = headline.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|·].*)?$/i);
    if (at) return (field === 'title' ? at[1] : at[2]).trim();
    const pipe = headline.match(/^(.+?)\s*[|·]\s*(.+)$/);
    if (pipe) return (field === 'title' ? pipe[1] : pipe[2]).trim();
    return '';
  }

  // ─── Insert ─────────────────────────────────────────────────────────────────
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function findAll(list) {
    return list.flatMap(sel => Array.from(document.querySelectorAll(sel))).filter(isVisible);
  }

  // Priority: invite note → most recent message window.
  function findComposer() {
    const note = findAll(SELECTORS.noteBox);
    if (note.length) return { el: note[note.length - 1], kind: 'connection-note' };
    const msg = findAll(SELECTORS.messageBox);
    if (msg.length) return { el: msg[msg.length - 1], kind: 'message' };
    return null;
  }

  const currentText = (el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText || '').trim();

  function insertMessage(text, replace) {
    const target = findComposer();
    if (!target) return { ok: false, reason: 'noComposer' };
    const { el, kind } = target;
    const maxLength = el.tagName === 'TEXTAREA' && el.maxLength > 0 ? el.maxLength : null;

    if (maxLength && text.length > maxLength) return { ok: false, reason: 'tooLong', kind, maxLength };
    if (!replace && currentText(el).length > 0) return { ok: false, reason: 'notEmpty', kind, maxLength };

    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text); // native setter so LinkedIn's framework sees the change
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
        el.replaceChildren(...text.split('\n').map(line => {
          const p = document.createElement('p');
          if (line) p.textContent = line; else p.appendChild(document.createElement('br'));
          return p;
        }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }
    const inserted = currentText(el).replace(/\s+/g, ' ');
    const verified = inserted.includes(text.replace(/\s+/g, ' ').slice(0, 40));
    return { ok: verified, reason: verified ? undefined : 'notVerified', kind, maxLength };
  }
})();
