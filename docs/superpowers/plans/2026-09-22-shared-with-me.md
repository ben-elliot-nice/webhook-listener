# Shared-with-me Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a viewer who opens a read-only share link (listener or project) find it again from their own Home page, until the owner revokes/deletes it or the viewer removes it themselves.

**Architecture:** A new `shared_with_me` D1 table records one row per `(viewer_email, kind, token)`. Two new POST endpoints record a visit when a shared page loads; a GET endpoint resolves recorded tokens live against `listeners`/`projects` (so revokes/deletes/label changes are always reflected, never cached); a DELETE endpoint implements personal removal. The frontend calls the record endpoint once per shared-page mount and renders a new "Shared with me" section on Home.

**Tech Stack:** Hono + D1 (`@cloudflare/vitest-pool-workers` for backend tests), React + react-router-dom, no frontend test framework (established project scope — manual verification only).

**Spec:** `docs/superpowers/specs/2026-09-22-shared-with-me-design.md`

## Global Constraints

- Viewer identity is always the verified email at `c.get('email')` (tier-0 auth middleware already applied to every route this plan touches) — never a session id, never a client-supplied value.
- A row's label/owner data is never cached in `shared_with_me` — always resolved live from `listeners`/`projects` by `token` at list time (spec: "Data model").
- `DELETE /api/shared-with-me/:kind/:token` always returns `204`, matching or not (spec: "Listing and removing").
- Recording a visit against a token that doesn't resolve to a real listener/project returns `404` and writes nothing (spec: "Recording a visit").

---

### Task 1: `shared_with_me` table and repo functions

**Files:**
- Create: `backend/migrations/0011_shared_with_me.sql`
- Create: `backend/src/shared-with-me.repo.ts`
- Test: `backend/src/shared-with-me.repo.test.ts`

**Interfaces:**
- Consumes: `Env['DB']` (D1Database), already defined in `backend/src/env.ts`.
- Produces:
  - `export type SharedWithMeKind = 'listener' | 'project'`
  - `export interface SharedWithMeRow { kind: SharedWithMeKind; token: string; firstVisitedAt: string }`
  - `export async function recordSharedVisit(db: Env['DB'], viewerEmail: string, kind: SharedWithMeKind, token: string, now: string): Promise<void>`
  - `export async function listSharedWithMe(db: Env['DB'], viewerEmail: string): Promise<SharedWithMeRow[]>`
  - `export async function removeSharedWithMe(db: Env['DB'], viewerEmail: string, kind: SharedWithMeKind, token: string, now: string): Promise<void>`

These four are used by Task 2 and Task 3's route handlers.

- [ ] **Step 1: Write the migration**

Create `backend/migrations/0011_shared_with_me.sql`:

```sql
CREATE TABLE shared_with_me (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  viewer_email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('listener', 'project')),
  token TEXT NOT NULL,
  first_visited_at TEXT NOT NULL,
  last_visited_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE(viewer_email, kind, token)
);

CREATE INDEX idx_shared_with_me_viewer ON shared_with_me(viewer_email);
```

This file is picked up automatically by `backend/vitest.config.ts` (it reads every file in `backend/migrations/` via `readD1Migrations` and applies them in the test DB) — no other config change is needed for tests to see the new table.

- [ ] **Step 2: Write the failing repo tests**

