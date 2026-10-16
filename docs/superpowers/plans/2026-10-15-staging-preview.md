# Staging-based PR previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `preview` label deploy the PR to the one long-lived staging environment, wiping its D1 database only when the label is added (pushes keep data), instead of provisioning a per-PR database copied from production.

**Architecture:** `provision.mjs` shrinks to two modes against `[env.staging]`: `reset` (on `labeled`: drop every table, record the PR in a one-row `_staging_occupant` table, migrate, deploy) and `redeploy` (on `synchronize`, only if the PR is the recorded occupant: apply new migrations, deploy; otherwise do nothing to staging). The workflow serialises deploy runs through one job-level concurrency group (the comment-only job has its own per-PR group) and only resets when the label added is `preview` itself. `upsert-comment.mjs` gains "superseded", "inactive" and "not-holder" states. All per-PR provisioning, teardown, scrub and wrangler-config-generation code is deleted.

**Tech Stack:** Node (`node:test` for `scripts/preview-env/*.test.mjs`), wrangler, GitHub Actions, Cloudflare D1 (Miniflare locally).

**Spec:** `docs/superpowers/specs/2026-10-15-staging-preview-design.md`

## Global Constraints

- Staging D1 is `webhook-listener-staging` (`7f55f3f0-7fe0-4237-8307-8769755f4c3a`), already declared in `backend/wrangler.toml` `[env.staging]`; deploy with `--env staging`. Do not add a `routes` block.
- Staging Workers: `webhook-api-staging` and `webhook-staging`, on workers.dev. Their `WL_SESSION_SECRET` and `RESEND_API_KEY` are set once and are never touched by the workflow.
- Reset **only** when the `preview` label itself is added (`labeled` with `github.event.label.name == 'preview'`). A push never wipes data. Reset drops **every** table in `sqlite_master` (excluding SQLite/Cloudflare internals), including `d1_migrations` and `_staging_occupant`, not a hardcoded list. No seed data.
- Staging records its occupant in a script-created (not a migration) one-row table `_staging_occupant (pr INTEGER NOT NULL)`, written right after each reset, before its migrations apply.
- A push (`synchronize`) to the occupant PR runs `wrangler d1 migrations apply` (new migrations only) and redeploys. A push to any other labelled PR, or when there is no occupant record, does nothing to staging and posts a "not-holder" comment telling the author to remove and re-add the label.
- Last label wins. Deploy runs share one concurrency group named `staging` with `cancel-in-progress: false`.
- Label removal or PR close takes no infrastructure action; it only updates the PR comment.
- Commit headers must be Conventional Commits and **<= 100 characters** (commitlint runs locally and in CI). Stage with `git add` in one command, commit in a separate command. Never `--no-verify`. If a commit fails with a confusing `Token` header-parsing error, `bw` is locked: ask the user to unlock it.
- Run Prettier 3.6.2 from the repo root install (`npx prettier --check <files>` after `npm ci` at the root). A bare `npx prettier` gives false passes.
- Subagents and reviews use **Sonnet only** (never Opus or Fable).
- Do **not** run any remote D1 command or trigger a real provision until the user says so. Use `~/scratch/` for scratch files, never `/tmp`.
- Acceptance bar for a real run: a reset plus deploy writes under 5,000 rows to the staging database and does not grow with production.
- Work in the worktree `/Users/Ben.Elliot/repos/webhook-listener/.claude/worktrees/staging-preview` on branch `docs/staging-preview-spec`. Run `node --test` for script tests from the worktree root.

---

## File Structure

- Modify `scripts/preview-env/provision.mjs` — reset/redeploy modes; exports pure helpers `isDroppableTable`, `parseTableNames`, `buildResetSql`, `buildOccupantSql`, `parseOccupant`, `decideProvisionMode`, `extractStagingUrls`.
- Modify `scripts/preview-env/provision.test.mjs` — tests for those helpers (old `shouldFullyProvision`, `generateSessionSecret`, `parseRowCount` tests are removed with their functions).
- Modify `scripts/preview-env/upsert-comment.mjs` and `.test.mjs` — new states and commands.
- Modify `.github/workflows/preview.yml` — rewritten; modify `.github/workflows/pr.yml` — one added step so these script tests run in CI.
- Delete: `scripts/preview-env/{teardown,cloudflare-d1,generate-wrangler-config,write-frontend-env}.mjs` and their `.test.mjs` files, `scripts/preview-env/scrub.sql`, `backend/src/preview-scrub.test.ts`.
- Modify `.gitignore`, `CLAUDE.md`, `STATUS.md`.

---

### Task 1: Reset/redeploy core in `provision.mjs`

**Files:**

- Modify: `scripts/preview-env/provision.mjs` (full rewrite)
- Modify: `scripts/preview-env/provision.test.mjs` (full rewrite)

**Interfaces:**

- Produces (all exported from `provision.mjs`):
  - `isDroppableTable(name: string): boolean`
  - `parseTableNames(jsonOutput: string): string[]` — input is `wrangler d1 execute --json` output for `SELECT name FROM sqlite_master WHERE type = 'table'`
  - `buildResetSql(tableNames: string[]): string`
  - `buildOccupantSql(prNumber: string): string` — creates `_staging_occupant` and inserts the PR number; throws if `prNumber` is not a positive integer string.
  - `parseOccupant(jsonOutput: string): number | null` — input is `--json` output for `SELECT pr FROM _staging_occupant`; `null` when the table has no rows.
  - `decideProvisionMode({ action: string, occupant: number | null, prNumber: string }): 'reset' | 'redeploy' | 'not-occupant'` — `labeled` → `reset`; `synchronize` → `redeploy` only if `occupant === Number(prNumber)`, else `not-occupant`; any other action throws.
  - `extractStagingUrls(tomlText: string): { backendUrl: string, frontendUrl: string }`
  - CLI: `node scripts/preview-env/provision.mjs <action> <pr-number>`; last stdout line is JSON, either `{ "outcome": "deployed", "mode": "reset" | "redeploy", "backendUrl": "...", "frontendUrl": "..." }` or `{ "outcome": "not-occupant", "occupant": <number> | null }`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `scripts/preview-env/provision.test.mjs` with:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isDroppableTable,
  parseTableNames,
  buildResetSql,
  buildOccupantSql,
  parseOccupant,
  decideProvisionMode,
  extractStagingUrls,
} from './provision.mjs'

test('isDroppableTable accepts application tables and d1_migrations', () => {
  assert.equal(isDroppableTable('listeners'), true)
  assert.equal(isDroppableTable('d1_migrations'), true)
})

test('isDroppableTable rejects SQLite and Cloudflare internal tables', () => {
  assert.equal(isDroppableTable('sqlite_sequence'), false)
  assert.equal(isDroppableTable('_cf_KV'), false)
})

