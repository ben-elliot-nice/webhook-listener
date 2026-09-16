# Shareable Read-Only View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a webhook listener's owner generate a revocable, read-only share
link that shows the same request history to someone else without granting
delete access or exposing the actual webhook hook URL.

**Architecture:** Add a nullable `share_token` column to the existing
`listeners` table (with a guarded migration, since the schema uses
`CREATE TABLE IF NOT EXISTS`). Add two owner-only share-management routes and
one new public read-only route (`GET /api/shared/:token/requests`) whose
response never includes the listener's real UUID. On the frontend, add a
"Share" section to the existing owner page and a new read-only page that
reuses the existing request-list components (filters, syntax highlighting,
diff, export) unchanged apart from a small type refactor that drops the
`listenerId` field these components never needed in the first place.

**Tech Stack:** Same as the existing project — Node/TypeScript/Fastify/
better-sqlite3 backend, React/Vite/Tailwind frontend, Vitest for backend
tests.

**Spec:** `docs/superpowers/specs/2026-09-16-shareable-readonly-view-design.md`

## Global Constraints

- No authentication anywhere (existing project-wide constraint, unchanged).
- The read-only view and every response under `/api/shared/*` must never
  include the listener's real UUID.
- No delete/mutation capability exists under `/api/shared/*` — by
  construction (no such route), not by a permission check.
- Share token generation reuses `randomUUID()`, matching the existing
  listener-id generation pattern (same entropy/security model).
- `POST /api/listeners/:id/share` is idempotent — repeated calls with an
  existing token return that same token, not a new one.
- `DELETE /api/listeners/:id/share` sets `share_token` back to `NULL`;
  generating a link again afterward produces a **new**, different token.
- The schema is applied via `CREATE TABLE IF NOT EXISTS`, which is a no-op
  against an already-existing database file — the `share_token` column
  migration must explicitly check for the column's existence (via
  `PRAGMA table_info`) before running `ALTER TABLE`, since SQLite has no
  `ADD COLUMN IF NOT EXISTS`.
- Frontend polling reuses the existing pattern exactly: `POLL_INTERVAL_MS =
  3000`, stop polling after `MAX_CONSECUTIVE_NOT_FOUND = 2` consecutive 404s.
- No automated frontend tests exist in this project (established scope) —
  frontend verification is `npm run build` (0 TypeScript errors) plus manual
  checks.

---

## File Structure

```
backend/
  src/
    db.ts                       # MODIFY: add share_token migration
    db.test.ts                  # MODIFY: add migration tests
    listeners.repo.ts           # MODIFY: add share-token functions
    listeners.repo.test.ts      # MODIFY: add share-token tests
    server.ts                   # MODIFY: register the new shared-routes plugin
    routes/
      listeners.ts              # MODIFY: add share endpoints, shareUrl field
      listeners.share.test.ts   # CREATE: tests for share management endpoints
      shared.ts                 # CREATE: GET /api/shared/:token/requests
      shared.test.ts            # CREATE: tests for the read-only route

frontend/
  src/
    api.ts                      # MODIFY: add RequestDetail, ShareLink types + functions
    App.tsx                     # MODIFY: add /shared/:token route
    pages/
      Listener.tsx               # MODIFY: add Share section
      SharedListener.tsx          # CREATE: read-only page
    components/
      RequestRow.tsx             # MODIFY: use RequestDetail instead of CapturedRequest
    lib/
      filterRequests.ts          # MODIFY: use RequestDetail instead of CapturedRequest
      exportRequests.ts          # MODIFY: use RequestDetail instead of CapturedRequest, optional hookUrl
```

---

### Task 1: Database migration + share-token repository functions

**Files:**
- Modify: `backend/src/db.ts`
- Modify: `backend/src/db.test.ts`
- Modify: `backend/src/listeners.repo.ts`
- Modify: `backend/src/listeners.repo.test.ts`

**Interfaces:**
- Consumes: nothing new — builds directly on the existing `Db`/`createDb` and
  `ListenerRecord`/`createListener`/`getListener`/`deleteListener`.
- Produces: `ListenerRecord` gains a `shareToken: string | null` field.
  New functions from `backend/src/listeners.repo.ts`:
  `getOrCreateShareToken(db: Db, id: string): string | undefined`,
  `revokeShareToken(db: Db, id: string): boolean`,
  `getListenerByShareToken(db: Db, token: string): ListenerRecord | undefined`.
  Used by Task 2 (share management routes) and Task 3 (public read-only route).

- [ ] **Step 1: Write the failing migration tests**

Modify `backend/src/db.test.ts` — add two new tests to the existing
`describe('createDb', ...)` block (keep the existing first test unchanged):

