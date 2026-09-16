import type { FastifyInstance } from 'fastify'
import type { Db } from '../db'
import { getListenerByShareToken } from '../listeners.repo'
import { getRequests } from '../requests.repo'

export function registerSharedRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { token: string } }>('/api/shared/:token/requests', async (request, reply) => {
    const listener = getListenerByShareToken(db, request.params.token)
    if (!listener) {
      reply.code(404)
      return { error: 'share link not found' }
    }
    const requests = getRequests(db, listener.id)
    return requests.map((r) => ({
      id: r.id,
      method: r.method,
      headers: JSON.parse(r.headers),
      queryParams: JSON.parse(r.queryParams),
      body: r.body,
      contentType: r.contentType,
      sourceIp: r.sourceIp,
      receivedAt: r.receivedAt,
    }))
  })
}
