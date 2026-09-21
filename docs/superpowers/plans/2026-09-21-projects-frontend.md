# Projects Frontend UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the frontend UI for projects — create a project, watch listeners spawned by `/hook/:projectId/:identifier` calls appear under it, and merge projects into Home's existing listener list/sort/drag-reorder system.

**Architecture:** Three small, additive backend changes (expose `projectId`/`sortPosition` on listener serialization, `hookUrlTemplate`/`sortPosition` on project serialization, a `sort_position` column on `projects` + a generalized mixed-type reorder endpoint) unlock a purely client-side merge: Home fetches listeners and projects separately and interleaves them via a pure merge function per sort mode; a new `/projects/:id` detail page polls the same two list endpoints and filters to one project's children.

**Tech Stack:** Hono + D1 (backend), React + Vite + react-router-dom + Tailwind (frontend), vitest + `@cloudflare/vitest-pool-workers` (backend tests only — frontend has no test framework).

**Spec:** `docs/superpowers/specs/2026-09-21-projects-frontend-design.md` (and its predecessor `docs/superpowers/specs/2026-09-20-projects-create-and-send-design.md` for the already-shipped backend data model).

## Global Constraints

- Model selection for every superpowers stage in this repo (brainstorming, writing-plans, executing-plans, subagent-driven-development task reviews, whole-change review) must use Sonnet — never Opus or Fable, for any step including reviews.
- Conventional Commits (`feat`, `fix`, `docs`, `chore`, `refactor` + optional scope) for every commit.
- Backend: run `npm test` after every backend task; it must stay green (currently 137/137 passing before this plan starts).
- Frontend: run `npm run build` (`tsc -b && vite build`) after every frontend task; it must stay clean (0 TypeScript errors).
- Frontend has no test framework — frontend tasks are verified by clean build + the manual click-through in Task 8, not automated tests.
- D1 migrations: apply locally (`npm run db:migrate:local`) as part of the task that adds the migration, never applied remotely as part of this plan (deploy is a separate, later step the user controls).

---

### Task 1: `projects` table gains `sort_position`; repo layer updated

**Files:**
- Create: `backend/migrations/0006_projects_sort_position.sql`
- Modify: `backend/src/projects.repo.ts`
- Modify: `backend/src/projects.repo.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ProjectRecord` now has `sortPosition: number | null`. `getProjectsForOwner` orders by `(sort_position IS NULL), sort_position ASC, created_at DESC, id DESC` (same fallback pattern `listeners.repo.ts`'s `custom` sort clause already uses). Later tasks (2, 3) rely on `ProjectRecord.sortPosition` existing.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE projects ADD COLUMN sort_position INTEGER;
```

Save as `backend/migrations/0006_projects_sort_position.sql`.

- [ ] **Step 2: Apply it locally**

Run: `cd backend && npm run db:migrate:local`
Expected: migration `0006_projects_sort_position.sql` applied without error.

- [ ] **Step 3: Write the failing repo tests**

Update `backend/src/projects.repo.test.ts` — the two existing `toEqual` assertions need `sortPosition: null` added (they'll fail once Step 4 changes `SELECT_COLUMNS`), and add a new ordering test:

```ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createProject, getProjectsForOwner, getProject } from './projects.repo'

