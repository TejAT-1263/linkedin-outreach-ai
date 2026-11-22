# Testing

**236 automated tests in four layers**, all run by `npm run check` (≈95 s) and in CI. The full pipeline was run three times back to back with no flaky failures.

| Layer | Command | Runs in | Count | Coverage gate |
|---|---|---|---|---|
| Lint | `npm run lint` | Node | ESLint 9, 0 warnings | — |
| Unit | `npm test` | Node (`node:test`) + Chrome API mock with fault injection | 140 tests | **100% lines**, ≥95% branches/functions on `background/` + `shared/` + `popup/api.js` (currently 96% branches) |
| Content script | `npm run test:dom` | Real Chrome, LinkedIn-like pages | 26 tests | — |
| End-to-end | `npm run test:e2e` | Real Chrome + the unpacked extension, LinkedIn routed to mocks, **fake Anthropic and OpenAI APIs at network level** | 70 steps in 4 suites | **≥90% per popup module** (currently 95–100%) |
| Fuzz (extra) | `npm run test:fuzz` | Node, seeded PRNG | 5,000 cases/property | — |

Browser coverage comes from one Chrome DevTools profiler session over the extension's JavaScript engine, merged across suites (`scripts/coverage-report.mjs`). Use `node scripts/coverage-gaps.mjs popup/write.js` to list any line the browser never ran.

## Scenario matrix

### Reading a profile
| Scenario | Where |
|---|---|
| Full modern profile: all 8 parts parsed (name, headline, location, about, experience, education, skills, posts) | dom, e2e journey |
| Older layout (headings, no anchor ids) | dom |
| 2026 layout: name in `<h2>`, page scrolls inside `#workspace`, sections mount only when scrolled to, "…more" buttons inside text, doubled link-card text | dom |
| Jobs and schools read one container at a time: uneven entries (2–4 lines), a location without a comma ("Greater Seattle Area"), a school without dates, several roles at one company | dom |
| A single wrapped job/school is read as one entry, not split into its parts | dom |
| Non-English profile (German headings) via anchor ids | dom |
| Duplicated screen-reader text collapsed | dom |
| UI noise filtered ("Show all 24 skills", endorsements, connections, pronouns) | dom |
| Layout changed (only a name) → flagged `1/8`, warning shown, nothing invented | dom, e2e journey |
| No `<h1>` → name from page title | dom |
| Title/company from headline (`at`, `@`, `\|`, none) | dom |
| Locations worldwide; job titles not mistaken for places | dom |
| Single-name locations ("United States") read from the line before "Contact info"; a title there is not taken as a place | dom |
| The headline repeated as the author line on your own posts is not counted as a post | dom |
| Script-injection text on page stays inert text | dom |
| Unicode / RTL / emoji names | dom |
| URL query/hash stripped; user's scroll position restored | dom |
| 400-section page scraped in < 5 s with bounded output | dom |
| Non-LinkedIn tab, LinkedIn non-profile page, closed tab, stale tab id | unit, e2e |
| Content script missing → injected once and retried; injection blocked; still unreachable | unit |
| Content script hangs → 20 s timeout with a clear message (not stuck forever) | unit |
| Malformed page data (wrong types, huge strings) normalised | unit, fuzz |

### Writing
| Scenario | Where |
|---|---|
| 3 formats × 4 purposes × 3 tones × 5 variants: always within limit, no `undefined`/placeholders | unit (180-draft matrix) |
| 5,000 random hostile profiles per run (10 seeds × 2,000 checked during development) | fuzz |
| Common ground ranked first; whole-word matching (`SQL` ≠ `PostgreSQL`) | unit |
| Hook toggle redrafts; max 2 (third swaps oldest); custom detail used verbatim; empty ignored | unit, e2e |
| New version (button and `Alt+N`) always changes the text | unit, e2e |
| Format switch re-fits the draft | e2e |
| AI: prompt has limit + hooks + common-ground marker; regenerate sends the previous draft | unit, e2e |
| AI: changing options never spends an API call silently | e2e |
| AI: 429 → retried honouring `Retry-After`; 5xx ×3 → clear error, draft kept, buttons re-enabled | unit, e2e |
| AI: 401 / 403 / 400 / unknown status / empty content / non-JSON / network down / timeout | unit, e2e |
| AI: over-limit output → one shorten pass → hard fit | unit, e2e |
| No API key → zero network requests | e2e |

