# Handoff — webhook-listener

Snapshot as of 2026-09-17. Read this first in a fresh session before touching code.

## What this project is

A self-hosted webhook capture/inspection tool (like webhook.site / RequestBin):
create a listener, get a unique URL, point a webhook at it, watch payloads
arrive in the UI. Runs entirely via `docker compose up` — no cloud deployment
target, no login system in the traditional sense (see access model below).

**Stack:** Node/TypeScript/Fastify/better-sqlite3 backend; React/Vite/Tailwind
frontend; Nginx reverse-proxies the frontend container to the backend; two
Docker Compose services, one SQLite file on a named volume.

**Repo root:** `/Users/Ben.Elliot/repos/webhook-listener`
**Git:** everything lands directly on `main` — this is a solo project, no
feature branches, no worktrees. That's an explicit, established choice for
this repo, not an oversight.
**Process used throughout:** brainstorming skill → design spec →
implementation plan → subagent-driven-development (fresh implementer
subagent per task, task-level review, final whole-branch review, fix waves
for anything Critical/Important). Every feature below has a spec + plan in
`docs/superpowers/specs/` and `docs/superpowers/plans/` — read those for the
full design rationale and file-by-file task breakdown if you need more detail
than this doc gives.

## Running it

```bash
docker compose up -d --build
```
App is at **http://localhost:8080**. Backend tests: `cd backend && npm test`
(66 tests, all green as of this snapshot). Frontend build check:
`cd frontend && npm run build` (0 TypeScript errors).

The stack is currently **up and running** from the last session — check
`docker compose ps` before rebuilding.

## Access model (read this before changing anything auth-related)

There are **three distinct tiers**, each a different kind of credential:

1. **Owner access** (`/listener/:id`) — requires an anonymous `wl_session_id`
   cookie matching the session that created the listener. NOT just the UUID
   anymore (see "Session-scoped ownership" below for why this changed).
2. **Read-only share access** (`/shared/:token`) — a separate bearer token,
   works from any browser, no session check, by design. Intended for
   "send this link to a teammate."
3. **Webhook capture** (`/hook/:id`) — fully open, no session, no auth. Any
   HTTP client must be able to POST here regardless of who's logged in
   where — that's the entire point of the tool.

None of this is "real" authentication — there's no login, no accounts. It's
all anonymous, cookie/token-based capability access, appropriate for a
personal local dev tool. Don't over-engineer auth here unless the user
explicitly asks for real accounts.

## Features built, in order

### 1. Core MVP (spec/plan: `2026-09-16-webhook-listener-*`)
Listener CRUD, `/hook/:id` capture (any method/content-type, 10MB cap),
polling UI (3s interval, stops after 2 consecutive 404s), Docker Compose
wiring. Later got a Tailwind visual pass, search/filter, JSON syntax
highlighting + diff-vs-previous, JSON/HAR export + per-row copy.

### 2. Shareable read-only view (spec/plan: `2026-09-16-shareable-readonly-view-*`)
Owners can generate a revocable `/shared/:token` link (`share_token` column,
`GET/POST/DELETE` share-management endpoints). Read-only viewers get
filtering/export/diff but no delete, no hook URL. **Known, accepted, documented
limitation:** the no-leak guarantee only covers app-generated fields — if a
webhook sender includes their own hook URL (and thus its UUID) inside a
captured header/body, that's shown to read-only viewers same as the owner.
Not a bug to fix; filtering captured payload content would be worse (data
corruption risk). Documented in the spec's Access model section.

### 3. Session-scoped listener ownership (spec/plan: `2026-09-17-session-scoped-ownership-*`)
**This is the big one — read the spec if you touch auth/sessions at all.**
The user personally discovered that pasting a listener URL into a fresh
incognito window granted full owner access (view + delete) with zero
barrier — the original MVP design ("UUID is the bearer credential") was
functioning as designed, but the user decided that design was wrong for
owner-level actions. Fix: an anonymous `wl_session_id` cookie
(`httpOnly`, `sameSite: 'lax'`, 1yr, unsigned — see spec for the honest
trade-off writeup on why unsigned is accepted at this scope) is assigned
per-browser; listeners record their creator's session (`owner_session`
column); five owner-only routes now 404 identically for "wrong session" and
"doesn't exist" (`getListenerForOwner` — one query, one code path, by
construction). `/hook/:id` and `/shared/:token` are untouched, unaffected.

