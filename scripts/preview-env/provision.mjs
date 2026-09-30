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

    run(
      `npx wrangler d1 export webhook-listener --remote --output=prod-dump.sql`,
      { cwd: 'backend' },
    )
    run(`npx wrangler d1 execute ${dbName} --remote --file=prod-dump.sql`, {
      cwd: 'backend',
    })
    run(
      `npx wrangler d1 execute ${dbName} --remote --file=../scripts/preview-env/scrub.sql`,
      { cwd: 'backend' },
    )
    run(`npx wrangler d1 migrations apply ${dbName} --remote`, {
      cwd: 'backend',
    })
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
