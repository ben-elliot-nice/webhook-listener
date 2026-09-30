# PR Preview Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a `preview`-labeled PR its own live Cloudflare Worker pair + D1 database, seeded from a scrubbed copy of production with migrations pre-applied, reviewable at a URL posted on the PR, torn down automatically on label removal or PR close.

**Architecture:** A new `.github/workflows/preview.yml` with two jobs (`deploy-preview`, `teardown`) that are thin YAML orchestration over five small, independently-tested Node scripts under `scripts/preview-env/` — the real logic (config templating, DB lifecycle via Cloudflare's REST API, PR-comment upsert, provision/teardown orchestration) lives in those scripts, not inline bash, so it can be unit tested.

**Tech Stack:** GitHub Actions, plain Node (`node:test`, no new dependencies), Cloudflare's D1 REST API (`fetch`), `wrangler` CLI (deploy/export/execute/migrations), GitHub REST API (`fetch`) for PR comments.

**Spec:** `docs/superpowers/specs/2026-09-30-pr-preview-environments-design.md`

## Global Constraints

- Opt-in only: preview environments are provisioned only for PRs carrying a `preview` label — never automatically.
- Per-PR resources: backend Worker `webhook-api-pr-<N>`, frontend Worker `webhook-pr-<N>`, D1 database `webhook-listener-pr-<N>`. `workers.dev` URLs only — no custom domain, no Zone:Workers Routes dependency.
- The existing shared `staging` environment (`webhook-api-staging` / `webhook-staging` / `webhook-listener-staging`) is never touched by anything in this plan.
- Full provision (export prod → scrub → import → migrate) runs only when no per-PR database exists yet, or when the PR's diff touches `backend/migrations/`. Otherwise, a push to an already-labeled PR only redeploys Worker code against the existing per-PR database.
- Scrub coverage (exact statements, from the spec): `requests.headers`/`query_params` → `'{}'`, `requests.body`/`source_ip` → `NULL`; `listeners`/`projects` `share_token`/`webhook_token` → regenerated via `hex(randomblob(16))` (only where already non-`NULL`); `owner_session` → `NULL`; `owner_email` → `'scrubbed-' || id || '@example.invalid'` (only where already non-`NULL`); `magic_links` → all rows deleted; `shared_with_me.viewer_email`/`token` → placeholder/regenerated (both `NOT NULL` columns, so never set to `NULL`).
- **Deviation from the spec's literal wording, discovered during planning:** the spec's Testing section says the backend scrub test should read `scripts/preview-env/scrub.sql` from disk via `fs`. This repo's backend tests run inside `@cloudflare/vitest-pool-workers`' workerd sandbox, which has no confirmed Node `fs`/filesystem access (no `nodejs_compat` compatibility flag is set in `backend/wrangler.toml`, and no existing test in this repo uses `node:fs`). Task 2 below instead inlines the scrub SQL as a duplicated string constant in the test file, with an explicit comment in both files pointing at each other so they're kept in sync by convention. This is a correction to an implementation-level assumption in the spec, not a scope change.
- Teardown must be resilient to partial/repeated runs (a Worker or database that's already gone is not an error) — every teardown step continues past a failure in an earlier step rather than aborting.
- Node version: 24, matching the rest of this repo's CI (per the earlier CI/release plan).
- **Second deviation from the spec, discovered during planning:** the spec's PR-comment component describes the redeploy-only path reading the existing database id back out of the PR comment's hidden marker "without an extra Cloudflare API round-trip." This plan does not implement that optimization — `provision.mjs` (Task 5) always calls `findD1DatabaseIdByName` (Task 4) directly against Cloudflare's API to determine whether a database already exists, on every run. This is simpler and more robust (survives a manually-edited or deleted PR comment) at the cost of one extra fast API call per run — negligible next to the `wrangler deploy` calls the same run already makes. `upsert-comment.mjs` (Task 3) still embeds the database id in the comment marker for human visibility/debugging, and still exports a tested `extractDatabaseId` function, but its CLI has no `get-db-id` mode, since nothing calls it.
- A new `CLOUDFLARE_ACCOUNT_ID` repository variable is required (see Manual Prerequisites) — this is not mentioned in the spec, which only flagged the `CLOUDFLARE_API_TOKEN` permission upgrade. It's needed because the Cloudflare D1 REST API (Task 4) takes an explicit account id in its URL path, unlike the `wrangler` CLI (which infers it from the token).

## Manual Prerequisites (not tasks below — require your Cloudflare/GitHub access)

Three things must exist before this plan's workflow can run successfully. None of them are code changes:

1. **Upgrade the existing `CLOUDFLARE_API_TOKEN` secret's permissions** (or create a second, differently-scoped token and update the secret) to add `Account → D1 → Edit`, alongside its existing `Account → Workers Scripts → Edit`. Without this, every D1 create/export/execute/migrate/delete call in this plan will fail with a permissions error.
2. **Add a new repository variable** (not a secret — the account ID isn't sensitive) named `CLOUDFLARE_ACCOUNT_ID` with value `9a42151a465b2da9ed7c88d6c72972de` (confirmed via `wrangler whoami` locally):
   ```bash
   gh variable set CLOUDFLARE_ACCOUNT_ID --body 9a42151a465b2da9ed7c88d6c72972de --repo ben-elliot-nice/webhook-listener
   ```
3. **Create the `preview` label** on the repo, if it doesn't already exist:
   ```bash
   gh label create preview --repo ben-elliot-nice/webhook-listener --color 0e8a16 --description "Provision a live PR preview environment"
   ```

Do these before merging the PR that includes Task 6 (the workflow itself), or before adding the `preview` label to any PR for the first time.

---

### Task 1: `generate-wrangler-config.mjs` (TDD)

**Files:**
- Create: `scripts/preview-env/generate-wrangler-config.mjs`
- Test: `scripts/preview-env/generate-wrangler-config.test.mjs`
- Modify: `.gitignore` (add generated-file pattern)

**Interfaces:**
- Produces: `extractWorkersDevSubdomain(backendTomlText: string): string` and `generatePreviewConfig({ target: 'backend'|'frontend', prNumber: string, tomlText: string, subdomain: string, databaseId?: string }): string` (named exports) — consumed directly (as JS imports, not CLI) by Task 5's `provision.mjs`. Also a CLI entry point: `node generate-wrangler-config.mjs <backend|frontend> <pr-number> [database-id]`, which writes `<target>/wrangler.pr-<N>.toml` and prints its path — this CLI form is not used by later tasks (they import the functions directly) but exists for manual debugging.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extractWorkersDevSubdomain, generatePreviewConfig } from './generate-wrangler-config.mjs'

const backendToml = readFileSync(new URL('../../backend/wrangler.toml', import.meta.url), 'utf8')
const frontendToml = readFileSync(new URL('../../frontend/wrangler.toml', import.meta.url), 'utf8')

test('extractWorkersDevSubdomain finds the staging subdomain', () => {
  assert.equal(extractWorkersDevSubdomain(backendToml), 'ben-elliot-9a4')
})

test('extractWorkersDevSubdomain throws when no staging URL is present', () => {
  assert.throws(() => extractWorkersDevSubdomain('name = "x"'))
})

test('generatePreviewConfig substitutes backend name, database_id, and URLs', () => {
  const output = generatePreviewConfig({
    target: 'backend',
    prNumber: '42',
    tomlText: backendToml,
    subdomain: 'ben-elliot-9a4',
    databaseId: 'test-db-id-123',
  })
  assert.match(output, /^name = "webhook-api-pr-42"$/m)
  assert.match(output, /^database_id = "test-db-id-123"$/m)
  assert.match(output, /^HOOK_BASE_URL = "https:\/\/webhook-api-pr-42\.ben-elliot-9a4\.workers\.dev"$/m)
  assert.match(output, /^APP_BASE_URL = "https:\/\/webhook-pr-42\.ben-elliot-9a4\.workers\.dev"$/m)
  assert.match(output, /^SESSION_COOKIE_DOMAIN = ""$/m)
})

test('generatePreviewConfig passes ALLOWED_EMAIL_DOMAINS through unchanged', () => {
  const output = generatePreviewConfig({
    target: 'backend',
    prNumber: '42',
    tomlText: backendToml,
    subdomain: 'ben-elliot-9a4',
    databaseId: 'test-db-id-123',
  })
  assert.match(output, /^ALLOWED_EMAIL_DOMAINS = "nice\.com,cognigy\.com"$/m)
})

test('generatePreviewConfig leaves the [env.staging] block byte-identical', () => {
  const output = generatePreviewConfig({
    target: 'backend',
    prNumber: '42',
    tomlText: backendToml,
    subdomain: 'ben-elliot-9a4',
    databaseId: 'test-db-id-123',
  })
  const originalStagingBlock = backendToml.slice(backendToml.indexOf('[env.staging]'))
  const outputStagingBlock = output.slice(output.indexOf('[env.staging]'))
  assert.equal(outputStagingBlock, originalStagingBlock)
})

test('generatePreviewConfig substitutes frontend name only, no database_id needed', () => {
  const output = generatePreviewConfig({
    target: 'frontend',
    prNumber: '42',
    tomlText: frontendToml,
    subdomain: 'ben-elliot-9a4',
  })
  assert.match(output, /^name = "webhook-pr-42"$/m)
})

test('generatePreviewConfig throws for a backend target with no databaseId', () => {
  assert.throws(() =>
    generatePreviewConfig({ target: 'backend', prNumber: '42', tomlText: backendToml, subdomain: 'x' }),
  )
})
```

Save to `scripts/preview-env/generate-wrangler-config.test.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/preview-env/generate-wrangler-config.test.mjs`
Expected: FAIL — `Error: Cannot find module '.../scripts/preview-env/generate-wrangler-config.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE_FILES = {
  backend: 'backend/wrangler.toml',
  frontend: 'frontend/wrangler.toml',
}

const DEFAULT_NAMES = {
  backend: 'webhook-api',
  frontend: 'webhook',
}

const ENV_STAGING_MARKER = '[env.staging]'

export function extractWorkersDevSubdomain(backendTomlText) {
  const match = backendTomlText.match(/-staging\.([a-z0-9-]+)\.workers\.dev/)
  if (!match) {
    throw new Error(
      'Could not find a *-staging.<subdomain>.workers.dev URL in backend/wrangler.toml to derive the account subdomain from',
    )
  }
  return match[1]
}

export function generatePreviewConfig({ target, prNumber, tomlText, subdomain, databaseId }) {
  const stagingIndex = tomlText.indexOf(ENV_STAGING_MARKER)
  const defaultSection = stagingIndex === -1 ? tomlText : tomlText.slice(0, stagingIndex)
  const rest = stagingIndex === -1 ? '' : tomlText.slice(stagingIndex)

  const workerName = target === 'backend' ? `webhook-api-pr-${prNumber}` : `webhook-pr-${prNumber}`

  let transformed = defaultSection.replace(
    new RegExp(`^name = "${DEFAULT_NAMES[target]}"$`, 'm'),
    `name = "${workerName}"`,
  )

  if (target === 'backend') {
    if (!databaseId) {
      throw new Error('databaseId is required when target is "backend"')
    }
    transformed = transformed.replace(/^database_id = ".+"$/m, `database_id = "${databaseId}"`)
    transformed = transformed.replace(
      /^HOOK_BASE_URL = ".+"$/m,
      `HOOK_BASE_URL = "https://webhook-api-pr-${prNumber}.${subdomain}.workers.dev"`,
    )
    transformed = transformed.replace(
      /^APP_BASE_URL = ".+"$/m,
      `APP_BASE_URL = "https://webhook-pr-${prNumber}.${subdomain}.workers.dev"`,
    )
    transformed = transformed.replace(/^SESSION_COOKIE_DOMAIN = ".*"$/m, `SESSION_COOKIE_DOMAIN = ""`)
  }

  return transformed + rest
}

function main() {
  const [target, prNumber, databaseIdArg] = process.argv.slice(2)
  if (target !== 'backend' && target !== 'frontend') {
    console.error('Usage: generate-wrangler-config.mjs <backend|frontend> <pr-number> [database-id]')
    process.exit(1)
  }
  if (!prNumber) {
    console.error('Usage: generate-wrangler-config.mjs <backend|frontend> <pr-number> [database-id]')
    process.exit(1)
  }
  if (target === 'backend' && !databaseIdArg) {
    console.error('database-id is required when target is "backend"')
    process.exit(1)
  }

  const backendTomlText = readFileSync(SOURCE_FILES.backend, 'utf8')
  const subdomain = extractWorkersDevSubdomain(backendTomlText)
  const sourceTomlText = target === 'backend' ? backendTomlText : readFileSync(SOURCE_FILES.frontend, 'utf8')

  const generated = generatePreviewConfig({
    target,
    prNumber,
    tomlText: sourceTomlText,
    subdomain,
    databaseId: databaseIdArg,
  })

  const outputPath = `${target}/wrangler.pr-${prNumber}.toml`
  writeFileSync(outputPath, generated)
  console.log(outputPath)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
```

Save to `scripts/preview-env/generate-wrangler-config.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/preview-env/generate-wrangler-config.test.mjs`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Add the gitignore entry**

Add this line to the repo's root `.gitignore`:

```
wrangler.pr-*.toml
```

- [ ] **Step 6: Commit**

```bash
git add scripts/preview-env/generate-wrangler-config.mjs scripts/preview-env/generate-wrangler-config.test.mjs .gitignore
git commit -m "feat: add per-PR wrangler config generator"
```

---

### Task 2: `scrub.sql` + backend scrub test

**Files:**
- Create: `scripts/preview-env/scrub.sql`
- Test: `backend/src/preview-scrub.test.ts`

**Interfaces:**
- Produces: the exact SQL statements consumed by Task 5's `provision.mjs` via `wrangler d1 execute <db> --remote --file=scripts/preview-env/scrub.sql`.

- [ ] **Step 1: Write scrub.sql**

```sql
-- Scrubs a copy of production data before it's exposed in a PR preview
-- environment. Every sensitive column in the schema is listed here
-- explicitly — there is no schema introspection. Whenever a migration
-- adds a table or column holding a token, email, IP address, or captured
-- payload content, THIS FILE MUST BE UPDATED in the same PR.
--
-- Mirrored (duplicated, not imported) in backend/src/preview-scrub.test.ts
-- because backend tests run inside a workerd sandbox with no confirmed
-- filesystem access — keep both in sync by hand.

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

Save to `scripts/preview-env/scrub.sql`.

- [ ] **Step 2: Write the backend test**

```ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

// Mirrors scripts/preview-env/scrub.sql exactly. Duplicated (not read from
// disk) because backend tests run inside a workerd sandbox with no
// confirmed filesystem access — if you change one, change the other.
const SCRUB_STATEMENTS = [
  `UPDATE requests SET
    headers = '{}',
    query_params = '{}',
    body = NULL,
    source_ip = NULL`,
  `UPDATE listeners SET
    share_token = CASE WHEN share_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
    webhook_token = CASE WHEN webhook_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
    owner_session = NULL,
    owner_email = CASE WHEN owner_email IS NOT NULL THEN 'scrubbed-' || id || '@example.invalid' ELSE NULL END`,
  `UPDATE projects SET
    share_token = CASE WHEN share_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
    owner_session = NULL,
    owner_email = CASE WHEN owner_email IS NOT NULL THEN 'scrubbed-' || id || '@example.invalid' ELSE NULL END`,
  `DELETE FROM magic_links`,
  `UPDATE shared_with_me SET
    viewer_email = 'scrubbed-' || id || '@example.invalid',
    token = hex(randomblob(16))`,
]

async function runScrub() {
  for (const statement of SCRUB_STATEMENTS) {
    await env.DB.prepare(statement).run()
  }
}

describe('preview environment scrub script', () => {
  it('nulls request payload content but preserves row shape', async () => {
    await env.DB.prepare(`INSERT INTO listeners (id, created_at) VALUES (?1, ?2)`)
      .bind('listener-1', '2024-01-01T00:00:00.000Z')
      .run()

    await env.DB.prepare(
      `INSERT INTO requests (listener_id, method, headers, query_params, body, content_type, source_ip, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        'listener-1',
        'POST',
        '{"authorization":"secret"}',
        '{"token":"abc"}',
        'raw webhook body content',
        'application/json',
        '203.0.113.5',
        '2024-01-01T00:00:01.000Z',
      )
      .run()

    await runScrub()

    const row = await env.DB.prepare('SELECT * FROM requests WHERE listener_id = ?1').bind('listener-1').first()
    expect(row.headers).toBe('{}')
    expect(row.query_params).toBe('{}')
    expect(row.body).toBeNull()
    expect(row.source_ip).toBeNull()
    expect(row.method).toBe('POST')
    expect(row.content_type).toBe('application/json')
  })

  it('regenerates listener tokens and scrubs owner fields when set', async () => {
    await env.DB.prepare(
      `INSERT INTO listeners (id, created_at, share_token, webhook_token, owner_session, owner_email)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        'listener-2',
        '2024-01-01T00:00:00.000Z',
        'real-share-token',
        'real-webhook-token',
        'real-owner-session',
        'real-owner@example.com',
      )
      .run()

    await runScrub()

    const row = await env.DB.prepare('SELECT * FROM listeners WHERE id = ?1').bind('listener-2').first()
    expect(row.share_token).not.toBe('real-share-token')
    expect(row.share_token).toMatch(/^[0-9a-f]{32}$/)
    expect(row.webhook_token).not.toBe('real-webhook-token')
    expect(row.webhook_token).toMatch(/^[0-9a-f]{32}$/)
    expect(row.owner_session).toBeNull()
    expect(row.owner_email).toBe('scrubbed-listener-2@example.invalid')
  })

  it('leaves listener tokens NULL when they were already NULL', async () => {
    await env.DB.prepare(`INSERT INTO listeners (id, created_at) VALUES (?1, ?2)`)
      .bind('listener-3', '2024-01-01T00:00:00.000Z')
      .run()

    await runScrub()

    const row = await env.DB.prepare('SELECT * FROM listeners WHERE id = ?1').bind('listener-3').first()
    expect(row.share_token).toBeNull()
    expect(row.webhook_token).toBeNull()
    expect(row.owner_email).toBeNull()
  })

  it('regenerates project share_token and scrubs owner fields when set', async () => {
    await env.DB.prepare(
      `INSERT INTO projects (id, created_at, owner_session, owner_email, share_token)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind('project-1', '2024-01-01T00:00:00.000Z', 'real-owner-session', 'real-owner@example.com', 'real-project-share-token')
      .run()

    await runScrub()

    const row = await env.DB.prepare('SELECT * FROM projects WHERE id = ?1').bind('project-1').first()
    expect(row.share_token).not.toBe('real-project-share-token')
    expect(row.share_token).toMatch(/^[0-9a-f]{32}$/)
    expect(row.owner_session).toBeNull()
    expect(row.owner_email).toBe('scrubbed-project-1@example.invalid')
  })

  it('deletes all magic_links rows', async () => {
    await env.DB.prepare(
      `INSERT INTO magic_links (token_hash, email, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind('hash-1', 'real@example.com', '2024-01-01T01:00:00.000Z', '2024-01-01T00:00:00.000Z')
      .run()

    await runScrub()

    const row = await env.DB.prepare('SELECT COUNT(*) as count FROM magic_links').first()
    expect(row.count).toBe(0)
  })

  it('scrubs shared_with_me viewer_email and token', async () => {
    await env.DB.prepare(
      `INSERT INTO shared_with_me (viewer_email, kind, token, first_visited_at, last_visited_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind('real-viewer@example.com', 'listener', 'real-share-token', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
      .run()

    await runScrub()

    const row = await env.DB.prepare('SELECT * FROM shared_with_me').first()
    expect(row.viewer_email).toMatch(/^scrubbed-\d+@example\.invalid$/)
    expect(row.token).not.toBe('real-share-token')
    expect(row.token).toMatch(/^[0-9a-f]{32}$/)
  })
})
```

Save to `backend/src/preview-scrub.test.ts`. Note: no `beforeEach`/cleanup is needed — this repo's vitest-pool-workers setup gives each `it()` block isolated storage starting from the post-migration state (confirmed by every other existing test file in this repo, none of which reset state between tests).

- [ ] **Step 3: Run the test**

Run: `cd backend && npm test -- preview-scrub`
Expected: PASS — all 6 tests green.

- [ ] **Step 4: Run the full backend suite to confirm no regressions**

Run: `cd backend && npm test`
Expected: same pass count as before this task, plus 6 new passing tests (this repo's documented baseline is 284/285 passing locally, with one known, pre-existing, expected `SESSION_COOKIE_DOMAIN` failure unrelated to this change).

- [ ] **Step 5: Commit**

```bash
git add scripts/preview-env/scrub.sql backend/src/preview-scrub.test.ts
git commit -m "feat: add preview environment data scrub script"
```

---

### Task 3: `upsert-comment.mjs` (TDD)

**Files:**
- Create: `scripts/preview-env/upsert-comment.mjs`
- Test: `scripts/preview-env/upsert-comment.test.mjs`

**Interfaces:**
- Produces: `buildCommentBody({ prNumber, databaseId, status, backendUrl, frontendUrl, runUrl }): string`, `findExistingComment(comments: {id:number, body:string}[], prNumber: string): {id:number, body:string}|null`, `extractDatabaseId(commentBody: string): string|null` (named exports, pure, no network calls — unit tested directly; `extractDatabaseId` is exported and tested for the marker's documentation/debugging value, but nothing in this plan calls it — see the Global Constraints note on the dropped comment-based lookup optimization). Also a CLI: `node upsert-comment.mjs upsert <pr> <status> <backendUrl> <frontendUrl> <databaseId> <runUrl>` — consumed by Task 6's workflow YAML, reading `GITHUB_TOKEN` and `GITHUB_REPOSITORY` from the environment (both already provided automatically by GitHub Actions).
- `status` is one of `'provisioned' | 'failed' | 'torn-down'`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCommentBody, findExistingComment, extractDatabaseId } from './upsert-comment.mjs'

test('buildCommentBody includes the marker with pr number and database id', () => {
  const body = buildCommentBody({
    prNumber: '42',
    databaseId: 'db-abc',
    status: 'provisioned',
    backendUrl: 'https://webhook-api-pr-42.example.workers.dev',
    frontendUrl: 'https://webhook-pr-42.example.workers.dev',
    runUrl: 'https://github.com/x/y/actions/runs/1',
  })
  assert.match(body, /^<!-- preview-env:42 db-id:db-abc -->/)
  assert.match(body, /Backend: https:\/\/webhook-api-pr-42\.example\.workers\.dev/)
  assert.match(body, /Frontend: https:\/\/webhook-pr-42\.example\.workers\.dev/)
  assert.match(body, /provisioned ✅/)
})

test('buildCommentBody renders a failed status without URLs', () => {
  const body = buildCommentBody({
    prNumber: '42',
    databaseId: null,
    status: 'failed',
    backendUrl: '',
    frontendUrl: '',
    runUrl: 'https://github.com/x/y/actions/runs/1',
  })
  assert.match(body, /provisioning failed ❌/)
})

test('buildCommentBody renders a torn-down status', () => {
  const body = buildCommentBody({
    prNumber: '42',
    databaseId: null,
    status: 'torn-down',
    backendUrl: '',
    frontendUrl: '',
    runUrl: 'https://github.com/x/y/actions/runs/1',
  })
  assert.match(body, /torn down 🧹/)
})

test('buildCommentBody throws for an unknown status', () => {
  assert.throws(() =>
    buildCommentBody({ prNumber: '42', databaseId: null, status: 'bogus', backendUrl: '', frontendUrl: '', runUrl: '' }),
  )
})

test('findExistingComment finds a comment matching the marker prefix for the given PR', () => {
  const comments = [
    { id: 1, body: '<!-- preview-env:41 db-id:none -->\nsomething else' },
    { id: 2, body: '<!-- preview-env:42 db-id:db-abc -->\n### 🔗 Preview environment' },
  ]
  assert.equal(findExistingComment(comments, '42').id, 2)
})

test('findExistingComment returns null when no comment matches', () => {
  assert.equal(findExistingComment([{ id: 1, body: 'unrelated comment' }], '42'), null)
})

test('extractDatabaseId reads the db-id out of a comment body', () => {
  assert.equal(extractDatabaseId('<!-- preview-env:42 db-id:db-abc -->\nbody'), 'db-abc')
})

test('extractDatabaseId returns null when the marker says "none"', () => {
  assert.equal(extractDatabaseId('<!-- preview-env:42 db-id:none -->\nbody'), null)
})
```

Save to `scripts/preview-env/upsert-comment.test.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/preview-env/upsert-comment.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
const MARKER_PREFIX = '<!-- preview-env:'

export function buildCommentBody({ prNumber, databaseId, status, backendUrl, frontendUrl, runUrl }) {
  const marker = `${MARKER_PREFIX}${prNumber} db-id:${databaseId ?? 'none'} -->`
  const lines = [marker, '### 🔗 Preview environment', '']

  if (status === 'provisioned') {
    lines.push(`- Backend: ${backendUrl}`)
    lines.push(`- Frontend: ${frontendUrl}`)
    lines.push('')
    lines.push(`Status: provisioned ✅ · [workflow run](${runUrl})`)
  } else if (status === 'failed') {
    lines.push(`Status: provisioning failed ❌ · [workflow run](${runUrl})`)
  } else if (status === 'torn-down') {
    lines.push(`Status: torn down 🧹 · [workflow run](${runUrl})`)
  } else {
    throw new Error(`Unknown status: ${status}`)
  }

  return lines.join('\n')
}

export function findExistingComment(comments, prNumber) {
  const prefix = `${MARKER_PREFIX}${prNumber} `
  return comments.find((comment) => comment.body.startsWith(prefix)) ?? null
}

export function extractDatabaseId(commentBody) {
  const match = commentBody.match(/db-id:([^\s]+) -->/)
  if (!match || match[1] === 'none') {
    return null
  }
  return match[1]
}

async function githubFetch(path, options = {}) {
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (!token || !repo) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY environment variables are required')
  }
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status} ${await response.text()}`)
  }
  return response.status === 204 ? null : response.json()
}

