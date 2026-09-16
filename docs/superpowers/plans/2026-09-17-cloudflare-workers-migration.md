# Cloudflare Workers Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Docker Compose (Fastify + better-sqlite3 + Nginx) stack with two Cloudflare Workers — a static-asset frontend Worker and a Hono + D1 API Worker — deployed to `webhook.fde.nice-agentic.com` and `webhook-api.fde.nice-agentic.com`, with Docker support removed entirely.

**Architecture:** Two independent Workers sharing one D1 database. The API Worker (`webhook-api`) carries every current Fastify route, ported to Hono, with `listeners.repo.ts`/`requests.repo.ts` converted from synchronous `better-sqlite3` calls to async D1 calls. The frontend Worker (`webhook`) serves the built Vite/React SPA via Workers' native static-assets binding, unchanged except for how it addresses the API (absolute URL + `credentials: 'include'` instead of same-origin relative paths). Local dev keeps `vite dev` for the frontend (fast HMR) and moves the backend to `wrangler dev` (Miniflare-backed, real D1 emulation).

**Tech Stack:** Hono (API routing), Cloudflare D1 (database), `@cloudflare/vitest-pool-workers` (backend test runner), Wrangler (deploy/dev tooling). Frontend stack (Vite/React/Tailwind) is unchanged.

**Spec:** `docs/superpowers/specs/2026-09-17-cloudflare-workers-migration-design.md`

## Global Constraints

