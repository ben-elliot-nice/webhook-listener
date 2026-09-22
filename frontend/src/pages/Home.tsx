import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createListener,
  createProject,
  listListeners,
  listProjects,
  listSharedWithMe,
  removeSharedWithMe,
  reorderItems,
  type Listener,
  type Project,
  type ReorderItem,
  type SharedWithMeEntry,
  type SortMode,
} from '../api'
import {
  mergeHomeItemsByActivity,
  mergeHomeItemsByCustom,
  mergeHomeItemsByDate,
  mergeHomeItemsByName,
  type HomeItem,
} from '../lib/mergeHomeItems'
import { useSettings } from '../hooks/useSettings'
import { WIDTH_CLASSES } from '../lib/settings'
import { setTransparentDragImage } from '../lib/dragImage'

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

function mergeItems(sort: SortMode, listeners: Listener[], projects: Project[]): HomeItem[] {
  if (sort === 'custom') {
    const standalone = listeners.filter((l) => l.projectId === null)
    return mergeHomeItemsByCustom(standalone, projects)
  }
  if (sort === 'name') return mergeHomeItemsByName(listeners, projects)
  if (sort === 'activity') return mergeHomeItemsByActivity(listeners, projects)
  return mergeHomeItemsByDate(listeners, projects)
}

function itemKey(item: HomeItem): string {
  return item.kind === 'listener' ? `listener:${item.listener.id}` : `project:${item.project.id}`
}

function toReorderItem(item: HomeItem): ReorderItem {
  return item.kind === 'listener' ? { type: 'listener', id: item.listener.id } : { type: 'project', id: item.project.id }
}

