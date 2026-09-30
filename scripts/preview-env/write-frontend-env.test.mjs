import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFrontendEnvContent } from './write-frontend-env.mjs'

test('buildFrontendEnvContent points VITE_API_BASE_URL at the PR backend Worker', () => {
  const content = buildFrontendEnvContent({
    prNumber: '42',
    subdomain: 'ben-elliot-9a4',
  })
  assert.equal(
    content,
    'VITE_API_BASE_URL=https://webhook-api-pr-42.ben-elliot-9a4.workers.dev\n',
  )
})
