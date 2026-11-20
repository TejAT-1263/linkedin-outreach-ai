# Architecture

## Shape of the system

```
┌──────────────── Chrome (one per user) ────────────────────────────────────────┐
│                                                                                │
│  popup/ (ES modules)            background/ (MV3 service worker, ES modules)   │
│  ┌──────────────┐  runtime     ┌──────────────────────────────────────────┐   │
│  │ main.js      │  message     │ index.js   listeners (msg, alarms, notif)│   │
│  │ write.js     │ ───────────▶ │ router.js  trusted-sender check, input   │   │
│  │ tracker.js   │ {action,     │            validation, error shaping     │   │
│  │ settings.js  │  payload}    │ ├─ hooks.js        profile → hooks       │   │
│  │ api.js dom.js│ ◀─────────── │ ├─ writer-local.js built-in writer       │   │
│  └──────────────┘ {success,    │ ├─ writer-ai.js    prompts + limit fit   │──▶ api.anthropic.com
│                    data|error} │ ├─ anthropic.js    timeout/retry client  │   (only with user's key)
│                                │ ├─ templates.js    placeholders          │   │
│                                │ ├─ tracker.js      due dates, stats, CSV │   │
│                                │ ├─ followups.js    alarm, badge, notify  │   │
│                                │ ├─ store.js ──▶ chrome.storage (locked)  │   │
│                                │ ├─ migrate.js      schema upgrades       │   │
│                                │ └─ linkedin.js ──▶ tabs / scripting      │   │
│                                └──────────────────────────┬───────────────┘   │
│                                                           │ tabs.sendMessage  │
│                                content/content_script.js ◀┘ (linkedin.com)    │
│                                  SELECTORS · scrape + diagnostics · insert     │
│  shared/constants.js · shared/text.js  — used by all of the above + tests      │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Rules that keep it maintainable**
- **One writer to storage.** Only `background/store.js` touches `chrome.storage`. The popup never writes storage directly; it asks the router.
- **Pure core, thin edges.** Hooks, both writers, templates, tracker maths and migrations are pure functions with no `chrome.*`. They're unit-tested in Node. Chrome APIs sit in `store`, `linkedin`, `followups` and `index`.
- **One contract.** Every action name is in `shared/constants.js#ACTIONS`. Unknown actions and untrusted senders are rejected.
- **Selectors in one place.** LinkedIn markup changes are a one-block edit in `content_script.js#SELECTORS`. The read check tells you when that edit is needed.

## Data model (`chrome.storage.local`, schema v2)

| Key | Shape | Notes |
|---|---|---|
| `schemaVersion` | `2` | `migrate.js` upgrades v3.1 / v3.2 data on install/update; idempotent |
| `settings` | `{name, bio, background, apiKey, resumeFileName, followUpDays, notifications, theme}` | `apiKey` is never sent back to the UI (only `hasKey` + a masked hint) |
| `prefs` | `{messageType, tone, format}` | last-used choices |
| `contacts` | `{ [id: "in:<slug>"]: Contact }` | keyed by profile slug → O(1) upsert, no duplicates |
| `templates` | `Template[]` | ≤ 50 |
| *(session)* `draft` | current profile/hooks/draft | `chrome.storage.session`: in memory, cleared when the browser closes, 6 h TTL |

`Contact`: `id, profileUrl, name, headline, company, purpose, format, message, hooks[≤2], status (drafted|copied|inserted|sent|replied|closed), followUps, createdAt, updatedAt, insertedAt, sentAt, lastTouchAt, repliedAt, notifiedAt, history[≤20]`.

## Reliability

| Concern | How it's handled |
|---|---|
| Lost updates (popup + hourly alarm writing at once) | `withLock()` promise queue around every read-modify-write. Unit test fires 50 concurrent increments and expects exactly 50. |
| Service worker restarts mid-request | All listeners registered synchronously at top level. Every request awaits `ready` (migration) first. |
| API flakiness | 30 s timeout via `AbortController`. Up to 2 retries with exponential backoff + jitter on 429/5xx/529/network. Honours `Retry-After`. No retry on 400/401/403. |
| Over-long AI output | One "shorten" pass, then a sentence-boundary cut. Never exceeds the format's limit. |
| Draft lost when the popup closes | Session saved on every change (debounced) and restored per profile URL. |
| LinkedIn markup drift | Anchor-id lookup first, heading text as fallback. Read check reports `found/8` and flags a likely layout change. Insert verifies the text actually landed and falls back to copy if not. |
| Old data after an update | Versioned migrations. The stored resume PDF from v3.1 is deleted. |
| Unbounded growth | Contacts capped at 1,000 (prunes oldest drafts first, keeps people awaiting a reply). Tracker lists are paged (30 per page). |

## Security & privacy

- **No backend; no data leaves the browser** unless the user adds their own Anthropic key. Then only the profile text needed for the draft (and the resume, once) is sent to `api.anthropic.com`.
- **Strict CSP** on extension pages (`script-src 'self'; object-src 'none'`). **No `innerHTML` with data** in the popup: every node is built with `textContent` (`dom.js#h`).
- **Router only accepts our own extension pages** (`sender.id` + `chrome-extension://<id>/` URL). The content script only accepts messages from the extension.
- **All inputs are validated and length-capped at the boundary** (`normalizeProfile`, `sanitizeHooks`, `sanitizeSettings`, router guards).
- **CSV export neutralises spreadsheet formula injection** (`=`, `+`, `-`, `@` prefixes).
- **Least surprise on LinkedIn.** The extension never clicks Send and never overwrites text the user typed without a second click.

## Performance

- Popup boot is one `getState` round-trip. Tabs render lazily; the tracker loads only when opened, 30 rows at a time, with debounced search.
- The scraper scrolls only as far as the page allows and restores the user's scroll position.
- Package size is about 61 KB with zero runtime dependencies.

## Scaling

**What exists today.** The extension is fully client-side, so it scales horizontally by construction. Each user's browser is its own compute and storage, and there's no shared server to overload. Within one user's browser, the bounded store, paging and lock keep it fast at the 1,000-contact cap.

**If this became a product with a backend,** for team accounts, a shared key, cross-device sync or analytics, this is the design I'd use. **None of it is built here.** It would be a rebuild, which the brief ruled out.

```
extension ──HTTPS──▶ API gateway / edge (rate limit per user: token bucket in Redis)
                       │
                       ├─▶ stateless API pods (autoscaled on CPU/RPS — horizontal)
                       │      ├─ /draft   → LLM proxy (holds org key; per-user quotas; retries; circuit breaker)
                       │      ├─ /sync    → contacts/templates CRUD (last-write-wins + updatedAt)
                       │      └─ /events  → analytics ingest
                       ├─▶ Postgres (row-level security per user/org; read replicas for reporting;
                       │            vertical scale first, partition `contacts` by org_id when needed)
                       ├─▶ queue (e.g. SQS) → workers for slow jobs (resume parsing, enrichment)
                       └─▶ observability: structured logs, traces, p95 latency + LLM cost dashboards
```

- **Horizontal:** API pods are stateless (sessions in JWTs, rate-limit state in Redis), so you add replicas behind the load balancer. LLM calls go through a queue with a concurrency cap so bursts can't exhaust provider quotas.
- **Vertical:** Postgres is scaled up first (simplest). Then add read replicas for analytics, then partition by `org_id`.
- **The client is already shaped for it.** `store.js` is the only persistence boundary, so sync can be added there. `anthropic.js` is injectable, so it can point at the proxy instead of the provider. Contact ids are stable (`in:<slug>`), so merging across devices is deterministic.
