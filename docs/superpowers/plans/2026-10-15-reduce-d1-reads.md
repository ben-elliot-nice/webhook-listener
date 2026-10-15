# Reduce D1 rows-read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut steady-state D1 rows-read by pausing hidden/idle pollers, replacing `ProjectDetail`'s fetch-100-and-filter with a project-scoped bounded endpoint, capping and caching the shared project list, and pruning requests on ~1 in 10 captures instead of every capture.

**Architecture:** Backend gets one new endpoint (`GET /api/projects/:id`), a shared in-isolate TTL cache for the shared project list, a `hasMore`/cap on that list, and a modulo guard on the prune `DELETE`. Frontend gets one framework-free poller (`lib/poller.ts`, unit-testable) wrapped by a `usePolling` hook that replaces five hand-rolled poll loops. All changes are additive; no migration.

**Tech Stack:** Cloudflare Workers + Hono + D1 (vitest + `@cloudflare/vitest-pool-workers`), React 18 + Vite + TypeScript (vitest added for the frontend in Task 4).

**Spec:** `docs/superpowers/specs/2026-10-15-reduce-d1-reads-design.md`

## Global Constraints

- Poll interval while visible: **5000 ms**. Idle pause after **600000 ms** (10 min) without user interaction. Hidden tab: no polling.
- Project children and shared project list cap: **100** listeners, fetched as 101 to derive `hasMore`. **No `COUNT(*)`.**
- Shared project list cache: in-isolate `Map`, keyed by **project id**, **10 s** TTL, max **200** entries, stores listener rows only (never a `Response`, never the token/project). The token → project lookup (`getProjectByShareToken`) runs on every request and is never cached.
- Do **not** use the edge Cache API anywhere (session `Set-Cookie` / per-request CORS leak risk).
- Prune guard: `last_insert_rowid() % 10 = 0`. `RETENTION_LIMIT` stays 200 and read paths still cap at 200.
- Existing endpoints and response shapes stay backward compatible (additive only). No D1 migration.
- Commits: Conventional Commits; stage with `git add` in one command, then `git commit` in a separate command. Never `--no-verify`. If the commit hook fails with a Bitwarden/GitGuardian header-parsing error, stop and ask the user to unlock `bw`.
- Python is not used in this plan. Never use bare `python`/`pip`; if needed use `uv`.
- Model rule (repo CLAUDE.md): any subagent used to execute or review this plan must be **Sonnet** — never Opus or Fable.
- Work in the worktree `/Users/Ben.Elliot/repos/webhook-listener-d1reads` on branch `fix/reduce-d1-reads`. It needs `backend/.dev.vars` copied from `/Users/Ben.Elliot/repos/webhook-listener/backend/.dev.vars` (gitignored) and `npm ci` in `backend/` and `frontend/` before running tests. One backend test (`app.session.test.ts` cookie `Domain`) fails on a clean `main` because of that `.dev.vars` — ignore that single known failure.

## File Structure

Backend (`backend/src/`):
- `requests.repo.ts` — modify: prune guard (Task 1).
- `requests.repo.test.ts` — modify: retention bound tests (Task 1).
- `listeners.repo.ts` — modify: export `parseSortMode`, `PROJECT_LISTENERS_LIMIT`; add `getListenersByProjectSorted`; remove `getListenersByProject` (Tasks 2–3).
- `routes/listeners.ts` — modify: import `parseSortMode` instead of local copy (Task 2).
- `routes/projects.ts` — modify: add `GET /api/projects/:id` (Task 2).
- `routes/projects.detail.test.ts` — create (Task 2).
- `ttlCache.ts` / `ttlCache.test.ts` — create: tiny generic TTL cache (Task 3).
- `sharedProjectListeners.ts` — create: cached shared-list fetch (Task 3).
- `routes/shared.ts` — modify: use it, return `hasMore` (Task 3).
- `routes/shared.projects.test.ts` — modify: add cap/cache/revocation tests (Task 3).

Frontend (`frontend/`):
- `package.json`, `src/lib/poller.ts`, `src/lib/poller.test.ts`, `src/hooks/usePolling.ts`, `src/components/PollingPausedNote.tsx` — create/modify (Task 4).
- `../.github/workflows/pr.yml` — modify: run frontend tests in CI (Task 4).
- `src/api.ts`, `src/pages/ProjectDetail.tsx`, `src/pages/SharedProject.tsx`, `src/pages/Listener.tsx`, `src/pages/SharedListener.tsx`, `src/pages/SharedProjectListener.tsx` — modify (Task 5).

---

### Task 1: Prune guard

**Files:**
- Modify: `backend/src/requests.repo.ts:34-51`
- Test: `backend/src/requests.repo.test.ts`

**Interfaces:**
- Consumes: existing `insertRequest(db, req)`, `getRequests(db, listenerId)`, `createListener(db, id, createdAt, ownerEmail)` (signature is `(db, id, createdAt, ownerEmail)`; existing tests pass a session-like string, copy their style).
- Produces: unchanged public API. Behaviour: the prune `DELETE` only runs when the just-inserted row's id is a multiple of 10.

- [ ] **Step 1: Write the failing test**

Add inside the `describe('requests repo', ...)` block in `backend/src/requests.repo.test.ts`:

