import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  createProjectListener,
  deleteProject,
  getOrCreateProjectShareLink,
  listListeners,
  listProjects,
  reorderItems,
  revokeProjectShareLink,
  setProjectLabel,
  type Listener,
  type Project,
  type ReorderItem,
  type SortMode,
} from '../api'
import { useSettings } from '../hooks/useSettings'
import { WIDTH_CLASSES } from '../lib/settings'

const POLL_INTERVAL_MS = 3000
const MAX_CONSECUTIVE_NOT_FOUND = 2

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'date', label: 'Date' },
  { value: 'name', label: 'Name' },
  { value: 'activity', label: 'Recent activity' },
  { value: 'custom', label: 'Custom' },
]

function sortStorageKey(projectId: string): string {
  return `wl_project_sort_${projectId}`
}

function loadStoredSort(projectId: string): SortMode {
  const stored = localStorage.getItem(sortStorageKey(projectId))
  return SORT_OPTIONS.some((option) => option.value === stored) ? (stored as SortMode) : 'date'
}

export function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { width } = useSettings()
  const [project, setProject] = useState<Project | null>(null)
  const [children, setChildren] = useState<Listener[]>([])
  const [notFound, setNotFound] = useState(false)
  const [copied, setCopied] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [editingLabel, setEditingLabel] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [sort, setSort] = useState<SortMode>('date')
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<{ key: string; before: boolean } | null>(null)
  const consecutiveNotFoundRef = useRef(0)

  useEffect(() => {
    if (projectId) setSort(loadStoredSort(projectId))
  }, [projectId])

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!projectId) return false
    const [projects, listeners] = await Promise.all([listProjects(), listListeners(sort)])
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
  }, [projectId, sort])

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

  async function handleCreateChild(e: FormEvent) {
    e.preventDefault()
    if (!projectId) return
    try {
      const listener = await createProjectListener(projectId, createDraft)
      setCreateDraft('')
      setError(null)
      navigate(`/listener/${listener.id}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("That identifier's already in use in this project.")
      } else if (err instanceof ApiError && err.status === 400) {
        setError('Identifier must be 3-63 characters after removing invalid characters.')
      } else {
        setError('Failed to create listener.')
      }
    }
  }

  function handleSortChange(next: SortMode) {
    if (!projectId) return
    setSort(next)
    localStorage.setItem(sortStorageKey(projectId), next)
  }

  function handleDrop(targetId: string) {
    if (!dragKey || dragKey === targetId) return
    const before = dropIndicator?.key === targetId ? dropIndicator.before : true
    const previousChildren = children
    const current = [...children]
    const fromIndex = current.findIndex((l) => l.id === dragKey)
    if (fromIndex === -1) return
    const [moved] = current.splice(fromIndex, 1)
    // Recompute the target's index after removal — removing an earlier item
    // shifts every later index down by one, so the target's pre-removal
    // index would silently misplace the drop by one slot.
    const targetIndex = current.findIndex((l) => l.id === targetId)
    if (targetIndex === -1) return
    current.splice(before ? targetIndex : targetIndex + 1, 0, moved)
    setDragKey(null)
    setDropIndicator(null)
    setChildren(current)

    const orderedItems: ReorderItem[] = current.map((l) => ({ type: 'listener', id: l.id }))
    reorderItems(orderedItems).catch(() => {
      setChildren(previousChildren)
      setError('Failed to save the new order.')
    })
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
      <main className={`mx-auto px-6 py-10 ${WIDTH_CLASSES[width]}`}>
        <Link
          to="/"
          className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          ← Back to listeners
        </Link>
        <p className="text-sm text-slate-500 dark:text-slate-400">Project not found.</p>
      </main>
    )
  }

  if (!project) {
    return (
      <main className={`mx-auto px-6 py-10 ${WIDTH_CLASSES[width]}`}>
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      </main>
    )
  }

  return (
    <main className={`mx-auto px-6 py-10 ${WIDTH_CLASSES[width]}`}>
      <div className="mb-4 flex items-center justify-between">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          ← Back to listeners
        </Link>
        <button
          onClick={handleDelete}
          className="rounded-lg border border-rose-200 px-3 py-1.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950"
        >
          Delete project
        </button>
      </div>
      <div className="mb-6 flex items-center gap-2">
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
            className="flex items-center gap-2 text-xl font-semibold text-slate-900 hover:underline dark:text-slate-100"
            title="Click to rename"
          >
            <span aria-hidden="true">📁</span>
            <span className="truncate">{project.label || project.id}</span>
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-6 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </p>
      )}

      <div className="mb-6">
        <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Create-and-send URL template</p>
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <code className="flex-1 truncate text-sm text-slate-700 dark:text-slate-300">{project.hookUrlTemplate}</code>
          <button
            onClick={handleCopy}
            aria-label="Copy create-and-send URL template"
            className="shrink-0 rounded-md bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-400">
          Created {new Date(project.createdAt).toLocaleString()}
        </p>
      </div>

      <div className="mb-6">
        {project.shareUrl && <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Share link (read-only)</p>}
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
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
              className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Get read-only share link
            </button>
          )}
        </div>
      </div>

      <div className="mb-6">
        <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Create a listener now</p>
        <form onSubmit={handleCreateChild} className="flex items-center gap-2">
          <input
            value={createDraft}
            onChange={(e) => setCreateDraft(e.target.value)}
            placeholder="uat-case-42"
            aria-label="New listener identifier"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
          />
          <button
            type="submit"
            className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            Create listener
          </button>
        </form>
      </div>

      {children.length > 0 && (
        <div className="mb-2 flex items-center gap-1" role="group" aria-label="Sort listeners">
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
      )}
      {children.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No requests yet — point your test script at the URL above (with a real identifier in place of{' '}
          <code>&lt;identifier&gt;</code>) to get started.
        </div>
      ) : (
        <ul className="space-y-2">
          {children.map((listener) => {
            const primaryText = listener.label || listener.slug || new Date(listener.createdAt).toLocaleString()
            return (
              <li
                key={listener.id}
                draggable={sort === 'custom'}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', listener.id)
                  setDragKey(listener.id)
                }}
                onDragEnd={() => {
                  setDragKey(null)
                  setDropIndicator(null)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (!dragKey || dragKey === listener.id) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const before = e.clientY < rect.top + rect.height / 2
                  setDropIndicator({ key: listener.id, before })
                }}
                onDragLeave={() => setDropIndicator((current) => (current?.key === listener.id ? null : current))}
                onDrop={() => handleDrop(listener.id)}
                className={`flex items-center gap-2 border-t-2 border-b-2 border-transparent ${
                  dropIndicator?.key === listener.id
                    ? dropIndicator.before
                      ? 'border-t-indigo-400 dark:border-t-indigo-500'
                      : 'border-b-indigo-400 dark:border-b-indigo-500'
                    : ''
                }`}
              >
                {sort === 'custom' && (
                  <span className="cursor-grab text-slate-400 dark:text-slate-400" aria-hidden="true">
                    ⠿
                  </span>
                )}
                <a
                  href={`/listener/${listener.id}`}
                  draggable={false}
                  className="block flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  <span className="flex items-center gap-2 font-medium">
                    <img src="/favicon.png" alt="" aria-hidden="true" draggable={false} className="h-4 w-4" />
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
    </main>
  )
}
