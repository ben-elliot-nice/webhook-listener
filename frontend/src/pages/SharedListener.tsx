import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError, type RequestDetail, getSharedRequests } from '../api'
import { RequestRow } from '../components/RequestRow'
import { RequestFilters } from '../components/RequestFilters'
import { ALL, filterRequests, uniqueContentTypes, uniqueMethods, type RequestFilter } from '../lib/filterRequests'
import { downloadFile, toHarExport, toJsonExport } from '../lib/exportRequests'
import { useSettings } from '../hooks/useSettings'
import { WIDTH_CLASSES } from '../lib/settings'

const POLL_INTERVAL_MS = 3000
const MAX_CONSECUTIVE_NOT_FOUND = 2

export function SharedListener() {
  const { token } = useParams<{ token: string }>()
  const { width } = useSettings()
  const [requests, setRequests] = useState<RequestDetail[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<RequestFilter>({ method: ALL, contentType: ALL, search: '' })
  const [diffOnly, setDiffOnly] = useState(false)
  const consecutiveNotFoundRef = useRef(0)
  const filteredRequests = useMemo(() => filterRequests(requests, filter), [requests, filter])
  const previousByRequestId = useMemo(() => {
    const map = new Map<number, RequestDetail>()
    for (let i = 0; i < requests.length - 1; i++) {
      map.set(requests[i].id, requests[i + 1])
    }
    return map
  }, [requests])

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!token) return false
    try {
      const requestData = await getSharedRequests(token)
      setRequests(requestData)
      setLoaded(true)
      setError(null)
      consecutiveNotFoundRef.current = 0
      return true
    } catch (err) {
      setError('Share link not found or revoked.')
      if (err instanceof ApiError && err.status === 404) {
        consecutiveNotFoundRef.current += 1
        if (consecutiveNotFoundRef.current >= MAX_CONSECUTIVE_NOT_FOUND) {
          return false
        }
        return true
      }
      consecutiveNotFoundRef.current = 0
      return true
    }
  }, [token])

  useEffect(() => {
    consecutiveNotFoundRef.current = 0
    let cancelled = false
    const timer = setInterval(async () => {
      const ok = await refresh()
      if (!ok && !cancelled) {
        clearInterval(timer)
      }
    }, POLL_INTERVAL_MS)

    refresh()

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refresh])

  function handleExportJson() {
    if (!token) return
    downloadFile(`webhook-shared-${token}.json`, toJsonExport(filteredRequests), 'application/json')
  }

  function handleExportHar() {
    if (!token) return
    downloadFile(`webhook-shared-${token}.har`, toHarExport(filteredRequests), 'application/json')
  }

  return (
    <main className={`mx-auto px-6 py-10 ${WIDTH_CLASSES[width]}`}>
      <h1 className="mb-6 text-xl font-semibold text-slate-900 dark:text-slate-100">Shared listener (read-only)</h1>

      {error && (
        <p role="alert" className="mb-6 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </p>
      )}

      {!loaded && !error && (
        <ul className="space-y-2" aria-label="Loading requests">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-12 animate-pulse rounded-lg bg-slate-200" />
          ))}
        </ul>
      )}

      {loaded && requests.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No requests yet.
        </div>
      )}

      {loaded && requests.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <RequestFilters
              filter={filter}
              onChange={setFilter}
              methodOptions={uniqueMethods(requests)}
              contentTypeOptions={uniqueContentTypes(requests)}
            />
            <div className="mb-4 flex shrink-0 gap-2">
              <button
                onClick={() => setDiffOnly((v) => !v)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                  diffOnly
                    ? 'border-indigo-600 bg-indigo-600 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300'
                }`}
              >
                Diff only
              </button>
              <button
                onClick={handleExportJson}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                Export JSON
              </button>
              <button
                onClick={handleExportHar}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                Export HAR
              </button>
            </div>
          </div>

          {filteredRequests.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              No requests match your filters.
            </div>
          ) : (
            <ul className="space-y-2">
              {filteredRequests.map((req) => (
                <RequestRow key={req.id} request={req} previousRequest={previousByRequestId.get(req.id)} diffOnly={diffOnly} />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  )
}
