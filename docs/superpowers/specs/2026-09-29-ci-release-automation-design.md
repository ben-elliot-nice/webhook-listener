# CI and automated release management — design

## Why

Every merge to `main` today is deployed by hand: no CI runs on pull
requests, there's no enforced commit convention, and `npm run deploy`
is a manual step in each of `backend/` and `frontend/`. This has
already produced at least one incident (a broken deploy around the
22nd that caused the CPU-limit warnings that kicked off the pagination
work) that automated tests-before-deploy would have caught before it
reached production.

This spec adds PR-time verification and a merge-time release pipeline
modelled on `cognigy-plugin`'s setup, adapted for the fact that this
repo isn't a published package — it's two independently deployed
Cloudflare Workers with no registry to publish to.

## Non-goals

- No npm publish — nothing in this repo ships to an npm registry.
- No automated D1 migrations. `db:migrate:remote` stays a manual,
  explicit step per the existing `CLAUDE.md` guidance — CI never runs
  it.
- No branch-protection changes. `main` has none today
  (`gh api repos/:owner/:repo/branches/main/protection` → 404); this
  spec doesn't add any, so the default `GITHUB_TOKEN` (contents:
  write) is sufficient for semantic-release to push its release commit
  directly to `main` — no GitHub App bypass token like the exemplar
  uses.
- No ESLint. Prettier only, matching the scope agreed in
  brainstorming.
- No preview/staging deploy environment for PRs. Cloudflare Workers
  preview URLs aren't part of this repo's setup and are out of scope.

## Architecture

Two GitHub Actions workflows, mirroring the exemplar's split between
"can this merge" and "what happens when it does":

```
PR opened/updated  ──►  pr.yml   (verify: commitlint, tests, build, prettier)
                                        │
                                   squash-merge
                                        ▼
push to main       ──►  release.yml  (semantic-release: version, changelog,
                                       GitHub Release, commit-back)
                                        │
                              release produced?
                                   yes │  no (chore/docs-only merge)
                                        ▼        └─► stop, no deploy
                              deploy backend + frontend to Cloudflare
```

Both workflows live at the repo root (`.github/workflows/`), not
inside `backend/` or `frontend/` — they orchestrate both packages, so
they don't belong to either.

## Component: root-level tooling package

The repo has no root `package.json` today; `backend/` and `frontend/`
each have their own, independently installed and deployed. This spec
adds a **third, tooling-only** `package.json` at the repo root:

```json
{
  "name": "webhook-listener",
  "private": true,
  "version": "0.0.0",
  "devDependencies": {
    "@commitlint/cli": "...",
    "@commitlint/config-conventional": "...",
    "@semantic-release/changelog": "...",
    "@semantic-release/commit-analyzer": "...",
    "@semantic-release/exec": "...",
    "@semantic-release/git": "...",
    "@semantic-release/release-notes-generator": "...",
    "husky": "...",
    "prettier": "...",
    "semantic-release": "..."
  }
}
```

This is **not** an npm workspaces root — `backend/` and `frontend/`
keep their own independent `package.json`, `package-lock.json`, and
`node_modules`, installed and tested exactly as they are today
(`cd backend && npm ci && npm test`, `cd frontend && npm ci && npm run
build`). The root package exists solely to hold the release/commit-lint/
format tooling and its own lockfile.

## Component: commit convention enforcement

- `commitlint.config.js` at the root, extending
  `@commitlint/config-conventional` (same as the exemplar).
- `.husky/commit-msg` — runs `commitlint --edit $1` locally on every
  commit.
- `.husky/pre-commit` — runs `prettier --check` on staged files
  matching `.ts`, `.tsx`, `.js`, `.json`, `.md`, `.yml` (scoped to
  changed files, not the whole repo, matching the exemplar).
- Husky is installed via a root `"prepare": "husky"` script, so `npm
  ci` at the root wires up the git hooks for any contributor.

## Component: `.prettierrc`

