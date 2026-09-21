# Projects Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add label/rename, share (read-only), delete, manual listener creation,
and child-listener sorting to projects — closing the five gaps identified in
the design spec.

**Architecture:** Mirror every existing listener-level pattern (label,
share-token, delete, sort/reorder) at the project level, reusing shared
validation/error types (`LabelValidationError`, `SlugValidationError`,
`isUniqueConstraintError`) from `listeners.repo.ts` rather than duplicating
them. New shared-project routes never leak the project's own `id` or
`hookUrlTemplate`, since the project id is itself a write-capability token
(per the original create-and-send design).

**Tech Stack:** Hono + D1 (backend), React/Vite/Tailwind (frontend), vitest +
`@cloudflare/vitest-pool-workers` for backend tests. No frontend test
framework exists — frontend verification is `npm run build` plus a manual
click-through.

**Spec:** `docs/superpowers/specs/2026-09-21-projects-management-design.md`

## Global Constraints

- Migration file name: `backend/migrations/0007_projects_label_share.sql` — exact name, next in sequence after `0006_projects_sort_position.sql`.
- Label max length: 100 characters (matches `MAX_LABEL_LENGTH` in `listeners.repo.ts` — reuse the existing `LabelValidationError` class, don't redefine it).
- Slug validation: reuse `normalizeSlug`/`assertValidSlug`/`SlugValidationError`/`isUniqueConstraintError` from `listeners.repo.ts` unchanged — no new slug rules.
- Manual-create conflict status: **409**, not the auto-create hook route's idempotent 200/201 reuse — this is a deliberate action, not idempotent.
- Shared-project response shape must never include the project's `id` or `hookUrlTemplate`, and a listener entry within it must never include `hookUrl`. This is the trust-model requirement from spec §3 — get it wrong and a "read-only" share link grants write access to spawn listeners.
- `deleteProject` must delete child listeners before the project row (FK enforcement is on — see spec §1) — both statements in one `db.batch()`.
- Every new backend error shape matches the exact status codes in spec §6: 404 project-not-found/token-not-found, 400 validation, 409 slug conflict. No new shapes.
- Run backend tests (`cd backend && npm test`) after every backend task; run `cd frontend && npm run build` after every frontend task.

---

## Task 1: `projects.repo.ts` — label, share-token, owner-scoped lookup, delete

**Files:**
- Modify: `backend/migrations/0007_projects_label_share.sql` (create)
- Modify: `backend/src/projects.repo.ts`
- Test: `backend/src/projects.repo.test.ts`

**Interfaces:**
- Consumes: `LabelValidationError` from `../listeners.repo` (already defined there).
- Produces: `ProjectRecord` now has `label: string | null` and `shareToken: string | null`. New exports: `getProjectForOwner(db, id, sessionId): Promise<ProjectRecord | undefined>`, `setProjectLabel(db, id, rawLabel): Promise<string | null>` (throws `LabelValidationError`), `getOrCreateProjectShareToken(db, id): Promise<string | undefined>`, `revokeProjectShareToken(db, id): Promise<boolean>`, `getProjectByShareToken(db, token): Promise<ProjectRecord | undefined>`, `deleteProject(db, id): Promise<boolean>`. Later tasks (2, 4) import all of these.

- [ ] **Step 1: Write the migration**

Create `backend/migrations/0007_projects_label_share.sql`:

```sql
ALTER TABLE projects ADD COLUMN label TEXT;
ALTER TABLE projects ADD COLUMN share_token TEXT;

CREATE UNIQUE INDEX idx_projects_share_token
  ON projects(share_token)
  WHERE share_token IS NOT NULL;
```

- [ ] **Step 2: Apply the migration locally**

Run: `cd backend && npm run db:migrate:local`
Expected: applies `0007_projects_label_share.sql` with no errors (Miniflare-local D1).

- [ ] **Step 3: Write the failing repo tests**

Append to `backend/src/projects.repo.test.ts` (add these `it` blocks inside the existing `describe('projects.repo', ...)`, and add the new imports at the top):

```ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import {
  createProject,
  getProjectsForOwner,
  getProject,
  getProjectForOwner,
  setProjectLabel,
  getOrCreateProjectShareToken,
  revokeProjectShareToken,
  getProjectByShareToken,
  deleteProject,
} from './projects.repo'
import { LabelValidationError } from './listeners.repo'
import { createProjectListener } from './listeners.repo'
```

```ts
  it('createProject returns a record with label and shareToken null', async () => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const result = await createProject(env.DB, id, createdAt, 'session-label')
    expect(result).toEqual({ id, createdAt, ownerSession: 'session-label', sortPosition: null, label: null, shareToken: null })
  })

  it('getProjectForOwner returns the project for the owning session', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'owner-session')
    const result = await getProjectForOwner(env.DB, project.id, 'owner-session')
    expect(result?.id).toBe(project.id)
  })

  it('getProjectForOwner returns undefined for a different session', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'owner-session-2')
    const result = await getProjectForOwner(env.DB, project.id, 'other-session')
    expect(result).toBeUndefined()
  })

  it('getProjectForOwner returns undefined for an unknown id', async () => {
    const result = await getProjectForOwner(env.DB, crypto.randomUUID(), 'owner-session-3')
    expect(result).toBeUndefined()
  })

  it('setProjectLabel trims and sets a label', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-c')
    const label = await setProjectLabel(env.DB, project.id, '  UAT batch  ')
    expect(label).toBe('UAT batch')
    const reloaded = await getProject(env.DB, project.id)
    expect(reloaded?.label).toBe('UAT batch')
  })

  it('setProjectLabel clears the label with an empty string', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-d')
    await setProjectLabel(env.DB, project.id, 'Something')
    const label = await setProjectLabel(env.DB, project.id, '')
    expect(label).toBeNull()
  })

  it('setProjectLabel throws LabelValidationError over 100 characters', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-e')
    await expect(setProjectLabel(env.DB, project.id, 'x'.repeat(101))).rejects.toThrow(LabelValidationError)
  })

  it('getOrCreateProjectShareToken creates then returns the same token on repeat calls', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-f')
    const first = await getOrCreateProjectShareToken(env.DB, project.id)
    const second = await getOrCreateProjectShareToken(env.DB, project.id)
    expect(first).toBeTypeOf('string')
    expect(second).toBe(first)
  })

  it('getOrCreateProjectShareToken returns undefined for an unknown project', async () => {
    const result = await getOrCreateProjectShareToken(env.DB, crypto.randomUUID())
    expect(result).toBeUndefined()
  })

  it('getProjectByShareToken resolves a project by its token', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-g')
    const token = await getOrCreateProjectShareToken(env.DB, project.id)
    const resolved = await getProjectByShareToken(env.DB, token as string)
    expect(resolved?.id).toBe(project.id)
  })

  it('getProjectByShareToken returns undefined for an unknown token', async () => {
    const resolved = await getProjectByShareToken(env.DB, 'does-not-exist')
    expect(resolved).toBeUndefined()
  })

  it('revokeProjectShareToken clears the token', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-h')
    const token = await getOrCreateProjectShareToken(env.DB, project.id)
    const revoked = await revokeProjectShareToken(env.DB, project.id)
    expect(revoked).toBe(true)
    const resolved = await getProjectByShareToken(env.DB, token as string)
    expect(resolved).toBeUndefined()
  })

  it('deleteProject removes the project and its child listeners', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-i')
    await createProjectListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-i', project.id, 'case-one')
    await createProjectListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-i', project.id, 'case-two')

    const deleted = await deleteProject(env.DB, project.id)
    expect(deleted).toBe(true)

    const reloadedProject = await getProject(env.DB, project.id)
    expect(reloadedProject).toBeUndefined()

    const { results: remainingListeners } = await env.DB
      .prepare('SELECT id FROM listeners WHERE project_id = ?')
      .bind(project.id)
      .all()
    expect(remainingListeners).toEqual([])
  })

  it('deleteProject on a project with zero listeners is a clean no-op batch', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-j')
    const deleted = await deleteProject(env.DB, project.id)
    expect(deleted).toBe(true)
  })

  it('deleteProject returns false for an unknown project', async () => {
    const deleted = await deleteProject(env.DB, crypto.randomUUID())
    expect(deleted).toBe(false)
  })
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/projects.repo.test.ts`
Expected: FAIL — `getProjectForOwner`, `setProjectLabel`, etc. are not exported yet.

- [ ] **Step 5: Implement the repo additions**

Replace the full contents of `backend/src/projects.repo.ts`:

```ts
import type { Env } from './env'
import { LabelValidationError } from './listeners.repo'

export interface ProjectRecord {
  id: string
  createdAt: string
  ownerSession: string
  sortPosition: number | null
  label: string | null
  shareToken: string | null
}

const SELECT_COLUMNS =
  'id, created_at AS createdAt, owner_session AS ownerSession, sort_position AS sortPosition, ' +
  'label, share_token AS shareToken'

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
  return { id, createdAt, ownerSession, sortPosition: null, label: null, shareToken: null }
}

export async function getProject(db: Env['DB'], id: string): Promise<ProjectRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`)
    .bind(id)
    .first<ProjectRecord>()
  return row ?? undefined
}

