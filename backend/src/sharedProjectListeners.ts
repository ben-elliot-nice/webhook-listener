import type { Env } from './env'
import {
  PROJECT_LISTENERS_LIMIT,
  getListenersByProjectSorted,
  type ListenerRecord,
} from './listeners.repo'
import { createTtlCache } from './ttlCache'

interface ProjectListeners {
  listeners: ListenerRecord[]
  hasMore: boolean
}

// In-isolate cache of a shared project's child listeners, keyed by project id.
// Deliberately caches data only (not a Response — session Set-Cookie / CORS
// headers must never be cached) and never caches the share-token lookup, so
// revoking a share link takes effect immediately. Per-isolate, so the hit rate
// is best-effort; staleness is bounded by the TTL.
const cache = createTtlCache<ProjectListeners>({
  ttlMs: 10_000,
  maxEntries: 200,
})

export async function getSharedProjectListeners(
  db: Env['DB'],
  projectId: string,
): Promise<ProjectListeners> {
  const cached = cache.get(projectId)
  if (cached) return cached
  const fresh = await getListenersByProjectSorted(
    db,
    projectId,
    'date',
    PROJECT_LISTENERS_LIMIT,
  )
  cache.set(projectId, fresh)
  return fresh
}

export function clearSharedProjectListenersCache(): void {
  cache.clear()
}
