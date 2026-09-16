import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'
import { extractSessionId } from '../test-helpers/session'

describe('hook capture route', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string
  let sessionId: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id
    sessionId = extractSessionId(created)
  })

  it('captures a POST payload and returns 200', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/hook/${listenerId}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ foo: 'bar' }),
    })

    expect(response.statusCode).toBe(200)

    const requests = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}/requests`,
      cookies: { session_id: sessionId },
    })
    const [captured] = requests.json()
    expect(captured.method).toBe('POST')
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.contentType).toBe('application/json')
  })

  it('captures query params and headers', async () => {
    await app.inject({
      method: 'GET',
      url: `/hook/${listenerId}?foo=bar`,
      headers: { 'x-custom-header': 'value' },
    })

    const requests = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}/requests`,
      cookies: { session_id: sessionId },
    })
    const [captured] = requests.json()
    expect(captured.queryParams).toEqual({ foo: 'bar' })
    expect(captured.headers['x-custom-header']).toBe('value')
  })

  it('returns 404 for an unknown listener', async () => {
    const response = await app.inject({ method: 'POST', url: '/hook/does-not-exist' })
    expect(response.statusCode).toBe(404)
  })
})
