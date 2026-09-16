import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db'
import { registerListenerRoutes } from './routes/listeners'

export interface ServerOptions {
  db: Db
  baseUrl: string
}

export function buildServer({ db, baseUrl }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: true })

  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })

  registerListenerRoutes(app, db, baseUrl)

  return app
}
