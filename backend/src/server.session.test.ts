import { describe, it, expect } from 'vitest'
import { createDb } from './db'
import { buildServer } from './server'
import { extractSessionId } from './test-helpers/session'

describe('session cookie', () => {
  it('sets a session_id cookie when the request has none', async () => {
    const db = createDb(':memory:')
    const app = buildServer({ db, baseUrl: 'http://localhost:8080' })

    const response = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })
    const cookie = response.cookies.find((c) => c.name === 'wl_session_id')
    expect(cookie).toBeDefined()
    expect(cookie?.value).toBeTypeOf('string')
  })

  it('reuses an existing session_id cookie instead of issuing a new one', async () => {
    const db = createDb(':memory:')
    const app = buildServer({ db, baseUrl: 'http://localhost:8080' })

    const first = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })
    const sessionId = extractSessionId(first)

    const second = await app.inject({
      method: 'GET',
      url: '/api/listeners/does-not-exist',
      cookies: { wl_session_id: sessionId },
    })
    const reusedCookie = second.cookies.find((c) => c.name === 'wl_session_id')
    expect(reusedCookie).toBeUndefined()
  })

  it('issues different session ids to requests with no cookie', async () => {
    const db = createDb(':memory:')
    const app = buildServer({ db, baseUrl: 'http://localhost:8080' })

    const first = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })
    const second = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })

    expect(extractSessionId(first)).not.toBe(extractSessionId(second))
  })

  it('replaces a malformed session_id cookie value with a fresh one', async () => {
    const db = createDb(':memory:')
    const app = buildServer({ db, baseUrl: 'http://localhost:8080' })

    const response = await app.inject({
      method: 'GET',
      url: '/api/listeners/does-not-exist',
      cookies: { wl_session_id: 'not-a-uuid' },
    })
    const cookie = response.cookies.find((c) => c.name === 'wl_session_id')
    expect(cookie).toBeDefined()
    expect(cookie?.value).not.toBe('not-a-uuid')
  })
})
