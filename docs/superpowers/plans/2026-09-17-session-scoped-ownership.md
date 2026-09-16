# Session-Scoped Listener Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make owner access to a listener (`/listener/:id` and its API routes)
require an anonymous session cookie matching the listener's creator, instead
of the UUID alone being sufficient — while leaving the hook capture route and
the shareable read-only view completely untouched.

**Architecture:** A global Fastify request hook assigns (or reuses) an
anonymous `session_id` cookie on every request. Listeners record their
creator's session id at creation time. Five owner-only routes resolve the
listener through a single new repository function that matches on both id
and owner session, collapsing "doesn't exist" and "not yours" into one 404
response. `/hook/:id` and `/api/shared/:token/requests` are untouched — no
session check, by design.

**Tech Stack:** Same as the existing project — Node/TypeScript/Fastify/
better-sqlite3 backend, Vitest for backend tests. New dependency:
`@fastify/cookie`. No frontend changes.

**Spec:** `docs/superpowers/specs/2026-09-17-session-scoped-ownership-design.md`

## Global Constraints

- Exactly these five routes require the caller's session to match the
  listener's owner: `GET /api/listeners/:id`, `GET /api/listeners/:id/requests`,
  `DELETE /api/listeners/:id`, `POST /api/listeners/:id/share`,
  `DELETE /api/listeners/:id/share`.
- `ALL /hook/:id` and `GET /api/shared/:token/requests` are NOT gated by
  session — no code in this plan touches their behavior.
- A non-owner request and a request for a genuinely nonexistent listener
  return the exact same `404 { "error": "listener not found" }` — there is
  one code path for both, not two branches that happen to agree.
- Session cookie: name `session_id`, `httpOnly: true`, `sameSite: 'lax'`,
  `path: '/'`, `maxAge` of `60 * 60 * 24 * 365` seconds (~1 year), unsigned,
  no `Secure` flag (this project only ever runs over local HTTP).
- No migration or back-compat behavior for listeners created before this
  change — a listener with `owner_session = NULL` matches no session and
  is intentionally left permanently inaccessible via `/listener/:id`. Do
  not build any grandfathering/claiming logic.
- No frontend code changes are required — `fetch()`'s default
  `credentials: 'same-origin'` already sends cookies automatically for
  same-origin requests.
- The schema is applied via `CREATE TABLE IF NOT EXISTS`, a no-op against
  an existing database file — the `owner_session` column migration must
  check `PRAGMA table_info` before running `ALTER TABLE`, same pattern as
  the existing `share_token` migration.

---

## File Structure

```
backend/
  package.json                          # MODIFY: add @fastify/cookie dependency
  src/
    db.ts                                # MODIFY: add owner_session migration
    db.test.ts                           # MODIFY: add migration test
    listeners.repo.ts                    # MODIFY: createListener gains ownerSession param,
                                          #   ListenerRecord gains ownerSession field,
                                          #   new getListenerForOwner function
    listeners.repo.test.ts               # MODIFY: update + add ownership tests
    server.ts                            # MODIFY: register @fastify/cookie, add session hook
    server.session.test.ts               # CREATE: tests for the session cookie hook itself
    server.test.ts                       # MODIFY: carry session cookie across requests
    test-helpers/
      session.ts                         # CREATE: extractSessionId(response) test helper
    routes/
      listeners.ts                       # MODIFY: gate the 5 owner routes
      listeners.share.test.ts            # MODIFY: carry session cookie across requests
      listeners.ownership.test.ts        # CREATE: cross-session isolation tests
      hook.test.ts                       # MODIFY: carry session cookie across requests
      shared.test.ts                     # MODIFY: carry session cookie across requests
```

---

### Task 1: Database migration — `owner_session` column