```ts
import { describe, it, expect } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db'

describe('createDb', () => {
  it('creates listeners and requests tables', () => {
    const db = createDb(':memory:')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual(['listeners', 'requests'])
  })

  it('adds a share_token column to the listeners table', () => {
    const db = createDb(':memory:')
    const columns = db.pragma('table_info(listeners)') as { name: string }[]
    expect(columns.map((c) => c.name)).toContain('share_token')
  })

  it('is safe to run the migration twice against the same database file', () => {
    const path = join(tmpdir(), `webhook-listener-migration-test-${Date.now()}.db`)
    try {
      createDb(path)
      expect(() => createDb(path)).not.toThrow()
    } finally {
      rmSync(path, { force: true })
      rmSync(`${path}-wal`, { force: true })
      rmSync(`${path}-shm`, { force: true })
    }
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run (from `backend/`): `npx vitest run src/db.test.ts`
Expected: the first test still passes; the two new tests FAIL (no
`share_token` column exists yet).

- [ ] **Step 3: Implement the migration**

Replace the full contents of `backend/src/db.ts`:

```ts
import Database from 'better-sqlite3'

export type Db = Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listeners (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listener_id TEXT NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  headers TEXT NOT NULL,
  query_params TEXT NOT NULL,
  body TEXT,
  content_type TEXT,
  source_ip TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_listener_received
  ON requests(listener_id, received_at DESC);
`

function ensureShareTokenColumn(db: Db): void {
  const columns = db.pragma('table_info(listeners)') as { name: string }[]
  const hasShareToken = columns.some((c) => c.name === 'share_token')
  if (!hasShareToken) {
    db.exec('ALTER TABLE listeners ADD COLUMN share_token TEXT UNIQUE')
  }
}

export function createDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  ensureShareTokenColumn(db)
  return db
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/db.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Write the failing repository tests**

Replace the full contents of `backend/src/listeners.repo.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from './db'
import {
  createListener,
  getListener,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
  getListenerByShareToken,
} from './listeners.repo'

describe('listeners repo', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('creates and fetches a listener', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z')
    const found = getListener(db, 'listener-1')
    expect(found).toEqual({ id: 'listener-1', createdAt: '2024-01-01T00:00:00.000Z', shareToken: null })
  })

  it('returns undefined for an unknown listener', () => {
    expect(getListener(db, 'does-not-exist')).toBeUndefined()
  })

  it('deletes a listener and reports success', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z')
    expect(deleteListener(db, 'listener-1')).toBe(true)
    expect(getListener(db, 'listener-1')).toBeUndefined()
  })

  it('reports failure when deleting an unknown listener', () => {
    expect(deleteListener(db, 'does-not-exist')).toBe(false)
  })
})

describe('share tokens', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z')
  })

  it('creates a share token on first call and reuses it on subsequent calls', () => {
    const first = getOrCreateShareToken(db, 'listener-1')
    const second = getOrCreateShareToken(db, 'listener-1')
    expect(first).toBeTypeOf('string')
    expect(second).toBe(first)
  })

  it('returns undefined for an unknown listener', () => {
    expect(getOrCreateShareToken(db, 'does-not-exist')).toBeUndefined()
  })

  it('looks up a listener by its share token', () => {
    const token = getOrCreateShareToken(db, 'listener-1') as string
    const found = getListenerByShareToken(db, token)
    expect(found?.id).toBe('listener-1')
  })

  it('returns undefined for an unknown share token', () => {
    expect(getListenerByShareToken(db, 'does-not-exist')).toBeUndefined()
  })

  it('revokes a share token', () => {
    const token = getOrCreateShareToken(db, 'listener-1') as string
    expect(revokeShareToken(db, 'listener-1')).toBe(true)
    expect(getListenerByShareToken(db, token)).toBeUndefined()
  })

  it('reports failure when revoking an unknown listener', () => {
    expect(revokeShareToken(db, 'does-not-exist')).toBe(false)
  })
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/listeners.repo.test.ts`
Expected: FAIL — `getOrCreateShareToken` etc. don't exist yet; the first
test also fails (missing `shareToken: null` in the returned object).

- [ ] **Step 7: Implement the repository functions**

Replace the full contents of `backend/src/listeners.repo.ts`:

```ts
import { randomUUID } from 'node:crypto'
import type { Db } from './db'

export interface ListenerRecord {
  id: string
  createdAt: string
  shareToken: string | null
}

export function createListener(db: Db, id: string, createdAt: string): ListenerRecord {
  db.prepare('INSERT INTO listeners (id, created_at) VALUES (?, ?)').run(id, createdAt)
  return { id, createdAt, shareToken: null }
}

export function getListener(db: Db, id: string): ListenerRecord | undefined {
  return db
    .prepare('SELECT id, created_at AS createdAt, share_token AS shareToken FROM listeners WHERE id = ?')
    .get(id) as ListenerRecord | undefined
}