Create `backend/src/shared-with-me.repo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { recordSharedVisit, listSharedWithMe, removeSharedWithMe } from './shared-with-me.repo'

describe('shared-with-me.repo', () => {
  it('recordSharedVisit creates a row that listSharedWithMe returns', async () => {
    const now = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer1@nice.com', 'listener', 'token-a', now)

    const rows = await listSharedWithMe(env.DB, 'viewer1@nice.com')
    expect(rows).toEqual([{ kind: 'listener', token: 'token-a', firstVisitedAt: now }])
  })

  it('recordSharedVisit twice for the same token updates in place, not duplicates', async () => {
    const first = new Date(Date.now() - 60_000).toISOString()
    const second = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer2@nice.com', 'project', 'token-b', first)
    await recordSharedVisit(env.DB, 'viewer2@nice.com', 'project', 'token-b', second)

    const { results } = await env.DB
      .prepare('SELECT COUNT(*) AS count FROM shared_with_me WHERE viewer_email = ? AND kind = ? AND token = ?')
      .bind('viewer2@nice.com', 'project', 'token-b')
      .all<{ count: number }>()
    expect(results[0].count).toBe(1)

    const rows = await listSharedWithMe(env.DB, 'viewer2@nice.com')
    expect(rows).toEqual([{ kind: 'project', token: 'token-b', firstVisitedAt: first }])
  })

  it('removeSharedWithMe hides the entry from listSharedWithMe', async () => {
    const now = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer3@nice.com', 'listener', 'token-c', now)
    await removeSharedWithMe(env.DB, 'viewer3@nice.com', 'listener', 'token-c', new Date().toISOString())

    const rows = await listSharedWithMe(env.DB, 'viewer3@nice.com')
    expect(rows).toEqual([])
  })

  it('recording a visit after personal removal clears removed_at and it reappears', async () => {
    const first = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer4@nice.com', 'listener', 'token-d', first)
    await removeSharedWithMe(env.DB, 'viewer4@nice.com', 'listener', 'token-d', new Date().toISOString())
    expect(await listSharedWithMe(env.DB, 'viewer4@nice.com')).toEqual([])

    const revisit = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer4@nice.com', 'listener', 'token-d', revisit)
    const rows = await listSharedWithMe(env.DB, 'viewer4@nice.com')
    expect(rows).toEqual([{ kind: 'listener', token: 'token-d', firstVisitedAt: first }])
  })

  it('two different viewer emails visiting the same token get independent rows', async () => {
    const now = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer5a@nice.com', 'project', 'token-e', now)
    await recordSharedVisit(env.DB, 'viewer5b@nice.com', 'project', 'token-e', now)

    await removeSharedWithMe(env.DB, 'viewer5a@nice.com', 'project', 'token-e', new Date().toISOString())

    expect(await listSharedWithMe(env.DB, 'viewer5a@nice.com')).toEqual([])
    expect(await listSharedWithMe(env.DB, 'viewer5b@nice.com')).toEqual([
      { kind: 'project', token: 'token-e', firstVisitedAt: now },
    ])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && npm test -- src/shared-with-me.repo.test.ts`
