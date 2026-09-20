import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  type CapturedRequest,
  type Listener as ListenerModel,
  deleteListener,
  getListener,
  getOrCreateShareLink,
  getRequests,
  removeSlug,
  revokeShareLink,
  rotateWebhookToken,
  setLabel,
  setSlug,
} from '../api'
import { RequestRow } from '../components/RequestRow'
import { RequestFilters } from '../components/RequestFilters'
import { Logo } from '../components/Logo'
import { ALL, filterRequests, uniqueContentTypes, uniqueMethods, type RequestFilter } from '../lib/filterRequests'
import { downloadFile, toHarExport, toJsonExport } from '../lib/exportRequests'
import { useSettings } from '../hooks/useSettings'
import { WIDTH_CLASSES } from '../lib/settings'

const POLL_INTERVAL_MS = 3000
const MAX_CONSECUTIVE_NOT_FOUND = 2

export function Listener() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { width } = useSettings()
  const [listener, setListener] = useState<ListenerModel | null>(null)
  const [requests, setRequests] = useState<CapturedRequest[]>([])
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const [filter, setFilter] = useState<RequestFilter>({ method: ALL, contentType: ALL, search: '' })
  const [labelDraft, setLabelDraft] = useState('')
  const [editingLabel, setEditingLabel] = useState(false)
  const [slugDraft, setSlugDraft] = useState('')
  const [webhookToken, setWebhookToken] = useState<string | null>(null)
  const [headerCopied, setHeaderCopied] = useState(false)
  const [diffOnly, setDiffOnly] = useState(false)
  const consecutiveNotFoundRef = useRef(0)
  const filteredRequests = useMemo(() => filterRequests(requests, filter), [requests, filter])
  const previousByRequestId = useMemo(() => {
    // `requests` is newest-first, so the chronological predecessor of requests[i] is requests[i + 1]
    const map = new Map<number, CapturedRequest>()
    for (let i = 0; i < requests.length - 1; i++) {
      map.set(requests[i].id, requests[i + 1])
    }
    return map
  }, [requests])

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!id) return false
    try {
      const [listenerData, requestData] = await Promise.all([getListener(id), getRequests(id)])
      setListener(listenerData)
      setRequests(requestData)
      setError(null)
      consecutiveNotFoundRef.current = 0
      return true
    } catch (err) {
      setError('Listener not found or unreachable.')
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
  }, [id])

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

  async function handleDelete() {
    if (!id) return
    if (!window.confirm('Delete this listener and all its history?')) return
    try {
      await deleteListener(id)
      navigate('/')
    } catch {
      setError('Failed to delete listener.')
    }
  }

  async function handleCopy() {
    if (!listener) return
    try {
      await navigator.clipboard.writeText(listener.hookUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Failed to copy to clipboard.')
    }
  }

  async function handleShare() {
    if (!id) return
    try {
      await getOrCreateShareLink(id)
      await refresh()
    } catch {
      setError('Failed to create share link.')
    }
  }

  async function handleRevokeShare() {
    if (!id) return
    if (!window.confirm('Revoke this share link? Anyone using it will lose access.')) return
    try {
      await revokeShareLink(id)
      await refresh()
    } catch {
      setError('Failed to revoke share link.')
    }
  }

  async function handleCopyShare() {
    if (!listener?.shareUrl) return
    try {
      await navigator.clipboard.writeText(listener.shareUrl)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 1500)
    } catch {
      setError('Failed to copy to clipboard.')
    }
  }

  function handleExportJson() {
    if (!id) return
    downloadFile(`webhook-${id}.json`, toJsonExport(filteredRequests), 'application/json')
  }

  function handleExportHar() {
    if (!id || !listener) return
    downloadFile(`webhook-${id}.har`, toHarExport(filteredRequests, listener.hookUrl), 'application/json')
  }

  async function handleSaveLabel() {
    if (!id) return
    try {
      await setLabel(id, labelDraft)
      setEditingLabel(false)
      await refresh()
    } catch {
      setError('Failed to save label.')
    }
  }

  async function handleSetSlug(e: FormEvent) {
    e.preventDefault()
    if (!id) return
    try {
      const result = await setSlug(id, slugDraft)
      setWebhookToken(result.webhookToken)
      setSlugDraft('')
      await refresh()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('That slug is already in use.')
      } else if (err instanceof ApiError && err.status === 400) {
        setError('Slug must be 3-63 characters after removing invalid characters.')
      } else {
        setError('Failed to set slug.')
      }
    }
  }

  async function handleRotateToken() {
    if (!id) return
    if (!window.confirm('Rotate the webhook token? The old token will stop working immediately.')) return
    try {
      const result = await rotateWebhookToken(id)
      setWebhookToken(result.webhookToken)
    } catch {
      setError('Failed to rotate token.')
    }
  }

  async function handleRemoveSlug() {
    if (!id) return
    if (!window.confirm('Remove this slug? The listener will revert to its original UUID hook URL.')) return
    try {
      await removeSlug(id)
      setWebhookToken(null)
      await refresh()
    } catch {
      setError('Failed to remove slug.')
    }
  }

  async function handleCopyHeaderJson() {
    if (!webhookToken) return
    try {
      await navigator.clipboard.writeText(JSON.stringify({ 'X-Webhook-Token': webhookToken }, null, 2))
      setHeaderCopied(true)
      setTimeout(() => setHeaderCopied(false), 1500)
    } catch {
      setError('Failed to copy to clipboard.')
    }
  }

  return (
    <main className={`mx-auto px-6 py-10 ${WIDTH_CLASSES[width]}`}>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Logo className="h-6 w-6 text-slate-900 dark:text-slate-100" />
          {editingLabel ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                handleSaveLabel()
              }}
              className="flex items-center gap-2"
            >
              <input
                autoFocus
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                maxLength={100}
                placeholder="Listener"
                className="rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700"
              />
              <button type="submit" className="text-xs font-medium text-indigo-600">
                Save
              </button>
              <button type="button" onClick={() => setEditingLabel(false)} className="text-xs text-slate-500 dark:text-slate-400">
                Cancel
              </button>
            </form>
          ) : (
            <button
              onClick={() => {
                setLabelDraft(listener?.label ?? '')
                setEditingLabel(true)
              }}
              className="text-xl font-semibold text-slate-900 hover:underline dark:text-slate-100"
              title="Click to rename"
            >
              {listener?.label || 'Listener'}
            </button>
          )}
        </div>
        <button
          onClick={handleDelete}
          className="rounded-lg border border-rose-200 px-3 py-1.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50"
        >
          Delete listener
        </button>
      </div>

      {listener && !listener.slug && (
        <div className="mb-6">
          <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Webhook URL</p>
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <code className="flex-1 truncate text-sm text-slate-700 dark:text-slate-300">{listener.hookUrl}</code>
            <button
              onClick={handleCopy}
              aria-label="Copy webhook URL"
              className="shrink-0 rounded-md bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {listener && (
        <div className="mb-6">
          <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Custom slug</p>
          {listener.slug ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                <code className="flex-1 truncate text-sm text-slate-700 dark:text-slate-300">{listener.hookUrl}</code>
                <button
                  onClick={handleCopy}
                  aria-label="Copy webhook URL"
                  className="shrink-0 rounded-md bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              {webhookToken ? (
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                  <code className="flex-1 truncate text-xs text-amber-900">{`{ "X-Webhook-Token": "${webhookToken}" }`}</code>
                  <button
                    onClick={handleCopyHeaderJson}
                    className="shrink-0 rounded-md bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-200"
                  >
                    {headerCopied ? 'Copied!' : 'Copy header JSON'}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-500 dark:text-slate-400">Token hidden — rotate it to get a fresh one to copy.</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleRotateToken}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  Rotate token
                </button>
                <button
                  onClick={handleRemoveSlug}
                  className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
                >
                  Remove slug
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSetSlug} className="flex items-center gap-2">
              <input
                value={slugDraft}
                onChange={(e) => setSlugDraft(e.target.value)}
                placeholder="my-stripe-hook"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
              />
              <button
                type="submit"
                className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                Set slug
              </button>
            </form>
          )}
        </div>
      )}

      {listener && (
        <div className="mb-6">
          {listener.shareUrl && <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Share link (read-only)</p>}
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            {listener.shareUrl ? (
              <>
                <code className="flex-1 truncate text-sm text-slate-700 dark:text-slate-300">{listener.shareUrl}</code>
                <button
                  onClick={handleCopyShare}
                  aria-label="Copy share link"
                  className="shrink-0 rounded-md bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  {shareCopied ? 'Copied!' : 'Copy'}
                </button>
                <button
                  onClick={handleRevokeShare}
                  className="shrink-0 rounded-md border border-rose-200 px-3 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
                >
                  Revoke share link
                </button>
              </>
            ) : (
              <button
                onClick={handleShare}
                className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                Get share link
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mb-6 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </p>
      )}

      {!listener && !error && (
        <ul className="space-y-2" aria-label="Loading requests">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-12 animate-pulse rounded-lg bg-slate-200" />
          ))}
        </ul>
      )}

      {listener && requests.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No requests yet — send a payload to the URL above.
        </div>
      )}

      {listener && requests.length > 0 && (
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