export function deleteListener(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM listeners WHERE id = ?').run(id)
  return result.changes > 0
}

export function getOrCreateShareToken(db: Db, id: string): string | undefined {
  const listener = getListener(db, id)
  if (!listener) return undefined
  if (listener.shareToken) return listener.shareToken

  const token = randomUUID()
  db.prepare('UPDATE listeners SET share_token = ? WHERE id = ?').run(token, id)
  return token
}

export function revokeShareToken(db: Db, id: string): boolean {
  const result = db.prepare('UPDATE listeners SET share_token = NULL WHERE id = ?').run(id)
  return result.changes > 0
}

export function getListenerByShareToken(db: Db, token: string): ListenerRecord | undefined {
  return db
    .prepare('SELECT id, created_at AS createdAt, share_token AS shareToken FROM listeners WHERE share_token = ?')
    .get(token) as ListenerRecord | undefined
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/listeners.repo.test.ts src/db.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 9: Run the full backend suite once**

Run (from `backend/`): `npm test`
Expected: all existing test files still pass (the `ListenerRecord` shape
change doesn't affect `requests.repo.test.ts`, `server.test.ts`, or
`routes/hook.test.ts`, since none of them do a full-object equality check
against a `ListenerRecord`).

- [ ] **Step 10: Commit**

```bash
git add backend/src/db.ts backend/src/db.test.ts backend/src/listeners.repo.ts backend/src/listeners.repo.test.ts
git commit -m "feat(backend): add share_token migration and repository functions"
```

---

### Task 2: Share management routes + shareUrl field

**Files:**
- Modify: `backend/src/routes/listeners.ts`
- Create: `backend/src/routes/listeners.share.test.ts`

**Interfaces:**
- Consumes: `getListener`, `deleteListener`, `createListener`,
  `getOrCreateShareToken`, `revokeShareToken` from
  `backend/src/listeners.repo.ts` (Task 1). `getRequests` from
  `backend/src/requests.repo.ts` (unchanged, existing).
- Produces: `POST /api/listeners/:id/share` → `{ shareToken: string;
  shareUrl: string }`. `DELETE /api/listeners/:id/share` → `204`. The
  existing `POST /api/listeners` and `GET /api/listeners/:id` responses gain
  a `shareUrl: string | null` field. Consumed by Task 4 (frontend `api.ts`).

- [ ] **Step 1: Write the failing tests**

Create `backend/src/routes/listeners.share.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'

describe('listener share management', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id
  })

  it('has no share link by default', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/listeners/${listenerId}` })
    expect(response.json().shareUrl).toBeNull()
  })

  it('creates a share link', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.shareToken).toBeTypeOf('string')
    expect(body.shareUrl).toBe(`http://localhost:8080/shared/${body.shareToken}`)
  })

  it('is idempotent — repeat calls return the same token', async () => {
    const first = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    const second = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    expect(second.json().shareToken).toBe(first.json().shareToken)
  })

  it('reflects the created share link on the listener', async () => {
    const shareResponse = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    const listenerResponse = await app.inject({ method: 'GET', url: `/api/listeners/${listenerId}` })
    expect(listenerResponse.json().shareUrl).toBe(shareResponse.json().shareUrl)
  })

  it('revokes a share link', async () => {
    await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    const revokeResponse = await app.inject({ method: 'DELETE', url: `/api/listeners/${listenerId}/share` })
    expect(revokeResponse.statusCode).toBe(204)

    const listenerResponse = await app.inject({ method: 'GET', url: `/api/listeners/${listenerId}` })
    expect(listenerResponse.json().shareUrl).toBeNull()
  })

  it('generates a new token after revoke then re-share', async () => {
    const first = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    await app.inject({ method: 'DELETE', url: `/api/listeners/${listenerId}/share` })
    const second = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    expect(second.json().shareToken).not.toBe(first.json().shareToken)
  })

  it('returns 404 for an unknown listener on both endpoints', async () => {
    const shareResponse = await app.inject({ method: 'POST', url: '/api/listeners/does-not-exist/share' })
    expect(shareResponse.statusCode).toBe(404)

    const revokeResponse = await app.inject({ method: 'DELETE', url: '/api/listeners/does-not-exist/share' })
    expect(revokeResponse.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/routes/listeners.share.test.ts`
Expected: FAIL — `/api/listeners/:id/share` doesn't exist yet (404s where
200/204 expected), and `shareUrl` is missing from listener responses.

- [ ] **Step 3: Implement the routes**

Replace the full contents of `backend/src/routes/listeners.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import {
  createListener,
  getListener,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
} from '../listeners.repo'
import { getRequests } from '../requests.repo'

function shareUrlFor(baseUrl: string, shareToken: string | null): string | null {
  return shareToken ? `${baseUrl}/shared/${shareToken}` : null
}

export function registerListenerRoutes(app: FastifyInstance, db: Db, baseUrl: string): void {
  app.post('/api/listeners', async (_request, reply) => {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const listener = createListener(db, id, createdAt)
    reply.code(201)
    return {
      id: listener.id,
      createdAt: listener.createdAt,
      hookUrl: `${baseUrl}/hook/${listener.id}`,
      shareUrl: shareUrlFor(baseUrl, listener.shareToken),
    }
  })

  app.get<{ Params: { id: string } }>('/api/listeners/:id', async (request, reply) => {
    const listener = getListener(db, request.params.id)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    return {
      id: listener.id,
      createdAt: listener.createdAt,
      hookUrl: `${baseUrl}/hook/${listener.id}`,
      shareUrl: shareUrlFor(baseUrl, listener.shareToken),
    }
  })

  app.get<{ Params: { id: string } }>('/api/listeners/:id/requests', async (request, reply) => {
    const listener = getListener(db, request.params.id)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    const requests = getRequests(db, listener.id)
    return requests.map((r) => ({
      ...r,
      headers: JSON.parse(r.headers),
      queryParams: JSON.parse(r.queryParams),
    }))
  })

  app.delete<{ Params: { id: string } }>('/api/listeners/:id', async (request, reply) => {
    const deleted = deleteListener(db, request.params.id)
    if (!deleted) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    reply.code(204)
    return null
  })

  app.post<{ Params: { id: string } }>('/api/listeners/:id/share', async (request, reply) => {
    const token = getOrCreateShareToken(db, request.params.id)
    if (!token) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    return { shareToken: token, shareUrl: shareUrlFor(baseUrl, token) }
  })

  app.delete<{ Params: { id: string } }>('/api/listeners/:id/share', async (request, reply) => {
    const revoked = revokeShareToken(db, request.params.id)
    if (!revoked) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    reply.code(204)
    return null
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/routes/listeners.share.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite once**

Run (from `backend/`): `npm test`
Expected: all test files pass, including the existing `server.test.ts` and
`routes/hook.test.ts` (neither depends on the absence of a `shareUrl` field).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/listeners.ts backend/src/routes/listeners.share.test.ts
git commit -m "feat(backend): add share link management endpoints"
```

---

### Task 3: Public read-only shared route

**Files:**
- Create: `backend/src/routes/shared.ts`
- Modify: `backend/src/server.ts`
- Create: `backend/src/routes/shared.test.ts`

**Interfaces:**
- Consumes: `getListenerByShareToken` from `backend/src/listeners.repo.ts`
  (Task 1); `getRequests` from `backend/src/requests.repo.ts` (existing).
- Produces: `export function registerSharedRoutes(app: FastifyInstance, db:
  Db): void`, registered in `buildServer`. `GET /api/shared/:token/requests`
  → an array of request objects with the same fields as
  `GET /api/listeners/:id/requests` **except** `listenerId` is omitted.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/routes/shared.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'

describe('shared read-only route', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string
  let shareToken: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id

    const shareResponse = await app.inject({ method: 'POST', url: `/api/listeners/${listenerId}/share` })
    shareToken = shareResponse.json().shareToken

    await app.inject({
      method: 'POST',
      url: `/hook/${listenerId}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ foo: 'bar' }),
    })
  })

  it('returns captured requests for a valid share token', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/shared/${shareToken}/requests` })
    expect(response.statusCode).toBe(200)
    const [captured] = response.json()
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.method).toBe('POST')
  })

  it('never includes the real listener id anywhere in the response', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/shared/${shareToken}/requests` })
    expect(response.body).not.toContain(listenerId)
  })

  it('returns 404 for an unknown share token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/shared/does-not-exist/requests' })
    expect(response.statusCode).toBe(404)
  })

  it('returns 404 after the share token has been revoked', async () => {
    await app.inject({ method: 'DELETE', url: `/api/listeners/${listenerId}/share` })
    const response = await app.inject({ method: 'GET', url: `/api/shared/${shareToken}/requests` })
    expect(response.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/routes/shared.test.ts`
Expected: FAIL — `/api/shared/:token/requests` doesn't exist yet (all
requests 404, including the ones expecting 200).

- [ ] **Step 3: Implement the route and register it**

Create `backend/src/routes/shared.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db'
import { getListenerByShareToken } from '../listeners.repo'
import { getRequests } from '../requests.repo'

export function registerSharedRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { token: string } }>('/api/shared/:token/requests', async (request, reply) => {
    const listener = getListenerByShareToken(db, request.params.token)
    if (!listener) {
      reply.code(404)
      return { error: 'share link not found' }
    }
    const requests = getRequests(db, listener.id)
    return requests.map((r) => ({
      id: r.id,
      method: r.method,
      headers: JSON.parse(r.headers),
      queryParams: JSON.parse(r.queryParams),
      body: r.body,
      contentType: r.contentType,
      sourceIp: r.sourceIp,
      receivedAt: r.receivedAt,
    }))
  })
}
```

Note the response is built as an explicit object (not `{...r, ...}`) so that
`r.listenerId` — the real listener UUID — is never spread into it. This is
the load-bearing line for this task's security property.

Modify `backend/src/server.ts` — add the import and registration:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db'
import { registerListenerRoutes } from './routes/listeners'
import { registerHookRoute } from './routes/hook'
import { registerSharedRoutes } from './routes/shared'

export interface ServerOptions {
  db: Db
  baseUrl: string
}

export function buildServer({ db, baseUrl }: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    bodyLimit: 10 * 1024 * 1024,
  })

  registerListenerRoutes(app, db, baseUrl)
  registerSharedRoutes(app, db)

  // The hook route needs every request body captured as a raw string regardless of
  // content-type, since it must accept arbitrary webhook payload shapes. That parser
  // override is scoped to this plugin registration so it can't leak into /api/* routes.
  app.register(async (scope) => {
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body)
    })
    scope.removeContentTypeParser(['application/json'])
    registerHookRoute(scope, db)
  })

  return app
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/routes/shared.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite once**

Run (from `backend/`): `npm test`
Expected: all test files pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/shared.ts backend/src/server.ts backend/src/routes/shared.test.ts
git commit -m "feat(backend): add public read-only shared requests route"
```

---

### Task 4: Frontend API client — share link management

**Files:**
- Modify: `frontend/src/api.ts`

**Interfaces:**
- Consumes: nothing new — extends the existing `Listener` interface and
  `ApiError`/`parseJsonOrThrow` pattern already in this file.
- Produces: `Listener` gains `shareUrl: string | null`. New
  `export interface ShareLink { shareToken: string; shareUrl: string }`,
  `export function getOrCreateShareLink(id: string): Promise<ShareLink>`,
  `export async function revokeShareLink(id: string): Promise<void>`. Used by
  Task 6 (owner page Share section).

- [ ] **Step 1: Implement the API client additions**

Replace the full contents of `frontend/src/api.ts`:

```ts
export interface Listener {
  id: string
  createdAt: string
  hookUrl: string
  shareUrl: string | null
}

export interface CapturedRequest {
  id: number
  listenerId: string
  method: string
  headers: Record<string, string>
  queryParams: Record<string, string | string[]>
  body: string | null
  contentType: string | null
  sourceIp: string | null
  receivedAt: string
}

export interface ShareLink {
  shareToken: string
  shareUrl: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number) {
    super(`request failed with status ${status}`)
    this.status = status
  }
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiError(response.status)
  }
  return response.json() as Promise<T>
}

export function createListener(): Promise<Listener> {
  return fetch('/api/listeners', { method: 'POST' }).then((r) => parseJsonOrThrow<Listener>(r))
}

export function getListener(id: string): Promise<Listener> {
  return fetch(`/api/listeners/${id}`).then((r) => parseJsonOrThrow<Listener>(r))
}

export function getRequests(id: string): Promise<CapturedRequest[]> {
  return fetch(`/api/listeners/${id}/requests`).then((r) => parseJsonOrThrow<CapturedRequest[]>(r))
}

export async function deleteListener(id: string): Promise<void> {
  const response = await fetch(`/api/listeners/${id}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function getOrCreateShareLink(id: string): Promise<ShareLink> {
  return fetch(`/api/listeners/${id}/share`, { method: 'POST' }).then((r) => parseJsonOrThrow<ShareLink>(r))
}

export async function revokeShareLink(id: string): Promise<void> {
  const response = await fetch(`/api/listeners/${id}/share`, { method: 'DELETE' })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}
```

- [ ] **Step 2: Verify the frontend builds**

Run (from `frontend/`): `npm run build`
Expected: build completes with 0 TypeScript errors. (No existing code
constructs a `Listener` object literal outside API responses, so the new
required `shareUrl` field doesn't break anything.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(frontend): add share link API client functions"
```

---

### Task 5: Read-only shared listener page

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/components/RequestRow.tsx`
- Modify: `frontend/src/lib/filterRequests.ts`
- Modify: `frontend/src/lib/exportRequests.ts`
- Create: `frontend/src/pages/SharedListener.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `getSharedRequests` (added to `api.ts` in this task);
  `RequestRow`, `RequestFilters`, `filterRequests`/`uniqueMethods`/
  `uniqueContentTypes`, `downloadFile`/`toJsonExport`/`toHarExport` — all
  existing, refactored in this task to accept the narrower `RequestDetail`
  type instead of `CapturedRequest`.
- Produces: route `/shared/:token` rendering `SharedListener`. `api.ts`
  gains `export interface RequestDetail { id: number; method: string;
  headers: Record<string, string>; queryParams: Record<string, string |
  string[]>; body: string | null; contentType: string | null; sourceIp:
  string | null; receivedAt: string }`, with `CapturedRequest extends
  RequestDetail { listenerId: string }`, and
  `export function getSharedRequests(token: string): Promise<RequestDetail[]>`.

- [ ] **Step 1: Add the RequestDetail type and getSharedRequests to api.ts**

In `frontend/src/api.ts`, replace the `CapturedRequest` interface and add a
new type and function. The relevant section becomes:

```ts
export interface RequestDetail {
  id: number
  method: string
  headers: Record<string, string>
  queryParams: Record<string, string | string[]>
  body: string | null
  contentType: string | null
  sourceIp: string | null
  receivedAt: string
}

export interface CapturedRequest extends RequestDetail {
  listenerId: string
}
```

(This replaces the standalone `CapturedRequest` interface from Task 4 —
same fields, now split into a base type plus the owner-only `listenerId`.)

And add, alongside the other exported functions:

```ts
export function getSharedRequests(token: string): Promise<RequestDetail[]> {
  return fetch(`/api/shared/${token}/requests`).then((r) => parseJsonOrThrow<RequestDetail[]>(r))
}
```

- [ ] **Step 2: Update RequestRow to use RequestDetail**

In `frontend/src/components/RequestRow.tsx`, change the import and prop
types only — no logic changes (every field `RequestRow` reads —
`method`, `contentType`, `receivedAt`, `headers`, `queryParams`, `sourceIp`,
`body`, `id` — is present on `RequestDetail`):

Change:
```ts
import type { CapturedRequest } from '../api'
```
to:
```ts
import type { RequestDetail } from '../api'
```

Change:
```ts
interface RequestRowProps {
  request: CapturedRequest
  previousRequest?: CapturedRequest
}
```
to:
```ts
interface RequestRowProps {
  request: RequestDetail
  previousRequest?: RequestDetail
}
```

- [ ] **Step 3: Update filterRequests to use RequestDetail**

Replace the full contents of `frontend/src/lib/filterRequests.ts`:

```ts
import type { RequestDetail } from '../api'

export interface RequestFilter {
  method: string
  contentType: string
  search: string
}

export const ALL = 'All'

export function filterRequests(requests: RequestDetail[], filter: RequestFilter): RequestDetail[] {
  const search = filter.search.trim().toLowerCase()

  return requests.filter((req) => {
    if (filter.method !== ALL && req.method !== filter.method) return false
    if (filter.contentType !== ALL && (req.contentType ?? 'none') !== filter.contentType) return false

    if (search) {
      const haystack = [req.body ?? '', JSON.stringify(req.headers), JSON.stringify(req.queryParams)]
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(search)) return false
    }

    return true
  })
}

export function uniqueMethods(requests: RequestDetail[]): string[] {
  return [...new Set(requests.map((r) => r.method))].sort()
}

export function uniqueContentTypes(requests: RequestDetail[]): string[] {
  return [...new Set(requests.map((r) => r.contentType ?? 'none'))].sort()
}
```

- [ ] **Step 4: Update exportRequests to use RequestDetail and an optional hookUrl**

Replace the full contents of `frontend/src/lib/exportRequests.ts`:

```ts
import type { RequestDetail } from '../api'
import { prettyPrintBody } from './prettyPrint'

function safeParse(body: string | null): unknown {
  if (!body) return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function toJsonExport(requests: RequestDetail[]): string {
  return JSON.stringify(
    requests.map((req) => ({
      method: req.method,
      headers: req.headers,
      queryParams: req.queryParams,
      contentType: req.contentType,
      sourceIp: req.sourceIp,
      receivedAt: req.receivedAt,
      body: safeParse(req.body),
    })),
    null,
    2
  )
}

function toHeaderEntries(headers: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}

function toQueryEntries(queryParams: Record<string, string | string[]>): { name: string; value: string }[] {
  return Object.entries(queryParams).flatMap(([name, value]) =>
    Array.isArray(value) ? value.map((v) => ({ name, value: v })) : [{ name, value }]
  )
}

export function toHarExport(requests: RequestDetail[], hookUrl: string = ''): string {
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'webhook-listener', version: '1.0' },
      entries: requests.map((req) => ({
        startedDateTime: req.receivedAt,
        time: 0,
        request: {
          method: req.method,
          url: hookUrl,
          httpVersion: 'HTTP/1.1',
          headers: toHeaderEntries(req.headers),
          queryString: toQueryEntries(req.queryParams),
          postData: req.body
            ? { mimeType: req.contentType ?? 'application/octet-stream', text: prettyPrintBody(req.body) }
            : undefined,
          headersSize: -1,
          bodySize: req.body?.length ?? 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [],
          content: { size: 0, mimeType: 'text/plain', text: '' },
          headersSize: -1,
          bodySize: 0,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      })),
    },
  }
  return JSON.stringify(har, null, 2)
}

export function downloadFile(filename: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
```

`hookUrl` is now optional (defaults to `''`) because the shared read-only
page exports the same JSON/HAR history but deliberately doesn't know (and
must never show) the real hook URL — the exported HAR's `request.url` field
is simply empty in that case.