describe('projects.repo', () => {
  it('createProject inserts a row and returns it', async () => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const result = await createProject(env.DB, id, createdAt, 'session-a')
    expect(result).toEqual({ id, createdAt, ownerSession: 'session-a', sortPosition: null })
  })

  it('getProject returns undefined for an unknown id', async () => {
    const result = await getProject(env.DB, crypto.randomUUID())
    expect(result).toBeUndefined()
  })

  it('getProject returns the row for a known id', async () => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    await createProject(env.DB, id, createdAt, 'session-b')
    const result = await getProject(env.DB, id)
    expect(result).toEqual({ id, createdAt, ownerSession: 'session-b', sortPosition: null })
  })

  it('getProjectsForOwner returns only the caller session, newest first', async () => {
    const sessionId = crypto.randomUUID()
    const first = await createProject(env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', sessionId)
    const second = await createProject(env.DB, crypto.randomUUID(), '2026-01-02T00:00:00.000Z', sessionId)
    await createProject(env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', 'other-session')

    const results = await getProjectsForOwner(env.DB, sessionId)
    expect(results.map((p) => p.id)).toEqual([second.id, first.id])
  })

  it('getProjectsForOwner returns an empty list for a session with no projects', async () => {
    const results = await getProjectsForOwner(env.DB, crypto.randomUUID())
    expect(results).toEqual([])
  })

  it('getProjectsForOwner places a project with a set sort_position before ones without, regardless of created_at', async () => {
    const sessionId = crypto.randomUUID()
    const older = await createProject(env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', sessionId)
    const newer = await createProject(env.DB, crypto.randomUUID(), '2026-01-02T00:00:00.000Z', sessionId)
    // Give the older project an explicit position; the newer one stays unset (null).
    await env.DB.prepare('UPDATE projects SET sort_position = 0 WHERE id = ?').bind(older.id).run()

    const results = await getProjectsForOwner(env.DB, sessionId)
    expect(results.map((p) => p.id)).toEqual([older.id, newer.id])
    expect(results[0].sortPosition).toBe(0)
    expect(results[1].sortPosition).toBeNull()
  })
})
```

- [ ] **Step 4: Run tests to verify the shape-assertion tests fail**

Run: `cd backend && npm test -- projects.repo.test.ts`
Expected: FAIL — `sortPosition` missing from returned objects (the two `toEqual` assertions and the new ordering test fail; the other two pre-existing tests still pass).

- [ ] **Step 5: Update `projects.repo.ts`**

```ts
import type { Env } from './env'

export interface ProjectRecord {
  id: string
  createdAt: string
  ownerSession: string
  sortPosition: number | null
}

const SELECT_COLUMNS = 'id, created_at AS createdAt, owner_session AS ownerSession, sort_position AS sortPosition'

export async function createProject(
  db: Env['DB'],
  id: string,
  createdAt: string,
  ownerSession: string
): Promise<ProjectRecord> {
  await db
    .prepare('INSERT INTO projects (id, created_at, owner_session) VALUES (?, ?, ?)')
    .bind(id, createdAt, ownerSession)
    .run()
  return { id, createdAt, ownerSession, sortPosition: null }
}

export async function getProject(db: Env['DB'], id: string): Promise<ProjectRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`)
    .bind(id)
    .first<ProjectRecord>()
  return row ?? undefined
}

export async function getProjectsForOwner(db: Env['DB'], sessionId: string): Promise<ProjectRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM projects WHERE owner_session = ? ` +
        'ORDER BY (sort_position IS NULL), sort_position ASC, created_at DESC, id DESC'
    )
    .bind(sessionId)
    .all<ProjectRecord>()
  return results
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npm test -- projects.repo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS — no regressions elsewhere (this task didn't touch anything else, but the migration changes the schema every other test's D1 instance is built from).

- [ ] **Step 8: Commit**

```bash
git add backend/migrations/0006_projects_sort_position.sql backend/src/projects.repo.ts backend/src/projects.repo.test.ts
git commit -m "feat(backend): add sort_position column to projects"
```

---

### Task 2: Expose `projectId`/`sortPosition` on listeners and `hookUrlTemplate`/`sortPosition` on projects

**Files:**
- Modify: `backend/src/routes/listeners.ts`
- Modify: `backend/src/routes/projects.ts`
- Modify: `backend/src/routes/listeners.projects.test.ts`
- Modify: `backend/src/routes/projects.test.ts`

