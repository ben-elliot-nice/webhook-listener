# Cloudflare Workers migration — design

Status: approved, ready for implementation plan.
Date: 2026-09-17

## Why

This project currently runs as two Docker Compose services (Fastify +
better-sqlite3 backend, Nginx-served React frontend) on the user's own
machine, with no cloud deployment target. The user wants a **total
replacement**: Docker Compose, Nginx, and both Dockerfiles go away
entirely, and Cloudflare Workers becomes the only way to run this app,
both for local development and for the deployed instance. This is not
an additional deployment target alongside Docker — Docker support is
being removed.

## Access model — unchanged

The three-tier access model documented in `HANDOFF.md` and the
`2026-09-17-session-scoped-ownership-design.md` /
`2026-09-16-shareable-readonly-view-design.md` specs does not change:

1. Owner access (`/listener/:id`) via `wl_session_id` cookie.
2. Read-only share access (`/shared/:token`) via bearer token, no
   session check.
3. Webhook capture (`/hook/:id`) fully open, no auth.

This migration is a runtime/infrastructure change only. No route
semantics, no auth semantics, no data model changes beyond what's
required to run on D1 instead of a local SQLite file.

## Architecture

Two Cloudflare Workers, deliberately split by purpose (not merged into
one Worker) because the user expects to iterate on the frontend much
more frequently than the core capture API, and wants independent
deploy cadence between them:

- **`webhook` Worker** — deployed to `webhook.fde.nice-agentic.com`.
  Serves the built Vite/React SPA as static assets via Workers' native
  `[assets]` binding. No server-side logic. Replaces the Nginx
  container entirely.
- **`webhook-api` Worker** — deployed to
  `webhook-api.fde.nice-agentic.com`. A Hono application carrying
  every current Fastify route (`/hook/:id`, owner-only listener
  routes, `/shared/:token` routes, `/api/listeners`), backed by a D1
  binding. Replaces the Fastify backend container entirely.
- **Cloudflare D1** replaces the SQLite file/named volume. Same
  relational schema (`listeners`, `requests` tables), same SQL
  shapes, managed via `wrangler d1 migrations` instead of the current
  ad-hoc `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` guard functions
  in `db.ts`.
- Docker Compose (`docker-compose.yml`), both `Dockerfile`s, and
  `frontend/nginx.conf` are deleted as part of this migration.
- Local dev becomes `wrangler dev` for each Worker. D1 has a
  Miniflare-backed local emulation mode, so local development does not
  touch the real production D1 database.

### Cloudflare account/domain facts (confirmed against the account)

- Zone: `nice-agentic.com` (id `cf2eae38525b377fd3de9af950bd476a`).
- Existing convention on this zone: a `fde` sub-subdomain is already
  in use (e.g. `dtmf.fde.nice-agentic.com`). This migration follows
  that convention.
- Frontend Worker route: `webhook.fde.nice-agentic.com`
- API Worker route: `webhook-api.fde.nice-agentic.com`
- Owner-session cookie (`wl_session_id`): `Domain=fde.nice-agentic.com`,
  `httpOnly`, `SameSite=Lax`, ~1yr expiry — same flags as today, just
  scoped one level up so both Workers' hostnames share it. Because
  `SameSite` is defined by registrable domain ("site"), not full
  origin, `Lax` remains sufficient — no need for the stricter
  `SameSite=None; Secure` cross-site regime that fully unrelated
  domains would have required.
- **Accepted risk:** widening `Domain` to `fde.nice-agentic.com` means
  `wl_session_id` is technically visible to any other host under that
  subdomain, not just the two webhook-listener Workers — including the
  unrelated `dtmf.fde.nice-agentic.com` app already noted above. This
  is accepted given the personal/low-stakes nature of this tool; the
  alternative (fully separate domains per Worker, requiring
  `SameSite=None; Secure` and losing the same-site CSRF protection
  `Lax` provides) is worse. The cookie is also marked `Secure`.

### Why split into two Workers (recorded rationale)

In isolation, splitting is justified when there's more than one
consumer of an API, or the components need independent deploy/scaling
cadence. Here, the user explicitly expects the frontend to iterate far
more than the stable capture core, so independent deploy cadence
applies. The cost accepted in exchange: the two Workers are different
origins (though same site), so cross-origin `fetch` calls from the SPA
to the API need explicit CORS configuration (see Components below) —
a complication that a single-Worker design would not have had.

## Components

- **`backend/src/db.ts`** is deleted. A D1 binding (`env.DB`) replaces
  the `better-sqlite3` connection. Schema is managed via
  `wrangler d1 migrations` files under a new `backend/migrations/`
  directory:
  - `0001_init.sql` — base `listeners` + `requests` tables and the
    `idx_requests_listener_received` index (current `SCHEMA` constant).
  - `0002_share_token.sql` — adds `share_token` column + unique index
    (current `ensureShareTokenColumn`).
  - `0003_owner_session.sql` — adds `owner_session` column (current
    `ensureOwnerSessionColumn`).

  This mirrors the schema's actual history and replaces the
  guard-function pattern with D1's proper migration tracking.