async function upsertComment({ prNumber, databaseId, status, backendUrl, frontendUrl, runUrl }) {
  const comments = await githubFetch(`/issues/${prNumber}/comments`)
  const existing = findExistingComment(comments, prNumber)
  const body = buildCommentBody({ prNumber, databaseId, status, backendUrl, frontendUrl, runUrl })

  if (existing) {
    await githubFetch(`/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
  } else {
    await githubFetch(`/issues/${prNumber}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  if (command === 'upsert') {
    const [prNumber, status, backendUrl, frontendUrl, databaseId, runUrl] = args
    await upsertComment({ prNumber, status, backendUrl, frontendUrl, databaseId: databaseId || null, runUrl })
    return
  }

  console.error('Usage: upsert-comment.mjs upsert <pr> <status> <backendUrl> <frontendUrl> <databaseId> <runUrl>')
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
```

Save to `scripts/preview-env/upsert-comment.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/preview-env/upsert-comment.test.mjs`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/preview-env/upsert-comment.mjs scripts/preview-env/upsert-comment.test.mjs
git commit -m "feat: add PR comment upsert script for preview environments"
```

---

### Task 4: `cloudflare-d1.mjs` (TDD)

**Files:**
- Create: `scripts/preview-env/cloudflare-d1.mjs`
- Test: `scripts/preview-env/cloudflare-d1.test.mjs`

**Interfaces:**
- Produces: `createD1Database({ accountId, name, apiToken, fetchImpl? }): Promise<string>` (returns the new database's uuid), `findD1DatabaseIdByName({ accountId, name, apiToken, fetchImpl? }): Promise<string|null>`, `deleteD1Database({ accountId, databaseId, apiToken, fetchImpl? }): Promise<void>` (named exports, each accepting an injectable `fetchImpl` defaulting to global `fetch`, for testability without real network calls) — consumed by Task 5's `provision.mjs` and `teardown.mjs`. Also a CLI: `node cloudflare-d1.mjs create <name>`, `find <name>`, `delete <database-id>`, reading `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createD1Database, findD1DatabaseIdByName, deleteD1Database } from './cloudflare-d1.mjs'

test('createD1Database posts to the create endpoint and returns the uuid', async () => {
  let capturedUrl, capturedOptions
  const fetchImpl = async (url, options) => {
    capturedUrl = url
    capturedOptions = options
    return { ok: true, json: async () => ({ result: { uuid: 'new-db-id' } }) }
  }

  const id = await createD1Database({ accountId: 'acct-1', name: 'db-name', apiToken: 'token-1', fetchImpl })

  assert.equal(id, 'new-db-id')
  assert.equal(capturedUrl, 'https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database')
  assert.equal(capturedOptions.method, 'POST')
  assert.equal(capturedOptions.headers.Authorization, 'Bearer token-1')
  assert.deepEqual(JSON.parse(capturedOptions.body), { name: 'db-name' })
})

test('createD1Database throws with response details on failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'bad request' })
  await assert.rejects(
    () => createD1Database({ accountId: 'acct-1', name: 'db-name', apiToken: 'token-1', fetchImpl }),
    /400/,
  )
})

test('findD1DatabaseIdByName returns the matching database uuid', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /\/d1\/database\?name=db-name$/)
    return {
      ok: true,
      json: async () => ({ result: [{ name: 'other-db', uuid: 'x' }, { name: 'db-name', uuid: 'found-id' }] }),
    }
  }
  const id = await findD1DatabaseIdByName({ accountId: 'acct-1', name: 'db-name', apiToken: 'token-1', fetchImpl })
  assert.equal(id, 'found-id')
})

test('findD1DatabaseIdByName returns null when no database matches', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: [] }) })
  const id = await findD1DatabaseIdByName({ accountId: 'acct-1', name: 'db-name', apiToken: 'token-1', fetchImpl })
  assert.equal(id, null)
})

test('deleteD1Database calls the delete endpoint with the right method and auth header', async () => {
  let capturedUrl, capturedOptions
  const fetchImpl = async (url, options) => {
    capturedUrl = url
    capturedOptions = options
    return { ok: true }
  }
  await deleteD1Database({ accountId: 'acct-1', databaseId: 'db-1', apiToken: 'token-1', fetchImpl })
  assert.equal(capturedUrl, 'https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database/db-1')
  assert.equal(capturedOptions.method, 'DELETE')
  assert.equal(capturedOptions.headers.Authorization, 'Bearer token-1')
})

test('deleteD1Database throws with response details on failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'not found' })
  await assert.rejects(
    () => deleteD1Database({ accountId: 'acct-1', databaseId: 'db-1', apiToken: 'token-1', fetchImpl }),
    /404/,
  )
})
```

Save to `scripts/preview-env/cloudflare-d1.test.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/preview-env/cloudflare-d1.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node

const API_BASE = 'https://api.cloudflare.com/client/v4'

export async function createD1Database({ accountId, name, apiToken, fetchImpl = fetch }) {
  const response = await fetchImpl(`${API_BASE}/accounts/${accountId}/d1/database`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!response.ok) {
    throw new Error(`Failed to create D1 database ${name}: ${response.status} ${await response.text()}`)
  }
  const json = await response.json()
  return json.result.uuid
}

export async function findD1DatabaseIdByName({ accountId, name, apiToken, fetchImpl = fetch }) {
  const response = await fetchImpl(`${API_BASE}/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  })
  if (!response.ok) {
    throw new Error(`Failed to list D1 databases: ${response.status} ${await response.text()}`)
  }
  const json = await response.json()
  const match = json.result.find((db) => db.name === name)
  return match ? match.uuid : null
}

export async function deleteD1Database({ accountId, databaseId, apiToken, fetchImpl = fetch }) {
  const response = await fetchImpl(`${API_BASE}/accounts/${accountId}/d1/database/${databaseId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiToken}` },
  })
  if (!response.ok) {
    throw new Error(`Failed to delete D1 database ${databaseId}: ${response.status} ${await response.text()}`)
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2)
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !apiToken) {
    console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required')
    process.exit(1)
  }
  if (command === 'create') {
    console.log(await createD1Database({ accountId, name: arg, apiToken }))
    return
  }
  if (command === 'find') {
    console.log((await findD1DatabaseIdByName({ accountId, name: arg, apiToken })) ?? '')
    return
  }
  if (command === 'delete') {
    await deleteD1Database({ accountId, databaseId: arg, apiToken })
    console.log(`Deleted D1 database ${arg}`)
    return
  }
  console.error('Usage: cloudflare-d1.mjs create <name> | find <name> | delete <database-id>')
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
```

Save to `scripts/preview-env/cloudflare-d1.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/preview-env/cloudflare-d1.test.mjs`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/preview-env/cloudflare-d1.mjs scripts/preview-env/cloudflare-d1.test.mjs
git commit -m "feat: add Cloudflare D1 database lifecycle helper"
```

