# Webhook Listener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dockerized webhook listener service — users create a UUID-scoped
listener via a web UI, send it arbitrary HTTP payloads which are captured and
persisted, and browse the received history in the UI.

**Architecture:** Two containers wired by `docker-compose.yml`. `backend` is a
Node/TypeScript/Fastify service that owns a SQLite database (`better-sqlite3`) and
exposes a REST API plus a catch-all `/hook/:id` capture route. `frontend` is a
React/Vite SPA built to static assets and served by Nginx, which also reverse-proxies
`/api/*` and `/hook/*` to `backend` so the browser only ever talks to one origin.

**Tech Stack:** Node.js 20, TypeScript, Fastify 5, better-sqlite3, Vitest, React 18,
Vite 5, react-router-dom, Nginx, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-16-webhook-listener-design.md`

## Global Constraints

- No authentication anywhere — the UUID in a listener's URL is the only access control.
- SQLite is the only datastore; no additional cache/DB service.
- Request history per listener is capped at the 200 most recent rows (oldest pruned
  automatically on insert).
- UI refresh is polling every 3 seconds — no SSE/WebSockets.
- Listeners never auto-expire; deletion is manual only, via `DELETE /api/listeners/:id`.
- Local `docker compose up` is the only deployment target for this iteration — no
  cloud-specific config.
- The backend's externally-reachable base URL (for building `hookUrl`) comes from a
  `BASE_URL` env var, not hardcoded host/port.

---

## File Structure

```
backend/
  package.json
  tsconfig.json
  vitest.config.ts
  Dockerfile
  src/
    db.ts                    # SQLite connection + schema
    db.test.ts
    listeners.repo.ts        # listener CRUD against SQLite
    listeners.repo.test.ts
    requests.repo.ts         # request capture + retention-capped reads
    requests.repo.test.ts
    server.ts                # Fastify app factory
    server.test.ts           # listener API route tests
    routes/
      listeners.ts           # /api/listeners* route handlers
      hook.ts                # /hook/:id capture route
      hook.test.ts
    index.ts                 # process entrypoint (env, listen)

frontend/
  package.json
  tsconfig.json
  tsconfig.node.json
  vite.config.ts
  index.html
  Dockerfile
  nginx.conf
  src/
    main.tsx
    App.tsx
    api.ts                   # typed fetch client for the backend API
    pages/
      Home.tsx
      Listener.tsx

docker-compose.yml
```

---

### Task 1: Backend scaffolding + SQLite schema

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/vitest.config.ts`
- Create: `backend/src/db.ts`
- Test: `backend/src/db.test.ts`

**Interfaces:**
- Produces: `export type Db = Database.Database` and `export function createDb(path: string): Db` from `backend/src/db.ts`. Every later backend task imports `Db` and `createDb` from this file.

- [ ] **Step 1: Create the backend project files**

`backend/package.json`:
```json
{
  "name": "webhook-listener-backend",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "build": "tsc -p .",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.5.5",
    "tsx": "^4.19.1",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

`backend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

`backend/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
  },
})
```

- [ ] **Step 2: Install dependencies**

Run (from `backend/`): `npm install`

Expected: `node_modules/` and `package-lock.json` are created with no errors.

- [ ] **Step 3: Write the failing test for the DB schema**

`backend/src/db.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createDb } from './db'

describe('createDb', () => {
  it('creates listeners and requests tables', () => {
    const db = createDb(':memory:')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual(['listeners', 'requests'])
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run (from `backend/`): `npx vitest run src/db.test.ts`
Expected: FAIL — `Cannot find module './db'` (file doesn't exist yet).

- [ ] **Step 5: Implement the DB module**

`backend/src/db.ts`:
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

export function createDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
```

- [ ] **Step 6: Run test to verify it passes**

Run (from `backend/`): `npx vitest run src/db.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/tsconfig.json backend/vitest.config.ts backend/src/db.ts backend/src/db.test.ts
git commit -m "feat(backend): scaffold project and SQLite schema"
```

