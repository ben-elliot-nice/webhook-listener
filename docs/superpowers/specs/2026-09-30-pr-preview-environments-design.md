# PR preview environments — design

## Why

Reviewing a PR against this repo today means reading a diff and trusting
the PR-check suite (`pr.yml`) — there's no way to click around the actual
running change, and no way to sense-check a new D1 migration against
anything resembling real data before it lands on `main` and the deploy
pipeline (`release.yml`) ships it straight to production. This spec adds
an opt-in, per-PR live preview environment: its own Worker pair and its
own D1 database, seeded from a scrubbed copy of production, with
migrations pre-applied — reviewable at a URL posted on the PR, torn down
automatically when the PR closes.

This is the first of two related pieces of work. A second, separate spec
will cover letting a PR opt into auto-applying its migration to
**production** at merge time, gated on this preview environment having
provisioned and migrated successfully plus an explicit human checkbox —
that piece is out of scope here and depends on this one already existing
and being trustworthy.

## Non-goals

- No automatic prod-migration application — that is sub-project 2's spec,
  not this one. This spec's migrations only ever touch a PR's own
  disposable D1 database.
- No preview environment for every PR — opt-in via a `preview` label
  only, per the brainstorming decision (cost of a full export/scrub/
  import/migrate cycle isn't worth paying for every trivial PR).
- No custom domain for preview URLs — `workers.dev` subdomains only,
  matching how the existing `[env.staging]` environment already works.
  No dependency on Zone:Workers Routes or the Custom Domains API.
- No changes to the existing shared `staging` environment
  (`webhook-api-staging` / `webhook-staging`) — preview environments are
  a parallel, per-PR-numbered mechanism, entirely separate resources.
- No attempt to preserve exact prod row _values_ for any sensitive
  column — the scrub step is one-way and deliberately destroys the
  original values (see Non-goals of the scrub step itself, below).

## Architecture

```
PR labeled "preview"                    PR pushed while labeled
        │                                        │
        ▼                                        ▼
  provision (first time,                   migrations touched?
  or migrations touched)                  ┌──────┴──────┐
        │                                 yes            no
        ▼                                  │              │
  export prod D1 → scrub → import           ▼              ▼
  → apply migrations                  (re-provision,   redeploy Worker
        │                              same as left)   code only against
        ▼                                                existing PR DB
  deploy both Workers (per-PR names)
        │
        ▼
  upsert PR comment with preview URLs


PR label removed / PR closed / PR merged
        │
        ▼
  delete both Workers, delete PR's D1 database, update PR comment
```

One new workflow, `.github/workflows/preview.yml`, triggered on
`pull_request` events `labeled`, `synchronize`, `unlabeled`, and `closed`,
gated on the PR carrying a `preview` label (checked via
`github.event.pull_request.labels`). Runs alongside the existing
`pr.yml` (unaffected) and independently of `release.yml` (which only
triggers on push to `main`).

## Component: per-PR resource naming

Given PR number `N`:

| Resource             | Name                                                       |
| -------------------- | ---------------------------------------------------------- |
| Backend Worker       | `webhook-api-pr-N`                                         |
| Frontend Worker      | `webhook-pr-N`                                             |
| D1 database          | `webhook-listener-pr-N`                                    |
| Backend preview URL  | `https://webhook-api-pr-N.<account-subdomain>.workers.dev` |
| Frontend preview URL | `https://webhook-pr-N.<account-subdomain>.workers.dev`     |

`<account-subdomain>` is this Cloudflare account's fixed `workers.dev`
subdomain (already visible in the existing `[env.staging]` URLs in both
`wrangler.toml` files) — not something generated per PR, just a fixed
string substituted into the generated config's `vars`.

## Component: `scripts/preview-env/generate-wrangler-config.mjs`

Templates a per-PR Wrangler config from the real `backend/wrangler.toml`
/ `frontend/wrangler.toml`, producing a temporary file
(`wrangler.pr-N.toml`, gitignored, written by CI and never committed)
with:

- `name` → the per-PR Worker name from the table above
- (`backend` only) the `[[d1_databases]] database_id` → the per-PR
  database's id (captured at creation time, see next component)
- `[vars] HOOK_BASE_URL` / `APP_BASE_URL` → the per-PR `workers.dev` URLs
  from the table above (both are knowable in advance from the PR number,
  so there's no ordering dependency between the two Workers' deploys)
- `SESSION_COOKIE_DOMAIN` → `""` (same reasoning as local dev / staging:
  a `workers.dev` URL can't be scoped to a custom cookie domain)
- Every other `[vars]` entry (e.g. `ALLOWED_EMAIL_DOMAINS`) copied
  through unchanged from the real config

This is a plain Node script (reads the TOML with a minimal hand-rolled
parser sufficient for this repo's two flat config files — no new
dependency added for a full TOML parser), invoked as
`node scripts/preview-env/generate-wrangler-config.mjs backend <N> <db-id>`
/ `... frontend <N>`, printing the path to the generated file.

## Component: `scripts/preview-env/scrub.sql`

Run via `wrangler d1 execute webhook-listener-pr-N --remote --file=scripts/preview-env/scrub.sql`
immediately after importing the prod export and before any Worker is
deployed against the new database:

```sql
UPDATE requests SET
  headers = '{}',
  query_params = '{}',
  body = NULL,
  source_ip = NULL;

UPDATE listeners SET
  share_token = CASE WHEN share_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
  webhook_token = CASE WHEN webhook_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
  owner_session = NULL,
  owner_email = CASE WHEN owner_email IS NOT NULL THEN 'scrubbed-' || id || '@example.invalid' ELSE NULL END;

UPDATE projects SET
  share_token = CASE WHEN share_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
  owner_session = NULL,
  owner_email = CASE WHEN owner_email IS NOT NULL THEN 'scrubbed-' || id || '@example.invalid' ELSE NULL END;

DELETE FROM magic_links;

UPDATE shared_with_me SET
  viewer_email = 'scrubbed-' || id || '@example.invalid',
  token = hex(randomblob(16));
```

**Non-goal of this file:** it is not a generic PII-scrubbing framework —
it is an explicit, hand-maintained list of every sensitive column in the
schema as of this spec. **Whenever a future migration adds a table or a
column that holds a token, email, IP address, or captured payload
content, this file must be updated in the same PR as that migration.**
This is a real, accepted maintenance cost (flagged during brainstorming),
not an oversight — a schema-introspecting auto-scrub was considered and
rejected as overkill for a five-table schema.

`CASE WHEN ... IS NOT NULL` guards preserve `NULL` where the source was
already `NULL` (e.g. a listener with no share link never gets a fake
token invented for it) — only columns with a real value get scrubbed to
a new value.

## Component: provisioning steps (`preview.yml`, provision path)

Triggered when: the `preview` label is added, or a push arrives on an
already-labeled PR and either (a) no per-PR D1 database exists yet for
this PR number, or (b) `git diff --name-only <base>...<head>` includes
any path under `backend/migrations/`.

1. `wrangler d1 list` (or the equivalent D1 REST API call) to check
   whether `webhook-listener-pr-N` already exists.
2. If it doesn't: `wrangler d1 create webhook-listener-pr-N`, capture the
   new `database_id` from the command's output.
   If it does (a migration-triggered re-provision on an existing PR):
   reuse the existing database, but first `DROP TABLE` every table in it
   (fresh start — this is a re-provision, not an incremental migration
   test) so the fresh export always lands on a clean slate.
3. `wrangler d1 export webhook-listener --remote --output=prod-dump.sql`
4. `wrangler d1 execute webhook-listener-pr-N --remote --file=prod-dump.sql`
5. `wrangler d1 execute webhook-listener-pr-N --remote --file=scripts/preview-env/scrub.sql`
6. `wrangler d1 migrations apply webhook-listener-pr-N --remote`
7. Generate both per-PR Wrangler configs (previous component), passing
   the `database_id` from step 2 into the backend one.
8. `wrangler deploy -c wrangler.pr-N.toml` (backend), then build +
   `wrangler deploy -c wrangler.pr-N.toml` (frontend).
9. Upsert the PR comment (next component) with both URLs and a
   "provisioned" status.

If any step 1-8 fails, the workflow still attempts step 9 with a
"provisioning failed, see workflow run" status and a link, rather than
leaving the PR comment silently stale.

## Component: redeploy-only steps (`preview.yml`, fast path)

Triggered when: a push arrives on an already-labeled PR, a per-PR D1
database already exists, and the diff touches no path under
`backend/migrations/`.

1. Generate both per-PR Wrangler configs (reusing the existing
   database's id — recorded in the PR comment's hidden marker, see next
   component, so this path doesn't need to re-query Cloudflare for it).
2. `wrangler deploy -c wrangler.pr-N.toml` (backend), build + deploy
   (frontend).
3. Upsert the PR comment.

## Component: PR comment

A single comment per PR, identified by a hidden HTML marker
(`<!-- preview-env:N -->`) so every run finds and edits it via
`gh api repos/:owner/:repo/issues/:number/comments` (list, find by
marker, `PATCH` if found, `POST` if not) rather than posting a new
comment each time. The comment body embeds the per-PR database's id
inside the same hidden-marker block (as an HTML comment, not visible
rendered) so the fast redeploy path can read it back without an extra
Cloudflare API round-trip:

```html
<!-- preview-env:42 db-id:7f55f3f0-... -->
### 🔗 Preview environment - Backend: https://webhook-api-pr-42.<subdomain
  >.workers.dev - Frontend: https://webhook-pr-42.<subdomain
    >.workers.dev Status: provisioned ✅ · [workflow run](...)</subdomain
  ></subdomain
>
```

## Component: teardown

Triggered on: `preview` label removed, or PR `closed` (covers both merge
and abandon-without-merge — GitHub's `closed` event fires for both,
distinguishable via `github.event.pull_request.merged` if ever needed,
but teardown behavior is identical either way).

1. `wrangler delete --name webhook-api-pr-N` (backend Worker)
2. `wrangler delete --name webhook-pr-N` (frontend Worker)
3. Delete the D1 database via the Cloudflare REST API directly
   (`DELETE /accounts/{account_id}/d1/database/{database_id}`) — current
   `wrangler d1 delete` requires interactive confirmation with no
   documented non-interactive flag, so this step calls the API directly
   with `CLOUDFLARE_API_TOKEN` rather than shelling out to a command that
   would hang in CI.
4. Update the PR comment to "torn down" (keep the comment, don't delete
   it — it's the historical record that a preview existed).

**Safety net:** a `workflow_dispatch` input (PR number, required) runs
just the teardown steps in isolation, for manually recovering an orphaned
environment if a `closed` event is ever missed (e.g. a workflow run
cancelled mid-way). Not automated further than a manual trigger — a
scheduled sweep for orphans is explicitly out of scope for this spec
(YAGNI unless it actually happens).

## Prerequisite: `CLOUDFLARE_API_TOKEN` permission change

The existing `CLOUDFLARE_API_TOKEN` secret (added for `release.yml`) is
currently scoped to `Workers Scripts: Edit` only. This spec's workflow
also needs `D1: Edit` (create/export/import/delete databases) on the same
account. This means editing that token's permissions in the Cloudflare
dashboard (or issuing a second, differently-scoped token) before this
ships — a manual, out-of-band step, same category as the original
`CLOUDFLARE_API_TOKEN` setup.

## Testing

- `scripts/preview-env/generate-wrangler-config.mjs` gets unit tests
  (plain Node, `node:test`) covering: name substitution, database_id
  substitution, var substitution, and that unrelated `[vars]` entries
  pass through unchanged — run against the real committed
  `wrangler.toml` files as fixtures, not hand-written mock TOML, so the
  test breaks loudly if the real files' shape ever changes in a way the
  parser can't handle.
- `scripts/preview-env/scrub.sql` is validated by a small backend test
  (new file, `backend/src/preview-scrub.test.ts`, reading the SQL from
  `../../scripts/preview-env/scrub.sql` — no duplicated copy of the
  statements) that seeds a
  D1 test instance (same `@cloudflare/vitest-pool-workers` harness this
  repo already uses) with one row per sensitive column pattern, runs the
  scrub SQL against it, and asserts every sensitive column changed and
  every `NULL`-guarded column stayed `NULL`. This is the regression net
  for the "must update `scrub.sql` when the schema changes" maintenance
  cost — it won't catch a _missing_ new sensitive column automatically,
  but it does lock in current behavior.
- The workflow itself (`preview.yml`) can only be validated by actually
  opening a labeled PR against this repo, the same way `pr.yml` and
  `release.yml` were validated — call this out explicitly when the
  implementation plan reaches that point, same as those two.

## Documentation updates

- `CLAUDE.md`: new subsection under "Deploying" (or its own subsection)
  documenting the `preview` label, what it provisions, the scrub
  script's maintenance obligation (update it when adding sensitive
  columns), and the teardown safety-net `workflow_dispatch` trigger.
- `STATUS.md`: new entry noting PR preview environments are live, and
  that sub-project 2 (opt-in prod auto-migration) is designed
  separately and not yet built.

## Addendum (2026-09-30, post-implementation): scrub no longer touches owner_email

Found via real usage on a live labeled PR: with `owner_email` fully
scrubbed (this spec's original design), a reviewer who signed in via the
real magic-link flow saw an empty account — none of the scrubbed rows'
`owner_email` matched their real email anymore, since every row's email
had been rewritten to `scrubbed-<id>@example.invalid`.

Revised design: `listeners.owner_email` and `projects.owner_email` are no
longer scrubbed. Everything else on those rows (share/webhook tokens,
`owner_session`) is still scrubbed, and `requests` (hook payload content)
is still fully scrubbed regardless of owner — only the ownership _link_
survives. This is judged safe because the email access gate already
requires proving ownership of a real inbox (via magic link) before
signing in as that email; preserving the link doesn't let anyone reach
data they couldn't already reach through the app's own auth, it just lets
a reviewer signing in as themselves see their own existing
(content-scrubbed) listeners/projects instead of an empty account.
`scripts/preview-env/scrub.sql` and `backend/src/preview-scrub.test.ts`
were updated together; see their inline comments for the same reasoning.