---

### Task 5: `provision.mjs` + `teardown.mjs`

**Files:**
- Create: `scripts/preview-env/provision.mjs`
- Test: `scripts/preview-env/provision.test.mjs` (covers only the extracted decision function — see below)
- Create: `scripts/preview-env/teardown.mjs`

**Interfaces:**
- Consumes: `generatePreviewConfig`/`extractWorkersDevSubdomain` (Task 1), `createD1Database`/`findD1DatabaseIdByName`/`deleteD1Database` (Task 4).
- Produces: `shouldFullyProvision({ existingDatabaseId, migrationsChanged }): boolean` (named export, the one piece of real decision logic in `provision.mjs`, unit tested). `provision.mjs`'s CLI form: `node provision.mjs <pr-number> <base-sha> <head-sha>`, run from the repo root, printing a single JSON line `{"databaseId":"...","backendUrl":"...","frontendUrl":"..."}` to stdout on success — consumed by Task 6's workflow YAML. `teardown.mjs`'s CLI form: `node teardown.mjs <pr-number>`, also run from the repo root.
- Both scripts shell out to `wrangler` via `child_process.execSync` and assume `backend/` and `frontend/` already have `node_modules` installed and `frontend/dist` already built — Task 6's workflow YAML is responsible for those installs/builds before invoking either script.