---

### Task 2: Listener repository

**Files:**
- Create: `backend/src/listeners.repo.ts`
- Test: `backend/src/listeners.repo.test.ts`

**Interfaces:**
- Consumes: `Db`, `createDb` from `backend/src/db.ts` (Task 1).
- Produces: `ListenerRecord { id: string; createdAt: string }`, `createListener(db: Db, id: string, createdAt: string): ListenerRecord`, `getListener(db: Db, id: string): ListenerRecord | undefined`, `deleteListener(db: Db, id: string): boolean` from `backend/src/listeners.repo.ts`. Used by Task 3 (FK setup in tests) and Task 4 (routes).

- [ ] **Step 1: Write the failing tests**

`backend/src/listeners.repo.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from './db'
import { createListener, getListener, deleteListener } from './listeners.repo'

describe('listeners repo', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('creates and fetches a listener', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z')
    const found = getListener(db, 'listener-1')
    expect(found).toEqual({ id: 'listener-1', createdAt: '2024-01-01T00:00:00.000Z' })
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/listeners.repo.test.ts`
Expected: FAIL — `Cannot find module './listeners.repo'`.

- [ ] **Step 3: Implement the listener repository**

`backend/src/listeners.repo.ts`:
```ts
import type { Db } from './db'

export interface ListenerRecord {
  id: string
  createdAt: string
}

export function createListener(db: Db, id: string, createdAt: string): ListenerRecord {
  db.prepare('INSERT INTO listeners (id, created_at) VALUES (?, ?)').run(id, createdAt)
  return { id, createdAt }
}

export function getListener(db: Db, id: string): ListenerRecord | undefined {
  return db
    .prepare('SELECT id, created_at AS createdAt FROM listeners WHERE id = ?')
    .get(id) as ListenerRecord | undefined
}

export function deleteListener(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM listeners WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/listeners.repo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/listeners.repo.ts backend/src/listeners.repo.test.ts
git commit -m "feat(backend): add listener repository"
```

---

### Task 3: Request repository with retention cap

**Files:**
- Create: `backend/src/requests.repo.ts`
- Test: `backend/src/requests.repo.test.ts`

**Interfaces:**
- Consumes: `Db`, `createDb` from `backend/src/db.ts`; `createListener` from `backend/src/listeners.repo.ts` (test setup only, to satisfy the FK).
- Produces: `RequestRecord { id: number; listenerId: string; method: string; headers: string; queryParams: string; body: string | null; contentType: string | null; sourceIp: string | null; receivedAt: string }`, `NewRequest` (same shape minus `id`), `insertRequest(db: Db, req: NewRequest): void`, `getRequests(db: Db, listenerId: string): RequestRecord[]` from `backend/src/requests.repo.ts`. Used by Task 4 (routes) and Task 5 (hook capture).

- [ ] **Step 1: Write the failing tests**

`backend/src/requests.repo.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from './db'
import { createListener } from './listeners.repo'
import { insertRequest, getRequests } from './requests.repo'

describe('requests repo', () => {
  let db: Db
  const listenerId = 'listener-1'

  beforeEach(() => {
    db = createDb(':memory:')
    createListener(db, listenerId, '2024-01-01T00:00:00.000Z')
  })

  it('stores and retrieves requests newest first', () => {
    insertRequest(db, {
      listenerId,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'first',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:01.000Z',
    })
    insertRequest(db, {
      listenerId,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'second',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:02.000Z',
    })

    const requests = getRequests(db, listenerId)
    expect(requests.map((r) => r.body)).toEqual(['second', 'first'])
  })

  it('prunes older requests beyond the 200-row retention cap', () => {
    for (let i = 0; i < 205; i++) {
      insertRequest(db, {
        listenerId,
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

    const requests = getRequests(db, listenerId)
    expect(requests).toHaveLength(200)
    expect(requests[0].body).toBe('request-204')
    expect(requests[requests.length - 1].body).toBe('request-5')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/requests.repo.test.ts`