**Interfaces:**
- Consumes: `ListenerRecord.projectId`/`ListenerRecord.sortPosition` (already exist on the repo type since migration 0005/0004 — only the route's JSON serialization is missing them). `ProjectRecord.sortPosition` from Task 1.
- Produces: `GET /api/listeners` and `POST /api/listeners` responses gain `projectId: string | null` and `sortPosition: number | null`. `GET /api/projects` and `POST /api/projects` responses gain `hookUrlTemplate: string` and `sortPosition: number | null`. Task 4 (frontend `api.ts`) types against exactly these field names.

- [ ] **Step 1: Write the failing test for listener serialization**

Add to `backend/src/routes/listeners.projects.test.ts` (append a new `it` inside the existing `describe` block):

```ts
  it('serialized listener includes projectId (null for standalone, set for project-scoped)', async () => {
    const standalone = await app.request('/api/listeners', { method: 'POST' }, env)
    const standaloneBody = (await standalone.json()) as { projectId: string | null }
    expect(standaloneBody.projectId).toBeNull()

    const projectResponse = await app.request('/api/projects', { method: 'POST' }, env)
    const sessionId = projectResponse.headers.get('set-cookie')?.match(/wl_session_id=([^;]+)/)?.[1]
    const projectId = ((await projectResponse.json()) as { id: string }).id

    await app.request(
      `/hook/${projectId}/checkout-uat-2`,
      { method: 'POST', headers: { cookie: `wl_session_id=${sessionId}` } },
      env
    )

    const listResponse = await app.request(
      '/api/listeners',
      { headers: { cookie: `wl_session_id=${sessionId}` } },
      env
    )
    const listeners = (await listResponse.json()) as { slug: string | null; projectId: string | null }[]
    const projectListener = listeners.find((l) => l.slug === 'checkout-uat-2')
    expect(projectListener?.projectId).toBe(projectId)
  })
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && npm test -- listeners.projects.test.ts`
Expected: FAIL — `projectId` is `undefined` on both, since `serializeListener` doesn't return it yet.

- [ ] **Step 3: Update `serializeListener`**

In `backend/src/routes/listeners.ts`, change:

```ts
function serializeListener(env: Env, listener: ListenerRecord) {
  return {
    id: listener.id,
    createdAt: listener.createdAt,
    hookUrl: hookUrlFor(env, listener),
    shareUrl: shareUrlFor(env.APP_BASE_URL, listener.shareToken),
    slug: listener.slug,
    label: listener.label,
  }
}
```

to:

```ts
function serializeListener(env: Env, listener: ListenerRecord) {
  return {
    id: listener.id,
    createdAt: listener.createdAt,
    hookUrl: hookUrlFor(env, listener),
    shareUrl: shareUrlFor(env.APP_BASE_URL, listener.shareToken),
    slug: listener.slug,
    label: listener.label,
    projectId: listener.projectId,
    sortPosition: listener.sortPosition,
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `cd backend && npm test -- listeners.projects.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for project serialization**

Add to `backend/src/routes/projects.test.ts` (append a new `it` inside the existing `describe` block):

```ts
  it('serialized project includes hookUrlTemplate and sortPosition', async () => {
    const response = await app.request('/api/projects', { method: 'POST' }, env)
    const body = (await response.json()) as { id: string; hookUrlTemplate: string; sortPosition: number | null }
    expect(body.hookUrlTemplate).toBe(`${env.HOOK_BASE_URL}/hook/${body.id}/<identifier>`)
    expect(body.sortPosition).toBeNull()

    const sessionId = extractSessionId(response)
    const list = await app.request('/api/projects', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    const listBody = (await list.json()) as { id: string; hookUrlTemplate: string }[]
    expect(listBody[0].hookUrlTemplate).toBe(`${env.HOOK_BASE_URL}/hook/${listBody[0].id}/<identifier>`)
  })
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `cd backend && npm test -- projects.test.ts`
Expected: FAIL — `hookUrlTemplate` and `sortPosition` are `undefined`.

- [ ] **Step 7: Update `serializeProject`**

In `backend/src/routes/projects.ts`, change the whole file to:

```ts
import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import { createProject, getProjectsForOwner } from '../projects.repo'

function serializeProject(env: Env, project: { id: string; createdAt: string; sortPosition: number | null }) {
  return {
    id: project.id,
    createdAt: project.createdAt,
    hookUrlTemplate: `${env.HOOK_BASE_URL}/hook/${project.id}/<identifier>`,
    sortPosition: project.sortPosition,
  }
}

export const projectRoutes = new Hono<{ Bindings: Env; Variables: Variables }>()

projectRoutes.post('/api/projects', async (c) => {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const project = await createProject(c.env.DB, id, createdAt, c.get('sessionId'))
  return c.json(serializeProject(c.env, project), 201)
})

projectRoutes.get('/api/projects', async (c) => {
  const projects = await getProjectsForOwner(c.env.DB, c.get('sessionId'))
  return c.json(projects.map((project) => serializeProject(c.env, project)))
})
```

- [ ] **Step 8: Run it to confirm it passes**

Run: `cd backend && npm test -- projects.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add backend/src/routes/listeners.ts backend/src/routes/projects.ts backend/src/routes/listeners.projects.test.ts backend/src/routes/projects.test.ts
git commit -m "feat(backend): expose projectId/sortPosition on listeners, hookUrlTemplate/sortPosition on projects"
```

---

### Task 3: Generalize the reorder endpoint to accept a mixed listener/project order

**Files:**
- Modify: `backend/src/listeners.repo.ts`
- Modify: `backend/src/routes/listeners.ts`
- Modify: `backend/src/routes/listeners.reorder.test.ts`

**Interfaces:**
- Consumes: `Env['DB']`, `sessionId: string`, and the caller's session-owned rows in both `listeners` and `projects`.
- Produces: `reorderItems(db, sessionId, items: ReorderItem[]): Promise<boolean>` replaces `reorderListeners`, where `ReorderItem = { type: 'listener' | 'project'; id: string }`. `POST /api/listeners/reorder` now expects `{ orderedItems: ReorderItem[] }` instead of `{ orderedIds: string[] }` — this is a breaking body-shape change to an endpoint only this monorepo's own frontend calls, so no back-compat shim is needed. Task 4's `reorderItems` API client function calls this with the new shape.

- [ ] **Step 1: Write the failing tests**

Replace the contents of `backend/src/routes/listeners.reorder.test.ts` with:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('POST /api/listeners/reorder', () => {
  let sessionId: string
  let firstId: string
  let secondId: string

  beforeEach(async () => {
    const first = await app.request('/api/listeners', { method: 'POST' }, env)
    sessionId = extractSessionId(first)
    firstId = ((await first.json()) as { id: string }).id
    const second = await app.request(
      '/api/listeners',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    secondId = ((await second.json()) as { id: string }).id
  })

  it('reorders listeners and is reflected in ?sort=custom', async () => {
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({
          orderedItems: [
            { type: 'listener', id: secondId },
            { type: 'listener', id: firstId },
          ],
        }),
      },
      env
    )
    expect(response.status).toBe(204)

    const listResponse = await app.request(
      '/api/listeners?sort=custom',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const body = (await listResponse.json()) as { id: string }[]
    expect(body.map((l) => l.id)).toEqual([secondId, firstId])
  })

  it('reorders a mix of listeners and projects together', async () => {
    const projectResponse = await app.request(
      '/api/projects',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const projectId = ((await projectResponse.json()) as { id: string }).id

    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({
          orderedItems: [
            { type: 'project', id: projectId },
            { type: 'listener', id: firstId },
            { type: 'listener', id: secondId },
          ],
        }),
      },
      env
    )
    expect(response.status).toBe(204)

    const listResponse = await app.request(
      '/api/listeners?sort=custom',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const listBody = (await listResponse.json()) as { id: string }[]
    expect(listBody.map((l) => l.id)).toEqual([firstId, secondId])

    const projectsResponse = await app.request(
      '/api/projects',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const projectsBody = (await projectsResponse.json()) as { id: string; sortPosition: number }[]
    expect(projectsBody[0]).toMatchObject({ id: projectId, sortPosition: 0 })
  })

  it('returns 400 for a listener id belonging to another session', async () => {
    const other = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherId = ((await other.json()) as { id: string }).id
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({
          orderedItems: [
            { type: 'listener', id: firstId },
            { type: 'listener', id: otherId },
          ],
        }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 for a project id belonging to another session', async () => {
    const otherProject = await app.request('/api/projects', { method: 'POST' }, env)
    const otherProjectId = ((await otherProject.json()) as { id: string }).id
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({
          orderedItems: [
            { type: 'listener', id: firstId },
            { type: 'project', id: otherProjectId },
          ],
        }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 for a malformed body', async () => {
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ orderedItems: 'not-an-array' }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 for an item missing a valid type', async () => {
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ orderedItems: [{ type: 'bogus', id: firstId }] }),
      },
      env
    )
    expect(response.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd backend && npm test -- listeners.reorder.test.ts`
Expected: FAIL — the route still expects `orderedIds`, so every request returns 400.

- [ ] **Step 3: Replace `reorderListeners` with `reorderItems` in `listeners.repo.ts`**

In `backend/src/listeners.repo.ts`, replace:

```ts
export async function reorderListeners(db: Env['DB'], sessionId: string, orderedIds: string[]): Promise<boolean> {
  if (orderedIds.length === 0) return false

  const { results } = await db
    .prepare('SELECT id FROM listeners WHERE owner_session = ?')
    .bind(sessionId)
    .all<{ id: string }>()
  const ownedIds = new Set(results.map((r) => r.id))
  if (!orderedIds.every((id) => ownedIds.has(id))) return false

  const statements = orderedIds.map((id, index) =>
    db.prepare('UPDATE listeners SET sort_position = ? WHERE id = ?').bind(index, id)
  )
  await db.batch(statements)
  return true
}
```

with:

```ts
export interface ReorderItem {
  type: 'listener' | 'project'
  id: string
}

export async function reorderItems(db: Env['DB'], sessionId: string, items: ReorderItem[]): Promise<boolean> {
  if (items.length === 0) return false

  const listenerIds = items.filter((item) => item.type === 'listener').map((item) => item.id)
  const projectIds = items.filter((item) => item.type === 'project').map((item) => item.id)

  const [ownedListeners, ownedProjects] = await Promise.all([
    db.prepare('SELECT id FROM listeners WHERE owner_session = ?').bind(sessionId).all<{ id: string }>(),
    db.prepare('SELECT id FROM projects WHERE owner_session = ?').bind(sessionId).all<{ id: string }>(),
  ])
  const ownedListenerIds = new Set(ownedListeners.results.map((r) => r.id))
  const ownedProjectIds = new Set(ownedProjects.results.map((r) => r.id))

  if (!listenerIds.every((id) => ownedListenerIds.has(id))) return false
  if (!projectIds.every((id) => ownedProjectIds.has(id))) return false

  const statements = items.map((item, index) =>
    item.type === 'listener'
      ? db.prepare('UPDATE listeners SET sort_position = ? WHERE id = ?').bind(index, item.id)
      : db.prepare('UPDATE projects SET sort_position = ? WHERE id = ?').bind(index, item.id)
  )
  await db.batch(statements)
  return true
}
```

- [ ] **Step 4: Update the route handler**

In `backend/src/routes/listeners.ts`, change the import line:

```ts
  reorderListeners,
```

to:

```ts
  reorderItems,
  type ReorderItem,
```

and replace the `/api/listeners/reorder` handler:

```ts
listenerRoutes.post('/api/listeners/reorder', async (c) => {
  const body = await c.req.json<{ orderedIds?: unknown }>().catch(() => ({}) as { orderedIds?: unknown })
  if (!Array.isArray(body.orderedIds) || body.orderedIds.some((id) => typeof id !== 'string')) {
    return c.json({ error: 'orderedIds must be an array of strings' }, 400)
  }

  const ok = await reorderListeners(c.env.DB, c.get('sessionId'), body.orderedIds)
  if (!ok) {
    return c.json({ error: 'orderedIds must only contain your own listeners' }, 400)
  }
  return c.body(null, 204)
})
```

with:

```ts
function isReorderItem(value: unknown): value is ReorderItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ReorderItem).id === 'string' &&
    ((value as ReorderItem).type === 'listener' || (value as ReorderItem).type === 'project')
  )
}

listenerRoutes.post('/api/listeners/reorder', async (c) => {
  const body = await c.req.json<{ orderedItems?: unknown }>().catch(() => ({}) as { orderedItems?: unknown })
  if (!Array.isArray(body.orderedItems) || !body.orderedItems.every(isReorderItem)) {
    return c.json({ error: 'orderedItems must be an array of { type, id }' }, 400)
  }

  const ok = await reorderItems(c.env.DB, c.get('sessionId'), body.orderedItems)
  if (!ok) {
    return c.json({ error: 'orderedItems must only contain your own listeners and projects' }, 400)
  }
  return c.body(null, 204)
})
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `cd backend && npm test -- listeners.reorder.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add backend/src/listeners.repo.ts backend/src/routes/listeners.ts backend/src/routes/listeners.reorder.test.ts
git commit -m "feat(backend): generalize reorder endpoint to accept mixed listeners and projects"
```

---

### Task 4: Frontend API client additions (`frontend/src/api.ts`)

**Files:**
- Modify: `frontend/src/api.ts`

**Interfaces:**
- Consumes: the JSON shapes produced by Tasks 2 and 3.
- Produces: `Project` type, `Listener.projectId`/`Listener.sortPosition`, `createProject()`, `listProjects()`, `reorderItems()`. Tasks 5–7 import all of these from `../api`.

- [ ] **Step 1: Add the `Project` type and extend `Listener`**

In `frontend/src/api.ts`, change:

```ts
export interface Listener {
  id: string
  createdAt: string
  hookUrl: string
  shareUrl: string | null
  slug: string | null
  label: string | null
}
```

to:

```ts
export interface Listener {
  id: string
  createdAt: string
  hookUrl: string
  shareUrl: string | null
  slug: string | null
  label: string | null
  projectId: string | null
  sortPosition: number | null
}

export interface Project {
  id: string
  createdAt: string
  hookUrlTemplate: string
  sortPosition: number | null
}

export interface ReorderItem {
  type: 'listener' | 'project'
  id: string
}
```

- [ ] **Step 2: Add `createProject` and `listProjects`**

Add, near `createListener`/`listListeners`:

```ts
export function createProject(): Promise<Project> {
  return fetch(`${API_BASE_URL}/api/projects`, { method: 'POST', credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Project>(r)
  )
}

export function listProjects(): Promise<Project[]> {
  return fetch(`${API_BASE_URL}/api/projects`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Project[]>(r)
  )
}
```

- [ ] **Step 3: Replace `reorderListeners` with `reorderItems`**

Change:

```ts
export async function reorderListeners(orderedIds: string[]): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/listeners/reorder`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}
```

to:

```ts
export async function reorderItems(orderedItems: ReorderItem[]): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/listeners/reorder`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderedItems }),
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}
```

- [ ] **Step 4: Build**

Run: `cd frontend && npm run build`
Expected: FAILS at this point — `Home.tsx` still imports `reorderListeners`, which no longer exists. This is expected; Task 6 fixes it. Confirm the *only* error is the missing `reorderListeners` export/usage in `Home.tsx` (not something else in `api.ts`), then proceed — Task 5 and Task 6 land before the build is expected to pass again.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(frontend): add Project type and projects API client functions"
```

