import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'
import { extractSessionId } from '../test-helpers/session'

describe('listener ownership isolation', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string
  let ownerSessionId: string
  let otherSessionId: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })

    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id
    ownerSessionId = extractSessionId(created)

    const otherVisit = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })
    otherSessionId = extractSessionId(otherVisit)
  })

  it('is invisible to a different session on GET /api/listeners/:id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: otherSessionId },
    })
    expect(response.statusCode).toBe(404)
  })

  it('is invisible to a different session on GET /api/listeners/:id/requests', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}/requests`,
      cookies: { session_id: otherSessionId },
    })
    expect(response.statusCode).toBe(404)
  })

  it('cannot be deleted by a different session', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: otherSessionId },
    })
    expect(response.statusCode).toBe(404)

    const stillThere = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: ownerSessionId },
    })
    expect(stillThere.statusCode).toBe(200)
  })

  it('cannot have a share link created by a different session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: otherSessionId },
    })
    expect(response.statusCode).toBe(404)
  })

  it('cannot have its share link revoked by a different session', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: ownerSessionId },
    })
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: otherSessionId },
    })
    expect(response.statusCode).toBe(404)
  })

  it('is invisible to a request with no session cookie at all', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/listeners/${listenerId}` })
    expect(response.statusCode).toBe(404)
  })

  it('remains visible to the owning session throughout', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: ownerSessionId },
    })
    expect(response.statusCode).toBe(200)
  })

  it('the hook route remains reachable regardless of session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/hook/${listenerId}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ok: true }),
    })
    expect(response.statusCode).toBe(200)
  })
})
