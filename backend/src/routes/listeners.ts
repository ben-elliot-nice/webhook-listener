import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import {
  createListener,
  getListener,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
} from '../listeners.repo'
import { getRequests } from '../requests.repo'

function shareUrlFor(baseUrl: string, shareToken: string | null): string | null {
  return shareToken ? `${baseUrl}/shared/${shareToken}` : null
}

export function registerListenerRoutes(app: FastifyInstance, db: Db, baseUrl: string): void {
  app.post('/api/listeners', async (_request, reply) => {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const listener = createListener(db, id, createdAt)
    reply.code(201)
    return {
      id: listener.id,
      createdAt: listener.createdAt,
      hookUrl: `${baseUrl}/hook/${listener.id}`,
      shareUrl: shareUrlFor(baseUrl, listener.shareToken),
    }
  })

  app.get<{ Params: { id: string } }>('/api/listeners/:id', async (request, reply) => {
    const listener = getListener(db, request.params.id)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    return {
      id: listener.id,
      createdAt: listener.createdAt,
      hookUrl: `${baseUrl}/hook/${listener.id}`,
      shareUrl: shareUrlFor(baseUrl, listener.shareToken),
    }
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

  app.post<{ Params: { id: string } }>('/api/listeners/:id/share', async (request, reply) => {
    const token = getOrCreateShareToken(db, request.params.id)
    if (!token) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    return { shareToken: token, shareUrl: shareUrlFor(baseUrl, token) }
  })

  app.delete<{ Params: { id: string } }>('/api/listeners/:id/share', async (request, reply) => {
    const revoked = revokeShareToken(db, request.params.id)
    if (!revoked) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    reply.code(204)
    return null
  })
}