**Files:**
- Modify: `backend/src/db.ts`
- Modify: `backend/src/db.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the `listeners` table gains a nullable `owner_session TEXT`
  column. Consumed by Task 3 (repository functions).

- [ ] **Step 1: Write the failing test**

Modify `backend/src/db.test.ts` — add one new test to the existing
`describe('createDb', ...)` block (keep the other tests unchanged):

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

  it('adds an owner_session column to the listeners table', () => {
    const db = createDb(':memory:')
    const columns = db.pragma('table_info(listeners)') as { name: string }[]
    expect(columns.map((c) => c.name)).toContain('owner_session')
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

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npx vitest run src/db.test.ts`
Expected: FAIL — the new "adds an owner_session column" test fails; the
others still pass.

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
    db.exec('ALTER TABLE listeners ADD COLUMN share_token TEXT')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_share_token ON listeners(share_token) WHERE share_token IS NOT NULL')
  }
}

function ensureOwnerSessionColumn(db: Db): void {
  const columns = db.pragma('table_info(listeners)') as { name: string }[]
  const hasOwnerSession = columns.some((c) => c.name === 'owner_session')
  if (!hasOwnerSession) {
    db.exec('ALTER TABLE listeners ADD COLUMN owner_session TEXT')
  }
}

export function createDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  ensureShareTokenColumn(db)
  ensureOwnerSessionColumn(db)
  return db
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `backend/`): `npx vitest run src/db.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Run the full backend suite once**

Run (from `backend/`): `npm test`
Expected: all existing test files still pass — this column is unused by
any other code yet, so nothing else should be affected.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db.ts backend/src/db.test.ts
git commit -m "feat(backend): add owner_session column migration"
```

---

### Task 2: Session cookie assignment hook

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/src/server.ts`
- Create: `backend/src/test-helpers/session.ts`
- Create: `backend/src/server.session.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks. This task does not touch
  `listeners.repo.ts`, so it cannot break any existing compile target.
- Produces: every request handled by the app has `request.sessionId: string`
  available (set by a global `onRequest` hook, either read from an existing
  `session_id` cookie or freshly generated and set via `Set-Cookie`).
  `backend/src/test-helpers/session.ts` exports
  `extractSessionId(response): string`, used by every test file in Task 4
  that needs to carry a session across multiple `app.inject()` calls.

- [ ] **Step 1: Add the dependency**

Modify `backend/package.json` — add to `dependencies`:

```json
"@fastify/cookie": "^9.0.0",
```

Run (from `backend/`): `npm install`
Expected: `package-lock.json` updates, no errors.

- [ ] **Step 2: Write the test helper**

Create `backend/src/test-helpers/session.ts`:

```ts
import type { FastifyInstance } from 'fastify'

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>

export function extractSessionId(response: InjectResponse): string {
  const cookie = response.cookies.find((c) => c.name === 'session_id')
  if (!cookie) {
    throw new Error('no session_id cookie found in response')
  }
  return cookie.value
}
```

- [ ] **Step 3: Write the failing tests**

Create `backend/src/server.session.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createDb } from './db'
import { buildServer } from './server'
import { extractSessionId } from './test-helpers/session'

describe('session cookie', () => {
  it('sets a session_id cookie when the request has none', async () => {
    const db = createDb(':memory:')
    const app = buildServer({ db, baseUrl: 'http://localhost:8080' })

    const response = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })
    const cookie = response.cookies.find((c) => c.name === 'session_id')
    expect(cookie).toBeDefined()
    expect(cookie?.value).toBeTypeOf('string')
  })

  it('reuses an existing session_id cookie instead of issuing a new one', async () => {
    const db = createDb(':memory:')
    const app = buildServer({ db, baseUrl: 'http://localhost:8080' })

    const first = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })
    const sessionId = extractSessionId(first)

    const second = await app.inject({
      method: 'GET',
      url: '/api/listeners/does-not-exist',
      cookies: { session_id: sessionId },
    })
    const reusedCookie = second.cookies.find((c) => c.name === 'session_id')
    expect(reusedCookie).toBeUndefined()
  })

  it('issues different session ids to requests with no cookie', async () => {
    const db = createDb(':memory:')
    const app = buildServer({ db, baseUrl: 'http://localhost:8080' })

    const first = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })
    const second = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })

    expect(extractSessionId(first)).not.toBe(extractSessionId(second))
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/server.session.test.ts`
Expected: FAIL — no `session_id` cookie is set yet (`buildServer` doesn't
register the cookie plugin or the hook).

