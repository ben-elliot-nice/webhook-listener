import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldFullyProvision, generateSessionSecret } from './provision.mjs'

test('shouldFullyProvision is true when there is no existing database', () => {
  assert.equal(
    shouldFullyProvision({
      existingDatabaseId: null,
      migrationsChanged: false,
    }),
    true,
  )
})

test('shouldFullyProvision is true when migrations changed, even with an existing database', () => {
  assert.equal(
    shouldFullyProvision({
      existingDatabaseId: 'db-1',
      migrationsChanged: true,
    }),
    true,
  )
})

test('shouldFullyProvision is false when a database exists and migrations did not change', () => {
  assert.equal(
    shouldFullyProvision({
      existingDatabaseId: 'db-1',
      migrationsChanged: false,
    }),
    false,
  )
})

test('generateSessionSecret returns a 64-char hex string', () => {
  const secret = generateSessionSecret()
  assert.match(secret, /^[0-9a-f]{64}$/)
})

test('generateSessionSecret returns a different value on each call', () => {
  assert.notEqual(generateSessionSecret(), generateSessionSecret())
})
