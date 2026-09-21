# webhook-listener — project instructions

Read this before touching anything in this repo. For "what's actually live
right now," see `STATUS.md`. For "what's not built yet," see `BACKLOG.md`.
This file is standing practice — it shouldn't need to change often.

## What this is

A self-hosted webhook capture/inspection tool (like webhook.site / RequestBin):
create a listener, get a unique URL, point a webhook at it, watch payloads
arrive in the UI.

**Stack:** Cloudflare Workers throughout — `backend/` is a Hono API Worker
backed by D1, `frontend/` is a React/Vite/Tailwind SPA served as a static-assets
Worker. There is no Docker, no Fastify, no better-sqlite3, no Nginx — those
were fully removed in the Cloudflare Workers migration
(`docs/superpowers/specs/2026-09-17-cloudflare-workers-migration-design.md`).
If you find a reference to Docker Compose anywhere outside the historical
specs, it's stale — flag it.

## Repo layout

- `backend/` — Hono API Worker (`src/index.ts`), D1 access via
  `*.repo.ts` modules, routes under `src/routes/`, migrations in
  `migrations/` (applied via `wrangler d1 migrations`, not ad-hoc DDL).
- `frontend/` — Vite/React SPA, deployed as a second, independent Worker.
- `docs/superpowers/specs/` — one design doc per feature, each documenting
  the *why*, not just the *what*. Read the relevant one before touching an
  area you don't already know well.
- `docs/superpowers/plans/` — the file-by-file implementation plan that
  followed each spec.

## Development workflow

This project uses the brainstorming → design spec → implementation plan →
subagent-driven execution → review → fix-wave process for anything
non-trivial. It has caught real bugs before shipping (a session-cookie leak
via re-exposed headers, an ordering flakiness bug) — keep using it rather
than one-shotting features directly into code.

1. Brainstorm the request (classify bounded vs. architectural).
2. Write a spec to `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md`.
3. Write a plan to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`.
4. Implement (fresh subagent per task where practical), review each task,
   then review the whole change once complete.
5. Fix anything Critical/Important found in review before calling it done.

**Model selection for superpowers stages:** when running brainstorming,
writing-plans, executing-plans, or any review step within that workflow
(including subagent-driven-development task reviews and the final
whole-change review), never use Opus or Fable — for any stage, including
reviews. Use Sonnet as the model for whatever step calls for the "highest"
or "most capable" model; there is no escalation above Sonnet in this repo's
workflow.

**Git:** work happens on a feature branch in its own worktree, opened as a
PR, and merged into `main` — no more committing straight to `main`. This
supersedes the earlier direct-to-main practice; if you see that described
elsewhere (old commit messages, stale docs), it's outdated.

**Commits:** Conventional Commits (`feat`, `fix`, `docs`, `chore`, `refactor`
+ optional scope), e.g. `fix(backend): reject a slug that collides with
another listener's UUID`.

## Running it locally

```bash
cd backend && npm run dev     # wrangler dev, Miniflare-backed local D1 — does not touch prod D1
cd frontend && npm run dev    # vite dev server
```

- Backend tests: `cd backend && npm test` (vitest + `@cloudflare/vitest-pool-workers`).
- Frontend build/typecheck: `cd frontend && npm run build` (`tsc -b && vite build`).
- There is no browser automation available in agent sessions run so far —
  every feature to date has been verified via `curl`/`app.inject()`-equivalent
  tests plus a code read-through, not an actual browser. If you have browser
  access, use it — this repo has never had a real click-through pass done by
  an agent.

## Deploying

Two independent Workers, deployed and versioned separately — deploy the one
you changed, not both reflexively.

```bash
cd backend && npm run deploy   # wrangler deploy — webhook-api Worker
cd frontend && npm run build && cd frontend && npx wrangler deploy   # webhook Worker (static assets)
```

- D1 migrations: `cd backend && npm run db:migrate:remote` (apply to the
  live database — `db:migrate:local` targets the Miniflare-local one).
  Always run local first, confirm tests pass, then apply remote.
- Custom domains (`webhook.fde.nice-agentic.com`,
  `webhook-api.fde.nice-agentic.com`) are attached out-of-band via
  Cloudflare's account-level Custom Domains API, not wrangler's `routes`
  block — the deploy token has Custom Domains permission but not
  Zone:Workers Routes. This is deliberate (see comments in each
  `wrangler.toml`) — don't "fix" it by adding a `routes` block.
- Zone: `nice-agentic.com` (`cf2eae38525b377fd3de9af950bd476a`). The `fde`
  sub-subdomain is a pre-existing convention on this zone (other apps live
  there too, e.g. `dtmf.fde.nice-agentic.com`).
- The `wl_session_id` cookie is scoped to `Domain=fde.nice-agentic.com` (one
  level up from either Worker's own hostname) so it's shared across both
  Workers. Accepted trade-off: it's technically visible to any other host
  under that subdomain — see the migration spec for the full writeup.

## Access model — read this before changing anything auth-related

Three tiers today (a fourth, email-based gate, is designed but **not
implemented** — see `BACKLOG.md`):

1. **Owner access** (`/listener/:id`) — requires an anonymous
   `wl_session_id` cookie matching the session that created the listener.
   Not the UUID alone — see the session-scoped-ownership spec for why that
   changed.
2. **Read-only share access** (`/shared/:token`) — separate bearer token,
   works from any browser, no session check, by design.
3. **Webhook capture** (`/hook/:id`) — fully open, no session, no auth. Any
   HTTP client must be able to POST here regardless of who's logged in
   where — that's the entire point of the tool.

None of this is "real" authentication. It was designed for a personal,
local-only tool. **That assumption no longer holds** — the app is now
publicly deployed (see `STATUS.md`). Don't casually extend the current
session-cookie model as if it were sufficient for a public multi-user app;
the email-access-gate spec exists precisely because this was already
identified as a gap.

## Known, deliberate design decisions — don't "fix" these

- Listeners created before session-scoped ownership shipped have
  `owner_session = NULL` and are permanently inaccessible via
  `/listener/:id`. Deliberate, not a bug.
- Read-only share views can leak a hook URL's UUID if a webhook sender put
  it in their own payload/headers — filtering captured payload content
  would be worse (data corruption risk). Documented, accepted.
- Export (JSON/HAR) always pretty-prints at a hardcoded 2-space indent,
  ignoring the user's Formatter display settings — export is a data
  interchange format, not a display, by design.
- `cookie`/`set-cookie` headers are redacted at capture time in
  `backend/src/routes/hook.ts` — do not remove this, it closes a real
  session-hijack path that was found and fixed during review.