**A real Critical security bug was found and fixed during this feature's own
final review, not before:** the session cookie itself was being captured
verbatim by `/hook/:id` (e.g. a browser visiting its own hook URL to test it
sends its own cookies) and then re-exposed through the pre-existing share
view — anyone with a share link could steal the session cookie and hijack
every listener that session ever owned. Fixed by redacting `cookie`/
`set-cookie` headers at capture time (`backend/src/routes/hook.ts`). Also
fixed in the same pass: cookie renamed `session_id` → `wl_session_id`
(collision-avoidance across localhost apps), added a UUID-shape validation
on incoming cookie values (rejects garbage, doesn't fully prevent session
fixation — that's an accepted, documented local-scope trade-off, not a
closed gap).

**No migration/back-compat for listeners created before this feature** —
they have `owner_session = NULL`, which matches no session by SQL semantics,
so they're permanently inaccessible via `/listener/:id`. Deliberate,
documented, not a bug. If you ever need to recover pre-existing listeners,
you'd need to add an explicit claiming mechanism (spec calls this out as a
deferred TODO, not started).

### 4. Home page listener list (spec/plan: `2026-09-17-home-listener-list-*`)
Visiting `/` now shows the current session's own listeners (newest-first),
linking to each. New `GET /api/listeners` route + `getListenersForOwner`
repo function (plural, distinct from the singular `getListenerForOwner`).
During review, a real flakiness bug was found and fixed: `ORDER BY
created_at DESC` had no tie-breaker for same-millisecond timestamps (3/5
test runs failed before the fix) — added `id DESC` as a secondary sort key,
same pattern already used in `requests.repo.ts`. Verified stable across 15
independent repeated test runs after the fix.

