import { Hono } from 'hono'
import type { Env } from '../env'
import {
  resolveListenerForHook,
  getListenerByProjectAndSlug,
  createProjectListener,
  normalizeSlug,
  assertValidSlug,
  SlugValidationError,
  isUniqueConstraintError,
} from '../listeners.repo'
import { insertRequest } from '../requests.repo'
import { getProject } from '../projects.repo'

const REDACTED_HEADER_NAMES = new Set(['cookie', 'set-cookie'])
const MAX_BODY_BYTES = 10 * 1024 * 1024

function redactHeaders(headers: Headers): Record<string, string> {
  const redacted: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (REDACTED_HEADER_NAMES.has(key.toLowerCase())) return
    redacted[key] = value
  })
  return redacted
}

function parseQuery(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const key of url.searchParams.keys()) {
    if (key in query) continue
    const values = url.searchParams.getAll(key)
    query[key] = values.length > 1 ? values : values[0]
  }
  return query
}

export const hookRoute = new Hono<{ Bindings: Env }>()

hookRoute.all('/hook/:id', async (c) => {
  const listener = await resolveListenerForHook(c.env.DB, c.req.param('id'), c.req.header('x-webhook-token'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }

  const contentLength = c.req.header('content-length')
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return c.json({ error: 'payload too large' }, 413)
  }

  const body = c.req.raw.body ? await c.req.raw.clone().text() : null

  await insertRequest(c.env.DB, {
    listenerId: listener.id,
    method: c.req.method,
    headers: JSON.stringify(redactHeaders(c.req.raw.headers)),
    queryParams: JSON.stringify(parseQuery(new URL(c.req.url))),
    body,
    contentType: c.req.header('content-type') ?? null,
    sourceIp: c.req.header('cf-connecting-ip') ?? null,
    receivedAt: new Date().toISOString(),
  })

  return c.body(null, 200)
})

hookRoute.all('/hook/:projectId/:identifier', async (c) => {
  const project = await getProject(c.env.DB, c.req.param('projectId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }

  const identifier = normalizeSlug(c.req.param('identifier'))
  try {
    assertValidSlug(identifier)
  } catch (err) {
    if (err instanceof SlugValidationError) {
      return c.json({ error: err.message }, 400)
    }
    throw err
  }

  const contentLength = c.req.header('content-length')
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return c.json({ error: 'payload too large' }, 413)
  }

  let listener = await getListenerByProjectAndSlug(c.env.DB, project.id, identifier)
  let status: 200 | 201 = listener ? 200 : 201
  if (!listener) {
    try {
      listener = await createProjectListener(
        c.env.DB,
        crypto.randomUUID(),
        new Date().toISOString(),
        project.ownerSession,
        project.ownerEmail,
        project.id,
        identifier
      )
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err
      // Lost the race to a concurrent first-call creating the same
      // (projectId, identifier) pair — the winner's row now exists, use it.
      listener = await getListenerByProjectAndSlug(c.env.DB, project.id, identifier)
      status = 200
      if (!listener) throw err
    }
  }

  const body = c.req.raw.body ? await c.req.raw.clone().text() : null

  await insertRequest(c.env.DB, {
    listenerId: listener.id,
    method: c.req.method,
    headers: JSON.stringify(redactHeaders(c.req.raw.headers)),
    queryParams: JSON.stringify(parseQuery(new URL(c.req.url))),
    body,
    contentType: c.req.header('content-type') ?? null,
    sourceIp: c.req.header('cf-connecting-ip') ?? null,
    receivedAt: new Date().toISOString(),
  })

  return c.body(null, status)
})