- [ ] **Step 5: Verify the refactor alone builds clean**

Run (from `frontend/`): `npm run build`
Expected: 0 TypeScript errors. `Listener.tsx` (which still uses
`CapturedRequest` for its own state) continues to work unchanged, since
`CapturedRequest` now structurally satisfies `RequestDetail` wherever it's
passed into `RequestRow`/`filterRequests`/`exportRequests`.

- [ ] **Step 6: Create the shared read-only page**

Create `frontend/src/pages/SharedListener.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError, type RequestDetail, getSharedRequests } from '../api'
import { RequestRow } from '../components/RequestRow'
import { RequestFilters } from '../components/RequestFilters'
import { ALL, filterRequests, uniqueContentTypes, uniqueMethods, type RequestFilter } from '../lib/filterRequests'
import { downloadFile, toHarExport, toJsonExport } from '../lib/exportRequests'

const POLL_INTERVAL_MS = 3000
const MAX_CONSECUTIVE_NOT_FOUND = 2

export function SharedListener() {
  const { token } = useParams<{ token: string }>()
  const [requests, setRequests] = useState<RequestDetail[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<RequestFilter>({ method: ALL, contentType: ALL, search: '' })
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
    if (!token) return false
    try {
      const requestData = await getSharedRequests(token)
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
  }, [token])

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
    if (!token) return
    downloadFile(`webhook-shared-${token}.json`, toJsonExport(filteredRequests), 'application/json')
  }

  function handleExportHar() {
    if (!token) return
    downloadFile(`webhook-shared-${token}.har`, toHarExport(filteredRequests), 'application/json')
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Shared listener (read-only)</h1>
      </div>

      {error && (
        <p role="alert" className="mb-6 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
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
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
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
                onClick={handleExportJson}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Export JSON
              </button>
              <button
                onClick={handleExportHar}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Export HAR
              </button>
            </div>
          </div>

          {filteredRequests.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
              No requests match your filters.
            </div>
          ) : (
            <ul className="space-y-2">
              {filteredRequests.map((req) => (
                <RequestRow key={req.id} request={req} previousRequest={previousByRequestId.get(req.id)} />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  )
}
```