### 5. Settings (theme/width/formatter) & diff view rewrite (spec/plan: `2026-09-20-settings-and-formatter-*`)
A cog-icon Settings modal (`components/SettingsModal.tsx`, wired into
`components/AppLayout.tsx` so it's available on all three routes — `/`,
`/listener/:id`, `/shared/:token`) covers four sections: Theme (light/dark,
with an inline pre-hydration script in `index.html` reading `localStorage`
directly so there's no flash-of-light-before-dark on refresh), Width (narrow/
wide/full, applied via `WIDTH_CLASSES` in each page's root `<main>`), and a
new Formatter section — a highlight-theme picker over 46 lazy-loaded Prism
themes (`lib/highlightThemes.ts`), indent width (2/4), compact mode, and line
numbers. Settings persist to `localStorage` (`wl_settings`) via
`hooks/useSettings.tsx`. The diff view (`components/RequestRow.tsx`) was
rewritten to render through the same `react-syntax-highlighter` instance used
for the plain view (previously it dropped formatting/styling), and a
whole-list "Diff only" toggle was added to both `pages/Listener.tsx` and
`pages/SharedListener.tsx`. Export (`lib/exportRequests.ts`) is deliberately
unaffected by Formatter settings — JSON/HAR export always pretty-prints at a
hardcoded 2-space indent regardless of the compact/indent-width settings, by
design (export is a data interchange format, not a display).

**Real technical finding, applied proactively:** Vite's dynamic
`import()` with a template-literal path doesn't warn at build time when the
path is unanalyzable — it fails silently at runtime instead. `lib/
highlightThemes.ts` therefore uses an explicit `switch` statement over all 46
theme names, each with a literal `import('.../theme-name.js')` path, rather
than a templated dynamic import, so Vite can statically analyze and
code-split every theme into its own chunk (confirmed in the production build
output — each theme is its own small JS asset).

**Accepted limitation / disclosed honestly:** this feature, like every prior
one in this repo, was implemented and reviewed with **no browser automation
available in the execution environment** — verification was build-only
(`tsc -b && vite build`, 0 TypeScript errors) plus a full code read-through
confirming each interactive/visual behavior's code path exists and is wired
correctly (modal sections present, no-flash script present, export functions
independent of display settings, per-row `SyntaxHighlighter` instances so
line numbers legitimately restart per row while staying continuous within
one row's diff). None of this was confirmed by actually opening a browser —
see "Outstanding manual check" below, which now explicitly covers this
feature too.

## Known parked/deferred items (not bugs, just triaged as non-blocking)

- Frontend: `Home.tsx`'s list-fetch failure is fully silent (no error
  banner) rather than showing an inline note — the spec asked for a note,
  the plan/implementation chose silence, reviewed and accepted as a valid
  interpretation. Revisit if it ever confuses a user ("why is my list
  empty?").
- The listener list has no heading/`aria-label` — cosmetic/a11y polish,
  not addressed.
- A few cheap test-hardening opportunities were identified but not built
  (asserting `ownerSession`/`shareToken` are *absent* from list responses;
  a repo-level test that actually exercises the `id DESC` tie-break path
  instead of avoiding it). Low priority, noted in case you're adding tests
  in this area anyway.
- No index on `listeners(owner_session)` — irrelevant at current scale
  (personal tool, tens of rows), would be the first lever if this table
  ever grows large.
- `npm audit` shows pre-existing vulnerabilities in the `vitest`/`vite`/
  `esbuild` devDependency chain — confirmed unrelated to any feature work
  here, not investigated further (dev-only, not shipped in either Docker
  image).

## Feature backlog (not started, from 2026-09-19 brainstorming session)

Batch of feature requests decomposed into sub-projects during brainstorming
on 2026-09-19. Two trivial items (CORS `onError` fix, favicon/header logo)
were dispatched to a subagent immediately — check git log for whether they
landed. The rest need their own brainstorm → design → plan cycle before
implementation, per this project's established workflow. Recorded here so
they aren't lost between sessions:

- **Listener identity & organization** — custom unique slug in the URL in
  place of the UUID; a label field on listeners (shown on the listener page
  and the list) for user-driven organization; make the listener list
  orderable by date/name/custom. Related: slug and label are both new
  `listeners` columns; ordering depends on which of those fields exist.
- **List view actions** — delete-with-confirm, share-with-confirm, copy
  share link, copy hook target URL, all as affordances directly on the
  home page listener list (currently these actions, where they exist at
  all, live on the individual listener page). Likely share a single
  confirm-dialog pattern across delete/share.
- **Email access gate** — magic-link email challenge gating access,
  restricted to `@nice.com`/`@cognigy.com` domains. This is a new auth
  subsystem (email delivery, token generation/verification, session
  gating, domain allowlist) and is architectural in scope — treat as its
  own spec, and read the "Access model" section above first since it
  currently documents an explicit no-real-auth design decision that this
  would supersede.

## Outstanding manual check (can't be done from an agent session)

**Nobody has visually confirmed any of this in an actual browser.** Every
verification in every feature was done via `curl`/`app.inject()` — no
browser tool exists in this execution environment. Before considering
anything "done done," open `http://localhost:8080` yourself and click
through: create a listener, confirm it appears on the home page, confirm an
incognito window can't see it, generate a share link and open it in another
browser/incognito, confirm the visual layout of the owner page's Share
section (labels were added to distinguish the hook URL box from the share
URL box — worth confirming they read clearly).

**Additionally, feature 5 (Settings/formatter/diff view) needs its own
click-through**, since it was implemented and reviewed entirely without
browser access: open the Settings modal on all three routes (`/`,
`/listener/:id`, `/shared/:token`) and confirm Theme/Width/Formatter
controls actually change the rendered view; hard-refresh in Dark theme a few
times on `/listener/:id` and confirm no flash of light background before
dark paints; set Compact + Indent 4 and confirm exported JSON/HAR files are
still 2-space pretty-printed (untouched by display settings); and with Line
numbers on, toggle Diff only on a listener with 4+ requests and confirm line
numbering is continuous within each row's diff (restarting per row is
correct — continuity is required within one diff, not across rows).

## If you're picking this up fresh

1. `docker compose ps` — is it already running from last time?
2. `cd backend && npm test` — should be 66/66 green. If not, something
   regressed; start there.
3. Read whichever spec in `docs/superpowers/specs/` is relevant to what
   you're about to touch — they're short and each documents the "why," not
   just the "what."
4. This project's workflow so far: brainstorm (classify
   bounded/architectural) → spec → plan → subagent-driven execution → final
   review → fix wave if needed. It's worked well here (caught two real bugs
   — the security leak and the ordering flakiness — that a single-pass
   implementation would likely have shipped). Keep using it for anything
   non-trivial.
5. The user's own words on the current access model, paraphrased: they want
   the "front door" (home page → create → that browser keeps access) to
   work, and a share link to be the only way a *different* browser context
   gets in. That's exactly what's built. If they ask for something that
   sounds like real user accounts/login, that's a bigger conversation —
   don't assume it, ask.