---

### Task 5: Home-item merge logic (`frontend/src/lib/mergeHomeItems.ts`)

**Files:**
- Create: `frontend/src/lib/mergeHomeItems.ts`

**Interfaces:**
- Consumes: `Listener`, `Project` from `../api`.
- Produces: `HomeItem` union type, `mergeHomeItemsByDate`, `mergeHomeItemsByName`, `mergeHomeItemsByActivity`, `mergeHomeItemsByCustom`. Task 6 (`Home.tsx`) imports all four merge functions and the `HomeItem` type.

No automated test for this file — the frontend has no test framework (confirmed: `frontend/package.json` has no test script). Correctness is verified by the manual click-through in Task 8. Keep the logic in this one pure, dependency-free file specifically so it's easy to reason about by reading, since it can't be exercised by a test runner.

- [ ] **Step 1: Write the file**

```ts
import type { Listener, Project } from '../api'

export type HomeItem = { kind: 'listener'; listener: Listener } | { kind: 'project'; project: Project }

function byCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  return b.createdAt.localeCompare(a.createdAt)
}

function createdAtOf(item: HomeItem): string {
  return item.kind === 'listener' ? item.listener.createdAt : item.project.createdAt
}

// Walks the already-sorted flat listener array (which includes project-scoped
// listeners) once. A project collapses into a single card at the position of
// its best-ranked child — the first of its listeners encountered, since the
// array is already ordered by the active sort criterion. Projects with no
// children yet are returned separately, since they never appear in the array.
function collapseProjectChildren(
  sortedListeners: Listener[],
  projects: Project[]
): { items: HomeItem[]; emptyProjects: Project[] } {
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const items: HomeItem[] = []
  for (const listener of sortedListeners) {
    if (listener.projectId) {
      if (seen.has(listener.projectId)) continue
      const project = projectById.get(listener.projectId)
      if (!project) continue
      seen.add(listener.projectId)
      items.push({ kind: 'project', project })
    } else {
      items.push({ kind: 'listener', listener })
    }
  }
  const emptyProjects = projects.filter((p) => !seen.has(p.id))
  return { items, emptyProjects }
}

// Standard merge of two sequences already sorted by createdAt descending.
function mergeSortedByCreatedAt(items: HomeItem[], emptyProjects: Project[]): HomeItem[] {
  const projectItems: HomeItem[] = [...emptyProjects].sort(byCreatedAtDesc).map((project) => ({
    kind: 'project',
    project,
  }))
  const merged: HomeItem[] = []
  let i = 0
  let j = 0
  while (i < items.length && j < projectItems.length) {
    if (createdAtOf(items[i]) >= createdAtOf(projectItems[j])) {
      merged.push(items[i++])
    } else {
      merged.push(projectItems[j++])
    }
  }
  return [...merged, ...items.slice(i), ...projectItems.slice(j)]
}

export function mergeHomeItemsByDate(sortedListeners: Listener[], projects: Project[]): HomeItem[] {
  const { items, emptyProjects } = collapseProjectChildren(sortedListeners, projects)
  return mergeSortedByCreatedAt(items, emptyProjects)
}

// Mirrors the backend's `name` SQL clause: `(COALESCE(label, slug) IS NULL),
// COALESCE(label, slug) COLLATE NOCASE ASC, created_at DESC` — named items
// first (already correctly ordered by the backend), then a fallback tail of
// unnamed items ordered by createdAt. A project with a named child is already
// positioned correctly by collapseProjectChildren (it inherits its best
// child's rank); an empty project has no name, so it belongs in the fallback
// tail, merged there by createdAt.
export function mergeHomeItemsByName(sortedListeners: Listener[], projects: Project[]): HomeItem[] {
  const { items, emptyProjects } = collapseProjectChildren(sortedListeners, projects)
  if (emptyProjects.length === 0) return items

  const boundary = items.findIndex((item) => item.kind === 'listener' && !(item.listener.label || item.listener.slug))
  if (boundary === -1) {
    return [...items, ...[...emptyProjects].sort(byCreatedAtDesc).map((project) => ({ kind: 'project', project }) as HomeItem)]
  }

  const named = items.slice(0, boundary)
  const unnamedTail = mergeSortedByCreatedAt(items.slice(boundary), emptyProjects)
  return [...named, ...unnamedTail]
}

