# Changelog

Two rounds of work on the original v3.1.0 extension:
- **v3.2.0**: fix what was broken, make it honest, make the messages fit LinkedIn, insert into LinkedIn. (Original audit and steps at the bottom.)
- **v3.3.0**: production-grade structure, follow-up tracking, profile read check, templates, dark mode, tests and CI.

Each step is also a commit: `git log --oneline`.

---

## v3.3.0

### Step 5 — Production-grade structure
**Why:** v3.2 worked, but it was two 500-line files with storage calls scattered across both. That makes it hard to test, easy to corrupt data, and painful to change when LinkedIn does.

**What:**
- Split into ES modules: `shared/` (constants + pure text helpers), `background/` (router + one module per concern), `content/`, and `popup/` (one module per tab). The service worker runs as `"type": "module"`.
- **Router** (`background/router.js`): one entry point. It checks that the sender is our own popup, rejects unknown actions, validates and length-caps every input, and returns user-safe errors. Unexpected errors are logged and masked.
- **Storage layer** (`background/store.js`): the only code that touches `chrome.storage`. Every read-modify-write runs through a lock, so the popup and the hourly alarm can't overwrite each other.
- **Schema v2 + migrations** (`background/migrate.js`): upgrades data from the original v3.1 and from v3.2 automatically. Contacts are now keyed by profile (`in:<slug>`), so no duplicates. The PDF the original stored is deleted.
- **API client** (`background/anthropic.js`): 30 s timeout, up to 2 retries with exponential backoff and jitter, honours `Retry-After`, never retries auth errors, and gives clear error messages.
- **The API key never goes back to the UI.** The popup only sees `hasKey` and a masked hint (`sk-ant-…1234`).
- **Strict Content Security Policy.** No `innerHTML` with data anywhere in the popup.
- **Draft session** moved to `chrome.storage.session`: in memory and cleared when the browser closes.

### Step 6 — Follow-ups and reply tracking (new Tracker tab)
**Why:** most replies on LinkedIn come after a follow-up, and the extension forgot people the moment you closed it.

