import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db'
import { registerListenerRoutes } from './routes/listeners'
import { registerHookRoute } from './routes/hook'

export interface ServerOptions {
  db: Db
  baseUrl: string
}

export function buildServer({ db, baseUrl }: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    bodyLimit: 10 * 1024 * 1024,
  })

  registerListenerRoutes(app, db, baseUrl)

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