// The frontend never receives raw `last_request_at` values (only the
// already-sorted order), so there's no way to know which listeners fall in
// the backend's "never received a request" fallback bucket without adding
// that field to the API. Rather than doing that just for this one edge case,
// empty projects are appended after every real item, ordered among
// themselves by createdAt — the same place a never-hit listener would
// roughly land, close enough for a rarely-hit corner of a rarely-used sort
// mode.
export function mergeHomeItemsByActivity(sortedListeners: Listener[], projects: Project[]): HomeItem[] {
  const { items, emptyProjects } = collapseProjectChildren(sortedListeners, projects)
  if (emptyProjects.length === 0) return items
  return [...items, ...[...emptyProjects].sort(byCreatedAtDesc).map((project) => ({ kind: 'project', project }) as HomeItem)]
}

// Custom mode ignores child listeners entirely — every project, empty or
// not, uses its own persisted sortPosition (or createdAt fallback), merged
// against standalone listeners' own sortPosition. Mirrors the backend's
// `(sort_position IS NULL), sort_position ASC, created_at DESC` fallback.
export function mergeHomeItemsByCustom(standaloneListeners: Listener[], projects: Project[]): HomeItem[] {
  const items: HomeItem[] = [
    ...standaloneListeners.map((listener) => ({ kind: 'listener', listener }) as HomeItem),
    ...projects.map((project) => ({ kind: 'project', project }) as HomeItem),
  ]

  function keyOf(item: HomeItem): { sortPosition: number | null; createdAt: string } {
    return item.kind === 'listener'
      ? { sortPosition: item.listener.sortPosition, createdAt: item.listener.createdAt }
      : { sortPosition: item.project.sortPosition, createdAt: item.project.createdAt }
  }

  return [...items].sort((a, b) => {
    const ka = keyOf(a)
    const kb = keyOf(b)
    if (ka.sortPosition === null && kb.sortPosition === null) return kb.createdAt.localeCompare(ka.createdAt)
    if (ka.sortPosition === null) return 1
    if (kb.sortPosition === null) return -1
    return ka.sortPosition - kb.sortPosition
  })
}
```

- [ ] **Step 2: Build**

Run: `cd frontend && npm run build`
Expected: still FAILS with the same `Home.tsx`/`reorderListeners` error as Task 4 Step 4 (this new file isn't imported by anything yet) — confirm no *new* errors were introduced by this file itself (e.g. temporarily comment out the rest of `Home.tsx`'s broken import if you need an isolated signal, then revert — or just read the tsc output carefully and confirm every reported error is the pre-existing `Home.tsx` one, not `mergeHomeItems.ts`).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/mergeHomeItems.ts
git commit -m "feat(frontend): add pure merge functions for interleaving projects into Home's listener list"
```