- [ ] **Step 5: Implement the session cookie hook**

Replace the full contents of `backend/src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import { registerListenerRoutes } from './routes/listeners'
import { registerHookRoute } from './routes/hook'
import { registerSharedRoutes } from './routes/shared'

declare module 'fastify' {
  interface FastifyRequest {
    sessionId: string
  }
}

const SESSION_COOKIE_NAME = 'session_id'
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

export interface ServerOptions {
  db: Db
  baseUrl: string
}

export function buildServer({ db, baseUrl }: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    bodyLimit: 10 * 1024 * 1024,
  })

  app.register(fastifyCookie)
  app.decorateRequest('sessionId', '')

  app.addHook('onRequest', async (request, reply) => {
    const existing = request.cookies[SESSION_COOKIE_NAME]
    if (existing) {
      request.sessionId = existing
      return
    }

    const sessionId = randomUUID()
    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    })
    request.sessionId = sessionId
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

- [ ] **Step 6: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/server.session.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 7: Run the full backend suite once**

Run (from `backend/`): `npm test`
Expected: PASS — every existing test file. This task doesn't change any
consumed interface (`createListener`'s signature, `ListenerRecord`'s shape,
etc. are all untouched), so nothing else should be affected yet.

- [ ] **Step 8: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/server.ts backend/src/server.session.test.ts backend/src/test-helpers/session.ts
git commit -m "feat(backend): add anonymous session cookie assignment"
```

---

### Task 3: Repository layer — owner-session-aware listener lookup

**Files:**
- Modify: `backend/src/listeners.repo.ts`
- Modify: `backend/src/listeners.repo.test.ts`

**Interfaces:**
- Consumes: `Db`/`createDb` from `backend/src/db.ts` (Task 1).
- Produces: `ListenerRecord` gains `ownerSession: string | null`.
  `createListener(db: Db, id: string, createdAt: string, ownerSession: string): ListenerRecord`
  now requires a fourth argument. New function
  `getListenerForOwner(db: Db, id: string, sessionId: string): ListenerRecord | undefined`.
  Used by Task 4 (route gating), together with `request.sessionId` produced
  by Task 2's hook.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `backend/src/listeners.repo.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from './db'
import {
  createListener,
  getListener,
  getListenerForOwner,
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
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    const found = getListener(db, 'listener-1')
    expect(found).toEqual({
      id: 'listener-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      shareToken: null,
      ownerSession: 'session-a',
    })
  })

  it('returns undefined for an unknown listener', () => {
    expect(getListener(db, 'does-not-exist')).toBeUndefined()
  })

  it('deletes a listener and reports success', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    expect(deleteListener(db, 'listener-1')).toBe(true)
    expect(getListener(db, 'listener-1')).toBeUndefined()
  })

  it('reports failure when deleting an unknown listener', () => {
    expect(deleteListener(db, 'does-not-exist')).toBe(false)
  })
})

describe('getListenerForOwner', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
  })

  it('returns the listener when the session matches its owner', () => {
    const found = getListenerForOwner(db, 'listener-1', 'session-a')
    expect(found?.id).toBe('listener-1')
  })

  it('returns undefined when the session does not match', () => {
    expect(getListenerForOwner(db, 'listener-1', 'session-b')).toBeUndefined()
  })

  it('returns undefined for an unknown listener id', () => {
    expect(getListenerForOwner(db, 'does-not-exist', 'session-a')).toBeUndefined()
  })

  it('returns undefined for a listener with no owner_session recorded (legacy row)', () => {
    db.prepare("INSERT INTO listeners (id, created_at) VALUES ('legacy-listener', '2024-01-01T00:00:00.000Z')").run()
    expect(getListenerForOwner(db, 'legacy-listener', 'session-a')).toBeUndefined()
  })
})