**Note on test scope:** `provision.mjs` and `teardown.mjs` are thin orchestration over already-unit-tested pieces (Tasks 1 and 4) plus real `wrangler`/network calls that can't be exercised outside CI with real Cloudflare credentials — the same category as `pr.yml`/`release.yml` in the earlier CI plan, which were validated by actually running them. Only the one real decision point (`shouldFullyProvision`) gets a unit test here; the rest of this task is verified by a careful self-review of the code against Tasks 1 and 4's real interfaces, with full validation deferred to Task 6's real workflow run.

- [ ] **Step 1: Write the failing test for the decision function**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldFullyProvision } from './provision.mjs'

test('shouldFullyProvision is true when there is no existing database', () => {
  assert.equal(shouldFullyProvision({ existingDatabaseId: null, migrationsChanged: false }), true)
})

test('shouldFullyProvision is true when migrations changed, even with an existing database', () => {
  assert.equal(shouldFullyProvision({ existingDatabaseId: 'db-1', migrationsChanged: true }), true)
})

test('shouldFullyProvision is false when a database exists and migrations did not change', () => {
  assert.equal(shouldFullyProvision({ existingDatabaseId: 'db-1', migrationsChanged: false }), false)
})
```

Save to `scripts/preview-env/provision.test.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/preview-env/provision.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write provision.mjs**

