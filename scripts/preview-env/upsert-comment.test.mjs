import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCommentBody,
  findExistingComment,
  extractDatabaseId,
} from './upsert-comment.mjs'

test('buildCommentBody includes the marker with pr number and database id', () => {
  const body = buildCommentBody({
    prNumber: '42',
    databaseId: 'db-abc',
    status: 'provisioned',
    backendUrl: 'https://webhook-api-pr-42.example.workers.dev',
    frontendUrl: 'https://webhook-pr-42.example.workers.dev',
    runUrl: 'https://github.com/x/y/actions/runs/1',
  })
  assert.match(body, /^<!-- preview-env:42 db-id:db-abc -->/)
  assert.match(
    body,
    /Backend: https:\/\/webhook-api-pr-42\.example\.workers\.dev/,
  )
  assert.match(body, /Frontend: https:\/\/webhook-pr-42\.example\.workers\.dev/)
  assert.match(body, /provisioned ✅/)
})

test('buildCommentBody renders a failed status without URLs', () => {
  const body = buildCommentBody({
    prNumber: '42',
    databaseId: null,
    status: 'failed',
    backendUrl: '',
    frontendUrl: '',
    runUrl: 'https://github.com/x/y/actions/runs/1',
  })
  assert.match(body, /provisioning failed ❌/)
})

test('buildCommentBody renders a torn-down status', () => {
  const body = buildCommentBody({
    prNumber: '42',
    databaseId: null,
    status: 'torn-down',
    backendUrl: '',
    frontendUrl: '',
    runUrl: 'https://github.com/x/y/actions/runs/1',
  })
  assert.match(body, /torn down 🧹/)
})

test('buildCommentBody throws for an unknown status', () => {
  assert.throws(() =>
    buildCommentBody({
      prNumber: '42',
      databaseId: null,
      status: 'bogus',
      backendUrl: '',
      frontendUrl: '',
      runUrl: '',
    }),
  )
})

test('findExistingComment finds a comment matching the marker prefix for the given PR', () => {
  const comments = [
    { id: 1, body: '<!-- preview-env:41 db-id:none -->\nsomething else' },
    {
      id: 2,
      body: '<!-- preview-env:42 db-id:db-abc -->\n### 🔗 Preview environment',
    },
  ]
  assert.equal(findExistingComment(comments, '42').id, 2)
})

test('findExistingComment returns null when no comment matches', () => {
  assert.equal(
    findExistingComment([{ id: 1, body: 'unrelated comment' }], '42'),
    null,
  )
})

test('extractDatabaseId reads the db-id out of a comment body', () => {
  assert.equal(
    extractDatabaseId('<!-- preview-env:42 db-id:db-abc -->\nbody'),
    'db-abc',
  )
})

test('extractDatabaseId returns null when the marker says "none"', () => {
  assert.equal(
    extractDatabaseId('<!-- preview-env:42 db-id:none -->\nbody'),
    null,
  )
})
