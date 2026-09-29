#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'

export function syncPackageVersion(filePath, version) {
  const pkg = JSON.parse(readFileSync(filePath, 'utf8'))
  pkg.version = version
  writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`)
}

const DEFAULT_TARGETS = ['backend/package.json', 'frontend/package.json']

function main() {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: sync-package-versions.mjs <version>')
    process.exit(1)
  }
  for (const filePath of DEFAULT_TARGETS) {
    syncPackageVersion(filePath, version)
  }
  console.log(`Synced version ${version} to ${DEFAULT_TARGETS.join(', ')}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