```js
#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createD1Database, findD1DatabaseIdByName } from './cloudflare-d1.mjs'
import { extractWorkersDevSubdomain, generatePreviewConfig } from './generate-wrangler-config.mjs'

export function shouldFullyProvision({ existingDatabaseId, migrationsChanged }) {
  return !existingDatabaseId || migrationsChanged
}

function run(command, options = {}) {
  console.log(`$ ${command}`)
  execSync(command, { stdio: 'inherit', ...options })
}

async function main() {
  const [prNumber, baseSha, headSha] = process.argv.slice(2)
  if (!prNumber || !baseSha || !headSha) {
    console.error('Usage: provision.mjs <pr-number> <base-sha> <head-sha>')
    process.exit(1)
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !apiToken) {
    console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required')
    process.exit(1)
  }

  const dbName = `webhook-listener-pr-${prNumber}`

  const changedFiles = execSync(`git diff --name-only ${baseSha}...${headSha}`, { encoding: 'utf8' })
  const migrationsChanged = changedFiles.split('\n').some((path) => path.startsWith('backend/migrations/'))

  const existingDatabaseId = await findD1DatabaseIdByName({ accountId, name: dbName, apiToken })
  const needsFullProvision = shouldFullyProvision({ existingDatabaseId, migrationsChanged })

  let databaseId = existingDatabaseId

  if (needsFullProvision) {
    if (existingDatabaseId) {
      run(
        `npx wrangler d1 execute ${dbName} --remote --command "DROP TABLE IF EXISTS shared_with_me; DROP TABLE IF EXISTS magic_links; DROP TABLE IF EXISTS requests; DROP TABLE IF EXISTS projects; DROP TABLE IF EXISTS listeners; DROP TABLE IF EXISTS d1_migrations;"`,
        { cwd: 'backend' },
      )
    } else {
      databaseId = await createD1Database({ accountId, name: dbName, apiToken })
    }

    run(`npx wrangler d1 export webhook-listener --remote --output=prod-dump.sql`, { cwd: 'backend' })
    run(`npx wrangler d1 execute ${dbName} --remote --file=prod-dump.sql`, { cwd: 'backend' })
    run(`npx wrangler d1 execute ${dbName} --remote --file=../scripts/preview-env/scrub.sql`, { cwd: 'backend' })
    run(`npx wrangler d1 migrations apply ${dbName} --remote`, { cwd: 'backend' })
  }

  const backendTomlText = readFileSync('backend/wrangler.toml', 'utf8')
  const subdomain = extractWorkersDevSubdomain(backendTomlText)

  const backendConfig = generatePreviewConfig({
    target: 'backend',
    prNumber,
    tomlText: backendTomlText,
    subdomain,
    databaseId,
  })
  writeFileSync(`backend/wrangler.pr-${prNumber}.toml`, backendConfig)
  run(`npx wrangler deploy -c wrangler.pr-${prNumber}.toml`, { cwd: 'backend' })

  const frontendTomlText = readFileSync('frontend/wrangler.toml', 'utf8')
  const frontendConfig = generatePreviewConfig({
    target: 'frontend',
    prNumber,
    tomlText: frontendTomlText,
    subdomain,
  })
  writeFileSync(`frontend/wrangler.pr-${prNumber}.toml`, frontendConfig)
  run(`npx wrangler deploy -c wrangler.pr-${prNumber}.toml`, { cwd: 'frontend' })

  const backendUrl = `https://webhook-api-pr-${prNumber}.${subdomain}.workers.dev`
  const frontendUrl = `https://webhook-pr-${prNumber}.${subdomain}.workers.dev`

  console.log(JSON.stringify({ databaseId, backendUrl, frontendUrl }))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