Expected: FAIL — `Cannot find module './requests.repo'`.

- [ ] **Step 3: Implement the request repository**

`backend/src/requests.repo.ts`:
```ts
import type { Db } from './db'

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

export function insertRequest(db: Db, req: NewRequest): void {
  const insert = db.prepare(`
    INSERT INTO requests
      (listener_id, method, headers, query_params, body, content_type, source_ip, received_at)
    VALUES (@listenerId, @method, @headers, @queryParams, @body, @contentType, @sourceIp, @receivedAt)
  `)
  const prune = db.prepare(`
    DELETE FROM requests
    WHERE listener_id = ?
      AND id NOT IN (
        SELECT id FROM requests
        WHERE listener_id = ?
        ORDER BY received_at DESC, id DESC
        LIMIT ?
      )
  `)
  const tx = db.transaction((r: NewRequest) => {
    insert.run(r)
    prune.run(r.listenerId, r.listenerId, RETENTION_LIMIT)
  })
  tx(req)
}

export function getRequests(db: Db, listenerId: string): RequestRecord[] {
  return db
    .prepare(
      `
      SELECT
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
      LIMIT ?
    `
    )
    .all(listenerId, RETENTION_LIMIT) as RequestRecord[]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/requests.repo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/requests.repo.ts backend/src/requests.repo.test.ts
git commit -m "feat(backend): add request repository with retention cap"
```

---

### Task 4: Fastify server + listener API routes

**Files:**
- Create: `backend/src/server.ts`
- Create: `backend/src/routes/listeners.ts`
- Test: `backend/src/server.test.ts`

**Interfaces:**
- Consumes: `Db` from `backend/src/db.ts`; `createListener`, `getListener`, `deleteListener` from `backend/src/listeners.repo.ts`; `getRequests` from `backend/src/requests.repo.ts`.
- Produces: `export interface ServerOptions { db: Db; baseUrl: string }` and `export function buildServer(options: ServerOptions): FastifyInstance` from `backend/src/server.ts`. Task 5 adds to this same file's route registration; Task 6 calls `buildServer` from the entrypoint.

- [ ] **Step 1: Write the failing tests**

`backend/src/server.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from './db'
import { buildServer } from './server'

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

    const response = await app.inject({ method: 'GET', url: `/api/listeners/${id}` })
    expect(response.statusCode).toBe(200)
    expect(response.json().id).toBe(id)
  })

  it('deletes a listener', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    const { id } = created.json()

    const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/listeners/${id}` })
    expect(deleteResponse.statusCode).toBe(204)

    const getResponse = await app.inject({ method: 'GET', url: `/api/listeners/${id}` })
    expect(getResponse.statusCode).toBe(404)
  })

  it('returns 404 for requests of an unknown listener', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/listeners/does-not-exist/requests' })
    expect(response.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/server.test.ts`
Expected: FAIL — `Cannot find module './server'`.

- [ ] **Step 3: Implement the routes and server factory**

`backend/src/routes/listeners.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import { createListener, getListener, deleteListener } from '../listeners.repo'
import { getRequests } from '../requests.repo'

export function registerListenerRoutes(app: FastifyInstance, db: Db, baseUrl: string): void {
  app.post('/api/listeners', async (_request, reply) => {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    createListener(db, id, createdAt)
    reply.code(201)
    return { id, createdAt, hookUrl: `${baseUrl}/hook/${id}` }
  })

  app.get<{ Params: { id: string } }>('/api/listeners/:id', async (request, reply) => {
    const listener = getListener(db, request.params.id)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }
    return { ...listener, hookUrl: `${baseUrl}/hook/${listener.id}` }
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
}
```

`backend/src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db'
import { registerListenerRoutes } from './routes/listeners'

export interface ServerOptions {
  db: Db
  baseUrl: string
}

export function buildServer({ db, baseUrl }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: true })

  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })

  registerListenerRoutes(app, db, baseUrl)

  return app
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts backend/src/routes/listeners.ts backend/src/server.test.ts
git commit -m "feat(backend): add Fastify server and listener API routes"
```

---

### Task 5: Hook capture route

**Files:**
- Create: `backend/src/routes/hook.ts`
- Modify: `backend/src/server.ts` (register the hook route)
- Test: `backend/src/routes/hook.test.ts`

**Interfaces:**
- Consumes: `Db` from `backend/src/db.ts`; `getListener` from `backend/src/listeners.repo.ts`; `insertRequest` from `backend/src/requests.repo.ts`; `buildServer` from `backend/src/server.ts`.
- Produces: `export function registerHookRoute(app: FastifyInstance, db: Db): void` from `backend/src/routes/hook.ts`, wired into `buildServer`.

- [ ] **Step 1: Write the failing tests**

`backend/src/routes/hook.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'

