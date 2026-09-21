# Status — webhook-listener

Live snapshot as of **2026-09-21**, verified by direct investigation (curl
against the deployed Workers, `npm test`, `npm run build`) — not copied from
a prior session's notes. Update this file when the picture changes rather
than letting it drift; if you're not sure it's still accurate, re-verify
before trusting it.

## Deployment — this is a live, public service

- Frontend: `https://webhook.fde.nice-agentic.com` — confirmed responding
  (200).
- Backend API: `https://webhook-api.fde.nice-agentic.com` — confirmed
  responding (200).
- **This is not a local-only personal tool anymore.** It is deployed on the
  open internet with **no authentication in front of it** — the access
  model (`CLAUDE.md`) is still the anonymous-session-cookie design built for
  a single local user. Anyone who finds the URL can create listeners and
  receive webhook traffic under this deployment. The email-access-gate
  feature designed to close this gap has **not been implemented** — see
  `BACKLOG.md`. Treat this as the top-priority open item, not routine
  backlog.

## Build / test health

- Backend: `cd backend && npm test` → **116/116 passing** (12 test files).
- Frontend: `cd frontend && npm run build` → clean, 0 TypeScript errors.
- D1 migrations applied: `0001_init.sql` → `0004_slug_label_ordering.sql`.
  No `0005` yet (the projects feature's migration, designed but not built —
  see `BACKLOG.md`).

## Recent rebrand (deployed, not yet committed)

The NiCE Labs rebrand has been built, verified against `dist/index.html` on
the live Worker, and deployed to `https://webhook.fde.nice-agentic.com` —
still sitting as **uncommitted local changes** in git, though:

- `frontend/src/components/Logo.tsx` — replaced the inline SVG mark with
  `<img>` tags pointing at new NiCE Labs PNG assets (light/dark variants,
  toggled via `dark:` classes).
- `frontend/src/pages/Home.tsx`, `Listener.tsx`, `SharedListener.tsx` —
  updated `Logo` className usage (height-only, no more fixed square
  width/text-color now that it's a raster wordmark, not a `currentColor`
  icon); `Listener.tsx` also gained a "← Back to listeners" link to `/`.
- `frontend/src/assets/nice-labs-on-black.png`,
  `frontend/src/assets/nice-labs-on-white.png` — new, untracked.
- `.DS_Store` and `frontend/.DS_Store` — untracked, should be added to
  `.gitignore` rather than committed.

Backend was untouched, so only the frontend Worker was redeployed
(`cd frontend && npm run build && npx wrangler deploy`). If you're picking
this up fresh, run `git status` and `git diff`, then commit this work
rather than re-doing it.

## Features shipped and live

In build order — each has a full design spec + implementation plan under
`docs/superpowers/`:

1. **Core MVP** — listener CRUD, `/hook/:id` capture (any method/content-type,
   10MB cap), polling UI, JSON syntax highlighting + diff-vs-previous,
   JSON/HAR export.
2. **Shareable read-only view** — revocable `/shared/:token` links.
3. **Session-scoped listener ownership** — `wl_session_id` cookie gates
   owner-only routes; fixed a real cookie-leak-via-share-view bug during
   review.
4. **Home page listener list** — `GET /api/listeners`, newest-first, scoped
   to the current session.
5. **Listener slug/label/ordering** — custom URL slugs (with per-listener
   `X-Webhook-Token` gating), label field, custom drag-to-reorder and
   sort-mode list view.
6. **Settings (theme/width/formatter) + diff view rewrite** — dark mode,
   width control, 46-theme syntax highlighter picker, indent/compact/line
   number options, diff-only toggle. Settings persist to `localStorage`.
7. **Cloudflare Workers migration** — full infrastructure replacement:
   Docker Compose/Fastify/better-sqlite3/Nginx removed entirely; now two
   Workers (`webhook`, `webhook-api`) + D1. Details and rationale in
   `CLAUDE.md`.

Full behavioural detail and edge cases for each of these live in their spec
files — this list is an index, not a substitute for reading them.

## Verification gap

No feature above has ever been click-through tested in an actual browser —
every verification pass to date used `curl` / Worker test harnesses plus a
code read-through. If you have real browser access in this session, a
first-ever manual click-through (create a listener, share it, toggle
Settings, confirm dark mode has no flash-of-light-on-refresh) would close a
long-standing gap. See `BACKLOG.md` for the specific checklist.