```

Save to `scripts/preview-env/provision.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/preview-env/provision.test.mjs`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Write teardown.mjs**

```js
#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { findD1DatabaseIdByName, deleteD1Database } from './cloudflare-d1.mjs'

function run(command, options = {}) {
  console.log(`$ ${command}`)
  try {
    execSync(command, { stdio: 'inherit', ...options })
  } catch (error) {
    console.error(`Command failed (continuing teardown): ${command}`)
    console.error(error.message)
  }
}

async function main() {
  const [prNumber] = process.argv.slice(2)
  if (!prNumber) {
    console.error('Usage: teardown.mjs <pr-number>')
    process.exit(1)
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !apiToken) {
    console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required')
    process.exit(1)
  }

  run(`npx wrangler delete --name webhook-api-pr-${prNumber}`, { cwd: 'backend' })
  run(`npx wrangler delete --name webhook-pr-${prNumber}`, { cwd: 'frontend' })

  const dbName = `webhook-listener-pr-${prNumber}`
  const databaseId = await findD1DatabaseIdByName({ accountId, name: dbName, apiToken })
  if (databaseId) {
    await deleteD1Database({ accountId, databaseId, apiToken })
    console.log(`Deleted D1 database ${dbName} (${databaseId})`)
  } else {
    console.log(`No D1 database named ${dbName} found — already deleted or never provisioned`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

Save to `scripts/preview-env/teardown.mjs`.

- [ ] **Step 6: Self-review both orchestration scripts**

Re-read `provision.mjs` and `teardown.mjs` against Task 1 and Task 4's actual exported function signatures (not from memory — re-open those two files) and confirm every call site matches: argument names, return types (`createD1Database` returns a bare string, not an object; `findD1DatabaseIdByName` returns `string|null`; `generatePreviewConfig` takes an options object, not positional args). Fix any mismatch before committing.

- [ ] **Step 7: Commit**

```bash
git add scripts/preview-env/provision.mjs scripts/preview-env/provision.test.mjs scripts/preview-env/teardown.mjs
git commit -m "feat: add preview environment provision and teardown orchestration"
```

---

### Task 6: `.github/workflows/preview.yml`

**Files:**
- Create: `.github/workflows/preview.yml`

**Interfaces:**
- Consumes: `scripts/preview-env/provision.mjs`, `scripts/preview-env/teardown.mjs` (Task 5), `scripts/preview-env/upsert-comment.mjs` (Task 3) — all invoked as plain `node <script>` calls, not imported.
- Consumes repo-level config from the Manual Prerequisites: secret `CLOUDFLARE_API_TOKEN`, variable `CLOUDFLARE_ACCOUNT_ID`, and the `preview` label.

- [ ] **Step 1: Write the workflow file**

```yaml
name: Preview Environment

on:
  pull_request:
    types: [labeled, unlabeled, synchronize, closed]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to tear down (safety net for a missed closed event)'
        required: true

permissions:
  contents: read
  pull-requests: write

jobs:
  deploy-preview:
    if: >
      github.event_name == 'pull_request' &&
      (github.event.action == 'labeled' || github.event.action == 'synchronize') &&
      contains(github.event.pull_request.labels.*.name, 'preview')
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install root dependencies
        run: npm ci

      - name: Install backend dependencies
        working-directory: backend
        run: npm ci

      - name: Install frontend dependencies
        working-directory: frontend
        run: npm ci

      - name: Build frontend
        working-directory: frontend
        run: npm run build

      - name: Provision or redeploy preview environment
        id: provision
        run: |
          RESULT=$(node scripts/preview-env/provision.mjs \
            "${{ github.event.pull_request.number }}" \
            "${{ github.event.pull_request.base.sha }}" \
            "${{ github.sha }}")
          echo "$RESULT"
          echo "result=$RESULT" >> "$GITHUB_OUTPUT"

      - name: Upsert PR comment (success)
        if: success()
        run: |
          BACKEND_URL=$(node -e "console.log(JSON.parse(process.argv[1]).backendUrl)" '${{ steps.provision.outputs.result }}')
          FRONTEND_URL=$(node -e "console.log(JSON.parse(process.argv[1]).frontendUrl)" '${{ steps.provision.outputs.result }}')
          DATABASE_ID=$(node -e "console.log(JSON.parse(process.argv[1]).databaseId)" '${{ steps.provision.outputs.result }}')
          node scripts/preview-env/upsert-comment.mjs upsert \
            "${{ github.event.pull_request.number }}" provisioned \
            "$BACKEND_URL" "$FRONTEND_URL" "$DATABASE_ID" \
            "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"

      - name: Upsert PR comment (failure)
        if: failure()
        run: |
          node scripts/preview-env/upsert-comment.mjs upsert \
            "${{ github.event.pull_request.number }}" failed \
            "" "" "" \
            "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"

  teardown:
    if: >
      github.event_name == 'workflow_dispatch' ||
      (github.event.action == 'unlabeled' && github.event.label.name == 'preview') ||
      (github.event.action == 'closed' && contains(github.event.pull_request.labels.*.name, 'preview'))
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install root dependencies
        run: npm ci

      - name: Install backend dependencies (for wrangler)
        working-directory: backend
        run: npm ci

      - name: Install frontend dependencies (for wrangler)
        working-directory: frontend
        run: npm ci

      - name: Determine PR number
        id: pr
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "number=${{ github.event.inputs.pr_number }}" >> "$GITHUB_OUTPUT"
          else
            echo "number=${{ github.event.pull_request.number }}" >> "$GITHUB_OUTPUT"
          fi

      - name: Tear down preview environment
        run: node scripts/preview-env/teardown.mjs "${{ steps.pr.outputs.number }}"

      - name: Upsert PR comment (torn down)
        run: |
          node scripts/preview-env/upsert-comment.mjs upsert \
            "${{ steps.pr.outputs.number }}" torn-down \
            "" "" "" \
            "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

Save to `.github/workflows/preview.yml`.

- [ ] **Step 2: Verify the YAML parses**

Run: `npx -y js-yaml .github/workflows/preview.yml > /dev/null`
Expected: exits 0, no parse error.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/preview.yml
git commit -m "ci: add PR preview environment workflow"
```

**Note:** this workflow's actual behavior (provisioning, redeploy-only detection, teardown, PR comment updates) can only be validated by opening a real `preview`-labeled PR against this repo — the same way `pr.yml` and `release.yml` were validated in the earlier CI/release plan. Confirm the three Manual Prerequisites are in place first, or the first real run will fail partway through (same failure mode as the earlier plan's `CLOUDFLARE_API_TOKEN` bootstrap issue).

---

### Task 7: Documentation updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `STATUS.md`

- [ ] **Step 1: Add a "PR preview environments" subsection to CLAUDE.md**

Add a new subsection after the existing "Deploying" section:

```markdown
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
- Removing the `preview` label, or closing/merging the PR, tears both
  Workers and the D1 database down. A `workflow_dispatch` input (PR
  number) is available as a manual safety net if a teardown is ever missed.
- Requires the `CLOUDFLARE_API_TOKEN` secret to have `D1: Edit` permission
  (in addition to the `Workers Scripts: Edit` permission `release.yml`
  needs) and a `CLOUDFLARE_ACCOUNT_ID` repository variable to be set.
```

- [ ] **Step 2: Add a STATUS.md entry**

Add a new numbered entry (following the existing list's format) noting: PR preview environments are live via the `preview` label; sub-project 2 (opt-in automated production migrations, gated on a successful preview provision plus an explicit PR-body checkbox) is designed separately and not yet built — see `docs/superpowers/specs/2026-09-30-pr-preview-environments-design.md`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md STATUS.md
git commit -m "docs: document PR preview environments"
```