describe('hook capture route', () => {
  let db: Db
  let app: FastifyInstance
  let listenerId: string

  beforeEach(async () => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    listenerId = created.json().id
  })

  it('captures a POST payload and returns 200', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/hook/${listenerId}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ foo: 'bar' }),
    })

    expect(response.statusCode).toBe(200)

    const requests = await app.inject({ method: 'GET', url: `/api/listeners/${listenerId}/requests` })
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

    const requests = await app.inject({ method: 'GET', url: `/api/listeners/${listenerId}/requests` })
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

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/routes/hook.test.ts`
Expected: FAIL — `Cannot find module '../routes/hook'` (module doesn't exist) and/or 404s where 200 is expected.

- [ ] **Step 3: Implement the hook route and wire it in**

`backend/src/routes/hook.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db'
import { getListener } from '../listeners.repo'
import { insertRequest } from '../requests.repo'

export function registerHookRoute(app: FastifyInstance, db: Db): void {
  app.all<{ Params: { id: string } }>('/hook/:id', async (request, reply) => {
    const listener = getListener(db, request.params.id)
    if (!listener) {
      reply.code(404)
      return { error: 'listener not found' }
    }

    const body = typeof request.body === 'string' ? request.body : null

    insertRequest(db, {
      listenerId: listener.id,
      method: request.method,
      headers: JSON.stringify(request.headers),
      queryParams: JSON.stringify(request.query ?? {}),
      body,
      contentType: (request.headers['content-type'] as string | undefined) ?? null,
      sourceIp: request.ip,
      receivedAt: new Date().toISOString(),
    })

    reply.code(200).send()
  })
}
```

Modify `backend/src/server.ts` — add the import and registration:
```ts
import { registerListenerRoutes } from './routes/listeners'
import { registerHookRoute } from './routes/hook'
```
and inside `buildServer`, after `registerListenerRoutes(app, db, baseUrl)`:
```ts
  registerHookRoute(app, db)
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/routes/hook.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full backend test suite**

Run (from `backend/`): `npm test`
Expected: All test files pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/hook.ts backend/src/server.ts backend/src/routes/hook.test.ts
git commit -m "feat(backend): add /hook/:id capture route"
```

---

### Task 6: Backend entrypoint and Dockerfile

**Files:**
- Create: `backend/src/index.ts`
- Create: `backend/Dockerfile`
- Create: `backend/.dockerignore`

**Interfaces:**
- Consumes: `createDb` from `backend/src/db.ts`; `buildServer` from `backend/src/server.ts`.
- Produces: the runnable backend process, listening on `PORT` and reading `DB_PATH`/`BASE_URL` from the environment. Consumed by `docker-compose.yml` in Task 11.

- [ ] **Step 1: Implement the entrypoint**

`backend/src/index.ts`:
```ts
import { createDb } from './db'
import { buildServer } from './server'