**What:**
- Each person moves through **Draft → Copied → Inserted → Sent → Replied**. Insert sets it automatically; you mark Sent or Replied with one click (the extension never presses Send, so it can't know).
- **Reminders:** after N days without a reply (default 5, set in Settings), the person moves to *Due*. The toolbar icon shows a **badge count**, an optional desktop notification fires once per due cycle, and clicking it opens their profile. Later follow-ups wait longer (5 → 7 → 9 days) and stop after 3.
- **Write follow-up:** a short follow-up that refers to the original note. The second one offers a polite way out. Built-in or AI. Copy it, open the profile, and **Mark as sent** to log it.
- **Stats:** reached out, replied, reply rate, plus an insight line showing which kind of opener gets replies (e.g. "Common ground — 2 of 3 replied").
- **Search, filters** (All / Due / Waiting / Replied / Drafts), **paging**, and **CSV export** (opens correctly in Excel and is safe against formula injection).
- **"Already contacted" banner** on the Write tab when you open someone you've written to before.

### Step 7 — Profile read check
**Why:** LinkedIn changes its markup often. When the scraper breaks, the old version silently produced generic messages.

**What:**
- The content script reports which of 8 parts it found (name, headline, location, about, experience, education, skills, recent posts). The popup shows a **"6/8 read"** pill; click it for the list.
- If the essentials are missing (no headline *and* no experience), a **layout-change warning** explains that drafts will be generic.
- Sections are found by LinkedIn's anchor ids first (language-independent), then by heading text. All selectors live in one `SELECTORS` block.
- Insert now **checks the text actually landed**. If LinkedIn rejected it, the draft is copied and you're told to paste.

### Step 8 — Saved templates
**What:** **☆ Save as template** on any draft. Their name, company and title, your name, and the opening detail become `{firstName}`, `{company}`, `{title}`, `{myName}` and `{hook}`. Pick a template from the menu above the draft and it's filled in for the next person, with sensible fallbacks for missing values. Templates for the current purpose are listed first. Manage or delete them in Settings, where usage counts are shown.

### Step 9 — Dark mode and polish
- **Theme:** System / Light / Dark, built on a full set of colour variables (contrast checked by eye in both themes).
- **Shortcuts:** `Alt+Shift+O` opens the extension; `Ctrl/⌘+Enter` inserts; `Alt+N` writes a new version.
- **Accessibility:** proper tab roles, arrow-key navigation, visible focus rings, `aria-live` status messages, labelled icon buttons, and `prefers-reduced-motion` respected.
- **Feel:** loading skeleton while reading, subtle fade-ins, toasts, a two-click confirm on destructive actions (no blocking dialogs), and a grouped Settings page.

### Step 10 — Tooling, tests, CI
- `npm run lint`: ESLint 9 (flat config). Clean.
- `npm test`: **48 unit tests** (Node's built-in runner). Covers text helpers, hooks, the built-in writer (180-draft limit matrix), templates, tracker maths, migrations, API retry/timeout, AI prompts, and the router end to end with a mock Chrome (lifecycle, lock under concurrency, paging, CSV, badge, notifications, reset).
- `npm run test:e2e`: **14-step Playwright run** in real Chrome with the extension loaded and linkedin.com routed to mock pages. It also asserts there are zero console errors and saves the screenshots.
- `npm run package`: validates the manifest (version match, every referenced file exists) and builds `dist/linkedin-outreach-ai-v3.3.0.zip` (about 61 KB).
- `.github/workflows/ci.yml`: lint → unit → e2e → package, with the zip and screenshots uploaded as build artifacts.

### Found and fixed by the new tests
- Applying a template with an empty `{hook}` left a stray leading space.
- `"SQL"` would have matched `"PostgreSQL"` as common ground. Matching is now whole-word.
- The toolbar badge could be up to an hour stale. It now refreshes whenever the popup opens.

### Not verified (needs a manual check before the demo)
- **The live LinkedIn DOM.** The e2e suite runs against mock pages shaped like LinkedIn's.
- **Real Anthropic API calls.** There was no key in the test environment; the AI path is unit-tested against a stub.
- **The GitHub Actions run.** The workflow is included but hasn't run on GitHub. Locally I used system Chrome via `CHROME_PATH`.

---

## v3.2.0 (from the original v3.1.0)

A step-by-step log of what I changed, why, and how. The brief was "improve, don't rebuild", so the architecture is the same (popup → background service worker → content script). I fixed what was broken, removed what was misleading, and made the core job — getting a reply — work better.

---

### Step 0 — Audit (before touching code)

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

### Step 1 — Make it install and work

**Icons** — generated a simple 16/48/128 px icon (`tests/make_icons.py`) and added `action.default_icon`.

**Recent tab without the missing `cache.js`** — the background already had half-built `SAVE_RECENT`/`GET_RECENT` handlers, so I finished that path instead of recreating a missing file:
- One router in `background.js`, `{ action, payload } → { success, data | error }`, replacing two inconsistent message styles (`action` vs `type`, `success` vs `status`).
- Added `saveRecent`, `updateRecent`, `getRecent`, `clearRecent`. Capacity went from 5 to 20.
- Each entry has a **status** (Drafted → Copied → Inserted), so Recent doubles as a simple outreach log. Added **Open profile** to jump back.

**Layout bug** — the popup now has a fixed height. The tab body is a `flex:1; min-height:0; overflow-y:auto` region, so it always scrolls instead of clipping.

**Draft survives the popup closing** — the current profile, hooks and draft are saved per profile URL (`session` in storage, expires after 6 h) and restored when you reopen the popup on the same profile. This is what makes Step 4 usable.

Purpose, tone and format choices are remembered between uses.

### Step 2 — Make "Deep Mode" honest, then useful

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

### Step 3 — Messages that fit LinkedIn and sound human

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

### Step 4 — Insert into LinkedIn

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

### Smaller fixes

- The scraper restores your scroll position and works out location for any country (no hard-coded city list). Headline/role extraction handles `Title @ Company`.
- The content script guards against being injected twice.
- Cleaned the CSS: removed duplicated resume/upload blocks, unused provider/password/pipeline styles, and `text-transform: uppercase` on the API key field.
- `esc()` now escapes quotes. The Recent list uses event delegation instead of per-index IDs.

*(v3.2's test notes and file list are superseded by v3.3: see the README for the current layout and test commands. The v3.2 "what next" list (follow-up reminders, reply tracking, selector health check) was built in v3.3.)*
