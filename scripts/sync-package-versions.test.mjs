import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncPackageVersion } from './sync-package-versions.mjs'

test('syncPackageVersion updates only the version field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-package-versions-'))
  const filePath = join(dir, 'package.json')
  writeFileSync(
    filePath,
    `${JSON.stringify({ name: 'example', version: '0.0.0', dependencies: { hono: '^4.6.9' } }, null, 2)}\n`,
  )

  syncPackageVersion(filePath, '1.2.3')

  const updated = JSON.parse(readFileSync(filePath, 'utf8'))
  assert.equal(updated.version, '1.2.3')
  assert.equal(updated.name, 'example')
  assert.deepEqual(updated.dependencies, { hono: '^4.6.9' })

  rmSync(dir, { recursive: true, force: true })
})

test('syncPackageVersion writes a trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-package-versions-'))
  const filePath = join(dir, 'package.json')
  writeFileSync(
    filePath,
    `${JSON.stringify({ name: 'example', version: '0.0.0' }, null, 2)}\n`,
  )

  syncPackageVersion(filePath, '2.0.0')

  const raw = readFileSync(filePath, 'utf8')
  assert.ok(raw.endsWith('\n'))

  rmSync(dir, { recursive: true, force: true })
})
