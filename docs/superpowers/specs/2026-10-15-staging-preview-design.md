# Staging-based PR previews — design

Status: draft, awaiting review. Date: 2026-10-15. Revised after review: reset
only on `labeled` (pushes keep data), occupant tracking added.

Supersedes the per-PR provisioning model in
`2026-09-30-pr-preview-environments-design.md`.

## Problem

The `preview` label provisions a per-PR D1 database by exporting all of
production, importing it, then scrubbing it. Cost scales with production's
size: on 2026-10-15 two provisions wrote about 71k rows, production wrote
about 29k, and the account crossed Cloudflare's free-tier cap of 100,000 D1
rows written per day (account-wide, all databases combined, resets 00:00
UTC). Writes were then rejected, which likely dropped webhook captures in
production. The cost grows as production grows (about 400 listeners/hour,
up to 200 requests each), so a single preview will soon exceed the whole
daily budget.

Numbers are a snapshot from 2026-10-15; re-measure before relying on them.

## Decision

Previews no longer copy production. The `preview` label deploys the PR to the
one long-lived **staging** environment, after wiping its database. Nothing is
ever synced from production.

This is a separate D1 database from production, but note it does not have its
own write budget: the cap is account-wide. The saving comes entirely from not
copying production, which makes a reset cost roughly the schema plus a
handful of statements, independent of production's size.

## Existing infrastructure (already in the repo)

- Backend: `[env.staging]` in `backend/wrangler.toml` — Worker
  `webhook-api-staging`, D1 `webhook-listener-staging`
  (`7f55f3f0-7fe0-4237-8307-8769755f4c3a`), workers.dev, no custom domain.
- Frontend: `[env.staging]` in `frontend/wrangler.toml` — Worker
  `webhook-staging`; `frontend/.env.staging` points at the staging backend;
  built with `vite build --mode staging`.
- `WL_SESSION_SECRET` and `RESEND_API_KEY` are set once as Workers secrets on
  the staging scripts and are not touched by the workflow.

## Behaviour

1. **Label added** (`labeled`): build the frontend with `--mode staging`,
   reset the staging D1 database, apply this branch's migrations, record the
   PR as the staging occupant, deploy both Workers with `--env staging`, and
   upsert a PR comment with the staging URLs. This is the only event that
   wipes staging.
2. **Push to a labelled PR** (`synchronize`): never wipes data, so a reviewer's
   hand-made listeners and requests survive pushes.
   - If this PR is the staging occupant: run `wrangler d1 migrations apply`
     (applies only new migrations, a no-op otherwise) and redeploy both
     Workers. Editing an already-applied migration is not picked up; re-add
     the label to reset.
   - If another PR is the occupant (or there is no occupant): do nothing to
     staging and upsert a comment on this PR: "staging holds #N; re-add the
     label to take over". Deploying this PR's code onto the other PR's schema
     would be wrong, and resetting would break rule 1.
3. **Occupant record.** After each reset the script creates a one-row
   `_staging_occupant` table (script-created, not a migration, so the prod
   schema is untouched) holding the PR number. Reset drops every table, so
   the record is cleared and rewritten with the data it describes.
4. **Last label wins.** If a second PR is labelled while the first still
   carries the label, the second run resets and takes over staging. Open PRs
   labelled `preview` other than the current one have their preview comment
   updated to "superseded by #N". The first PR takes staging back only by
   having its label removed and re-added.
5. **No seed data.** Staging starts empty after every reset. A reviewer creates
   their own listeners. Fixtures can be added later if a feature needs them.
6. **Label removed or PR closed:** no infrastructure action. If the PR was the
   most recent holder, its comment is updated to say the preview is no longer
   active. Staging keeps running that PR's code and data until the next label.
7. All runs share one `concurrency` group (`staging`, `cancel-in-progress:
false`), so they queue rather than race.

## Changes

- `scripts/preview-env/provision.mjs`: two modes. `reset` (on `labeled`):
  reset, migrate, write the occupant record, deploy. `redeploy` (on
  `synchronize`): read the occupant record, and only if it matches this PR,
  migrate and deploy; otherwise exit with a "not the occupant" result that
  the workflow turns into a comment. The mode decision is a pure function
  with unit tests.
  - Reset drops **every** table found in `sqlite_master` (excluding SQLite
    internals), not a hardcoded list, so a future migration adding a table
    cannot leave stale state. Includes `d1_migrations`.
  - Foreign-key ordering for drops must be verified against Miniflare D1 (drop
    children first, or disable FK enforcement for the reset).
  - Migrate with `wrangler d1 migrations apply DB --remote --env staging`
    from `backend/`.
- `.github/workflows/preview.yml`: one shared concurrency group; remove the
  teardown job and the `workflow_dispatch` PR-number input; remove the
  `write-frontend-env` step; remove `PREVIEW_RESEND_API_KEY`.
- `scripts/preview-env/upsert-comment.mjs`: states reduced to provisioned,
  failed, superseded, inactive. Add logic to find other open PRs with the
  `preview` label.
- Delete: `teardown.mjs`, `scrub.sql`, `backend/src/preview-scrub.test.ts`,
  `generate-wrangler-config.*`, `write-frontend-env.*`, `cloudflare-d1.*`
  and their tests, once confirmed unreferenced.
- Docs: rewrite "PR preview environments" in `CLAUDE.md` (the scrubbing
  contract and the `owner_email` paragraph go away); update `STATUS.md`.
- `CLOUDFLARE_API_TOKEN` still needs `D1: Edit` (to reset and migrate the
  staging database) and `Workers Scripts: Edit`. It no longer needs to create
  or delete databases or export production, but tightening it is optional and
  out of scope.

## Trade-offs accepted

- **No real-volume check.** Previews no longer exercise production-shaped
  data, so a migration that is fine on a tiny staging DB but slow at volume
  is only caught in production. The 0012/0013 index work is the example.
  Mitigation if wanted: a local Miniflare D1 loaded with generated rows,
  which costs no D1 budget. Out of scope here.
- **One preview at a time.** See "last label wins" above. Taking staging
  back means removing and re-adding the label.
- **Edited applied migrations need a re-label.** Pushes only apply new
  migrations.
- **Staging is also used for email tests.** A reset wipes whatever is there.

## Testing

- Unit tests (node:test, as the existing `*.test.mjs`) for the reset SQL
  generation, the labeled/synchronize/occupant mode decision, and the
  comment-state logic (including the "staging holds #N" state).
- Dry-run the reset and migrate sequence against local Miniflare D1,
  including a schema with foreign keys, before any remote run.
- A real remote run is deferred until the account's D1 write budget has reset
  and staging's reset cost has been estimated. After the first real run, read
  the staging database's `rowsWritten` for that hour from the D1 GraphQL
  analytics and record it in `STATUS.md`. Acceptance: a reset plus deploy
  writes under 5,000 rows and does not grow with production.

## Out of scope

- Reducing production's own write volume (it wrote about 29k rows on
  2026-10-15 and is growing; separate problem).
- A write-budget guard before provisioning (unnecessary once previews stop
  copying production).
- Migration 0013 and PR #16, which are independent.
