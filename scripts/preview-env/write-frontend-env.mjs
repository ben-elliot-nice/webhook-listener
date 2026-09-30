#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { extractWorkersDevSubdomain } from './generate-wrangler-config.mjs'

// The frontend's API base URL is baked in at build time via Vite's
// import.meta.env.VITE_API_BASE_URL (frontend/src/api.ts), read from
// frontend/.env.production by default. Left untouched, a preview build
// would call the real prod backend instead of its own webhook-api-pr-N
// Worker — breaking every API call with a CORS error, since prod's CORS
// only allows the real prod frontend origin. Vite loads
// .env.<mode>.local with the highest precedence, so writing this file
// before `vite build` (mode defaults to "production") overrides the
// committed frontend/.env.production for this build only, without
// touching it.
export function buildFrontendEnvContent({ prNumber, subdomain }) {
  return `VITE_API_BASE_URL=https://webhook-api-pr-${prNumber}.${subdomain}.workers.dev\n`
}

function main() {
  const [prNumber] = process.argv.slice(2)
  if (!prNumber) {
    console.error('Usage: write-frontend-env.mjs <pr-number>')
    process.exit(1)
  }

  const backendTomlText = readFileSync('backend/wrangler.toml', 'utf8')
  const subdomain = extractWorkersDevSubdomain(backendTomlText)

  const content = buildFrontendEnvContent({ prNumber, subdomain })
  const outputPath = 'frontend/.env.production.local'
  writeFileSync(outputPath, content)
  console.log(outputPath)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
