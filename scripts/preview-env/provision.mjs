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
  // The header must be a whole line: backend/wrangler.toml also mentions
  // `[env.staging.vars]` inside a comment, which a plain substring split hit.
  const afterHeader = tomlText.split(/^\[env\.staging\.vars\][ \t]*$/m)[1]
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