### Inserting into LinkedIn
| Scenario | Where |
|---|---|
| "Add a note" textarea: inserted, `input`+`change` fired, real `maxlength` reported | dom, e2e |
| Draft longer than LinkedIn's box → blocked with the real limit + "Free-plan note" hint | dom, e2e |
| Typed draft over the hard limit → blocked before touching LinkedIn | e2e |
| Box already has the user's text → never overwritten without a second click | dom, e2e |
| Message window (contenteditable), multi-line; latest visible window wins | dom, e2e |
| Hidden boxes ignored (`display:none`, `visibility:hidden`, zero size) | dom |
| Note dialog wins over an open chat | dom |
| `insertText` unavailable → safe paragraph fallback (markup stays text) | dom |
| Editor throws the text away → reported honestly + copied to the clipboard | dom, e2e |
| No box open → copied, with instructions | dom, e2e |
| Tab closed mid-flow → clear error | e2e |
| Insert/Copy disabled while reading or writing | e2e |

### Deep Mode (L1 OpenAI parser → L2 OpenAI web research → L3 writer)
| Scenario | Where |
|---|---|
| No OpenAI key → Deep Mode asks for it, sends nothing; Quick mode never calls OpenAI | unit, e2e |
| Full run: L1 → L2 → L3, each layer shows running / done with real detail; sources listed as safe links | unit, e2e |
| L1 values must appear in the page text: invented jobs, schools, skills and posts are dropped; mistakes such as a place used as a job title are fixed | unit |
| L2 items must cite a URL the web search returned (or its site); LinkedIn and non-https links dropped; tracking parameters ignored; max 3 per kind | unit |
| L1 fails → page-reader data used and L2 still runs; L2 fails or returns unreadable text → still drafts | unit, e2e |
| Rejected key / no credit / unknown model → L2 skipped (no second charge) with a clear reason | unit, e2e |
| Model rejects `reasoning`, `tool_choice` or `include` → retried once without it; cut-off answer → retried with a bigger budget | unit |
| Rate limit / 5xx / network → backoff + retry; a slow web search is not repeated after a timeout | unit |
| Popup closed mid-research → research finishes in the background and is restored on reopen; only one search per profile at a time; interrupted run reported and restartable | unit, e2e |
| Your own typed detail stays picked after research; AI writer is told research hooks are public-web facts | unit, e2e |
| Page text for L1: the profile's own sections only (no sidebar), bounded to 15,000 characters | dom |
| OpenAI key: format check, live test, stored key reused, model saved, never shown back | unit, e2e |

### Resume
| Scenario | Where |
|---|---|
| PDF kept on the device with or without a key (as in the original); exact bytes download back; two-click remove | unit, e2e |
| Not a real PDF → rejected; over 4 MB → rejected | unit, e2e |
| With an Anthropic key it also fills in your background; unreadable → PDF still saved, reason shown | unit, e2e |
| The original version's stored resume is migrated, not deleted | unit |

### Tracker and follow-ups
| Scenario | Where |
|---|---|
| Lifecycle: drafted → copied → inserted → sent → due → followed up → replied → undo | unit, e2e |
| Re-drafting after sending never overwrites the sent message | unit |
| Due dates back off (5 → 7 → 9 days), stop after 3 | unit |
| Badge count (capped at 99), refreshed whenever the popup opens | unit, e2e |
| Notifications: single vs summary, once per due cycle, turned off, API missing, blocked → retried later; a contact is marked notified only after Chrome confirms the notification was created | unit |
| Notification click → profile / messaging; foreign ids ignored | unit |
| Stats + "what's working" insight | unit, e2e |
| 60 contacts: paging, search, every filter | unit, e2e |
| CSV export: header, escaping, formula-injection neutralised, empty tracker | unit, e2e |
| Delete / clear / reset need two clicks and disarm after 3.5 s | e2e |
| 1,000-contact cap prunes old drafts, keeps people awaiting replies | unit |

