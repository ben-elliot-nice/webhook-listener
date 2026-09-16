import type { FastifyInstance } from 'fastify'
import type { Db } from '../db'
import { getListener } from '../listeners.repo'
import { insertRequest } from '../requests.repo'

const REDACTED_HEADER_NAMES = new Set(['cookie', 'set-cookie'])

function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (REDACTED_HEADER_NAMES.has(key.toLowerCase())) continue
    redacted[key] = value
  }
  return redacted
}

export function registerHookRoute(app: FastifyInstance, db: Db): void {
  app.all<{ Params: { id: string } }>('/hook/:id', async (request, reply) => {
    const listener = getListener(db, request.params.id)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }

    const body = typeof request.body === 'string' ? request.body : null

    insertRequest(db, {
      listenerId: listener.id,
      method: request.method,
      headers: JSON.stringify(redactHeaders(request.headers)),
      queryParams: JSON.stringify(request.query ?? {}),
      body,
      contentType: (request.headers['content-type'] as string | undefined) ?? null,
      sourceIp: request.ip,
      receivedAt: new Date().toISOString(),
    })

    reply.code(200).send()
  })
}
