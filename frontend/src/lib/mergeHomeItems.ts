import type { Listener, Project } from '../api'

export type HomeItem = { kind: 'listener'; listener: Listener } | { kind: 'project'; project: Project }

function byCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  return b.createdAt.localeCompare(a.createdAt)
}

function createdAtOf(item: HomeItem): string {
  return item.kind === 'listener' ? item.listener.createdAt : item.project.createdAt
}

// Walks the already-sorted flat listener array (which includes project-scoped
// listeners) once. A project collapses into a single card at the position of
// its best-ranked child — the first of its listeners encountered, since the
// array is already ordered by the active sort criterion. Projects with no
// children yet are returned separately, since they never appear in the array.
function collapseProjectChildren(
  sortedListeners: Listener[],
  projects: Project[]
): { items: HomeItem[]; emptyProjects: Project[] } {
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const items: HomeItem[] = []
  for (const listener of sortedListeners) {
    if (listener.projectId) {
      if (seen.has(listener.projectId)) continue
      const project = projectById.get(listener.projectId)
      if (!project) continue
      seen.add(listener.projectId)
      items.push({ kind: 'project', project })
    } else {
      items.push({ kind: 'listener', listener })
    }
  }
  const emptyProjects = projects.filter((p) => !seen.has(p.id))
  return { items, emptyProjects }
}

// Standard merge of two sequences already sorted by createdAt descending.
function mergeSortedByCreatedAt(items: HomeItem[], emptyProjects: Project[]): HomeItem[] {
  const projectItems: HomeItem[] = [...emptyProjects].sort(byCreatedAtDesc).map((project) => ({
    kind: 'project',
    project,
  }))
  const merged: HomeItem[] = []
  let i = 0
  let j = 0
  while (i < items.length && j < projectItems.length) {
    if (createdAtOf(items[i]) >= createdAtOf(projectItems[j])) {
      merged.push(items[i++])
    } else {
      merged.push(projectItems[j++])
    }
  }
  return [...merged, ...items.slice(i), ...projectItems.slice(j)]
}

export function mergeHomeItemsByDate(sortedListeners: Listener[], projects: Project[]): HomeItem[] {
  const { items, emptyProjects } = collapseProjectChildren(sortedListeners, projects)
  return mergeSortedByCreatedAt(items, emptyProjects)
}

// Mirrors the backend's `name` SQL clause: `(COALESCE(label, slug) IS NULL),
// COALESCE(label, slug) COLLATE NOCASE ASC, created_at DESC` — named items
// first (already correctly ordered by the backend), then a fallback tail of
// unnamed items ordered by createdAt. A project with a named child is already
// positioned correctly by collapseProjectChildren (it inherits its best
// child's rank); an empty project has no name, so it belongs in the fallback
// tail, merged there by createdAt.
export function mergeHomeItemsByName(sortedListeners: Listener[], projects: Project[]): HomeItem[] {
  const { items, emptyProjects } = collapseProjectChildren(sortedListeners, projects)
  if (emptyProjects.length === 0) return items

  const boundary = items.findIndex((item) => item.kind === 'listener' && !(item.listener.label || item.listener.slug))
  if (boundary === -1) {
    return [...items, ...[...emptyProjects].sort(byCreatedAtDesc).map((project) => ({ kind: 'project', project }) as HomeItem)]
  }

  const named = items.slice(0, boundary)
  const unnamedTail = mergeSortedByCreatedAt(items.slice(boundary), emptyProjects)
  return [...named, ...unnamedTail]
}

// The frontend never receives raw `last_request_at` values (only the
// already-sorted order), so there's no way to know which listeners fall in
// the backend's "never received a request" fallback bucket without adding
// that field to the API. Rather than doing that just for this one edge case,
// empty projects are appended after every real item, ordered among
// themselves by createdAt — the same place a never-hit listener would
// roughly land, close enough for a rarely-hit corner of a rarely-used sort
// mode.
export function mergeHomeItemsByActivity(sortedListeners: Listener[], projects: Project[]): HomeItem[] {
  const { items, emptyProjects } = collapseProjectChildren(sortedListeners, projects)
  if (emptyProjects.length === 0) return items
  return [...items, ...[...emptyProjects].sort(byCreatedAtDesc).map((project) => ({ kind: 'project', project }) as HomeItem)]
}

// Custom mode ignores child listeners entirely — every project, empty or
// not, uses its own persisted sortPosition (or createdAt fallback), merged
// against standalone listeners' own sortPosition. Mirrors the backend's
// `(sort_position IS NULL), sort_position ASC, created_at DESC` fallback.
export function mergeHomeItemsByCustom(standaloneListeners: Listener[], projects: Project[]): HomeItem[] {
  const items: HomeItem[] = [
    ...standaloneListeners.map((listener) => ({ kind: 'listener', listener }) as HomeItem),
    ...projects.map((project) => ({ kind: 'project', project }) as HomeItem),
  ]

  function keyOf(item: HomeItem): { sortPosition: number | null; createdAt: string } {
    return item.kind === 'listener'
      ? { sortPosition: item.listener.sortPosition, createdAt: item.listener.createdAt }
      : { sortPosition: item.project.sortPosition, createdAt: item.project.createdAt }
  }

  return [...items].sort((a, b) => {
    const ka = keyOf(a)
    const kb = keyOf(b)
    if (ka.sortPosition === null && kb.sortPosition === null) return kb.createdAt.localeCompare(ka.createdAt)
    if (ka.sortPosition === null) return 1
    if (kb.sortPosition === null) return -1
    return ka.sortPosition - kb.sortPosition
  })
}
