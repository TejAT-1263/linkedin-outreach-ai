# LinkedIn Outreach AI — v3.3.0

Write a short, specific LinkedIn note from the profile you're viewing, built around what you actually have in common. Insert it into LinkedIn in one click, and get reminded to follow up if they don't reply.

| Write | Tracker | Dark mode |
|---|---|---|
| ![Write](screenshots/03-drafted.png) | ![Tracker](screenshots/05-followup.png) | ![Dark](screenshots/08-write-dark.png) |

## Install (2 minutes)
1. Unzip `dist/linkedin-outreach-ai-v3.3.0.zip` (or use the `extension/` folder directly).
2. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, and select the folder.
3. Pin **LinkedIn Outreach AI**. Shortcut: `Alt+Shift+O`.

## Use
1. **Settings:** add your name, a one-liner and your background (companies, schools, skills, city). Optionally add your Anthropic key for AI drafts and resume reading.
2. Open someone's profile → **Read profile & draft**. The pill shows how much of the profile was read (e.g. `8/8 read`).
3. Under **What to mention**, pick up to two hooks (★ = something you have in common) or add your own detail. Choose the format (300 / 200 / message) and the draft fits automatically.
4. On LinkedIn open **Connect → Add a note** or **Message**, reopen the extension (the draft is still there), then **Insert into LinkedIn** (`Ctrl/⌘+Enter`). Read it, then send.
5. **Tracker:** mark people Sent or Replied. When a follow-up is due you'll see a badge on the icon. **Write follow-up**, send it, then **Mark as sent**.
6. Like a draft? **☆ Save as template** and reuse it for anyone.

Without an API key everything runs locally, and nothing leaves your browser.

## What's new
See **[docs/CHANGELOG.md](docs/CHANGELOG.md)**: the original audit, every change step by step, and why.
See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**: module map, data model, reliability, security and the scaling plan.

## Develop
```bash
npm ci
npm run lint        # ESLint
npm test            # 48 unit tests (node:test)
npm run test:e2e    # 14-step Playwright run in real Chrome against mock LinkedIn pages
                    #   (set CHROME_PATH=/path/to/chrome to use an installed Chrome)
npm run package     # validates manifest → dist/linkedin-outreach-ai-v<version>.zip
npm run check       # all of the above except package
```

```
extension/
  manifest.json
  background/   index · router · store · migrate · hooks · writer-local · writer-ai
                anthropic · templates · tracker · followups · linkedin
  content/      content_script.js   (all LinkedIn selectors in one SELECTORS block)
  popup/        popup.html · popup.css · main · write · tracker · settings · api · dom
  shared/       constants.js · text.js
tests/unit/     *.test.mjs + helpers (chrome mock, fixtures)
tests/e2e/      run.mjs + mock LinkedIn pages
scripts/        package.mjs · make_icons.py
docs/           CHANGELOG · ARCHITECTURE · LOOM_OUTLINE
```

## Known limits
- LinkedIn changes its markup. If **Read** or **Insert** misbehaves, update `SELECTORS` in `content/content_script.js`; the read check will flag it.
- The character limits (300 / 200) match what LinkedIn has shown. At insert time the extension reads LinkedIn's real `maxlength` and warns if it's lower.
- The extension never presses Send, so "Sent" and "Replied" are marked by you.