---

### Task 6: Home page — merge in projects, add Create Project button, extend drag-reorder

**Files:**
- Modify: `frontend/src/pages/Home.tsx`

**Interfaces:**
- Consumes: `listListeners`, `listProjects`, `createListener`, `createProject`, `reorderItems` from `../api`; `mergeHomeItemsByDate`, `mergeHomeItemsByName`, `mergeHomeItemsByActivity`, `mergeHomeItemsByCustom`, `type HomeItem` from `../lib/mergeHomeItems`.
- Produces: nothing consumed elsewhere — this is a leaf page component.

- [ ] **Step 1: Replace the full contents of `Home.tsx`**

```tsx
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
```

- [ ] **Step 2: Build**

Run: `cd frontend && npm run build`
Expected: PASS — 0 TypeScript errors. This resolves the expected failures left over from Tasks 4 and 5.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Home.tsx
git commit -m "feat(frontend): merge projects into Home's listener list, add Create Project button"
```

---

### Task 7: Project detail page + route registration

**Files:**
- Create: `frontend/src/pages/ProjectDetail.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `listProjects`, `listListeners`, `type Listener`, `type Project` from `../api`.
- Produces: route `/projects/:projectId`.

- [ ] **Step 1: Write `ProjectDetail.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { listListeners, listProjects, type Listener, type Project } from '../api'

const POLL_INTERVAL_MS = 3000
const MAX_CONSECUTIVE_NOT_FOUND = 2

export function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const [project, setProject] = useState<Project | null>(null)
  const [children, setChildren] = useState<Listener[]>([])
  const [notFound, setNotFound] = useState(false)
  const [copied, setCopied] = useState(false)
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
        <a href="/" className="mb-4 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          ← Back to listeners
        </a>
        <h1 className="flex items-center justify-center gap-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
          <span aria-hidden="true">📁</span>
          <span className="truncate">{project.id}</span>
        </h1>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-400">
          Created {new Date(project.createdAt).toLocaleString()}
        </p>

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
```

