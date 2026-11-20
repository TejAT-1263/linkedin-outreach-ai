# LinkedIn Outreach AI — v3.1.0 → v3.2.0

A step-by-step log of what I changed, why, and how. The brief was "improve, don't rebuild", so the architecture is the same (popup → background service worker → content script). I fixed what was broken, removed what was misleading, and made the core job — getting a reply — work better.

---

## Step 0 — Audit (before touching code)

I read every file and used the extension the way a user would. Findings, worst first:

| # | Problem | Evidence in the original code | Impact |
|---|---|---|---|
| 1 | **Missing files** | `popup.html` loads `utils/cache.js`; `manifest.json` points to `icons/icon16/48/128.png`. Both folders were empty in the shared copy. | Chrome rejects a manifest whose icons are missing. Even with icons, `Cache` is undefined, so every generation ends in an error and the Recent tab never loads. |
| 2 | **Deep Mode is theatre** | UI says "OpenAI — Profile Parser" and "OpenAI — Web Enrichment: searches company news". The code makes no OpenAI call, `companyNews` is always `[]`, and there's a `delay(300)` to look busy. | Misleads users about what happens to their data and what they're getting. Biggest taste issue. |
| 3 | **Resume upload does nothing** | Saved as base64 in storage, never read by any writer. | Dead feature; up to 4 MB stored for no reason. |
| 4 | **Messages ignore LinkedIn's limits** | AI prompt says "under 600 characters". Connection notes are capped (300, and lower on some free accounts). | Drafts get cut off or rejected inside LinkedIn. |
| 5 | **Generic free template** | "I came across your profile and was impressed by your work as…" | Exactly the message people ignore. |
| 6 | **Regenerate is a no-op in Free Mode** | `localMessage` is deterministic. | The button returns the same text. |
| 7 | **Popup clips content** | `body {max-height; overflow:hidden}` + `.app {height:100%}` of an auto-height parent. | Long drafts in Deep Mode get cut off with no scrollbar. |
| 8 | **Draft lost on close** | No state persistence. | Chrome closes the popup when you click into LinkedIn, e.g. to open "Add a note". You lose the draft. |
| 9 | **Copy-paste is the last step** | No way to put the text into LinkedIn. | Extra friction on every message. |
| 10 | Brittle scraping | Location detection hard-codes Indian city names; the scraper scrolls and leaves you at the top of the page. | Wrong data outside India; jarring UX. |
| 11 | Leftovers | Empty `#no-key-warning`, `checkLicenseStatus`, "messages left today" counter that's never set, unused `SAVE_RECENT`/`GET_RECENT` handlers, duplicated CSS blocks, API-key input styled `uppercase`. | Noise; signs of an unfinished migration. |

**What I chose to fix:** the things that stop it working (1, 7, 8), the things that are dishonest (2, 3), and the things that decide whether a message gets a reply (4, 5, 6, 9). I fixed 10 and 11 along the way because I was already in those files.

---

## Step 1 — Make it install and work

**Icons** — generated a simple 16/48/128 px icon (`tests/make_icons.py`) and added `action.default_icon`.

**Recent tab without the missing `cache.js`** — the background already had half-built `SAVE_RECENT`/`GET_RECENT` handlers, so I finished that path instead of recreating a missing file:
- One router in `background.js`, `{ action, payload } → { success, data | error }`, replacing two inconsistent message styles (`action` vs `type`, `success` vs `status`).
- Added `saveRecent`, `updateRecent`, `getRecent`, `clearRecent`. Capacity went from 5 to 20.
- Each entry has a **status** (Drafted → Copied → Inserted), so Recent doubles as a simple outreach log. Added **Open profile** to jump back.

**Layout bug** — the popup now has a fixed height. The tab body is a `flex:1; min-height:0; overflow-y:auto` region, so it always scrolls instead of clipping.

**Draft survives the popup closing** — the current profile, hooks and draft are saved per profile URL (`session` in storage, expires after 6 h) and restored when you reopen the popup on the same profile. This is what makes Step 4 usable.

Purpose, tone and format choices are remembered between uses.

## Step 2 — Make "Deep Mode" honest, then useful

**Removed** the fake 3-layer pipeline: the OpenAI labels, the L1/L2/L3 status dots, the artificial delay, the two-button scrape-then-generate flow, and the Quick/Deep toggle. Both modes ran the same local code, so there was nothing real to choose between.

**Replaced with one flow:** `Read profile & draft` → see the draft → adjust → Insert.

**"What to mention" (hook picker).** The profile is turned into specific, clickable hooks:
- ★ **Common ground** (highest priority): same company, same school, shared skills, same city. Found by comparing the profile with *your* background.
- A recent post, their role, a line from their About section, a past company, skills, education.
- **Add your own detail**: a free-text hook ("We met at the Pune product meetup") that gets used word for word.
- The two strongest are pre-selected. You can pick up to two; picking a third swaps out the oldest. In free mode the draft rewrites instantly. In AI mode it waits for you to click, so it doesn't spend API calls silently.

**Your background (Settings)** — new field: companies, schools, skills, city. This powers common-ground matching and is always visible and editable.

**The resume now does something.** With your API key, the PDF is sent once to Claude as a document. It extracts companies, schools, skills, city and a one-line bio, merges them into "Your background", and shows what it found. **The PDF itself is no longer stored.** Without a key it says so plainly and points you to the typed field.

