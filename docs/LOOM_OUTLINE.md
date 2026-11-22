# Loom outline (aim for 6–7 minutes)

Talking points, not a script. Say it in your own words. Keep a browser tab ready with the original code from Drive, this repo in your editor, and LinkedIn open on a real profile.

## 1. Framing (20 s)
- "I treated this like a product review: what stops someone getting a reply on LinkedIn, and where does the extension get in the way?"
- Three problems: **it was broken, it overpromised, and its messages wouldn't get replies.** Then one missing piece: **it forgot people the moment you closed it.**

## 2. What I found (60 s) — show the original code
- `utils/cache.js` and the icons were missing → Recent never worked, and the extension might not even load.
- Deep Mode: "OpenAI — Web Enrichment" in the HTML vs `companyNews: []` and `delay(300)` in the code. "A progress bar for work that isn't happening. For a tool that handles people's data, that's a trust problem."
- The resume was stored but never used. The prompt allowed 600 chars for 300-char notes. The free template said "impressed by your work".

## 3. Demo (3 min)
1. **Settings** → name, one-liner, background (or resume → it fills in). Mention the key is never shown back, only `sk-ant-…1234`.
2. **Profile → Read profile & draft.** Point out the `8/8 read` pill and the ★ common-ground hooks.
3. Click another hook → the draft rewrites. **Add your own detail.** **New version** (or `Alt+N`).
4. Switch format 300 → 200 → watch the meter and the draft re-fit.
5. **Connect → Add a note** on LinkedIn → the popup closes → reopen: the draft is still there → `Ctrl+Enter` inserts. Click again → the "won't overwrite your text" guard.
6. **☆ Save as template** → pick it from the menu → it's filled in for this person.
7. **Tracker** → Inserted → Mark sent. "In 5 days this shows up as Due with a badge on the icon." Show **Write follow-up** → **Mark as sent** → **Replied** → stats and the "what's working" insight.
8. **Dark mode** toggle. Export CSV.

## 4. How it's built (90 s) — editor + terminal
- Kept MV3 popup → service worker → content script, but split into modules. Open `docs/ARCHITECTURE.md` and show the diagram.
- Three things that make it production-grade:
  1. **One storage writer with a lock**. Show the concurrency test (50 parallel updates → exactly 50).
  2. **Schema migrations**: users of the old version keep their data, including their stored resume PDF.
  3. **API client** with timeout, backoff and `Retry-After`; **router** that only accepts our own popup and validates every input.
- **Read check + one `SELECTORS` block**: when LinkedIn changes, you find out and fix it in one place.
- Run `npm run check` live: 236 tests in about 2 minutes. Show `docs/TESTING.md`: the scenario matrix, the fake API used to test the real AI path, injected failures, accessibility checks, coverage gates, and **the bugs the tests caught**, including the ones found on live LinkedIn profiles.

## 5. Scaling + trade-offs (40 s)
- "It's fully client-side, so it scales per user by construction: no server to overload. I deliberately didn't add a backend because the brief said not to rebuild." Show the scaling section: stateless API behind a gateway, LLM proxy with quotas, Postgres with row-level security, and why the client is already shaped for it (one storage boundary, injectable API client, stable contact ids).
- Trade-off: v3.2 removed the fake Deep Mode, because honest beats impressive-looking. It is now rebuilt for real: OpenAI parses the page (L1) and researches the web (L2), and every fact must be backed by the page text or a cited source before it can reach a draft.
- Next: test against the live LinkedIn DOM with a small selector-health ping, and an A/B of openers using the reply-rate data.
