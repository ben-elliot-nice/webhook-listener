#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createD1Database, findD1DatabaseIdByName } from './cloudflare-d1.mjs'
import {
  extractWorkersDevSubdomain,
  generatePreviewConfig,
} from './generate-wrangler-config.mjs'

export function shouldFullyProvision({
  existingDatabaseId,
  migrationsChanged,
}) {
  return !existingDatabaseId || migrationsChanged
}

// Dependency order matters here: `wrangler d1 export`'s dump orders tables
// by original creation history, not current schema, so a naive whole-DB
// export/import puts `CREATE TABLE listeners` (migration 0001, which later
// gained a `project_id REFERENCES projects(id)` column in migration 0005)
// before `CREATE TABLE projects`. D1 enforces foreign keys immediately
// (it does not honor the dump's own `PRAGMA defer_foreign_keys=TRUE`
// line), so importing that dump verbatim fails with
// "no such table: main.projects" the moment it inserts a listener row
// with a non-null project_id. Migrating the schema first (so every table
// already exists), then importing each table's data separately in
// parent-before-child order, avoids the hazard entirely. Discovered via a
// real labeled test PR (see docs/superpowers/plans/2026-09-30-pr-preview-environments.md).
const TABLES_IN_DEPENDENCY_ORDER = [
  'projects',
  'listeners',
  'requests',
  'magic_links',
  'shared_with_me',
]

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
    console.error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required',
    )
    process.exit(1)
  }

  const dbName = `webhook-listener-pr-${prNumber}`

  const changedFiles = execSync(
    `git diff --name-only ${baseSha}...${headSha}`,
    { encoding: 'utf8' },
  )
  const migrationsChanged = changedFiles
    .split('\n')
    .some((path) => path.startsWith('backend/migrations/'))

  const existingDatabaseId = await findD1DatabaseIdByName({
    accountId,
    name: dbName,
    apiToken,
  })
  const needsFullProvision = shouldFullyProvision({
    existingDatabaseId,
    migrationsChanged,
  })

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
  }

  // Written before migrations run (not just before deploy) because
  // `wrangler d1 migrations apply <database>` resolves its <database>
  // argument against a [[d1_databases]] entry declared in the loaded
  // wrangler.toml — unlike `wrangler d1 execute <name>`, which resolves
  // the name directly against the account's D1 API and needs no config
  // declaration. The default backend/wrangler.toml only declares the prod
  // database, so migrations apply against the PR database has to be
  // pointed at this generated config via -c, using the "DB" binding name.
  const backendTomlText = readFileSync('backend/wrangler.toml', 'utf8')
  const subdomain = extractWorkersDevSubdomain(backendTomlText)

  const backendConfig = generatePreviewConfig({
    target: 'backend',
    prNumber,
    tomlText: backendTomlText,
    subdomain,
    databaseId,
  })
  const backendConfigPath = `wrangler.pr-${prNumber}.toml`
  writeFileSync(`backend/${backendConfigPath}`, backendConfig)

  if (needsFullProvision) {
    run(
      `npx wrangler d1 migrations apply DB --remote -c ${backendConfigPath}`,
      {
        cwd: 'backend',
      },
    )

    for (const table of TABLES_IN_DEPENDENCY_ORDER) {
      const dumpFile = `prod-dump-${table}.sql`
      run(
        `npx wrangler d1 export webhook-listener --remote --no-schema --table=${table} --output=${dumpFile}`,
        { cwd: 'backend' },
      )
      run(`npx wrangler d1 execute ${dbName} --remote --file=${dumpFile}`, {
        cwd: 'backend',
      })
    }

    run(
      `npx wrangler d1 execute ${dbName} --remote --file=../scripts/preview-env/scrub.sql`,
      { cwd: 'backend' },
    )
  }

  run(`npx wrangler deploy -c ${backendConfigPath}`, { cwd: 'backend' })

  const frontendTomlText = readFileSync('frontend/wrangler.toml', 'utf8')
  const frontendConfig = generatePreviewConfig({
    target: 'frontend',
    prNumber,
    tomlText: frontendTomlText,
    subdomain,
  })
  writeFileSync(`frontend/wrangler.pr-${prNumber}.toml`, frontendConfig)
  run(`npx wrangler deploy -c wrangler.pr-${prNumber}.toml`, {
    cwd: 'frontend',
  })

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
