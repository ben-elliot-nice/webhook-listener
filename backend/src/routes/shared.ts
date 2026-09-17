import { Hono } from 'hono'
import type { Env } from '../env'
import { getListenerByShareToken } from '../listeners.repo'
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