```ts
  it('prunes on roughly 1 in 10 captures, keeping a listener within 200..209 rows and never dropping the newest', async () => {
    const boundedListenerId = 'listener-bounded'
    await createListener(
      env.DB,
      boundedListenerId,
      '2024-01-01T00:00:00.000Z',
      'session-a',
    )

    let maxCount = 0
    const total = 430
    for (let i = 0; i < total; i++) {
      await insertRequest(env.DB, {
        listenerId: boundedListenerId,
        method: 'POST',
        headers: '{}',
        queryParams: '{}',
        body: `bounded-${i}`,
        contentType: 'text/plain',
        sourceIp: '127.0.0.1',
        receivedAt: `2024-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(
          i % 60,
        ).padStart(2, '0')}.000Z`,
      })
      const row = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM requests WHERE listener_id = ?',
      )
        .bind(boundedListenerId)
        .first<{ n: number }>()
      const count = row!.n
      if (i >= 200) {
        expect(count).toBeGreaterThanOrEqual(200)
        expect(count).toBeLessThanOrEqual(209)
      }
      maxCount = Math.max(maxCount, count)
    }

    // Proves the prune is NOT running on every capture (old behaviour kept it at exactly 200).
    expect(maxCount).toBeGreaterThan(200)

    const newest = await getRequests(env.DB, boundedListenerId)
    expect(newest).toHaveLength(200)
    expect(newest[0].body).toBe(`bounded-${total - 1}`)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/requests.repo.test.ts -t "prunes on roughly 1 in 10"`
Expected: FAIL on `expect(maxCount).toBeGreaterThan(200)` (current code prunes every capture so the max count is exactly 200).

- [ ] **Step 3: Write minimal implementation**

In `backend/src/requests.repo.ts`, replace the `prune` statement:

```ts
  // Prune only when the row just inserted has an id divisible by PRUNE_EVERY.
  // `last_insert_rowid()` inside db.batch() refers to the INSERT above (batch
  // statements share one connection/transaction). Request ids are global
  // across listeners, so a given listener is pruned roughly 1 in PRUNE_EVERY
  // captures and may briefly exceed RETENTION_LIMIT; read paths still cap at
  // RETENTION_LIMIT. This replaced a per-capture prune that was ~18% of D1
  // rows read.
  const prune = db
    .prepare(
      `DELETE FROM requests
       WHERE listener_id = ?
         AND last_insert_rowid() % ? = 0
         AND id NOT IN (
           SELECT id FROM requests
           WHERE listener_id = ?
           ORDER BY received_at DESC, id DESC
           LIMIT ?
         )`,
    )
    .bind(req.listenerId, PRUNE_EVERY, req.listenerId, RETENTION_LIMIT)
```

And next to `RETENTION_LIMIT` add:

```ts
const RETENTION_LIMIT = 200
const PRUNE_EVERY = 10
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/requests.repo.test.ts`
Expected: all PASS, including the pre-existing `prunes older requests beyond the 200-row retention cap` (it asserts the *read* cap via `getRequests`, which still returns the newest 200 and drops `request-0..4`).

- [ ] **Step 5: Stage**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git add backend/src/requests.repo.ts backend/src/requests.repo.test.ts
```

- [ ] **Step 6: Commit**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git commit -m "perf(backend): prune request history on ~1 in 10 captures instead of every capture"
```

---

### Task 2: Project-scoped listing endpoint

**Files:**
- Modify: `backend/src/listeners.repo.ts` (add exports near `SORT_CLAUSES`, ~line 131-153)
- Modify: `backend/src/routes/listeners.ts:55-63` (remove local `VALID_SORTS`/`parseSortMode`, import from repo)
- Modify: `backend/src/routes/projects.ts` (add route after `GET /api/projects`, import `getListenersByProjectSorted`, `parseSortMode`)
- Create: `backend/src/routes/projects.detail.test.ts`

**Interfaces:**
- Consumes: `getProjectForOwner(db, id, email): Promise<ProjectRecord | undefined>`, `serializeProject(env, project)` (local to `routes/projects.ts`), `serializeListener(env, listener)` (exported from `routes/listeners.ts`), `createProjectListener(db, id, createdAt, ownerSession, ownerEmail, projectId, slug)` (tests only), `authCookieHeader(env, email)`.
- Produces:
  - `export const PROJECT_LISTENERS_LIMIT = 100` and `export function parseSortMode(raw: string | undefined): SortMode` in `listeners.repo.ts`.
  - `export async function getListenersByProjectSorted(db: Env['DB'], projectId: string, sort: SortMode, limit: number): Promise<{ listeners: ListenerRecord[]; hasMore: boolean }>` in `listeners.repo.ts`.
  - `GET /api/projects/:id?sort=<mode>` → `200 { ...serializeProject, listeners: Listener[], hasMore: boolean }` shaped as `{ project, listeners, hasMore }` (exact body: `{ project: <serializeProject>, listeners: <serializeListener[]>, hasMore: boolean }`), `404 { error: 'project not found' }` for unknown or foreign project.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/routes/projects.detail.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'
import { createProjectListener } from '../listeners.repo'

interface DetailBody {
  project: { id: string; label: string | null }
  listeners: { id: string; slug: string | null; projectId: string | null }[]
  hasMore: boolean
}