export async function getProjectForOwner(
  db: Env['DB'],
  id: string,
  sessionId: string
): Promise<ProjectRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ? AND owner_session = ?`)
    .bind(id, sessionId)
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

const MAX_LABEL_LENGTH = 100

export async function setProjectLabel(db: Env['DB'], id: string, rawLabel: string): Promise<string | null> {
  const trimmed = rawLabel.trim()
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new LabelValidationError(`label must be ${MAX_LABEL_LENGTH} characters or fewer`)
  }
  const value = trimmed.length > 0 ? trimmed : null
  await db.prepare('UPDATE projects SET label = ? WHERE id = ?').bind(value, id).run()
  return value
}

// Same read-then-write race trade-off as getOrCreateShareToken in
// listeners.repo.ts — accepted at this app's personal scale.
export async function getOrCreateProjectShareToken(db: Env['DB'], id: string): Promise<string | undefined> {
  const project = await getProject(db, id)
  if (!project) return undefined
  if (project.shareToken) return project.shareToken

  const token = crypto.randomUUID()
  await db.prepare('UPDATE projects SET share_token = ? WHERE id = ?').bind(token, id).run()
  return token
}

export async function revokeProjectShareToken(db: Env['DB'], id: string): Promise<boolean> {
  const result = await db.prepare('UPDATE projects SET share_token = NULL WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

export async function getProjectByShareToken(db: Env['DB'], token: string): Promise<ProjectRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE share_token = ?`)
    .bind(token)
    .first<ProjectRecord>()
  return row ?? undefined
}

// Deletes every listener under this project first (their requests cascade
// via the already-working FK on requests.listener_id), then the project row
// itself — required because listeners.project_id has no declared cascade,
// and FK enforcement is genuinely on (see design spec §1).
export async function deleteProject(db: Env['DB'], id: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare('DELETE FROM listeners WHERE project_id = ?').bind(id),
    db.prepare('DELETE FROM projects WHERE id = ?').bind(id),
  ])
  const projectDeleteResult = results[1]
  return (projectDeleteResult.meta.changes ?? 0) > 0
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/projects.repo.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS — nothing else references the old `ProjectRecord` shape in a way that breaks.

- [ ] **Step 8: Commit**

```bash
cd backend
git add migrations/0007_projects_label_share.sql src/projects.repo.ts src/projects.repo.test.ts
git commit -m "feat(backend): add project label, share-token, and delete support to projects.repo"
```

---

## Task 2: `routes/projects.ts` — label, share, delete endpoints

**Files:**
- Modify: `backend/src/routes/projects.ts`
- Test: `backend/src/routes/projects.label.test.ts` (create)
- Test: `backend/src/routes/projects.share.test.ts` (create)
- Test: `backend/src/routes/projects.delete.test.ts` (create)

**Interfaces:**
- Consumes: `getProjectForOwner`, `setProjectLabel`, `getOrCreateProjectShareToken`, `revokeProjectShareToken`, `deleteProject` from `../projects.repo` (Task 1). `LabelValidationError` from `../listeners.repo`.
- Produces: serialized project now includes `label: string | null` and `shareUrl: string | null`. `PATCH /api/projects/:id/label`, `POST`/`DELETE /api/projects/:id/share`, `DELETE /api/projects/:id` routes, used by frontend Task 6/7.

- [ ] **Step 1: Write the failing route tests**

Create `backend/src/routes/projects.label.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('project label management', () => {
  let projectId: string
  let sessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/projects', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    projectId = createdBody.id
    sessionId = extractSessionId(created)
  })

  it('sets a label', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: '  UAT batch  ' }),
      },
      env
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as { label: string }).toEqual({ label: 'UAT batch' })
  })

  it('clears a label with an empty string', async () => {
    await app.request(
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Something' }),
      },
      env
    )
    const response = await app.request(
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: '' }),
      },
      env
    )
    expect((await response.json()) as { label: string | null }).toEqual({ label: null })
  })

  it('returns 400 for a label over 100 characters', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'x'.repeat(101) }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 for a different session', async () => {
    const other = await app.request('/api/projects', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(other)
    const response = await app.request(
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: otherSessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'nope' }),
      },
      env
    )
    expect(response.status).toBe(404)
  })

  it('the label appears on GET /api/projects', async () => {
    await app.request(
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'UAT batch' }),
      },
      env
    )
    const list = await app.request('/api/projects', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    const body = (await list.json()) as { id: string; label: string | null }[]
    expect(body.find((p) => p.id === projectId)?.label).toBe('UAT batch')
  })
})
```

