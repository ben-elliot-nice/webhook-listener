import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'

describe('shared read-only route', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string
  let shareToken: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id

    const shareResponse = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    shareToken = shareResponse.json().shareToken

    await app.inject({
      method: 'POST',
      url: `/hook/${listenerId}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ foo: 'bar' }),
    })
  })

  it('returns captured requests for a valid share token', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/shared/${shareToken}/requests` })
    expect(response.statusCode).toBe(200)
    const [captured] = response.json()
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.method).toBe('POST')
  })

  it('never includes the real listener id anywhere in the response', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/shared/${shareToken}/requests` })
    expect(response.body).not.toContain(listenerId)
  })

  it('exposes exactly the expected fields, nothing more', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/shared/${shareToken}/requests` })
    const [captured] = response.json()
    expect(Object.keys(captured).sort()).toEqual(
      ['body', 'contentType', 'headers', 'id', 'method', 'queryParams', 'receivedAt', 'sourceIp'].sort()
    )
  })

  it('returns 404 for an unknown share token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/shared/does-not-exist/requests' })
    expect(response.statusCode).toBe(404)
  })

  it('returns 404 after the share token has been revoked', async () => {
    await app.inject({ method: 'DELETE', url: `/api/listeners/${listenerId}/share` })
    const response = await app.inject({ method: 'GET', url: `/api/shared/${shareToken}/requests` })
    expect(response.statusCode).toBe(404)
  })
})
