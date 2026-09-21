import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  deleteProject,
  getOrCreateProjectShareLink,
  listListeners,
  listProjects,
  revokeProjectShareLink,
  setProjectLabel,
  type Listener,
  type Project,
} from '../api'

const POLL_INTERVAL_MS = 3000
const MAX_CONSECUTIVE_NOT_FOUND = 2

export function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<Project | null>(null)
  const [children, setChildren] = useState<Listener[]>([])
  const [notFound, setNotFound] = useState(false)
  const [copied, setCopied] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [editingLabel, setEditingLabel] = useState(false)
  const consecutiveNotFoundRef = useRef(0)

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!projectId) return false
    const [projects, listeners] = await Promise.all([listProjects(), listListeners()])
    const found = projects.find((p) => p.id === projectId)
    if (!found) {
      consecutiveNotFoundRef.current += 1
      if (consecutiveNotFoundRef.current >= MAX_CONSECUTIVE_NOT_FOUND) {
        setNotFound(true)
        return false
      }
      return true
    }
    consecutiveNotFoundRef.current = 0
    setProject(found)
    setChildren(listeners.filter((l) => l.projectId === projectId))
    return true
  }, [projectId])

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

  async function handleCopy() {
    if (!project) return
    try {
      await navigator.clipboard.writeText(project.hookUrlTemplate)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can fail (permissions, insecure context); the URL is
      // still visible in the code block for manual copying.
    }
  }

  async function handleSaveLabel() {
    if (!projectId) return
    try {
      await setProjectLabel(projectId, labelDraft)
      setEditingLabel(false)
      await refresh()
    } catch {
      setError('Failed to save label.')
    }
  }

  async function handleShare() {
    if (!projectId) return
    try {
      await getOrCreateProjectShareLink(projectId)
      await refresh()
    } catch {
      setError('Failed to create share link.')
    }
  }

  async function handleRevokeShare() {
    if (!projectId) return
    if (!window.confirm('Revoke this share link? Anyone using it will lose access.')) return
    try {
      await revokeProjectShareLink(projectId)
      await refresh()
    } catch {
      setError('Failed to revoke share link.')
    }
  }

  async function handleCopyShare() {
    if (!project?.shareUrl) return
    try {
      await navigator.clipboard.writeText(project.shareUrl)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 1500)
    } catch {
      setError('Failed to copy to clipboard.')
    }
  }

  async function handleDelete() {
    if (!projectId) return
    if (!window.confirm('Delete this project and all its listeners and history?')) return
    try {
      await deleteProject(projectId)
      navigate('/')
    } catch {
      setError('Failed to delete project.')
    }
  }

  if (notFound) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm dark:bg-slate-800">
          <p className="text-sm text-slate-500 dark:text-slate-400">Project not found.</p>
          <a href="/" className="mt-4 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            ← Back to listeners
          </a>
        </div>
      </main>
    )
  }

  if (!project) {
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
        <div className="flex items-center justify-between">
          <a href="/" className="mb-4 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            ← Back to listeners
          </a>
          <button
            onClick={handleDelete}
            className="mb-4 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950"
          >
            Delete project
          </button>
        </div>
        {editingLabel ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleSaveLabel()
            }}
            className="flex items-center justify-center gap-2"
          >
            <input
              autoFocus
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              maxLength={100}
              placeholder="Project"
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
              setLabelDraft(project.label ?? '')
              setEditingLabel(true)
            }}
            className="flex items-center justify-center gap-2 text-2xl font-semibold text-slate-900 hover:underline dark:text-slate-100"
            title="Click to rename"
          >
            <span aria-hidden="true">📁</span>
            <span className="truncate">{project.label || project.id}</span>
          </button>
        )}
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-400">
          Created {new Date(project.createdAt).toLocaleString()}
        </p>
        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
          <code className="flex-1 truncate text-sm text-slate-700 dark:text-slate-300">{project.hookUrlTemplate}</code>
          <button
            onClick={handleCopy}
            aria-label="Copy create-and-send URL template"
            className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        <div className="mt-4">
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
            {project.shareUrl ? (
              <>
                <code className="flex-1 truncate text-sm text-slate-700 dark:text-slate-300">{project.shareUrl}</code>
                <button
                  onClick={handleCopyShare}
                  aria-label="Copy share link"
                  className="shrink-0 rounded-md bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  {shareCopied ? 'Copied!' : 'Copy'}
                </button>
                <button
                  onClick={handleRevokeShare}
                  className="shrink-0 rounded-md border border-rose-200 px-3 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950"
                >
                  Revoke share link
                </button>
              </>
            ) : (
              <button
                onClick={handleShare}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
              >
                Get read-only share link
              </button>
            )}
          </div>
        </div>

        {children.length === 0 ? (
          <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">
            No requests yet — point your test script at the URL above (with a real identifier in place of{' '}
            <code>&lt;identifier&gt;</code>) to get started.
          </p>
        ) : (
          <ul className="mb-2 mt-6 space-y-2 text-left">
            {children.map((listener) => {
              const primaryText = listener.label || listener.slug || new Date(listener.createdAt).toLocaleString()
              return (
                <li key={listener.id}>
                  <a
                    href={`/listener/${listener.id}`}
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