- [ ] **Step 2: Register the route**

In `frontend/src/App.tsx`, change:

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'
import { SharedListener } from './pages/SharedListener'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/listener/:id" element={<Listener />} />
          <Route path="/shared/:token" element={<SharedListener />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
```

to:

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'
import { ProjectDetail } from './pages/ProjectDetail'
import { SharedListener } from './pages/SharedListener'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/listener/:id" element={<Listener />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/shared/:token" element={<SharedListener />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
```

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build`
Expected: PASS — 0 TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/ProjectDetail.tsx frontend/src/App.tsx
git commit -m "feat(frontend): add project detail page with polling and create-and-send URL template"
```

---

### Task 8: Manual verification

**Files:** none (verification only — no code changes).

- [ ] **Step 1: Start both dev servers**

Confirm `backend/.dev.vars` exists with the localhost overrides documented in `CLAUDE.md` (`APP_BASE_URL`, `HOOK_BASE_URL`, `SESSION_COOKIE_DOMAIN`); create it first if missing, then:

Run: `cd backend && npm run dev` (in one terminal)
Run: `cd frontend && npm run dev` (in another terminal)

- [ ] **Step 2: Create a project and copy its template**

In the browser at the frontend dev URL: click "Create project", confirm you land on `/projects/:id`, confirm the header shows the project id and created time, click "Copy" on the URL template and confirm it copies a string of the form `http://localhost:8787/hook/<projectId>/<identifier>`.

- [ ] **Step 3: Hit the create-and-send URL and confirm it appears only under the project**

Run (substituting the real project id and any identifier):

```bash
curl -X POST http://localhost:8787/hook/<projectId>/checkout-uat -d '{"ok":true}'
```

Within 3 seconds, confirm the new listener row appears under the project detail page (poll picks it up). Navigate to `/` (Home) and confirm this listener does **not** appear in the flat Home list — only the project card does.

- [ ] **Step 4: Confirm the listener page itself still works for a project-scoped listener**

Click the newly-appeared listener row from the project detail page, confirm it opens `/listener/:id` and shows the captured request (method, body, headers) as normal.

- [ ] **Step 5: Confirm Custom-mode drag works for both a listener and a project**

On Home, create one more standalone listener (via "Create new webhook listener"), switch sort to "Custom", and drag both a listener row and the project's folder row to new positions. Reload the page and confirm the new order persisted (both listeners and the project stayed where you dropped them).

- [ ] **Step 6: Confirm Date/Name/Activity sorts still work and interleave the project sensibly**

Switch through "Date", "Name", "Recent activity" and confirm the app doesn't error and the project card appears in a reasonable position relative to the standalone listener(s) each time (exact position isn't critical to verify precisely — just that nothing crashes and the ordering looks sane, e.g. the most-recently-created item is near the top under Date).

- [ ] **Step 7: Report results**

Note in the PR description (or directly to the user, if not opening a PR yet) which of Steps 2–6 passed, and paste the exact `curl` command and its response status/body from Step 3 as evidence, per this repo's verification-before-completion practice.
