import type { FastifyInstance } from 'fastify'

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>

export function extractSessionId(response: InjectResponse): string {
  const cookie = response.cookies.find((c) => c.name === 'wl_session_id')
  if (!cookie) {
    throw new Error('no session_id cookie found in response')
  }
  return cookie.value
}
