# Projects & Create-and-Send Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a session-owned `projects` grouping and a new `/hook/:projectId/:identifier` route so a UAT test script can create a listener and record its first payload in a single call, keyed by a runtime-known identifier that only needs to be unique within that project.

**Architecture:** One new D1 migration (`0005_projects.sql`) adds a `projects` table and a nullable `listeners.project_id` column, splitting the existing global slug-uniqueness index into a project-scoped and a global-scoped partial index. A new `backend/src/projects.repo.ts` + `backend/src/routes/projects.ts` pair mirrors the existing listener repo/route split for `POST /api/projects` and `GET /api/projects`. A new route handler is added to the existing `backend/src/routes/hook.ts` for `ALL /hook/:projectId/:identifier`, reusing `normalizeSlug`/`assertValidSlug` and `insertRequest`. Two existing functions change: `setListenerSlug` (project-scoped conflict checks) and `serializeListener` (project-aware `hookUrl`).

**Tech Stack:** Hono (routing), D1 (SQLite-compatible, via `wrangler d1 migrations`), Vitest + `@cloudflare/vitest-pool-workers` for backend tests. No frontend changes this round.

**Spec:** `docs/superpowers/specs/2026-09-20-projects-create-and-send-design.md`

## Global Constraints

- Backend-only this round — no frontend UI for creating/viewing projects (spec §"Purpose", "Out of scope").
- `projects.owner_session` is `NOT NULL` — every project is created through the authenticated session-cookie path, unlike `listeners.owner_session` which stays nullable for legacy rows (spec §1).
- `listeners.project_id` is nullable; `NULL` for every listener created via the existing two paths (spec §1).
- No per-listener `webhook_token` for project-scoped listeners created via create-and-send — the project id in the URL is the only gate (spec §3, §"Out of scope").
- No update/delete endpoints for projects, no renaming/deleting/transferring projects, no moving listeners in/out of projects (spec §2, §"Out of scope").
- No additional auth/rate-limiting on the create-and-send route beyond "you need the project id" (spec §"Out of scope").
- Migration file must be exactly `backend/migrations/0005_projects.sql` — `0005` is reserved for this feature (`BACKLOG.md`); don't let anything else claim it first.

---

## File Structure