const port = Number(process.env.PORT ?? 3000)
const dbPath = process.env.DB_PATH ?? './webhook-listener.db'
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`

const db = createDb(dbPath)
const app = buildServer({ db, baseUrl })

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Verify it builds and runs locally**

Run (from `backend/`): `npm run build && PORT=3000 DB_PATH=./dev.db node dist/index.js`
Expected: Log output showing the Fastify server listening on port 3000, no errors. Then `Ctrl+C` to stop it, and delete the scratch file: `rm -f backend/dev.db backend/dev.db-wal backend/dev.db-shm`.

- [ ] **Step 3: Write the Dockerfile**

`backend/.dockerignore`:
```
node_modules
dist
*.db
*.db-wal
*.db-shm
```

`backend/Dockerfile`:
```dockerfile
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 4: Build the image standalone to verify it compiles**

Run (from `backend/`): `docker build -t webhook-listener-backend .`
Expected: Image builds successfully with no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.ts backend/Dockerfile backend/.dockerignore
git commit -m "feat(backend): add process entrypoint and Dockerfile"
```

---

### Task 7: Frontend scaffolding

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/tsconfig.node.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/api.ts`

**Interfaces:**
- Produces: `Listener`, `CapturedRequest` types and `createListener`, `getListener`, `getRequests`, `deleteListener` functions from `frontend/src/api.ts`. Consumed by Task 8 (`Home.tsx`) and Task 9 (`Listener.tsx`).

- [ ] **Step 1: Create the project config files**

`frontend/package.json`:
```json
{
  "name": "webhook-listener-frontend",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2"
  },
  "devDependencies": {
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.6.2",
    "vite": "^5.4.6"
  }
}
```

`frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

`frontend/tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

`frontend/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
```

`frontend/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Webhook Listener</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the API client**

`frontend/src/api.ts`:
```ts
export interface Listener {
  id: string
  createdAt: string
  hookUrl: string
}

export interface CapturedRequest {
  id: number
  listenerId: string
  method: string
  headers: Record<string, string>
  queryParams: Record<string, string>
  body: string | null
  contentType: string | null
  sourceIp: string | null
  receivedAt: string
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`request failed with status ${response.status}`)
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
    throw new Error(`request failed with status ${response.status}`)
  }
}
```

- [ ] **Step 3: Write placeholder App and entrypoint**

`frontend/src/App.tsx`:
```tsx
export function App() {
  return <main>Webhook Listener</main>
}
```

`frontend/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

- [ ] **Step 4: Install dependencies and verify the dev server starts**

Run (from `frontend/`): `npm install`
Expected: `node_modules/` and `package-lock.json` created with no errors.

Run (from `frontend/`): `npm run dev -- --port 5173` then open `http://localhost:5173` in a browser (or `curl http://localhost:5173`).
Expected: Page loads showing "Webhook Listener". Stop the dev server with `Ctrl+C`.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/tsconfig.json frontend/tsconfig.node.json frontend/vite.config.ts frontend/index.html frontend/src/main.tsx frontend/src/App.tsx frontend/src/api.ts
git commit -m "feat(frontend): scaffold Vite/React project and API client"
```

---

### Task 8: Home page and routing

**Files:**
- Create: `frontend/src/pages/Home.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `createListener` from `frontend/src/api.ts`.
- Produces: route `/` rendering `Home`; route `/listener/:id` reserved for Task 9's `Listener` component (imported once it exists).

- [ ] **Step 1: Write the Home page**

`frontend/src/pages/Home.tsx`:
```tsx
import { useNavigate } from 'react-router-dom'
import { createListener } from '../api'

export function Home() {
  const navigate = useNavigate()

  async function handleCreate() {
    const listener = await createListener()
    navigate(`/listener/${listener.id}`)
  }

  return (
    <main>
      <h1>Webhook Listener</h1>
      <button onClick={handleCreate}>Create new webhook listener</button>
    </main>
  )
}
```

- [ ] **Step 2: Wire up routing in App**