describe('share tokens', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
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

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/listeners.repo.test.ts`
Expected: FAIL — `getListenerForOwner` doesn't exist yet, and
`createListener` doesn't accept a fourth argument yet (TypeScript compile
error surfaces as a test run failure).

- [ ] **Step 3: Implement the repository changes**

Replace the full contents of `backend/src/listeners.repo.ts`:

```ts
import { randomUUID } from 'node:crypto'
import type { Db } from './db'

export interface ListenerRecord {
  id: string
  createdAt: string
  shareToken: string | null
  ownerSession: string | null
}

export function createListener(db: Db, id: string, createdAt: string, ownerSession: string): ListenerRecord {
  db.prepare('INSERT INTO listeners (id, created_at, owner_session) VALUES (?, ?, ?)').run(id, createdAt, ownerSession)
  return { id, createdAt, shareToken: null, ownerSession }
}

export function getListener(db: Db, id: string): ListenerRecord | undefined {
  return db
    .prepare(
      'SELECT id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession FROM listeners WHERE id = ?'
    )
    .get(id) as ListenerRecord | undefined
}

export function getListenerForOwner(db: Db, id: string, sessionId: string): ListenerRecord | undefined {
  return db
    .prepare(
      'SELECT id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession FROM listeners WHERE id = ? AND owner_session = ?'
    )
    .get(id, sessionId) as ListenerRecord | undefined
}

export function deleteListener(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM listeners WHERE id = ?').run(id)
  return result.changes > 0
}

// Safe only because this whole function runs synchronously (better-sqlite3 is a
// synchronous driver) — nothing can interleave between the read and the write.
// Do not introduce an `await` between them without adding a transaction.
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
    .prepare(
      'SELECT id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession FROM listeners WHERE share_token = ?'
    )
    .get(token) as ListenerRecord | undefined
}
```

Note `getListener` and `getListenerByShareToken` are otherwise unchanged —
only their `SELECT` gained the `owner_session AS ownerSession` column so
`ListenerRecord`'s shape stays consistent. Neither function does an
ownership check; they remain session-agnostic existence/token lookups,
used respectively by the hook route and the shared route (both untouched
by this plan).

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/listeners.repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite once — expected to fail here**

Run (from `backend/`): `npm test`
Expected: FAIL with a TypeScript compile error. `backend/src/routes/listeners.ts`
still calls `createListener(db, id, createdAt)` with only 3 arguments (it
isn't updated until Task 4), and this task made the 4th argument
(`ownerSession`) mandatory. Because almost every test file imports
`buildServer` from `./server`, which imports `registerListenerRoutes` from
`./routes/listeners`, this one stale call site breaks compilation for most
of the suite — that's expected and correct at this checkpoint, not a bug
to chase. Confirm the failure is specifically this TypeScript error (an
argument-count mismatch on `createListener` in `routes/listeners.ts`), then
move on — do NOT modify `routes/listeners.ts` in this task; that happens in
Task 4's Step 1.

- [ ] **Step 6: Commit**

```bash
git add backend/src/listeners.repo.ts backend/src/listeners.repo.test.ts
git commit -m "feat(backend): add owner-session repository support"
```

---

### Task 4: Gate the five owner-only routes

**Files:**
- Modify: `backend/src/routes/listeners.ts`
- Modify: `backend/src/server.test.ts`
- Modify: `backend/src/routes/listeners.share.test.ts`
- Modify: `backend/src/routes/hook.test.ts`
- Modify: `backend/src/routes/shared.test.ts`
- Create: `backend/src/routes/listeners.ownership.test.ts`

**Interfaces:**
- Consumes: `getListenerForOwner`, `createListener` (new signature),
  `deleteListener`, `getOrCreateShareToken`, `revokeShareToken` from
  `backend/src/listeners.repo.ts` (Task 3); `request.sessionId` from the
  hook added in Task 2; `extractSessionId` from
  `backend/src/test-helpers/session.ts` (Task 2).
- Produces: the five owner routes now 404 for any session that isn't the
  listener's creator, using the exact same response as a nonexistent
  listener.

- [ ] **Step 1: Update the route implementation**

Replace the full contents of `backend/src/routes/listeners.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import {
  createListener,
  getListenerForOwner,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
} from '../listeners.repo'
import { getRequests } from '../requests.repo'