### Settings, templates, data
| Scenario | Where |
|---|---|
| Key: wrong format, rejected, accepted, Enter key, network down, remove; never shown back | unit, e2e |
| Failed key test never overwrites a working key | unit |
| Follow-up days out of range rejected; theme applied live and persisted | e2e |
| Resume: non-PDF, > 4 MB, no key, drag & drop, keyboard (Enter + Space), unreadable AI output; PDF never stored | unit, e2e |
| Templates: placeholders created, applied with fallbacks, `{hook}` filled, limit of 50, delete, survive popup reopen | unit, e2e |
| Migration from v3.1 and v3.2 data; idempotent; old PDF deleted | unit |
| Corrupted storage of every key → repaired or dropped; popup boots cleanly | unit, e2e |
| Storage full / write error → clear message; write lock keeps working afterwards | unit |
| 50 concurrent writes → no lost updates | unit |
| Draft survives the popup closing; session expires after 6 h | unit, e2e |

### Robustness and security
| Scenario | Where |
|---|---|
| Router rejects other extensions, content scripts, malformed messages, `__proto__`/`constructor` | unit |
| Unexpected internal errors masked from the user, logged for developers | unit |
| Every background failure (13 actions) injected in the live popup → clear message, popup stays usable | e2e |
| Worker unreachable at boot → explanation, not a blank popup | e2e |
| Uncaught error / promise rejection → safety-net toast | e2e |
| Content script ignores foreign senders and double injection | dom |
| Accessibility: axe WCAG 2 A/AA on every tab, light and dark | e2e |
| Keyboard: arrow keys across tabs/formats/filters; Enter/Space on custom buttons | e2e |
| Zero console or page errors across all e2e suites | e2e |

## Bugs the tests found (all fixed)
1. Template name/limit and resume errors were replaced by "Something went wrong".
2. CSV export crashed on a corrupted timestamp.
3. Non-text settings values were saved as `[object Object]`.
4. Saving a template could corrupt its own placeholders when an opener was punctuation-only.
5. Hint text failed WCAG AA contrast in both themes; landmarks were missing.
6. The resume drop zone ignored Space; tracker messages lacked Space and `aria-expanded`.
7. Insert/Copy stayed clickable while re-reading a profile but silently did nothing.
8. "Tracker cleared" was shown even when clearing failed.
9. A failed theme save was silent.
10. *(v3.3)* An empty `{hook}` left a stray space; `SQL` matched `PostgreSQL`; the badge could be an hour stale.

Found on live LinkedIn profiles (Nov 2026), then reproduced in tests and fixed:

11. Jobs were read as fixed 3-line blocks. A job with a comma-less location shifted every later row, so "Greater Seattle Area" became a job title and "Member Board Of Trustees" a past company.
12. A degree line without dates was read as a second school.
13. Single-name locations ("United States", "Singapore") were not found.
14. On your own posts, the author line (your headline) was counted as a recent post.
15. A follow-up was marked notified before Chrome had created the notification, so a failed notification could suppress the next reminder.

Found while building Deep Mode, then fixed:

16. Two links differing only in their query (`watch?v=1` vs `watch?v=2`) were treated as the same source.
17. On a short profile the parser's page text fell back to the whole page and picked up the "People you may know" sidebar.
18. Re-running Deep Mode dropped a detail you had typed yourself.

## What automated tests cannot prove — check by hand before a demo
Nothing that depends on LinkedIn's live page or a paid API can be guaranteed by mocks. Do this 5-minute pass:
1. Load `extension/` unpacked. Open a **real** profile and click **Read**. The pill should say ≥ 5/8. If it shows the layout warning, update `SELECTORS` in `content/content_script.js`.
2. **Connect → Add a note**, reopen, **Insert**. Text appears; LinkedIn's counter updates.
3. Open **Message** on a 1st-degree connection and **Insert**. Text appears and **Send** is enabled.
4. Add your real Anthropic key → **Test & save** → draft. Then upload your real resume.
5. Add your real OpenAI key → **Test & save**. Switch to **🔍 Deep**, click **Read + research** on a real profile, and check that each source link opens the right page.
6. Tracker: **Mark sent**. Change "Remind me after" to 1 day if you want to see the badge sooner.
