import { Hono } from 'hono'
import type { Env } from '../env'
import { getListenerByShareToken, getListener, getListenersByProject } from '../listeners.repo'
import { getProjectByShareToken } from '../projects.repo'
import { getRequests } from '../requests.repo'

export const sharedRoutes = new Hono<{ Bindings: Env }>()

sharedRoutes.get('/api/shared/:token/requests', async (c) => {
  const listener = await getListenerByShareToken(c.env.DB, c.req.param('token'))
  if (!listener) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const requests = await getRequests(c.env.DB, listener.id)
  return c.json(
    requests.map((r) => ({
      id: r.id,
      method: r.method,
      headers: JSON.parse(r.headers),
      queryParams: JSON.parse(r.queryParams),
      body: r.body,
      contentType: r.contentType,
      sourceIp: r.sourceIp,
      receivedAt: r.receivedAt,
    }))
  )
})

sharedRoutes.get('/api/shared/projects/:token', async (c) => {
  const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
  if (!project) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const listeners = await getListenersByProject(c.env.DB, project.id)
  return c.json(
    listeners.map((l) => ({
      id: l.id,
      label: l.label,
      slug: l.slug,
      createdAt: l.createdAt,
    }))
  )
})

sharedRoutes.get('/api/shared/projects/:token/listeners/:listenerId/requests', async (c) => {
  const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
  if (!project) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const listener = await getListener(c.env.DB, c.req.param('listenerId'))
  if (!listener || listener.projectId !== project.id) {
    return c.json({ error: 'listener not found' }, 404)
  }
  const requests = await getRequests(c.env.DB, listener.id)
  return c.json(
    requests.map((r) => ({
      id: r.id,
      method: r.method,
      headers: JSON.parse(r.headers),
      queryParams: JSON.parse(r.queryParams),
      body: r.body,
      contentType: r.contentType,
      sourceIp: r.sourceIp,
      receivedAt: r.receivedAt,
    }))
  )
})
