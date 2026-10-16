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

// backend/wrangler.toml mentions the header inside a comment before the real
// section; the first real run failed on exactly this shape.
test('extractStagingUrls ignores the header text inside a comment', () => {
  const toml = `# not in [env.staging.vars] either, for the same reason
[env.staging]
name = "webhook-api-staging"

[env.staging.vars]
HOOK_BASE_URL = "https://webhook-api-staging.example.workers.dev"
APP_BASE_URL = "https://webhook-staging.example.workers.dev"
`
  assert.deepEqual(extractStagingUrls(toml), {
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
