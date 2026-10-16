import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCommentBody,
  findExistingComment,
  isActiveComment,
} from './upsert-comment.mjs'

const RUN = 'https://github.com/x/y/actions/runs/1'

test('buildCommentBody renders provisioned with both URLs', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'provisioned',
    backendUrl: 'https://api.example.workers.dev',
    frontendUrl: 'https://app.example.workers.dev',
    runUrl: RUN,
  })
  assert.match(body, /^<!-- preview-env:42 -->/)
  assert.match(body, /Backend: https:\/\/api\.example\.workers\.dev/)
  assert.match(body, /Frontend: https:\/\/app\.example\.workers\.dev/)
  assert.match(body, /Status: provisioned ✅/)
  assert.match(body, /shared staging environment/)
  assert.match(body, /wiped when the `preview` label is added/)
})

test('buildCommentBody renders failed without URLs', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'failed',
    runUrl: RUN,
  })
  assert.match(body, /Status: deploy failed ❌/)
  assert.doesNotMatch(body, /Backend:/)
})

test('buildCommentBody renders superseded with the PR that took over', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'superseded',
    runUrl: RUN,
    supersededBy: '43',
  })
  assert.match(body, /Status: superseded by #43 ⏭️/)
  assert.doesNotMatch(body, /Backend:/)
})

test('buildCommentBody renders inactive', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'inactive',
    runUrl: RUN,
  })
  assert.match(body, /Status: no longer active 🧹/)
})

test('buildCommentBody renders not-holder with the PR that holds staging', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'not-holder',
    runUrl: RUN,
    heldBy: '43',
  })
  assert.match(body, /Status: staging is held by #43 ⏸️/)
  assert.match(body, /remove and re-add the `preview` label/)
  assert.doesNotMatch(body, /Backend:/)
})

test('buildCommentBody renders not-holder when no PR holds staging', () => {
  const body = buildCommentBody({
    prNumber: '42',
    status: 'not-holder',
    runUrl: RUN,
  })
  assert.match(body, /Status: staging has no recorded holder ⏸️/)
  assert.match(body, /remove and re-add the `preview` label/)
})

test('buildCommentBody throws for an unknown status', () => {
  assert.throws(() =>
    buildCommentBody({ prNumber: '42', status: 'bogus', runUrl: RUN }),
  )
})

test('findExistingComment matches the new marker format', () => {
  const comments = [
    { id: 1, body: '<!-- preview-env:41 -->\nother' },
    { id: 2, body: '<!-- preview-env:42 -->\n### Staging preview' },
  ]
  assert.equal(findExistingComment(comments, '42').id, 2)
})

test('findExistingComment also matches the old db-id marker format', () => {
  const comments = [
    { id: 7, body: '<!-- preview-env:42 db-id:db-abc -->\nold' },
  ]
  assert.equal(findExistingComment(comments, '42').id, 7)
})

test('findExistingComment does not confuse PR 4 with PR 42', () => {
  const comments = [{ id: 1, body: '<!-- preview-env:42 -->\nbody' }]
  assert.equal(findExistingComment(comments, '4'), null)
})

test('findExistingComment returns null when nothing matches', () => {
  assert.equal(findExistingComment([{ id: 1, body: 'unrelated' }], '42'), null)
})

test('isActiveComment is true only for a provisioned comment', () => {
  const active = buildCommentBody({
    prNumber: '42',
    status: 'provisioned',
    backendUrl: 'a',
    frontendUrl: 'b',
    runUrl: RUN,
  })
  const superseded = buildCommentBody({
    prNumber: '42',
    status: 'superseded',
    runUrl: RUN,
    supersededBy: '43',
  })
  const notHolder = buildCommentBody({
    prNumber: '42',
    status: 'not-holder',
    runUrl: RUN,
    heldBy: '43',
  })
  assert.equal(isActiveComment(active), true)
  assert.equal(isActiveComment(superseded), false)
  assert.equal(isActiveComment(notHolder), false)
})