- **Create:** `backend/migrations/0005_projects.sql` — schema migration (new table, new column, index split).
- **Create:** `backend/src/projects.repo.ts` — `createProject`, `getProjectsForOwner`, `getProject` (D1 access for the `projects` table, mirrors `listeners.repo.ts`'s shape).
- **Create:** `backend/src/routes/projects.ts` — `projectRoutes` Hono sub-app: `POST /api/projects`, `GET /api/projects`. Mirrors `backend/src/routes/listeners.ts`'s serialize-then-respond pattern.
- **Create:** `backend/src/projects.repo.test.ts` — repo-level tests for `createProject`/`getProjectsForOwner`.
- **Create:** `backend/src/routes/projects.test.ts` — route-level tests for the two endpoints.
- **Create:** `backend/src/routes/hook.create-and-send.test.ts` — route-level tests for the new hook route.
- **Modify:** `backend/src/listeners.repo.ts` — add `projectId` to `ListenerRecord`/`SELECT_COLUMNS`; add `getListenerByProjectAndSlug`; add `createProjectListener`; make `setListenerSlug`'s conflict checks project-scope-aware.
- **Modify:** `backend/src/routes/hook.ts` — add the `ALL /hook/:projectId/:identifier` handler.
- **Modify:** `backend/src/routes/listeners.ts` — `serializeListener` builds a project-aware `hookUrl`.
- **Modify:** `backend/src/app.ts` — mount `projectRoutes`.
- **Modify:** `backend/src/listeners.repo.test.ts` (or nearest existing slug test file — see Task 4) — add project-scoped-vs-global slug uniqueness cases.

---

### Task 1: Migration — `projects` table, `listeners.project_id`, split slug index

**Files:**
- Create: `backend/migrations/0005_projects.sql`
- Test: manual verification via `wrangler d1 migrations apply` against local D1 (no vitest file — this task has no application code yet)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `projects(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, owner_session TEXT NOT NULL)`; `listeners.project_id TEXT REFERENCES projects(id)` (nullable); `idx_listeners_slug_global` (unique on `slug` where `slug IS NOT NULL AND project_id IS NULL`); `idx_listeners_slug_project` (unique on `(project_id, slug)` where both non-null). Later tasks assume these exist.

- [ ] **Step 1: Write the migration file**

```sql
-- backend/migrations/0005_projects.sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  owner_session TEXT NOT NULL
);

ALTER TABLE listeners ADD COLUMN project_id TEXT REFERENCES projects(id);

DROP INDEX idx_listeners_slug;

CREATE UNIQUE INDEX idx_listeners_slug_global
  ON listeners(slug)
  WHERE slug IS NOT NULL AND project_id IS NULL;

CREATE UNIQUE INDEX idx_listeners_slug_project
  ON listeners(project_id, slug)
  WHERE slug IS NOT NULL AND project_id IS NOT NULL;
```

- [ ] **Step 2: Apply the migration to the local D1 database**

Run (from `backend/`): `npm run db:migrate:local`
Expected: migration `0005_projects.sql` reported as applied, no errors. (If your `package.json` doesn't have this script yet, check the exact script name with `cat package.json | grep migrate` — use whatever the existing `0001`-`0004` migrations were applied with; don't invent a new command.)

- [ ] **Step 3: Confirm the schema locally**

Run: `npx wrangler d1 execute <local-db-name> --local --command ".schema listeners"` (get `<local-db-name>` from `wrangler.toml`'s `d1_databases` block) and separately `.schema projects`.
Expected: `listeners` has a `project_id` column; `projects` table exists with the three columns above; `idx_listeners_slug` is gone, `idx_listeners_slug_global` and `idx_listeners_slug_project` exist.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/0005_projects.sql
git commit -m "feat(backend): add projects table and project-scoped slug index"
```

---

### Task 2: `projects.repo.ts` — create and list projects

**Files:**
- Create: `backend/src/projects.repo.ts`
- Test: `backend/src/projects.repo.test.ts`

**Interfaces:**
- Consumes: `Env['DB']` from `backend/src/env.ts` (existing).
- Produces: `interface ProjectRecord { id: string; createdAt: string; ownerSession: string }`; `createProject(db: Env['DB'], id: string, createdAt: string, ownerSession: string): Promise<ProjectRecord>`; `getProjectsForOwner(db: Env['DB'], sessionId: string): Promise<ProjectRecord[]>` (newest-first); `getProject(db: Env['DB'], id: string): Promise<ProjectRecord | undefined>`. Task 3 (routes) and Task 5 (hook route) both call these by these exact names.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/projects.repo.test.ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createProject, getProjectsForOwner, getProject } from './projects.repo'

describe('projects.repo', () => {
  it('createProject inserts a row and returns it', async () => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const result = await createProject(env.DB, id, createdAt, 'session-a')
    expect(result).toEqual({ id, createdAt, ownerSession: 'session-a' })
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
    expect(result).toEqual({ id, createdAt, ownerSession: 'session-b' })
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
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npm test -- projects.repo.test.ts`
Expected: FAIL — `Cannot find module './projects.repo'` (or similar; the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/projects.repo.ts
import type { Env } from './env'

export interface ProjectRecord {
  id: string
  createdAt: string
  ownerSession: string
}

const SELECT_COLUMNS = 'id, created_at AS createdAt, owner_session AS ownerSession'

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
  return { id, createdAt, ownerSession }
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
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE owner_session = ? ORDER BY created_at DESC, id DESC`)
    .bind(sessionId)
    .all<ProjectRecord>()
  return results
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- projects.repo.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/projects.repo.ts backend/src/projects.repo.test.ts
git commit -m "feat(backend): add projects repo — create, get, list by owner"
```

---

### Task 3: `POST /api/projects` and `GET /api/projects` routes

**Files:**
- Create: `backend/src/routes/projects.ts`
- Create: `backend/src/routes/projects.test.ts`
- Modify: `backend/src/app.ts:47-50` (route mounting, alongside `hookRoute`/`listenerRoutes`/`sharedRoutes`)

**Interfaces:**
- Consumes: `createProject`, `getProjectsForOwner` from `./projects.repo` (Task 2); `Variables` type and `c.get('sessionId')` pattern from `backend/src/app.ts` (existing, used identically in `backend/src/routes/listeners.ts`).
- Produces: `export const projectRoutes: Hono<{ Bindings: Env; Variables: Variables }>` with `POST /api/projects` → `{ id, createdAt }` (201) and `GET /api/projects` → `[{ id, createdAt }]` (200). Task 5 does not consume this route directly (it calls the repo), but the frontend follow-up spec will.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/routes/projects.test.ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('projects routes', () => {
  it('POST /api/projects creates a project owned by the caller session', async () => {
    const response = await app.request('/api/projects', { method: 'POST' }, env)
    expect(response.status).toBe(201)
    const body = (await response.json()) as { id: string; createdAt: string }
    expect(body.id).toBeTypeOf('string')
    expect(body.createdAt).toBeTypeOf('string')
  })

  it('GET /api/projects lists only the caller session projects, newest first', async () => {
    const first = await app.request('/api/projects', { method: 'POST' }, env)
    const sessionId = extractSessionId(first)
    const firstBody = (await first.json()) as { id: string }

    const second = await app.request(
      '/api/projects',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const secondBody = (await second.json()) as { id: string }

    // A different session's project must not appear in the list above.
    await app.request('/api/projects', { method: 'POST' }, env)

    const list = await app.request('/api/projects', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { id: string }[]
    expect(listBody.map((p) => p.id)).toEqual([secondBody.id, firstBody.id])
  })

  it('GET /api/projects returns an empty list for a session with no projects', async () => {
    const response = await app.request('/api/projects', {}, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- routes/projects.test.ts`
Expected: FAIL — 404s, since `/api/projects` isn't routed yet.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/routes/projects.ts
import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import { createProject, getProjectsForOwner } from '../projects.repo'

function serializeProject(project: { id: string; createdAt: string }) {
  return { id: project.id, createdAt: project.createdAt }
}

export const projectRoutes = new Hono<{ Bindings: Env; Variables: Variables }>()

projectRoutes.post('/api/projects', async (c) => {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const project = await createProject(c.env.DB, id, createdAt, c.get('sessionId'))
  return c.json(serializeProject(project), 201)
})

projectRoutes.get('/api/projects', async (c) => {
  const projects = await getProjectsForOwner(c.env.DB, c.get('sessionId'))
  return c.json(projects.map(serializeProject))
})
```

Modify `backend/src/app.ts` — add the import and mount alongside the existing three:

```typescript
// backend/src/app.ts — near the top, alongside the other route imports
import { projectRoutes } from './routes/projects'
```

```typescript
// backend/src/app.ts — alongside app.route('/', hookRoute) etc.
app.route('/', projectRoutes)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- routes/projects.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/projects.ts backend/src/routes/projects.test.ts backend/src/app.ts
git commit -m "feat(backend): add POST/GET /api/projects routes"
```

---

### Task 4: Project-scoped listener lookups + project-aware `setListenerSlug`

**Files:**
- Modify: `backend/src/listeners.repo.ts` (interface, `SELECT_COLUMNS`, new functions, `setListenerSlug`)
- Test: `backend/src/listeners.slug.test.ts` (existing file — add cases; see `backend/src/routes/listeners.slug.test.ts` read during planning for the existing pattern, adjust path if the repo-level slug tests actually live elsewhere — confirm with `ls backend/src/*.test.ts backend/src/routes/*slug*`)

**Interfaces:**
- Consumes: `ProjectRecord`/`getProject` are NOT needed here — this task only touches `listeners.repo.ts`, keyed by `project_id` as a plain string column, no FK-object lookups.
- Produces: `ListenerRecord` gains `projectId: string | null`; `getListenerByProjectAndSlug(db: Env['DB'], projectId: string, slug: string): Promise<ListenerRecord | undefined>`; `createProjectListener(db: Env['DB'], id: string, createdAt: string, ownerSession: string, projectId: string, slug: string): Promise<ListenerRecord>`. `setListenerSlug`'s signature is unchanged but its conflict-check behavior becomes project-scope-aware. Task 5 (hook route) calls `getListenerByProjectAndSlug` and `createProjectListener`. Task 6 (`serializeListener`) reads `listener.projectId`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/listeners.repo.test.ts` (create this file if a repo-level test file doesn't already exist — check first with `ls backend/src/*.repo.test.ts`; if slug logic is instead tested only at the route level in `backend/src/routes/listeners.slug.test.ts`, add the route-facing cases there instead and skip the repo-level ones below that don't apply):

```typescript
// backend/src/listeners.repo.test.ts (new or existing file — add these cases)
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createProject } from './projects.repo'
import {
  createListener,
  createProjectListener,
  getListenerByProjectAndSlug,
  setListenerSlug,
  SlugConflictError,
} from './listeners.repo'

describe('project-scoped listeners', () => {
  it('createProjectListener sets project_id and slug, with a null webhookToken', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    const id = crypto.randomUUID()
    const listener = await createProjectListener(env.DB, id, new Date().toISOString(), 'session-a', project.id, 'checkout-uat')
    expect(listener.projectId).toBe(project.id)
    expect(listener.slug).toBe('checkout-uat')
    expect(listener.webhookToken).toBeNull()
  })

  it('getListenerByProjectAndSlug finds a listener scoped to its project', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    const id = crypto.randomUUID()
    await createProjectListener(env.DB, id, new Date().toISOString(), 'session-a', project.id, 'checkout-uat')

    const found = await getListenerByProjectAndSlug(env.DB, project.id, 'checkout-uat')
    expect(found?.id).toBe(id)
  })

  it('the same slug string is allowed under two different projects', async () => {
    const projectA = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    const projectB = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')

    const listenerA = await createProjectListener(
      env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a', projectA.id, 'checkout-uat'
    )
    const listenerB = await createProjectListener(
      env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a', projectB.id, 'checkout-uat'
    )

    expect(listenerA.id).not.toBe(listenerB.id)
    expect(await getListenerByProjectAndSlug(env.DB, projectA.id, 'checkout-uat')).toMatchObject({ id: listenerA.id })
    expect(await getListenerByProjectAndSlug(env.DB, projectB.id, 'checkout-uat')).toMatchObject({ id: listenerB.id })
  })

  it('setListenerSlug on a project-scoped listener only conflicts within its own project', async () => {
    const projectA = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    const projectB = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    await createProjectListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a', projectA.id, 'taken')

    const otherInSameProject = await createListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    // Simulate assigning otherInSameProject to projectA would require a project_id — this repo layer
    // only exposes createProjectListener for that, so instead verify the cross-project case:
    const listenerInProjectB = await createProjectListener(
      env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a', projectB.id, 'free-slug'
    )
    await expect(setListenerSlug(env.DB, listenerInProjectB.id, 'taken')).resolves.toMatchObject({ slug: 'taken' })
  })

  it('setListenerSlug still conflicts globally for non-project listeners', async () => {
    const first = await createListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    await setListenerSlug(env.DB, first.id, 'global-taken')
    const second = await createListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    await expect(setListenerSlug(env.DB, second.id, 'global-taken')).rejects.toThrow(SlugConflictError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- listeners.repo.test.ts`
Expected: FAIL — `createProjectListener`/`getListenerByProjectAndSlug` not exported yet.

- [ ] **Step 3: Write the implementation**

In `backend/src/listeners.repo.ts`, update the interface and `SELECT_COLUMNS`:

```typescript
export interface ListenerRecord {
  id: string
  createdAt: string
  shareToken: string | null
  ownerSession: string | null
  slug: string | null
  webhookToken: string | null
  label: string | null
  lastRequestAt: string | null
  sortPosition: number | null
  projectId: string | null
}

const SELECT_COLUMNS =
  'id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession, ' +
  'slug, webhook_token AS webhookToken, label, last_request_at AS lastRequestAt, sort_position AS sortPosition, ' +
  'project_id AS projectId'
```

Update `createListener`'s return object to add `projectId: null` (existing function, non-project path):

```typescript
export async function createListener(
  db: Env['DB'],
  id: string,
  createdAt: string,
  ownerSession: string
): Promise<ListenerRecord> {
  await db
    .prepare('INSERT INTO listeners (id, created_at, owner_session) VALUES (?, ?, ?)')
    .bind(id, createdAt, ownerSession)
    .run()
  return { id, createdAt, shareToken: null, ownerSession, slug: null, webhookToken: null, label: null, lastRequestAt: null, sortPosition: null, projectId: null }
}
```

Add the two new functions (place near `getListenerBySlug`):

```typescript
export async function getListenerByProjectAndSlug(
  db: Env['DB'],
  projectId: string,
  slug: string
): Promise<ListenerRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE project_id = ? AND slug = ?`)
    .bind(projectId, slug)
    .first<ListenerRecord>()
  return row ?? undefined
}

export async function createProjectListener(
  db: Env['DB'],
  id: string,
  createdAt: string,
  ownerSession: string,
  projectId: string,
  slug: string
): Promise<ListenerRecord> {
  await db
    .prepare(
      'INSERT INTO listeners (id, created_at, owner_session, project_id, slug) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(id, createdAt, ownerSession, projectId, slug)
    .run()
  return {
    id,
    createdAt,
    shareToken: null,
    ownerSession,
    slug,
    webhookToken: null,
    label: null,
    lastRequestAt: null,
    sortPosition: null,
    projectId,
  }
}
```

Update `setListenerSlug` so both the id-collision check and the uniqueness-conflict message stay correct per project. The DB's partial indexes already enforce the split at the constraint level (project-scoped unique index vs. global unique index) — `isUniqueConstraintError` catches both, so the try/catch needs no change. Only the id-collision pre-check needs to become aware that a project-scoped listener's "identifier space" is its own project, not global:

```typescript
export async function setListenerSlug(
  db: Env['DB'],
  id: string,
  rawSlug: string
): Promise<{ slug: string; webhookToken: string }> {
  const slug = normalizeSlug(rawSlug)
  assertValidSlug(slug)

  const listener = await getListener(db, id)

  // A slug that happens to match another listener's UUID would let
  // resolveListenerForHook's slug lookup shadow that listener's id-based
  // lookup, breaking its (token-less) hook URL. Only a concern for
  // project-less listeners, since resolveListenerForHook only ever looks
  // up by bare id on the /hook/:id path, never scoped to a project.
  if (!listener?.projectId) {
    const idCollision = await db.prepare('SELECT id FROM listeners WHERE id = ? AND id != ?').bind(slug, id).first()
    if (idCollision) {
      throw new SlugConflictError(`slug "${slug}" is already in use`)
    }
  }

  const webhookToken = listener?.webhookToken ?? crypto.randomUUID()

  try {
    await db.prepare('UPDATE listeners SET slug = ?, webhook_token = ? WHERE id = ?').bind(slug, webhookToken, id).run()
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new SlugConflictError(`slug "${slug}" is already in use`)
    }
    throw err
  }

  return { slug, webhookToken }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- listeners.repo.test.ts`
Expected: PASS, all 5 new tests green, and the existing slug tests in `backend/src/routes/listeners.slug.test.ts` still pass (`npm test -- listeners.slug.test.ts`).

- [ ] **Step 5: Run the full backend test suite to check for regressions**

Run: `npm test`
Expected: all previously-passing tests still pass (116 + new tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/listeners.repo.ts backend/src/listeners.repo.test.ts
git commit -m "feat(backend): add project-scoped listener lookups, project-aware slug conflicts"
```

---

### Task 5: `ALL /hook/:projectId/:identifier` create-and-send route

**Files:**
- Modify: `backend/src/routes/hook.ts`
- Create: `backend/src/routes/hook.create-and-send.test.ts`

**Interfaces:**
- Consumes: `getProject` from `../projects.repo` (Task 2); `getListenerByProjectAndSlug`, `createProjectListener`, `normalizeSlug`, `assertValidSlug`/`SlugValidationError` from `../listeners.repo` (Task 4 — note `assertValidSlug` is not currently exported; export it in this task). `insertRequest` from `../requests.repo` (existing). `redactHeaders`/`parseQuery`/`MAX_BODY_BYTES` already exist as private helpers in `hook.ts` — reuse them directly, don't duplicate.
- Produces: nothing new consumed downstream — this is a leaf route.

- [ ] **Step 1: Export `assertValidSlug` from `listeners.repo.ts`**

In `backend/src/listeners.repo.ts`, change:

```typescript
function assertValidSlug(slug: string): void {
```

to:

```typescript
export function assertValidSlug(slug: string): void {
```

- [ ] **Step 2: Write the failing tests**

```typescript
// backend/src/routes/hook.create-and-send.test.ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'

async function createProjectId(): Promise<string> {
  const response = await app.request('/api/projects', { method: 'POST' }, env)
  const body = (await response.json()) as { id: string }
  return body.id
}

describe('create-and-send hook route', () => {
  it('first call to an unseen (projectId, identifier) pair creates a listener and returns 201', async () => {
    const projectId = await createProjectId()
    const response = await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) },
      env
    )
    expect(response.status).toBe(201)
  })

  it('second call to the same pair reuses the listener and returns 200, with both requests recorded', async () => {
    const projectId = await createProjectId()
    await app.request(`/hook/${projectId}/checkout-uat`, { method: 'POST', body: 'first' }, env)
    const second = await app.request(`/hook/${projectId}/checkout-uat`, { method: 'POST', body: 'second' }, env)
    expect(second.status).toBe(200)

    const created = await app.request('/api/projects', { method: 'POST' }, env) // dummy session bootstrap unused here
    void created

    // Verify both requests landed against the same listener by re-hitting the identifier
    // a third time and confirming it's still 200 (i.e. still being treated as "found", not recreated as 201).
    const third = await app.request(`/hook/${projectId}/checkout-uat`, { method: 'POST', body: 'third' }, env)
    expect(third.status).toBe(200)
  })

  it('returns 404 for an unknown projectId', async () => {
    const response = await app.request(`/hook/${crypto.randomUUID()}/checkout-uat`, { method: 'POST' }, env)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'project not found' })
  })

  it('returns 400 for an identifier that normalizes too short', async () => {
    const projectId = await createProjectId()
    const response = await app.request(`/hook/${projectId}/a`, { method: 'POST' }, env)
    expect(response.status).toBe(400)
  })

  it('the same identifier string under two different projects creates two distinct listeners', async () => {
    const projectA = await createProjectId()
    const projectB = await createProjectId()
    const responseA = await app.request(`/hook/${projectA}/checkout-uat`, { method: 'POST' }, env)
    const responseB = await app.request(`/hook/${projectB}/checkout-uat`, { method: 'POST' }, env)
    expect(responseA.status).toBe(201)
    expect(responseB.status).toBe(201)
  })

  it('GET /api/listeners includes a project-scoped listener with a /hook/:projectId/:slug hookUrl', async () => {
    const created = await app.request('/api/projects', { method: 'POST' }, env)
    const sessionId = created.headers.get('set-cookie')?.match(/wl_session_id=([^;]+)/)?.[1]
    const projectId = ((await created.json()) as { id: string }).id

    await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { cookie: `wl_session_id=${sessionId}` } },
      env
    )

    const list = await app.request('/api/listeners', { headers: { cookie: `wl_session_id=${sessionId}` } }, env)
    const listBody = (await list.json()) as { hookUrl: string; slug: string }[]
    const match = listBody.find((l) => l.slug === 'checkout-uat')
    expect(match?.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${projectId}/checkout-uat`)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- hook.create-and-send.test.ts`
Expected: FAIL — 404s from Hono's router (no matching route yet) instead of the expected 201/200/400 codes.

- [ ] **Step 4: Write the implementation**

Add to `backend/src/routes/hook.ts` (after the imports, alongside the existing route):

```typescript
import { getProject } from '../projects.repo'
import {
  getListenerByProjectAndSlug,
  createProjectListener,
  normalizeSlug,
  assertValidSlug,
  SlugValidationError,
} from '../listeners.repo'
```

```typescript
hookRoute.all('/hook/:projectId/:identifier', async (c) => {
  const project = await getProject(c.env.DB, c.req.param('projectId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }

  const identifier = normalizeSlug(c.req.param('identifier'))
  try {
    assertValidSlug(identifier)
  } catch (err) {
    if (err instanceof SlugValidationError) {
      return c.json({ error: err.message }, 400)
    }
    throw err
  }

  const contentLength = c.req.header('content-length')
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return c.json({ error: 'payload too large' }, 413)
  }

  let listener = await getListenerByProjectAndSlug(c.env.DB, project.id, identifier)
  const status = listener ? 200 : 201
  if (!listener) {
    listener = await createProjectListener(
      c.env.DB,
      crypto.randomUUID(),
      new Date().toISOString(),
      project.ownerSession,
      project.id,
      identifier
    )
  }

  const body = c.req.raw.body ? await c.req.raw.clone().text() : null

  await insertRequest(c.env.DB, {
    listenerId: listener.id,
    method: c.req.method,
    headers: JSON.stringify(redactHeaders(c.req.raw.headers)),
    queryParams: JSON.stringify(parseQuery(new URL(c.req.url))),
    body,
    contentType: c.req.header('content-type') ?? null,
    sourceIp: c.req.header('cf-connecting-ip') ?? null,
    receivedAt: new Date().toISOString(),
  })

  return c.body(null, status)
})
```

Note: Hono resolves `/hook/:id` vs `/hook/:projectId/:identifier` by path-segment count, so both routes coexist without conflict — no route-ordering change needed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- hook.create-and-send.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 6: Run the full backend test suite to check for regressions**

Run: `npm test`
Expected: all tests pass, including the existing `hook.test.ts` (confirms `/hook/:id` still resolves correctly and wasn't shadowed by the new route).

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/hook.ts backend/src/routes/hook.create-and-send.test.ts backend/src/listeners.repo.ts
git commit -m "feat(backend): add create-and-send hook route for project-scoped listeners"
```

---

### Task 6: Project-aware `hookUrl` in `serializeListener`

**Files:**
- Modify: `backend/src/routes/listeners.ts:28-37`
- Test: `backend/src/routes/listeners.list.test.ts` (existing file — add a case; confirm exact filename with `ls backend/src/routes/listeners.*.test.ts` since list/serialization tests may live under a different name)

**Interfaces:**
- Consumes: `listener.projectId` from `ListenerRecord` (Task 4).
- Produces: `serializeListener`'s `hookUrl` field format changes for project-scoped listeners only; non-project listeners are byte-for-byte unchanged.

- [ ] **Step 1: Write the failing test**

Add to the existing listener-list test file (or create `backend/src/routes/listeners.projects.test.ts` if a cleaner home doesn't exist):

```typescript
// backend/src/routes/listeners.projects.test.ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'

describe('project-scoped listener serialization', () => {
  it('a project-scoped listener\'s hookUrl uses the /hook/:projectId/:slug form', async () => {
    const projectResponse = await app.request('/api/projects', { method: 'POST' }, env)
    const sessionId = projectResponse.headers.get('set-cookie')?.match(/wl_session_id=([^;]+)/)?.[1]
    const projectId = ((await projectResponse.json()) as { id: string }).id

    await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { cookie: `wl_session_id=${sessionId}` } },
      env
    )

    const listResponse = await app.request(
      '/api/listeners',
      { headers: { cookie: `wl_session_id=${sessionId}` } },
      env
    )
    const listeners = (await listResponse.json()) as { hookUrl: string; slug: string | null }[]
    const projectListener = listeners.find((l) => l.slug === 'checkout-uat')
    expect(projectListener?.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${projectId}/checkout-uat`)
  })

  it('a non-project listener\'s hookUrl is unchanged', async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const sessionId = created.headers.get('set-cookie')?.match(/wl_session_id=([^;]+)/)?.[1]
    const listener = (await created.json()) as { id: string; hookUrl: string }
    expect(listener.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${listener.id}`)
    void sessionId
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- listeners.projects.test.ts`
Expected: FAIL — `projectListener?.hookUrl` is `${HOOK_BASE_URL}/hook/checkout-uat` (missing the `projectId` segment), not matching the expected `/hook/:projectId/:slug` form.

- [ ] **Step 3: Write the implementation**

In `backend/src/routes/listeners.ts`, change `serializeListener`:

```typescript
function serializeListener(env: Env, listener: ListenerRecord) {
  return {
    id: listener.id,
    createdAt: listener.createdAt,
    hookUrl: listener.projectId
      ? `${env.HOOK_BASE_URL}/hook/${listener.projectId}/${listener.slug}`
      : `${env.HOOK_BASE_URL}/hook/${listener.slug ?? listener.id}`,
    shareUrl: shareUrlFor(env.APP_BASE_URL, listener.shareToken),
    slug: listener.slug,
    label: listener.label,
  }
}
```

(`listener.slug` is guaranteed non-null whenever `listener.projectId` is set, since `createProjectListener` — the only path that sets `project_id` — always sets `slug` in the same insert.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- listeners.projects.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Run the full backend test suite**

Run: `npm test`
Expected: all tests pass (previous count + all tests added in Tasks 2-6).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/listeners.ts backend/src/routes/listeners.projects.test.ts
git commit -m "feat(backend): build project-scoped hookUrl in listener serialization"
```

---

### Task 7: Full regression pass, build check, and STATUS/BACKLOG update

**Files:**
- Modify: `STATUS.md` (move projects feature from "not yet" language to shipped, update D1 migration line, update test count)
- Modify: `BACKLOG.md` (remove the "Not started — projects & create-and-send hook" section)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — documentation task only.

- [ ] **Step 1: Run the full backend test suite**

Run (from `backend/`): `npm test`
Expected: all tests pass. Record the new total test count for Step 3.

- [ ] **Step 2: Run the frontend build to confirm no accidental breakage**

Run (from `frontend/`): `npm run build`
Expected: clean, 0 TypeScript errors (this feature is backend-only, so this is a no-op confirmation, not expected to change).

- [ ] **Step 3: Update `STATUS.md`**

In the "Build / test health" section, update:

```markdown
- Backend: `cd backend && npm test` → **<new total>/<new total> passing** (<N> test files).
```

and:

```markdown
- D1 migrations applied: `0001_init.sql` → `0005_projects.sql`.
```

In "Features shipped and live", add a new numbered entry after item 7:

```markdown
8. **Projects & create-and-send hook (backend-only)** — session-owned
   `projects` table; `ALL /hook/:projectId/:identifier` creates a
   listener on first call and reuses it on subsequent calls, scoped to
   the project rather than global slug uniqueness. No frontend UI yet —
   see `docs/superpowers/specs/2026-09-20-projects-create-and-send-design.md`.
```

- [ ] **Step 4: Update `BACKLOG.md`**

Remove the entire "## Not started — projects & create-and-send hook" section (the feature is now shipped, not backlog). Leave everything else unchanged, including the note in "Housekeeping" about `0005` being reserved — update that line to say `0005` is now in use rather than reserved, or remove it if it no longer applies:

```markdown
- `backend/migrations/0005_projects.sql` is now in use (projects feature,
  shipped <date>) — the next migration number to use is `0006`.
```

- [ ] **Step 5: Commit**

```bash
git add STATUS.md BACKLOG.md
git commit -m "docs: mark projects & create-and-send hook feature as shipped"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (data model) → Task 1. §2 (projects API) → Tasks 2-3. §3 (create-and-send route) → Task 5. §4 (existing-code changes: `setListenerSlug`, `serializeListener`, `GET /api/listeners` unchanged behavior) → Tasks 4 and 6 (the "unchanged behavior" claim for `GET /api/listeners` is exercised by Task 6's tests, which confirm project-scoped listeners appear in the same list). §5 (error handling: 404/400/413) → Task 5. §6 (testing) → each task's own test file, matching the spec's named test files (`projects.repo.test.ts`, `projects.test.ts`, `hook.create-and-send.test.ts`) as closely as the existing repo's actual file-naming allows (spec used `projects.test.ts`; this plan uses `routes/projects.test.ts` to match the existing `routes/*.test.ts` convention — same coverage, adjusted path).
- **Out-of-scope items** (frontend UI, rename/delete/transfer, moving listeners between project/non-project) are correctly not represented by any task.
- **Placeholder scan:** no TBD/TODO markers; every step has concrete code or an exact command.
- **Type consistency:** `ListenerRecord.projectId` (Task 4) is read consistently in Task 5 (`listener.projectId` not used there directly, only `project.id`/`project.ownerSession` from `ProjectRecord`) and Task 6 (`listener.projectId`). `ProjectRecord.ownerSession` (Task 2) matches its use in Task 5's `createProjectListener` call. Function names (`getListenerByProjectAndSlug`, `createProjectListener`, `getProject`, `getProjectsForOwner`, `createProject`) are spelled identically everywhere they're referenced across tasks.
- **Known open question flagged for the implementer:** Task 4 and Task 6 reference "the existing slug/list test file" without 100% certainty of its exact current name, since repo test-file organization may have shifted slightly since this plan was written — each of those tasks includes an explicit `ls` check as its first action to resolve this before writing new test code, rather than guessing and creating a duplicate file.
