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
    // 2026 layout: the name is an <h2> in the top card; older layouts used <h1>.
    name: 'main h1, h1',
    nameCandidates: 'main h1, main h2, h1, h2',
    // 2026 layout scrolls inside <main id="workspace">, not the window.
    scroller: '#workspace, main',
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

  /** The element that actually scrolls the profile (LinkedIn moved this off the window in 2026). */
  function findScroller() {
    const scrollable = (el) => {
      if (!el) return false;
      const oy = getComputedStyle(el).overflowY;
      return /(auto|scroll)/.test(oy) && el.scrollHeight > el.clientHeight + 50;
    };
    for (const el of document.querySelectorAll(SELECTORS.scroller)) {
      if (scrollable(el)) return el;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (scrollable(a)) return a;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function scrapeWithScroll() {
    // Lower sections lazy-load as they come into view: scroll the real container in
    // viewport-sized steps until nothing new loads, then put the user back where they were.
    const sc = findScroller();
    const startY = sc.scrollTop;
    // Bounded: at most 12 viewport-sized steps (~3.6 s) — enough for a full profile.
    const step = Math.max(400, sc.clientHeight || window.innerHeight);
    for (let y = step, i = 0; y < sc.scrollHeight + step && i < 12; y += step, i++) {
      sc.scrollTop = y;
      await wait(300);
    }
    sc.scrollTop = startY;
    await wait(150);
    return scrapeProfile();
  }

  // Inline-only text blocks: paragraphs/spans whose content is text with line breaks,
  // hashtags or links — how LinkedIn renders About text and posts in the 2026 layout.
  // BUTTON is allowed because LinkedIn puts its "…more" toggle inside the text element;
  // its label is stripped from the result.
  const INLINE = new Set(['BR', 'STRONG', 'EM', 'B', 'I', 'A', 'SPAN', 'U', 'MARK', 'SMALL', 'WBR', 'BUTTON']);
  function blockText(el) {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('button').forEach(b => b.remove());
    copy.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
    return undouble(clean(copy.textContent));
  }
  /** LinkedIn sometimes renders a visible and a screen-reader copy in one element: "AB AB" → "AB". */
  function undouble(t) {
    const mid = Math.floor(t.length / 2);
    for (const k of [mid, mid + 1, mid - 1]) {
      const a = t.slice(0, k).trim();
      if (a.length > 10 && a === t.slice(k).trim()) return a;
    }
    return t;
  }
  function textBlocks(root, min = 40) {
    if (!root) return [];
    const blocks = Array.from(root.querySelectorAll('p, span'))
      .filter(el => Array.from(el.querySelectorAll('*')).every(d => INLINE.has(d.tagName) || d.closest('button')))
      .map(blockText)
      .filter(t => t.length >= min);
    // Drop blocks that are just a piece of a longer block.
    return [...new Set(blocks)].filter((t, _, all) => !all.some(o => o !== t && o.length > t.length && o.includes(t)));
  }

  /** Name from the tab title, minus LinkedIn's "(3) " notification counter. */
  function nameFromTitle() {
    return clean(document.title.replace(/^\(\d+\+?\)\s*/, '').split('|')[0]);
  }

  function findNameHeading() {
    const h1 = document.querySelector(SELECTORS.name);
    if (h1 && clean(h1.innerText || h1.textContent)) return h1;
    const want = nameFromTitle().toLowerCase();
    const heads = Array.from(document.querySelectorAll(SELECTORS.nameCandidates));
    return heads.find(h => want && clean(h.innerText || h.textContent).toLowerCase() === want) || null;
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
    const nameEl = findNameHeading();
    const name = clean(nameEl?.innerText || nameEl?.textContent) || nameFromTitle();
    const topCard = nameEl ? (nameEl.closest(SELECTORS.section) || nameEl.parentElement?.parentElement) : null;

    // Headline + location from the top card
    let headline = '';
    let location = '';
    if (topCard) {
      const lines = [...new Set(leafTexts(topCard, SELECTORS.topCardLines))]
        .filter(t => t !== name && !/connections?|followers?|contact info|^he\/him|^she\/her|^they\/them/i.test(t));
      headline = lines.find(t => t.length > 5 && (t.includes('|') || t.includes('@') || TITLE_WORDS_RE.test(t))) || lines.find(t => t.length > 5) || '';
      location = lines.find(t => t !== headline && looksLikeLocation(t)) || locationBeforeContactInfo(topCard, name, headline);
    }

    const sections = {
      about: findSection('about'), experience: findSection('experience'), education: findSection('education'),
      skills: findSection('skills'), activity: findSection('activity')
    };

    const aboutBlocks = textBlocks(sections.about, 80).filter(t => !/^top skills\b/i.test(t));
    const about = aboutBlocks.sort((a, b) => b.length - a.length)[0] || leafTexts(sections.about).find(t => t.length > 80) || '';
    // "Top skills" line inside About ("A • B • C") — often richer than the trimmed Skills section.
    const topSkillsLabel = sections.about && Array.from(sections.about.querySelectorAll('p, span, div'))
      .find(el => clean(el.innerText || el.textContent).toLowerCase() === 'top skills');
    const topSkills = topSkillsLabel?.nextElementSibling
      ? clean(topSkillsLabel.nextElementSibling.innerText || topSkillsLabel.nextElementSibling.textContent).split(/\s*[•·]\s*/).filter(t => t && t.length < 60)
      : [];

    // Experience: title, company · type, dates, [location]. Entries are read one container
    // at a time when LinkedIn wraps them (it does); flat markup falls back to a 3-line stride.
    const experienceEntries = [];
    const expGroups = entryGroups(sections.experience, 'Experience');
    if (expGroups) {
      for (const g of expGroups) experienceEntries.push(...parseExperienceGroup(g));
    } else {
      const expLines = flatLines(sections.experience, 'Experience');
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
    }

    const current = experienceEntries[0] || null;
    const currentTitle = current?.title || fromHeadline(headline, 'title');
    const currentCompany = current?.company || fromHeadline(headline, 'company');
    const pastCompanies = [...new Set(experienceEntries.slice(1).map(e => e.company).filter(c => c && c !== currentCompany))];

    const skills = [...new Set([...topSkills, ...leafTexts(sections.skills).filter(t =>
      !/^skills\b/i.test(t) && t.length < 60 && !/\d/.test(t) && !UI_NOISE_RE.test(t))])];

    const educationEntries = [];
    const eduGroups = entryGroups(sections.education, 'Education');
    if (eduGroups) {
      for (const [school, detail] of eduGroups) {
        if (school && !DATE_RE.test(school)) educationEntries.push({ school, detail: detail && !DATE_RE.test(detail) ? detail : '' });
      }
    } else {
      const eduLines = flatLines(sections.education, 'Education');
      for (let i = 0; i < eduLines.length; i += 3) {
        if (eduLines[i] && !DATE_RE.test(eduLines[i])) educationEntries.push({ school: eduLines[i], detail: eduLines[i + 1] || '' });
      }
    }

    const postBlocks = textBlocks(sections.activity, 40);
    const recentPosts = [...new Set((postBlocks.length ? postBlocks : leafTexts(sections.activity))
      // The author byline on your own posts repeats the headline: that isn't a post.
      .filter(t => t.length > 40 && t.length < 3000 && t !== headline && !UI_NOISE_RE.test(t) && !/\bfollowers?\b/i.test(t)))];

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
      rawText: profileText(topCard, sections),
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

  /**
   * Single-name places ("United States", "Singapore", "Greater Seattle Area") have no comma,
   * so looksLikeLocation can't recognise them. LinkedIn always prints the location directly
   * before the "Contact info" link, so take that line when it is plausibly a place.
   */
  function locationBeforeContactInfo(topCard, name, headline) {
    const leaves = Array.from(topCard.querySelectorAll('p, span, a, div'))
      .filter(el => el.children.length === 0)
      .map(el => clean(el.innerText || el.textContent))
      .filter(t => t && !/^[·•\s]+$/.test(t));
    const at = leaves.findIndex(t => /^contact info$/i.test(t));
    const prev = at > 0 ? leaves[at - 1].replace(/\s*·\s*$/, '') : '';
    const plausible = prev && prev !== name && prev !== headline && prev.length <= 60 &&
      /^[\p{L}][\p{L} .,'()-]*$/u.test(prev) && !TITLE_WORDS_RE.test(prev);
    return plausible ? prev : '';
  }

  /**
   * The profile's own visible text (top card + its sections, no sidebar or ads) for Deep Mode's
   * parser. Falls back to the whole main column when the sections can't be found. Bounded.
   */
  const RAW_TEXT_MAX = 15000;
  function profileText(topCard, sections) {
    const els = [topCard, ...Object.values(sections)].filter(Boolean);
    const roots = els.filter((el, i) => !els.some((o, j) => j !== i && o !== el && o.contains(el)));
    const textOf = (el) => String(el.innerText || el.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    let out = [...new Set(roots)].map(textOf).filter(Boolean).join('\n\n');
    if (out.length < 40) out = textOf(document.querySelector('main') || document.body); // nothing recognisable
    return out.slice(0, RAW_TEXT_MAX);
  }

  function flatLines(root, heading) {
    return [...dedupeAdjacent(leafTexts(root, SELECTORS.leafText))].filter(t => t !== heading);
  }

  /**
   * Split a section into one line-list per entry, using the DOM: walk down from the section
   * until the text lines first fall into different containers. Those containers are the
   * entries (LinkedIn wraps each job/school in its own block). Returns null when the markup
   * has no per-entry containers (every line in its own element), so callers use the stride.
   */
  function entryGroups(root, heading) {
    if (!root) return null;
    const leaves = Array.from(root.querySelectorAll(SELECTORS.leafText))
      .filter(el => el.children.length === 0)
      .map(el => ({ el, text: clean(el.innerText || el.textContent) }))
      .filter(l => l.text.length > 2 && !/^[·•\s]+$/.test(l.text) && l.text !== heading && !UI_NOISE_RE.test(l.text));
    if (!leaves.length) return null;
    const chains = leaves.map(({ el }) => {
      const c = [];
      for (let a = el; a && a !== root; a = a.parentElement) c.unshift(a);
      return c;
    });
    const maxDepth = Math.max(...chains.map(c => c.length));
    for (let d = 0; d < maxDepth; d++) {
      const groups = new Map();
      chains.forEach((c, i) => {
        const key = c[d] || leaves[i].el;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(leaves[i].text);
      });
      if (groups.size < 2) continue;
      const lists = [...groups.values()].map(g => [...dedupeAdjacent(g)]);
      const multi = lists.filter(g => g.length >= 2).length;
      if (multi >= 2) return lists;
      // One wrapped entry splitting into its own parts (title block, dates…): read it as one.
      if (multi === 1) return [[...dedupeAdjacent(leaves.map(l => l.text))]];
      return null; // every line in its own element: flat markup
    }
    return null;
  }

  // "Full-time · 9 yrs", "4 yrs 2 mos": the company-level line above several roles at one company.
  const TENURE_RE = /^(?:[\p{L}-]+(?:\s[\p{L}-]+)?\s*·\s*)?\d+\s*(?:yrs?|mos?)(?:\s+\d+\s*mos?)?$/iu;

  function parseExperienceGroup(lines) {
    if (!lines.length || DATE_RE.test(lines[0]) || looksLikeLocation(lines[0])) return [];
    if (lines.length > 2 && TENURE_RE.test(lines[1] || '')) {
      // One company, several roles: company, tenure, [location], then title + dates pairs.
      const company = lines[0];
      const roles = [];
      for (let i = 2; i < lines.length; i++) {
        const t = lines[i];
        if (DATE_RE.test(t) || TENURE_RE.test(t) || looksLikeLocation(t) || t.length > 100) continue;
        const dur = lines.slice(i + 1, i + 3).find(l => DATE_RE.test(l) && DURATION_RE.test(l)) || '';
        roles.push({ title: t, company, duration: dur });
        if (dur) i = lines.indexOf(dur, i + 1);
      }
      if (roles.length) return roles;
    }
    const dur = lines.slice(2, 4).find(l => DATE_RE.test(l) && DURATION_RE.test(l)) || '';
    return [{ title: lines[0], company: (lines[1] || '').split('·')[0].trim(), duration: dur }];
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