Create `backend/src/routes/projects.share.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('project share management', () => {
  let projectId: string
  let sessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/projects', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    projectId = createdBody.id
    sessionId = extractSessionId(created)
  })

  it('has no share link by default', async () => {
    const response = await app.request(
      '/api/projects',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const body = (await response.json()) as { id: string; shareUrl: string | null }[]
    expect(body.find((p) => p.id === projectId)?.shareUrl).toBeNull()
  })

  it('creates a share link at /shared/projects/:token', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { shareToken: string; shareUrl: string }
    expect(body.shareToken).toBeTypeOf('string')
    expect(body.shareUrl).toBe(`${env.APP_BASE_URL}/shared/projects/${body.shareToken}`)
  })

  it('is idempotent — repeat calls return the same token', async () => {
    const first = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const second = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await second.json() as { shareToken: string }).shareToken).toBe(
      (await first.json() as { shareToken: string }).shareToken
    )
  })

  it('revokes a share link', async () => {
    await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const revokeResponse = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(revokeResponse.status).toBe(204)

    const list = await app.request(
      '/api/projects',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const body = (await list.json()) as { id: string; shareUrl: string | null }[]
    expect(body.find((p) => p.id === projectId)?.shareUrl).toBeNull()
  })

  it('returns 404 for an unknown project on both endpoints', async () => {
    const shareResponse = await app.request(
      '/api/projects/does-not-exist/share',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(shareResponse.status).toBe(404)

    const revokeResponse = await app.request(
      '/api/projects/does-not-exist/share',
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(revokeResponse.status).toBe(404)
  })

  it('returns 404 for a different session', async () => {
    const other = await app.request('/api/projects', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(other)
    const response = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })
})
```

Create `backend/src/routes/projects.delete.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('project delete', () => {
  let projectId: string
  let sessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/projects', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    projectId = createdBody.id
    sessionId = extractSessionId(created)
  })

  it('deletes a project with no listeners', async () => {
    const response = await app.request(
      `/api/projects/${projectId}`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(response.status).toBe(204)

    const list = await app.request('/api/projects', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    const body = (await list.json()) as { id: string }[]
    expect(body.find((p) => p.id === projectId)).toBeUndefined()
  })

  it('cascades to child listeners and their requests', async () => {
    const hookResponse = await app.request(
      `/hook/${projectId}/uat-case-1`,
      { method: 'POST', headers: { cookie: `wl_session_id=${sessionId}`, 'content-type': 'application/json' }, body: '{}' },
      env
    )
    expect(hookResponse.status).toBe(201)

    const listenersBefore = await env.DB.prepare('SELECT id FROM listeners WHERE project_id = ?').bind(projectId).all()
    expect(listenersBefore.results.length).toBe(1)
    const listenerId = (listenersBefore.results[0] as { id: string }).id
    const requestsBefore = await env.DB.prepare('SELECT id FROM requests WHERE listener_id = ?').bind(listenerId).all()
    expect(requestsBefore.results.length).toBe(1)

    const response = await app.request(
      `/api/projects/${projectId}`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(response.status).toBe(204)

    const listenersAfter = await env.DB.prepare('SELECT id FROM listeners WHERE project_id = ?').bind(projectId).all()
    expect(listenersAfter.results).toEqual([])
    const requestsAfter = await env.DB.prepare('SELECT id FROM requests WHERE listener_id = ?').bind(listenerId).all()
    expect(requestsAfter.results).toEqual([])
  })

  it('returns 404 for an unknown project', async () => {
    const response = await app.request(
      '/api/projects/does-not-exist',
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for a different session, and leaves the project intact', async () => {
    const other = await app.request('/api/projects', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(other)
    const response = await app.request(
      `/api/projects/${projectId}`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)

    const stillThere = await app.request(
      `/api/projects`,
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const body = (await stillThere.json()) as { id: string }[]
    expect(body.find((p) => p.id === projectId)).toBeDefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/routes/projects.label.test.ts src/routes/projects.share.test.ts src/routes/projects.delete.test.ts`
Expected: FAIL — 404s across the board, since none of these routes exist yet.

- [ ] **Step 3: Implement the routes**

Replace the full contents of `backend/src/routes/projects.ts`:

```ts
import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import {
  createProject,
  getProjectsForOwner,
  getProjectForOwner,
  setProjectLabel,
  getOrCreateProjectShareToken,
  revokeProjectShareToken,
  deleteProject,
  type ProjectRecord,
} from '../projects.repo'
import { LabelValidationError } from '../listeners.repo'

function projectShareUrlFor(appBaseUrl: string, shareToken: string | null): string | null {
  return shareToken ? `${appBaseUrl}/shared/projects/${shareToken}` : null
}

function serializeProject(env: Env, project: ProjectRecord) {
  return {
    id: project.id,
    createdAt: project.createdAt,
    hookUrlTemplate: `${env.HOOK_BASE_URL}/hook/${project.id}/<identifier>`,
    sortPosition: project.sortPosition,
    label: project.label,
    shareUrl: projectShareUrlFor(env.APP_BASE_URL, project.shareToken),
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

projectRoutes.patch('/api/projects/:id/label', async (c) => {
  const project = await getProjectForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }

  const body = await c.req.json<{ label?: unknown }>().catch(() => ({}) as { label?: unknown })
  if (typeof body.label !== 'string') {
    return c.json({ error: 'label is required (use an empty string to clear it)' }, 400)
  }

  try {
    const label = await setProjectLabel(c.env.DB, project.id, body.label)
    return c.json({ label })
  } catch (err) {
    if (err instanceof LabelValidationError) {
      return c.json({ error: err.message }, 400)
    }
    throw err
  }
})

projectRoutes.post('/api/projects/:id/share', async (c) => {
  const project = await getProjectForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }
  const token = (await getOrCreateProjectShareToken(c.env.DB, project.id)) as string
  return c.json({ shareToken: token, shareUrl: projectShareUrlFor(c.env.APP_BASE_URL, token) })
})

projectRoutes.delete('/api/projects/:id/share', async (c) => {
  const project = await getProjectForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }
  await revokeProjectShareToken(c.env.DB, project.id)
  return c.body(null, 204)
})

projectRoutes.delete('/api/projects/:id', async (c) => {
  const project = await getProjectForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }
  await deleteProject(c.env.DB, project.id)
  return c.body(null, 204)
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/projects.label.test.ts src/routes/projects.share.test.ts src/routes/projects.delete.test.ts src/routes/projects.test.ts`
Expected: PASS, including the pre-existing `projects.test.ts` (its `hookUrlTemplate`/`sortPosition` assertions are unaffected by the new fields).

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd backend
git add src/routes/projects.ts src/routes/projects.label.test.ts src/routes/projects.share.test.ts src/routes/projects.delete.test.ts
git commit -m "feat(backend): add project label, share, and delete routes"
```

---

## Task 3: Manual listener creation inside a project

**Files:**
- Modify: `backend/src/routes/listeners.ts` (export `serializeListener`)
- Modify: `backend/src/routes/projects.ts`
- Test: `backend/src/routes/projects.listeners.test.ts` (create)

**Interfaces:**
- Consumes: `serializeListener` exported from `../routes/listeners` (this task). `getProjectForOwner` from `../projects.repo` (Task 1). `normalizeSlug`, `assertValidSlug`, `SlugValidationError`, `isUniqueConstraintError`, `getListenerByProjectAndSlug`, `createProjectListener` from `../listeners.repo` (all pre-existing).
- Produces: `POST /api/projects/:projectId/listeners` route, used by frontend Task 8.

- [ ] **Step 1: Export `serializeListener` from `listeners.ts`**

In `backend/src/routes/listeners.ts`, change:

```ts
function serializeListener(env: Env, listener: ListenerRecord) {
```

to:

```ts
export function serializeListener(env: Env, listener: ListenerRecord) {
```

- [ ] **Step 2: Write the failing tests**

Create `backend/src/routes/projects.listeners.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('manual listener creation inside a project', () => {
  let projectId: string
  let sessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/projects', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    projectId = createdBody.id
    sessionId = extractSessionId(created)
  })

  it('creates a listener with the given identifier', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'checkout-uat' }),
      },
      env
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as { slug: string; projectId: string; hookUrl: string }
    expect(body.slug).toBe('checkout-uat')
    expect(body.projectId).toBe(projectId)
    expect(body.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${projectId}/checkout-uat`)
  })

  it('the created listener has no webhook token (project id is the only gate)', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'checkout-uat-2' }),
      },
      env
    )
    const body = (await response.json()) as { id: string }
    const listResponse = await app.request(
      '/api/listeners',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const listeners = (await listResponse.json()) as { id: string; slug: string | null }[]
    expect(listeners.find((l) => l.id === body.id)?.slug).toBe('checkout-uat-2')

    const hookResponse = await app.request(
      `/hook/${projectId}/checkout-uat-2`,
      { method: 'POST' },
      env
    )
    expect(hookResponse.status).toBe(200)
  })

  it('appears via a subsequent create-and-send hit, unchanged from auto-create behavior', async () => {
    await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'checkout-uat-3' }),
      },
      env
    )
    const hookResponse = await app.request(
      `/hook/${projectId}/checkout-uat-3`,
      { method: 'POST' },
      env
    )
    expect(hookResponse.status).toBe(200)
  })

  it('returns 409 for an identifier that already exists in the project', async () => {
    await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'dup-case' }),
      },
      env
    )
    const response = await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'dup-case' }),
      },
      env
    )
    expect(response.status).toBe(409)
  })

  it('returns 400 for an invalid slug', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'ab' }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 for a project owned by a different session', async () => {
    const other = await app.request('/api/projects', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(other)
    const response = await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: otherSessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'checkout-uat-4' }),
      },
      env
    )
    expect(response.status).toBe(404)
  })

  it('the same identifier is still creatable in a different project', async () => {
    await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'shared-name' }),
      },
      env
    )
    const secondProject = await app.request(
      '/api/projects',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const secondProjectId = ((await secondProject.json()) as { id: string }).id
    const response = await app.request(
      `/api/projects/${secondProjectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'shared-name' }),
      },
      env
    )
    expect(response.status).toBe(201)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/routes/projects.listeners.test.ts`
Expected: FAIL — 404 on a route that doesn't exist yet.

- [ ] **Step 4: Implement the route**

In `backend/src/routes/projects.ts`, update the imports at the top to:

```ts
import {
  createProject,
  getProjectsForOwner,
  getProjectForOwner,
  setProjectLabel,
  getOrCreateProjectShareToken,
  revokeProjectShareToken,
  deleteProject,
  type ProjectRecord,
} from '../projects.repo'
import {
  LabelValidationError,
  normalizeSlug,
  assertValidSlug,
  SlugValidationError,
  isUniqueConstraintError,
  getListenerByProjectAndSlug,
  createProjectListener,
} from '../listeners.repo'
import { serializeListener } from './listeners'
```

Add this route at the end of `backend/src/routes/projects.ts`:

```ts
projectRoutes.post('/api/projects/:projectId/listeners', async (c) => {
  const project = await getProjectForOwner(c.env.DB, c.req.param('projectId'), c.get('sessionId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }

  const body = await c.req.json<{ slug?: unknown }>().catch(() => ({}) as { slug?: unknown })
  if (typeof body.slug !== 'string') {
    return c.json({ error: 'slug is required' }, 400)
  }

  const slug = normalizeSlug(body.slug)
  try {
    assertValidSlug(slug)
  } catch (err) {
    if (err instanceof SlugValidationError) {
      return c.json({ error: err.message }, 400)
    }
    throw err
  }

  const existing = await getListenerByProjectAndSlug(c.env.DB, project.id, slug)
  if (existing) {
    return c.json({ error: `identifier "${slug}" is already in use in this project` }, 409)
  }

  try {
    const listener = await createProjectListener(
      c.env.DB,
      crypto.randomUUID(),
      new Date().toISOString(),
      project.ownerSession,
      project.id,
      slug
    )
    return c.json(serializeListener(c.env, listener), 201)
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return c.json({ error: `identifier "${slug}" is already in use in this project` }, 409)
    }
    throw err
  }
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/projects.listeners.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd backend
git add src/routes/listeners.ts src/routes/projects.ts src/routes/projects.listeners.test.ts
git commit -m "feat(backend): support manually creating a listener inside a project"
```

---

## Task 4: Shared project view routes

**Files:**
- Modify: `backend/src/listeners.repo.ts` (add `getListenersByProject`)
- Modify: `backend/src/routes/shared.ts`
- Test: `backend/src/listeners.repo.test.ts`
- Test: `backend/src/routes/shared.projects.test.ts` (create)

**Interfaces:**
- Consumes: `getProjectByShareToken` from `../projects.repo` (Task 1). `getListener`, `getListenersByProject` (this task) from `../listeners.repo`. `getRequests` from `../requests.repo` (pre-existing).
- Produces: `GET /api/shared/projects/:token` (returns `{ id, label, slug, createdAt }[]`), `GET /api/shared/projects/:token/listeners/:listenerId/requests`, used by frontend Task 11.

- [ ] **Step 1: Write the failing repo test**

Append to `backend/src/listeners.repo.test.ts` (add the import and the `it` block inside the existing top-level `describe`, checking the file's actual describe structure first and placing it in a matching or new nested `describe('getListenersByProject', ...)`):

```ts
import { getListenersByProject } from './listeners.repo'
```

```ts
describe('getListenersByProject', () => {
  it('returns only listeners for the given project, newest first', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-k')
    const older = await createProjectListener(
      env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', 'session-k', project.id, 'case-a'
    )
    const newer = await createProjectListener(
      env.DB, crypto.randomUUID(), '2026-01-02T00:00:00.000Z', 'session-k', project.id, 'case-b'
    )
    await createListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-k')

    const results = await getListenersByProject(env.DB, project.id)
    expect(results.map((l) => l.id)).toEqual([newer.id, older.id])
  })

  it('returns an empty list for a project with no listeners', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-l')
    const results = await getListenersByProject(env.DB, project.id)
    expect(results).toEqual([])
  })
})
```

Note: `createProject` isn't currently imported in `listeners.repo.test.ts` — add `import { createProject } from './projects.repo'` alongside the new `getListenersByProject` import if it's missing. Check the file's existing imports first (`createListener`, `createProjectListener` are almost certainly already imported since project-scoped listener tests already exist there).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/listeners.repo.test.ts`
Expected: FAIL — `getListenersByProject` is not exported yet.

- [ ] **Step 3: Implement `getListenersByProject`**

In `backend/src/listeners.repo.ts`, add this function directly after `getListenerByProjectAndSlug`:

```ts
export async function getListenersByProject(db: Env['DB'], projectId: string): Promise<ListenerRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE project_id = ? ORDER BY created_at DESC, id DESC`)
    .bind(projectId)
    .all<ListenerRecord>()
  return results
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/listeners.repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

