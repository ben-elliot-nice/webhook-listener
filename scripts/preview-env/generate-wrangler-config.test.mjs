import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  extractWorkersDevSubdomain,
  generatePreviewConfig,
} from './generate-wrangler-config.mjs'

const backendToml = readFileSync(
  new URL('../../backend/wrangler.toml', import.meta.url),
  'utf8',
)
const frontendToml = readFileSync(
  new URL('../../frontend/wrangler.toml', import.meta.url),
  'utf8',
)

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
  assert.match(
    output,
    /^HOOK_BASE_URL = "https:\/\/webhook-api-pr-42\.ben-elliot-9a4\.workers\.dev"$/m,
  )
  assert.match(
    output,
    /^APP_BASE_URL = "https:\/\/webhook-pr-42\.ben-elliot-9a4\.workers\.dev"$/m,
  )
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
  const originalStagingBlock = backendToml.slice(
    backendToml.indexOf('[env.staging]'),
  )
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
    generatePreviewConfig({
      target: 'backend',
      prNumber: '42',
      tomlText: backendToml,
      subdomain: 'x',
    }),
  )
})

// Discovered during implementation: frontend/wrangler.toml's default section
// explicitly sets `workers_dev = false` (it normally relies on an
// out-of-band custom-domain attachment instead). Left untouched, a PR
// preview deploy of the frontend Worker would get no *.workers.dev URL at
// all, breaking the feature's entire premise. generatePreviewConfig must
// force workers_dev on for both targets in the generated section.
test('generatePreviewConfig forces workers_dev = true for frontend (overriding false)', () => {
  const output = generatePreviewConfig({
    target: 'frontend',
    prNumber: '42',
    tomlText: frontendToml,
    subdomain: 'ben-elliot-9a4',
  })
  const defaultSection = output.slice(0, output.indexOf('[env.staging]'))
  assert.match(defaultSection, /^workers_dev = true$/m)
  assert.doesNotMatch(defaultSection, /^workers_dev = false$/m)
})

test('generatePreviewConfig sets workers_dev = true for backend (no line present originally)', () => {
  const output = generatePreviewConfig({
    target: 'backend',
    prNumber: '42',
    tomlText: backendToml,
    subdomain: 'ben-elliot-9a4',
    databaseId: 'test-db-id-123',
  })
  const defaultSection = output.slice(0, output.indexOf('[env.staging]'))
  assert.match(defaultSection, /^workers_dev = true$/m)
})
