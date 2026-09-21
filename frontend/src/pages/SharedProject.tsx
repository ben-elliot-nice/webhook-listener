import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError, getSharedProject, type SharedProjectListener } from '../api'

const POLL_INTERVAL_MS = 3000
const MAX_CONSECUTIVE_NOT_FOUND = 2

export function SharedProject() {
  const { token } = useParams<{ token: string }>()
  const [listeners, setListeners] = useState<SharedProjectListener[]>([])
  const [loaded, setLoaded] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const consecutiveNotFoundRef = useRef(0)

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!token) return false
    try {
      const data = await getSharedProject(token)
      setListeners(data)
      setLoaded(true)
      consecutiveNotFoundRef.current = 0
      return true
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        consecutiveNotFoundRef.current += 1
        if (consecutiveNotFoundRef.current >= MAX_CONSECUTIVE_NOT_FOUND) {
          setNotFound(true)
          return false
        }
        return true
      }
      consecutiveNotFoundRef.current = 0
      return true
    }
  }, [token])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    async function tick() {
      const shouldContinue = await refresh().catch(() => true)
      if (cancelled || !shouldContinue) return
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [refresh])

  if (notFound) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm dark:bg-slate-800">
          <p className="text-sm text-slate-500 dark:text-slate-400">Share link not found or revoked.</p>
        </div>
      </main>
    )
  }

  if (!loaded) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm dark:bg-slate-800">
          <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm dark:bg-slate-800">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Shared project (read-only)</h1>

        {listeners.length === 0 ? (
          <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">No listeners in this project yet.</p>
        ) : (
          <ul className="mb-2 mt-6 space-y-2 text-left">
            {listeners.map((listener) => {
              const primaryText = listener.label || listener.slug || new Date(listener.createdAt).toLocaleString()
              return (
                <li key={listener.id}>
                  <a
                    href={`/shared/projects/${token}/${listener.id}`}
                    className="block rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <img src="/favicon.png" alt="" aria-hidden="true" className="h-4 w-4" />
                      {primaryText}
                    </span>
                    <span className="block text-xs text-slate-400 dark:text-slate-400">
                      {new Date(listener.createdAt).toLocaleString()}
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </main>
  )
}