Create `backend/src/routes/shared.projects.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('shared project view', () => {
  let projectId: string
  let sessionId: string
  let shareToken: string
  let listenerId: string

  beforeEach(async () => {
    const created = await app.request('/api/projects', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    projectId = createdBody.id
    sessionId = extractSessionId(created)

    await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'checkout-uat' }),
      },
      env
    )
    const listResponse = await app.request(
      '/api/listeners',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const listeners = (await listResponse.json()) as { id: string; slug: string | null }[]
    listenerId = listeners.find((l) => l.slug === 'checkout-uat')!.id

    await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ foo: 'bar' }) },
      env
    )

    const shareResponse = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    shareToken = (await shareResponse.json() as { shareToken: string }).shareToken
  })

  it('lists child listeners for a valid share token', async () => {
    const response = await app.request(`/api/shared/projects/${shareToken}`, {}, env)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { id: string; label: string | null; slug: string | null; createdAt: string }[]
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe(listenerId)
    expect(body[0].slug).toBe('checkout-uat')
  })

  it('never includes the project id or hookUrlTemplate anywhere in the response', async () => {
    const response = await app.request(`/api/shared/projects/${shareToken}`, {}, env)
    const text = await response.text()
    expect(text).not.toContain(projectId)
    expect(text).not.toContain('hookUrlTemplate')
  })

  it('a listener entry never includes hookUrl', async () => {
    const response = await app.request(`/api/shared/projects/${shareToken}`, {}, env)
    const body = (await response.json()) as Record<string, unknown>[]
    expect(Object.keys(body[0]).sort()).toEqual(['createdAt', 'id', 'label', 'slug'].sort())
  })

  it('returns 404 for an unknown token', async () => {
    const response = await app.request('/api/shared/projects/does-not-exist', {}, env)
    expect(response.status).toBe(404)
  })

  it('returns captured requests for a child listener', async () => {
    const response = await app.request(`/api/shared/projects/${shareToken}/listeners/${listenerId}/requests`, {}, env)
    expect(response.status).toBe(200)
    const [captured] = (await response.json()) as { body: string; method: string }[]
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.method).toBe('POST')
  })

  it('returns 404 for a listener that does not belong to the project resolved by the token', async () => {
    const otherProject = await app.request(
      '/api/projects',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const otherProjectId = ((await otherProject.json()) as { id: string }).id
    await app.request(
      `/api/projects/${otherProjectId}/listeners`,
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'other-case' }),
      },
      env
    )
    const otherListenersResponse = await app.request(
      '/api/listeners',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const otherListeners = (await otherListenersResponse.json()) as { id: string; slug: string | null }[]
    const otherListenerId = otherListeners.find((l) => l.slug === 'other-case')!.id

    const response = await app.request(
      `/api/shared/projects/${shareToken}/listeners/${otherListenerId}/requests`,
      {},
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for an unknown token on the requests route', async () => {
    const response = await app.request(
      `/api/shared/projects/does-not-exist/listeners/${listenerId}/requests`,
      {},
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 after the share token has been revoked', async () => {
    await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const response = await app.request(`/api/shared/projects/${shareToken}`, {}, env)
    expect(response.status).toBe(404)
  })
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/routes/shared.projects.test.ts`
Expected: FAIL — 404 on routes that don't exist yet.

- [ ] **Step 7: Implement the shared routes**

Replace the full contents of `backend/src/routes/shared.ts`:

```ts
import { Hono } from 'hono'
import type { Env } from '../env'
import { getListenerByShareToken, getListener, getListenersByProject } from '../listeners.repo'
import { getProjectByShareToken } from '../projects.repo'
import { getRequests } from '../requests.repo'

export const sharedRoutes = new Hono<{ Bindings: Env }>()

sharedRoutes.get('/api/shared/:token/requests', async (c) => {
  const listener = await getListenerByShareToken(c.env.DB, c.req.param('token'))
  if (!listener) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const requests = await getRequests(c.env.DB, listener.id)
  return c.json(
    requests.map((r) => ({
      id: r.id,
      method: r.method,
      headers: JSON.parse(r.headers),
      queryParams: JSON.parse(r.queryParams),
      body: r.body,
      contentType: r.contentType,
      sourceIp: r.sourceIp,
      receivedAt: r.receivedAt,
    }))
  )
})

sharedRoutes.get('/api/shared/projects/:token', async (c) => {
  const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
  if (!project) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const listeners = await getListenersByProject(c.env.DB, project.id)
  return c.json(
    listeners.map((l) => ({
      id: l.id,
      label: l.label,
      slug: l.slug,
      createdAt: l.createdAt,
    }))
  )
})

sharedRoutes.get('/api/shared/projects/:token/listeners/:listenerId/requests', async (c) => {
  const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
  if (!project) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const listener = await getListener(c.env.DB, c.req.param('listenerId'))
  if (!listener || listener.projectId !== project.id) {
    return c.json({ error: 'listener not found' }, 404)
  }
  const requests = await getRequests(c.env.DB, listener.id)
  return c.json(
    requests.map((r) => ({
      id: r.id,
      method: r.method,
      headers: JSON.parse(r.headers),
      queryParams: JSON.parse(r.queryParams),
      body: r.body,
      contentType: r.contentType,
      sourceIp: r.sourceIp,
      receivedAt: r.receivedAt,
    }))
  )
})
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/shared.projects.test.ts src/routes/shared.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd backend
git add src/listeners.repo.ts src/listeners.repo.test.ts src/routes/shared.ts src/routes/shared.projects.test.ts
git commit -m "feat(backend): add read-only shared project view routes"
```

---

## Task 5: Frontend `api.ts` additions

**Files:**
- Modify: `frontend/src/api.ts`