export function Home() {
  const navigate = useNavigate()
  const { width } = useSettings()
  const [error, setError] = useState<string | null>(null)
  const [creatingListener, setCreatingListener] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [listeners, setListeners] = useState<Listener[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [sharedWithMe, setSharedWithMe] = useState<SharedWithMeEntry[]>([])
  const [sort, setSort] = useState<SortMode>(loadStoredSort)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<{ key: string; before: boolean } | null>(null)

  useEffect(() => {
    Promise.all([listListeners(sort), listProjects()])
      .then(([listenerData, projectData]) => {
        setListeners(listenerData)
        setProjects(projectData)
      })
      .catch(() => {
        // Listing is a nice-to-have; a failed fetch must not block the create flow.
      })
  }, [sort])

  useEffect(() => {
    listSharedWithMe()
      .then(setSharedWithMe)
      .catch(() => {
        // Same as the owned-items list above: a failed fetch is a nice-to-have
        // miss, not a blocker for the rest of Home.
      })
  }, [])

  const items = mergeItems(sort, listeners, projects)

  function handleSortChange(next: SortMode) {
    setSort(next)
    localStorage.setItem(SORT_STORAGE_KEY, next)
  }

  function handleRemoveSharedWithMe(kind: 'listener' | 'project', token: string) {
    setSharedWithMe((current) => current.filter((entry) => !(entry.kind === kind && entry.token === token)))
    removeSharedWithMe(kind, token).catch(() => {
      // Best-effort optimistic removal; a failed DELETE just means the entry
      // reappears on the next Home load, which is an acceptable degradation
      // for a personal declutter action.
    })
  }

  async function handleCreateListener() {
    setCreatingListener(true)
    setError(null)
    try {
      const listener = await createListener()
      navigate(`/listener/${listener.id}`)
    } catch {
      setError('Failed to create listener. Is the backend running?')
      setCreatingListener(false)
    }
  }

  async function handleCreateProject() {
    setCreatingProject(true)
    setError(null)
    try {
      const project = await createProject()
      navigate(`/projects/${project.id}`)
    } catch {
      setError('Failed to create project. Is the backend running?')
      setCreatingProject(false)
    }
  }

  function handleDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey) return
    const before = dropIndicator?.key === targetKey ? dropIndicator.before : true
    const current = [...items]
    const fromIndex = current.findIndex((item) => itemKey(item) === dragKey)
    if (fromIndex === -1) return
    const [moved] = current.splice(fromIndex, 1)
    // Recompute the target's index after removal — removing an earlier item
    // shifts every later index down by one, so the target's pre-removal
    // index would silently misplace the drop by one slot.
    const targetIndex = current.findIndex((item) => itemKey(item) === targetKey)
    if (targetIndex === -1) return
    current.splice(before ? targetIndex : targetIndex + 1, 0, moved)
    setDragKey(null)
    setDropIndicator(null)

    const previousListeners = listeners
    const previousProjects = projects

    // Custom mode re-sorts by each item's own sortPosition field on every
    // render (see mergeHomeItemsByCustom) — it does not trust plain array
    // order. Reordering `current` alone is therefore invisible: the very
    // next render re-sorts everything back using each item's still-stale
    // sortPosition. Stamp every item's sortPosition to its new index in the
    // combined list — the same index reorderItems below persists server-side
    // — so the optimistic update actually reflects the drop instead of being
    // silently re-sorted away.
    //
    // `items`/`current` only ever contain standalone (project-less)
    // listeners in Custom mode — mergeHomeItemsByCustom filters
    // project-scoped ones out before merging — so reconstructing `listeners`
    // state purely from `current` would silently drop every project-scoped
    // listener from state. Preserve them by concatenating the reordered
    // standalone listeners with whatever project-scoped listeners already
    // exist in state, unchanged.
    const projectScopedListeners = listeners.filter((l) => l.projectId !== null)
    const reorderedStandalone: Listener[] = []
    const reorderedProjects: Project[] = []
    current.forEach((item, position) => {
      if (item.kind === 'listener') {
        reorderedStandalone.push({ ...item.listener, sortPosition: position })
      } else {
        reorderedProjects.push({ ...item.project, sortPosition: position })
      }
    })
    setListeners([...reorderedStandalone, ...projectScopedListeners])
    setProjects(reorderedProjects)

    reorderItems(current.map(toReorderItem)).catch(() => {
      setListeners(previousListeners)
      setProjects(previousProjects)
      setError('Failed to save the new order.')
    })
  }

  return (
    <main className={`mx-auto px-6 py-10 ${WIDTH_CLASSES[width]}`}>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Webhook Listener</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Create a unique URL, send it webhook payloads, and watch them arrive here.
      </p>
      <div className="mt-6 flex gap-2">
        <button
          onClick={handleCreateListener}
          disabled={creatingListener}
          className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {creatingListener ? 'Creating…' : 'Create new webhook listener'}
        </button>
        <button
          onClick={handleCreateProject}
          disabled={creatingProject}
          className="rounded-lg bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
        >
          {creatingProject ? 'Creating…' : 'Create project'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </p>
      )}
      {items.length > 0 && (
        <>
          <div className="mb-2 mt-8 flex items-center gap-1" role="group" aria-label="Sort listeners">
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
          <ul className="mb-6 space-y-2">
            {items.map((item) => {
              const key = itemKey(item)
              if (item.kind === 'project') {
                const { project } = item
                return (
                  <li
                    key={key}
                    draggable={sort === 'custom'}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', key)
                      setTransparentDragImage(e)
                      setDragKey(key)
                    }}
                    onDragEnd={() => {
                      setDragKey(null)
                      setDropIndicator(null)
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      if (!dragKey || dragKey === key) return
                      const rect = e.currentTarget.getBoundingClientRect()
                      const before = e.clientY < rect.top + rect.height / 2
                      setDropIndicator({ key, before })
                    }}
                    onDragLeave={() => setDropIndicator((current) => (current?.key === key ? null : current))}
                    onDrop={() => handleDrop(key)}
                    className={`flex items-center gap-2 border-t-2 border-b-2 border-transparent ${
                      dropIndicator?.key === key
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
                      href={`/projects/${project.id}`}
                      draggable={false}
                      className={
                        dragKey === key
                          ? 'block flex-1 rounded-lg border-2 border-dotted border-slate-300 px-4 py-3 text-base opacity-40 dark:border-slate-600'
                          : 'block flex-1 rounded-lg border border-slate-200 bg-white px-4 py-3 text-base text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                      }
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <span aria-hidden="true">📁</span>
                        {project.label || project.id}
                      </span>
                      <span className="block text-xs text-slate-400 dark:text-slate-400">
                        {new Date(project.createdAt).toLocaleString()}
                      </span>
                    </a>
                  </li>
                )
              }

              const { listener } = item
              const hasNameOrSlug = Boolean(listener.label || listener.slug)
              const primaryText = listener.label || listener.slug || new Date(listener.createdAt).toLocaleString()
              return (
                <li
                  key={key}
                  draggable={sort === 'custom'}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', key)
                    setTransparentDragImage(e)
                    setDragKey(key)
                  }}
                  onDragEnd={() => {
                    setDragKey(null)
                    setDropIndicator(null)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (!dragKey || dragKey === key) return
                    const rect = e.currentTarget.getBoundingClientRect()
                    const before = e.clientY < rect.top + rect.height / 2
                    setDropIndicator({ key, before })
                  }}
                  onDragLeave={() => setDropIndicator((current) => (current?.key === key ? null : current))}
                  onDrop={() => handleDrop(key)}
                  className={`flex items-center gap-2 border-t-2 border-b-2 border-transparent ${
                    dropIndicator?.key === key
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
                    className={
                      dragKey === key
                        ? 'block flex-1 rounded-lg border-2 border-dotted border-slate-300 px-3 py-2 text-sm opacity-40 dark:border-slate-600'
                        : 'block flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                    }
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <img src="/favicon.png" alt="" aria-hidden="true" draggable={false} className="h-4 w-4" />
                      {primaryText}
                    </span>
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
      {sharedWithMe.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">Shared with me</h2>
          <ul className="space-y-2">
            {sharedWithMe.map((entry) => (
              <li key={`${entry.kind}:${entry.token}`} className="flex items-center gap-2">
                <a
                  href={entry.url}
                  className="block flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  <span className="flex items-center gap-2 font-medium">
                    <span aria-hidden="true">🔗</span>
                    {entry.label || entry.token}
                  </span>
                  <span className="block text-xs text-slate-400 dark:text-slate-400">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </a>
                <button
                  onClick={() => handleRemoveSharedWithMe(entry.kind, entry.token)}
                  aria-label="Remove from shared with me"
                  className="rounded-md px-2 py-1 text-sm text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  )
}