**Header badge** tells the truth: `Built-in writer` (nothing leaves the device) or `AI · your key`. The settings note now says exactly when data is sent to Anthropic.

## Step 3 — Messages that fit LinkedIn and sound human

**Format selector:** Connect note (300) · Free-plan note (200) · Message (600 soft cap). Every writer respects the limit.

**Live character meter** under the draft header: `212 / 300`, with a bar that goes green → amber (>90%) → red (over).

**Built-in writer rewritten** (`localMessage` in `background.js`):
- Openers are built from the hooks you selected, with 2–3 phrasings per hook type. No "impressed by your profile".
- Purpose-specific asks (Networking / Job / Referral / Collaboration), plus short versions for tight limits.
- **Fit-to-limit:** it tries the richest version first, then drops optional parts in order (your bio line → second hook → full sign-off → short ask) until it fits. Last resort is a clean cut at a sentence boundary.
- **"↻ New version" really changes the draft:** a `variant` counter rotates the phrasing.
- Removed a template that claimed things the sender never said ("X has been on my radar").

**AI writer** (your key):
- A system prompt with rules: lead with one specific detail, never invent facts, no flattery clichés, one low-effort ask, obey the hard limit.
- The prompt includes the format, limit and the hooks you picked. On "New version" it gets the previous draft and is told to write something clearly different.
- If the reply is still over the limit, it gets one "shorten this" pass, then a safe cut as a last resort.
- Clearer API errors (401 → "key was rejected", 429 → "rate limited").

## Step 4 — Insert into LinkedIn

New **Insert into LinkedIn** button. The content script finds the box you most likely mean, in this order:
1. The **"Add a note"** textarea in the Connect dialog.
2. The most recently opened **messaging** box (contenteditable).
3. Any other visible text box inside a dialog.

Safety and edge cases:
- It **never overwrites** text you've already typed. The first click warns you, and the button becomes "Replace LinkedIn text" for a deliberate second click.
- It reads LinkedIn's **real `maxlength`** on the note box. If the draft is too long it tells you the actual limit, and suggests the 200 format if that's what LinkedIn enforces.
- **No open box** → it copies to the clipboard and tells you exactly where to click.
- Text is inserted with the native value setter / `insertText`, so LinkedIn's own UI registers the change. The extension **never clicks Send**. You review and send it yourself.
- On success, the Recent entry is marked **Inserted**.

## Smaller fixes

- The scraper restores your scroll position and works out location for any country (no hard-coded city list). Headline/role extraction handles `Title @ Company`.
- The content script guards against being injected twice.
- Cleaned the CSS: removed duplicated resume/upload blocks, unused provider/password/pipeline styles, and `text-transform: uppercase` on the API key field.
- `esc()` now escapes quotes. The Recent list uses event delegation instead of per-index IDs.

---

## How I tested it

| Test | What it checks | Result |
|---|---|---|
| `node --check` on all JS + manifest JSON parse | Syntax | Pass |
| `tests/unit.js` | 144 drafts (3 formats × 4 purposes × 3 tones × 4 variants) against the limit and for stray `undefined`/`null`; sparse profile; New version differs | 0 failures, 128 unique drafts |
| `tests/ai_unit.js` | AI path with a stubbed Anthropic API: system prompt, limit in prompt, shortening retry, resume document block, no-key error | Pass |
| `tests/e2e.js` (Playwright + real Chrome, extension loaded, linkedin.com routed to `tests/mock/profile.html`) | Read → hooks → auto-redraft → New version → format switch → Insert into note → replace guard → Insert into message box → copy fallback → session restore → Recent status → non-profile warning; no console errors | Pass |

**Not verified:** the live LinkedIn DOM (the e2e uses a mock page shaped like LinkedIn's), and real Anthropic API calls (no key in the test environment). Both need a manual check on a real profile before the demo. The LinkedIn selectors are the most likely thing to need a tweak, because LinkedIn changes its markup often.

Run the tests (Node 18+, Playwright, Chrome):
```
node tests/unit.js ./extension/background.js
node tests/ai_unit.js ./extension/background.js
node tests/e2e.js ./extension ./screenshots
```
(`popup.html?tabId=<id>` exists only so the e2e test can drive the popup as a normal page.)

## Files changed

| File | Change |
|---|---|
| `manifest.json` | v3.2.0, honest description, action icons |
| `icons/*` | **new** |
| `background.js` | single router; hooks + common ground; format-aware local writer; new AI prompt + shorten pass; resume reader; recent log; insert relay |
| `content_script.js` | scraper fixes; **new** `insertMessage` |
| `popup.html` | one flow; format selector; meter; hook picker; Insert button; background field; removed pipeline UI and `utils/cache.js` |
| `popup.js` | rewritten around the single flow + session restore |
| `popup.css` | layout fix, cleanup, styles for new components |

## What I'd do next

1. **Follow-up reminders**: Recent already knows who you inserted a note for. Nudge after 5 days with a follow-up draft.
2. **Reply-rate tracking**: mark "Replied" in Recent to learn which hooks and purposes work.
3. **Selector health check**: a tiny self-test that warns when LinkedIn's markup changes, instead of failing silently.
