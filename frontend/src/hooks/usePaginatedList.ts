import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { appendPage, mergeFirstPage } from '../lib/listPaging'

export interface ListPage<T> {
  items: T[]
  nextCursor: string | null
  truncated: boolean
}

export interface UsePaginatedListResult<T> {
  items: T[]
  setItems: Dispatch<SetStateAction<T[]>>
  hasMore: boolean
  truncated: boolean
  loaded: boolean
  loadingMore: boolean
  loadMore: () => Promise<void>
  refreshFirstPage: () => Promise<void>
}

// `paged` = the active sort uses keyset cursors (Date, Recent activity). When
// false the server returns the whole (capped) list in one response, so a
// refresh replaces everything. A new `fetchPage` identity (sort or scope
// changed) drops all loaded rows and ignores results still in flight for the
// previous identity.
export function usePaginatedList<T extends { id: string }>(
  fetchPage: (cursor?: string) => Promise<ListPage<T>>,
  paged: boolean,
): UsePaginatedListResult<T> {
  const [items, setItems] = useState<T[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const generationRef = useRef(0)
  const firstPageEstablishedRef = useRef(false)

  useEffect(() => {
    generationRef.current += 1
    firstPageEstablishedRef.current = false
    setItems([])
    setNextCursor(null)
    setTruncated(false)
    setLoaded(false)
    setLoadingMore(false)
  }, [fetchPage])

  const refreshFirstPage = useCallback(async (): Promise<void> => {
    const generation = generationRef.current
    const page = await fetchPage(undefined)
    if (generation !== generationRef.current) return
    setItems((current) =>
      paged ? mergeFirstPage(current, page.items) : page.items,
    )
    setTruncated(page.truncated)
    // Establish the cursor only on the first successful load; later refreshes
    // of page one must not rewind a user who has scrolled further.
    if (!firstPageEstablishedRef.current) {
      firstPageEstablishedRef.current = true
      setNextCursor(page.nextCursor)
    }
    setLoaded(true)
  }, [fetchPage, paged])

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null || loadingMore) return
    const generation = generationRef.current
    setLoadingMore(true)
    try {
      const page = await fetchPage(nextCursor)
      if (generation !== generationRef.current) return
      setItems((current) => appendPage(current, page.items))
      setNextCursor(page.nextCursor)
    } finally {
      if (generation === generationRef.current) setLoadingMore(false)
    }
  }, [fetchPage, nextCursor, loadingMore])

  return {
    items,
    setItems,
    hasMore: nextCursor !== null,
    truncated,
    loaded,
    loadingMore,
    loadMore,
    refreshFirstPage,
  }
}
