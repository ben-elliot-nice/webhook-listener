import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import {
  createListener,
  getListenerForOwner,
  getListenersForOwner,
  reorderItems,
  type ReorderItem,
  type SortMode,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
  setListenerSlug,
  rotateWebhookToken,
  removeListenerSlug,
  setListenerLabel,
  SlugValidationError,
  SlugConflictError,
  LabelValidationError,
  type ListenerRecord,
} from '../listeners.repo'
import { getRequests } from '../requests.repo'

function shareUrlFor(appBaseUrl: string, shareToken: string | null): string | null {
  return shareToken ? `${appBaseUrl}/shared/${shareToken}` : null
}

function hookUrlFor(env: Env, listener: ListenerRecord): string {
  return listener.projectId && listener.slug
    ? `${env.HOOK_BASE_URL}/hook/${listener.projectId}/${listener.slug}`
    : `${env.HOOK_BASE_URL}/hook/${listener.slug ?? listener.id}`
}

export function serializeListener(env: Env, listener: ListenerRecord) {
  return {
    id: listener.id,
    createdAt: listener.createdAt,
    hookUrl: hookUrlFor(env, listener),
    shareUrl: shareUrlFor(env.APP_BASE_URL, listener.shareToken),
    slug: listener.slug,
    label: listener.label,
    projectId: listener.projectId,
    sortPosition: listener.sortPosition,
  }
}

const LIST_LIMIT = 100

const VALID_SORTS: SortMode[] = ['date', 'name', 'activity', 'custom']

function parseSortMode(raw: string | undefined): SortMode {
  return (VALID_SORTS as string[]).includes(raw ?? '') ? (raw as SortMode) : 'date'
}

export const listenerRoutes = new Hono<{ Bindings: Env; Variables: Variables }>()

listenerRoutes.get('/api/listeners', async (c) => {
  const sort = parseSortMode(c.req.query('sort'))
  const listeners = await getListenersForOwner(c.env.DB, c.get('email'), LIST_LIMIT, sort)
  return c.json(listeners.map((listener) => serializeListener(c.env, listener)))
})

function isReorderItem(value: unknown): value is ReorderItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ReorderItem).id === 'string' &&
    ((value as ReorderItem).type === 'listener' || (value as ReorderItem).type === 'project')
  )
}

listenerRoutes.post('/api/listeners/reorder', async (c) => {
  const body = await c.req.json<{ orderedItems?: unknown }>().catch(() => ({}) as { orderedItems?: unknown })
  if (!Array.isArray(body.orderedItems) || !body.orderedItems.every(isReorderItem)) {
    return c.json({ error: 'orderedItems must be an array of { type, id }' }, 400)
  }

  const ok = await reorderItems(c.env.DB, c.get('email'), body.orderedItems)
  if (!ok) {
    return c.json({ error: 'orderedItems must only contain your own listeners and projects' }, 400)
  }
  return c.body(null, 204)
})

listenerRoutes.post('/api/listeners', async (c) => {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const listener = await createListener(c.env.DB, id, createdAt, c.get('email'))
  return c.json(serializeListener(c.env, listener), 201)
})

listenerRoutes.get('/api/listeners/:id', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  return c.json(serializeListener(c.env, listener))
})

listenerRoutes.get('/api/listeners/:id/requests', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
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
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  await deleteListener(c.env.DB, listener.id)
  return c.body(null, 204)
})

listenerRoutes.post('/api/listeners/:id/share', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  const token = (await getOrCreateShareToken(c.env.DB, listener.id)) as string
  return c.json({ shareToken: token, shareUrl: shareUrlFor(c.env.APP_BASE_URL, token) })
})

listenerRoutes.delete('/api/listeners/:id/share', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  await revokeShareToken(c.env.DB, listener.id)
  return c.body(null, 204)
})

listenerRoutes.put('/api/listeners/:id/slug', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }

  const body = await c.req.json<{ slug?: unknown }>().catch(() => ({}) as { slug?: unknown })
  if (typeof body.slug !== 'string') {
    return c.json({ error: 'slug is required' }, 400)
  }

  try {
    const { slug, webhookToken } = await setListenerSlug(c.env.DB, listener.id, body.slug)
    return c.json({ slug, webhookToken, hookUrl: hookUrlFor(c.env, { ...listener, slug, webhookToken }) })
  } catch (err) {
    if (err instanceof SlugValidationError) {
      return c.json({ error: err.message }, 400)
    }
    if (err instanceof SlugConflictError) {
      return c.json({ error: err.message }, 409)
    }
    throw err
  }
})

listenerRoutes.post('/api/listeners/:id/slug/rotate-token', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }

  const token = await rotateWebhookToken(c.env.DB, listener.id)
  if (!token) {
    return c.json({ error: 'listener has no slug set' }, 400)
  }
  return c.json({ webhookToken: token })
})

listenerRoutes.delete('/api/listeners/:id/slug', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }

  await removeListenerSlug(c.env.DB, listener.id)
  return c.body(null, 204)
})

listenerRoutes.patch('/api/listeners/:id/label', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }

  const body = await c.req.json<{ label?: unknown }>().catch(() => ({}) as { label?: unknown })
  if (typeof body.label !== 'string') {
    return c.json({ error: 'label is required (use an empty string to clear it)' }, 400)
  }

  try {
    const label = await setListenerLabel(c.env.DB, listener.id, body.label)
    return c.json({ label })
  } catch (err) {
    if (err instanceof LabelValidationError) {
      return c.json({ error: err.message }, 400)
    }
    throw err
  }
})
