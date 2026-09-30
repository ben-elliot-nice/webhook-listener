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

// Forces the generated section onto workers.dev, regardless of whether the
// source file had no workers_dev line (backend, which normally relies on an
// out-of-band custom-domain attachment) or an explicit `workers_dev = false`
// (frontend, same reason). Without this, a PR preview Worker would deploy
// with no *.workers.dev URL at all.
function forceWorkersDevOn(sectionText) {
  if (/^workers_dev = .*$/m.test(sectionText)) {
    return sectionText.replace(/^workers_dev = .*$/m, 'workers_dev = true')
  }
  return sectionText.replace(/^(name = ".+")$/m, `$1\nworkers_dev = true`)
}

export function generatePreviewConfig({
  target,
  prNumber,
  tomlText,
  subdomain,
  databaseId,
}) {
  const stagingIndex = tomlText.indexOf(ENV_STAGING_MARKER)
  const defaultSection =
    stagingIndex === -1 ? tomlText : tomlText.slice(0, stagingIndex)
  const rest = stagingIndex === -1 ? '' : tomlText.slice(stagingIndex)

  const workerName =
    target === 'backend'
      ? `webhook-api-pr-${prNumber}`
      : `webhook-pr-${prNumber}`

  let transformed = defaultSection.replace(
    new RegExp(`^name = "${DEFAULT_NAMES[target]}"$`, 'm'),
    `name = "${workerName}"`,
  )

  transformed = forceWorkersDevOn(transformed)

  if (target === 'backend') {
    if (!databaseId) {
      throw new Error('databaseId is required when target is "backend"')
    }
    transformed = transformed.replace(
      /^database_id = ".+"$/m,
      `database_id = "${databaseId}"`,
    )
    transformed = transformed.replace(
      /^HOOK_BASE_URL = ".+"$/m,
      `HOOK_BASE_URL = "https://webhook-api-pr-${prNumber}.${subdomain}.workers.dev"`,
    )
    transformed = transformed.replace(
      /^APP_BASE_URL = ".+"$/m,
      `APP_BASE_URL = "https://webhook-pr-${prNumber}.${subdomain}.workers.dev"`,
    )
    transformed = transformed.replace(
      /^SESSION_COOKIE_DOMAIN = ".*"$/m,
      `SESSION_COOKIE_DOMAIN = ""`,
    )
  }

  return transformed + rest
}

function main() {
  const [target, prNumber, databaseIdArg] = process.argv.slice(2)
  if (target !== 'backend' && target !== 'frontend') {
    console.error(
      'Usage: generate-wrangler-config.mjs <backend|frontend> <pr-number> [database-id]',
    )
    process.exit(1)
  }
  if (!prNumber) {
    console.error(
      'Usage: generate-wrangler-config.mjs <backend|frontend> <pr-number> [database-id]',
    )
    process.exit(1)
  }
  if (target === 'backend' && !databaseIdArg) {
    console.error('database-id is required when target is "backend"')
    process.exit(1)
  }

  const backendTomlText = readFileSync(SOURCE_FILES.backend, 'utf8')
  const subdomain = extractWorkersDevSubdomain(backendTomlText)
  const sourceTomlText =
    target === 'backend'
      ? backendTomlText
      : readFileSync(SOURCE_FILES.frontend, 'utf8')

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