Note there is deliberately no delete button, no hook URL display, and no
share-management controls anywhere on this page.

- [ ] **Step 7: Wire the route into App**

Replace the full contents of `frontend/src/App.tsx`:

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'
import { SharedListener } from './pages/SharedListener'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/listener/:id" element={<Listener />} />
        <Route path="/shared/:token" element={<SharedListener />} />
      </Routes>
    </BrowserRouter>
  )
}
```

- [ ] **Step 8: Verify the frontend builds**

Run (from `frontend/`): `npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/api.ts frontend/src/components/RequestRow.tsx frontend/src/lib/filterRequests.ts frontend/src/lib/exportRequests.ts frontend/src/pages/SharedListener.tsx frontend/src/App.tsx
git commit -m "feat(frontend): add read-only shared listener page"
```

---

### Task 6: Owner page — Share section

**Files:**
- Modify: `frontend/src/pages/Listener.tsx`

**Interfaces:**
- Consumes: `getOrCreateShareLink`, `revokeShareLink` from
  `frontend/src/api.ts` (Task 4); `listener.shareUrl` (already present on
  the `Listener` type from Task 4, populated by the backend from Task 2).

- [ ] **Step 1: Add the Share section to the owner page**

In `frontend/src/pages/Listener.tsx`:

Change the import line:
```ts
import {
  ApiError,
  type CapturedRequest,
  type Listener as ListenerModel,
  deleteListener,
  getListener,
  getRequests,
} from '../api'
```
to:
```ts
import {
  ApiError,
  type CapturedRequest,
  type Listener as ListenerModel,
  deleteListener,
  getListener,
  getOrCreateShareLink,
  getRequests,
  revokeShareLink,
} from '../api'
```

Add a new piece of state alongside the existing `copied` state (the hookUrl
copy button already uses `copied` — the share link needs its own so both
can show independent "Copied!" feedback):
```ts
const [copied, setCopied] = useState(false)
const [shareCopied, setShareCopied] = useState(false)
```

Add three new handlers alongside the existing `handleCopy`:
```ts
async function handleShare() {
  if (!id) return
  try {
    await getOrCreateShareLink(id)
    await refresh()
  } catch {
    setError('Failed to create share link.')
  }
}

