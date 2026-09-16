import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from './db'
import { buildServer } from './server'

describe('listener routes', () => {
  let db: Db
  let app: FastifyInstance

  beforeEach(() => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
  })

  it('creates a listener', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/listeners' })
    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.id).toBeTypeOf('string')
    expect(body.hookUrl).toBe(`http://localhost:8080/hook/${body.id}`)
  })

  it('returns 404 for an unknown listener', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })
    expect(response.statusCode).toBe(404)
  })

  it('fetches an existing listener', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    const { id } = created.json()

    const response = await app.inject({ method: 'GET', url: `/api/listeners/${id}` })
    expect(response.statusCode).toBe(200)
    expect(response.json().id).toBe(id)
  })

  it('deletes a listener', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    const { id } = created.json()

    const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/listeners/${id}` })
    expect(deleteResponse.statusCode).toBe(204)

    const getResponse = await app.inject({ method: 'GET', url: `/api/listeners/${id}` })
    expect(getResponse.statusCode).toBe(404)
  })

  it('returns 404 for requests of an unknown listener', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist/requests' })
    expect(response.statusCode).toBe(404)
  })
})
