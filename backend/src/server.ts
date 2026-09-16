import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db'
import { registerListenerRoutes } from './routes/listeners'
import { registerHookRoute } from './routes/hook'

export interface ServerOptions {
  db: Db
  baseUrl: string
}

export function buildServer({ db, baseUrl }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: true })

  // Fastify's default parsers for 'application/json' and 'text/plain' would otherwise
  // take precedence over the '*' catch-all below, so they must be removed to guarantee
  // every request body is captured as a raw string regardless of content-type.
  app.removeContentTypeParser(['application/json'])
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })

  registerListenerRoutes(app, db, baseUrl)
  registerHookRoute(app, db)

  return app
}