test('parseTableNames reads and filters names from wrangler d1 execute --json output', () => {
  const output = JSON.stringify([
    {
      results: [
        { name: 'listeners' },
        { name: 'sqlite_sequence' },
        { name: '_cf_KV' },
        { name: 'd1_migrations' },
      ],
      success: true,
      meta: {},
    },
  ])
  assert.deepEqual(parseTableNames(output), ['listeners', 'd1_migrations'])
})

test('parseTableNames returns an empty list for an empty database', () => {
  const output = JSON.stringify([{ results: [], success: true, meta: {} }])
  assert.deepEqual(parseTableNames(output), [])
})

test('buildResetSql defers foreign keys then drops each table', () => {
  assert.equal(
    buildResetSql(['requests', 'listeners']),
    [
      'PRAGMA defer_foreign_keys = on;',
      'DROP TABLE IF EXISTS "requests";',
      'DROP TABLE IF EXISTS "listeners";',
    ].join('\n'),
  )
})

test('buildResetSql escapes double quotes in identifiers', () => {
  assert.match(buildResetSql(['we"ird']), /DROP TABLE IF EXISTS "we""ird";/)
})

test('buildResetSql with no tables is only the pragma', () => {
  assert.equal(buildResetSql([]), 'PRAGMA defer_foreign_keys = on;')
})

test('buildOccupantSql creates the table and records the PR number', () => {
  assert.equal(
    buildOccupantSql('42'),
    [
      'CREATE TABLE _staging_occupant (pr INTEGER NOT NULL);',
      'INSERT INTO _staging_occupant (pr) VALUES (42);',
    ].join('\n'),
  )
})

test('buildOccupantSql rejects anything that is not a positive integer', () => {
  assert.throws(() => buildOccupantSql('42; DROP TABLE listeners'), /PR number/)
  assert.throws(() => buildOccupantSql('0'), /PR number/)
  assert.throws(() => buildOccupantSql(''), /PR number/)
})

test('parseOccupant reads the recorded PR number', () => {
  const output = JSON.stringify([{ results: [{ pr: 42 }], success: true }])
  assert.equal(parseOccupant(output), 42)
})

test('parseOccupant returns null when the table has no rows', () => {
  const output = JSON.stringify([{ results: [], success: true }])
  assert.equal(parseOccupant(output), null)
})

test('decideProvisionMode always resets on labeled, whoever held staging', () => {
  assert.equal(
    decideProvisionMode({ action: 'labeled', occupant: 7, prNumber: '42' }),
    'reset',
  )
  assert.equal(
    decideProvisionMode({ action: 'labeled', occupant: null, prNumber: '42' }),
    'reset',
  )
})

test('decideProvisionMode redeploys a push from the occupant PR', () => {
  assert.equal(
    decideProvisionMode({
      action: 'synchronize',
      occupant: 42,
      prNumber: '42',
    }),
    'redeploy',
  )
})

test('decideProvisionMode leaves staging alone for a push from another PR', () => {
  assert.equal(
    decideProvisionMode({ action: 'synchronize', occupant: 7, prNumber: '42' }),
    'not-occupant',
  )
})

test('decideProvisionMode leaves staging alone when there is no occupant record', () => {
  assert.equal(
    decideProvisionMode({
      action: 'synchronize',
      occupant: null,
      prNumber: '42',
    }),
    'not-occupant',
  )
})

test('decideProvisionMode throws for an unsupported action', () => {
  assert.throws(
    () =>
      decideProvisionMode({ action: 'closed', occupant: 42, prNumber: '42' }),
    /action/,
  )
})

const TOML = `
[vars]
HOOK_BASE_URL = "https://prod-api.example.com"
APP_BASE_URL = "https://prod.example.com"

[env.staging]
name = "webhook-api-staging"

[env.staging.vars]
HOOK_BASE_URL = "https://webhook-api-staging.example.workers.dev"
APP_BASE_URL = "https://webhook-staging.example.workers.dev"
SESSION_COOKIE_DOMAIN = ""
`

test('extractStagingUrls reads the staging vars, not the production ones', () => {
  assert.deepEqual(extractStagingUrls(TOML), {
    backendUrl: 'https://webhook-api-staging.example.workers.dev',
    frontendUrl: 'https://webhook-staging.example.workers.dev',
  })
})

test('extractStagingUrls throws when the staging vars section is missing', () => {
  assert.throws(() => extractStagingUrls('[vars]\nA = "b"\n'), /staging/)
})

