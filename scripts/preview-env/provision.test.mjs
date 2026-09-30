import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldFullyProvision } from './provision.mjs'

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