Expected: FAIL — `Cannot find module './shared-with-me.repo'` (file doesn't exist yet).

- [ ] **Step 4: Write the repo implementation**

Create `backend/src/shared-with-me.repo.ts`:

```typescript
import type { Env } from './env'

export type SharedWithMeKind = 'listener' | 'project'

export interface SharedWithMeRow {
  kind: SharedWithMeKind
  token: string
  firstVisitedAt: string
}

export async function recordSharedVisit(
  db: Env['DB'],
  viewerEmail: string,
  kind: SharedWithMeKind,
  token: string,
  now: string
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO shared_with_me (viewer_email, kind, token, first_visited_at, last_visited_at, removed_at) ' +
        'VALUES (?, ?, ?, ?, ?, NULL) ' +
        'ON CONFLICT(viewer_email, kind, token) DO UPDATE SET last_visited_at = excluded.last_visited_at, removed_at = NULL'
    )
    .bind(viewerEmail, kind, token, now, now)
    .run()
}

export async function listSharedWithMe(db: Env['DB'], viewerEmail: string): Promise<SharedWithMeRow[]> {
  const { results } = await db
    .prepare(
      'SELECT kind, token, first_visited_at AS firstVisitedAt FROM shared_with_me ' +
        'WHERE viewer_email = ? AND removed_at IS NULL ORDER BY first_visited_at DESC'
    )
    .bind(viewerEmail)
    .all<SharedWithMeRow>()
  return results
}

export async function removeSharedWithMe(
  db: Env['DB'],
  viewerEmail: string,
  kind: SharedWithMeKind,
  token: string,
  now: string
): Promise<void> {
  await db
    .prepare('UPDATE shared_with_me SET removed_at = ? WHERE viewer_email = ? AND kind = ? AND token = ?')
    .bind(now, viewerEmail, kind, token)
    .run()
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npm test -- src/shared-with-me.repo.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/0011_shared_with_me.sql backend/src/shared-with-me.repo.ts backend/src/shared-with-me.repo.test.ts
git commit -m "feat(backend): add shared_with_me table and repo functions"
```

---

### Task 2: Visit-recording routes

**Files:**
- Modify: `backend/src/routes/shared.ts`
- Test: Create `backend/src/routes/shared-with-me.test.ts`

**Interfaces:**
- Consumes: `recordSharedVisit` from Task 1 (`../shared-with-me.repo`); `getListenerByShareToken` from `../listeners.repo` (already imported in `shared.ts`); `getProjectByShareToken` from `../projects.repo` (already imported in `shared.ts`); `Variables` type from `../app` (already used the same way in `routes/listeners.ts:3` and `routes/projects.ts:3`); `authCookieHeader(env, email)` test helper from `../test-helpers/auth`.
- Produces: `POST /api/shared/:token/visit` and `POST /api/shared/projects/:token/visit`, both requiring the existing tier-0 `wl_email_session` cookie (same as every other `/api/*` route) and returning `204` on success, `404` if the token doesn't resolve.

- [ ] **Step 1: Write the failing route tests**

Create `backend/src/routes/shared-with-me.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('shared-with-me visit recording', () => {
  let listenerId: string
  let listenerShareToken: string
  let projectId: string
  let projectShareToken: string
  const ownerEmail = 'visit-owner@nice.com'
  const viewerEmail = 'visit-viewer@nice.com'

  beforeEach(async () => {
    const listenerResponse = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    listenerId = ((await listenerResponse.json()) as { id: string }).id
    const listenerShareResponse = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    listenerShareToken = ((await listenerShareResponse.json()) as { shareToken: string }).shareToken

    const projectResponse = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    projectId = ((await projectResponse.json()) as { id: string }).id
    const projectShareResponse = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    projectShareToken = ((await projectShareResponse.json()) as { shareToken: string }).shareToken
  })

  it('POST /api/shared/:token/visit returns 204 for a valid listener share token', async () => {
    const response = await app.request(
      `/api/shared/${listenerShareToken}/visit`,
      { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(204)
  })

  it('POST /api/shared/:token/visit returns 404 for an unknown token and writes nothing', async () => {
    const response = await app.request(
      '/api/shared/does-not-exist/visit',
      { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(404)
    const { results } = await env.DB
      .prepare('SELECT COUNT(*) AS count FROM shared_with_me WHERE token = ?')
      .bind('does-not-exist')
      .all<{ count: number }>()
    expect(results[0].count).toBe(0)
  })

  it('POST /api/shared/projects/:token/visit returns 204 for a valid project share token', async () => {
    const response = await app.request(
      `/api/shared/projects/${projectShareToken}/visit`,
      { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(204)
  })

  it('POST /api/shared/projects/:token/visit returns 404 for an unknown token', async () => {
    const response = await app.request(
      '/api/shared/projects/does-not-exist/visit',
      { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('recording a visit requires a valid session (401 with no cookie)', async () => {
    const response = await app.request(`/api/shared/${listenerShareToken}/visit`, { method: 'POST' }, env)
    expect(response.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- src/routes/shared-with-me.test.ts`
Expected: FAIL — 404s where 204 is expected (routes don't exist yet, so Hono falls through to a 404 for the unmatched path).

- [ ] **Step 3: Update `shared.ts`'s Hono generic and imports**

In `backend/src/routes/shared.ts`, change the top of the file from:

```typescript
import { Hono } from 'hono'
import type { Env } from '../env'
import { getListenerByShareToken, getListener, getListenersByProject } from '../listeners.repo'
import { getProjectByShareToken } from '../projects.repo'
import { getRequests } from '../requests.repo'

export const sharedRoutes = new Hono<{ Bindings: Env }>()
```

to:

```typescript
import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import { getListenerByShareToken, getListener, getListenersByProject } from '../listeners.repo'
import { getProjectByShareToken } from '../projects.repo'
import { getRequests } from '../requests.repo'
import { recordSharedVisit } from '../shared-with-me.repo'

export const sharedRoutes = new Hono<{ Bindings: Env; Variables: Variables }>()
```

(`Variables` is needed to call `c.get('email')`, the same pattern already used in `routes/listeners.ts` and `routes/projects.ts`.)

- [ ] **Step 4: Add the two visit-recording routes**

Add to the end of `backend/src/routes/shared.ts`:

```typescript
sharedRoutes.post('/api/shared/:token/visit', async (c) => {
  const listener = await getListenerByShareToken(c.env.DB, c.req.param('token'))
  if (!listener) {
    return c.json({ error: 'share link not found' }, 404)
  }
  await recordSharedVisit(c.env.DB, c.get('email'), 'listener', c.req.param('token'), new Date().toISOString())
  return c.body(null, 204)
})

sharedRoutes.post('/api/shared/projects/:token/visit', async (c) => {
  const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
  if (!project) {
    return c.json({ error: 'share link not found' }, 404)
  }
  await recordSharedVisit(c.env.DB, c.get('email'), 'project', c.req.param('token'), new Date().toISOString())
  return c.body(null, 204)
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npm test -- src/routes/shared-with-me.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Run the full backend suite to check for regressions**

Run: `cd backend && npm test`
Expected: PASS, except the pre-existing unrelated failure in `src/app.session.test.ts` (a `Domain=` cookie assertion failure that predates this plan — confirmed via `git stash` before this work began). No other failures.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/shared.ts backend/src/routes/shared-with-me.test.ts
git commit -m "feat(backend): add POST endpoints to record shared-link visits"
```

---

### Task 3: List and remove routes

**Files:**
- Modify: `backend/src/routes/shared.ts`
- Modify: `backend/src/routes/shared-with-me.test.ts`

**Interfaces:**
- Consumes: `listSharedWithMe`, `removeSharedWithMe` from Task 1; `getListenerByShareToken`, `getProjectByShareToken` (already imported in `shared.ts` from Task 2).
- Produces: `GET /api/shared-with-me` → `{ kind: 'listener' | 'project'; token: string; label: string | null; createdAt: string; url: string }[]`; `DELETE /api/shared-with-me/:kind/:token` → `204`.

- [ ] **Step 1: Write the failing route tests**

Append to `backend/src/routes/shared-with-me.test.ts` (inside the existing `describe` block, after the last `it(...)`):

```typescript
  describe('GET /api/shared-with-me and DELETE /api/shared-with-me/:kind/:token', () => {
    it('lists a recorded listener visit with its live label', async () => {
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, viewerEmail) }, env)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { kind: string; token: string; url: string }[]
      expect(body).toEqual([
        expect.objectContaining({ kind: 'listener', token: listenerShareToken, url: `/shared/${listenerShareToken}` }),
      ])
    })

    it('lists a recorded project visit with its live label', async () => {
      await app.request(
        `/api/shared/projects/${projectShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, viewerEmail) }, env)
      const body = (await response.json()) as { kind: string; token: string; url: string }[]
      expect(body).toEqual([
        expect.objectContaining({
          kind: 'project',
          token: projectShareToken,
          url: `/shared/projects/${projectShareToken}`,
        }),
      ])
    })

    it('excludes an entry once its token is revoked', async () => {
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      await app.request(
        `/api/listeners/${listenerId}/share`,
        { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
        env
      )

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, viewerEmail) }, env)
      expect(await response.json()).toEqual([])
    })

    it('excludes an entry whose resolved owner is the viewer themselves', async () => {
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
        env
      )

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, ownerEmail) }, env)
      expect(await response.json()).toEqual([])
    })

    it('DELETE removes an entry, and it drops out of the next GET', async () => {
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )

      const deleteResponse = await app.request(
        `/api/shared-with-me/listener/${listenerShareToken}`,
        { method: 'DELETE', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      expect(deleteResponse.status).toBe(204)

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, viewerEmail) }, env)
      expect(await response.json()).toEqual([])
    })

    it('DELETE returns 204 even for a token the viewer never visited', async () => {
      const response = await app.request(
        '/api/shared-with-me/listener/never-visited-token',
        { method: 'DELETE', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      expect(response.status).toBe(204)
    })

    it('revisiting after removal clears removed_at and it reappears in GET', async () => {
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      await app.request(
        `/api/shared-with-me/listener/${listenerShareToken}`,
        { method: 'DELETE', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, viewerEmail) }, env)
      const body = (await response.json()) as { token: string }[]
      expect(body.map((r) => r.token)).toContain(listenerShareToken)
    })

    it('one viewer removing an entry does not affect another viewer who also visited it', async () => {
      const otherViewerEmail = 'other-viewer@nice.com'
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, otherViewerEmail) },
        env
      )
      await app.request(
        `/api/shared-with-me/listener/${listenerShareToken}`,
        { method: 'DELETE', headers: await authCookieHeader(env, viewerEmail) },
        env
      )

      const otherResponse = await app.request(
        '/api/shared-with-me',
        { headers: await authCookieHeader(env, otherViewerEmail) },
        env
      )
      const otherBody = (await otherResponse.json()) as { token: string }[]
      expect(otherBody.map((r) => r.token)).toContain(listenerShareToken)
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- src/routes/shared-with-me.test.ts`
Expected: FAIL — the new routes don't exist yet (404s where 200/204 expected).

- [ ] **Step 3: Add `listSharedWithMe`/`removeSharedWithMe` to the imports**

In `backend/src/routes/shared.ts`, change:

```typescript
import { recordSharedVisit } from '../shared-with-me.repo'
```

to:

```typescript
import { recordSharedVisit, listSharedWithMe, removeSharedWithMe } from '../shared-with-me.repo'
```

- [ ] **Step 4: Add the list and remove routes**

Add to the end of `backend/src/routes/shared.ts`:

```typescript
sharedRoutes.get('/api/shared-with-me', async (c) => {
  const viewerEmail = c.get('email')
  const rows = await listSharedWithMe(c.env.DB, viewerEmail)

  const entries = await Promise.all(
    rows.map(async (row) => {
      if (row.kind === 'listener') {
        const listener = await getListenerByShareToken(c.env.DB, row.token)
        if (!listener || listener.ownerEmail === viewerEmail) return null
        return {
          kind: 'listener' as const,
          token: row.token,
          label: listener.label ?? listener.slug,
          createdAt: listener.createdAt,
          url: `/shared/${row.token}`,
        }
      }
      const project = await getProjectByShareToken(c.env.DB, row.token)
      if (!project || project.ownerEmail === viewerEmail) return null
      return {
        kind: 'project' as const,
        token: row.token,
        label: project.label,
        createdAt: project.createdAt,
        url: `/shared/projects/${row.token}`,
      }
    })
  )

  return c.json(entries.filter((entry) => entry !== null))
})