A minimal default config (no project-specific style has been chosen
yet):

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all"
}
```

This matches this repo's existing code style (double quotes, semicolons,
trailing commas are already the prevailing style in `backend/src` and
`frontend/src`), so applying `prettier --write` once at introduction
should produce a near-empty diff. The introducing PR runs
`prettier --write` across both `backend/src` and `frontend/src` once,
committed as its own `chore(format): apply prettier` commit so it
doesn't get tangled with the workflow-file changes.

## Component: `pr.yml`

Triggers: `pull_request` with `types: [opened, edited, synchronize,
reopened]` (matches the exemplar; `edited` re-runs the title check
when the title changes).

Steps:
1. Checkout with `fetch-depth: 0` (commitlint needs commit history).
2. Setup Node 24 (matching this repo's `mise use node@lts` convention;
   the exemplar's `pr.yml` uses 22, but this repo should track its own
   LTS pin).
3. **Validate commit messages**: `npx commitlint --from
   ${{ github.event.pull_request.base.sha }} --to ${{ github.sha }}
   --verbose` — installed from the root `package.json`.
4. **Validate PR title**: pipe `github.event.pull_request.title`
   through `commitlint` — because this repo squash-merges (confirmed
   empirically in the pagination-memory PR: a 14-commit branch became
   one commit on `main`), the PR title becomes the commit
   semantic-release reads, so it must itself be a valid conventional
   commit.
5. **Backend**: `cd backend && npm ci && npm test`.
6. **Frontend**: `cd frontend && npm ci && npm run build` (this
   already runs `tsc -b && vite build`, so it's both a typecheck and a
   build-succeeds gate).
7. **Prettier check**: collect changed files across the whole diff
   matching the tracked extensions (same file-collection approach as
   the exemplar's `pr.yml`) and run `prettier --check` against them
   from the root install. Skip the step entirely if no matching files
   changed.

All steps run in one job, sequentially — this repo is small enough
that splitting backend/frontend into a matrix isn't worth the added
complexity.

## Component: `release.yml`

Triggers: `push` to `main`, plus `workflow_dispatch` for a manual
re-run if a release run needs retriggering.

Permissions: `contents: write` (push the release commit + tag),
`issues: write`, `pull-requests: write` (semantic-release comments on
released issues/PRs) — no `id-token: write`, since there's no OIDC
npm publish here.

Steps:
1. Checkout with `fetch-depth: 0`, using the default `GITHUB_TOKEN`
   (no GitHub App needed — see Non-goals).
2. Setup Node 24.
3. `npm ci` at root.
4. `npx semantic-release`, governed by `.releaserc.json`:
   - `commit-analyzer` with the `conventionalcommits` preset and the
     same release-rule table as the exemplar (`feat`→minor,
     `fix`/`perf`/`revert`/`docs`/`refactor`→patch,
     `chore`/`test`/`build`/`ci`→no release).
   - `release-notes-generator`, same section mapping as the exemplar.
   - `@semantic-release/changelog` → writes/updates root
     `CHANGELOG.md`.
   - `@semantic-release/exec`, `prepareCmd` bumps `backend/package.json`
     and `frontend/package.json` versions to `${nextRelease.version}`
     via a small `scripts/sync-package-versions.mjs` (the repo-level
     analogue of the exemplar's `sync-plugin-version.mjs`) — this is
     informational only; nothing in either Worker reads its own
     `package.json` version at runtime.
   - `@semantic-release/git` commits `CHANGELOG.md`,
     `package.json`/`package-lock.json` (root),
     `backend/package.json`, `frontend/package.json` back to `main`
     as `chore(release): ${nextRelease.version} [skip ci]`.
   - `@semantic-release/github` creates the GitHub Release + tag.
   - **No `@semantic-release/npm` plugin** — nothing is published.
5. **Deploy gate**: semantic-release exits without creating a release
   when the merged commits don't warrant a version bump (e.g. a
   `chore`/`docs`-only PR). The workflow must not attempt to deploy in
   that case. Achieved via semantic-release's own exit behaviour:
   `@semantic-release/exec`'s `publishCmd` is used (not a separate
   workflow step) to run the deploy, since `publishCmd` only executes
   when a release was actually determined — this is the same
   mechanism the exemplar uses to gate `npm publish`, just repurposed
   to gate `wrangler deploy` instead:
   ```json
   ["@semantic-release/exec", {
     "prepareCmd": "node scripts/sync-package-versions.mjs ${nextRelease.version}",
     "publishCmd": "cd backend && npm ci && npm run deploy && cd ../frontend && npm ci && npm run build && npx wrangler deploy"
   }]
   ```
6. `CLOUDFLARE_API_TOKEN` is read from repo secrets by `wrangler`
   automatically (`wrangler deploy` picks it up from the
   `CLOUDFLARE_API_TOKEN` env var with no extra config) — set as a
   step-level or job-level `env:` on the release job.

## Prerequisite: Cloudflare API token

Before `release.yml` can deploy, a `CLOUDFLARE_API_TOKEN` secret must
exist on this GitHub repo. This is an out-of-band manual step (not
part of the implementation plan's file changes) — done once, before
or during rollout:

1. Cloudflare dashboard → My Profile → API Tokens → Create Token.
2. Scope: **Account** → Workers Scripts → Edit, for the account that
   owns zone `nice-agentic.com`
   (`cf2eae38525b377fd3de9af950bd476a`).
3. `gh secret set CLOUDFLARE_API_TOKEN --repo ben-elliot-nice/webhook-listener`,
   pasting the token when prompted.

## Rollout / sequencing risk

The introducing PR itself needs to pass its own new `pr.yml` checks
(commitlint on its own title/commits, prettier-clean) to merge, and
the first push to `main` after it merges will trigger `release.yml`
for the first time — with no prior git tag, semantic-release treats
this as the initial release (defaults to `1.0.0` unless commit history
implies otherwise). This is expected and fine: the repo currently has
no version semantics, so `1.0.0` is a reasonable starting point,
documented in `STATUS.md` as the baseline.

The `CLOUDFLARE_API_TOKEN` secret must be in place **before** this
first merge, or the first release will succeed (version/changelog/tag)
but the deploy step will fail — semantic-release doesn't roll back a
just-created release if a later `publishCmd` step fails, so the plan
must call out running the token setup first.

## Testing

- `pr.yml` is validated by opening the introducing PR itself and
  confirming its own checks pass (commitlint, tests, build, prettier)
  — this is the first real exercise of the workflow.
- `release.yml` is validated by observing the actual release run after
  merge: correct version bump, changelog content, GitHub Release
  created, both Workers deployed and live (same `curl` verification
  pattern used for the pagination-memory deploy).
- No unit tests are meaningful for GitHub Actions YAML itself; the
  `scripts/sync-package-versions.mjs` helper (plain Node, no
  dependencies) gets a small script-level test or a manual `node
  scripts/sync-package-versions.mjs 1.2.3 --dry-run` check.

## Documentation updates

- `CLAUDE.md` (root): update "Deploying" section — deploys are now
  automatic on merge to `main` via `release.yml`; `npm run deploy` in
  each package remains available for manual/emergency redeploys but is
  no longer the normal path. Update "Commits" section to note
  Conventional Commits are now enforced by commitlint, not just
  followed by convention.
- `STATUS.md`: note the CI/release pipeline is live, and the initial
  version baseline (`1.0.0`).
