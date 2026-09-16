import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'

describe('listener share management', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id
  })

  it('has no share link by default', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/listeners/${listenerId}` })
    expect(response.json().shareUrl).toBeNull()
  })

  it('creates a share link', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.shareToken).toBeTypeOf('string')
    expect(body.shareUrl).toBe(`http://localhost:8080/shared/${body.shareToken}`)
  })

  it('is idempotent — repeat calls return the same token', async () => {
    const first = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    const second = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    expect(second.json().shareToken).toBe(first.json().shareToken)
  })

  it('reflects the created share link on the listener', async () => {
    const shareResponse = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    const listenerResponse = await app.inject({ method: 'GET', url: `/api/listeners/${listenerId}` })
    expect(listenerResponse.json().shareUrl).toBe(shareResponse.json().shareUrl)
  })

  it('revokes a share link', async () => {
    await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    const revokeResponse = await app.inject({ method: 'DELETE', url: `/api/listeners/${listenerId}/share` })
    expect(revokeResponse.statusCode).toBe(204)

    const listenerResponse = await app.inject({ method: 'GET', url: `/api/listeners/${listenerId}` })
    expect(listenerResponse.json().shareUrl).toBeNull()
  })

  it('generates a new token after revoke then re-share', async () => {
    const first = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    await app.inject({ method: 'DELETE', url: `/api/listeners/${listenerId}/share` })
    const second = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    expect(second.json().shareToken).not.toBe(first.json().shareToken)
  })

  it('returns 404 for an unknown listener on both endpoints', async () => {
    const shareResponse = await app.inject({ method: 'POST', url: '/api/listeners/does-not-exist/share' })
    expect(shareResponse.statusCode).toBe(404)

    const revokeResponse = await app.inject({ method: 'DELETE', url: '/api/listeners/does-not-exist/share' })
    expect(revokeResponse.statusCode).toBe(404)
  })
})
