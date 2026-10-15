import type { Project, SortMode } from '../api'

// Date and Recent activity load page by page (keyset cursor); Name and Custom
// load everything up to the server's cap and do not poll on a timer.
export function isPagedSort(sort: SortMode): boolean {
  return sort === 'date' || sort === 'activity'
}

// The fresh first page goes first; rows already loaded from later pages (and
// rows pushed out of the first page) keep their relative order after it. Rows
// in the fresh page replace stale copies by id.
export function mergeFirstPage<T extends { id: string }>(
  current: T[],
  firstPage: T[],
): T[] {
  const freshIds = new Set(firstPage.map((item) => item.id))
  return [...firstPage, ...current.filter((item) => !freshIds.has(item.id))]
}

export function appendPage<T extends { id: string }>(
  current: T[],
  page: T[],
): T[] {
  const seen = new Set(current.map((item) => item.id))
  return [...current, ...page.filter((item) => !seen.has(item.id))]
}

// Moves `fromId` next to `targetId` (before or after). Returns null when either
// id is not in the list. The target index is recomputed after removal —
// removing an earlier item shifts every later index down by one.
export function moveItem<T extends { id: string }>(
  list: T[],
  fromId: string,
  targetId: string,
  before: boolean,
): T[] | null {
  const next = [...list]
  const fromIndex = next.findIndex((item) => item.id === fromId)
  if (fromIndex === -1) return null
  const [moved] = next.splice(fromIndex, 1)
  const targetIndex = next.findIndex((item) => item.id === targetId)
  if (targetIndex === -1) return null
  next.splice(before ? targetIndex : targetIndex + 1, 0, moved)
  return next
}

function byCreatedAtDesc(a: Project, b: Project): number {
  return b.createdAt.localeCompare(a.createdAt)
}

// Projects are ordered by their own fields. A project has no activity field of
// its own, so Recent activity falls back to created date.
export function sortProjects(sort: SortMode, projects: Project[]): Project[] {
  const sorted = [...projects]
  if (sort === 'name') {
    return sorted.sort((a, b) => {
      if (a.label === null && b.label === null) return byCreatedAtDesc(a, b)
      if (a.label === null) return 1
      if (b.label === null) return -1
      const byLabel = a.label.localeCompare(b.label, undefined, {
        sensitivity: 'base',
      })
      return byLabel !== 0 ? byLabel : byCreatedAtDesc(a, b)
    })
  }
  if (sort === 'custom') {
    return sorted.sort((a, b) => {
      if (a.sortPosition === null && b.sortPosition === null)
        return byCreatedAtDesc(a, b)
      if (a.sortPosition === null) return 1
      if (b.sortPosition === null) return -1
      const byPosition = a.sortPosition - b.sortPosition
      return byPosition !== 0 ? byPosition : byCreatedAtDesc(a, b)
    })
  }
  return sorted.sort(byCreatedAtDesc)
}

// Guard for automatic (sentinel-driven) loading of the next page. A failed
// load blocks further automatic attempts until the caller explicitly retries.
export function canAutoLoadMore(state: {
  nextCursor: string | null
  loadingMore: boolean
  loadError: boolean
}): boolean {
  return state.nextCursor !== null && !state.loadingMore && !state.loadError
}
