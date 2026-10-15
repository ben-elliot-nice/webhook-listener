# Paginate listener lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every listener reachable on Home (standalone listeners) and on a project page (children) via infinite scroll, with index-backed keyset pagination so read cost per page stays ~page size.

**Architecture:** A new backend module (`listenersPaging.ts`) builds keyset queries (Date, Recent activity) and capped unpaged queries (Name, Custom, 500 max) for two scopes (a project's children, an owner's standalone listeners); two additive indexes serve them. Two endpoints expose it. The frontend gets a generic `usePaginatedList` hook, a `null`-interval mode for the poller (no timer polling for Name/Custom), and Home is restructured into a Projects section plus a paginated Listeners section.

**Tech Stack:** Cloudflare Workers + Hono + D1 (vitest + `@cloudflare/vitest-pool-workers`), React 18 + Vite + TypeScript (vitest, node env, already set up).

**Spec:** `docs/superpowers/specs/2026-10-15-paginate-listener-lists-design.md`

## Global Constraints

- Page size: default **50**, clamped to **100**. Name and Custom sorts are not paginated: cap **500** (fetch 501, return 500, `truncated` = more than 500 exist, `nextCursor` always `null`).
- Date order: `created_at DESC, id DESC`. Activity order: `COALESCE(last_request_at, '') DESC, created_at DESC, id DESC`. Name: `(COALESCE(label, slug) IS NULL), COALESCE(label, slug) COLLATE NOCASE ASC, created_at DESC, id DESC`. Custom: `(sort_position IS NULL), sort_position ASC, created_at DESC, id DESC`.
- Cursors are opaque base64url JSON carrying the sort name (`s`); a cursor for a different sort, malformed, or tampered cursor → HTTP **400** `{ error: 'invalid cursor' }`. Keyset `WHERE` is a redundant sargable leading bound plus the expanded form: `<k1> <= ? AND (k1 < ? OR (k1 = ? AND (k2 < ? OR (k2 = ? AND id < ?))))` (the expanded `OR` alone is NOT index-seekable — measured 502-952 rows read for a deep page vs 52 with the leading bound; row-value comparison is not sargable on the activity expression). Fetch `limit + 1` rows; **no `COUNT(*)`**.
- New indexes (migration `0013`): `idx_listeners_owner_standalone ON listeners(owner_email, project_id, created_at DESC, id DESC)` and `idx_listeners_project_activity ON listeners(project_id, COALESCE(last_request_at, '') DESC, created_at DESC, id DESC)`. The activity expression in queries must match the index expression text exactly (`COALESCE(last_request_at, '')`).
- Endpoints are additive: `GET /api/listeners` is untouched (bare array, newest 100); `GET /api/projects/:id` keeps `{ project, listeners, hasMore }` and adds `nextCursor` and `truncated` (`hasMore` = `nextCursor !== null || truncated`); new `GET /api/standalone-listeners` (owner-scoped, `project_id IS NULL`) returns `{ listeners, nextCursor, truncated }`. `SharedProject` and the shared endpoint are NOT changed.
- Polling: Date/Activity keep polling the first page (5000 ms visible, hidden/idle pause as shipped). Name/Custom use `intervalMs: null` (run on start and on each return to a visible tab, never on a timer). Home does not poll (as today).
- Home: Projects section (all projects from `GET /api/projects`, ordered client-side by their own fields; **activity sort falls back to `createdAt`**) above a Listeners section (standalone, paginated). Drag-reorder is Custom-sort only, within a section only, and is disabled when the list is `truncated`.
- No change to request-history prune, share/cookie handling, or the access model.
- Commits: Conventional Commits, header **<= 100 characters** (commitlint enforces this in CI); stage with `git add <specific files>` in one command (never `git add -A`; never stage `.superpowers/` or `backend/.dev.vars`), then `git commit` in a separate command. Never `--no-verify`. If the commit hook fails with a Bitwarden/GitGuardian header-parsing error, stop and ask the user to unlock `bw`.
- Python is not used. Never use bare `python`/`pip`/`python3`. Never use `/tmp` for scratch; use `~/scratch/`.
- Model rule (repo CLAUDE.md): any subagent used to execute or review this plan must be **Sonnet** — never Opus or Fable.
- Work in `/Users/Ben.Elliot/repos/webhook-listener-paging` on branch `feat/paginate-listener-lists`. `backend/.dev.vars` is copied and `npm ci` is done in `backend/` and `frontend/`. One backend test (`src/app.session.test.ts`, cookie `Domain`) fails on a clean `main` because of `.dev.vars` — ignore that single known failure.
- Do NOT push, open a PR, or apply anything to prod D1 — Task 6 stops for the user.

## File Structure

Backend (`backend/`):

- `migrations/0013_listener_paging_indexes.sql` — create (Task 1).
- `src/listenersPaging.ts` — create: cursor codec, query builder, `getListenersPage` (Task 1).
- `src/listenersPaging.test.ts` — create (Task 1).
- `src/listeners.repo.ts` — modify: export `SELECT_COLUMNS` (Task 1).
- `src/routes/projects.ts` — modify: paginate `GET /api/projects/:id` (Task 2).
- `src/routes/projects.detail.test.ts` — modify: adjust cap tests, add paging tests (Task 2).
- `src/routes/listeners.ts` — modify: add `GET /api/standalone-listeners` (Task 2).
- `src/routes/listeners.standalone.test.ts` — create (Task 2).

Frontend (`frontend/src/`):

- `lib/poller.ts`, `lib/poller.test.ts`, `hooks/usePolling.ts` — modify: `intervalMs: number | null` (Task 3).
- `lib/listPaging.ts`, `lib/listPaging.test.ts` — create: pure helpers (Task 3).
- `hooks/usePaginatedList.ts` — create (Task 3).
- `api.ts` — modify (Task 3).
- `pages/ProjectDetail.tsx` — modify (Task 4).
- `pages/Home.tsx` — modify; `lib/mergeHomeItems.ts` — delete (Task 5).
- `STATUS.md`, `CLAUDE.md` — docs (Task 6).

---

### Task 1: Paging query module and indexes (backend)

**Files:**

- Create: `backend/migrations/0013_listener_paging_indexes.sql`
- Create: `backend/src/listenersPaging.ts`
- Create: `backend/src/listenersPaging.test.ts`
- Modify: `backend/src/listeners.repo.ts` (export `SELECT_COLUMNS`)

**Interfaces:**

- Consumes: `ListenerRecord`, `SortMode` and `SELECT_COLUMNS` from `listeners.repo.ts` (`SELECT_COLUMNS` becomes exported here); `createListener(db, id, createdAt, ownerEmail)` and `createProjectListener(db, id, createdAt, ownerSession, ownerEmail, projectId, slug)` (tests); `createProject(db, id, createdAt, ownerEmail)` from `projects.repo.ts` (tests).
- Produces (all exported from `listenersPaging.ts`):
  - `PAGE_DEFAULT_LIMIT = 50`, `PAGE_MAX_LIMIT = 100`, `UNPAGED_CAP = 500`
  - `type ListScope = { kind: 'project'; projectId: string } | { kind: 'standalone'; email: string }`
  - `interface ListenersPage { listeners: ListenerRecord[]; nextCursor: string | null; truncated: boolean }`
  - `class InvalidCursorError extends Error`
  - `parsePageLimit(raw: string | undefined): number`
  - `encodeCursor(cursor: Cursor): string` with `type Cursor = { s: 'date'; c: string; id: string } | { s: 'activity'; a: string; c: string; id: string }`
  - `buildListenersPageQuery(scope: ListScope, sort: SortMode, cursor: string | undefined, limit: number): { sql: string; binds: unknown[]; fetchSize: number }` (throws `InvalidCursorError`)
  - `getListenersPage(db: Env['DB'], scope: ListScope, sort: SortMode, options: { cursor?: string; limit: number }): Promise<ListenersPage>`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/listenersPaging.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createListener, createProjectListener } from './listeners.repo'
import { createProject } from './projects.repo'
import {
  UNPAGED_CAP,
  InvalidCursorError,
  buildListenersPageQuery,
  encodeCursor,
  getListenersPage,
  parsePageLimit,
  type ListScope,
} from './listenersPaging'
import type { SortMode } from './listeners.repo'

