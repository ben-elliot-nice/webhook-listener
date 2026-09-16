import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'
import { extractSessionId } from '../test-helpers/session'

describe('GET /api/listeners', () => {
  let db: Db
  let app: FastifyInstance

  beforeEach(() => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
  })

  it('returns an empty array for a session with no listeners', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/listeners' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })

  it('returns only the calling session\'s own listeners, newest first', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/listeners' })
    const sessionId = extractSessionId(first)
    // Guarantee a distinct millisecond `created_at` between the two creations so
    // "newest first" ordering is deterministic rather than a timing race (see
    // getListenersForOwner's ORDER BY created_at DESC, id DESC tie-breaker).
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await app.inject({
      method: 'POST',
      url: '/api/listeners',
      cookies: { wl_session_id: sessionId },
    })

    const otherSessionCreate = await app.inject({ method: 'POST', url: '/api/listeners' })
    const otherSessionId = extractSessionId(otherSessionCreate)

    const response = await app.inject({
      method: 'GET',
      url: '/api/listeners',
      cookies: { wl_session_id: sessionId },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.map((l: { id: string }) => l.id)).toEqual([second.json().id, first.json().id])

    const otherResponse = await app.inject({
      method: 'GET',
      url: '/api/listeners',
      cookies: { wl_session_id: otherSessionId },
    })
    expect(otherResponse.json().map((l: { id: string }) => l.id)).toEqual([otherSessionCreate.json().id])
  })

  it('includes hookUrl and shareUrl on each item, matching the single-listener shape', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    const sessionId = extractSessionId(created)

    const response = await app.inject({
      method: 'GET',
      url: '/api/listeners',
      cookies: { wl_session_id: sessionId },
    })
    const [listed] = response.json()
    expect(listed.hookUrl).toBe(created.json().hookUrl)
    expect(listed.shareUrl).toBeNull()
  })
})