sharedRoutes.delete('/api/shared-with-me/:kind/:token', async (c) => {
  const kind = c.req.param('kind')
  if (kind !== 'listener' && kind !== 'project') {
    return c.json({ error: 'kind must be "listener" or "project"' }, 400)
  }
  await removeSharedWithMe(c.env.DB, c.get('email'), kind, c.req.param('token'), new Date().toISOString())
  return c.body(null, 204)
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npm test -- src/routes/shared-with-me.test.ts`
Expected: PASS (13 tests total in the file)

- [ ] **Step 6: Run the full backend suite to check for regressions**

Run: `cd backend && npm test`
Expected: PASS, except the same pre-existing `app.session.test.ts` failure noted in Task 2.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/shared.ts backend/src/routes/shared-with-me.test.ts
git commit -m "feat(backend): add list and remove endpoints for shared-with-me"
```

---

### Task 4: Frontend — record a visit from each shared page

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/pages/SharedListener.tsx`
- Modify: `frontend/src/pages/SharedProject.tsx`
- Modify: `frontend/src/pages/SharedProjectListener.tsx`

**Interfaces:**
- Consumes: `API_BASE_URL`, `ApiError`, `parseJsonOrThrow` pattern already in `api.ts`.
- Produces:
  - `export function recordSharedListenerVisit(token: string): Promise<void>`
  - `export function recordSharedProjectVisit(token: string): Promise<void>`

No automated tests for this task (established project scope — frontend has no test framework). Verified manually in Step 4 below and again end-to-end after Task 5.

- [ ] **Step 1: Add the two API functions**

In `frontend/src/api.ts`, add after `getSharedRequests` (existing function, currently ending around line 155):

```typescript
export async function recordSharedListenerVisit(token: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/shared/${token}/visit`, { method: 'POST', credentials: 'include' }).catch(() => {})
}

export async function recordSharedProjectVisit(token: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/shared/projects/${token}/visit`, { method: 'POST', credentials: 'include' }).catch(
    () => {}
  )
}
```

These swallow all failures (network error or non-2xx) — recording a visit is incidental to viewing a share, and must never surface an error or block the read-only view (spec: "Error handling").

- [ ] **Step 2: Wire the listener visit call into `SharedListener.tsx`**

In `frontend/src/pages/SharedListener.tsx`, change the import line:

```typescript
import { ApiError, type RequestDetail, getSharedRequests } from '../api'
```

to:

```typescript
import { ApiError, type RequestDetail, getSharedRequests, recordSharedListenerVisit } from '../api'
```

Then add a new effect right after the existing `const filteredRequests = useMemo(...)` block and before `const previousByRequestId = useMemo(...)` (i.e. among the other hooks, before the `refresh` callback):

```typescript
  useEffect(() => {
    if (token) recordSharedListenerVisit(token)
  }, [token])
```

- [ ] **Step 3: Wire the project visit call into `SharedProject.tsx`**

In `frontend/src/pages/SharedProject.tsx`, change the import line:

```typescript
import { ApiError, getSharedProject, type SharedProjectListener } from '../api'
```

to:

```typescript
import { ApiError, getSharedProject, recordSharedProjectVisit, type SharedProjectListener } from '../api'
```

Then add, right after the `consecutiveNotFoundRef` declaration and before the `refresh` callback:

```typescript
  useEffect(() => {
    if (token) recordSharedProjectVisit(token)
  }, [token])
```

- [ ] **Step 4: Wire the project visit call into `SharedProjectListener.tsx`**

A listener nested inside a shared project still counts as visiting the *project* share (spec: "Recording a visit" — no separate endpoint for the nested view).

In `frontend/src/pages/SharedProjectListener.tsx`, change the import line:

```typescript
import { ApiError, type RequestDetail, getSharedProjectListenerRequests } from '../api'
```

to:

```typescript
import { ApiError, type RequestDetail, getSharedProjectListenerRequests, recordSharedProjectVisit } from '../api'
```

Then add, right after the `consecutiveNotFoundRef` declaration and before the `refresh` callback:

```typescript
  useEffect(() => {
    if (token) recordSharedProjectVisit(token)
  }, [token])
```

- [ ] **Step 5: Build and manually verify**

Run: `cd frontend && npm run build`
Expected: builds cleanly with no type errors.

Manual check (requires `backend` running locally per the project's `.dev.vars` setup described in the root `CLAUDE.md`): create a listener, get its share link, open `/shared/:token` in a browser signed in with an allow-listed email, then query the local D1 DB for a new `shared_with_me` row:

```bash
cd backend && npx wrangler d1 execute webhook-listener --local --command "SELECT * FROM shared_with_me"
```

Expected: one row with `kind = 'listener'` and the visited token.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.ts frontend/src/pages/SharedListener.tsx frontend/src/pages/SharedProject.tsx frontend/src/pages/SharedProjectListener.tsx
git commit -m "feat(frontend): record a shared-with-me visit on each shared page"
```

---

### Task 5: Frontend — "Shared with me" section on Home

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/pages/Home.tsx`

**Interfaces:**
- Consumes: `API_BASE_URL`, `ApiError`, `parseJsonOrThrow` (from `api.ts`, same as Task 4).
- Produces:
  - `export interface SharedWithMeEntry { kind: 'listener' | 'project'; token: string; label: string | null; createdAt: string; url: string }`
  - `export function listSharedWithMe(): Promise<SharedWithMeEntry[]>`
  - `export async function removeSharedWithMe(kind: 'listener' | 'project', token: string): Promise<void>`

No automated tests for this task (established project scope). Verified manually in Step 4.

- [ ] **Step 1: Add the API type and functions**

In `frontend/src/api.ts`, add after the `recordSharedProjectVisit` function added in Task 4:

```typescript
export interface SharedWithMeEntry {
  kind: 'listener' | 'project'
  token: string
  label: string | null
  createdAt: string
  url: string
}

export function listSharedWithMe(): Promise<SharedWithMeEntry[]> {
  return fetch(`${API_BASE_URL}/api/shared-with-me`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<SharedWithMeEntry[]>(r)
  )
}

export async function removeSharedWithMe(kind: 'listener' | 'project', token: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/shared-with-me/${kind}/${token}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}
```

- [ ] **Step 2: Add state and a fetch effect to `Home.tsx`**

In `frontend/src/pages/Home.tsx`, change the import line:

```typescript
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
```

to:

```typescript
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
```

Then, add a new state field next to the existing `listeners`/`projects` state (right after `const [projects, setProjects] = useState<Project[]>([])`):

```typescript
  const [sharedWithMe, setSharedWithMe] = useState<SharedWithMeEntry[]>([])
```

Then add a new effect right after the existing `useEffect` that calls `Promise.all([listListeners(sort), listProjects()])`:

```typescript
  useEffect(() => {
    listSharedWithMe()
      .then(setSharedWithMe)
      .catch(() => {
        // Same as the owned-items list above: a failed fetch is a nice-to-have
        // miss, not a blocker for the rest of Home.
      })
  }, [])
```

Then add a handler function near `handleSortChange` (after it):

```typescript
  function handleRemoveSharedWithMe(kind: 'listener' | 'project', token: string) {
    setSharedWithMe((current) => current.filter((entry) => !(entry.kind === kind && entry.token === token)))
    removeSharedWithMe(kind, token).catch(() => {
      // Best-effort optimistic removal; a failed DELETE just means the entry
      // reappears on the next Home load, which is an acceptable degradation
      // for a personal declutter action.
    })
  }
```

- [ ] **Step 3: Render the new section**

In `frontend/src/pages/Home.tsx`, find the closing `</main>` tag at the end of the component's returned JSX. Add the new section immediately before it (after the existing `{items.length > 0 && ( ... )}` block that renders the sortable grid):

```typescript
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
```

- [ ] **Step 4: Build and manually verify**

Run: `cd frontend && npm run build`
Expected: builds cleanly with no type errors.

Manual check (backend running locally, two allow-listed test emails available):
1. Sign in as email A, create a listener, get its share link.
2. Sign in as email B (different browser profile or after signing out), open the share link — confirm the tier-0 gate lets it through, then the read-only view loads.
3. Reload Home as email B — confirm the "Shared with me" section shows the listener.
4. Sign in as email A again — confirm the section does *not* show that listener (it's email A's own item, filtered out by the owner-email check).
5. As email A, revoke the listener's share link (from `Listener.tsx`'s existing share controls). Reload Home as email B — confirm the entry is gone.
6. Repeat steps 1–3 with a project share link instead of a listener share link.
7. As email B, click the × control on an entry — confirm it disappears from Home immediately, then revisit the same share link and confirm it reappears in the list on the next Home load.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/pages/Home.tsx
git commit -m "feat(frontend): add Shared with me section to Home"
```

---

## Self-Review Notes

- **Spec coverage:** Data model (Task 1), recording (Task 2 + Task 4), listing/removing (Task 3 + Task 5), frontend section (Task 5), error handling (404-on-record in Task 2, always-204-on-delete in Task 3, silent-failure-on-fetch in Task 4/5) — all covered. Testing section's backend cases map 1:1 onto Task 1/2/3 test files; frontend manual steps map onto Task 4/5 Step 4/5 verification.
- **Placeholder scan:** no TBDs; every step has literal code or an exact command.
- **Type consistency:** `SharedWithMeKind`/`SharedWithMeRow` (Task 1) match the types consumed in Task 2/3's route handlers; `SharedWithMeEntry` (Task 5, frontend) matches the exact JSON shape produced by `GET /api/shared-with-me` in Task 3 (`kind`, `token`, `label`, `createdAt`, `url`).
