import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import {
  createListener,
  getListenerForOwner,
  getListenersForOwner,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
} from '../listeners.repo'
import { getRequests } from '../requests.repo'

function shareUrlFor(appBaseUrl: string, shareToken: string | null): string | null {
  return shareToken ? `${appBaseUrl}/shared/${shareToken}` : null
}

const LIST_LIMIT = 100

export const listenerRoutes = new Hono<{ Bindings: Env; Variables: Variables }>()

listenerRoutes.get('/api/listeners', async (c) => {
  const listeners = await getListenersForOwner(c.env.DB, c.get('sessionId'), LIST_LIMIT)
  return c.json(
    listeners.map((listener) => ({
      id: listener.id,
      createdAt: listener.createdAt,
      hookUrl: `${c.env.HOOK_BASE_URL}/hook/${listener.id}`,
      shareUrl: shareUrlFor(c.env.APP_BASE_URL, listener.shareToken),
    }))
  )
})

listenerRoutes.post('/api/listeners', async (c) => {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const listener = await createListener(c.env.DB, id, createdAt, c.get('sessionId'))
  return c.json(
    {
      id: listener.id,
      createdAt: listener.createdAt,
      hookUrl: `${c.env.HOOK_BASE_URL}/hook/${listener.id}`,
      shareUrl: shareUrlFor(c.env.APP_BASE_URL, listener.shareToken),
    },
    201
  )
})

listenerRoutes.get('/api/listeners/:id', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  return c.json({
    id: listener.id,
    createdAt: listener.createdAt,
    hookUrl: `${c.env.HOOK_BASE_URL}/hook/${listener.id}`,
    shareUrl: shareUrlFor(c.env.APP_BASE_URL, listener.shareToken),
  })
})

listenerRoutes.get('/api/listeners/:id/requests', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  const requests = await getRequests(c.env.DB, listener.id)
  return c.json(
    requests.map((r) => ({
      ...r,
      headers: JSON.parse(r.headers),
      queryParams: JSON.parse(r.queryParams),
    }))
  )
})

listenerRoutes.delete('/api/listeners/:id', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  await deleteListener(c.env.DB, listener.id)
  return c.body(null, 204)
})

listenerRoutes.post('/api/listeners/:id/share', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  const token = (await getOrCreateShareToken(c.env.DB, listener.id)) as string
  return c.json({ shareToken: token, shareUrl: shareUrlFor(c.env.APP_BASE_URL, token) })
})

listenerRoutes.delete('/api/listeners/:id/share', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  await revokeShareToken(c.env.DB, listener.id)
  return c.body(null, 204)
})
