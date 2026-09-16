import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import { createListener, getListener, deleteListener } from '../listeners.repo'
import { getRequests } from '../requests.repo'

export function registerListenerRoutes(app: FastifyInstance, db: Db, baseUrl: string): void {
  app.post('/api/listeners', async (_request, reply) => {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    createListener(db, id, createdAt)
    reply.code(201)
    return { id, createdAt, hookUrl: `${baseUrl}/hook/${id}` }
  })

  app.get<{ Params: { id: string } }>('/api/listeners/:id', async (request, reply) => {
    const listener = getListener(db, request.params.id)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    return { ...listener, hookUrl: `${baseUrl}/hook/${listener.id}` }
  })

  app.get<{ Params: { id: string } }>('/api/listeners/:id/requests', async (request, reply) => {
    const listener = getListener(db, request.params.id)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    const requests = getRequests(db, listener.id)
    return requests.map((r) => ({
      ...r,
      headers: JSON.parse(r.headers),
      queryParams: JSON.parse(r.queryParams),
    }))
  })

  app.delete<{ Params: { id: string } }>('/api/listeners/:id', async (request, reply) => {
    const deleted = deleteListener(db, request.params.id)
    if (!deleted) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    reply.code(204)
    return null
  })
}