Replace the contents of `frontend/src/App.tsx`:
```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Home } from './pages/Home'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </BrowserRouter>
  )
}
```

- [ ] **Step 3: Verify manually**

Run (from `frontend/`): `npm run dev -- --port 5173`, open `http://localhost:5173`.
Expected: Page shows the "Create new webhook listener" button. Clicking it will currently fail the network call (no backend running) — that's expected at this stage; just confirm the page renders and the button is present. Stop the dev server with `Ctrl+C`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Home.tsx frontend/src/App.tsx
git commit -m "feat(frontend): add home page and routing"
```

---

### Task 9: Listener page

**Files:**
- Create: `frontend/src/pages/Listener.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `Listener`, `CapturedRequest`, `getListener`, `getRequests`, `deleteListener` from `frontend/src/api.ts`.
- Produces: route `/listener/:id` rendering `Listener`.

- [ ] **Step 1: Write the Listener page**

`frontend/src/pages/Listener.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  type CapturedRequest,
  type Listener as ListenerModel,
  deleteListener,
  getListener,
  getRequests,
} from '../api'

const POLL_INTERVAL_MS = 3000

function safeParse(body: string | null): unknown {
  if (!body) return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function Listener() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [listener, setListener] = useState<ListenerModel | null>(null)
  const [requests, setRequests] = useState<CapturedRequest[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!id) return false
    try {
      const [listenerData, requestData] = await Promise.all([getListener(id), getRequests(id)])
      setListener(listenerData)
      setRequests(requestData)
      setError(null)
      return true
    } catch {
      setError('Listener not found or unreachable.')
      return false
    }
  }, [id])

  useEffect(() => {
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

  async function handleDelete() {
    if (!id) return
    if (!window.confirm('Delete this listener and all its history?')) return
    await deleteListener(id)
    navigate('/')
  }

  async function handleCopy() {
    if (!listener) return
    await navigator.clipboard.writeText(listener.hookUrl)
  }

  if (error) {
    return <p role="alert">{error}</p>
  }

  if (!listener) {
    return <p>Loading…</p>
  }

  return (
    <main>
      <h1>Listener</h1>
      <p>
        <code>{listener.hookUrl}</code>
        <button onClick={handleCopy}>Copy</button>
      </p>
      <button onClick={handleDelete}>Delete listener</button>

      <ul>
        {requests.map((req) => (
          <li key={req.id}>
            <button onClick={() => setExpandedId(expandedId === req.id ? null : req.id)}>
              {req.method} — {req.receivedAt} — {req.contentType ?? 'no content-type'}
            </button>
            {expandedId === req.id && (
              <pre>
                {JSON.stringify(
                  {
                    headers: req.headers,
                    queryParams: req.queryParams,
                    sourceIp: req.sourceIp,
                    body: safeParse(req.body),
                  },
                  null,
                  2
                )}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </main>
  )
}
```

- [ ] **Step 2: Wire the route into App**

Replace the contents of `frontend/src/App.tsx`:
```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/listener/:id" element={<Listener />} />
      </Routes>
    </BrowserRouter>
  )
}
```

- [ ] **Step 3: Verify the frontend builds**