test('extractStagingUrls throws when a URL is missing from the section', () => {
  assert.throws(
    () =>
      extractStagingUrls('[env.staging.vars]\nHOOK_BASE_URL = "https://x"\n'),
    /APP_BASE_URL/,
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/preview-env/provision.test.mjs`
Expected: FAIL — `isDroppableTable`, `parseTableNames` etc. are not exported from `provision.mjs`.

- [ ] **Step 3: Rewrite `provision.mjs`**

Replace the whole file with:

```js
#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

// Previews deploy to the one long-lived staging environment. Adding the
// `preview` label wipes its database (mode `reset`); a push to the PR that
// currently holds staging only applies new migrations and redeploys (mode
// `redeploy`), so hand-made test data survives. Nothing is ever copied from
// production. See docs/superpowers/specs/2026-10-15-staging-preview-design.md.

const RESET_FILE = '.reset-staging.sql'
const OCCUPANT_FILE = '.occupant-staging.sql'
const OCCUPANT_TABLE = '_staging_occupant'

// SQLite's own bookkeeping tables and Cloudflare's internal `_cf_*` tables
// can't (or must not) be dropped. Everything else, including d1_migrations,
// is dropped so the branch's migrations apply to a truly empty database.
export function isDroppableTable(name) {
  return !name.startsWith('sqlite_') && !name.startsWith('_cf_')
}

// `wrangler d1 execute --json` output for
// `SELECT name FROM sqlite_master WHERE type = 'table'`.
export function parseTableNames(jsonOutput) {
  return JSON.parse(jsonOutput)[0]
    .results.map((row) => row.name)
    .filter(isDroppableTable)
}

// defer_foreign_keys lets parent and child tables be dropped in any order
// within the one batch, so the reset cannot drift as the schema grows.
export function buildResetSql(tableNames) {
  const drops = tableNames.map(
    (name) => `DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}";`,
  )
  return ['PRAGMA defer_foreign_keys = on;', ...drops].join('\n')
}

// The occupant table is created by this script, not by a migration, so the
// production schema is untouched. It is dropped by every reset along with the
// data it describes. prNumber is validated because it is interpolated into SQL.
export function buildOccupantSql(prNumber) {
  if (!/^[1-9]\d*$/.test(prNumber)) {
    throw new Error(`Invalid PR number: ${JSON.stringify(prNumber)}`)
  }
  return [
    `CREATE TABLE ${OCCUPANT_TABLE} (pr INTEGER NOT NULL);`,
    `INSERT INTO ${OCCUPANT_TABLE} (pr) VALUES (${prNumber});`,
  ].join('\n')
}

// `wrangler d1 execute --json` output for `SELECT pr FROM _staging_occupant`.
export function parseOccupant(jsonOutput) {
  const rows = JSON.parse(jsonOutput)[0].results
  return rows.length === 0 ? null : Number(rows[0].pr)
}

// `labeled` is the only event that may wipe staging. A push never does: it
// redeploys only for the PR that already holds staging, because deploying
// another PR's code onto the holder's schema would be wrong, and resetting
// would destroy the holder's test data.
export function decideProvisionMode({ action, occupant, prNumber }) {
  if (action === 'labeled') return 'reset'
  if (action === 'synchronize') {
    return occupant === Number(prNumber) ? 'redeploy' : 'not-occupant'
  }
  throw new Error(`Unsupported action: ${action}`)
}

// Staging's public URLs already live in backend/wrangler.toml's
// [env.staging.vars]; reading them from there avoids a second copy.
export function extractStagingUrls(tomlText) {
  const afterHeader = tomlText.split('[env.staging.vars]')[1]
  if (afterHeader === undefined) {
    throw new Error('No [env.staging.vars] section found in wrangler.toml')
  }
  const section = afterHeader.split(/^\[/m)[0]
  const read = (key) => {
    const match = section.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))
    if (!match) {
      throw new Error(`${key} missing from [env.staging.vars]`)
    }
    return match[1]
  }
  return {
    backendUrl: read('HOOK_BASE_URL'),
    frontendUrl: read('APP_BASE_URL'),
  }
}

function run(command, options = {}) {
  // stdout is reserved for the final JSON result line, so wrangler's own
  // stdout goes to stderr (fd 2).
  console.error(`$ ${command}`)
  execSync(command, { stdio: ['inherit', 2, 'inherit'], ...options })
}

// Runs a SQL file on remote staging, then removes it even if the run fails.
function executeSqlFile(fileName, sql) {
  const path = `backend/${fileName}`
  writeFileSync(path, sql)
  try {
    run(
      `npx wrangler d1 execute DB --remote --env staging --file=${fileName}`,
      { cwd: 'backend' },
    )
  } finally {
    unlinkSync(path)
  }
}

function queryStaging(sql) {
  return execSync(
    `npx wrangler d1 execute DB --remote --env staging --json --command "${sql}"`,
    { cwd: 'backend', encoding: 'utf8' },
  )
}

function main() {
  const [action, prNumber] = process.argv.slice(2)
  if (!action || !/^[1-9]\d*$/.test(prNumber ?? '')) {
    console.error('Usage: provision.mjs <labeled|synchronize> <pr-number>')
    process.exit(1)
  }

  const { backendUrl, frontendUrl } = extractStagingUrls(
    readFileSync('backend/wrangler.toml', 'utf8'),
  )

  const tableNames = parseTableNames(
    queryStaging("SELECT name FROM sqlite_master WHERE type = 'table'"),
  )
  // A staging DB that has never held a preview has no occupant table.
  const occupant = tableNames.includes(OCCUPANT_TABLE)
    ? parseOccupant(queryStaging(`SELECT pr FROM ${OCCUPANT_TABLE}`))
    : null

  const mode = decideProvisionMode({ action, occupant, prNumber })

  if (mode === 'not-occupant') {
    console.error(`Staging is not held by #${prNumber}; leaving it untouched`)
    console.log(JSON.stringify({ outcome: 'not-occupant', occupant }))
    return
  }

  if (mode === 'reset') {
    console.error(`Resetting staging: dropping ${tableNames.length} table(s)`)
    executeSqlFile(RESET_FILE, buildResetSql(tableNames))
    // This PR owns staging from here on. Recording it before migrating means
    // that if a migration (or anything later) fails, a fix push is a
    // `redeploy` that retries `migrations apply` on the partial database,
    // rather than "no recorded holder".
    executeSqlFile(OCCUPANT_FILE, buildOccupantSql(prNumber))
  }

  // On `redeploy` this applies only migrations not yet recorded in
  // d1_migrations; on `reset` it applies all of them to the empty database.
  run(`npx wrangler d1 migrations apply DB --remote --env staging`, {
    cwd: 'backend',
  })

  run(`npx wrangler deploy --env staging`, { cwd: 'backend' })
  // The workflow has already built the frontend with --mode staging.
  run(`npx wrangler deploy --env staging`, { cwd: 'frontend' })

  console.log(
    JSON.stringify({ outcome: 'deployed', mode, backendUrl, frontendUrl }),
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/preview-env/provision.test.mjs`
Expected: PASS, 19 tests.

- [ ] **Step 5: Format and commit**

Run: `npx prettier --write scripts/preview-env/provision.mjs scripts/preview-env/provision.test.mjs`

```bash
git add scripts/preview-env/provision.mjs scripts/preview-env/provision.test.mjs
```

```bash
git commit -m "feat(ci): reset staging on label, redeploy on push, in provision.mjs"
```

(The deleted helpers are still imported by files removed in Task 4; nothing else imports `provision.mjs`, so this is safe.)

---

### Task 2: Comment states and commands in `upsert-comment.mjs`

**Files:**

- Modify: `scripts/preview-env/upsert-comment.mjs` (full rewrite)
- Modify: `scripts/preview-env/upsert-comment.test.mjs` (full rewrite)

**Interfaces:**

- Produces (exported): `buildCommentBody({ prNumber, status, backendUrl, frontendUrl, runUrl, supersededBy, heldBy }): string` where `status` is `'provisioned' | 'failed' | 'superseded' | 'inactive' | 'not-holder'` (`heldBy` is the PR number holding staging, or undefined when there is no occupant record); `findExistingComment(comments, prNumber)`; `isActiveComment(body): boolean`.
- Produces CLI commands used by Task 4's workflow:
  - `upsert-comment.mjs upsert <pr> <status> <backendUrl> <frontendUrl> <runUrl> [otherPr]` — `otherPr` is used as `supersededBy` for `superseded` and as `heldBy` for `not-holder`; pass `""` for the unused URL arguments.
  - `upsert-comment.mjs supersede-others <currentPr> <runUrl>`
  - `upsert-comment.mjs deactivate <pr> <runUrl>`
- Marker format is now `<!-- preview-env:<pr> -->`. Old-format comments (`<!-- preview-env:<pr> db-id:... -->`) still match `findExistingComment` and get overwritten.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `scripts/preview-env/upsert-comment.test.mjs` with:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCommentBody,
  findExistingComment,
  isActiveComment,
} from './upsert-comment.mjs'

const RUN = 'https://github.com/x/y/actions/runs/1'

test('buildCommentBody renders provisioned with both URLs', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'provisioned',
    backendUrl: 'https://api.example.workers.dev',
    frontendUrl: 'https://app.example.workers.dev',
    runUrl: RUN,
  })
  assert.match(body, /^<!-- preview-env:42 -->/)
  assert.match(body, /Backend: https:\/\/api\.example\.workers\.dev/)
  assert.match(body, /Frontend: https:\/\/app\.example\.workers\.dev/)
  assert.match(body, /Status: provisioned ✅/)
  assert.match(body, /shared staging environment/)
  assert.match(body, /wiped when the `preview` label is added/)
})

test('buildCommentBody renders failed without URLs', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'failed',
    runUrl: RUN,
  })
  assert.match(body, /Status: deploy failed ❌/)
  assert.match(body, /re-add the \`preview\` label/)
  assert.doesNotMatch(body, /Backend:/)
})

test('buildCommentBody renders superseded with the PR that took over', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'superseded',
    runUrl: RUN,
    supersededBy: '43',
  })
  assert.match(body, /Status: superseded by #43 ⏭️/)
  assert.doesNotMatch(body, /Backend:/)
})

test('buildCommentBody renders inactive', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'inactive',
    runUrl: RUN,
  })
  assert.match(body, /Status: no longer active 🧹/)
})

test('buildCommentBody renders not-holder with the PR that holds staging', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'not-holder',
    runUrl: RUN,
    heldBy: '43',
  })
  assert.match(body, /Status: staging is held by #43 ⏸️/)
  assert.match(body, /remove and re-add the `preview` label/)
  assert.doesNotMatch(body, /Backend:/)
})

test('buildCommentBody renders not-holder when no PR holds staging', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'not-holder',
    runUrl: RUN,
  })
  assert.match(body, /Status: staging has no recorded holder ⏸️/)
  assert.match(body, /remove and re-add the `preview` label/)
})

test('buildCommentBody throws for an unknown status', () => {
  assert.throws(() =>
    buildCommentBody({ prNumber: '42', status: 'bogus', runUrl: RUN }),
  )
})

test('findExistingComment matches the new marker format', () => {
  const comments = [
    { id: 1, body: '<!-- preview-env:41 -->\nother' },
    { id: 2, body: '<!-- preview-env:42 -->\n### Staging preview' },
  ]
  assert.equal(findExistingComment(comments, '42').id, 2)
})

test('findExistingComment also matches the old db-id marker format', () => {
  const comments = [
    { id: 7, body: '<!-- preview-env:42 db-id:db-abc -->\nold' },
  ]
  assert.equal(findExistingComment(comments, '42').id, 7)
})

test('findExistingComment does not confuse PR 4 with PR 42', () => {
  const comments = [{ id: 1, body: '<!-- preview-env:42 -->\nbody' }]
  assert.equal(findExistingComment(comments, '4'), null)
})

test('findExistingComment returns null when nothing matches', () => {
  assert.equal(findExistingComment([{ id: 1, body: 'unrelated' }], '42'), null)
})

test('isActiveComment is true only for a provisioned comment', () => {
  const active = buildCommentBody({
    prNumber: '42',
    status: 'provisioned',
    backendUrl: 'a',
    frontendUrl: 'b',
    runUrl: RUN,
  })
  const superseded = buildCommentBody({
    prNumber: '42',
    status: 'superseded',
    runUrl: RUN,
    supersededBy: '43',
  })
  const notHolder = buildCommentBody({
    prNumber: '42',
    status: 'not-holder',
    runUrl: RUN,
    heldBy: '43',
  })
  assert.equal(isActiveComment(active), true)
  assert.equal(isActiveComment(superseded), false)
  assert.equal(isActiveComment(notHolder), false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/preview-env/upsert-comment.test.mjs`
Expected: FAIL — `isActiveComment` is not exported and old behaviour differs.

- [ ] **Step 3: Rewrite `upsert-comment.mjs`**

Replace the whole file with:

```js
#!/usr/bin/env node
const MARKER_PREFIX = '<!-- preview-env:'

export function buildCommentBody({
  prNumber,
  status,
  backendUrl,
  frontendUrl,
  runUrl,
  supersededBy,
  heldBy,
}) {
  const lines = [
    `${MARKER_PREFIX}${prNumber} -->`,
    '### 🔗 Staging preview',
    '',
  ]

  if (status === 'provisioned') {
    lines.push(`- Backend: ${backendUrl}`)
    lines.push(`- Frontend: ${frontendUrl}`)
    lines.push('')
    lines.push(
      'This is the shared staging environment: its database is wiped when the `preview` label is added (pushes keep your data), and the most recently labelled PR holds it.',
    )
    lines.push('')
    lines.push(`Status: provisioned ✅ · [workflow run](${runUrl})`)
  } else if (status === 'failed') {
    lines.push(`Status: deploy failed ❌ · [workflow run](${runUrl})`)
    lines.push('')
    lines.push(
      'Fix the cause and push to retry. If the next push says staging has no recorded holder, remove and re-add the `preview` label (this wipes staging).',
    )
  } else if (status === 'superseded') {
    lines.push(
      `Status: superseded by #${supersededBy} ⏭️ · [workflow run](${runUrl})`,
    )
  } else if (status === 'inactive') {
    lines.push(`Status: no longer active 🧹 · [workflow run](${runUrl})`)
  } else if (status === 'not-holder') {
    const holder = heldBy
      ? `staging is held by #${heldBy}`
      : 'staging has no recorded holder'
    lines.push(`Status: ${holder} ⏸️ · [workflow run](${runUrl})`)
    lines.push('')
    lines.push(
      'This push was not deployed. To take staging over (this wipes its database), remove and re-add the `preview` label.',
    )
  } else {
    throw new Error(`Unknown status: ${status}`)
  }

  return lines.join('\n')
}

export function findExistingComment(comments, prNumber) {
  const prefix = `${MARKER_PREFIX}${prNumber} `
  return comments.find((comment) => comment.body.startsWith(prefix)) ?? null
}

// Only a provisioned comment means "this PR currently holds staging".
export function isActiveComment(body) {
  return body.includes('Status: provisioned')
}

async function githubFetch(path, options = {}) {
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (!token || !repo) {
    throw new Error(
      'GITHUB_TOKEN and GITHUB_REPOSITORY environment variables are required',
    )
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
    throw new Error(
      `GitHub API ${path} failed: ${response.status} ${await response.text()}`,
    )
  }
  return response.status === 204 ? null : response.json()
}

function listComments(prNumber) {
  return githubFetch(`/issues/${prNumber}/comments?per_page=100`)
}

async function upsertComment(prNumber, fields) {
  const existing = findExistingComment(await listComments(prNumber), prNumber)
  const body = buildCommentBody({ prNumber, ...fields })
  if (existing) {
    await githubFetch(`/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    })
  } else {
    await githubFetch(`/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
  }
}

// Rewrites the comment of every *other* open PR that still claims staging.
async function supersedeOthers(currentPr, runUrl) {
  const issues = await githubFetch(
    '/issues?labels=preview&state=open&per_page=100',
  )
  for (const issue of issues) {
    const prNumber = String(issue.number)
    if (prNumber === currentPr) continue
    const existing = findExistingComment(await listComments(prNumber), prNumber)
    if (!existing || !isActiveComment(existing.body)) continue
    await githubFetch(`/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        body: buildCommentBody({
          prNumber,
          status: 'superseded',
          runUrl,
          supersededBy: currentPr,
        }),
      }),
    })
  }
}

// Label removed or PR closed: staging is left alone, but if this PR was the
// holder its comment must stop advertising live URLs. A comment that was
// already superseded or failed is left as it is.
async function deactivate(prNumber, runUrl) {
  const existing = findExistingComment(await listComments(prNumber), prNumber)
  if (!existing || !isActiveComment(existing.body)) return
  await githubFetch(`/issues/comments/${existing.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      body: buildCommentBody({ prNumber, status: 'inactive', runUrl }),
    }),
  })
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  if (command === 'upsert') {
    const [prNumber, status, backendUrl, frontendUrl, runUrl, otherPr] = args
    await upsertComment(prNumber, {
      status,
      backendUrl,
      frontendUrl,
      runUrl,
      supersededBy: otherPr || undefined,
      heldBy: otherPr || undefined,
    })
    return
  }
  if (command === 'supersede-others') {
    const [currentPr, runUrl] = args
    await supersedeOthers(currentPr, runUrl)
    return
  }
  if (command === 'deactivate') {
    const [prNumber, runUrl] = args
    await deactivate(prNumber, runUrl)
    return
  }

  console.error(
    'Usage: upsert-comment.mjs upsert <pr> <status> <backendUrl> <frontendUrl> <runUrl> [otherPr]\n' +
      '       upsert-comment.mjs supersede-others <currentPr> <runUrl>\n' +
      '       upsert-comment.mjs deactivate <pr> <runUrl>',
  )
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/preview-env/upsert-comment.test.mjs`
Expected: PASS, 12 tests.

- [ ] **Step 5: Format and commit**

Run: `npx prettier --write scripts/preview-env/upsert-comment.mjs scripts/preview-env/upsert-comment.test.mjs`

```bash
git add scripts/preview-env/upsert-comment.mjs scripts/preview-env/upsert-comment.test.mjs
```

```bash
git commit -m "feat(ci): add superseded, inactive and not-holder states to the preview comment"
```

---

### Task 3: Local dry run of the reset SQL (verification, no commit)

This task proves the reset SQL works against real D1 semantics (Miniflare) with foreign keys enforced. It touches only the local database under `backend/.wrangler/` (gitignored) and never uses `--remote`. Nothing in this task is committed.

**Files:**

- Read: `backend/src/preview-scrub.test.ts` (for valid `INSERT` shapes for `listeners` and `requests`; still present until Task 4)
- Scratch: `~/scratch/staging-reset/`

**Interfaces:**

- Consumes: `parseTableNames`, `buildResetSql`, `buildOccupantSql`, `parseOccupant`, `decideProvisionMode` from Task 1.

- [ ] **Step 1: Apply migrations to the local staging-binding database**

```bash
mkdir -p ~/scratch/staging-reset
cd backend && npx wrangler d1 migrations apply DB --local --env staging
```

Expected: all migrations in `backend/migrations/` apply with no error.

- [ ] **Step 2: Insert a parent and a child row so foreign keys are exercised**

Copy the `INSERT INTO listeners` and `INSERT INTO requests` statements (and their bound values) from `backend/src/preview-scrub.test.ts`, then run them literally:

```bash
npx wrangler d1 execute DB --local --env staging --command "INSERT INTO listeners (id, created_at) VALUES ('l1', '2024-01-01T00:00:00.000Z'); <the requests INSERT referencing listener l1>"
npx wrangler d1 execute DB --local --env staging --json --command "SELECT (SELECT COUNT(*) FROM listeners) AS l, (SELECT COUNT(*) FROM requests) AS r"
```

Expected: `l = 1`, `r = 1`.

- [ ] **Step 3: Generate the reset SQL from the real table list**

```bash
npx wrangler d1 execute DB --local --env staging --json --command "SELECT name FROM sqlite_master WHERE type = 'table'" > ~/scratch/staging-reset/tables.json
node --input-type=module -e "import { readFileSync, writeFileSync } from 'node:fs'; const m = await import('../scripts/preview-env/provision.mjs'); const dir = process.env.HOME + '/scratch/staging-reset/'; writeFileSync(dir + 'reset.sql', m.buildResetSql(m.parseTableNames(readFileSync(dir + 'tables.json', 'utf8'))))"
cat ~/scratch/staging-reset/reset.sql
```

Expected: the file starts with `PRAGMA defer_foreign_keys = on;` and has one `DROP TABLE` per application table, including `d1_migrations`.

- [ ] **Step 4: Run the reset and confirm the database is empty**

```bash
npx wrangler d1 execute DB --local --env staging --file ~/scratch/staging-reset/reset.sql
npx wrangler d1 execute DB --local --env staging --json --command "SELECT name FROM sqlite_master WHERE type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
```

Expected: the reset succeeds, and the second command returns an empty `results` array. Failure: if the reset fails with a foreign-key error even with data present, `defer_foreign_keys` is not taking effect for `--file`. **Stop and report this to the user** before changing the approach; the fallback is to order drops children-first using `SELECT m.name, f."table" FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table'`, which would change `buildResetSql`'s signature and Task 1's tests.

- [ ] **Step 5: Re-apply migrations to prove a clean rebuild**

```bash
npx wrangler d1 migrations apply DB --local --env staging
npx wrangler d1 execute DB --local --env staging --json --command "SELECT (SELECT COUNT(*) FROM listeners) AS l, (SELECT COUNT(*) FROM requests) AS r"
```

Expected: all migrations apply from scratch (the `d1_migrations` table was dropped), and `l = 0`, `r = 0`.

- [ ] **Step 6: Record an occupant and prove a push does not wipe data**

```bash
node --input-type=module -e "import { writeFileSync } from 'node:fs'; const m = await import('../scripts/preview-env/provision.mjs'); writeFileSync(process.env.HOME + '/scratch/staging-reset/occupant.sql', m.buildOccupantSql('42'))"
npx wrangler d1 execute DB --local --env staging --file ~/scratch/staging-reset/occupant.sql
npx wrangler d1 execute DB --local --env staging --json --command "SELECT pr FROM _staging_occupant" > ~/scratch/staging-reset/occupant.json
node --input-type=module -e "import { readFileSync } from 'node:fs'; const m = await import('../scripts/preview-env/provision.mjs'); const o = m.parseOccupant(readFileSync(process.env.HOME + '/scratch/staging-reset/occupant.json', 'utf8')); console.log(o, m.decideProvisionMode({ action: 'synchronize', occupant: o, prNumber: '42' }), m.decideProvisionMode({ action: 'synchronize', occupant: o, prNumber: '43' }))"
```

Expected: the node line prints `42 redeploy not-occupant`.

Then re-insert the Step 2 parent and child rows, run `npx wrangler d1 migrations apply DB --local --env staging` again (the redeploy path), and confirm `l = 1`, `r = 1` still: a no-op migrate must not touch data. Finally run the Step 3 and Step 4 reset again and confirm `_staging_occupant` is gone along with everything else (the reset drops it, so a stale occupant can never survive a wipe).

- [ ] **Step 7: Record the result**

No commit. In the final report, state the outcome of Steps 4, 5 and 6 explicitly.

---

### Task 4: Workflow rewrite, delete obsolete code, run script tests in CI

**Files:**

- Modify: `.github/workflows/preview.yml` (full rewrite)
- Modify: `.github/workflows/pr.yml` (add one step after "Test frontend")
- Modify: `.gitignore`
- Delete: `scripts/preview-env/teardown.mjs`, `scripts/preview-env/cloudflare-d1.mjs`, `scripts/preview-env/cloudflare-d1.test.mjs`, `scripts/preview-env/generate-wrangler-config.mjs`, `scripts/preview-env/generate-wrangler-config.test.mjs`, `scripts/preview-env/write-frontend-env.mjs`, `scripts/preview-env/write-frontend-env.test.mjs`, `scripts/preview-env/scrub.sql`, `backend/src/preview-scrub.test.ts`

**Interfaces:**

- Consumes: the `provision.mjs` CLI (Task 1) and the three `upsert-comment.mjs` commands (Task 2).

- [ ] **Step 1: Delete the obsolete files**

```bash
git rm scripts/preview-env/teardown.mjs scripts/preview-env/cloudflare-d1.mjs scripts/preview-env/cloudflare-d1.test.mjs scripts/preview-env/generate-wrangler-config.mjs scripts/preview-env/generate-wrangler-config.test.mjs scripts/preview-env/write-frontend-env.mjs scripts/preview-env/write-frontend-env.test.mjs scripts/preview-env/scrub.sql backend/src/preview-scrub.test.ts
```

Then confirm nothing still references them:

```bash
grep -rn "cloudflare-d1\|generate-wrangler-config\|write-frontend-env\|teardown.mjs\|scrub.sql\|preview-scrub" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs --exclude=CHANGELOG.md .
```

Expected: matches only in `.github/workflows/preview.yml` (rewritten next) and `CLAUDE.md` (rewritten in Task 5). Anything else: investigate before continuing.

- [ ] **Step 2: Rewrite `.github/workflows/preview.yml`**

Replace the whole file with the following. Concurrency is set at **job** level, not workflow level, on purpose: a workflow-level group would let a no-op run (for example a push to an unlabelled PR) replace a pending deploy from another PR. Skipped jobs do not enter a job-level group. GitHub keeps at most one pending run per group, so a third queued run replaces the second. Under "last label wins" that is acceptable, with one caveat to note in the PR description: a pending `labeled` run (a reset) replaced by a later push run would drop the reset, and the push would then see no occupant and post the "not-holder" comment. The author recovers by removing and re-adding the label. The comment-only `release-comment` job uses its own per-PR concurrency group (`preview-comment-<N>`) so it can never displace a pending staging deploy; only `deploy-staging` uses the `staging` group.

```yaml
name: Staging Preview

on:
  pull_request:
    types: [labeled, unlabeled, synchronize, closed]

permissions:
  contents: read
  pull-requests: write
  issues: read

jobs:
  deploy-staging:
    # `labeled` must check the label that was just added, not the PR's label
    # list: adding any unrelated label (say `bug`) to a PR that already has
    # `preview` fires `labeled` too, and must not wipe staging.
    if: >
      (github.event.action == 'labeled' && github.event.label.name == 'preview') ||
      (github.event.action == 'synchronize' &&
        contains(github.event.pull_request.labels.*.name, 'preview'))
    runs-on: ubuntu-latest
    # One shared environment: runs queue instead of racing. See
    # docs/superpowers/specs/2026-10-15-staging-preview-design.md.
    concurrency:
      group: staging
      cancel-in-progress: false
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
      ACTION: ${{ github.event.action }}
      RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install backend dependencies
        working-directory: backend
        run: npm ci

      - name: Install frontend dependencies
        working-directory: frontend
        run: npm ci

      # frontend/.env.staging points the build at the staging backend.
      - name: Build frontend for staging
        working-directory: frontend
        run: npm run build -- --mode staging

      # provision.mjs resets staging on `labeled`, redeploys on `synchronize`
      # for the occupant PR, and otherwise leaves staging untouched. Its
      # wrangler output goes to stderr (live in the Actions log, even on
      # failure); stdout carries only the final JSON result line, which is
      # what goes to $GITHUB_OUTPUT.
      - name: Reset or redeploy staging
        id: provision
        run: |
          RESULT=$(node scripts/preview-env/provision.mjs "$ACTION" "$PR_NUMBER")
          echo "$RESULT"
          echo "result=$(echo "$RESULT" | tail -1)" >> "$GITHUB_OUTPUT"

      - name: Upsert PR comment (deployed)
        if: steps.provision.outcome == 'success' && fromJSON(steps.provision.outputs.result).outcome == 'deployed'
        run: |
          BACKEND_URL=$(node -e "console.log(JSON.parse(process.argv[1]).backendUrl)" '${{ steps.provision.outputs.result }}')
          FRONTEND_URL=$(node -e "console.log(JSON.parse(process.argv[1]).frontendUrl)" '${{ steps.provision.outputs.result }}')
          node scripts/preview-env/upsert-comment.mjs upsert \
            "$PR_NUMBER" provisioned "$BACKEND_URL" "$FRONTEND_URL" "$RUN_URL"
          node scripts/preview-env/upsert-comment.mjs supersede-others \
            "$PR_NUMBER" "$RUN_URL"

      # A push to a PR that does not hold staging: nothing was deployed.
      # `occupant` is null when staging has no recorded holder.
      - name: Upsert PR comment (not the holder)
        if: steps.provision.outcome == 'success' && fromJSON(steps.provision.outputs.result).outcome == 'not-occupant'
        run: |
          HELD_BY=$(node -e "console.log(JSON.parse(process.argv[1]).occupant ?? '')" '${{ steps.provision.outputs.result }}')
          node scripts/preview-env/upsert-comment.mjs upsert \
            "$PR_NUMBER" not-holder "" "" "$RUN_URL" "$HELD_BY"

      - name: Upsert PR comment (failure)
        if: failure()
        run: |
          node scripts/preview-env/upsert-comment.mjs upsert \
            "$PR_NUMBER" failed "" "" "$RUN_URL"

  release-comment:
    if: >
      (github.event.action == 'unlabeled' && github.event.label.name == 'preview') ||
      (github.event.action == 'closed' && contains(github.event.pull_request.labels.*.name, 'preview'))
    runs-on: ubuntu-latest
    # Comment-only job: it takes no infrastructure action, so it must never
    # share the `staging` group. GitHub keeps one pending run per group, and
    # an unlabel/close run would displace another PR's queued staging deploy.
    # A per-PR group is enough; a deactivate racing an in-flight deploy for the
    # same PR can only leave a stale comment, which is cosmetic.
    concurrency:
      group: preview-comment-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      # Staging itself is left as it is; only the comment stops advertising
      # live URLs, and only if this PR was the most recent holder.
      - name: Mark preview comment inactive
        run: |
          node scripts/preview-env/upsert-comment.mjs deactivate \
            "${{ github.event.pull_request.number }}" \
            "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

- [ ] **Step 3: Run the script tests in PR CI**

In `.github/workflows/pr.yml`, add this step immediately after the "Test frontend" step (these `*.test.mjs` files are not run anywhere in CI today; without this the new tests are unprotected). Confirm the job has already run `actions/setup-node` before this point; if it has not, add a `setup-node` step with `node-version: 24` first.

```yaml
- name: Test preview-env scripts
  run: node --test "scripts/preview-env/*.test.mjs"
```

- [ ] **Step 4: Tidy `.gitignore`**

Remove these three lines, which only served the deleted per-PR flow:

```
wrangler.pr-*.toml
prod-dump*.sql
frontend/.env.production.local
```

Add:

```
backend/.reset-staging.sql
```

- [ ] **Step 5: Verify**

```bash
node --test "scripts/preview-env/*.test.mjs"
cd backend && npm test
```

Expected: script tests PASS (31 tests: 19 in `provision.test.mjs`, 12 in `upsert-comment.test.mjs`). Backend tests pass except the single known failure in `src/app.session.test.ts` (cookie `Domain`, caused by the local `.dev.vars`); no other failure. Note that the backend test count drops by the deleted scrub tests.

Then: `npx prettier --check .github/workflows/preview.yml .github/workflows/pr.yml .gitignore` is not meaningful for `.gitignore`; run it on the two workflow files only.

- [ ] **Step 6: Commit**

```bash
git add -A .github .gitignore scripts backend/src
```

```bash
git commit -m "feat(ci): deploy preview-labelled PRs to shared staging, remove per-PR machinery"
```

---

### Task 5: Update `CLAUDE.md` and `STATUS.md`

**Files:**

- Modify: `CLAUDE.md` (the `preview.yml` bullet in "CI/CD workflows — the map", and the whole "PR preview environments" section)
- Modify: `STATUS.md` (item 13, lines 150-160)

- [ ] **Step 1: Replace the `preview.yml` bullet in `CLAUDE.md`**

Find the bullet beginning `- **\`.github/workflows/preview.yml\`\*\*`and replace it, through the end of that bullet (ending`"PR preview environments" below.`), with:

```markdown
- **`.github/workflows/preview.yml`** — runs when the `preview` label is
  added to a PR: wipes the shared staging D1 database, applies the branch's
  migrations, and deploys both staging Workers, then posts the staging URLs
  as a PR comment. Pushes to the PR that holds staging apply new migrations
  and redeploy without wiping. See "PR preview environments" below.
```

- [ ] **Step 2: Replace the "PR preview environments" section in `CLAUDE.md`**

Replace everything from the `## PR preview environments` heading up to (not including) the next `## ` heading (`## Access model — read this before changing anything auth-related`) with:

```markdown
## PR preview environments

Adding the `preview` label to a PR deploys it to the **shared staging
environment** (`webhook-api-staging` + `webhook-staging` Workers on
workers.dev, D1 `webhook-listener-staging`). Nothing is ever copied from
production, so a preview's D1 write cost is the schema plus a handful of
statements, independent of production's size. This replaced the earlier
per-PR Worker + D1 model, which exported and scrubbed all of production and
exhausted the account's daily D1 write budget (spec:
`docs/superpowers/specs/2026-10-15-staging-preview-design.md`).

- **Only adding the label wipes staging.** Adding `preview` drops every
  table (including `d1_migrations`), records the PR in a script-created
  `_staging_occupant` table, applies this branch's migrations from scratch,
  and deploys both Workers with `--env staging` (in that order, so a failed
  migration can be retried by pushing). There is no seed data;
  reviewers create their own listeners. Adding an unrelated label to an
  already-labelled PR does not trigger a wipe.
- **Pushes keep your data.** A push to the PR that holds staging applies any
  new migrations (not edits to already-applied ones; re-label for those) and
  redeploys. A push to a PR that does not hold staging deploys nothing and
  comments "staging is held by #N"; remove and re-add the label to take over.
- **One preview at a time; last label wins.** A second labelled PR takes
  over staging, and the first PR's comment is rewritten to "superseded by
  #N". Deploy runs share one job-level concurrency group named `staging`, so
  they queue (GitHub keeps only the newest pending one). The comment-only
  job (label removal or close) uses its own per-PR group, so it never
  displaces a deploy; another deploy run for the `staging` group can still
  replace a pending one, so a pending `labeled` reset may be dropped. The
  push then finds no occupant and comments "staging has no recorded holder".
- **Failed runs.** A failed run sets the PR comment to a `failed` state with
  a recovery hint. If a run fails after the occupant is recorded, push a fix
  and the push retries migrations. If a push says "staging has no recorded
  holder" (the reset itself failed part-way, or a pending reset was
  replaced), remove and re-add the `preview` label.
- **Removing the label or closing the PR does nothing to staging.** It only
  updates the PR comment (if that PR was the holder).
- **Staging is also used for manual email tests.** Adding the label wipes
  whatever is there.
- Staging's `WL_SESSION_SECRET` and `RESEND_API_KEY` are Workers secrets set
  once with `wrangler secret put <NAME> --env staging`; the workflow never
  touches them.
- Previews no longer exercise production-shaped data, so a migration that is
  fine on an empty database but slow at volume is only caught in
  production. Check index/query-plan changes against a local Miniflare D1
  with generated rows (this costs no D1 budget).
- **D1 free-tier limits are account-wide**, not per database: 100,000 rows
  written and 5M rows read per day across every database, resetting at
  00:00 UTC. A separate database does not get a separate budget.
- Requires the `CLOUDFLARE_API_TOKEN` secret to have `D1: Edit` and
  `Workers Scripts: Edit`, and a `CLOUDFLARE_ACCOUNT_ID` repository variable.
- The script unit tests under `scripts/preview-env/` run in `pr.yml`
  (`node --test`).
```

- [ ] **Step 3: Replace item 13 in `STATUS.md`**

Replace the whole of item 13 (from `13. **PR preview environments**` through `checkbox at merge time — is designed separately and not yet built.`) with:

```markdown
13. **PR preview environments** — adding the `preview` label to a PR
    deploys it to the shared staging environment after wiping the staging
    D1 database (no data copied from production; last label wins; pushes
    keep the data and only the occupant PR redeploys). The
    staging URLs are posted as a PR comment (`.github/workflows/preview.yml`,
    scripts under `scripts/preview-env/`). See `CLAUDE.md`'s "PR preview
    environments" section and
    `docs/superpowers/specs/2026-10-15-staging-preview-design.md`. The
    per-PR model it replaced (`2026-09-30-pr-preview-environments-design.md`)
    is historical. Not yet verified against a real run: the measured D1
    write cost of one reset-and-deploy (acceptance bar: under 5,000 rows).
    A follow-on, sub-project 2 — opt-in automated production migrations,
    gated on a successful preview provision plus an explicit PR-body
    checkbox at merge time — is designed separately and not yet built; it
    was designed against the per-PR model and needs revisiting.
```

- [ ] **Step 4: Check for any other stale references**

```bash
grep -n -i "scrub\|torn down\|tears both\|webhook-api-pr\|PREVIEW_RESEND" CLAUDE.md STATUS.md BACKLOG.md
```

Expected: no matches in `CLAUDE.md` or `STATUS.md`. A match in `BACKLOG.md` mentioning `webhook-api-pr-13` is a historical bug report; leave it. Anything else, fix or flag to the user.

- [ ] **Step 5: Format and commit**

Run: `npx prettier --write CLAUDE.md STATUS.md`

```bash
git add CLAUDE.md STATUS.md
```

```bash
git commit -m "docs: describe staging-based previews in CLAUDE.md and STATUS.md"
```

---

### Task 6: Push, open the PR, and (deferred) measure a real run

**Files:** none.

- [ ] **Step 1: Final local verification**

```bash
node --test "scripts/preview-env/*.test.mjs"
npx prettier --check CLAUDE.md STATUS.md docs/superpowers/specs/2026-10-15-staging-preview-design.md docs/superpowers/plans/2026-10-15-staging-preview.md .github/workflows/preview.yml .github/workflows/pr.yml scripts/preview-env/*.mjs
git log --oneline main..HEAD
```

Expected: tests and Prettier pass; the log shows the spec, spec revision, plan, plan revision, the `STATUS.md` 0013 fix, and the implementation commits, each header <= 100 characters.

- [ ] **Step 2: Rename the branch to describe the whole change, then push**

Ask the user before pushing (this publishes the branch). On approval:

```bash
git branch -m docs/staging-preview-spec feat/staging-preview
git push -u origin feat/staging-preview
```

- [ ] **Step 3: Open the PR (without the `preview` label)**

Ask the user before opening it. Use a title <= 100 characters, for example `feat(ci): deploy preview-labelled PRs to a reset staging env instead of copying prod` (PRs are squash-merged, so the title becomes the release commit). The body should summarise: the incident (account-wide D1 write cap), the design in the spec, what was deleted, the local dry-run result from Task 3, and that the real-run measurement is pending. **Do not add the `preview` label** at this point.

- [ ] **Step 4: Real run and measurement (only when the user says go)**

Prerequisites to confirm with the user first: the D1 write budget has reset for the day (re-measure today's account-wide `rowsWritten` first); staging's secrets exist (`cd backend && npx wrangler secret list --env staging` should list `WL_SESSION_SECRET` and `RESEND_API_KEY`); nothing important is on staging. Then add the `preview` label to this PR (the `pull_request` workflow runs the version of `preview.yml` from the PR itself, so labelling this PR exercises the new flow).

Measure the staging database's writes for that hour with the D1 GraphQL analytics (read-only; token from `npx wrangler auth token`; account id `9a42151a465b2da9ed7c88d6c72972de`):

```
query { viewer { accounts(filter: { accountTag: "9a42151a465b2da9ed7c88d6c72972de" }) {
  d1AnalyticsAdaptiveGroups(limit: 500,
    filter: { datetime_geq: "<today>T00:00:00Z", datetime_leq: "<today>T23:59:59Z",
              databaseId: "7f55f3f0-7fe0-4237-8307-8769755f4c3a" },
    orderBy: [datetimeHour_ASC]) {
      dimensions { datetimeHour }
      sum { rowsRead rowsWritten } } } } }
```

Acceptance: `rowsWritten` for the hour of the run is under 5,000. Record the number in `STATUS.md` item 13 (replacing "Not yet verified") in a follow-up commit, and verify the comment on the PR shows `provisioned ✅` with working URLs. Then check the rules that matter most to the owner, in this order:

1. Sign in on staging, create a listener, and send it a request.
2. Push a second commit to the PR. Confirm the workflow redeploys and the listener and request **still exist** (a push must not wipe data), and the comment still shows `provisioned ✅`.
3. Add an unrelated label (for example `documentation`) to the PR. Confirm the data **still exists** (the workflow's `labeled` guard must ignore other labels).
4. Remove and re-add `preview`. Confirm staging is now **empty** and the comment updates.
5. Remove the label and confirm the comment becomes `no longer active`.

If a second PR is available, label it and confirm the first PR's comment becomes `superseded by #N`, and that pushing to the first PR then posts `staging is held by #N` without touching staging.

- [ ] **Step 5: Post-merge housekeeping**

After the PR merges, tell the user that the saved memory note `project_d1_free_tier_limits` ("avoid the `preview` label") is now out of date and should be updated, since a preview no longer burns the write budget.
