import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  type CapturedRequest,
  type Listener as ListenerModel,
  deleteListener,
  getListener,
  getRequests,
} from '../api'

const POLL_INTERVAL_MS = 3000

function safeParse(body: string | null): unknown {
  if (!body) return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function Listener() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [listener, setListener] = useState<ListenerModel | null>(null)
  const [requests, setRequests] = useState<CapturedRequest[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!id) return false
    try {
      const [listenerData, requestData] = await Promise.all([getListener(id), getRequests(id)])
      setListener(listenerData)
      setRequests(requestData)
      setError(null)
      return true
    } catch {
      setError('Listener not found or unreachable.')
      return false
    }
  }, [id])

  useEffect(() => {
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

  async function handleDelete() {
    if (!id) return
    if (!window.confirm('Delete this listener and all its history?')) return
    await deleteListener(id)
    navigate('/')
  }

  async function handleCopy() {
    if (!listener) return
    await navigator.clipboard.writeText(listener.hookUrl)
  }

  if (error) {
    return <p role="alert">{error}</p>
  }

  if (!listener) {
    return <p>Loading…</p>
  }

  return (
    <main>
      <h1>Listener</h1>
      <p>
        <code>{listener.hookUrl}</code>
        <button onClick={handleCopy}>Copy</button>
      </p>
      <button onClick={handleDelete}>Delete listener</button>

      <ul>
        {requests.map((req) => (
          <li key={req.id}>
            <button onClick={() => setExpandedId(expandedId === req.id ? null : req.id)}>
              {req.method} — {req.receivedAt} — {req.contentType ?? 'no content-type'}
            </button>
            {expandedId === req.id && (
              <pre>
                {JSON.stringify(
                  {
                    headers: req.headers,
                    queryParams: req.queryParams,
                    sourceIp: req.sourceIp,
                    body: safeParse(req.body),
                  },
                  null,
                  2
                )}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </main>
  )
}
