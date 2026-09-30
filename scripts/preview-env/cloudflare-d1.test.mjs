import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createD1Database,
  findD1DatabaseIdByName,
  deleteD1Database,
} from './cloudflare-d1.mjs'

test('createD1Database posts to the create endpoint and returns the uuid', async () => {
  let capturedUrl, capturedOptions
  const fetchImpl = async (url, options) => {
    capturedUrl = url
    capturedOptions = options
    return { ok: true, json: async () => ({ result: { uuid: 'new-db-id' } }) }
  }

  const id = await createD1Database({
    accountId: 'acct-1',
    name: 'db-name',
    apiToken: 'token-1',
    fetchImpl,
  })

  assert.equal(id, 'new-db-id')
  assert.equal(
    capturedUrl,
    'https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database',
  )
  assert.equal(capturedOptions.method, 'POST')
  assert.equal(capturedOptions.headers.Authorization, 'Bearer token-1')
  assert.deepEqual(JSON.parse(capturedOptions.body), { name: 'db-name' })
})

test('createD1Database throws with response details on failure', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => 'bad request',
  })
  await assert.rejects(
    () =>
      createD1Database({
        accountId: 'acct-1',
        name: 'db-name',
        apiToken: 'token-1',
        fetchImpl,
      }),
    /400/,
  )
})

test('findD1DatabaseIdByName returns the matching database uuid', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /\/d1\/database\?name=db-name$/)
    return {
      ok: true,
      json: async () => ({
        result: [
          { name: 'other-db', uuid: 'x' },
          { name: 'db-name', uuid: 'found-id' },
        ],
      }),
    }
  }
  const id = await findD1DatabaseIdByName({
    accountId: 'acct-1',
    name: 'db-name',
    apiToken: 'token-1',
    fetchImpl,
  })
  assert.equal(id, 'found-id')
})

test('findD1DatabaseIdByName returns null when no database matches', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ result: [] }),
  })
  const id = await findD1DatabaseIdByName({
    accountId: 'acct-1',
    name: 'db-name',
    apiToken: 'token-1',
    fetchImpl,
  })
  assert.equal(id, null)
})

test('deleteD1Database calls the delete endpoint with the right method and auth header', async () => {
  let capturedUrl, capturedOptions
  const fetchImpl = async (url, options) => {
    capturedUrl = url
    capturedOptions = options
    return { ok: true }
  }
  await deleteD1Database({
    accountId: 'acct-1',
    databaseId: 'db-1',
    apiToken: 'token-1',
    fetchImpl,
  })
  assert.equal(
    capturedUrl,
    'https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database/db-1',
  )
  assert.equal(capturedOptions.method, 'DELETE')
  assert.equal(capturedOptions.headers.Authorization, 'Bearer token-1')
})

test('deleteD1Database throws with response details on failure', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    text: async () => 'not found',
  })
  await assert.rejects(
    () =>
      deleteD1Database({
        accountId: 'acct-1',
        databaseId: 'db-1',
        apiToken: 'token-1',
        fetchImpl,
      }),
    /404/,
  )
})