const OWNER = 'owner@nice.com'
const OTHER = 'other@nice.com'
const BASE = '2024-01-01T00:00:00.000Z'

async function seedProject(id = 'proj-1'): Promise<string> {
  await createProject(env.DB, id, BASE, OWNER)
  return id
}

async function seedChild(
  projectId: string,
  id: string,
  createdAt: string,
  extra: { label?: string; lastRequestAt?: string } = {},
) {
  await createProjectListener(
    env.DB,
    id,
    createdAt,
    null,
    OWNER,
    projectId,
    `slug-${id}`,
  )
  if (extra.label !== undefined || extra.lastRequestAt !== undefined) {
    await env.DB.prepare(
      'UPDATE listeners SET label = ?, last_request_at = ? WHERE id = ?',
    )
      .bind(extra.label ?? null, extra.lastRequestAt ?? null, id)
      .run()
  }
}

function at(minute: number): string {
  return `2024-02-01T00:${String(minute).padStart(2, '0')}:00.000Z`
}

async function walk(
  scope: ListScope,
  sort: SortMode,
  limit: number,
): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  for (let i = 0; i < 60; i++) {
    const page = await getListenersPage(env.DB, scope, sort, { cursor, limit })
    ids.push(...page.listeners.map((l) => l.id))
    if (!page.nextCursor) return ids
    cursor = page.nextCursor
  }
  throw new Error('pagination did not terminate')
}

async function seedMany(projectId: string, count: number) {
  const statements = []
  for (let i = 0; i < count; i++) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO listeners (id, created_at, owner_email, project_id, slug) VALUES (?, ?, ?, ?, ?)',
      ).bind(`bulk-${i}`, BASE, OWNER, projectId, `bulk-${i}`),
    )
  }
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100))
  }
}

describe('parsePageLimit', () => {
  it('defaults to 50, clamps to 100, rejects junk', () => {
    expect(parsePageLimit(undefined)).toBe(50)
    expect(parsePageLimit('20')).toBe(20)
    expect(parsePageLimit('500')).toBe(100)
    expect(parsePageLimit('0')).toBe(50)
    expect(parsePageLimit('abc')).toBe(50)
  })
})

describe('getListenersPage — date sort', () => {
  it('walks all rows newest first with no duplicates or gaps', async () => {
    const projectId = await seedProject()
    for (let i = 1; i <= 5; i++) await seedChild(projectId, `c${i}`, at(i))
    const scope: ListScope = { kind: 'project', projectId }
    const expected = ['c5', 'c4', 'c3', 'c2', 'c1']
    expect(await walk(scope, 'date', 2)).toEqual(expected)
    expect(await walk(scope, 'date', 5)).toEqual(expected)
    expect(await walk(scope, 'date', 100)).toEqual(expected)
  })

  it('reports nextCursor only when more rows exist (exact boundary)', async () => {
    const projectId = await seedProject()
    for (let i = 1; i <= 5; i++) await seedChild(projectId, `c${i}`, at(i))
    const scope: ListScope = { kind: 'project', projectId }
    const full = await getListenersPage(env.DB, scope, 'date', { limit: 5 })
    expect(full.listeners).toHaveLength(5)
    expect(full.nextCursor).toBeNull()
    const partial = await getListenersPage(env.DB, scope, 'date', { limit: 4 })
    expect(partial.listeners).toHaveLength(4)
    expect(partial.nextCursor).not.toBeNull()
  })

  it('breaks ties on created_at by id (no row repeated or skipped across pages)', async () => {
    const projectId = await seedProject()
    for (const id of ['a', 'b', 'c']) await seedChild(projectId, id, at(7))
    const scope: ListScope = { kind: 'project', projectId }
    expect(await walk(scope, 'date', 1)).toEqual(['c', 'b', 'a'])
  })
})

describe('getListenersPage — activity sort', () => {
  it('orders by last activity, never-active last by created_at, and pages consistently', async () => {
    const projectId = await seedProject()
    await seedChild(projectId, 'x', at(1), { lastRequestAt: at(50) })
    await seedChild(projectId, 'y', at(2), { lastRequestAt: at(40) })
    await seedChild(projectId, 'z', at(9)) // never active, newer
    await seedChild(projectId, 'w', at(3)) // never active, older
    await seedChild(projectId, 'p', at(5), { lastRequestAt: at(30) })
    await seedChild(projectId, 'q', at(5), { lastRequestAt: at(30) }) // exact tie with p
    const scope: ListScope = { kind: 'project', projectId }
    const expected = ['x', 'y', 'q', 'p', 'z', 'w']
    expect(await walk(scope, 'activity', 100)).toEqual(expected)
    expect(await walk(scope, 'activity', 1)).toEqual(expected)
    expect(await walk(scope, 'activity', 2)).toEqual(expected)
  })
})

