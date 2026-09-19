import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createListener, listListeners, reorderListeners, type Listener, type SortMode } from '../api'
import { Logo } from '../components/Logo'

const SORT_STORAGE_KEY = 'wl_home_sort'
const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'date', label: 'Date' },
  { value: 'name', label: 'Name' },
  { value: 'activity', label: 'Recent activity' },
  { value: 'custom', label: 'Custom' },
]

function loadStoredSort(): SortMode {
  const stored = localStorage.getItem(SORT_STORAGE_KEY)
  return SORT_OPTIONS.some((option) => option.value === stored) ? (stored as SortMode) : 'date'
}

export function Home() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [listeners, setListeners] = useState<Listener[]>([])
  const [sort, setSort] = useState<SortMode>(loadStoredSort)
  const [dragId, setDragId] = useState<string | null>(null)

  useEffect(() => {
    listListeners(sort)
      .then(setListeners)
      .catch(() => {
        // Listing is a nice-to-have; a failed fetch must not block the create flow.
      })
  }, [sort])

  function handleSortChange(next: SortMode) {
    setSort(next)
    localStorage.setItem(SORT_STORAGE_KEY, next)
  }

  async function handleCreate() {
    setCreating(true)
    setError(null)
    try {
      const listener = await createListener()
      navigate(`/listener/${listener.id}`)
    } catch {
      setError('Failed to create listener. Is the backend running?')
      setCreating(false)
    }
  }

  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) return
    const previous = listeners
    const current = [...listeners]
    const fromIndex = current.findIndex((l) => l.id === dragId)
    const toIndex = current.findIndex((l) => l.id === targetId)
    if (fromIndex === -1 || toIndex === -1) return
    const [moved] = current.splice(fromIndex, 1)
    current.splice(toIndex, 0, moved)
    setListeners(current)
    setDragId(null)
    reorderListeners(current.map((l) => l.id)).catch(() => {
      setListeners(previous)
      setError('Failed to save the new order.')
    })
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm dark:bg-slate-800">
        <div className="flex items-center justify-center gap-2">
          <Logo className="h-7 w-7 text-slate-900 dark:text-slate-100" />
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Webhook Listener</h1>
        </div>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Create a unique URL, send it webhook payloads, and watch them arrive here.
        </p>
        {listeners.length > 0 && (
          <>
            <div className="mb-2 mt-6 flex items-center justify-center gap-1" role="group" aria-label="Sort listeners">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleSortChange(option.value)}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                    sort === option.value
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <ul className="mb-6 space-y-2 text-left">
              {listeners.map((listener) => {
                const hasNameOrSlug = Boolean(listener.label || listener.slug)
                const primaryText = listener.label || listener.slug || new Date(listener.createdAt).toLocaleString()
                return (
                  <li
                    key={listener.id}
                    draggable={sort === 'custom'}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', listener.id)
                      setDragId(listener.id)
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleDrop(listener.id)}
                    className="flex items-center gap-2"
                  >
                    {sort === 'custom' && (
                      <span className="cursor-grab text-slate-400 dark:text-slate-400" aria-hidden="true">
                        ⠿
                      </span>
                    )}
                    <a
                      href={`/listener/${listener.id}`}
                      className="block flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    >
                      <span className="block font-medium">{primaryText}</span>
                      {hasNameOrSlug && (
                        <span className="block text-xs text-slate-400 dark:text-slate-400">
                          {new Date(listener.createdAt).toLocaleString()}
                        </span>
                      )}
                    </a>
                  </li>
                )
              })}
            </ul>
          </>
        )}
        <button
          onClick={handleCreate}
          disabled={creating}
          className="mt-6 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {creating ? 'Creating…' : 'Create new webhook listener'}
        </button>
        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
            {error}
          </p>
        )}
      </div>
    </main>
  )
}