Run (from `frontend/`): `npm run build`
Expected: Build completes with no TypeScript errors, producing a `dist/` directory.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Listener.tsx frontend/src/App.tsx
git commit -m "feat(frontend): add listener page with polling, copy, and delete"
```

---

### Task 10: Frontend Dockerfile and Nginx reverse proxy

**Files:**
- Create: `frontend/Dockerfile`
- Create: `frontend/nginx.conf`
- Create: `frontend/.dockerignore`

**Interfaces:**
- Consumes: the `dist/` build output from Task 9's `npm run build`.
- Produces: an Nginx image serving the built SPA on port 80, proxying `/api/*` and `/hook/*` to a service named `backend` on port 3000. Consumed by `docker-compose.yml` in Task 11.

- [ ] **Step 1: Write the Nginx config**

`frontend/nginx.conf`:
```nginx
server {
    listen 80;

    location /api/ {
        proxy_pass http://backend:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /hook/ {
        proxy_pass http://backend:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        root /usr/share/nginx/html;
        try_files $uri /index.html;
    }
}
```

- [ ] **Step 2: Write the Dockerfile**

`frontend/.dockerignore`:
```
node_modules
dist
```

`frontend/Dockerfile`:
```dockerfile
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **Step 3: Build the image standalone to verify it compiles**

Run (from `frontend/`): `docker build -t webhook-listener-frontend .`
Expected: Image builds successfully with no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/Dockerfile frontend/nginx.conf frontend/.dockerignore
git commit -m "feat(frontend): add Dockerfile and Nginx reverse proxy config"
```

---

### Task 11: Docker Compose wiring

**Files:**
- Create: `docker-compose.yml`

**Interfaces:**
- Consumes: `backend/Dockerfile` (Task 6), `frontend/Dockerfile` (Task 10).
- Produces: the full local stack, reachable at `http://localhost:8080`.

- [ ] **Step 1: Write docker-compose.yml**

`docker-compose.yml`:
```yaml
services:
  backend:
    build: ./backend
    environment:
      - PORT=3000
      - DB_PATH=/data/webhook-listener.db
      - BASE_URL=http://localhost:8080
    volumes:
      - sqlite-data:/data
    expose:
      - "3000"

  frontend:
    build: ./frontend
    ports:
      - "8080:80"
    depends_on:
      - backend

volumes:
  sqlite-data:
```

- [ ] **Step 2: Bring the stack up**

Run: `docker compose up --build -d`
Expected: Both `backend` and `frontend` containers report as running (`docker compose ps`).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: wire backend and frontend into docker-compose"
```

---

### Task 12: End-to-end verification

**Files:** none (verification only).

**Interfaces:** none — this task exercises the full stack from Task 11.

- [ ] **Step 1: Create a listener via the API**

Run: `curl -s -X POST http://localhost:8080/api/listeners`
Expected: JSON response with `id` and `hookUrl` fields, e.g. `{"id":"...","createdAt":"...","hookUrl":"http://localhost:8080/hook/..."}`. Note the `id` for the next steps (call it `$ID`).

- [ ] **Step 2: Send a payload to the listener**

Run: `curl -s -X POST http://localhost:8080/hook/$ID -H 'Content-Type: application/json' -d '{"foo":"bar"}'`
Expected: Empty `200 OK` response (check with `-i` flag if you want to see the status line).

- [ ] **Step 3: Confirm the payload is retrievable via the API**

Run: `curl -s http://localhost:8080/api/listeners/$ID/requests`
Expected: A JSON array with one entry whose `body` is `{"foo":"bar"}` and `contentType` is `application/json`.

- [ ] **Step 4: Confirm the payload is visible in the UI**

Open `http://localhost:8080/listener/$ID` in a browser.
Expected: The webhook URL is shown, and the captured request appears in the list within ~3 seconds (poll interval). Expanding it shows headers, query params, and the pretty-printed body.

- [ ] **Step 5: Verify persistence across a backend restart**

Run: `docker compose restart backend`, wait a few seconds, then repeat Step 3.
Expected: The previously captured request is still present — confirms the SQLite file on the named volume survived the restart.

- [ ] **Step 6: Verify deletion**

In the browser, click "Delete listener" and confirm the prompt. Then run: `curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/listeners/$ID`
Expected: Browser redirects to the home page; the curl command prints `404`.

- [ ] **Step 7: Tear down**

Run: `docker compose down`
Expected: Containers stop and are removed (the named volume `sqlite-data` persists unless `-v` is passed).

No commit needed for this task — it's verification only. If any step fails, fix the underlying task's code, re-run that task's automated tests, then re-run this task's steps from Step 1.