- Zone: `nice-agentic.com`. Frontend Worker route: `webhook.fde.nice-agentic.com`. API Worker route: `webhook-api.fde.nice-agentic.com`.
- Session cookie: name `wl_session_id`, `httpOnly`, `sameSite: 'Lax'`, `domain: 'fde.nice-agentic.com'`, `path: '/'`, `maxAge` 60*60*24*365 seconds. UUID-shape validation on incoming cookie values via `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
- CORS on the API Worker's `/api/*` routes: allow-list exactly `env.APP_BASE_URL`, `credentials: true`. `/hook/:id` has no CORS (no browser involvement).
- `/hook/:id` capture cap: reject bodies over 10MB (`10 * 1024 * 1024` bytes) with 413.
- Two base URLs, not one: `HOOK_BASE_URL` (`https://webhook-api.fde.nice-agentic.com`, used to build `hookUrl`) and `APP_BASE_URL` (`https://webhook.fde.nice-agentic.com`, used to build `shareUrl` — the share page is a frontend React route, not an API route). **This splits the old single `baseUrl` concept from the Fastify version — a real requirement surfaced during planning, not present in the single-origin Docker setup.**
- D1 access is always async (`await db.prepare(sql).bind(...).run()/.first()/.all()`). Use positional `?` binds only — D1 does not support SQLite's `@name` named-parameter binding that `better-sqlite3` used.
- No `node:crypto` — use the Workers-native global `crypto.randomUUID()`.
- Request retention cap stays 200 rows per listener, enforced via `D1Database.batch([insertStmt, pruneStmt])` (D1's atomic multi-statement primitive, replacing `better-sqlite3`'s `db.transaction()` closure).
- Existing 66 backend tests must all be ported with identical assertions — this migration changes the runtime, not the behavior.

---

### Task 1: Backend scaffolding — remove Docker, add Workers tooling, D1 migrations

**Files:**
- Delete: `docker-compose.yml`, `backend/Dockerfile`, `backend/.dockerignore`, `frontend/Dockerfile`, `frontend/.dockerignore`, `frontend/nginx.conf`
- Delete: `backend/src/db.ts`, `backend/src/db.test.ts`
- Create: `backend/migrations/0001_init.sql`, `backend/migrations/0002_share_token.sql`, `backend/migrations/0003_owner_session.sql`
- Create: `backend/src/env.ts`
- Modify: `backend/package.json`, `backend/tsconfig.json`, `backend/vitest.config.ts`
- Create: `backend/test/apply-migrations.ts`
- Create: `backend/wrangler.toml`, `backend/.dev.vars` (gitignored)
- Modify: root `.gitignore` (add `.wrangler/`, `.dev.vars`, `*.dev.vars`)

**Interfaces:**
- Produces: `Env` type (`{ DB: D1Database; HOOK_BASE_URL: string; APP_BASE_URL: string }`) from `backend/src/env.ts`, imported by every later backend task.
- Produces: a working `npm test` in `backend/` using `@cloudflare/vitest-pool-workers`, with migrations pre-applied to an isolated D1 instance before each test.

- [ ] **Step 1: Delete Docker/Nginx artifacts and the old sqlite bootstrap**

```bash
cd /path/to/repo
git rm docker-compose.yml backend/Dockerfile backend/.dockerignore frontend/Dockerfile frontend/.dockerignore frontend/nginx.conf backend/src/db.ts backend/src/db.test.ts
```

- [ ] **Step 2: Write the D1 migration files**

`backend/migrations/0001_init.sql`:
```sql
CREATE TABLE listeners (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE requests (
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

CREATE INDEX idx_requests_listener_received
  ON requests(listener_id, received_at DESC);
```

`backend/migrations/0002_share_token.sql`:
```sql
ALTER TABLE listeners ADD COLUMN share_token TEXT;

CREATE UNIQUE INDEX idx_share_token
  ON listeners(share_token)
  WHERE share_token IS NOT NULL;
```

`backend/migrations/0003_owner_session.sql`:
```sql
ALTER TABLE listeners ADD COLUMN owner_session TEXT;
```

- [ ] **Step 3: Create the `Env` type**

`backend/src/env.ts`:
```ts
export interface Env {
  DB: D1Database
  HOOK_BASE_URL: string
  APP_BASE_URL: string
}
```

- [ ] **Step 4: Rewrite `backend/package.json`**

```json
{
  "name": "webhook-listener-backend",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "dev": "wrangler dev",
    "test": "vitest run",
    "deploy": "wrangler deploy",
    "db:migrate:local": "wrangler d1 migrations apply webhook-listener --local",
    "db:migrate:remote": "wrangler d1 migrations apply webhook-listener --remote"
  },
  "dependencies": {
    "hono": "^4.6.9"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.6.4",
    "@cloudflare/workers-types": "^4.20240925.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1",
    "wrangler": "^4.0.0"
  }
}
```

Run `npm install` inside `backend/`. If npm reports a version-resolution conflict on any of these (Cloudflare's packages move fast), bump the offending package to whatever `npm info <pkg> version` reports as current and re-run — this is routine dependency maintenance, not a design change.

- [ ] **Step 5: Rewrite `backend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src", "migrations", "test"]
}
```

- [ ] **Step 6: Create `backend/wrangler.toml`**

```toml
name = "webhook-api"
main = "src/index.ts"
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"
database_name = "webhook-listener"
database_id = "REPLACE_WITH_D1_DATABASE_ID"

[vars]
HOOK_BASE_URL = "https://webhook-api.fde.nice-agentic.com"
APP_BASE_URL = "https://webhook.fde.nice-agentic.com"
```

`database_id` is a placeholder — Task 9 creates the real D1 database and fills this in before deploying. Tests and `wrangler dev` do not need a real id (Miniflare provisions a local one automatically).

- [ ] **Step 7: Create `backend/.dev.vars` (local-only overrides, gitignored)**

```
HOOK_BASE_URL="http://localhost:8787"
APP_BASE_URL="http://localhost:5173"
```

- [ ] **Step 8: Add `.wrangler/` and dev-vars files to `.gitignore`**

Append to the repo root `.gitignore` (create the file if it doesn't exist):
```
.wrangler/
.dev.vars
*.dev.vars
```

- [ ] **Step 9: Rewrite `backend/vitest.config.ts`**

```ts
import path from 'node:path'
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations')
  const migrations = await readD1Migrations(migrationsPath)
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  }
})
```

- [ ] **Step 10: Create `backend/test/apply-migrations.ts`**

```ts
import { applyD1Migrations, env } from 'cloudflare:test'

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
```

- [ ] **Step 11: Verify the test harness boots (no tests exist yet, so this just proves the pool/D1/migration wiring works)**

Run: `cd backend && npm test`
Expected: vitest reports "No test files found" (or passes with 0 tests) rather than erroring on migration application or pool setup. If it errors, fix the `vitest.config.ts` / `wrangler.toml` wiring before moving on — every later task depends on this working.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: remove Docker/Nginx, scaffold Cloudflare Workers tooling and D1 migrations"
```

---

### Task 2: `listeners.repo.ts` — D1 conversion

**Files:**
- Modify: `backend/src/listeners.repo.ts`
- Modify: `backend/src/listeners.repo.test.ts`

**Interfaces:**
- Consumes: `Env` from `backend/src/env.ts` (Task 1).
- Produces: `ListenerRecord`, and async `createListener`, `getListener`, `getListenerForOwner`, `getListenersForOwner`, `deleteListener`, `getOrCreateShareToken`, `revokeShareToken`, `getListenerByShareToken` — all taking `db: Env['DB']` as first argument and returning `Promise<...>`. These exact names/signatures are relied on by Tasks 5, 6, 7.

- [ ] **Step 1: Rewrite the test file for D1 and async**

`backend/src/listeners.repo.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import {
  createListener,
  getListener,
  getListenerForOwner,
  getListenersForOwner,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
  getListenerByShareToken,
} from './listeners.repo'

describe('listeners repo', () => {
  it('creates and fetches a listener', async () => {
    await createListener(env.DB, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    const found = await getListener(env.DB, 'listener-1')
    expect(found).toEqual({
      id: 'listener-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      shareToken: null,
      ownerSession: 'session-a',
    })
  })

  it('returns undefined for an unknown listener', async () => {
    expect(await getListener(env.DB, 'does-not-exist')).toBeUndefined()
  })

  it('deletes a listener and reports success', async () => {
    await createListener(env.DB, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    expect(await deleteListener(env.DB, 'listener-1')).toBe(true)
    expect(await getListener(env.DB, 'listener-1')).toBeUndefined()
  })

  it('reports failure when deleting an unknown listener', async () => {
    expect(await deleteListener(env.DB, 'does-not-exist')).toBe(false)
  })
})

describe('getListenerForOwner', () => {
  it('returns the listener when the session matches its owner', async () => {
    await createListener(env.DB, 'listener-2', '2024-01-01T00:00:00.000Z', 'session-a')
    const found = await getListenerForOwner(env.DB, 'listener-2', 'session-a')
    expect(found?.id).toBe('listener-2')
  })

  it('returns undefined when the session does not match', async () => {
    await createListener(env.DB, 'listener-3', '2024-01-01T00:00:00.000Z', 'session-a')
    expect(await getListenerForOwner(env.DB, 'listener-3', 'session-b')).toBeUndefined()
  })

  it('returns undefined for an unknown listener id', async () => {
    expect(await getListenerForOwner(env.DB, 'does-not-exist', 'session-a')).toBeUndefined()
  })

  it('returns undefined for a listener with no owner_session recorded (legacy row)', async () => {
    await env.DB.prepare("INSERT INTO listeners (id, created_at) VALUES ('legacy-listener', '2024-01-01T00:00:00.000Z')").run()
    expect(await getListenerForOwner(env.DB, 'legacy-listener', 'session-a')).toBeUndefined()
  })
})

describe('share tokens', () => {
  it('creates a share token on first call and reuses it on subsequent calls', async () => {
    await createListener(env.DB, 'listener-4', '2024-01-01T00:00:00.000Z', 'session-a')
    const first = await getOrCreateShareToken(env.DB, 'listener-4')
    const second = await getOrCreateShareToken(env.DB, 'listener-4')
    expect(first).toBeTypeOf('string')
    expect(second).toBe(first)
  })

  it('returns undefined for an unknown listener', async () => {
    expect(await getOrCreateShareToken(env.DB, 'does-not-exist')).toBeUndefined()
  })

  it('looks up a listener by its share token', async () => {
    await createListener(env.DB, 'listener-5', '2024-01-01T00:00:00.000Z', 'session-a')
    const token = (await getOrCreateShareToken(env.DB, 'listener-5')) as string
    const found = await getListenerByShareToken(env.DB, token)
    expect(found?.id).toBe('listener-5')
  })

  it('returns undefined for an unknown share token', async () => {
    expect(await getListenerByShareToken(env.DB, 'does-not-exist')).toBeUndefined()
  })

  it('revokes a share token', async () => {
    await createListener(env.DB, 'listener-6', '2024-01-01T00:00:00.000Z', 'session-a')
    const token = (await getOrCreateShareToken(env.DB, 'listener-6')) as string
    expect(await revokeShareToken(env.DB, 'listener-6')).toBe(true)
    expect(await getListenerByShareToken(env.DB, token)).toBeUndefined()
  })

  it('reports failure when revoking an unknown listener', async () => {
    expect(await revokeShareToken(env.DB, 'does-not-exist')).toBe(false)
  })
})

describe('getListenersForOwner', () => {
  it("returns only the calling session's listeners, newest first", async () => {
    await createListener(env.DB, 'listener-7', '2024-01-01T00:00:00.000Z', 'session-x')
    await createListener(env.DB, 'listener-8', '2024-01-02T00:00:00.000Z', 'session-x')
    await createListener(env.DB, 'listener-9', '2024-01-03T00:00:00.000Z', 'session-y')

    const result = await getListenersForOwner(env.DB, 'session-x', 100)
    expect(result.map((l) => l.id)).toEqual(['listener-8', 'listener-7'])
  })

  it('returns an empty array for a session with no listeners', async () => {
    expect(await getListenersForOwner(env.DB, 'session-with-nothing', 100)).toEqual([])
  })

  it('respects the limit', async () => {
    await createListener(env.DB, 'listener-10', '2024-01-01T00:00:00.000Z', 'session-z')
    await createListener(env.DB, 'listener-11', '2024-01-02T00:00:00.000Z', 'session-z')
    await createListener(env.DB, 'listener-12', '2024-01-03T00:00:00.000Z', 'session-z')

    const result = await getListenersForOwner(env.DB, 'session-z', 2)
    expect(result).toHaveLength(2)
    expect(result.map((l) => l.id)).toEqual(['listener-12', 'listener-11'])
  })
})
```

(Row ids are unique per test — `isolatedStorage` in `vitest-pool-workers` gives each `it` a fresh copy of storage, but unique ids keep the tests self-explanatory and safe if isolation is ever loosened.)

- [ ] **Step 2: Run the tests to confirm they fail (repo file still uses `better-sqlite3`)**

Run: `cd backend && npm test -- listeners.repo`
Expected: FAIL — `listeners.repo.ts` still imports from `./db`, which no longer exists.

- [ ] **Step 3: Rewrite `backend/src/listeners.repo.ts`**

```ts
import type { Env } from './env'

export interface ListenerRecord {
  id: string
  createdAt: string
  shareToken: string | null
  ownerSession: string | null
}

const SELECT_COLUMNS = 'id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession'

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
  return { id, createdAt, shareToken: null, ownerSession }
}

export async function getListener(db: Env['DB'], id: string): Promise<ListenerRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE id = ?`)
    .bind(id)
    .first<ListenerRecord>()
  return row ?? undefined
}

export async function getListenerForOwner(
  db: Env['DB'],
  id: string,
  sessionId: string
): Promise<ListenerRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE id = ? AND owner_session = ?`)
    .bind(id, sessionId)
    .first<ListenerRecord>()
  return row ?? undefined
}

export async function getListenersForOwner(
  db: Env['DB'],
  sessionId: string,
  limit: number
): Promise<ListenerRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM listeners WHERE owner_session = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(sessionId, limit)
    .all<ListenerRecord>()
  return results
}

export async function deleteListener(db: Env['DB'], id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM listeners WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

// Read-then-write, now across two awaited D1 calls instead of one synchronous
// better-sqlite3 call — two concurrent callers could both read "no token" and
// both write, with the last write winning. Accepted at this app's personal
// scale, same trade-off the original synchronous-only comment flagged, now
// under D1's async model instead of better-sqlite3's single-threaded one.
export async function getOrCreateShareToken(db: Env['DB'], id: string): Promise<string | undefined> {
  const listener = await getListener(db, id)
  if (!listener) return undefined
  if (listener.shareToken) return listener.shareToken

  const token = crypto.randomUUID()
  await db.prepare('UPDATE listeners SET share_token = ? WHERE id = ?').bind(token, id).run()
  return token
}

export async function revokeShareToken(db: Env['DB'], id: string): Promise<boolean> {
  const result = await db.prepare('UPDATE listeners SET share_token = NULL WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

export async function getListenerByShareToken(db: Env['DB'], token: string): Promise<ListenerRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE share_token = ?`)
    .bind(token)
    .first<ListenerRecord>()
  return row ?? undefined
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd backend && npm test -- listeners.repo`
Expected: PASS, all 15 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/listeners.repo.ts backend/src/listeners.repo.test.ts
git commit -m "refactor(backend): convert listeners.repo to async D1 calls"
```

---

### Task 3: `requests.repo.ts` — D1 conversion with `batch()`

**Files:**
- Modify: `backend/src/requests.repo.ts`
- Modify: `backend/src/requests.repo.test.ts`

**Interfaces:**
- Consumes: `Env` (Task 1), `createListener` (Task 2).
- Produces: `RequestRecord`, `NewRequest`, async `insertRequest(db, req): Promise<void>`, async `getRequests(db, listenerId): Promise<RequestRecord[]>` — relied on by Tasks 5, 6, 7.

- [ ] **Step 1: Rewrite the test file for D1 and async**

`backend/src/requests.repo.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createListener } from './listeners.repo'
import { insertRequest, getRequests } from './requests.repo'

describe('requests repo', () => {
  const listenerId = 'listener-1'

  it('stores and retrieves requests newest first', async () => {
    await createListener(env.DB, listenerId, '2024-01-01T00:00:00.000Z', 'session-a')
    await insertRequest(env.DB, {
      listenerId,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'first',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:01.000Z',
    })
    await insertRequest(env.DB, {
      listenerId,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'second',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:02.000Z',
    })

    const requests = await getRequests(env.DB, listenerId)
    expect(requests.map((r) => r.body)).toEqual(['second', 'first'])
  })

  it('prunes older requests beyond the 200-row retention cap', async () => {
    const pruneListenerId = 'listener-prune'
    await createListener(env.DB, pruneListenerId, '2024-01-01T00:00:00.000Z', 'session-a')

    for (let i = 0; i < 205; i++) {
      await insertRequest(env.DB, {
        listenerId: pruneListenerId,
        method: 'POST',
        headers: '{}',
        queryParams: '{}',
        body: `request-${i}`,
        contentType: 'text/plain',
        sourceIp: '127.0.0.1',
        receivedAt: `2024-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(
          i % 60
        ).padStart(2, '0')}.000Z`,
      })
    }

    const requests = await getRequests(env.DB, pruneListenerId)
    expect(requests).toHaveLength(200)
    expect(requests[0].body).toBe('request-204')
    expect(requests[requests.length - 1].body).toBe('request-5')
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd backend && npm test -- requests.repo`
Expected: FAIL — `requests.repo.ts` still imports `./db`.

- [ ] **Step 3: Rewrite `backend/src/requests.repo.ts`**

```ts
import type { Env } from './env'

export interface RequestRecord {
  id: number
  listenerId: string
  method: string
  headers: string
  queryParams: string
  body: string | null
  contentType: string | null
  sourceIp: string | null
  receivedAt: string
}

export type NewRequest = Omit<RequestRecord, 'id'>

const RETENTION_LIMIT = 200

export async function insertRequest(db: Env['DB'], req: NewRequest): Promise<void> {
  const insert = db
    .prepare(
      `INSERT INTO requests
        (listener_id, method, headers, query_params, body, content_type, source_ip, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      req.listenerId,
      req.method,
      req.headers,
      req.queryParams,
      req.body,
      req.contentType,
      req.sourceIp,
      req.receivedAt
    )

  const prune = db
    .prepare(
      `DELETE FROM requests
       WHERE listener_id = ?
         AND id NOT IN (
           SELECT id FROM requests
           WHERE listener_id = ?
           ORDER BY received_at DESC, id DESC
           LIMIT ?
         )`
    )
    .bind(req.listenerId, req.listenerId, RETENTION_LIMIT)

  // D1's batch() runs both statements as one atomic unit — the replacement
  // for better-sqlite3's synchronous db.transaction() closure.
  await db.batch([insert, prune])
}

export async function getRequests(db: Env['DB'], listenerId: string): Promise<RequestRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT
        id,
        listener_id AS listenerId,
        method,
        headers,
        query_params AS queryParams,
        body,
        content_type AS contentType,
        source_ip AS sourceIp,
        received_at AS receivedAt
      FROM requests
      WHERE listener_id = ?
      ORDER BY received_at DESC, id DESC
      LIMIT ?`
    )
    .bind(listenerId, RETENTION_LIMIT)
    .all<RequestRecord>()
  return results
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd backend && npm test -- requests.repo`
Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/requests.repo.ts backend/src/requests.repo.test.ts
git commit -m "refactor(backend): convert requests.repo to async D1 calls with batch() pruning"
```

---

### Task 4: Hono app skeleton — session middleware, CORS, entrypoint

**Files:**
- Create: `backend/src/app.ts`
- Rewrite: `backend/src/index.ts`
- Delete: `backend/src/server.ts`
- Modify: `backend/src/test-helpers/session.ts`
- Rewrite: `backend/src/server.test.ts` → move to `backend/src/app.test.ts`
- Rewrite: `backend/src/server.session.test.ts` → move to `backend/src/app.session.test.ts`

**Interfaces:**
- Consumes: `Env` (Task 1).
- Produces: `app` (a `Hono<{ Bindings: Env; Variables: { sessionId: string } }>` instance) exported from `backend/src/app.ts`, imported by Tasks 5, 6, 7 to attach routes via `app.route('/', someRoute)`, and by every route test via `app.request(path, init, env)`.
- Produces: `cookieHeader(cookies?: Record<string,string>): Record<string,string>` and `extractSessionId(response: Response): string` from `backend/src/test-helpers/session.ts`, used by every route test in Tasks 5–7.

Note: at the end of this task `app.ts` has no routes yet except the session/CORS middleware — that's expected, routes attach in later tasks. The two test files here only exercise the session-cookie middleware itself (they don't need real routes, any 404 response still carries the cookie since middleware runs before routing).

- [ ] **Step 1: Rewrite the test helper**

`backend/src/test-helpers/session.ts`:
```ts
export function cookieHeader(cookies?: Record<string, string>): Record<string, string> {
  if (!cookies) return {}
  return {
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; '),
  }
}

export function extractSessionId(response: Response): string {
  const setCookies = response.headers.getSetCookie()
  const match = setCookies.find((c) => c.startsWith('wl_session_id='))
  if (!match) {
    throw new Error('no wl_session_id cookie found in response')
  }
  return match.split(';')[0].split('=')[1]
}
```

- [ ] **Step 2: Write the failing tests**

`backend/src/app.test.ts` (replaces `server.test.ts` — file has no routes to test at this point in the migration, so it's a placeholder describe block satisfied once `app.ts` exists; real route coverage returns in Tasks 5–7):
```ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from './app'

describe('app', () => {
  it('responds (even with a 404) to prove the Hono app boots', async () => {
    const response = await app.request('/does-not-exist', {}, env)
    expect(response.status).toBe(404)
  })
})
```

`backend/src/app.session.test.ts` (replaces `server.session.test.ts`):
```ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from './app'
import { cookieHeader, extractSessionId } from './test-helpers/session'

describe('session cookie', () => {
  it('sets a wl_session_id cookie when the request has none', async () => {
    const response = await app.request('/does-not-exist', {}, env)
    const setCookies = response.headers.getSetCookie()
    expect(setCookies.some((c) => c.startsWith('wl_session_id='))).toBe(true)
  })

  it('reuses an existing wl_session_id cookie instead of issuing a new one', async () => {
    const first = await app.request('/does-not-exist', {}, env)
    const sessionId = extractSessionId(first)

    const second = await app.request('/does-not-exist', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    const setCookies = second.headers.getSetCookie()
    expect(setCookies.some((c) => c.startsWith('wl_session_id='))).toBe(false)
  })

  it('issues different session ids to requests with no cookie', async () => {
    const first = await app.request('/does-not-exist', {}, env)
    const second = await app.request('/does-not-exist', {}, env)
    expect(extractSessionId(first)).not.toBe(extractSessionId(second))
  })

  it('replaces a malformed wl_session_id cookie value with a fresh one', async () => {
    const response = await app.request(
      '/does-not-exist',
      { headers: cookieHeader({ wl_session_id: 'not-a-uuid' }) },
      env
    )
    const sessionId = extractSessionId(response)
    expect(sessionId).not.toBe('not-a-uuid')
  })
})
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `cd backend && npm test -- app`
Expected: FAIL — `./app` does not exist yet.

- [ ] **Step 4: Delete the old Fastify server file**

```bash
git rm backend/src/server.ts backend/src/server.test.ts backend/src/server.session.test.ts
```

- [ ] **Step 5: Create `backend/src/app.ts`**

```ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie } from 'hono/cookie'
import type { Env } from './env'

export type Variables = { sessionId: string }

const SESSION_COOKIE_NAME = 'wl_session_id'
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365
const SESSION_COOKIE_DOMAIN = 'fde.nice-agentic.com'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.use(
  '/api/*',
  cors({
    origin: (_origin, c) => c.env.APP_BASE_URL,
    credentials: true,
  })
)

app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/hook/')) {
    await next()
    return
  }

  const existing = getCookie(c, SESSION_COOKIE_NAME)
  if (existing && UUID_PATTERN.test(existing)) {
    c.set('sessionId', existing)
    await next()
    return
  }

  const sessionId = crypto.randomUUID()
  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    domain: SESSION_COOKIE_DOMAIN,
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  })
  c.set('sessionId', sessionId)
  await next()
})
```

- [ ] **Step 6: Rewrite `backend/src/index.ts`**

```ts
import { app } from './app'

export default app
```

- [ ] **Step 7: Run the tests to confirm they pass**

Run: `cd backend && npm test -- app`
Expected: PASS, all 5 tests green (1 in `app.test.ts`, 4 in `app.session.test.ts`).

- [ ] **Step 8: Commit**

```bash
git add backend/src/app.ts backend/src/index.ts backend/src/app.test.ts backend/src/app.session.test.ts backend/src/test-helpers/session.ts
git rm backend/src/server.ts backend/src/server.test.ts backend/src/server.session.test.ts
git commit -m "refactor(backend): replace Fastify server with Hono app + session/CORS middleware"
```

---

### Task 5: `/hook/:id` route

**Files:**
- Create: `backend/src/routes/hook.ts` (replaces the Fastify version)
- Rewrite: `backend/src/routes/hook.test.ts`
- Modify: `backend/src/app.ts` (mount the route)

**Interfaces:**
- Consumes: `Env` (Task 1), `getListener` (Task 2), `insertRequest` (Task 3), `app` (Task 4).
- Produces: `hookRoute` (a `Hono<{ Bindings: Env }>` instance), mounted at `app.route('/', hookRoute)`.

This task also needs a listener to exist to hit `/hook/:id` against — since `/api/listeners` (Task 6) doesn't exist yet, the test creates listeners directly via the repo function against `env.DB`, not via an API call.

- [ ] **Step 1: Write the failing test**

`backend/src/routes/hook.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { createListener } from '../listeners.repo'
import { getRequests } from '../requests.repo'

describe('hook capture route', () => {
  const listenerId = 'hook-test-listener'

  beforeEach(async () => {
    await createListener(env.DB, listenerId, '2024-01-01T00:00:00.000Z', 'session-a')
  })

  it('captures a POST payload and returns 200', async () => {
    const response = await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      },
      env
    )
    expect(response.status).toBe(200)

    const [captured] = await getRequests(env.DB, listenerId)
    expect(captured.method).toBe('POST')
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.contentType).toBe('application/json')
  })

  it('captures query params and headers', async () => {
    await app.request(
      `/hook/${listenerId}?foo=bar`,
      { method: 'GET', headers: { 'x-custom-header': 'value' } },
      env
    )

    const [captured] = await getRequests(env.DB, listenerId)
    expect(JSON.parse(captured.queryParams)).toEqual({ foo: 'bar' })
    expect(JSON.parse(captured.headers)['x-custom-header']).toBe('value')
  })

  it('returns 404 for an unknown listener', async () => {
    const response = await app.request('/hook/does-not-exist', { method: 'POST' }, env)
    expect(response.status).toBe(404)
  })

  it('redacts the cookie header from captured requests', async () => {
    await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'session_id=some-secret-value' },
        body: JSON.stringify({ foo: 'bar' }),
      },
      env
    )

    const [captured] = await getRequests(env.DB, listenerId)
    const headers = JSON.parse(captured.headers)
    expect(headers.cookie).toBeUndefined()
    expect(captured.headers).not.toContain('some-secret-value')
  })

  it('rejects a payload over the 10MB cap with 413', async () => {
    const response = await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(11 * 1024 * 1024) },
      },
      env
    )
    expect(response.status).toBe(413)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd backend && npm test -- routes/hook`
Expected: FAIL — `../routes/hook` does not exist.

- [ ] **Step 3: Write `backend/src/routes/hook.ts`**

```ts
import { Hono } from 'hono'
import type { Env } from '../env'
import { getListener } from '../listeners.repo'
import { insertRequest } from '../requests.repo'

const REDACTED_HEADER_NAMES = new Set(['cookie', 'set-cookie'])
const MAX_BODY_BYTES = 10 * 1024 * 1024

function redactHeaders(headers: Headers): Record<string, string> {
  const redacted: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (REDACTED_HEADER_NAMES.has(key.toLowerCase())) return
    redacted[key] = value
  })
  return redacted
}

function parseQuery(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const key of url.searchParams.keys()) {
    if (key in query) continue
    const values = url.searchParams.getAll(key)
    query[key] = values.length > 1 ? values : values[0]
  }
  return query
}

export const hookRoute = new Hono<{ Bindings: Env }>()

hookRoute.all('/hook/:id', async (c) => {
  const listener = await getListener(c.env.DB, c.req.param('id'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }

  const contentLength = c.req.header('content-length')
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return c.json({ error: 'payload too large' }, 413)
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

  return c.body(null, 200)
})
```

- [ ] **Step 4: Mount the route in `backend/src/app.ts`**

Add near the top (after the `Env`/`Variables` setup) and after the middleware registrations, before the file's closing:
```ts
import { hookRoute } from './routes/hook'
```
And after the session middleware block:
```ts
app.route('/', hookRoute)
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd backend && npm test -- routes/hook`
Expected: PASS, all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/hook.ts backend/src/routes/hook.test.ts backend/src/app.ts
git commit -m "feat(backend): port /hook/:id capture route to Hono"
```

---

### Task 6: `/api/listeners*` routes (CRUD + share management)

**Files:**
- Create: `backend/src/routes/listeners.ts` (replaces the Fastify version)
- Rewrite: `backend/src/routes/listeners.ownership.test.ts`
- Rewrite: `backend/src/routes/listeners.share.test.ts`
- Rewrite: `backend/src/routes/listeners.list.test.ts`
- Delete: old `backend/src/routes/listeners.ts` Fastify version (overwritten in place)
- Modify: `backend/src/app.ts` (mount the route)

**Interfaces:**
- Consumes: `Env` (Task 1), all of `listeners.repo.ts` (Task 2), `getRequests` (Task 3), `Variables` (Task 4, for `c.get('sessionId')`).
- Produces: `listenerRoutes` (a `Hono<{ Bindings: Env; Variables: Variables }>` instance), mounted at `app.route('/', listenerRoutes)`.
- Uses `c.env.HOOK_BASE_URL` for `hookUrl` and `c.env.APP_BASE_URL` for `shareUrl` — see Global Constraints on the two-base-URL split.

- [ ] **Step 1: Write the failing tests**

`backend/src/routes/listeners.list.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('GET /api/listeners', () => {
  it('returns an empty array for a session with no listeners', async () => {
    const response = await app.request('/api/listeners', {}, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it("returns only the calling session's own listeners, newest first", async () => {
    const first = await app.request('/api/listeners', { method: 'POST' }, env)
    const sessionId = extractSessionId(first)
    const firstBody = (await first.json()) as { id: string }

    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await app.request(
      '/api/listeners',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const secondBody = (await second.json()) as { id: string }

    const otherCreate = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(otherCreate)
    const otherBody = (await otherCreate.json()) as { id: string }

    const response = await app.request('/api/listeners', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { id: string }[]
    expect(body.map((l) => l.id)).toEqual([secondBody.id, firstBody.id])

    const otherResponse = await app.request(
      '/api/listeners',
      { headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    const otherListed = (await otherResponse.json()) as { id: string }[]
    expect(otherListed.map((l) => l.id)).toEqual([otherBody.id])
  })

  it('includes hookUrl and shareUrl on each item, matching the single-listener shape', async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const sessionId = extractSessionId(created)
    const createdBody = (await created.json()) as { hookUrl: string }

    const response = await app.request('/api/listeners', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    const [listed] = (await response.json()) as { hookUrl: string; shareUrl: string | null }[]
    expect(listed.hookUrl).toBe(createdBody.hookUrl)
    expect(listed.shareUrl).toBeNull()
  })
})
```

`backend/src/routes/listeners.ownership.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('listener ownership isolation', () => {
  let listenerId: string
  let ownerSessionId: string
  let otherSessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
    ownerSessionId = extractSessionId(created)

    const otherVisit = await app.request('/api/listeners/does-not-exist', {}, env)
    otherSessionId = extractSessionId(otherVisit)
  })

  it('is invisible to a different session on GET /api/listeners/:id', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('is invisible to a different session on GET /api/listeners/:id/requests', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/requests`,
      { headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('cannot be deleted by a different session', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)

    const stillThere = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: ownerSessionId }) },
      env
    )
    expect(stillThere.status).toBe(200)
  })

  it('cannot have a share link created by a different session', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('cannot have its share link revoked by a different session', async () => {
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: ownerSessionId }) },
      env
    )
    const response = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('is invisible to a request with no session cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}`, {}, env)
    expect(response.status).toBe(404)
  })

  it('cannot be deleted by a request with no session cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}`, { method: 'DELETE' }, env)
    expect(response.status).toBe(404)
  })

  it('cannot have a share link created by a request with no session cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}/share`, { method: 'POST' }, env)
    expect(response.status).toBe(404)
  })

  it('cannot have its share link revoked by a request with no session cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}/share`, { method: 'DELETE' }, env)
    expect(response.status).toBe(404)
  })

  it('returns the exact same 404 body as a nonexistent listener', async () => {
    const wrongSessionResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    const nonexistentResponse = await app.request(
      '/api/listeners/does-not-exist',
      { headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(await wrongSessionResponse.json()).toEqual(await nonexistentResponse.json())
    expect(wrongSessionResponse.status).toBe(nonexistentResponse.status)
  })

  it('a legacy listener with no owner_session is inaccessible via the route layer', async () => {
    await env.DB.prepare("INSERT INTO listeners (id, created_at) VALUES ('legacy-listener', '2024-01-01T00:00:00.000Z')").run()

    const response = await app.request(
      '/api/listeners/legacy-listener',
      { headers: cookieHeader({ wl_session_id: ownerSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('remains visible to the owning session throughout', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: ownerSessionId }) },
      env
    )
    expect(response.status).toBe(200)
  })

  it('the hook route remains reachable regardless of session', async () => {
    const response = await app.request(
      `/hook/${listenerId}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) },
      env
    )
    expect(response.status).toBe(200)
  })
})
```

`backend/src/routes/listeners.share.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('listener share management', () => {
  let listenerId: string
  let sessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
    sessionId = extractSessionId(created)
  })

  it('has no share link by default', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await response.json() as { shareUrl: string | null }).shareUrl).toBeNull()
  })

  it('creates a share link', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { shareToken: string; shareUrl: string }
    expect(body.shareToken).toBeTypeOf('string')
    expect(body.shareUrl).toBe(`https://webhook.fde.nice-agentic.com/shared/${body.shareToken}`)
  })

  it('is idempotent — repeat calls return the same token', async () => {
    const first = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const second = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await second.json() as { shareToken: string }).shareToken).toBe(
      (await first.json() as { shareToken: string }).shareToken
    )
  })

  it('reflects the created share link on the listener', async () => {
    const shareResponse = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const listenerResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await listenerResponse.json() as { shareUrl: string }).shareUrl).toBe(
      (await shareResponse.json() as { shareUrl: string }).shareUrl
    )
  })

  it('revokes a share link', async () => {
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const revokeResponse = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(revokeResponse.status).toBe(204)

    const listenerResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await listenerResponse.json() as { shareUrl: string | null }).shareUrl).toBeNull()
  })

  it('generates a new token after revoke then re-share', async () => {
    const first = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const second = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await second.json() as { shareToken: string }).shareToken).not.toBe(
      (await first.json() as { shareToken: string }).shareToken
    )
  })

  it('returns 404 for an unknown listener on both endpoints', async () => {
    const shareResponse = await app.request(
      '/api/listeners/does-not-exist/share',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(shareResponse.status).toBe(404)

    const revokeResponse = await app.request(
      '/api/listeners/does-not-exist/share',
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(revokeResponse.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd backend && npm test -- routes/listeners`
Expected: FAIL — `listeners.ts` still exports the Fastify version.

- [ ] **Step 3: Overwrite `backend/src/routes/listeners.ts`**

```ts
import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import {
  createListener,
  getListenerForOwner,
  getListenersForOwner,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
} from '../listeners.repo'
import { getRequests } from '../requests.repo'

function shareUrlFor(appBaseUrl: string, shareToken: string | null): string | null {
  return shareToken ? `${appBaseUrl}/shared/${shareToken}` : null
}

const LIST_LIMIT = 100

export const listenerRoutes = new Hono<{ Bindings: Env; Variables: Variables }>()

listenerRoutes.get('/api/listeners', async (c) => {
  const listeners = await getListenersForOwner(c.env.DB, c.get('sessionId'), LIST_LIMIT)
  return c.json(
    listeners.map((listener) => ({
      id: listener.id,
      createdAt: listener.createdAt,
      hookUrl: `${c.env.HOOK_BASE_URL}/hook/${listener.id}`,
      shareUrl: shareUrlFor(c.env.APP_BASE_URL, listener.shareToken),
    }))
  )
})

listenerRoutes.post('/api/listeners', async (c) => {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const listener = await createListener(c.env.DB, id, createdAt, c.get('sessionId'))
  return c.json(
    {
      id: listener.id,
      createdAt: listener.createdAt,
      hookUrl: `${c.env.HOOK_BASE_URL}/hook/${listener.id}`,
      shareUrl: shareUrlFor(c.env.APP_BASE_URL, listener.shareToken),
    },
    201
  )
})

listenerRoutes.get('/api/listeners/:id', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  return c.json({
    id: listener.id,
    createdAt: listener.createdAt,
    hookUrl: `${c.env.HOOK_BASE_URL}/hook/${listener.id}`,
    shareUrl: shareUrlFor(c.env.APP_BASE_URL, listener.shareToken),
  })
})

listenerRoutes.get('/api/listeners/:id/requests', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  const requests = await getRequests(c.env.DB, listener.id)
  return c.json(
    requests.map((r) => ({
      ...r,
      headers: JSON.parse(r.headers),
      queryParams: JSON.parse(r.queryParams),
    }))
  )
})

listenerRoutes.delete('/api/listeners/:id', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  await deleteListener(c.env.DB, listener.id)
  return c.body(null, 204)
})

listenerRoutes.post('/api/listeners/:id/share', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  const token = (await getOrCreateShareToken(c.env.DB, listener.id)) as string
  return c.json({ shareToken: token, shareUrl: shareUrlFor(c.env.APP_BASE_URL, token) })
})

listenerRoutes.delete('/api/listeners/:id/share', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  await revokeShareToken(c.env.DB, listener.id)
  return c.body(null, 204)
})
```

- [ ] **Step 4: Mount the route in `backend/src/app.ts`**

Add the import:
```ts
import { listenerRoutes } from './routes/listeners'
```
And after `app.route('/', hookRoute)`:
```ts
app.route('/', listenerRoutes)
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `cd backend && npm test -- routes/listeners`
Expected: PASS, all tests green across the three files (3 list + 14 ownership + 7 share = 24 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/listeners.ts backend/src/routes/listeners.ownership.test.ts backend/src/routes/listeners.share.test.ts backend/src/routes/listeners.list.test.ts backend/src/app.ts
git commit -m "feat(backend): port /api/listeners CRUD + share routes to Hono"
```

---

### Task 7: `/api/shared/:token/requests` route

**Files:**
- Create: `backend/src/routes/shared.ts` (replaces the Fastify version)
- Rewrite: `backend/src/routes/shared.test.ts`
- Modify: `backend/src/app.ts` (mount the route)

**Interfaces:**
- Consumes: `Env` (Task 1), `getListenerByShareToken` (Task 2), `getRequests` (Task 3).
- Produces: `sharedRoutes` (a `Hono<{ Bindings: Env }>` instance), mounted at `app.route('/', sharedRoutes)`.

- [ ] **Step 1: Write the failing test**

`backend/src/routes/shared.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('shared read-only route', () => {
  let listenerId: string
  let sessionId: string
  let shareToken: string

  beforeEach(async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
    sessionId = extractSessionId(created)

    const shareResponse = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    shareToken = (await shareResponse.json() as { shareToken: string }).shareToken

    await app.request(
      `/hook/${listenerId}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ foo: 'bar' }) },
      env
    )
  })

  it('returns captured requests for a valid share token', async () => {
    const response = await app.request(`/api/shared/${shareToken}/requests`, {}, env)
    expect(response.status).toBe(200)
    const [captured] = (await response.json()) as { body: string; method: string }[]
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.method).toBe('POST')
  })

  it('never includes the real listener id anywhere in the response', async () => {
    const response = await app.request(`/api/shared/${shareToken}/requests`, {}, env)
    const text = await response.text()
    expect(text).not.toContain(listenerId)
  })

  it('never includes the owner session id anywhere in the response', async () => {
    await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `wl_session_id=${sessionId}` },
        body: JSON.stringify({ probe: true }),
      },
      env
    )
    const response = await app.request(`/api/shared/${shareToken}/requests`, {}, env)
    const text = await response.text()
    expect(text).not.toContain(sessionId)
  })

  it('is reachable by a session that is not the owner', async () => {
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: cookieHeader({ wl_session_id: 'some-other-session-uuid-0000-0000-000000000000' }) },
      env
    )
    expect(response.status).toBe(200)
  })

  it('returns 404 for an unknown share token', async () => {
    const response = await app.request('/api/shared/does-not-exist/requests', {}, env)
    expect(response.status).toBe(404)
  })

  it('returns 404 after the share token has been revoked', async () => {
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const response = await app.request(`/api/shared/${shareToken}/requests`, {}, env)
    expect(response.status).toBe(404)
  })

  it('exposes exactly the expected fields, nothing more', async () => {
    const response = await app.request(`/api/shared/${shareToken}/requests`, {}, env)
    const [captured] = (await response.json()) as Record<string, unknown>[]
    expect(Object.keys(captured).sort()).toEqual(
      ['body', 'contentType', 'headers', 'id', 'method', 'queryParams', 'receivedAt', 'sourceIp'].sort()
    )
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd backend && npm test -- routes/shared`
Expected: FAIL — `shared.ts` still exports the Fastify version.

- [ ] **Step 3: Overwrite `backend/src/routes/shared.ts`**

```ts
import { Hono } from 'hono'
import type { Env } from '../env'
import { getListenerByShareToken } from '../listeners.repo'
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
```

- [ ] **Step 4: Mount the route in `backend/src/app.ts`**

Add the import:
```ts
import { sharedRoutes } from './routes/shared'
```
And after `app.route('/', listenerRoutes)`:
```ts
app.route('/', sharedRoutes)
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd backend && npm test -- routes/shared`
Expected: PASS, all 7 tests green.

- [ ] **Step 6: Run the full backend test suite**

Run: `cd backend && npm test`
Expected: PASS, all tests green (66 original tests' worth of coverage, ported 1:1 across Tasks 2–7, plus the new `app.test.ts`/`app.session.test.ts` and the new 413 body-cap test — net more tests than the original 66, none fewer).

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/shared.ts backend/src/routes/shared.test.ts backend/src/app.ts
git commit -m "feat(backend): port /api/shared/:token/requests route to Hono"
```

---

### Task 8: Frontend — absolute API base URL, credentials, static-assets Worker config

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/vite-env.d.ts`
- Create: `frontend/.env.development`, `frontend/.env.production`
- Create: `frontend/wrangler.toml`
- Modify: `frontend/package.json` (add `wrangler` devDependency + `deploy` script)

**Interfaces:**
- Produces: every function in `frontend/src/api.ts` now calls `${API_BASE_URL}${path}` with `credentials: 'include'` instead of the current same-origin relative `fetch(path)`. Signatures and return types are unchanged — this is a pure networking-detail change, not an API surface change, so `Home.tsx`/`Listener.tsx`/`SharedListener.tsx` need no changes.

- [ ] **Step 1: Declare the new env var's type**

`frontend/src/vite-env.d.ts` — check current contents first; append if a `ImportMetaEnv` interface doesn't already exist:
```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

- [ ] **Step 2: Create the dev/prod env files**

`frontend/.env.development`:
```
VITE_API_BASE_URL=http://localhost:8787
```

`frontend/.env.production`:
```
VITE_API_BASE_URL=https://webhook-api.fde.nice-agentic.com
```

- [ ] **Step 3: Rewrite `frontend/src/api.ts`**

```ts
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

export interface Listener {
  id: string
  createdAt: string
  hookUrl: string
  shareUrl: string | null
}

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
  return fetch(`${API_BASE_URL}/api/listeners`, { method: 'POST', credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Listener>(r)
  )
}

export function getListener(id: string): Promise<Listener> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Listener>(r)
  )
}

export function listListeners(): Promise<Listener[]> {
  return fetch(`${API_BASE_URL}/api/listeners`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Listener[]>(r)
  )
}

export function getRequests(id: string): Promise<CapturedRequest[]> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/requests`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<CapturedRequest[]>(r)
  )
}

export async function deleteListener(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/listeners/${id}`, { method: 'DELETE', credentials: 'include' })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function getOrCreateShareLink(id: string): Promise<ShareLink> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/share`, { method: 'POST', credentials: 'include' }).then((r) =>
    parseJsonOrThrow<ShareLink>(r)
  )
}

export async function revokeShareLink(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/listeners/${id}/share`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function getSharedRequests(token: string): Promise<RequestDetail[]> {
  return fetch(`${API_BASE_URL}/api/shared/${token}/requests`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<RequestDetail[]>(r)
  )
}
```

- [ ] **Step 4: Create `frontend/wrangler.toml`** (used only for deploying the built static assets, not for local dev — local dev keeps using `vite dev`)

```toml
name = "webhook"
compatibility_date = "2024-09-23"

[assets]
directory = "./dist"
not_found_handling = "single-page-application"
```

- [ ] **Step 5: Add `wrangler` and a `deploy` script to `frontend/package.json`**

Modify the `scripts` and `devDependencies` blocks:
```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview",
  "deploy": "wrangler deploy"
},
```
```json
"devDependencies": {
  "@types/diff": "^7.0.2",
  "@types/react": "^18.3.5",
  "@types/react-dom": "^18.3.0",
  "@types/react-syntax-highlighter": "^15.5.13",
  "@vitejs/plugin-react": "^4.3.1",
  "autoprefixer": "^10.6.1",
  "postcss": "^8.5.28",
  "tailwindcss": "^3.4.19",
  "typescript": "^5.6.2",
  "vite": "^5.4.6",
  "wrangler": "^4.0.0"
}
```

Run `npm install` inside `frontend/`.

- [ ] **Step 6: Verify the frontend still builds clean**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors, `dist/` produced.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.ts frontend/src/vite-env.d.ts frontend/.env.development frontend/.env.production frontend/wrangler.toml frontend/package.json frontend/package-lock.json
git commit -m "feat(frontend): point api.ts at an absolute, credentialed API base URL; add Workers static-assets config"
```

---

### Task 9: Provision Cloudflare resources and deploy both Workers

**Files:**
- Modify: `backend/wrangler.toml` (fill in the real `database_id`)

This task is infrastructure, not code — no tests. It's the final step that makes the migration real: create the D1 database, apply migrations to it, and deploy both Workers to the confirmed routes.

- [ ] **Step 1: Create the D1 database**

Run: `cd backend && npx wrangler d1 create webhook-listener`
This prints a `database_id`. Copy it.

- [ ] **Step 2: Fill in the real `database_id` in `backend/wrangler.toml`**

Replace `"REPLACE_WITH_D1_DATABASE_ID"` with the id from Step 1.

- [ ] **Step 3: Apply migrations to the remote D1 database**

Run: `cd backend && npm run db:migrate:remote`
Expected: all three migrations (`0001_init`, `0002_share_token`, `0003_owner_session`) apply cleanly.

- [ ] **Step 4: Deploy the API Worker**

Run: `cd backend && npm run deploy`
Expected: Wrangler reports a successful deploy and a `*.workers.dev` URL. Then bind the custom route: run `npx wrangler deploy` again after adding a `routes` entry, or configure the custom domain via the Cloudflare dashboard for `webhook-api.fde.nice-agentic.com` pointing at the `webhook-api` Worker (Workers custom domains auto-provision the DNS record and TLS cert — this is the standard, lowest-friction way to attach a zone hostname to a Worker, simpler than a manual `routes` pattern + separate DNS record).

- [ ] **Step 5: Build and deploy the frontend Worker**

Run: `cd frontend && npm run build && npm run deploy`
Expected: Wrangler reports a successful deploy. Attach the custom domain `webhook.fde.nice-agentic.com` to the `webhook` Worker the same way as Step 4.

- [ ] **Step 6: Smoke test the deployed capture path**

```bash
curl -s -X POST https://webhook-api.fde.nice-agentic.com/hook/smoke-test-nonexistent-id
```
Expected: `404 {"error":"listener not found"}` — proves the API Worker is live and D1-backed (a nonexistent listener correctly 404s against the real remote database, not a stale local one).

- [ ] **Step 7: Smoke test the deployed frontend**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://webhook.fde.nice-agentic.com/
```
Expected: `200` — proves the static-assets Worker is serving the SPA shell.

- [ ] **Step 8: Commit the filled-in `database_id`**

```bash
git add backend/wrangler.toml
git commit -m "chore: wire the deployed D1 database id into wrangler.toml"
```

- [ ] **Step 9: Manual browser check (cannot be done from an agent session — flag to the user)**

Open `https://webhook.fde.nice-agentic.com` in a real browser: create a listener, confirm it appears on the home page, POST a test payload to its `hookUrl` and confirm it shows up in the UI, generate a share link and open it in an incognito window, confirm an incognito window cannot see the owner's listener list. This mirrors the outstanding manual check already flagged in `HANDOFF.md` for the pre-migration app and needs re-verification post-migration since cross-origin cookie/CORS behavior is genuinely new here, not just carried over.
