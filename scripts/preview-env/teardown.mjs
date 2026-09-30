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
    console.error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required',
    )
    process.exit(1)
  }

  run(`npx wrangler delete --name webhook-api-pr-${prNumber}`, {
    cwd: 'backend',
  })
  run(`npx wrangler delete --name webhook-pr-${prNumber}`, { cwd: 'frontend' })

  const dbName = `webhook-listener-pr-${prNumber}`
  const databaseId = await findD1DatabaseIdByName({
    accountId,
    name: dbName,
    apiToken,
  })
  if (databaseId) {
    await deleteD1Database({ accountId, databaseId, apiToken })
    console.log(`Deleted D1 database ${dbName} (${databaseId})`)
  } else {
    console.log(
      `No D1 database named ${dbName} found — already deleted or never provisioned`,
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