describe('cursor validation', () => {
  it('rejects garbage, wrong-sort and structurally invalid cursors', async () => {
    const projectId = await seedProject()
    for (let i = 1; i <= 3; i++) await seedChild(projectId, `c${i}`, at(i))
    const scope: ListScope = { kind: 'project', projectId }

    await expect(
      getListenersPage(env.DB, scope, 'date', {
        cursor: 'not-a-cursor',
        limit: 2,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError)

    const activityPage = await getListenersPage(env.DB, scope, 'activity', {
      limit: 1,
    })
    await expect(
      getListenersPage(env.DB, scope, 'date', {
        cursor: activityPage.nextCursor!,
        limit: 2,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError)

    const missingField = btoa(JSON.stringify({ s: 'date', c: 'x' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    await expect(
      getListenersPage(env.DB, scope, 'date', {
        cursor: missingField,
        limit: 2,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError)
  })
})

describe('getListenersPage — name and custom (unpaged, capped)', () => {
  it('sorts name case-insensitively with unlabeled (slug) after', async () => {
    const projectId = await seedProject()
    await seedChild(projectId, 'b', at(1), { label: 'bravo' })
    await seedChild(projectId, 'a', at(2), { label: 'Alpha' })
    await seedChild(projectId, 'z', at(3)) // no label -> slug-z
    const page = await getListenersPage(
      env.DB,
      { kind: 'project', projectId },
      'name',
      { limit: 50 },
    )
    expect(page.listeners.map((l) => l.id)).toEqual(['a', 'b', 'z'])
    expect(page.nextCursor).toBeNull()
    expect(page.truncated).toBe(false)
  })

  it('caps at 500 and flags truncated only when more than 500 exist', async () => {
    const projectId = await seedProject()
    await seedMany(projectId, UNPAGED_CAP + 1)
    const scope: ListScope = { kind: 'project', projectId }
    const over = await getListenersPage(env.DB, scope, 'name', { limit: 50 })
    expect(over.listeners).toHaveLength(UNPAGED_CAP)
    expect(over.truncated).toBe(true)
    expect(over.nextCursor).toBeNull()

    await env.DB.prepare('DELETE FROM listeners WHERE id = ?')
      .bind('bulk-0')
      .run()
    const exact = await getListenersPage(env.DB, scope, 'custom', { limit: 50 })
    expect(exact.listeners).toHaveLength(UNPAGED_CAP)
    expect(exact.truncated).toBe(false)
  })
})

describe('getListenersPage — standalone scope', () => {
  it("returns only the owner's project-less listeners", async () => {
    const projectId = await seedProject()
    await seedChild(projectId, 'child', at(1))
    await createListener(env.DB, 's1', at(2), OWNER)
    await createListener(env.DB, 's2', at(3), OWNER)
    await createListener(env.DB, 'other-s', at(4), OTHER)
    const ids = await walk({ kind: 'standalone', email: OWNER }, 'date', 1)
    expect(ids).toEqual(['s2', 's1'])
  })
})

describe('query plans use the new indexes (no table scans)', () => {
  async function planFor(
    scope: ListScope,
    sort: SortMode,
    cursor?: string,
  ): Promise<string> {
    const { sql, binds } = buildListenersPageQuery(scope, sort, cursor, 50)
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...binds)
      .all<{ detail: string }>()
    return results.map((r) => r.detail).join(' | ')
  }

  it('standalone date keyset seeks idx_listeners_owner_standalone', async () => {
    const plan = await planFor(
      { kind: 'standalone', email: OWNER },
      'date',
      encodeCursor({ s: 'date', c: BASE, id: 'x' }),
    )
    expect(plan).toContain('idx_listeners_owner_standalone')
    expect(plan).not.toContain('SCAN')
  })

  it('project date keyset seeks idx_listeners_project_id', async () => {
    const plan = await planFor(
      { kind: 'project', projectId: 'p' },
      'date',
      encodeCursor({ s: 'date', c: BASE, id: 'x' }),
    )
    expect(plan).toContain('idx_listeners_project_id')
    expect(plan).not.toContain('SCAN')
  })

  it('project activity first page and keyset seek idx_listeners_project_activity', async () => {
    const first = await planFor({ kind: 'project', projectId: 'p' }, 'activity')
    expect(first).toContain('idx_listeners_project_activity')
    expect(first).not.toContain('SCAN')
    const next = await planFor(
      { kind: 'project', projectId: 'p' },
      'activity',
      encodeCursor({ s: 'activity', a: BASE, c: BASE, id: 'x' }),
    )
    expect(next).toContain('idx_listeners_project_activity')
    expect(next).not.toContain('SCAN')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/listenersPaging.test.ts`
Expected: FAIL — cannot resolve `./listenersPaging`.

- [ ] **Step 3: Add the migration**

Create `backend/migrations/0013_listener_paging_indexes.sql`:

```sql
-- Keyset pagination for listener lists (design: 2026-10-15-paginate-listener-lists).
-- Standalone listeners for Home: seek on (owner_email, project_id IS NULL) instead
-- of scanning every one of an owner's rows.
CREATE INDEX idx_listeners_owner_standalone
  ON listeners(owner_email, project_id, created_at DESC, id DESC);

-- Recent-activity pages for a project; the expression must match the query text
-- exactly. '' sorts below every ISO timestamp, so never-active rows come last.
CREATE INDEX idx_listeners_project_activity
  ON listeners(project_id, COALESCE(last_request_at, '') DESC, created_at DESC, id DESC);
```

- [ ] **Step 4: Export `SELECT_COLUMNS`**

In `backend/src/listeners.repo.ts` change `const SELECT_COLUMNS =` to `export const SELECT_COLUMNS =` (no other change).

- [ ] **Step 5: Implement the module**

Create `backend/src/listenersPaging.ts`:

```ts
import type { Env } from './env'
import {
  SELECT_COLUMNS,
  type ListenerRecord,
  type SortMode,
} from './listeners.repo'

export const PAGE_DEFAULT_LIMIT = 50
export const PAGE_MAX_LIMIT = 100
export const UNPAGED_CAP = 500

export type ListScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'standalone'; email: string }

export interface ListenersPage {
  listeners: ListenerRecord[]
  nextCursor: string | null
  truncated: boolean
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor')
  }
}

export type Cursor =
  | { s: 'date'; c: string; id: string }
  | { s: 'activity'; a: string; c: string; id: string }

// Must match the index expression in migration 0013 exactly.
const ACTIVITY_KEY = "COALESCE(last_request_at, '')"

const UNPAGED_ORDER = {
  name: '(COALESCE(label, slug) IS NULL), COALESCE(label, slug) COLLATE NOCASE ASC, created_at DESC, id DESC',
  custom:
    '(sort_position IS NULL), sort_position ASC, created_at DESC, id DESC',
} as const

export function parsePageLimit(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return PAGE_DEFAULT_LIMIT
  return Math.min(parsed, PAGE_MAX_LIMIT)
}

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): string {
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (text.length % 4)) % 4)
  return atob(padded)
}

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify(cursor))
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function decodeCursor(raw: string, sort: 'date' | 'activity'): Cursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(raw))
  } catch {
    throw new InvalidCursorError()
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidCursorError()
  }
  const value = parsed as Record<string, unknown>
  if (value.s !== sort) throw new InvalidCursorError()
  if (!isString(value.c) || !isString(value.id)) throw new InvalidCursorError()
  if (sort === 'date') return { s: 'date', c: value.c, id: value.id }
  if (!isString(value.a)) throw new InvalidCursorError()
  return { s: 'activity', a: value.a, c: value.c, id: value.id }
}

function scopeClause(scope: ListScope): { sql: string; binds: unknown[] } {
  return scope.kind === 'project'
    ? { sql: 'project_id = ?', binds: [scope.projectId] }
    : {
        sql: 'owner_email = ? AND project_id IS NULL',
        binds: [scope.email],
      }
}

function keysetClause(cursor: Cursor): { sql: string; binds: unknown[] } {
  // The leading `<= ?` bound is what lets SQLite seek into the index; the
  // expanded OR alone is applied as a per-row filter and would walk every row
  // before the cursor (O(position) reads). The OR then only filters the few rows
  // that tie on the leading key.
  if (cursor.s === 'date') {
    return {
      sql: ' AND created_at <= ? AND (created_at < ? OR (created_at = ? AND id < ?))',
      binds: [cursor.c, cursor.c, cursor.c, cursor.id],
    }
  }
  return {
    sql:
      ` AND ${ACTIVITY_KEY} <= ? AND (${ACTIVITY_KEY} < ? OR (${ACTIVITY_KEY} = ? AND ` +
      '(created_at < ? OR (created_at = ? AND id < ?))))',
    binds: [cursor.a, cursor.a, cursor.a, cursor.c, cursor.c, cursor.id],
  }
}

export function buildListenersPageQuery(
  scope: ListScope,
  sort: SortMode,
  cursor: string | undefined,
  limit: number,
): { sql: string; binds: unknown[]; fetchSize: number } {
  const where = scopeClause(scope)

  if (sort === 'name' || sort === 'custom') {
    // Not paginated: a cursor, if sent, is ignored.
    return {
      sql: `SELECT ${SELECT_COLUMNS} FROM listeners WHERE ${where.sql} ORDER BY ${UNPAGED_ORDER[sort]} LIMIT ?`,
      binds: [...where.binds, UNPAGED_CAP + 1],
      fetchSize: UNPAGED_CAP + 1,
    }
  }

  const keyset =
    cursor === undefined
      ? { sql: '', binds: [] as unknown[] }
      : keysetClause(decodeCursor(cursor, sort))
  const order =
    sort === 'date'
      ? 'created_at DESC, id DESC'
      : `${ACTIVITY_KEY} DESC, created_at DESC, id DESC`
  return {
    sql: `SELECT ${SELECT_COLUMNS} FROM listeners WHERE ${where.sql}${keyset.sql} ORDER BY ${order} LIMIT ?`,
    binds: [...where.binds, ...keyset.binds, limit + 1],
    fetchSize: limit + 1,
  }
}

function cursorFor(sort: 'date' | 'activity', row: ListenerRecord): string {
  return encodeCursor(
    sort === 'date'
      ? { s: 'date', c: row.createdAt, id: row.id }
      : {
          s: 'activity',
          a: row.lastRequestAt ?? '',
          c: row.createdAt,
          id: row.id,
        },
  )
}

export async function getListenersPage(
  db: Env['DB'],
  scope: ListScope,
  sort: SortMode,
  options: { cursor?: string; limit: number },
): Promise<ListenersPage> {
  const { sql, binds } = buildListenersPageQuery(
    scope,
    sort,
    options.cursor,
    options.limit,
  )
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ListenerRecord>()

  if (sort === 'name' || sort === 'custom') {
    return {
      listeners: results.slice(0, UNPAGED_CAP),
      nextCursor: null,
      truncated: results.length > UNPAGED_CAP,
    }
  }

  const more = results.length > options.limit
  const listeners = results.slice(0, options.limit)
  const last = listeners[listeners.length - 1]
  return {
    listeners,
    nextCursor: more && last ? cursorFor(sort, last) : null,
    truncated: false,
  }
}
```

- [ ] **Step 6: Run the module tests**

Run: `cd backend && npx vitest run src/listenersPaging.test.ts`
Expected: all PASS, including the `EXPLAIN QUERY PLAN` tests (they require the migration to be applied in the test D1; the repo's vitest config applies everything in `migrations/`). If an `EXPLAIN` test fails because the planner picked a different index, report the actual plan text rather than loosening the assertion.

- [ ] **Step 7: Full backend suite and typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: all PASS except the single known `src/app.session.test.ts` failure; `tsc` prints nothing.

- [ ] **Step 8: Stage**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git add backend/migrations/0013_listener_paging_indexes.sql backend/src/listenersPaging.ts backend/src/listenersPaging.test.ts backend/src/listeners.repo.ts
```

- [ ] **Step 9: Commit**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git commit -m "feat(backend): add keyset listener paging module and supporting indexes"
```

---

### Task 2: Paginated endpoints (backend)

**Files:**

- Modify: `backend/src/routes/projects.ts` (the `GET /api/projects/:id` handler and its imports)
- Modify: `backend/src/routes/projects.detail.test.ts`
- Modify: `backend/src/routes/listeners.ts` (add a route and imports)
- Create: `backend/src/routes/listeners.standalone.test.ts`

**Interfaces:**

- Consumes: `getListenersPage`, `parsePageLimit`, `InvalidCursorError`, `ListScope` from `../listenersPaging` (Task 1); `parseSortMode` from `../listeners.repo`; `serializeListener` (exported from `routes/listeners.ts`), local `serializeProject`.
- Produces:
  - `GET /api/projects/:id?sort=&cursor=&limit=` → `200 { project, listeners, nextCursor: string | null, truncated: boolean, hasMore: boolean }`; `404 { error: 'project not found' }`; `400 { error: 'invalid cursor' }`.
  - `GET /api/standalone-listeners?sort=&cursor=&limit=` → `200 { listeners, nextCursor, truncated }`; `400 { error: 'invalid cursor' }`.

- [ ] **Step 1: Update and add the project-detail tests**

In `backend/src/routes/projects.detail.test.ts` the existing helper `getDetail(id, query, email)` and `seedListeners(projectId, count, prefix)` are reused. Replace the two tests titled `caps at 100 listeners and reports hasMore when 101 exist (newest first by default)` and `reports hasMore=false at exactly 100 listeners` with the following (the default page size is now 50, so the cap tests pass `?limit=100`), and extend the `DetailBody` interface and add the new tests:

Change the interface at the top of the file to:

```ts
interface DetailBody {
  project: { id: string; label: string | null }
  listeners: { id: string; slug: string | null; projectId: string | null }[]
  hasMore: boolean
  nextCursor: string | null
  truncated: boolean
}
```

Replace the two cap tests with:

```ts
it('defaults to 50 per page and reports a cursor when more exist', async () => {
  await seedListeners(projectId, 51)
  const body = (await (await getDetail(projectId)).json()) as DetailBody
  expect(body.listeners).toHaveLength(50)
  expect(body.hasMore).toBe(true)
  expect(body.nextCursor).not.toBeNull()
  expect(body.truncated).toBe(false)
  expect(body.listeners[0].slug).toBe('l050')
})

it('honours limit=100 (the max) and clamps larger values', async () => {
  await seedListeners(projectId, 101)
  const body = (await (
    await getDetail(projectId, '?limit=100')
  ).json()) as DetailBody
  expect(body.listeners).toHaveLength(100)
  expect(body.hasMore).toBe(true)
  const clamped = (await (
    await getDetail(projectId, '?limit=9999')
  ).json()) as DetailBody
  expect(clamped.listeners).toHaveLength(100)
})

it('reports no cursor and hasMore=false at exactly the page size', async () => {
  await seedListeners(projectId, 100)
  const body = (await (
    await getDetail(projectId, '?limit=100')
  ).json()) as DetailBody
  expect(body.listeners).toHaveLength(100)
  expect(body.nextCursor).toBeNull()
  expect(body.hasMore).toBe(false)
})

it('walks every listener across pages via nextCursor (no duplicates, none missing)', async () => {
  await seedListeners(projectId, 7)
  const slugs: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < 10; i++) {
    const query: string =
      cursor === null ? '?limit=3' : `?limit=3&cursor=${cursor}`
    const body = (await (
      await getDetail(projectId, query)
    ).json()) as DetailBody
    slugs.push(...body.listeners.map((l) => l.slug ?? ''))
    cursor = body.nextCursor
    if (cursor === null) break
  }
  expect(slugs).toEqual([
    'l006',
    'l005',
    'l004',
    'l003',
    'l002',
    'l001',
    'l000',
  ])
})

it('returns 400 for a malformed cursor', async () => {
  const response = await getDetail(projectId, '?cursor=garbage')
  expect(response.status).toBe(400)
  expect(((await response.json()) as { error: string }).error).toBe(
    'invalid cursor',
  )
})

it('name sort is unpaged: no cursor, truncated=false for a small project', async () => {
  await seedListeners(projectId, 3)
  const body = (await (
    await getDetail(projectId, '?sort=name')
  ).json()) as DetailBody
  expect(body.nextCursor).toBeNull()
  expect(body.truncated).toBe(false)
  expect(body.hasMore).toBe(false)
})
```

- [ ] **Step 2: Write the standalone endpoint tests**

Create `backend/src/routes/listeners.standalone.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'
import { createListener, createProjectListener } from '../listeners.repo'
import { createProject } from '../projects.repo'

interface StandaloneBody {
  listeners: { id: string; projectId: string | null }[]
  nextCursor: string | null
  truncated: boolean
}

const OWNER = 'owner@nice.com'
const OTHER = 'other@nice.com'

async function get(query: string, email = OWNER) {
  return app.request(
    `/api/standalone-listeners${query}`,
    { headers: await authCookieHeader(env, email) },
    env,
  )
}

function at(minute: number): string {
  return `2024-02-01T00:${String(minute).padStart(2, '0')}:00.000Z`
}

describe('GET /api/standalone-listeners', () => {
  it("returns only the caller's project-less listeners, newest first", async () => {
    await createProject(env.DB, 'proj', at(0), OWNER)
    await createProjectListener(
      env.DB,
      'child',
      at(9),
      null,
      OWNER,
      'proj',
      'c',
    )
    await createListener(env.DB, 's1', at(1), OWNER)
    await createListener(env.DB, 's2', at(2), OWNER)
    await createListener(env.DB, 'theirs', at(3), OTHER)

    const body = (await (await get('')).json()) as StandaloneBody
    expect(body.listeners.map((l) => l.id)).toEqual(['s2', 's1'])
    expect(body.listeners.every((l) => l.projectId === null)).toBe(true)
    expect(body.nextCursor).toBeNull()
    expect(body.truncated).toBe(false)
  })

  it('pages with limit and nextCursor without gaps or duplicates', async () => {
    for (let i = 1; i <= 5; i++) {
      await createListener(env.DB, `s${i}`, at(i), OWNER)
    }
    const ids: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 10; i++) {
      const query: string =
        cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`
      const body = (await (await get(query)).json()) as StandaloneBody
      ids.push(...body.listeners.map((l) => l.id))
      cursor = body.nextCursor
      if (cursor === null) break
    }
    expect(ids).toEqual(['s5', 's4', 's3', 's2', 's1'])
  })

  it('returns 400 for a malformed cursor', async () => {
    const response = await get('?cursor=garbage')
    expect(response.status).toBe(400)
  })

  it('an owner with no listeners gets an empty page', async () => {
    const body = (await (
      await get('', 'nobody@nice.com')
    ).json()) as StandaloneBody
    expect(body.listeners).toEqual([])
    expect(body.nextCursor).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd backend && npx vitest run src/routes/projects.detail.test.ts src/routes/listeners.standalone.test.ts`
Expected: FAIL — the new project tests fail (no `nextCursor`, default cap still 100) and the standalone route returns 404.

- [ ] **Step 4: Implement the project endpoint change**

In `backend/src/routes/projects.ts`: remove `getListenersByProjectSorted` and `PROJECT_LISTENERS_LIMIT` from the `'../listeners.repo'` import (keep `parseSortMode`), add:

```ts
import {
  InvalidCursorError,
  getListenersPage,
  parsePageLimit,
} from '../listenersPaging'
```

and replace the body of the `projectRoutes.get('/api/projects/:id', ...)` handler after the project lookup (the `getListenersByProjectSorted` call and the `return c.json(...)`) with:

```ts
let page
try {
  page = await getListenersPage(
    c.env.DB,
    { kind: 'project', projectId: project.id },
    parseSortMode(c.req.query('sort')),
    {
      cursor: c.req.query('cursor'),
      limit: parsePageLimit(c.req.query('limit')),
    },
  )
} catch (err) {
  if (err instanceof InvalidCursorError) {
    return c.json({ error: 'invalid cursor' }, 400)
  }
  throw err
}
return c.json({
  project: serializeProject(c.env, project),
  listeners: page.listeners.map((listener) =>
    serializeListener(c.env, listener),
  ),
  nextCursor: page.nextCursor,
  truncated: page.truncated,
  hasMore: page.nextCursor !== null || page.truncated,
})
```

Do NOT remove `getListenersByProjectSorted` / `PROJECT_LISTENERS_LIMIT` from `listeners.repo.ts` — `sharedProjectListeners.ts` still uses them.

- [ ] **Step 5: Implement the standalone endpoint**

In `backend/src/routes/listeners.ts`, add to the imports:

```ts
import {
  InvalidCursorError,
  getListenersPage,
  parsePageLimit,
} from '../listenersPaging'
```

and add this route directly after the existing `listenerRoutes.get('/api/listeners', ...)` handler:

```ts
listenerRoutes.get('/api/standalone-listeners', async (c) => {
  try {
    const page = await getListenersPage(
      c.env.DB,
      { kind: 'standalone', email: c.get('email') },
      parseSortMode(c.req.query('sort')),
      {
        cursor: c.req.query('cursor'),
        limit: parsePageLimit(c.req.query('limit')),
      },
    )
    return c.json({
      listeners: page.listeners.map((listener) =>
        serializeListener(c.env, listener),
      ),
      nextCursor: page.nextCursor,
      truncated: page.truncated,
    })
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      return c.json({ error: 'invalid cursor' }, 400)
    }
    throw err
  }
})
```

- [ ] **Step 6: Run the endpoint tests**

Run: `cd backend && npx vitest run src/routes/projects.detail.test.ts src/routes/listeners.standalone.test.ts src/routes/listeners.list.test.ts`
Expected: all PASS (the last file confirms the untouched `GET /api/listeners`).

- [ ] **Step 7: Full backend suite and typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: all PASS except the known `src/app.session.test.ts` failure; `tsc` prints nothing.

- [ ] **Step 8: Stage**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git add backend/src/routes/projects.ts backend/src/routes/projects.detail.test.ts backend/src/routes/listeners.ts backend/src/routes/listeners.standalone.test.ts
```

- [ ] **Step 9: Commit**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git commit -m "feat(backend): paginate project listeners and add standalone listeners endpoint"
```

---

### Task 3: Frontend foundations (poller, pure helpers, hook, API client)

**Files:**

- Modify: `frontend/src/lib/poller.ts`, `frontend/src/lib/poller.test.ts`, `frontend/src/hooks/usePolling.ts`
- Create: `frontend/src/lib/listPaging.ts`, `frontend/src/lib/listPaging.test.ts`
- Create: `frontend/src/hooks/usePaginatedList.ts`
- Modify: `frontend/src/api.ts`

**Interfaces:**

- Consumes: backend responses from Task 2.
- Produces:
  - `PollerOptions.intervalMs: number | null` (`null` = run on start and on each return to a visible tab, never on a timer).
  - `usePolling(tick, options?: { intervalMs?: number | null }): { paused: boolean }`.
  - `lib/listPaging.ts`: `isPagedSort(sort: SortMode): boolean`; `mergeFirstPage<T extends { id: string }>(current: T[], firstPage: T[]): T[]`; `appendPage<T extends { id: string }>(current: T[], page: T[]): T[]`; `moveItem<T extends { id: string }>(list: T[], fromId: string, targetId: string, before: boolean): T[] | null`; `sortProjects(sort: SortMode, projects: Project[]): Project[]`.
  - `hooks/usePaginatedList.ts`: `interface ListPage<T> { items: T[]; nextCursor: string | null; truncated: boolean }` and `usePaginatedList<T extends { id: string }>(fetchPage: (cursor?: string) => Promise<ListPage<T>>, paged: boolean)` returning `{ items: T[]; setItems: Dispatch<SetStateAction<T[]>>; hasMore: boolean; truncated: boolean; loaded: boolean; loadingMore: boolean; loadMore(): Promise<void>; refreshFirstPage(): Promise<void> }`. A new `fetchPage` identity resets all state and ignores in-flight results from the previous identity.
  - `api.ts`: `LIST_PAGE_SIZE = 50`; `interface ListenerPage { listeners: Listener[]; nextCursor: string | null; truncated: boolean }`; `interface ProjectDetailData extends ListenerPage { project: Project; hasMore: boolean }`; `getProject(id: string, sort?: SortMode, cursor?: string, limit?: number): Promise<ProjectDetailData>`; `listStandaloneListeners(sort?: SortMode, cursor?: string, limit?: number): Promise<ListenerPage>`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/poller.test.ts` inside the existing `describe('createPoller', ...)` block (reusing its `makeEnv`, `OPTIONS`):

```ts
it('with intervalMs null: ticks on start and on each return to visible, never on a timer', async () => {
  const t = makeEnv()
  const tick = vi.fn().mockResolvedValue(true)
  createPoller(tick, { intervalMs: null, idleMs: 600000 }, t.env).start()
  await vi.advanceTimersByTimeAsync(60000)
  expect(tick).toHaveBeenCalledTimes(1)

  t.setHidden(true)
  await vi.advanceTimersByTimeAsync(1000)
  t.setHidden(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(tick).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(60000)
  expect(tick).toHaveBeenCalledTimes(2)
})
```

Create `frontend/src/lib/listPaging.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Project } from '../api'
import {
  appendPage,
  isPagedSort,
  mergeFirstPage,
  moveItem,
  sortProjects,
} from './listPaging'

const item = (id: string) => ({ id })

describe('isPagedSort', () => {
  it('pages date and activity only', () => {
    expect(isPagedSort('date')).toBe(true)
    expect(isPagedSort('activity')).toBe(true)
    expect(isPagedSort('name')).toBe(false)
    expect(isPagedSort('custom')).toBe(false)
  })
})

describe('mergeFirstPage', () => {
  it('puts the fresh first page first and keeps later-page rows after it, without duplicates', () => {
    const current = [item('a'), item('b'), item('c'), item('d')]
    const firstPage = [item('c'), item('a')] // c gained activity and jumped up
    expect(mergeFirstPage(current, firstPage).map((i) => i.id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ])
  })

  it('adds brand new rows at the front', () => {
    expect(
      mergeFirstPage([item('a')], [item('n'), item('a')]).map((i) => i.id),
    ).toEqual(['n', 'a'])
  })

  it('replaces in-place data with the fresh copy', () => {
    const fresh = { id: 'a', label: 'new' }
    const merged = mergeFirstPage([{ id: 'a', label: 'old' }], [fresh])
    expect(merged[0]).toBe(fresh)
  })
})

describe('appendPage', () => {
  it('appends only unseen rows', () => {
    expect(
      appendPage([item('a'), item('b')], [item('b'), item('c')]).map(
        (i) => i.id,
      ),
    ).toEqual(['a', 'b', 'c'])
  })
})

describe('moveItem', () => {
  const list = [item('a'), item('b'), item('c'), item('d')]

  it('moves before the target', () => {
    expect(moveItem(list, 'd', 'b', true)?.map((i) => i.id)).toEqual([
      'a',
      'd',
      'b',
      'c',
    ])
  })

  it('moves after the target, recomputing the index after removal', () => {
    expect(moveItem(list, 'a', 'c', false)?.map((i) => i.id)).toEqual([
      'b',
      'c',
      'a',
      'd',
    ])
  })

  it('returns null for unknown ids and does not mutate the input', () => {
    expect(moveItem(list, 'x', 'b', true)).toBeNull()
    expect(moveItem(list, 'a', 'x', true)).toBeNull()
    expect(list.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('sortProjects', () => {
  const p = (id: string, over: Partial<Project> = {}): Project => ({
    id,
    createdAt: '2024-01-01T00:00:00.000Z',
    hookUrlTemplate: '',
    sortPosition: null,
    label: null,
    shareUrl: null,
    ...over,
  })

  it('date and activity: newest created first', () => {
    const projects = [
      p('old', { createdAt: '2024-01-01T00:00:00.000Z' }),
      p('new', { createdAt: '2024-03-01T00:00:00.000Z' }),
    ]
    expect(sortProjects('date', projects).map((x) => x.id)).toEqual([
      'new',
      'old',
    ])
    expect(sortProjects('activity', projects).map((x) => x.id)).toEqual([
      'new',
      'old',
    ])
  })

  it('name: case-insensitive label, unlabeled last', () => {
    const projects = [
      p('none'),
      p('b', { label: 'bravo' }),
      p('a', { label: 'Alpha' }),
    ]
    expect(sortProjects('name', projects).map((x) => x.id)).toEqual([
      'a',
      'b',
      'none',
    ])
  })

  it('custom: by sortPosition, unpositioned last by created date', () => {
    const projects = [
      p('np-old', { createdAt: '2024-01-01T00:00:00.000Z' }),
      p('two', { sortPosition: 2 }),
      p('np-new', { createdAt: '2024-05-01T00:00:00.000Z' }),
      p('zero', { sortPosition: 0 }),
    ]
    expect(sortProjects('custom', projects).map((x) => x.id)).toEqual([
      'zero',
      'two',
      'np-new',
      'np-old',
    ])
  })

  it('does not mutate its input', () => {
    const projects = [
      p('a', { createdAt: '2024-01-01T00:00:00.000Z' }),
      p('b', { createdAt: '2024-02-01T00:00:00.000Z' }),
    ]
    sortProjects('date', projects)
    expect(projects.map((x) => x.id)).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run to verify failures**

Run: `cd frontend && npm test`
Expected: FAIL — `./listPaging` cannot be resolved, and the new poller test fails (a `null` interval is not supported yet; it would also fail type-checking, which vitest does not enforce, so it fails on behaviour: the poller schedules `setTimeout(run, null)` and ticks repeatedly).

- [ ] **Step 3: Poller `null` interval**

In `frontend/src/lib/poller.ts`:

- In `PollerOptions` change `intervalMs: number` to `intervalMs: number | null` and extend its comment: `// null: run once on start and on each return to a visible tab; never on a timer.`
- Replace the `schedule` function with:

```ts
function schedule() {
  clearTimer()
  const interval = options.intervalMs
  if (stopped || interval === null || env.isHidden()) return
  if (env.now() - lastActivity >= options.idleMs) {
    setPaused(true)
    return
  }
  timer = setTimeout(run, interval)
}
```

In `frontend/src/hooks/usePolling.ts` replace the function with:

```ts
export function usePolling(
  tick: () => Promise<boolean>,
  options?: { intervalMs?: number | null },
): { paused: boolean } {
  const [paused, setPaused] = useState(false)
  // null = no timer polling (run on mount and when the tab becomes visible).
  const intervalMs =
    options?.intervalMs === undefined ? POLL_INTERVAL_MS : options.intervalMs

  useEffect(() => {
    setPaused(false)
    const poller = createPoller(
      tick,
      { intervalMs, idleMs: POLL_IDLE_MS, onPausedChange: setPaused },
      browserPollerEnv,
    )
    poller.start()
    return poller.stop
  }, [tick, intervalMs])

  return { paused }
}
```

(Keep the existing constants and the explanatory comment above the function, updated to mention the optional `intervalMs`.)

- [ ] **Step 4: Pure helpers**

Create `frontend/src/lib/listPaging.ts`:

```ts
import type { Project, SortMode } from '../api'

// Date and Recent activity load page by page (keyset cursor); Name and Custom
// load everything up to the server's cap and do not poll on a timer.
export function isPagedSort(sort: SortMode): boolean {
  return sort === 'date' || sort === 'activity'
}

// The fresh first page goes first; rows already loaded from later pages (and
// rows pushed out of the first page) keep their relative order after it. Rows
// in the fresh page replace stale copies by id.
export function mergeFirstPage<T extends { id: string }>(
  current: T[],
  firstPage: T[],
): T[] {
  const freshIds = new Set(firstPage.map((item) => item.id))
  return [...firstPage, ...current.filter((item) => !freshIds.has(item.id))]
}

export function appendPage<T extends { id: string }>(
  current: T[],
  page: T[],
): T[] {
  const seen = new Set(current.map((item) => item.id))
  return [...current, ...page.filter((item) => !seen.has(item.id))]
}

// Moves `fromId` next to `targetId` (before or after). Returns null when either
// id is not in the list. The target index is recomputed after removal —
// removing an earlier item shifts every later index down by one.
export function moveItem<T extends { id: string }>(
  list: T[],
  fromId: string,
  targetId: string,
  before: boolean,
): T[] | null {
  const next = [...list]
  const fromIndex = next.findIndex((item) => item.id === fromId)
  if (fromIndex === -1) return null
  const [moved] = next.splice(fromIndex, 1)
  const targetIndex = next.findIndex((item) => item.id === targetId)
  if (targetIndex === -1) return null
  next.splice(before ? targetIndex : targetIndex + 1, 0, moved)
  return next
}

function byCreatedAtDesc(a: Project, b: Project): number {
  return b.createdAt.localeCompare(a.createdAt)
}

// Projects are ordered by their own fields. A project has no activity field of
// its own, so Recent activity falls back to created date.
export function sortProjects(sort: SortMode, projects: Project[]): Project[] {
  const sorted = [...projects]
  if (sort === 'name') {
    return sorted.sort((a, b) => {
      if (a.label === null && b.label === null) return byCreatedAtDesc(a, b)
      if (a.label === null) return 1
      if (b.label === null) return -1
      const byLabel = a.label.localeCompare(b.label, undefined, {
        sensitivity: 'base',
      })
      return byLabel !== 0 ? byLabel : byCreatedAtDesc(a, b)
    })
  }
  if (sort === 'custom') {
    return sorted.sort((a, b) => {
      if (a.sortPosition === null && b.sortPosition === null)
        return byCreatedAtDesc(a, b)
      if (a.sortPosition === null) return 1
      if (b.sortPosition === null) return -1
      return a.sortPosition - b.sortPosition
    })
  }
  return sorted.sort(byCreatedAtDesc)
}
```

- [ ] **Step 5: API client**

In `frontend/src/api.ts`, replace the existing `ProjectDetailData` interface and `getProject` function (added in the previous release) with, and add `listStandaloneListeners`:

```ts
export const LIST_PAGE_SIZE = 50

export interface ListenerPage {
  listeners: Listener[]
  nextCursor: string | null
  truncated: boolean
}

export interface ProjectDetailData extends ListenerPage {
  project: Project
  hasMore: boolean
}

function listQuery(sort: SortMode, cursor?: string, limit?: number): string {
  const params = new URLSearchParams({ sort })
  if (cursor !== undefined) params.set('cursor', cursor)
  if (limit !== undefined) params.set('limit', String(limit))
  return `?${params.toString()}`
}

export function getProject(
  id: string,
  sort: SortMode = 'date',
  cursor?: string,
  limit: number = LIST_PAGE_SIZE,
): Promise<ProjectDetailData> {
  return fetch(
    `${API_BASE_URL}/api/projects/${id}${listQuery(sort, cursor, limit)}`,
    { credentials: 'include' },
  ).then((r) => parseJsonOrThrow<ProjectDetailData>(r))
}

export function listStandaloneListeners(
  sort: SortMode = 'date',
  cursor?: string,
  limit: number = LIST_PAGE_SIZE,
): Promise<ListenerPage> {
  return fetch(
    `${API_BASE_URL}/api/standalone-listeners${listQuery(sort, cursor, limit)}`,
    { credentials: 'include' },
  ).then((r) => parseJsonOrThrow<ListenerPage>(r))
}
```

(Keep `listListeners` — it is still exported; Home stops using it in Task 5. Leave `SortMode` and `Listener` where they are; place the new block next to `listListeners`.)

- [ ] **Step 6: The hook**

Create `frontend/src/hooks/usePaginatedList.ts`:

```ts
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { appendPage, mergeFirstPage } from '../lib/listPaging'

export interface ListPage<T> {
  items: T[]
  nextCursor: string | null
  truncated: boolean
}

export interface UsePaginatedListResult<T> {
  items: T[]
  setItems: Dispatch<SetStateAction<T[]>>
  hasMore: boolean
  truncated: boolean
  loaded: boolean
  loadingMore: boolean
  loadMore: () => Promise<void>
  refreshFirstPage: () => Promise<void>
}

// `paged` = the active sort uses keyset cursors (Date, Recent activity). When
// false the server returns the whole (capped) list in one response, so a
// refresh replaces everything. A new `fetchPage` identity (sort or scope
// changed) drops all loaded rows and ignores results still in flight for the
// previous identity.
export function usePaginatedList<T extends { id: string }>(
  fetchPage: (cursor?: string) => Promise<ListPage<T>>,
  paged: boolean,
): UsePaginatedListResult<T> {
  const [items, setItems] = useState<T[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const generationRef = useRef(0)
  const firstPageEstablishedRef = useRef(false)

  useEffect(() => {
    generationRef.current += 1
    firstPageEstablishedRef.current = false
    setItems([])
    setNextCursor(null)
    setTruncated(false)
    setLoaded(false)
    setLoadingMore(false)
  }, [fetchPage])

  const refreshFirstPage = useCallback(async (): Promise<void> => {
    const generation = generationRef.current
    const page = await fetchPage(undefined)
    if (generation !== generationRef.current) return
    setItems((current) =>
      paged ? mergeFirstPage(current, page.items) : page.items,
    )
    setTruncated(page.truncated)
    // Establish the cursor only on the first successful load; later refreshes
    // of page one must not rewind a user who has scrolled further.
    if (!firstPageEstablishedRef.current) {
      firstPageEstablishedRef.current = true
      setNextCursor(page.nextCursor)
    }
    setLoaded(true)
  }, [fetchPage, paged])

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null || loadingMore) return
    const generation = generationRef.current
    setLoadingMore(true)
    try {
      const page = await fetchPage(nextCursor)
      if (generation !== generationRef.current) return
      setItems((current) => appendPage(current, page.items))
      setNextCursor(page.nextCursor)
    } finally {
      if (generation === generationRef.current) setLoadingMore(false)
    }
  }, [fetchPage, nextCursor, loadingMore])

  return {
    items,
    setItems,
    hasMore: nextCursor !== null,
    truncated,
    loaded,
    loadingMore,
    loadMore,
    refreshFirstPage,
  }
}
```

- [ ] **Step 7: Run tests and build**

Run: `cd frontend && npm test && npm run build`
Expected: all tests PASS; `tsc -b && vite build` succeeds. (If `tsc -b` flags `getProject`'s old callers — `ProjectDetail.tsx` still calls `getProject(projectId, sort)` and reads `data.hasMore`, which still exists — nothing should break; fix only genuine type errors.)

- [ ] **Step 8: Stage**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git add frontend/src/lib/poller.ts frontend/src/lib/poller.test.ts frontend/src/hooks/usePolling.ts frontend/src/lib/listPaging.ts frontend/src/lib/listPaging.test.ts frontend/src/hooks/usePaginatedList.ts frontend/src/api.ts
```

- [ ] **Step 9: Commit**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git commit -m "feat(frontend): add paginated list hook, paging helpers and null-interval poller"
```

---

### Task 4: ProjectDetail infinite scroll

**Files:**

- Modify: `frontend/src/pages/ProjectDetail.tsx`

**Interfaces:**

- Consumes: `usePaginatedList`, `ListPage` (Task 3), `isPagedSort` (Task 3), `usePolling(tick, { intervalMs })` (Task 3), `getProject(id, sort, cursor)` returning `ProjectDetailData` (Task 3), `PollingPausedNote`.
- Produces: no new interfaces.

- [ ] **Step 1: Imports**

Add (keep all existing imports that remain used):

```tsx
import { usePaginatedList, type ListPage } from '../hooks/usePaginatedList'
import { isPagedSort } from '../lib/listPaging'
```

and add `POLL_INTERVAL_MS` to the existing `usePolling` import if not already imported separately: `import { POLL_INTERVAL_MS, usePolling } from '../hooks/usePolling'`.

- [ ] **Step 2: State and refresh**

Replace the `children`/`hasMore` state lines and the `refresh` callback and the `usePolling(refresh)` call. Remove `const [children, setChildren] = useState<Listener[]>([])` and `const [hasMore, setHasMore] = useState(false)`. Keep `project`, `notFound`, `sort` etc. After the `useEffect` that loads the stored sort, replace everything from `const refresh = useCallback(` through `const { paused } = usePolling(refresh)` with:

```tsx
const paged = isPagedSort(sort)

const fetchPage = useCallback(
  async (cursor?: string): Promise<ListPage<Listener>> => {
    const data = await getProject(projectId!, sort, cursor)
    setProject(data.project)
    return {
      items: data.listeners,
      nextCursor: data.nextCursor,
      truncated: data.truncated,
    }
  },
  [projectId, sort],
)

const {
  items: children,
  setItems: setChildren,
  hasMore,
  truncated,
  loadingMore,
  loadMore,
  refreshFirstPage,
} = usePaginatedList(fetchPage, paged)

const refresh = useCallback(async (): Promise<boolean> => {
  if (!projectId) return false
  try {
    await refreshFirstPage()
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
  return true
}, [projectId, refreshFirstPage])

// Date and Recent activity poll the first page; Name and Custom re-sort the
// whole project server-side, so they load once (and again when the tab
// becomes visible or after the user's own edits) instead of polling.
const { paused } = usePolling(refresh, {
  intervalMs: paged ? POLL_INTERVAL_MS : null,
})

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
```

(`sort` is set from localStorage in an earlier effect; the first render uses `'date'` and the stored sort then triggers one extra load — same as today's behaviour for `refresh`.)

- [ ] **Step 3: Drag-reorder guard**

In `handleDrop`, change the first guard to also bail when the list is truncated:

```tsx
if (!dragKey || dragKey === targetId || truncated) return
```

and wherever the file sets `draggable={sort === 'custom'}` (the child `<li>`), change it to `draggable={sort === 'custom' && !truncated}`; likewise the `⠿` handle condition `sort === 'custom' &&` → `sort === 'custom' && !truncated &&`. (Search the file for `sort === 'custom'` to find all of them.)

- [ ] **Step 4: Replace the old note with the sentinel and truncation note**

Replace the existing block at the end of the page:

```tsx
{
  hasMore && (
    <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
      Showing the first 100 listeners — more exist.
    </p>
  )
}
```

with:

```tsx
{
  hasMore && <div ref={sentinelRef} aria-hidden="true" className="h-4" />
}
{
  loadingMore && (
    <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
      Loading more…
    </p>
  )
}
{
  truncated && (
    <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
      Showing the first 500 listeners — more exist.
      {sort === 'custom' ? ' Reordering is unavailable.' : ''}
    </p>
  )
}
```

- [ ] **Step 5: Verify**

Run: `cd frontend && npm test && npm run build`
Expected: tests PASS; build clean with no unused imports/vars (remove any import that is now unused, e.g. `useState` is still used; check `Listener` type is still used by `fetchPage`).

Then confirm by reading the file: no remaining reference to `setHasMore`, no `children` state setter other than the one from the hook, `handleSaveLabel`/`handleShare` still call `refresh()`, and the not-found branch still returns early before the main render.

- [ ] **Step 6: Stage**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git add frontend/src/pages/ProjectDetail.tsx
```

- [ ] **Step 7: Commit**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git commit -m "feat(frontend): infinite scroll for project listeners, no timer polling for name/custom"
```

---

### Task 5: Home restructure (Projects section + paginated Listeners)

**Files:**

- Modify: `frontend/src/pages/Home.tsx`
- Delete: `frontend/src/lib/mergeHomeItems.ts`

**Interfaces:**

- Consumes: `listStandaloneListeners`, `listProjects`, `reorderItems`, `ReorderItem` types from `../api`; `usePaginatedList`, `ListPage` (Task 3); `isPagedSort`, `moveItem`, `sortProjects` (Task 3).
- Produces: no new interfaces.

The page currently builds one merged list (`items`) of project cards and standalone listeners (via `mergeHomeItems.ts`) and has one drag handler for both. After this task Home renders two sections and each has its own drag handler. The two `<li>` render blocks (project card, listener row) are **moved verbatim** into functions; only their `key`, the drop handler call, and the `draggable`/handle conditions change.

- [ ] **Step 1: Imports and removal of the merge helpers**

- Remove the import of `HomeItem`, `mergeHomeItemsByActivity`, `mergeHomeItemsByCustom`, `mergeHomeItemsByDate`, `mergeHomeItemsByName` from `'../lib/mergeHomeItems'` and delete the local `mergeItems`, `itemKey` and `toReorderItem` functions.
- In the `../api` import, replace `listListeners` with `listStandaloneListeners`.
- Add:

```tsx
import { usePaginatedList, type ListPage } from '../hooks/usePaginatedList'
import { isPagedSort, moveItem, sortProjects } from '../lib/listPaging'
```

- Ensure `useCallback` and `useRef` are in the React import.
- Delete `frontend/src/lib/mergeHomeItems.ts` (run `grep -rn mergeHomeItems frontend/src` afterwards: expect no hits).

- [ ] **Step 2: State and loading**

Replace `const [listeners, setListeners] = useState<Listener[]>([])` and the effect `useEffect(() => { Promise.all([listListeners(sort), listProjects()]) ... }, [sort])` with:

```tsx
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
  loadMore,
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

const sortedProjects = sortProjects(sort, projects)

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
```

Remove `const items = mergeItems(sort, listeners, projects)`.

- [ ] **Step 3: Per-section drop handlers**

Replace the single `handleDrop(targetKey)` function with these two (the comments about the combined list no longer apply):

```tsx
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
  reorderItems(moved.map((p) => ({ type: 'project', id: p.id }))).catch(() => {
    setProjects(previous)
    setError('Failed to save the new order.')
  })
}

function handleDropListener(targetId: string) {
  const fromId = dragKey?.startsWith('listener:')
    ? dragKey.slice('listener:'.length)
    : null
  if (!fromId || fromId === targetId || truncated) return
  const before =
    dropIndicator?.key === `listener:${targetId}` ? dropIndicator.before : true
  const moved = moveItem(standalone, fromId, targetId, before)
  setDragKey(null)
  setDropIndicator(null)
  if (!moved) return

  const previous = standalone
  setStandalone(moved.map((l, position) => ({ ...l, sortPosition: position })))
  reorderItems(moved.map((l) => ({ type: 'listener', id: l.id }))).catch(() => {
    setStandalone(previous)
    setError('Failed to save the new order.')
  })
}
```

- [ ] **Step 4: Render two sections**

Move the existing project `<li>…</li>` block (the one inside `if (item.kind === 'project') { … return ( <li key={key} … </li> ) }`) into a function inside `Home` and the existing listener `<li>…</li>` block (the final `return ( <li key={key} … </li> )` of the `items.map` callback) into another, then delete the old `items.map(...)` and its surrounding `<ul>`/fragment. The two functions:

```tsx
function renderProject(project: Project) {
  const key = `project:${project.id}`
  const draggableProject = sort === 'custom'
  // ... the existing project <li> block, moved verbatim, with these changes:
  //   key={key}                         (unchanged text, new key value above)
  //   draggable={draggableProject}
  //   onDrop={() => handleDropProject(project.id)}
  //   the ⠿ handle condition: {draggableProject && ( ... )}
  // `project` is the function argument (no `const { project } = item`).
}

function renderListener(listener: Listener) {
  const key = `listener:${listener.id}`
  const draggableListener = sort === 'custom' && !truncated
  const hasNameOrSlug = Boolean(listener.label || listener.slug)
  const primaryText =
    listener.label ||
    listener.slug ||
    new Date(listener.createdAt).toLocaleString()
  // ... the existing listener <li> block, moved verbatim, with these changes:
  //   draggable={draggableListener}
  //   onDrop={() => handleDropListener(listener.id)}
  //   the ⠿ handle condition: {draggableListener && ( ... )}
}
```

Then, where the old `{items.length > 0 && (<> sort buttons + <ul>…</ul> </>)}` block was, render:

```tsx
{
  ;(sortedProjects.length > 0 || standalone.length > 0) && (
    <div
      className="mb-2 mt-8 flex items-center gap-1"
      role="group"
      aria-label="Sort listeners"
    >
      {/* the existing SORT_OPTIONS.map(...) buttons, moved verbatim */}
    </div>
  )
}
{
  sortedProjects.length > 0 && (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
        Projects
      </h2>
      <ul className="space-y-2">{sortedProjects.map(renderProject)}</ul>
    </section>
  )
}
{
  standalone.length > 0 && (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
        Listeners
      </h2>
      <ul className="space-y-2">{standalone.map(renderListener)}</ul>
      {hasMore && <div ref={sentinelRef} aria-hidden="true" className="h-4" />}
      {loadingMore && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Loading more…
        </p>
      )}
      {truncated && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Showing the first 500 listeners — more exist.
          {sort === 'custom' ? ' Reordering is unavailable.' : ''}
        </p>
      )}
    </section>
  )
}
```

(Keep the "Shared with me" block untouched after it. The sort buttons' markup is copied from the existing block unchanged.)

- [ ] **Step 5: Verify**

Run: `cd frontend && npm test && npm run build`
Expected: tests PASS; build clean. Then verify by reading `Home.tsx` and reporting: no remaining references to `listListeners`, `mergeItems`, `itemKey`, `toReorderItem`, `HomeItem`, `setListeners`, `listeners.filter`; `grep -rn mergeHomeItems frontend/src` returns nothing; both section handlers use `moveItem`; drag handles and `draggable` are gated as specified; the page has no polling.

- [ ] **Step 6: Stage**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git add frontend/src/pages/Home.tsx frontend/src/lib/mergeHomeItems.ts
```

(`git add` on the deleted path stages the deletion.)

- [ ] **Step 7: Commit**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git commit -m "feat(frontend): split Home into projects and a paginated listeners section"
```

---

### Task 6: Docs and verification (STOP before any prod or remote action)

**Files:**

- Modify: `STATUS.md` (only where now inaccurate or to record the new behaviour)
- Modify: `CLAUDE.md` only if something there is now false (probably nothing)

**Interfaces:**

- Consumes/Produces: none.

- [ ] **Step 1: Docs sweep**

Run `grep -n -i "100\|more exist\|home\|mergeHome\|standalone\|poll\|index" STATUS.md CLAUDE.md BACKLOG.md` (from the worktree root). Update, minimally and matching STATUS.md's existing style: the item added for project pages that says "capped at 100 with a note" (now infinite scroll, Name/Custom capped at 500 with a note and no timer polling); Home layout (Projects section above a paginated Listeners section; Recent activity sort orders projects by created date); the new endpoints (`GET /api/standalone-listeners`, paginated `GET /api/projects/:id`) and migration `0013`; the known limitations (activity cursors can briefly repeat/miss rows; Name/Custom cost O(project size) per load; reorder disabled when truncated). Update test counts if STATUS.md states them (read them from the real run in Step 2, do not guess).

- [ ] **Step 2: Full verification — read the output**

- `cd backend && npm test && npx tsc --noEmit` — all PASS except the single known `src/app.session.test.ts` failure; report the pass count.
- `cd frontend && npm test && npm run build` — PASS; report the count.
- Prettier on changed files: `cd /Users/Ben.Elliot/repos/webhook-listener-paging && npx prettier --check $(git diff --name-only origin/main --diff-filter=ACMR | grep -E '\.(ts|tsx|md|yml|json|sql)$')`. If it reports files, run `npx prettier --write` on exactly those files and re-check (never format `.superpowers/`).
- Check every commit header on the branch is <= 100 characters: `git log origin/main..HEAD --format='%h %s' | awk '{ if (length($0)-8 > 100) print "TOO LONG: " $0 }'` and expect no output.

- [ ] **Step 3: Stage and commit docs/format fixes**

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git add STATUS.md CLAUDE.md
```

(Add any file Prettier rewrote by explicit path; stage only files that changed. If nothing changed, skip.) Then, as a separate command, if there are staged changes:

```bash
cd /Users/Ben.Elliot/repos/webhook-listener-paging && git commit -m "docs: record paginated listener lists and migration 0013"
```

- [ ] **Step 4: STOP — hand back to the controller**

Do NOT apply the migration to prod, push the branch, or open a PR. Those are done by the controller with the user's confirmation, in this order: (1) apply `0013_listener_paging_indexes.sql` to prod D1 and verify with `EXPLAIN QUERY PLAN` (the migration is additive; queries are correct without it but slow); (2) push and open the PR with the `preview` label; (3) after merge/release, compare D1 per-query rows read.