function shareUrlFor(baseUrl: string, shareToken: string | null): string | null {
  return shareToken ? `${baseUrl}/shared/${shareToken}` : null
}

export function registerListenerRoutes(app: FastifyInstance, db: Db, baseUrl: string): void {
  app.post('/api/listeners', async (request, reply) => {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const listener = createListener(db, id, createdAt, request.sessionId)
    reply.code(201)
    return {
      id: listener.id,
      createdAt: listener.createdAt,
      hookUrl: `${baseUrl}/hook/${listener.id}`,
      shareUrl: shareUrlFor(baseUrl, listener.shareToken),
    }
  })

  app.get<{ Params: { id: string } }>('/api/listeners/:id', async (request, reply) => {
    const listener = getListenerForOwner(db, request.params.id, request.sessionId)
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
    const listener = getListenerForOwner(db, request.params.id, request.sessionId)
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
    const listener = getListenerForOwner(db, request.params.id, request.sessionId)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    deleteListener(db, listener.id)
    reply.code(204)
    return null
  })

  app.post<{ Params: { id: string } }>('/api/listeners/:id/share', async (request, reply) => {
    const listener = getListenerForOwner(db, request.params.id, request.sessionId)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    const token = getOrCreateShareToken(db, listener.id)
    if (!token) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    return { shareToken: token, shareUrl: shareUrlFor(baseUrl, token) }
  })

  app.delete<{ Params: { id: string } }>('/api/listeners/:id/share', async (request, reply) => {
    const listener = getListenerForOwner(db, request.params.id, request.sessionId)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    revokeShareToken(db, listener.id)
    reply.code(204)
    return null
  })
}
```

- [ ] **Step 2: Update server.test.ts to carry the session cookie**

Replace the full contents of `backend/src/server.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from './db'
import { buildServer } from './server'
import { extractSessionId } from './test-helpers/session'

describe('listener routes', () => {
  let db: Db
  let app: FastifyInstance

  beforeEach(() => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
  })

  it('creates a listener', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/listeners' })
    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.id).toBeTypeOf('string')
    expect(body.hookUrl).toBe(`http://localhost:8080/hook/${body.id}`)
  })

  it('returns 404 for an unknown listener', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })
    expect(response.statusCode).toBe(404)
  })

  it('fetches an existing listener', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    const { id } = created.json()
    const sessionId = extractSessionId(created)

    const response = await app.inject({
      method: 'GET',
      url: `/api/listeners/${id}`,
      cookies: { session_id: sessionId },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().id).toBe(id)
  })

  it('deletes a listener', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    const { id } = created.json()
    const sessionId = extractSessionId(created)

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/listeners/${id}`,
      cookies: { session_id: sessionId },
    })
    expect(deleteResponse.statusCode).toBe(204)

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/listeners/${id}`,
      cookies: { session_id: sessionId },
    })
    expect(getResponse.statusCode).toBe(404)
  })

  it('returns 404 for requests of an unknown listener', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist/requests' })
    expect(response.statusCode).toBe(404)
  })
})
```

- [ ] **Step 3: Update listeners.share.test.ts to carry the session cookie**

Replace the full contents of `backend/src/routes/listeners.share.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'
import { extractSessionId } from '../test-helpers/session'

