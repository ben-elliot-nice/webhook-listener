import { useCallback, useRef, useState } from 'react'

interface PageResult<T> {
  requests: T[]
  nextCursor: number | null
}

export interface UsePaginatedRequestsResult<T> {
  requests: T[]
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => Promise<void>
  refreshFirstPage: () => Promise<T[]>
}

function mergeById<T extends { id: number }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) {
    byId.set(item.id, item)
  }
  return [...byId.values()].sort((a, b) => b.id - a.id)
}

export function usePaginatedRequests<T extends { id: number }>(
  fetchPage: (before?: number) => Promise<PageResult<T>>
): UsePaginatedRequestsResult<T> {
  const [requests, setRequests] = useState<T[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const firstPageEstablishedRef = useRef(false)

  const refreshFirstPage = useCallback(async (): Promise<T[]> => {
    const page = await fetchPage(undefined)
    setRequests((current) => mergeById(current, page.requests))
    // Establish nextCursor only on the very first successful load.
    // Use a ref to guard against overlapping in-flight calls: if two
    // refreshFirstPage calls are in flight, only the first one to reach
    // this point will establish the cursor.
    if (!firstPageEstablishedRef.current) {
      firstPageEstablishedRef.current = true
      setNextCursor(page.nextCursor)
    }
    return page.requests
  }, [fetchPage])

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await fetchPage(nextCursor)
      setRequests((current) => mergeById(current, page.requests))
      setNextCursor(page.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }, [fetchPage, nextCursor, loadingMore])

  return { requests, hasMore: nextCursor !== null, loadingMore, loadMore, refreshFirstPage }
}
