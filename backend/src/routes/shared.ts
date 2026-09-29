import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import {
  getListenerByShareToken,
  getListener,
  getListenersByProject,
} from '../listeners.repo'
import { getProjectByShareToken } from '../projects.repo'
import { getRequestsPage, getRequestById } from '../requests.repo'
import {
  recordSharedVisit,
  listSharedWithMe,
  removeSharedWithMe,
} from '../shared-with-me.repo'
import {
  serializeRequestListItem,
  parsePageParams,
} from './requestListSerializer'

export const sharedRoutes = new Hono<{ Bindings: Env; Variables: Variables }>()

sharedRoutes.get('/api/shared/:token/requests', async (c) => {
  const listener = await getListenerByShareToken(c.env.DB, c.req.param('token'))
  if (!listener) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const { limit, before } = parsePageParams(
    c.req.query('limit'),
    c.req.query('before'),
  )
  const { requests, nextCursor } = await getRequestsPage(
    c.env.DB,
    listener.id,
    { limit, before },
  )
  return c.json({
    requests: requests.map(serializeRequestListItem),
    nextCursor,
  })
})

sharedRoutes.get('/api/shared/:token/requests/:requestId/body', async (c) => {
  const listener = await getListenerByShareToken(c.env.DB, c.req.param('token'))
  if (!listener) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const requestId = Number(c.req.param('requestId'))
  const record = Number.isInteger(requestId)
    ? await getRequestById(c.env.DB, listener.id, requestId)
    : undefined
  if (!record) {
    return c.json({ error: 'request not found' }, 404)
  }
  return c.json({ body: record.body })
})

sharedRoutes.get('/api/shared/projects/:token', async (c) => {
  const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
  if (!project) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const listeners = await getListenersByProject(c.env.DB, project.id)
  return c.json({
    label: project.label,
    listeners: listeners.map((l) => ({
      id: l.id,
      label: l.label,
      slug: l.slug,
      createdAt: l.createdAt,
    })),
  })
})

sharedRoutes.get(
  '/api/shared/projects/:token/listeners/:listenerId/requests',
  async (c) => {
    const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
    if (!project) {
      return c.json({ error: 'share link not found' }, 404)
    }
    const listener = await getListener(c.env.DB, c.req.param('listenerId'))
    if (!listener || listener.projectId !== project.id) {
      return c.json({ error: 'listener not found' }, 404)
    }
    const { limit, before } = parsePageParams(
      c.req.query('limit'),
      c.req.query('before'),
    )
    const { requests, nextCursor } = await getRequestsPage(
      c.env.DB,
      listener.id,
      { limit, before },
    )
    return c.json({
      requests: requests.map(serializeRequestListItem),
      nextCursor,
    })
  },
)

sharedRoutes.get(
  '/api/shared/projects/:token/listeners/:listenerId/requests/:requestId/body',
  async (c) => {
    const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
    if (!project) {
      return c.json({ error: 'share link not found' }, 404)
    }
    const listener = await getListener(c.env.DB, c.req.param('listenerId'))
    if (!listener || listener.projectId !== project.id) {
      return c.json({ error: 'listener not found' }, 404)
    }
    const requestId = Number(c.req.param('requestId'))
    const record = Number.isInteger(requestId)
      ? await getRequestById(c.env.DB, listener.id, requestId)
      : undefined
    if (!record) {
      return c.json({ error: 'request not found' }, 404)
    }
    return c.json({ body: record.body })
  },
)

sharedRoutes.post('/api/shared/:token/visit', async (c) => {
  const listener = await getListenerByShareToken(c.env.DB, c.req.param('token'))
  if (!listener) {
    return c.json({ error: 'share link not found' }, 404)
  }
  await recordSharedVisit(
    c.env.DB,
    c.get('email'),
    'listener',
    c.req.param('token'),
    new Date().toISOString(),
  )
  return c.body(null, 204)
})

sharedRoutes.post('/api/shared/projects/:token/visit', async (c) => {
  const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
  if (!project) {
    return c.json({ error: 'share link not found' }, 404)
  }
  await recordSharedVisit(
    c.env.DB,
    c.get('email'),
    'project',
    c.req.param('token'),
    new Date().toISOString(),
  )
  return c.body(null, 204)
})

sharedRoutes.get('/api/shared-with-me', async (c) => {
  const viewerEmail = c.get('email')
  const rows = await listSharedWithMe(c.env.DB, viewerEmail)

  const entries = await Promise.all(
    rows.map(async (row) => {
      if (row.kind === 'listener') {
        const listener = await getListenerByShareToken(c.env.DB, row.token)
        if (!listener || listener.ownerEmail === viewerEmail) return null
        return {
          kind: 'listener' as const,
          token: row.token,
          label: listener.label ?? listener.slug,
          createdAt: listener.createdAt,
          url: `/shared/${row.token}`,
        }
      }
      const project = await getProjectByShareToken(c.env.DB, row.token)
      if (!project || project.ownerEmail === viewerEmail) return null
      return {
        kind: 'project' as const,
        token: row.token,
        label: project.label,
        createdAt: project.createdAt,
        url: `/shared/projects/${row.token}`,
      }
    }),
  )

  return c.json(entries.filter((entry) => entry !== null))
})

sharedRoutes.delete('/api/shared-with-me/:kind/:token', async (c) => {
  const kind = c.req.param('kind')
  if (kind !== 'listener' && kind !== 'project') {
    return c.json({ error: 'kind must be "listener" or "project"' }, 400)
  }
  await removeSharedWithMe(
    c.env.DB,
    c.get('email'),
    kind,
    c.req.param('token'),
    new Date().toISOString(),
  )
  return c.body(null, 204)
})