describe('listener share management', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string
  let sessionId: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id
    sessionId = extractSessionId(created)
  })

  it('has no share link by default', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: sessionId },
    })
    expect(response.json().shareUrl).toBeNull()
  })

  it('creates a share link', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.shareToken).toBeTypeOf('string')
    expect(body.shareUrl).toBe(`http://localhost:8080/shared/${body.shareToken}`)
  })

  it('is idempotent — repeat calls return the same token', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
    const second = await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
    expect(second.json().shareToken).toBe(first.json().shareToken)
  })

  it('reflects the created share link on the listener', async () => {
    const shareResponse = await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
    const listenerResponse = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: sessionId },
    })
    expect(listenerResponse.json().shareUrl).toBe(shareResponse.json().shareUrl)
  })

  it('revokes a share link', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
    const revokeResponse = await app.inject({
      method: 'DELETE',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
    expect(revokeResponse.statusCode).toBe(204)

    const listenerResponse = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: sessionId },
    })
    expect(listenerResponse.json().shareUrl).toBeNull()
  })

  it('generates a new token after revoke then re-share', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
    await app.inject({
      method: 'DELETE',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
    const second = await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
    expect(second.json().shareToken).not.toBe(first.json().shareToken)
  })

  it('returns 404 for an unknown listener on both endpoints', async () => {
    const shareResponse = await app.inject({
      method: 'POST',
      url: '/api/listeners/does-not-exist/share',
      cookies: { session_id: sessionId },
    })
    expect(shareResponse.statusCode).toBe(404)

    const revokeResponse = await app.inject({
      method: 'DELETE',
      url: '/api/listeners/does-not-exist/share',
      cookies: { session_id: sessionId },
    })
    expect(revokeResponse.statusCode).toBe(404)
  })
})
```

- [ ] **Step 4: Update hook.test.ts to carry the session cookie**

Replace the full contents of `backend/src/routes/hook.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'
import { extractSessionId } from '../test-helpers/session'

describe('hook capture route', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string
  let sessionId: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id
    sessionId = extractSessionId(created)
  })

  it('captures a POST payload and returns 200', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/hook/${listenerId}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ foo: 'bar' }),
    })

    expect(response.statusCode).toBe(200)

    const requests = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}/requests`,
      cookies: { session_id: sessionId },
    })
    const [captured] = requests.json()
    expect(captured.method).toBe('POST')
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.contentType).toBe('application/json')
  })

  it('captures query params and headers', async () => {
    await app.inject({
      method: 'GET',
      url: `/hook/${listenerId}?foo=bar`,
      headers: { 'x-custom-header': 'value' },
    })

    const requests = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}/requests`,
      cookies: { session_id: sessionId },
    })
    const [captured] = requests.json()
    expect(captured.queryParams).toEqual({ foo: 'bar' })
    expect(captured.headers['x-custom-header']).toBe('value')
  })

  it('returns 404 for an unknown listener', async () => {
    const response = await app.inject({ method: 'POST', url: '/hook/does-not-exist' })
    expect(response.statusCode).toBe(404)
  })
})
```

- [ ] **Step 5: Update shared.test.ts to carry the session cookie**

Replace the full contents of `backend/src/routes/shared.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'
import { extractSessionId } from '../test-helpers/session'

describe('shared read-only route', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string
  let sessionId: string
  let shareToken: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id
    sessionId = extractSessionId(created)

    const shareResponse = await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
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
    await app.inject({
      method: 'DELETE',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: sessionId },
    })
    const response = await app.inject({ method: 'GET', url: `/api/shared/${shareToken}/requests` })
    expect(response.statusCode).toBe(404)
  })

  it('exposes exactly the expected fields, nothing more', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/shared/${shareToken}/requests` })
    const [captured] = response.json()
    expect(Object.keys(captured).sort()).toEqual(
      ['body', 'contentType', 'headers', 'id', 'method', 'queryParams', 'receivedAt', 'sourceIp'].sort()
    )
  })
})
```

- [ ] **Step 6: Write the cross-session isolation tests**

Create `backend/src/routes/listeners.ownership.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'
import { extractSessionId } from '../test-helpers/session'

describe('listener ownership isolation', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string
  let ownerSessionId: string
  let otherSessionId: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })

    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id
    ownerSessionId = extractSessionId(created)

    const otherVisit = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist' })
    otherSessionId = extractSessionId(otherVisit)
  })

  it('is invisible to a different session on GET /api/listeners/:id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: otherSessionId },
    })
    expect(response.statusCode).toBe(404)
  })

  it('is invisible to a different session on GET /api/listeners/:id/requests', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}/requests`,
      cookies: { session_id: otherSessionId },
    })
    expect(response.statusCode).toBe(404)
  })

  it('cannot be deleted by a different session', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: otherSessionId },
    })
    expect(response.statusCode).toBe(404)

    const stillThere = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: ownerSessionId },
    })
    expect(stillThere.statusCode).toBe(200)
  })

  it('cannot have a share link created by a different session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: otherSessionId },
    })
    expect(response.statusCode).toBe(404)
  })

  it('cannot have its share link revoked by a different session', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: ownerSessionId },
    })
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/listeners/${listenerId}/share`,
      cookies: { session_id: otherSessionId },
    })
    expect(response.statusCode).toBe(404)
  })

  it('is invisible to a request with no session cookie at all', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/listeners/${listenerId}` })
    expect(response.statusCode).toBe(404)
  })

  it('remains visible to the owning session throughout', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/listeners/${listenerId}`,
      cookies: { session_id: ownerSessionId },
    })
    expect(response.statusCode).toBe(200)
  })

  it('the hook route remains reachable regardless of session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/hook/${listenerId}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ok: true }),
    })
    expect(response.statusCode).toBe(200)
  })
})
```

- [ ] **Step 7: Run the full backend suite**

Run (from `backend/`): `npm test`
Expected: ALL test files pass — this is the first point in the plan where
the full suite is expected to be green again after Task 3's intentional
breakage.

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/listeners.ts backend/src/server.test.ts backend/src/routes/listeners.share.test.ts backend/src/routes/hook.test.ts backend/src/routes/shared.test.ts backend/src/routes/listeners.ownership.test.ts
git commit -m "feat(backend): gate owner-only listener routes by session"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only).