- **`backend/src/listeners.repo.ts`** / **`backend/src/requests.repo.ts`**
  keep their current function signatures and SQL. Every function
  becomes `async` — D1's driver (`env.DB.prepare(sql).bind(...).run()`
  / `.all()` / `.first()`) is promise-based, unlike `better-sqlite3`'s
  synchronous API. This is a mechanical, repo-wide change: every call
  site needs an `await` added, and callers up the stack become `async`
  as needed.

- **`backend/src/routes/*.ts`** (`hook.ts`, `listeners.ts`, `shared.ts`)
  are rewritten from Fastify plugins to Hono route modules/handlers.
  Same route paths, methods, and handler logic; different
  registration syntax (`app.get('/path', handler)` instead of Fastify
  plugin registration).

- **`backend/src/server.ts`** / **`backend/src/index.ts`** collapse
  into a single Hono app instance exported as the Worker's `fetch`
  handler (the standard Cloudflare Workers entry point shape:
  `export default { fetch: app.fetch }`).

- **Cookie handling**: `@fastify/cookie` is replaced by Hono's
  built-in `hono/cookie` helpers. Same cookie name (`wl_session_id`)
  and flags, new `Domain=fde.nice-agentic.com` scope as described
  above.

- **CORS**: the API Worker gets Hono's `cors` middleware, allow-listing
  exactly `https://webhook.fde.nice-agentic.com` with
  `credentials: true`, applied to the owner/share/listener-list
  routes. `/hook/:id` is exempt — webhook senders are not browsers and
  have no CORS involvement, matching today's fully-open behaviour.

## Data flow

- **Capture**: webhook sender → `POST
  webhook-api.fde.nice-agentic.com/hook/:id` → Hono handler writes to
  the D1 `requests` table → response identical to today (fully open,
  no auth, 10MB cap enforced explicitly — see Error handling).
- **Owner UI**: browser loads the SPA from
  `webhook.fde.nice-agentic.com` (static assets) → SPA's polling/fetch
  calls hit `webhook-api.fde.nice-agentic.com/api/...` with
  `credentials: 'include'` → the CORS-approved cross-origin request
  still carries the `wl_session_id` cookie (same-site, different
  origin) → `getListenerForOwner` / `getListenersForOwner` resolve
  exactly as today, against D1 instead of the local SQLite file.
- **Share links**: `/shared/:token` is bearer-token based already, not
  cookie-dependent, so it works cross-origin under the same CORS
  middleware without needing `credentials: true` specifically for
  that route (it's included in the same middleware config for
  simplicity, not because it requires credentials).

## Error handling

- Workers impose their own request/response size and CPU-time limits,
  distinct from Node/Fastify defaults. The existing 10MB body cap on
  `/hook/:id` must be enforced explicitly in the Hono handler (reading
  `Content-Length` and rejecting oversized bodies) — Workers does not
  inherit Node's body-size assumptions the way the current Fastify
  setup implicitly relied on Node's defaults.
- D1's error surface differs from `better-sqlite3`'s (e.g. constraint
  violation errors throw differently). Repo functions get thin
  try/catch translation only where existing tests assert specific
  error responses — no new error handling invented beyond matching
  current, already-tested behaviour.
- The existing "one query, one code path" 404-for-wrong-session-or-
  nonexistent behaviour in `getListenerForOwner` is preserved exactly
  as-is; this is repo-layer logic unaffected by the runtime swap.

## Testing

- Backend tests move from plain `vitest` (running against a real Node
  process + a real sqlite file) to
  `@cloudflare/vitest-pool-workers` — Cloudflare's official
  Workers-runtime-accurate test runner. Each test file runs inside a
  real `workerd` environment with a local D1 binding; no hand-rolled
  Miniflare setup or mocking needed.
- Fastify's `app.inject()` calls are replaced with Hono's
  `app.request()` — the same "call the handler directly, assert on
  the Response" pattern, so all 66 existing tests are ported
  mechanically (same assertions, new call syntax) rather than
  rewritten from scratch.
- Frontend build/tests are unaffected — still a static Vite build,
  only the deployment mechanism changes.

## Deployment

- No CI/CD is being introduced. This repo has none today (manual
  `docker compose up`), and that stays consistent: deploys are run
  directly via `wrangler deploy` for each Worker, performed by the
  implementer at the end of the implementation plan, not wired into
  GitHub Actions.
- D1 database and both Workers are created/configured directly against
  the Cloudflare account confirmed above
  (`Ben.elliot@nice.com's Account`, id `9a42151a465b2da9ed7c88d6c72972de`,
  zone `nice-agentic.com`).

## Explicitly out of scope

- No changes to the access model, auth semantics, or any route's
  request/response contract beyond what's mechanically required by
  the runtime swap (async D1 calls, Hono syntax).
- No Durable Objects — D1 is sufficient and lower-risk for this app's
  scale and access patterns (see rationale exchanged during
  brainstorming: DO would require rewriting the repo layer's
  transaction model from scratch, unjustified for a personal tool).
- No GitHub Actions / CI pipeline.
- No changes to the frontend's own code beyond how/where it's built
  and served (Vite build output unchanged; only Nginx is removed in
  favour of Workers static assets).
