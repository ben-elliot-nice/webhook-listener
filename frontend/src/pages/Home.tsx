import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createListener, listListeners, type Listener } from '../api'

export function Home() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [listeners, setListeners] = useState<Listener[]>([])

  useEffect(() => {
    listListeners()
      .then(setListeners)
      .catch(() => {
        // Listing is a nice-to-have; a failed fetch must not block the create flow.
      })
  }, [])

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

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Webhook Listener</h1>
        <p className="mt-2 text-sm text-slate-500">
          Create a unique URL, send it webhook payloads, and watch them arrive here.
        </p>
        {listeners.length > 0 && (
          <ul className="mb-6 mt-6 space-y-2 text-left">
            {listeners.map((listener) => (
              <li key={listener.id}>
                <a
                  href={`/listener/${listener.id}`}
                  className="block rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  {new Date(listener.createdAt).toLocaleString()}
                </a>
              </li>
            ))}
          </ul>
        )}
        <button
          onClick={handleCreate}
          disabled={creating}
          className="mt-6 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {creating ? 'Creating…' : 'Create new webhook listener'}
        </button>
        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}
      </div>
    </main>
  )
}