describe('GET /api/projects/:id', () => {
  const ownerEmail = 'owner@nice.com'
  const otherEmail = 'other@nice.com'
  let projectId: string

  async function createProjectFor(email: string): Promise<string> {
    const created = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, email) },
      env,
    )
    return ((await created.json()) as { id: string }).id
  }

  async function seedListeners(
    forProjectId: string,
    count: number,
    prefix = 'l',
  ) {
    for (let i = 0; i < count; i++) {
      await createProjectListener(
        env.DB,
        `${prefix}-${forProjectId}-${i}`,
        `2024-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(
          i % 60,
        ).padStart(2, '0')}.000Z`,
        null,
        ownerEmail,
        forProjectId,
        `${prefix}${String(i).padStart(3, '0')}`,
      )
    }
  }

  async function getDetail(id: string, query = '', email = ownerEmail) {
    return app.request(
      `/api/projects/${id}${query}`,
      { headers: await authCookieHeader(env, email) },
      env,
    )
  }

  beforeEach(async () => {
    projectId = await createProjectFor(ownerEmail)
  })

  it('returns the project, its listeners and hasMore=false for a small project', async () => {
    await seedListeners(projectId, 3)
    const response = await getDetail(projectId)
    expect(response.status).toBe(200)
    const body = (await response.json()) as DetailBody
    expect(body.project.id).toBe(projectId)
    expect(body.listeners).toHaveLength(3)
    expect(body.hasMore).toBe(false)
  })

  it('returns 404 for an unknown project id', async () => {
    const response = await getDetail('does-not-exist')
    expect(response.status).toBe(404)
  })

  it("returns 404 for another owner's project", async () => {
    const response = await getDetail(projectId, '', otherEmail)
    expect(response.status).toBe(404)
  })

  it('caps at 100 listeners and reports hasMore when 101 exist (newest first by default)', async () => {
    await seedListeners(projectId, 101)
    const body = (await (await getDetail(projectId)).json()) as DetailBody
    expect(body.listeners).toHaveLength(100)
    expect(body.hasMore).toBe(true)
    expect(body.listeners[0].slug).toBe('l100')
    expect(body.listeners.map((l) => l.slug)).not.toContain('l000')
  })

  it('reports hasMore=false at exactly 100 listeners', async () => {
    await seedListeners(projectId, 100)
    const body = (await (await getDetail(projectId)).json()) as DetailBody
    expect(body.listeners).toHaveLength(100)
    expect(body.hasMore).toBe(false)
  })

  it('applies the requested sort (name = alphabetical)', async () => {
    for (const slug of ['charlie', 'alpha', 'bravo']) {
      await createProjectListener(
        env.DB,
        `name-${slug}`,
        '2024-01-01T00:00:00.000Z',
        null,
        ownerEmail,
        projectId,
        slug,
      )
    }
    const body = (await (
      await getDetail(projectId, '?sort=name')
    ).json()) as DetailBody
    expect(body.listeners.map((l) => l.slug)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ])
  })

  it('falls back to the date sort for an unknown sort value', async () => {
    await seedListeners(projectId, 2)
    const response = await getDetail(projectId, '?sort=bogus')
    expect(response.status).toBe(200)
    const body = (await response.json()) as DetailBody
    expect(body.listeners.map((l) => l.slug)).toEqual(['l001', 'l000'])
  })

  it("never includes another project's listeners", async () => {
    const otherProjectId = await createProjectFor(ownerEmail)
    await seedListeners(projectId, 2, 'mine')
    await seedListeners(otherProjectId, 2, 'theirs')
    const body = (await (await getDetail(projectId)).json()) as DetailBody
    expect(body.listeners.every((l) => l.projectId === projectId)).toBe(true)
    expect(body.listeners).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/routes/projects.detail.test.ts`
Expected: FAIL (the route does not exist → 404 for every request, `Cannot read properties` / status assertions fail; `getListenersByProjectSorted`/`PROJECT_LISTENERS_LIMIT` are not imported by the test but the route tests fail first).

- [ ] **Step 3: Implement repo additions**

In `backend/src/listeners.repo.ts`, directly after the `SORT_CLAUSES` constant, add:

```ts
export const PROJECT_LISTENERS_LIMIT = 100

const VALID_SORTS: SortMode[] = ['date', 'name', 'activity', 'custom']

export function parseSortMode(raw: string | undefined): SortMode {
  return (VALID_SORTS as string[]).includes(raw ?? '')
    ? (raw as SortMode)
    : 'date'
}

// Fetches limit + 1 rows to learn whether more exist without a COUNT(*)
// (which would read every child row on every poll).
export async function getListenersByProjectSorted(
  db: Env['DB'],
  projectId: string,
  sort: SortMode,
  limit: number,
): Promise<{ listeners: ListenerRecord[]; hasMore: boolean }> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM listeners WHERE project_id = ? ORDER BY ${SORT_CLAUSES[sort]} LIMIT ?`,
    )
    .bind(projectId, limit + 1)
    .all<ListenerRecord>()
  return {
    listeners: results.slice(0, limit),
    hasMore: results.length > limit,
  }
}
```

In `backend/src/routes/listeners.ts`, delete the local `VALID_SORTS` constant and `parseSortMode` function (lines ~57-63) and add `parseSortMode` to the existing import from `'../listeners.repo'` (the import block that already contains `getListenersForOwner`).

- [ ] **Step 4: Implement the route**

In `backend/src/routes/projects.ts`, add `getListenersByProjectSorted`, `parseSortMode`, `PROJECT_LISTENERS_LIMIT` to the import from `'../listeners.repo'`, then add after the `projectRoutes.get('/api/projects', ...)` handler:

```ts
projectRoutes.get('/api/projects/:id', async (c) => {
  const project = await getProjectForOwner(
    c.env.DB,
    c.req.param('id'),
    c.get('email'),
  )
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }
  const { listeners, hasMore } = await getListenersByProjectSorted(
    c.env.DB,
    project.id,
    parseSortMode(c.req.query('sort')),
    PROJECT_LISTENERS_LIMIT,
  )
  return c.json({
    project: serializeProject(c.env, project),
    listeners: listeners.map((listener) => serializeListener(c.env, listener)),
    hasMore,
  })
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/projects.detail.test.ts src/routes/listeners.list.test.ts src/routes/projects.test.ts`
Expected: all PASS (the owner list tests confirm `parseSortMode` still behaves the same after the move).

- [ ] **Step 6: Stage**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git add backend/src/listeners.repo.ts backend/src/routes/listeners.ts backend/src/routes/projects.ts backend/src/routes/projects.detail.test.ts
```

- [ ] **Step 7: Commit**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git commit -m "feat(backend): add bounded GET /api/projects/:id with sort and hasMore"
```

---

### Task 3: Shared project list — cap, hasMore, isolate cache

**Files:**
- Create: `backend/src/ttlCache.ts`, `backend/src/ttlCache.test.ts`
- Create: `backend/src/sharedProjectListeners.ts`
- Modify: `backend/src/routes/shared.ts:1-10,58-75`
- Modify: `backend/src/listeners.repo.ts` (remove `getListenersByProject`, lines 63-74)
- Modify: `backend/src/routes/shared.projects.test.ts`

**Interfaces:**
- Consumes: `getListenersByProjectSorted(db, projectId, sort, limit)` and `PROJECT_LISTENERS_LIMIT` from Task 2; `getProjectByShareToken(db, token)`.
- Produces:
  - `createTtlCache<V>(options: { ttlMs: number; maxEntries: number; now?: () => number }): TtlCache<V>` with `get(key): V | undefined`, `set(key, value): void`, `clear(): void`.
  - `getSharedProjectListeners(db: Env['DB'], projectId: string): Promise<{ listeners: ListenerRecord[]; hasMore: boolean }>` and `clearSharedProjectListenersCache(): void` in `sharedProjectListeners.ts`.
  - `GET /api/shared/projects/:token` response gains `hasMore: boolean` (existing fields unchanged; listener entries still exactly `id,label,slug,createdAt`).

- [ ] **Step 1: Write the failing cache unit test**

Create `backend/src/ttlCache.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createTtlCache } from './ttlCache'

describe('createTtlCache', () => {
  it('returns a stored value until the TTL elapses', () => {
    let now = 1000
    const cache = createTtlCache<string>({
      ttlMs: 10,
      maxEntries: 5,
      now: () => now,
    })
    cache.set('a', 'one')
    expect(cache.get('a')).toBe('one')
    now = 1009
    expect(cache.get('a')).toBe('one')
    now = 1010
    expect(cache.get('a')).toBeUndefined()
  })

  it('evicts the oldest entry when over maxEntries', () => {
    const cache = createTtlCache<number>({
      ttlMs: 1000,
      maxEntries: 2,
      now: () => 0,
    })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('refreshes TTL and recency when a key is set again', () => {
    let now = 0
    const cache = createTtlCache<number>({
      ttlMs: 10,
      maxEntries: 2,
      now: () => now,
    })
    cache.set('a', 1)
    cache.set('b', 2)
    now = 5
    cache.set('a', 11)
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(11)
  })

  it('clear removes everything', () => {
    const cache = createTtlCache<number>({ ttlMs: 10, maxEntries: 2 })
    cache.set('a', 1)
    cache.clear()
    expect(cache.get('a')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/ttlCache.test.ts`
Expected: FAIL — cannot resolve `./ttlCache`.

- [ ] **Step 3: Implement the cache**

Create `backend/src/ttlCache.ts`:

```ts
export interface TtlCache<V> {
  get(key: string): V | undefined
  set(key: string, value: V): void
  clear(): void
}

export function createTtlCache<V>(options: {
  ttlMs: number
  maxEntries: number
  now?: () => number
}): TtlCache<V> {
  const now = options.now ?? Date.now
  const entries = new Map<string, { value: V; expiresAt: number }>()

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= now()) {
        entries.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key, value) {
      // delete-then-set moves the key to the end, so insertion order is
      // recency order and the first key is always the oldest.
      entries.delete(key)
      entries.set(key, { value, expiresAt: now() + options.ttlMs })
      while (entries.size > options.maxEntries) {
        const oldest = entries.keys().next().value as string
        entries.delete(oldest)
      }
    },
    clear() {
      entries.clear()
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run src/ttlCache.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing route tests**

In `backend/src/routes/shared.projects.test.ts`, add to the imports:

```ts
import { createProjectListener } from '../listeners.repo'
import { clearSharedProjectListenersCache } from '../sharedProjectListeners'
```

Add `clearSharedProjectListenersCache()` as the first statement inside the existing `beforeEach` of the `describe('shared project view', ...)` block, and add these tests inside that describe (they reuse `projectId`, `shareToken`, `ownerEmail`, `viewerEmail`, `listenerId` from the existing setup):

```ts
  it('includes hasMore=false for a small project', async () => {
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const body = (await response.json()) as { hasMore: boolean }
    expect(body.hasMore).toBe(false)
  })

  it('caps the list at 100 listeners and reports hasMore when more exist', async () => {
    for (let i = 0; i < 100; i++) {
      await createProjectListener(
        env.DB,
        `cap-${projectId}-${i}`,
        `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        null,
        ownerEmail,
        projectId,
        `cap${String(i).padStart(3, '0')}`,
      )
    }
    // 100 seeded + the 1 from beforeEach = 101
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const body = (await response.json()) as {
      listeners: unknown[]
      hasMore: boolean
    }
    expect(body.listeners).toHaveLength(100)
    expect(body.hasMore).toBe(true)
  })

  it('serves the child list from cache for repeat requests, until the cache is cleared', async () => {
    const fetchList = async () =>
      (await (
        await app.request(
          `/api/shared/projects/${shareToken}`,
          { headers: await authCookieHeader(env, viewerEmail) },
          env,
        )
      ).json()) as { listeners: { slug: string | null }[] }

    const first = await fetchList()
    expect(first.listeners).toHaveLength(1)

    await createProjectListener(
      env.DB,
      `late-${projectId}`,
      '2024-02-01T00:00:00.000Z',
      null,
      ownerEmail,
      projectId,
      'late-arrival',
    )

    const second = await fetchList()
    expect(second.listeners).toHaveLength(1) // still cached

    clearSharedProjectListenersCache()
    const third = await fetchList()
    expect(third.listeners).toHaveLength(2)
  })

  it('returns 404 immediately after the share link is revoked, even while the list is cached', async () => {
    const url = `/api/shared/projects/${shareToken}`
    const warm = await app.request(
      url,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(warm.status).toBe(200)

    await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )

    const after = await app.request(
      url,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(after.status).toBe(404)
  })
```

- [ ] **Step 6: Run to verify they fail**

Run: `cd backend && npx vitest run src/routes/shared.projects.test.ts`
Expected: FAIL — cannot resolve `../sharedProjectListeners`.

- [ ] **Step 7: Implement the cached fetch**

Create `backend/src/sharedProjectListeners.ts`:

```ts
import type { Env } from './env'
import {
  PROJECT_LISTENERS_LIMIT,
  getListenersByProjectSorted,
  type ListenerRecord,
} from './listeners.repo'
import { createTtlCache } from './ttlCache'

interface ProjectListeners {
  listeners: ListenerRecord[]
  hasMore: boolean
}

// In-isolate cache of a shared project's child listeners, keyed by project id.
// Deliberately caches data only (not a Response — session Set-Cookie / CORS
// headers must never be cached) and never caches the share-token lookup, so
// revoking a share link takes effect immediately. Per-isolate, so the hit rate
// is best-effort; staleness is bounded by the TTL.
const cache = createTtlCache<ProjectListeners>({
  ttlMs: 10_000,
  maxEntries: 200,
})

export async function getSharedProjectListeners(
  db: Env['DB'],
  projectId: string,
): Promise<ProjectListeners> {
  const cached = cache.get(projectId)
  if (cached) return cached
  const fresh = await getListenersByProjectSorted(
    db,
    projectId,
    'date',
    PROJECT_LISTENERS_LIMIT,
  )
  cache.set(projectId, fresh)
  return fresh
}

export function clearSharedProjectListenersCache(): void {
  cache.clear()
}
```

- [ ] **Step 8: Wire the route and remove the old repo function**

In `backend/src/routes/shared.ts`: remove `getListenersByProject` from the `'../listeners.repo'` import, add `import { getSharedProjectListeners } from '../sharedProjectListeners'`, and replace the project handler body:

```ts
sharedRoutes.get('/api/shared/projects/:token', async (c) => {
  const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
  if (!project) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const { listeners, hasMore } = await getSharedProjectListeners(
    c.env.DB,
    project.id,
  )
  return c.json({
    label: project.label,
    listeners: listeners.map((l) => ({
      id: l.id,
      label: l.label,
      slug: l.slug,
      createdAt: l.createdAt,
    })),
    hasMore,
  })
})
```

In `backend/src/listeners.repo.ts`, delete the now-unused `getListenersByProject` function. First run `grep -rn "getListenersByProject\b" backend/src` — if any test still imports it, update that test to use `getListenersByProjectSorted(env.DB, id, 'date', 100)` and read `.listeners`.

- [ ] **Step 9: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: all PASS except the single known pre-existing failure `src/app.session.test.ts` (cookie `Domain` — fails on clean `main` due to `.dev.vars`). Also run `cd backend && npx tsc --noEmit` (or the repo's typecheck equivalent) and expect no errors.

- [ ] **Step 10: Stage**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git add backend/src/ttlCache.ts backend/src/ttlCache.test.ts backend/src/sharedProjectListeners.ts backend/src/routes/shared.ts backend/src/listeners.repo.ts backend/src/routes/shared.projects.test.ts
```

- [ ] **Step 11: Commit**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git commit -m "perf(backend): cap shared project list at 100 and cache it per isolate for 10s"
```

---

### Task 4: Frontend poller, hook, test runner

**Files:**
- Modify: `frontend/package.json` (add `vitest` devDependency and `test` script)
- Create: `frontend/src/lib/poller.ts`, `frontend/src/lib/poller.test.ts`
- Create: `frontend/src/hooks/usePolling.ts`
- Create: `frontend/src/components/PollingPausedNote.tsx`
- Modify: `.github/workflows/pr.yml` (add a frontend test step before "Build frontend")

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createPoller(tick: () => Promise<boolean>, options: PollerOptions, env: PollerEnv): Poller` where `PollerOptions = { intervalMs: number; idleMs: number; onPausedChange?: (paused: boolean) => void }`, `Poller = { start(): void; stop(): void }`, `PollerEnv = { isHidden(): boolean; now(): number; onVisibilityChange(l: () => void): () => void; onActivity(l: () => void): () => void }`; `browserPollerEnv: PollerEnv`.
  - `usePolling(tick: () => Promise<boolean>): { paused: boolean }` and constants `POLL_INTERVAL_MS = 5000`, `POLL_IDLE_MS = 600000` from `hooks/usePolling.ts`. `tick` resolving `false` stops polling permanently; a rejected tick counts as `true`.
  - `<PollingPausedNote />` (no props).

- [ ] **Step 1: Add the test runner**

Run: `cd frontend && npm install --save-dev vitest@^2` then edit `frontend/package.json` scripts to add `"test": "vitest run"` (keep existing scripts). Vitest picks up `vite.config.ts` automatically; tests here run in the default `node` environment (the poller takes its browser access via an injected `PollerEnv`, so no jsdom is needed).

- [ ] **Step 2: Write the failing poller tests**

Create `frontend/src/lib/poller.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPoller, type PollerEnv } from './poller'

function makeEnv() {
  let hidden = false
  let visibilityListeners: Array<() => void> = []
  let activityListeners: Array<() => void> = []
  const env: PollerEnv = {
    isHidden: () => hidden,
    now: () => Date.now(),
    onVisibilityChange: (listener) => {
      visibilityListeners.push(listener)
      return () => {
        visibilityListeners = visibilityListeners.filter((l) => l !== listener)
      }
    },
    onActivity: (listener) => {
      activityListeners.push(listener)
      return () => {
        activityListeners = activityListeners.filter((l) => l !== listener)
      }
    },
  }
  return {
    env,
    setHidden(value: boolean) {
      hidden = value
      visibilityListeners.slice().forEach((l) => l())
    },
    activity() {
      activityListeners.slice().forEach((l) => l())
    },
    listenerCount: () => visibilityListeners.length + activityListeners.length,
  }
}

const OPTIONS = { intervalMs: 5000, idleMs: 600000 }

describe('createPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks immediately on start, then every intervalMs', async () => {
    const { env } = makeEnv()
    const tick = vi.fn().mockResolvedValue(true)
    createPoller(tick, OPTIONS, env).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('does not tick while the tab is hidden, and ticks immediately when it becomes visible', async () => {
    const t = makeEnv()
    const tick = vi.fn().mockResolvedValue(true)
    createPoller(tick, OPTIONS, t.env).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)

    t.setHidden(true)
    await vi.advanceTimersByTimeAsync(60000)
    expect(tick).toHaveBeenCalledTimes(1)

    t.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('does not start ticking when started hidden until it becomes visible', async () => {
    const t = makeEnv()
    t.setHidden(true)
    const tick = vi.fn().mockResolvedValue(true)
    createPoller(tick, OPTIONS, t.env).start()
    await vi.advanceTimersByTimeAsync(30000)
    expect(tick).not.toHaveBeenCalled()
    t.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('pauses after idleMs without activity, reports it, and resumes with an immediate tick on activity', async () => {
    const t = makeEnv()
    const tick = vi.fn().mockResolvedValue(true)
    const onPausedChange = vi.fn()
    createPoller(tick, { ...OPTIONS, onPausedChange }, t.env).start()

    await vi.advanceTimersByTimeAsync(700000)
    expect(onPausedChange).toHaveBeenLastCalledWith(true)
    const callsWhenPaused = tick.mock.calls.length

    await vi.advanceTimersByTimeAsync(60000)
    expect(tick.mock.calls.length).toBe(callsWhenPaused)

    t.activity()
    await vi.advanceTimersByTimeAsync(0)
    expect(onPausedChange).toHaveBeenLastCalledWith(false)
    expect(tick.mock.calls.length).toBe(callsWhenPaused + 1)
  })

  it('activity before the idle limit keeps polling alive', async () => {
    const t = makeEnv()
    const tick = vi.fn().mockResolvedValue(true)
    const onPausedChange = vi.fn()
    createPoller(tick, { ...OPTIONS, onPausedChange }, t.env).start()

    await vi.advanceTimersByTimeAsync(500000)
    t.activity()
    await vi.advanceTimersByTimeAsync(300000) // 800s total, only 300s since activity
    expect(onPausedChange).not.toHaveBeenCalledWith(true)
    const before = tick.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick.mock.calls.length).toBe(before + 1)
  })

  it('never overlaps ticks, even if visibility toggles while one is in flight', async () => {
    const t = makeEnv()
    let resolveFirst: (value: boolean) => void = () => {}
    const tick = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValue(true)
    createPoller(tick, OPTIONS, t.env).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)

    t.setHidden(true)
    t.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1) // still the in-flight one

    resolveFirst(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('stops permanently when tick resolves false', async () => {
    const t = makeEnv()
    const tick = vi.fn().mockResolvedValue(false)
    createPoller(tick, OPTIONS, t.env).start()
    await vi.advanceTimersByTimeAsync(60000)
    expect(tick).toHaveBeenCalledTimes(1)
    expect(t.listenerCount()).toBe(0)
  })

  it('treats a rejected tick as keep-polling', async () => {
    const t = makeEnv()
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(true)
    createPoller(tick, OPTIONS, t.env).start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('stop() cancels the timer and unsubscribes', async () => {
    const t = makeEnv()
    const tick = vi.fn().mockResolvedValue(true)
    const poller = createPoller(tick, OPTIONS, t.env)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    poller.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(tick).toHaveBeenCalledTimes(1)
    expect(t.listenerCount()).toBe(0)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd frontend && npm test`
Expected: FAIL — cannot resolve `./poller`.

- [ ] **Step 4: Implement the poller**

Create `frontend/src/lib/poller.ts`:

```ts
export interface PollerEnv {
  isHidden: () => boolean
  now: () => number
  onVisibilityChange: (listener: () => void) => () => void
  onActivity: (listener: () => void) => () => void
}

export interface PollerOptions {
  intervalMs: number
  idleMs: number
  onPausedChange?: (paused: boolean) => void
}

export interface Poller {
  start: () => void
  stop: () => void
}

// Framework-free so it can be unit tested with fake timers. `tick` resolves
// true to keep polling, false to stop for good; a rejection keeps polling.
// Polling is paused while the tab is hidden, and after `idleMs` without user
// activity (resumed, with an immediate tick, on the next activity).
export function createPoller(
  tick: () => Promise<boolean>,
  options: PollerOptions,
  env: PollerEnv,
): Poller {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let stopped = true
  let idlePaused = false
  let lastActivity = 0
  let unsubscribers: Array<() => void> = []

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function setPaused(next: boolean) {
    if (idlePaused === next) return
    idlePaused = next
    options.onPausedChange?.(next)
  }

  function schedule() {
    clearTimer()
    if (stopped || env.isHidden()) return
    if (env.now() - lastActivity >= options.idleMs) {
      setPaused(true)
      return
    }
    timer = setTimeout(run, options.intervalMs)
  }

  async function run() {
    timer = undefined
    if (stopped || inFlight) return
    inFlight = true
    let keepGoing = true
    try {
      keepGoing = await tick()
    } catch {
      keepGoing = true
    }
    inFlight = false
    if (stopped) return
    if (!keepGoing) {
      stop()
      return
    }
    schedule()
  }

  function handleVisibility() {
    if (stopped) return
    if (env.isHidden()) {
      clearTimer()
      return
    }
    lastActivity = env.now()
    setPaused(false)
    if (timer === undefined && !inFlight) void run()
  }

  function handleActivity() {
    if (stopped) return
    lastActivity = env.now()
    if (idlePaused) {
      setPaused(false)
      if (!inFlight) void run()
    }
  }

  function start() {
    if (!stopped) return
    stopped = false
    lastActivity = env.now()
    unsubscribers = [
      env.onVisibilityChange(handleVisibility),
      env.onActivity(handleActivity),
    ]
    if (!env.isHidden()) void run()
  }

  function stop() {
    stopped = true
    clearTimer()
    unsubscribers.forEach((unsubscribe) => unsubscribe())
    unsubscribers = []
  }

  return { start, stop }
}

const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'scroll',
  'touchstart',
  'wheel',
] as const

// The activity handler is a single timestamp assignment on the hot path, so
// no throttling is needed.
export const browserPollerEnv: PollerEnv = {
  isHidden: () => document.hidden,
  now: () => Date.now(),
  onVisibilityChange: (listener) => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
  onActivity: (listener) => {
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, listener, { passive: true, capture: true })
    }
    return () => {
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, listener, { capture: true })
      }
    }
  },
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd frontend && npm test`
Expected: PASS (9 tests).

- [ ] **Step 6: Add the hook and the paused note**

Create `frontend/src/hooks/usePolling.ts`:

```ts
import { useEffect, useState } from 'react'
import { browserPollerEnv, createPoller } from '../lib/poller'

export const POLL_INTERVAL_MS = 5000
export const POLL_IDLE_MS = 10 * 60 * 1000

// Polls `tick` immediately and then every POLL_INTERVAL_MS while the tab is
// visible and the user has been active in the last POLL_IDLE_MS. `tick`
// resolving false stops polling for good. Restarts when `tick`'s identity
// changes (pass a useCallback'd function).
export function usePolling(tick: () => Promise<boolean>): { paused: boolean } {
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    setPaused(false)
    const poller = createPoller(
      tick,
      {
        intervalMs: POLL_INTERVAL_MS,
        idleMs: POLL_IDLE_MS,
        onPausedChange: setPaused,
      },
      browserPollerEnv,
    )
    poller.start()
    return poller.stop
  }, [tick])

  return { paused }
}
```

Create `frontend/src/components/PollingPausedNote.tsx`:

```tsx
export function PollingPausedNote() {
  return (
    <p
      role="status"
      className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      Live updates paused while inactive — move the mouse or press a key to
      resume.
    </p>
  )
}
```

- [ ] **Step 7: Run frontend tests in CI**

In `.github/workflows/pr.yml`, immediately before the `- name: Build frontend` step, add:

```yaml
      - name: Test frontend
        working-directory: frontend
        run: npm test

```

- [ ] **Step 8: Verify the frontend still builds**

Run: `cd frontend && npm run build`
Expected: success (nothing imports the new hook yet).

- [ ] **Step 9: Stage**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git add frontend/package.json frontend/package-lock.json frontend/src/lib/poller.ts frontend/src/lib/poller.test.ts frontend/src/hooks/usePolling.ts frontend/src/components/PollingPausedNote.tsx .github/workflows/pr.yml
```

- [ ] **Step 10: Commit**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git commit -m "feat(frontend): add visibility- and idle-aware poller with unit tests"
```

---

### Task 5: Adopt the poller and the bounded endpoints in the pages

**Files:**
- Modify: `frontend/src/api.ts` (add `getProject`, `ProjectDetailData`; add `hasMore` to `SharedProjectData`)
- Modify: `frontend/src/pages/ProjectDetail.tsx`
- Modify: `frontend/src/pages/SharedProject.tsx`
- Modify: `frontend/src/pages/Listener.tsx`, `frontend/src/pages/SharedListener.tsx`, `frontend/src/pages/SharedProjectListener.tsx`

**Interfaces:**
- Consumes: `usePolling(tick): { paused: boolean }` (Task 4), `<PollingPausedNote />` (Task 4), backend `GET /api/projects/:id?sort=` → `{ project, listeners, hasMore }` (Task 2), `GET /api/shared/projects/:token` → `{ label, listeners, hasMore }` (Task 3).
- Produces: no new public interfaces. (`api.ts` exports `getProject(id: string, sort?: SortMode): Promise<ProjectDetailData>` and `ProjectDetailData`.)

- [ ] **Step 1: api.ts**

In `frontend/src/api.ts`, next to `listListeners`, add:

```ts
export interface ProjectDetailData {
  project: Project
  listeners: Listener[]
  hasMore: boolean
}

export function getProject(
  id: string,
  sort: SortMode = 'date',
): Promise<ProjectDetailData> {
  return fetch(`${API_BASE_URL}/api/projects/${id}?sort=${sort}`, {
    credentials: 'include',
  }).then((r) => parseJsonOrThrow<ProjectDetailData>(r))
}
```

And change `SharedProjectData` to:

```ts
export interface SharedProjectData {
  label: string | null
  listeners: SharedProjectListener[]
  hasMore: boolean
}
```

(`parseJsonOrThrow` already throws `ApiError` with `.status` on non-2xx, which the pages rely on for 404 handling — confirm by reading it before relying on it.)

- [ ] **Step 2: The three request-feed pages**

In each of `Listener.tsx`, `SharedListener.tsx`, `SharedProjectListener.tsx`:
1. Delete `const POLL_INTERVAL_MS = 3000`.
2. Add `import { usePolling } from '../hooks/usePolling'` and `import { PollingPausedNote } from '../components/PollingPausedNote'`.
3. Replace the polling effect block (the `useEffect` containing `const timer = setInterval(async () => { const ok = await refresh() ... }, POLL_INTERVAL_MS)` and `refresh()`, through its `}, [refresh])`) with:

```tsx
  useEffect(() => {
    consecutiveNotFoundRef.current = 0
  }, [refresh])

  const { paused } = usePolling(refresh)
```

4. Render `{paused && <PollingPausedNote />}` as the first child of the primary (non-error/non-loading) `<main>` the component returns.
5. If `useEffect` is no longer needed elsewhere in the file the import stays valid (it is still used above); remove any now-unused imports so `tsc -b` stays clean.

- [ ] **Step 3: SharedProject**

In `frontend/src/pages/SharedProject.tsx`: delete `POLL_INTERVAL_MS`; import `usePolling` and `PollingPausedNote`; add `const [hasMore, setHasMore] = useState(false)`; in `refresh` add `setHasMore(data.hasMore)` right after `setListeners(data.listeners)`; replace the polling `useEffect` (the `setTimeout` chain through `}, [refresh])`) with:

```tsx
  const { paused } = usePolling(refresh)
```

Render `{paused && <PollingPausedNote />}` as the first child of the primary `<main>`, and render this immediately after the element that renders the `listeners.map(...)` list:

```tsx
{hasMore && (
  <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
    Showing the first 100 listeners — more exist.
  </p>
)}
```

- [ ] **Step 4: ProjectDetail**

In `frontend/src/pages/ProjectDetail.tsx`:
1. Delete `POLL_INTERVAL_MS`; in the `../api` import replace `listListeners, listProjects` with `getProject` (run `grep -n "listListeners\|listProjects" frontend/src/pages/ProjectDetail.tsx` first and keep any import still used elsewhere in the file; if either is used elsewhere, leave it in the import).
2. Import `usePolling` and `PollingPausedNote`.
3. Add `const [hasMore, setHasMore] = useState(false)`.
4. Replace the body of `refresh` from `const [projects, listeners] = await Promise.all([` through `return true` (just before `}, [projectId, sort])`) with:

```tsx
    let data
    try {
      data = await getProject(projectId, sort)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        consecutiveNotFoundRef.current += 1
        if (consecutiveNotFoundRef.current >= MAX_CONSECUTIVE_NOT_FOUND) {
          setNotFound(true)
          return false
        }
        return true
      }
      throw err
    }
    consecutiveNotFoundRef.current = 0
    setProject(data.project)
    setChildren(data.listeners)
    setHasMore(data.hasMore)
    return true
```

5. Replace the polling `useEffect` (the `setTimeout` chain through `}, [refresh])`) with `const { paused } = usePolling(refresh)`.
6. Render `{paused && <PollingPausedNote />}` as the first child of the primary `<main>`, and render the same "Showing the first 100 listeners — more exist." `<p>` (as in Step 3, using `hasMore`) directly after the `<ul>` that renders `children.map(...)`.

- [ ] **Step 5: Verify build and tests**

Run: `cd frontend && npm test && npm run build`
Expected: tests PASS; `tsc -b && vite build` succeeds with no unused-import or type errors.

- [ ] **Step 6: Stage**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git add frontend/src/api.ts frontend/src/pages/ProjectDetail.tsx frontend/src/pages/SharedProject.tsx frontend/src/pages/Listener.tsx frontend/src/pages/SharedListener.tsx frontend/src/pages/SharedProjectListener.tsx
```

- [ ] **Step 7: Commit**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git commit -m "perf(frontend): poll at 5s only while visible and active, and use the bounded project endpoint"
```

---

### Task 6: Docs, full verification, PR

**Files:**
- Modify: `STATUS.md` (only if it describes polling or request pruning — check first)
- Modify: `CLAUDE.md` (only to add one line under "Running it locally" that the frontend now has `npm test`)

**Interfaces:**
- Consumes: everything above.
- Produces: a PR with the `preview` label.

- [ ] **Step 1: Docs sweep**

Run: `grep -n -i "poll\|3 second\|3s\|prune\|retention" STATUS.md CLAUDE.md BACKLOG.md`
Update any statement that is now false (3-second polling → 5s visible/active only; per-capture prune → roughly every 10th capture; frontend has no tests → `npm test`). Keep edits minimal; if nothing is stale, skip.

- [ ] **Step 2: Full verification**

Run, and read the output:
- `cd backend && npm test` — expect all PASS except the known `src/app.session.test.ts` cookie `Domain` failure.
- `cd frontend && npm test && npm run build` — expect PASS.
- `cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && npx prettier --check $(git diff --name-only origin/main --diff-filter=ACMR | grep -E '\.(ts|tsx|md|yml|json)$')` — expect clean; if not, run `npx prettier --write` on those files and re-check.

- [ ] **Step 3: Stage docs/format fixes, then commit (skip if nothing changed)**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git add -A && git status --short
```

Then, in a separate command, if there are staged changes:

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git commit -m "docs: update polling and retention notes"
```

- [ ] **Step 4: Push and open the PR (ask the user first if they have not already approved this)**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-d1reads && git push -u origin fix/reduce-d1-reads
```

Then `gh pr create --base main --title "perf: reduce D1 rows-read (poll pausing, bounded project list, prune guard)" --label preview` with a body summarising the spec (`docs/superpowers/specs/2026-10-15-reduce-d1-reads-design.md`), the measured breakdown, and the post-release check: compare D1 `d1QueriesAdaptiveGroups` rows-read before/after; expect the `/api/listeners` share to fall sharply and the prune `DELETE` to drop ~90%.

- [ ] **Step 5: Preview checks (once the preview environment is up)**

In the preview frontend: open a project page and a shared project page; confirm (a) the network tab shows one `GET /api/projects/:id` per 5s (not `/api/listeners` + `/api/projects`), (b) switching to another tab stops requests and returning triggers one immediate request, (c) leaving the page untouched for 10 minutes pauses polling and shows the "Live updates paused" note, which clears on mouse move. Report what was and was not verified.
