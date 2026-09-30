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
  the _why_, not just the _what_. Read the relevant one before touching an
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

**Commits:** Conventional Commits (`feat`, `fix`, `docs`, `chore`, `refactor`,
optionally with a scope), e.g. `fix(backend): reject a slug that collides
with another listener's UUID`.

Conventional Commits are now enforced, not just followed by convention:
commitlint runs locally via a husky `commit-msg` hook and again in
`.github/workflows/pr.yml` against every commit in a PR and the PR title
itself (PRs are squash-merged, so the PR title becomes the commit
semantic-release reads on `main`).

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

**Browser-based local dev needs a `.dev.vars` override.** `backend/wrangler.toml`'s
`[vars]` block (`APP_BASE_URL`, `HOOK_BASE_URL`, `SESSION_COOKIE_DOMAIN`) is
hardcoded to the production domains, since there's no `routes` block or
environment split to vary it by. Left as-is, `wrangler dev` still starts
fine and answers `curl` correctly, but a real browser hitting the frontend
at `http://localhost:5173` gets every session-cookie-bearing request
silently blocked: CORS returns `Access-Control-Allow-Origin:
https://webhook.fde.nice-agentic.com` (mismatched origin) and the
`Set-Cookie` carries `Domain=fde.nice-agentic.com` (doesn't match
`localhost`, so the browser drops it) — this shows up as a generic
"failed to create" with no obvious backend error. Create a
`backend/.dev.vars` (gitignored, wrangler auto-loads it, already in
`.gitignore` via `.dev.vars`/`*.dev.vars`) to override for local dev:

```
APP_BASE_URL = "http://localhost:5173"
HOOK_BASE_URL = "http://localhost:8787"
SESSION_COOKIE_DOMAIN = ""
```

Restart `wrangler dev` after creating/editing it (env vars are read at
startup, not hot-reloaded).

## Deploying

Two independent Workers, deployed and versioned separately — deploy the one
you changed, not both reflexively.

```bash
cd backend && npm run deploy   # wrangler deploy — webhook-api Worker
cd frontend && npm run build && cd frontend && npx wrangler deploy   # webhook Worker (static assets)
```

**As of the CI/release pipeline, these commands are no longer the normal
path.** Every merge to `main` that includes a `feat`/`fix`/`perf`/`revert`/
`docs`/`refactor` commit triggers `.github/workflows/release.yml`:
semantic-release bumps the version, writes `CHANGELOG.md`, creates a GitHub
Release, and then deploys both Workers automatically. The manual `npm run
deploy` commands above remain available for an emergency/manual redeploy,
but merging to `main` is normally sufficient — you don't need to run them
yourself.

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

## PR preview environments

Adding the `preview` label to a PR provisions a live, isolated environment
for it: its own Worker pair (`webhook-api-pr-<N>`, `webhook-pr-<N>`) and
its own D1 database (`webhook-listener-pr-<N>`), seeded from a **scrubbed**
copy of production with pending migrations pre-applied. The preview URLs
are posted (and kept updated) as a PR comment.

- The first labeling (or any push that touches `backend/migrations/`)
  triggers a full provision: export prod D1, scrub it
  (`scripts/preview-env/scrub.sql`), import into the PR's own database,
  apply migrations, then deploy both Workers. Any other push just
  redeploys Worker code against the existing preview database.
- **`scripts/preview-env/scrub.sql` is a hand-maintained list of every
  sensitive column in the schema, not a generic scrubber.** If a migration
  adds a table or column holding a token, email, IP address, or captured
  payload content, update this file (and its duplicated mirror in
  `backend/src/preview-scrub.test.ts`) in the same PR.
- **Deliberately not scrubbed: `listeners.owner_email` / `projects.owner_email`.**
  Everything else on those rows (share/webhook tokens, `owner_session`) is
  still scrubbed, and hook content (`requests.headers`/`body`/etc.) is
  always fully scrubbed regardless of owner — only the ownership _link_
  survives. This is safe because the email access gate already requires
  proving ownership of a real inbox (via magic link) before signing in as
  that email, so preserving the link doesn't let anyone see data they
  couldn't otherwise reach — it just means a PR reviewer signing in as
  themselves sees their own existing (content-scrubbed) listeners/projects
  instead of an empty account.
- Removing the `preview` label, or closing/merging the PR, tears both
  Workers and the D1 database down. A `workflow_dispatch` input (PR
  number) is available as a manual safety net if a teardown is ever missed.
- Requires the `CLOUDFLARE_API_TOKEN` secret to have `D1: Edit` permission
  (in addition to the `Workers Scripts: Edit` permission `release.yml`
  needs) and a `CLOUDFLARE_ACCOUNT_ID` repository variable to be set.
- The frontend's API base URL is baked in at build time (Vite's
  `import.meta.env.VITE_API_BASE_URL`, from `frontend/.env.production` by
  default) — `scripts/preview-env/write-frontend-env.mjs` overrides it to
  the PR's own backend Worker via `frontend/.env.production.local`
  (Vite's highest-precedence override file) before the build runs. Without
  this, a preview frontend would call the real prod backend and get
  blocked by CORS.
- Each `webhook-api-pr-<N>` Worker is a brand-new Cloudflare Worker
  script — it does not inherit prod's `WL_SESSION_SECRET`/
  `RESEND_API_KEY` (those are set once, directly, on the prod/staging
  scripts only, and never touched by this workflow). `provision.mjs`
  pushes a freshly generated, preview-only `WL_SESSION_SECRET` and the
  `PREVIEW_RESEND_API_KEY` repo secret (a Resend key/sender **dedicated
  to previews**, separate from prod's, so ephemeral test environments
  never send through prod's sending identity) to every preview Worker via
  `wrangler secret put`, on every deploy.

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