async function handleRevokeShare() {
  if (!id) return
  if (!window.confirm('Revoke this share link? Anyone using it will lose access.')) return
  try {
    await revokeShareLink(id)
    await refresh()
  } catch {
    setError('Failed to revoke share link.')
  }
}

async function handleCopyShare() {
  if (!listener?.shareUrl) return
  try {
    await navigator.clipboard.writeText(listener.shareUrl)
    setShareCopied(true)
    setTimeout(() => setShareCopied(false), 1500)
  } catch {
    setError('Failed to copy to clipboard.')
  }
}
```

Add a new block in the JSX, immediately after the existing hookUrl block
(the one showing `listener.hookUrl` with its Copy button) and before the
`{error && ...}` block:
```tsx
{listener && (
  <div className="mb-6 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
    {listener.shareUrl ? (
      <>
        <code className="flex-1 truncate text-sm text-slate-700">{listener.shareUrl}</code>
        <button
          onClick={handleCopyShare}
          className="shrink-0 rounded-md bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200"
        >
          {shareCopied ? 'Copied!' : 'Copy'}
        </button>
        <button
          onClick={handleRevokeShare}
          className="shrink-0 rounded-md border border-rose-200 px-3 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
        >
          Revoke share link
        </button>
      </>
    ) : (
      <button
        onClick={handleShare}
        className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200"
      >
        Get share link
      </button>
    )}
  </div>
)}
```

- [ ] **Step 2: Verify the frontend builds**

Run (from `frontend/`): `npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Listener.tsx
git commit -m "feat(frontend): add share link controls to the owner listener page"
```

---

### Task 7: End-to-end verification

**Files:** none (verification only).

**Interfaces:** none — this task exercises the full stack built by Tasks 1-6.

- [ ] **Step 1: Rebuild and bring up the stack**

Run: `docker compose up -d --build`
Expected: both containers report `Up` (`docker compose ps`).

- [ ] **Step 2: Create a listener and a share link**

```bash
LISTENER=$(curl -s -X POST http://localhost:8080/api/listeners)
LISTENER_ID=$(echo "$LISTENER" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
SHARE=$(curl -s -X POST "http://localhost:8080/api/listeners/$LISTENER_ID/share")
echo "$SHARE"
SHARE_TOKEN=$(echo "$SHARE" | python3 -c "import sys,json; print(json.load(sys.stdin)['shareToken'])")
```
Expected: `$SHARE` contains `shareToken` and a `shareUrl` of the form
`http://localhost:8080/shared/<shareToken>`.

- [ ] **Step 3: Send a payload and confirm it's visible via the share token**

```bash
curl -s -X POST "http://localhost:8080/hook/$LISTENER_ID" -H 'Content-Type: application/json' -d '{"shared":"test"}'
curl -s "http://localhost:8080/api/shared/$SHARE_TOKEN/requests"
```
Expected: the second command returns an array containing the captured
request, and the response body does **not** contain `$LISTENER_ID` anywhere
(spot-check by eye, or `curl -s ... | grep -c "$LISTENER_ID"` should print
`0`).

- [ ] **Step 4: Confirm the shared page loads in the UI**

Open `http://localhost:8080/shared/$SHARE_TOKEN` in a browser (or `curl -s
-o /dev/null -w '%{http_code}\n' "http://localhost:8080/shared/$SHARE_TOKEN"`
for a headless check — expect `200`).
Expected (manual): the page shows the request history with filters and
export buttons, but no delete button and no hook URL anywhere on the page.

- [ ] **Step 5: Revoke the share link and confirm it stops working**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "http://localhost:8080/api/listeners/$LISTENER_ID/share"
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:8080/api/shared/$SHARE_TOKEN/requests"
```
Expected: first command prints `204`, second prints `404`.

- [ ] **Step 6: Confirm generating a new link produces a different token**

```bash
curl -s -X POST "http://localhost:8080/api/listeners/$LISTENER_ID/share"
```
Expected: the returned `shareToken` differs from the original `$SHARE_TOKEN`.

- [ ] **Step 7: Confirm the owner page's Share section**

Open `http://localhost:8080/listener/$LISTENER_ID` in a browser.
Expected (manual): a "Get share link" button is present if no link exists
yet, or the current share URL with "Copy" and "Revoke share link" buttons if
one does; clicking through both states works and the shown link matches
what's returned by the API.

No commit needed for this task — it's verification only. If any step
fails, fix the underlying task's code, re-run that task's automated tests,
then re-run this task's steps from Step 1.
