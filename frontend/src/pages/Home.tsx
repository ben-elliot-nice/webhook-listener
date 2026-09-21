import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createListener,
  createProject,
  listListeners,
  listProjects,
  reorderItems,
  type Listener,
  type Project,
  type ReorderItem,
  type SortMode,
} from '../api'
import {
  mergeHomeItemsByActivity,
  mergeHomeItemsByCustom,
  mergeHomeItemsByDate,
  mergeHomeItemsByName,
  type HomeItem,
} from '../lib/mergeHomeItems'

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
  const [error, setError] = useState<string | null>(null)
  const [creatingListener, setCreatingListener] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [listeners, setListeners] = useState<Listener[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [sort, setSort] = useState<SortMode>(loadStoredSort)
  const [dragKey, setDragKey] = useState<string | null>(null)

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

  const items = mergeItems(sort, listeners, projects)

  function handleSortChange(next: SortMode) {
    setSort(next)
    localStorage.setItem(SORT_STORAGE_KEY, next)
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
    const previousItems = items
    const current = [...items]
    const fromIndex = current.findIndex((item) => itemKey(item) === dragKey)
    const toIndex = current.findIndex((item) => itemKey(item) === targetKey)
    if (fromIndex === -1 || toIndex === -1) return
    const [moved] = current.splice(fromIndex, 1)
    current.splice(toIndex, 0, moved)
    setDragKey(null)

    // Optimistically reflect the drop by rebuilding local state from the
    // reordered items, since `items` itself is derived, not stored directly.
    setListeners(
      current.filter((item): item is { kind: 'listener'; listener: Listener } => item.kind === 'listener').map((item) => item.listener)
    )
    setProjects(
      current.filter((item): item is { kind: 'project'; project: Project } => item.kind === 'project').map((item) => item.project)
    )

    reorderItems(current.map(toReorderItem)).catch(() => {
      setListeners(previousItems.filter((item): item is { kind: 'listener'; listener: Listener } => item.kind === 'listener').map((item) => item.listener))
      setProjects(previousItems.filter((item): item is { kind: 'project'; project: Project } => item.kind === 'project').map((item) => item.project))
      setError('Failed to save the new order.')
    })
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm dark:bg-slate-800">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Webhook Listener</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Create a unique URL, send it webhook payloads, and watch them arrive here.
        </p>
        {items.length > 0 && (
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
                        setDragKey(key)
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => handleDrop(key)}
                      className="flex items-center gap-2"
                    >
                      {sort === 'custom' && (
                        <span className="cursor-grab text-slate-400 dark:text-slate-400" aria-hidden="true">
                          ⠿
                        </span>
                      )}
                      <a
                        href={`/projects/${project.id}`}
                        className="block flex-1 rounded-lg border border-slate-200 bg-white px-4 py-3 text-base text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                      >
                        <span className="flex items-center gap-2 font-medium">
                          <span aria-hidden="true">📁</span>
                          {project.id}
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
                      setDragKey(key)
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleDrop(key)}
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
                      <span className="flex items-center gap-2 font-medium">
                        <img src="/favicon.png" alt="" aria-hidden="true" className="h-4 w-4" />
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
        <div className="mt-6 flex gap-2">
          <button
            onClick={handleCreateListener}
            disabled={creatingListener}
            className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
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
      </div>
    </main>
  )
}
