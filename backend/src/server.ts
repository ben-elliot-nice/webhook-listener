import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import { registerListenerRoutes } from './routes/listeners'
import { registerHookRoute } from './routes/hook'
import { registerSharedRoutes } from './routes/shared'

declare module 'fastify' {
  interface FastifyRequest {
    sessionId: string
  }
}

const SESSION_COOKIE_NAME = 'wl_session_id'
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ServerOptions {
  db: Db
  baseUrl: string
}

export function buildServer({ db, baseUrl }: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    bodyLimit: 10 * 1024 * 1024,
  })

  // Must register before the onRequest hook below — @fastify/cookie's own parsing hook
  // needs to run first so `request.cookies` is populated when our hook reads it.
  app.register(fastifyCookie)
  app.decorateRequest('sessionId', '')

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/hook/')) {
      return
    }

    const existing = request.cookies[SESSION_COOKIE_NAME]
    if (existing && UUID_PATTERN.test(existing)) {
      request.sessionId = existing
      return
    }

    const sessionId = randomUUID()
    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    })
    request.sessionId = sessionId
  })

  registerListenerRoutes(app, db, baseUrl)
  registerSharedRoutes(app, db)

  // The hook route needs every request body captured as a raw string regardless of
  // content-type, since it must accept arbitrary webhook payload shapes. That parser
  // override is scoped to this plugin registration so it can't leak into /api/* routes.
  app.register(async (scope) => {
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body)
    })
    scope.removeContentTypeParser(['application/json'])
    registerHookRoute(scope, db)
  })

  return app
}