**Interfaces:**
- Consumes: the six new backend endpoints from Tasks 2-4.
- Produces: `Project.label`/`Project.shareUrl` fields; `setProjectLabel`, `getOrCreateProjectShareLink`, `revokeProjectShareLink`, `deleteProject`, `createProjectListener`, `getSharedProject`, `getSharedProjectListenerRequests`, `SharedProjectListener` type — consumed by Tasks 6-11.

- [ ] **Step 1: Update the `Project` interface**

In `frontend/src/api.ts`, change:

```ts
export interface Project {
  id: string
  createdAt: string
  hookUrlTemplate: string
  sortPosition: number | null
}
```

to:

```ts
export interface Project {
  id: string
  createdAt: string
  hookUrlTemplate: string
  sortPosition: number | null
  label: string | null
  shareUrl: string | null
}

export interface SharedProjectListener {
  id: string
  label: string | null
  slug: string | null
  createdAt: string
}
```

- [ ] **Step 2: Add the new functions**

Add these functions to the end of `frontend/src/api.ts`:

```ts
export function setProjectLabel(id: string, label: string): Promise<{ label: string | null }> {
  return fetch(`${API_BASE_URL}/api/projects/${id}/label`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  }).then((r) => parseJsonOrThrow<{ label: string | null }>(r))
}

export function getOrCreateProjectShareLink(id: string): Promise<ShareLink> {
  return fetch(`${API_BASE_URL}/api/projects/${id}/share`, { method: 'POST', credentials: 'include' }).then((r) =>
    parseJsonOrThrow<ShareLink>(r)
  )
}

export async function revokeProjectShareLink(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${id}/share`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${id}`, { method: 'DELETE', credentials: 'include' })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function createProjectListener(projectId: string, slug: string): Promise<Listener> {
  return fetch(`${API_BASE_URL}/api/projects/${projectId}/listeners`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug }),
  }).then((r) => parseJsonOrThrow<Listener>(r))
}

export function getSharedProject(token: string): Promise<SharedProjectListener[]> {
  return fetch(`${API_BASE_URL}/api/shared/projects/${token}`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<SharedProjectListener[]>(r)
  )
}

export function getSharedProjectListenerRequests(token: string, listenerId: string): Promise<RequestDetail[]> {
  return fetch(`${API_BASE_URL}/api/shared/projects/${token}/listeners/${listenerId}/requests`, {
    credentials: 'include',
  }).then((r) => parseJsonOrThrow<RequestDetail[]>(r))
}
```

- [ ] **Step 3: Run the frontend build to verify types check**

