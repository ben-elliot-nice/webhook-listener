import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createListener,
  createProject,
  listProjects,
  listSharedWithMe,
  listStandaloneListeners,
  removeSharedWithMe,
  reorderItems,
  type Listener,
  type Project,
  type SharedWithMeEntry,
  type SortMode,
} from '../api'
import { usePaginatedList, type ListPage } from '../hooks/usePaginatedList'
import { isPagedSort, moveItem, sortProjects } from '../lib/listPaging'
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
  return SORT_OPTIONS.some((option) => option.value === stored)
    ? (stored as SortMode)
    : 'date'
}

export function Home() {
  const navigate = useNavigate()
  const { width } = useSettings()
  const [error, setError] = useState<string | null>(null)
  const [creatingListener, setCreatingListener] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [sharedWithMe, setSharedWithMe] = useState<SharedWithMeEntry[]>([])
  const [sort, setSort] = useState<SortMode>(loadStoredSort)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<{
    key: string
    before: boolean
  } | null>(null)

  const paged = isPagedSort(sort)

  const fetchStandalone = useCallback(
    async (cursor?: string): Promise<ListPage<Listener>> => {
      const page = await listStandaloneListeners(sort, cursor)
      return {
        items: page.listeners,
        nextCursor: page.nextCursor,
        truncated: page.truncated,
      }
    },
    [sort],
  )

  const {
    items: standalone,
    setItems: setStandalone,
    hasMore,
    truncated,
    loadingMore,
    loadError,
    loadMore,
    retryLoadMore,
    refreshFirstPage,
  } = usePaginatedList(fetchStandalone, paged)

  useEffect(() => {
    refreshFirstPage().catch(() => {
      // Listing is a nice-to-have; a failed fetch must not block the create flow.
    })
  }, [refreshFirstPage])

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch(() => {
        // Same: a failed project fetch must not block the create flow.
      })
  }, [])

  useEffect(() => {
    listSharedWithMe()
      .then(setSharedWithMe)
      .catch(() => {
        // Same as the owned-items list above: a failed fetch is a nice-to-have
        // miss, not a blocker for the rest of Home.
      })
  }, [])

  const sortedProjects = sortProjects(sort, projects)

  // Sort buttons stay put while a sort change reloads (the standalone list is
  // briefly empty); once shown they are not hidden again.
  const [sortVisible, setSortVisible] = useState(false)
  useEffect(() => {
    if (sortedProjects.length > 0 || standalone.length > 0) {
      setSortVisible(true)
    }
  }, [sortedProjects.length, standalone.length])

  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!hasMore) return
    const node = sentinelRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loadMore])

  function handleSortChange(next: SortMode) {
    setSort(next)
    localStorage.setItem(SORT_STORAGE_KEY, next)
  }

  function handleRemoveSharedWithMe(
    kind: 'listener' | 'project',
    token: string,
  ) {
    setSharedWithMe((current) =>
      current.filter(
        (entry) => !(entry.kind === kind && entry.token === token),
      ),
    )
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

  function handleDropProject(targetId: string) {
    const fromId = dragKey?.startsWith('project:')
      ? dragKey.slice('project:'.length)
      : null
    if (!fromId || fromId === targetId) return
    const before =
      dropIndicator?.key === `project:${targetId}` ? dropIndicator.before : true
    const moved = moveItem(sortedProjects, fromId, targetId, before)
    setDragKey(null)
    setDropIndicator(null)
    if (!moved) return

    const previous = projects
    // Custom mode re-sorts by each project's own sortPosition on every render,
    // so stamp the new index onto each item or the drop is sorted away.
    setProjects(moved.map((p, position) => ({ ...p, sortPosition: position })))
    reorderItems(moved.map((p) => ({ type: 'project', id: p.id }))).catch(
      () => {
        setProjects(previous)
        setError('Failed to save the new order.')
      },
    )
  }

  function handleDropListener(targetId: string) {
    const fromId = dragKey?.startsWith('listener:')
      ? dragKey.slice('listener:'.length)
      : null
    if (!fromId || fromId === targetId || truncated) return
    const before =
      dropIndicator?.key === `listener:${targetId}`
        ? dropIndicator.before
        : true
    const moved = moveItem(standalone, fromId, targetId, before)
    setDragKey(null)
    setDropIndicator(null)
    if (!moved) return

    const previous = standalone
    setStandalone(
      moved.map((l, position) => ({ ...l, sortPosition: position })),
    )
    reorderItems(moved.map((l) => ({ type: 'listener', id: l.id }))).catch(
      () => {
        setStandalone(previous)
        setError('Failed to save the new order.')
      },
    )
  }

  function renderProject(project: Project) {
    const key = `project:${project.id}`
    const draggableProject = sort === 'custom'
    return (
      <li
        key={key}
        draggable={draggableProject}
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
        onDragLeave={() =>
          setDropIndicator((current) => (current?.key === key ? null : current))
        }
        onDrop={() => handleDropProject(project.id)}
        className={`flex items-center gap-2 border-t-2 border-b-2 border-transparent ${
          dropIndicator?.key === key
            ? dropIndicator.before
              ? 'border-t-indigo-400 dark:border-t-indigo-500'
              : 'border-b-indigo-400 dark:border-b-indigo-500'
            : ''
        }`}
      >
        {draggableProject && (
          <span
            className="cursor-grab text-slate-400 dark:text-slate-400"
            aria-hidden="true"
          >
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

  function renderListener(listener: Listener) {
    const key = `listener:${listener.id}`
    const draggableListener = sort === 'custom' && !truncated
    const hasNameOrSlug = Boolean(listener.label || listener.slug)
    const primaryText =
      listener.label ||
      listener.slug ||
      new Date(listener.createdAt).toLocaleString()
    return (
      <li
        key={key}
        draggable={draggableListener}
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
        onDragLeave={() =>
          setDropIndicator((current) => (current?.key === key ? null : current))
        }
        onDrop={() => handleDropListener(listener.id)}
        className={`flex items-center gap-2 border-t-2 border-b-2 border-transparent ${
          dropIndicator?.key === key
            ? dropIndicator.before
              ? 'border-t-indigo-400 dark:border-t-indigo-500'
              : 'border-b-indigo-400 dark:border-b-indigo-500'
            : ''
        }`}
      >
        {draggableListener && (
          <span
            className="cursor-grab text-slate-400 dark:text-slate-400"
            aria-hidden="true"
          >
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
            <img
              src="/favicon.png"
              alt=""
              aria-hidden="true"
              draggable={false}
              className="h-4 w-4"
            />
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
  }

  return (
    <main className={`mx-auto px-6 py-10 ${WIDTH_CLASSES[width]}`}>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
        Webhook Listener
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Create a unique URL, send it webhook payloads, and watch them arrive
        here.
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
        <p
          role="alert"
          className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300"
        >
          {error}
        </p>
      )}
      {sortVisible && (
        <div
          className="mb-2 mt-8 flex items-center gap-1"
          role="group"
          aria-label="Sort listeners"
        >
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
      {sortedProjects.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
            Projects
          </h2>
          <ul className="space-y-2">{sortedProjects.map(renderProject)}</ul>
        </section>
      )}
      {standalone.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
            Listeners
          </h2>
          <ul className="space-y-2">{standalone.map(renderListener)}</ul>
          {hasMore && (
            <div ref={sentinelRef} aria-hidden="true" className="h-4" />
          )}
          {loadingMore && (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              Loading more…
            </p>
          )}
          {loadError && (
            <p
              role="alert"
              className="mt-3 text-xs text-rose-600 dark:text-rose-400"
            >
              Failed to load more listeners.{' '}
              <button
                type="button"
                onClick={retryLoadMore}
                className="underline"
              >
                Retry
              </button>
            </p>
          )}
          {truncated && (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              Showing the first 500 listeners — more exist.
              {sort === 'custom' ? ' Reordering is unavailable.' : ''}
            </p>
          )}
        </section>
      )}
      {sharedWithMe.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
            Shared with me
          </h2>
          <ul className="space-y-2">
            {sharedWithMe.map((entry) => (
              <li
                key={`${entry.kind}:${entry.token}`}
                className="flex items-center gap-2"
              >
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
                  onClick={() =>
                    handleRemoveSharedWithMe(entry.kind, entry.token)
                  }
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