**Interfaces:** none — this task exercises the full stack built by Tasks 1-4.

- [ ] **Step 1: Rebuild and bring up the stack**

Run: `docker compose up -d --build`
Expected: both containers report `Up` (`docker compose ps`).

- [ ] **Step 2: Create a listener as "browser A" (using a cookie jar)**

```bash
rm -f /tmp/webhook-cookiejar-a.txt
LISTENER=$(curl -s -c /tmp/webhook-cookiejar-a.txt -X POST http://localhost:8080/api/listeners)
echo "$LISTENER"
LISTENER_ID=$(echo "$LISTENER" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
```
Expected: `$LISTENER` contains `id`, `hookUrl`, `shareUrl: null`. The cookie
jar file now holds a `session_id` cookie.

- [ ] **Step 3: Confirm "browser A" (same cookie jar) can view the listener**

```bash
curl -s -b /tmp/webhook-cookiejar-a.txt -o /dev/null -w '%{http_code}\n' "http://localhost:8080/api/listeners/$LISTENER_ID"
```
Expected: `200`.

- [ ] **Step 4: Confirm a request with no cookie jar at all cannot view it**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:8080/api/listeners/$LISTENER_ID"
```
Expected: `404` — this is the exact scenario (a fresh incognito window /
different browser) that motivated this change; confirm it's now blocked.

- [ ] **Step 5: Create a share link as browser A, confirm the share route ignores sessions**

```bash
SHARE=$(curl -s -b /tmp/webhook-cookiejar-a.txt -X POST "http://localhost:8080/api/listeners/$LISTENER_ID/share")
echo "$SHARE"
SHARE_TOKEN=$(echo "$SHARE" | python3 -c "import sys,json; print(json.load(sys.stdin)['shareToken'])")
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:8080/api/shared/$SHARE_TOKEN/requests"
```
Expected: `SHARE` contains a valid `shareToken`/`shareUrl`; the final `curl`
(no cookie jar at all) prints `200` — confirming the shared route is
completely unaffected by session gating.

- [ ] **Step 6: Confirm browser A can still delete its own listener**

```bash
curl -s -b /tmp/webhook-cookiejar-a.txt -o /dev/null -w '%{http_code}\n' -X DELETE "http://localhost:8080/api/listeners/$LISTENER_ID"
curl -s -b /tmp/webhook-cookiejar-a.txt -o /dev/null -w '%{http_code}\n' "http://localhost:8080/api/listeners/$LISTENER_ID"
rm -f /tmp/webhook-cookiejar-a.txt
```
Expected: first prints `204`, second prints `404` (now genuinely deleted).

No commit needed for this task — it's verification only. If any step
fails, fix the underlying task's code, re-run that task's automated tests,
then re-run this task's steps from Step 1.