Run: `cd frontend && npm run build`
Expected: PASS — `api.ts` compiles; nothing else references `Project` in a way that breaks from the two added fields (they're additive).

- [ ] **Step 4: Commit**

```bash
cd frontend
git add src/api.ts
git commit -m "feat(frontend): add API client functions for project label, share, delete, and manual create"
```

---

## Task 6: `ProjectDetail.tsx` — label edit and delete

**Files:**
- Modify: `frontend/src/pages/ProjectDetail.tsx`

**Interfaces:**
- Consumes: `setProjectLabel`, `deleteProject` from `../api` (Task 5).
- Produces: no new exports; `project.label` is now shown as the page's primary heading text.

- [ ] **Step 1: Add label-edit and delete state, handlers, and imports**

In `frontend/src/pages/ProjectDetail.tsx`, update the top of the file. Change the import block from:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { listListeners, listProjects, type Listener, type Project } from '../api'
```

to:

```ts
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { deleteProject, listListeners, listProjects, setProjectLabel, type Listener, type Project } from '../api'
```

Inside the `ProjectDetail` component, change:

```ts
  const { projectId } = useParams<{ projectId: string }>()
  const [project, setProject] = useState<Project | null>(null)
  const [children, setChildren] = useState<Listener[]>([])
  const [notFound, setNotFound] = useState(false)
  const [copied, setCopied] = useState(false)
  const consecutiveNotFoundRef = useRef(0)
```

to:

```ts
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<Project | null>(null)
  const [children, setChildren] = useState<Listener[]>([])
  const [notFound, setNotFound] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [editingLabel, setEditingLabel] = useState(false)
  const consecutiveNotFoundRef = useRef(0)
```

Add these handlers directly after the existing `handleCopy` function:

```ts
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
```

- [ ] **Step 2: Replace the heading with a label-edit form, and add the delete button and error banner**

Replace this block:

```tsx
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
```

with:

```tsx
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
```

- [ ] **Step 3: Run the frontend build**

Run: `cd frontend && npm run build`
Expected: PASS. Fix any type errors from the `FormEvent` import if unused elsewhere (it's used implicitly through the inline `onSubmit`, so no separate handler signature is needed — remove the `type FormEvent` import if `tsc` flags it as unused, since this task's form only uses an inline arrow function, not a named `FormEvent` handler).

- [ ] **Step 4: Manual verification**

Run `cd backend && npm run dev` and `cd frontend && npm run dev` (with `backend/.dev.vars` already set per `CLAUDE.md`). In a browser: create a project, click its heading to rename it, save, confirm the new label persists on reload; click "Delete project", confirm the dialog, confirm it navigates back to `/` and the project no longer appears.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/pages/ProjectDetail.tsx
git commit -m "feat(frontend): add project label edit and delete to the detail page"
```

---

## Task 7: `ProjectDetail.tsx` — share section

**Files:**
- Modify: `frontend/src/pages/ProjectDetail.tsx`

**Interfaces:**
- Consumes: `getOrCreateProjectShareLink`, `revokeProjectShareLink` from `../api` (Task 5).
- Produces: no new exports.

- [ ] **Step 1: Add share state, handlers, and import**

Update the `../api` import to add the two share functions:

```ts
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
```

Add state alongside the existing `copied` state:

```ts
  const [shareCopied, setShareCopied] = useState(false)
```

Add these handlers after `handleSaveLabel`:

```ts
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
```

- [ ] **Step 2: Add the share section to the JSX**

Insert this block directly after the closing `</div>` of the create-and-send URL block (the one containing `project.hookUrlTemplate` and the "Copy" button), and before the `{children.length === 0 ? (` block:

```tsx
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
```

- [ ] **Step 3: Run the frontend build**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 4: Manual verification**

In the browser: open a project detail page, click "Get read-only share link", confirm a link appears in the `/shared/projects/:token` form, click "Copy" (confirms "Copied!" feedback), click "Revoke share link", confirm the dialog, confirm the button reverts to "Get read-only share link".

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/pages/ProjectDetail.tsx
git commit -m "feat(frontend): add project share link section to the detail page"
```

---

## Task 8: `ProjectDetail.tsx` — manual create-listener form

**Files:**
- Modify: `frontend/src/pages/ProjectDetail.tsx`

**Interfaces:**
- Consumes: `createProjectListener`, `ApiError` from `../api` (Task 5).
- Produces: no new exports.

- [ ] **Step 1: Add form state, handler, and imports**

Update the `../api` import to add `ApiError` and `createProjectListener`:

```ts
import {
  ApiError,
  createProjectListener,
  deleteProject,
  getOrCreateProjectShareLink,
  listListeners,
  listProjects,
  revokeProjectShareLink,
  setProjectLabel,
  type Listener,
  type Project,
} from '../api'
```

Add state:

```ts
  const [createDraft, setCreateDraft] = useState('')
```

Add this handler after `handleRevokeShare`:

```ts
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
```

Restore the `type FormEvent` import removed (or kept) in Task 6 — add it back to the top-level import if it isn't already there:

```ts
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
```

- [ ] **Step 2: Add the create form to the JSX**

Insert this block directly after the share section added in Task 7, and before the `{children.length === 0 ? (` block:

```tsx
        <form onSubmit={handleCreateChild} className="mt-4 flex items-center gap-2">
          <input
            value={createDraft}
            onChange={(e) => setCreateDraft(e.target.value)}
            placeholder="uat-case-42"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
          />
          <button
            type="submit"
            className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            Create listener
          </button>
        </form>
```

- [ ] **Step 3: Run the frontend build**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 4: Manual verification**

In the browser: on a project detail page, type an identifier into the new field and submit — confirm navigation to `/listener/:id` for the new listener; go back, submit the exact same identifier again in a second project — confirm it succeeds (different project); submit the same identifier a second time in the *same* project — confirm the inline "already in use" error appears and no navigation happens.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/pages/ProjectDetail.tsx
git commit -m "feat(frontend): add manual create-listener form to the project detail page"
```

---

## Task 9: `ProjectDetail.tsx` — sort mode and drag-reorder for children

**Files:**
- Modify: `frontend/src/pages/ProjectDetail.tsx`

**Interfaces:**
- Consumes: `reorderItems`, `type SortMode`, `type ReorderItem` from `../api` (pre-existing, already used by `Home.tsx`).
- Produces: no new exports.

- [ ] **Step 1: Add sort-mode and drag state, storage helpers, and imports**

Update the `../api` import to add `reorderItems`, `type ReorderItem`, `type SortMode`:

```ts
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
```

Add these module-level constants directly after the existing `MAX_CONSECUTIVE_NOT_FOUND` constant:

```ts
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
```

Inside the component, add sort/drag state and change `refresh` to depend on the current sort mode. Replace:

```ts
  const [notFound, setNotFound] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
```

with:

```ts
  const [notFound, setNotFound] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortMode>('date')
  const [dragKey, setDragKey] = useState<string | null>(null)
```

Replace the `refresh` callback's body so it fetches with the active sort mode and loads the stored sort once `projectId` is known:

```ts
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
```

Add a sort-change handler and a drop handler after `handleCreateChild`:

```ts
  function handleSortChange(next: SortMode) {
    if (!projectId) return
    setSort(next)
    localStorage.setItem(sortStorageKey(projectId), next)
  }

  function handleDrop(targetId: string) {
    if (!dragKey || dragKey === targetId) return
    const previousChildren = children
    const current = [...children]
    const fromIndex = current.findIndex((l) => l.id === dragKey)
    const toIndex = current.findIndex((l) => l.id === targetId)
    if (fromIndex === -1 || toIndex === -1) return
    const [moved] = current.splice(fromIndex, 1)
    current.splice(toIndex, 0, moved)
    setDragKey(null)
    setChildren(current)

    const orderedItems: ReorderItem[] = current.map((l) => ({ type: 'listener', id: l.id }))
    reorderItems(orderedItems).catch(() => {
      setChildren(previousChildren)
      setError('Failed to save the new order.')
    })
  }
```

- [ ] **Step 2: Add sort-mode buttons and wire up drag-and-drop on the children list**

Insert this block directly before `{children.length === 0 ? (`:

```tsx
        {children.length > 0 && (
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
        )}
```

Replace the existing children-list rendering block:

```tsx
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
```

with:

```tsx
        {children.length === 0 ? (
          <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">
            No requests yet — point your test script at the URL above (with a real identifier in place of{' '}
            <code>&lt;identifier&gt;</code>) to get started.
          </p>
        ) : (
          <ul className="mb-2 mt-2 space-y-2 text-left">
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
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(listener.id)}
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
                    <span className="block text-xs text-slate-400 dark:text-slate-400">
                      {new Date(listener.createdAt).toLocaleString()}
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        )}
```

- [ ] **Step 3: Run the frontend build**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 4: Manual verification**

In the browser: create a project with 3+ manually-created listeners (Task 8's form). Switch between Date/Name/Recent activity/Custom sort buttons and confirm the order changes sensibly. In Custom mode, drag one listener above another, confirm the order persists after a page reload, and confirm this reordering does not affect the order of *standalone* listeners shown on the Home page in its own Custom mode.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/pages/ProjectDetail.tsx
git commit -m "feat(frontend): add sort-mode and drag-reorder for a project's child listeners"
```

---

## Task 10: `Home.tsx` — show project label

**Files:**
- Modify: `frontend/src/pages/Home.tsx`

**Interfaces:**
- Consumes: `project.label` (now present on `Project`, Task 5).
- Produces: no new exports.

- [ ] **Step 1: Update the project card's primary text**

In `frontend/src/pages/Home.tsx`, change:

```tsx
                      <span className="flex items-center gap-2 font-medium">
                        <span aria-hidden="true">📁</span>
                        {project.id}
                      </span>
```

to:

```tsx
                      <span className="flex items-center gap-2 font-medium">
                        <span aria-hidden="true">📁</span>
                        {project.label || project.id}
                      </span>
```

- [ ] **Step 2: Run the frontend build**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 3: Manual verification**

On the Home page, confirm a labeled project shows its label instead of its raw UUID, and an unlabeled project still falls back to showing its UUID.

- [ ] **Step 4: Commit**

```bash
cd frontend
git add src/pages/Home.tsx
git commit -m "feat(frontend): show a project's label on its Home card"
```

---

## Task 11: `SharedProject.tsx` page and routing

**Files:**
- Create: `frontend/src/pages/SharedProject.tsx`
- Create: `frontend/src/pages/SharedProjectListener.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `getSharedProject`, `getSharedProjectListenerRequests`, `type SharedProjectListener` from `../api` (Task 5). Reuses `RequestRow`, `RequestFilters`, `filterRequests`/`uniqueContentTypes`/`uniqueMethods`, `downloadFile`/`toHarExport`/`toJsonExport`, `useSettings`/`WIDTH_CLASSES` — the same imports `SharedListener.tsx` already uses.
- Produces: routes `/shared/projects/:token` and `/shared/projects/:token/:listenerId`.

- [ ] **Step 1: Create `SharedProject.tsx`**

Create `frontend/src/pages/SharedProject.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError, getSharedProject, type SharedProjectListener } from '../api'

const POLL_INTERVAL_MS = 3000
const MAX_CONSECUTIVE_NOT_FOUND = 2

export function SharedProject() {
  const { token } = useParams<{ token: string }>()
  const [listeners, setListeners] = useState<SharedProjectListener[]>([])
  const [loaded, setLoaded] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const consecutiveNotFoundRef = useRef(0)

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!token) return false
    try {
      const data = await getSharedProject(token)
      setListeners(data)
      setLoaded(true)
      consecutiveNotFoundRef.current = 0
      return true
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        consecutiveNotFoundRef.current += 1
        if (consecutiveNotFoundRef.current >= MAX_CONSECUTIVE_NOT_FOUND) {
          setNotFound(true)
          return false
        }
        return true
      }
      consecutiveNotFoundRef.current = 0
      return true
    }
  }, [token])

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

  if (notFound) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm dark:bg-slate-800">
          <p className="text-sm text-slate-500 dark:text-slate-400">Share link not found or revoked.</p>
        </div>
      </main>
    )
  }

  if (!loaded) {
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
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Shared project (read-only)</h1>

        {listeners.length === 0 ? (
          <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">No listeners in this project yet.</p>
        ) : (
          <ul className="mb-2 mt-6 space-y-2 text-left">
            {listeners.map((listener) => {
              const primaryText = listener.label || listener.slug || new Date(listener.createdAt).toLocaleString()
              return (
                <li key={listener.id}>
                  <a
                    href={`/shared/projects/${token}/${listener.id}`}
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

- [ ] **Step 2: Create `SharedProjectListener.tsx`**

Create `frontend/src/pages/SharedProjectListener.tsx` by copying `SharedListener.tsx`'s structure, pointed at the project-scoped requests endpoint and both route params:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, type RequestDetail, getSharedProjectListenerRequests } from '../api'
import { RequestRow } from '../components/RequestRow'
import { RequestFilters } from '../components/RequestFilters'
import { ALL, filterRequests, uniqueContentTypes, uniqueMethods, type RequestFilter } from '../lib/filterRequests'
import { downloadFile, toHarExport, toJsonExport } from '../lib/exportRequests'
import { useSettings } from '../hooks/useSettings'
import { WIDTH_CLASSES } from '../lib/settings'

const POLL_INTERVAL_MS = 3000
const MAX_CONSECUTIVE_NOT_FOUND = 2

export function SharedProjectListener() {
  const { token, listenerId } = useParams<{ token: string; listenerId: string }>()
  const { width } = useSettings()
  const [requests, setRequests] = useState<RequestDetail[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<RequestFilter>({ method: ALL, contentType: ALL, search: '' })
  const [diffOnly, setDiffOnly] = useState(false)
  const consecutiveNotFoundRef = useRef(0)
  const filteredRequests = useMemo(() => filterRequests(requests, filter), [requests, filter])
  const previousByRequestId = useMemo(() => {
    const map = new Map<number, RequestDetail>()
    for (let i = 0; i < requests.length - 1; i++) {
      map.set(requests[i].id, requests[i + 1])
    }
    return map
  }, [requests])

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!token || !listenerId) return false
    try {
      const requestData = await getSharedProjectListenerRequests(token, listenerId)
      setRequests(requestData)
      setLoaded(true)
      setError(null)
      consecutiveNotFoundRef.current = 0
      return true
    } catch (err) {
      setError('Share link not found or revoked.')
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
  }, [token, listenerId])

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

  function handleExportJson() {
    if (!listenerId) return
    downloadFile(`webhook-shared-${listenerId}.json`, toJsonExport(filteredRequests), 'application/json')
  }

  function handleExportHar() {
    if (!listenerId) return
    downloadFile(`webhook-shared-${listenerId}.har`, toHarExport(filteredRequests), 'application/json')
  }

  return (
    <main className={`mx-auto px-6 py-10 ${WIDTH_CLASSES[width]}`}>
      <Link
        to={`/shared/projects/${token}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        ← Back to project
      </Link>
      <h1 className="mb-6 text-xl font-semibold text-slate-900 dark:text-slate-100">Shared listener (read-only)</h1>

      {error && (
        <p role="alert" className="mb-6 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </p>
      )}

      {!loaded && !error && (
        <ul className="space-y-2" aria-label="Loading requests">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-12 animate-pulse rounded-lg bg-slate-200" />
          ))}
        </ul>
      )}

      {loaded && requests.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No requests yet.
        </div>
      )}

      {loaded && requests.length > 0 && (
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
```

- [ ] **Step 3: Wire up the routes**

Replace the full contents of `frontend/src/App.tsx`:

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'
import { ProjectDetail } from './pages/ProjectDetail'
import { SharedListener } from './pages/SharedListener'
import { SharedProject } from './pages/SharedProject'
import { SharedProjectListener } from './pages/SharedProjectListener'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/listener/:id" element={<Listener />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/shared/:token" element={<SharedListener />} />
          <Route path="/shared/projects/:token" element={<SharedProject />} />
          <Route path="/shared/projects/:token/:listenerId" element={<SharedProjectListener />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
```

Note: React Router matches `/shared/projects/:token` and `/shared/:token` unambiguously since they have different segment counts, and `/shared/projects/:token/:listenerId` doesn't collide with either — no route-ordering hazard here.

- [ ] **Step 4: Run the frontend build**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Open a project's share link in an incognito window: confirm the child-listener list renders with labels/slugs/timestamps only, click into a listener, confirm its captured requests render via the export/filter UI, and confirm neither the project's raw id nor its `hookUrlTemplate` appear anywhere in the page source (view-source or DevTools network tab on `/api/shared/projects/:token`).

- [ ] **Step 6: Commit**

```bash
cd frontend
git add src/pages/SharedProject.tsx src/pages/SharedProjectListener.tsx src/App.tsx
git commit -m "feat(frontend): add the read-only shared project view and its listener detail page"
```

---

## Self-Review Notes

- **Spec coverage:** §1 data model → Task 1. §2 backend project API → Tasks 2-3. §3 shared project routes → Task 4. §4 sort (frontend-only, no backend work) → Task 9. §5 frontend → Tasks 5-11. §6 error handling → verified inline in each task's tests (404/400/409 assertions). §7 testing → backend covered by Tasks 1-4's test files; frontend covered by the `npm run build` + manual click-through step in every frontend task, matching the spec's stated frontend verification approach (no test framework exists).
- **Out of scope confirmed unchanged:** no task touches moving listeners between projects, transferring ownership, hook-route auth, or the Home-page listener action gap — matching spec's "Out of scope" section.
- **Type consistency check:** `ProjectRecord` (Task 1) gains `label`/`shareToken`, consumed identically in `serializeProject` (Task 2) and `getListenersByProject`'s caller (Task 4). `SharedProjectListener` (Task 5) matches the exact shape returned by `GET /api/shared/projects/:token` (Task 4): `{ id, label, slug, createdAt }`. `ReorderItem`/`SortMode` (Task 9) reused unchanged from the existing `api.ts` exports, matching `Home.tsx`'s usage.
