# Home Page Listener List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the current session's own listeners on the home page,
newest first, each linking to its listener page — instead of the home page
being only a "Create new webhook listener" button.

**Architecture:** One new backend route (`GET /api/listeners`) backed by
one new repository function (`getListenersForOwner`, plural) that queries
by `owner_session` and returns the most recent matches. The frontend fetches
this list once on `Home.tsx` mount and renders it above the existing create
button.

**Tech Stack:** Same as the existing project — Node/TypeScript/Fastify/
better-sqlite3 backend, Vitest for backend tests; React/Vite/Tailwind
frontend, no automated frontend tests (established project scope).

**Spec:** `docs/superpowers/specs/2026-09-17-home-listener-list-design.md`

**Hard dependency:** this plan requires
`docs/superpowers/plans/2026-09-17-session-scoped-ownership.md` to be fully
implemented and merged first — specifically the `owner_session` column,
`request.sessionId` (the session cookie hook), and the
`getListenerForOwner`/`ListenerRecord` shape it introduces. Do not start
Task 1 below until that plan's full backend test suite is green.

## Global Constraints

- `GET /api/listeners` returns only the calling session's own listeners —
  never another session's, never all listeners system-wide.
- Ordered newest-first (`created_at DESC`), capped at 100 rows (a
  defensive bound, not a business requirement).
- A session with zero listeners gets `200` with an empty array, not an
  error.
- The frontend list-fetch failing must never block the existing
  create-a-listener flow — the create button stays usable either way.
- No automated frontend tests exist in this project (established scope) —
  frontend verification is `npm run build` plus manual checks.

---

## File Structure

```
backend/
  src/
    listeners.repo.ts        # MODIFY: add getListenersForOwner
    listeners.repo.test.ts   # MODIFY: add tests for it
    routes/
      listeners.ts           # MODIFY: add GET /api/listeners
      listeners.list.test.ts # CREATE: route-level tests

frontend/
  src/
    api.ts                   # MODIFY: add listListeners()
    pages/
      Home.tsx               # MODIFY: fetch and render the list
```

---

### Task 1: Repository function — list a session's own listeners

**Files:**
- Modify: `backend/src/listeners.repo.ts`
- Modify: `backend/src/listeners.repo.test.ts`

**Interfaces:**
- Consumes: `Db` from `backend/src/db.ts`; the `owner_session` column and
  `ListenerRecord` shape from the session-scoped-ownership feature
  (already implemented — this plan depends on it).
- Produces: `getListenersForOwner(db: Db, sessionId: string, limit: number): ListenerRecord[]`.
  Used by Task 2 (the new route).

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `backend/src/listeners.repo.test.ts` (keep
all existing blocks in that file unchanged — just add this one):

```ts
describe('getListenersForOwner', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('returns only the calling session\'s listeners, newest first', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    createListener(db, 'listener-2', '2024-01-02T00:00:00.000Z', 'session-a')
    createListener(db, 'listener-3', '2024-01-03T00:00:00.000Z', 'session-b')

    const result = getListenersForOwner(db, 'session-a', 100)
    expect(result.map((l) => l.id)).toEqual(['listener-2', 'listener-1'])
  })

  it('returns an empty array for a session with no listeners', () => {
    expect(getListenersForOwner(db, 'session-with-nothing', 100)).toEqual([])
  })

  it('respects the limit', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    createListener(db, 'listener-2', '2024-01-02T00:00:00.000Z', 'session-a')
    createListener(db, 'listener-3', '2024-01-03T00:00:00.000Z', 'session-a')

    const result = getListenersForOwner(db, 'session-a', 2)
    expect(result).toHaveLength(2)
    expect(result.map((l) => l.id)).toEqual(['listener-3', 'listener-2'])
  })
})
```

Add `getListenersForOwner` to the existing import line at the top of the
file (alongside `createListener`, `getListener`, `getListenerForOwner`,
etc. — whatever that file's current import list is after the
session-ownership feature landed).

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/listeners.repo.test.ts`
Expected: FAIL — `getListenersForOwner` doesn't exist yet.

- [ ] **Step 3: Implement the function**

Add this function to `backend/src/listeners.repo.ts` (place it next to
the existing `getListenerForOwner` — keep the singular/plural pair
together for readability):

```ts
export function getListenersForOwner(db: Db, sessionId: string, limit: number): ListenerRecord[] {
  return db
    .prepare(
      `
      SELECT id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession
      FROM listeners
      WHERE owner_session = ?
      ORDER BY created_at DESC
      LIMIT ?
    `
    )
    .all(sessionId, limit) as ListenerRecord[]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/listeners.repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite once**

Run (from `backend/`): `npm test`
Expected: all test files pass — this function isn't consumed by any route
yet.

- [ ] **Step 6: Commit**

```bash
git add backend/src/listeners.repo.ts backend/src/listeners.repo.test.ts
git commit -m "feat(backend): add getListenersForOwner repository function"
```

---

### Task 2: API route — list the current session's listeners

**Files:**
- Modify: `backend/src/routes/listeners.ts`
- Create: `backend/src/routes/listeners.list.test.ts`

**Interfaces:**
- Consumes: `getListenersForOwner` from `backend/src/listeners.repo.ts`
  (Task 1); `request.sessionId` from the existing session cookie hook;
  `extractSessionId` from `backend/src/test-helpers/session.ts` (already
  exists from the session-ownership feature).
- Produces: `GET /api/listeners` → `Array<{ id, createdAt, hookUrl, shareUrl }>`,
  same per-item shape as `GET /api/listeners/:id`. Consumed by Task 3
  (frontend `api.ts`).

- [ ] **Step 1: Write the failing tests**

Create `backend/src/routes/listeners.list.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../db'
import { buildServer } from '../server'
import { extractSessionId } from '../test-helpers/session'

describe('GET /api/listeners', () => {
  let db: Db
  let app: FastifyInstance

  beforeEach(() => {
    db = createDb(':memory:')
    app = buildServer({ db, baseUrl: 'http://localhost:8080' })
  })

  it('returns an empty array for a session with no listeners', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/listeners' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })

  it('returns only the calling session\'s own listeners, newest first', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/listeners' })
    const sessionId = extractSessionId(first)
    const second = await app.inject({
      method: 'POST',
      url: '/api/listeners',
      cookies: { session_id: sessionId },
    })

    const otherSessionCreate = await app.inject({ method: 'POST', url: '/api/listeners' })
    const otherSessionId = extractSessionId(otherSessionCreate)

    const response = await app.inject({
      method: 'GET',
      url: '/api/listeners',
      cookies: { session_id: sessionId },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.map((l: { id: string }) => l.id)).toEqual([second.json().id, first.json().id])

    const otherResponse = await app.inject({
      method: 'GET',
      url: '/api/listeners',
      cookies: { session_id: otherSessionId },
    })
    expect(otherResponse.json().map((l: { id: string }) => l.id)).toEqual([otherSessionCreate.json().id])
  })

  it('includes hookUrl and shareUrl on each item, matching the single-listener shape', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/listeners' })
    const sessionId = extractSessionId(created)

    const response = await app.inject({
      method: 'GET',
      url: '/api/listeners',
      cookies: { session_id: sessionId },
    })
    const [listed] = response.json()
    expect(listed.hookUrl).toBe(created.json().hookUrl)
    expect(listed.shareUrl).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npx vitest run src/routes/listeners.list.test.ts`
Expected: FAIL — `GET /api/listeners` doesn't exist yet (404s where 200s
are expected).

- [ ] **Step 3: Implement the route**

Modify `backend/src/routes/listeners.ts`:

Add `getListenersForOwner` to the existing import from `../listeners.repo`.

Add this route inside `registerListenerRoutes`, placed before the existing
`app.post('/api/listeners', ...)` registration (order doesn't affect
Fastify's routing — a literal `/api/listeners` path always matches before
the `/api/listeners/:id` wildcard route regardless of registration order —
but placing the list route near the top keeps the file's route order
matching the API table in the spec):

```ts
const LIST_LIMIT = 100

app.get('/api/listeners', async (request) => {
  const listeners = getListenersForOwner(db, request.sessionId, LIST_LIMIT)
  return listeners.map((listener) => ({
    id: listener.id,
    createdAt: listener.createdAt,
    hookUrl: `${baseUrl}/hook/${listener.id}`,
    shareUrl: shareUrlFor(baseUrl, listener.shareToken),
  }))
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npx vitest run src/routes/listeners.list.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite once**

Run (from `backend/`): `npm test`
Expected: all test files pass, including the existing
`POST /api/listeners` tests (confirm the new `GET /api/listeners` route
didn't shadow or conflict with `GET /api/listeners/:id` — Fastify's router
distinguishes a literal segment from a parameterized one automatically, so
this should just work, but the full suite passing is the actual proof).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/listeners.ts backend/src/routes/listeners.list.test.ts
git commit -m "feat(backend): add GET /api/listeners route"
```

---

### Task 3: Frontend — show the list on the home page

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/pages/Home.tsx`

**Interfaces:**
- Consumes: the existing `Listener` type and `ApiError`/`parseJsonOrThrow`
  pattern already in `frontend/src/api.ts`.
- Produces: `export function listListeners(): Promise<Listener[]>` in
  `api.ts`. `Home.tsx` renders the list above its existing create button.

- [ ] **Step 1: Add the API client function**

In `frontend/src/api.ts`, add this function alongside the existing ones
(e.g. near `getListener`):

```ts
export function listListeners(): Promise<Listener[]> {
  return fetch('/api/listeners').then((r) => parseJsonOrThrow<Listener[]>(r))
}
```

- [ ] **Step 2: Update the Home page**

Read the current contents of `frontend/src/pages/Home.tsx` first — it
currently has `error`/`creating` state and a `handleCreate` function
rendering a centered card with a heading, subtext, and the create button.
Add list-fetching alongside the existing state, without changing the
existing create-flow behavior:

- Add `const [listeners, setListeners] = useState<Listener[]>([])` (import
  `type Listener` from `../api` alongside the other imports).
- Add a `useEffect` that calls `listListeners()` on mount, setting
  `listeners` on success and silently ignoring failure (per the spec: a
  failed list fetch must never block the create flow, so no error state is
  set for this fetch — only the existing `error` state, which is reserved
  for the create-listener flow, stays as-is):

```tsx
useEffect(() => {
  listListeners()
    .then(setListeners)
    .catch(() => {
      // Listing is a nice-to-have; a failed fetch must not block the create flow.
    })
}, [])
```

- Render the list above the existing create button, inside the same card,
  only when non-empty:

```tsx
{listeners.length > 0 && (
  <ul className="mb-6 space-y-2 text-left">
    {listeners.map((listener) => (
      <li key={listener.id}>
        <a
          href={`/listener/${listener.id}`}
          className="block rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
        >
          {new Date(listener.createdAt).toLocaleString()}
        </a>
      </li>
    ))}
  </ul>
)}
```

Use a plain `<a href>` rather than React Router's `<Link>` here — check
which one `Home.tsx` already imports/uses elsewhere in the file (it
currently uses `useNavigate` for programmatic navigation after create, not
`<Link>` for a static list); if `react-router-dom`'s `Link` is not already
imported in this file, prefer the plain `<a>` above to avoid adding an
import for a single static link list, since a full page navigation to
`/listener/:id` is inconsequential for this app (small bundle, no
client-side state worth preserving across that navigation).

- [ ] **Step 3: Verify the frontend builds**

Run (from `frontend/`): `npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api.ts frontend/src/pages/Home.tsx
git commit -m "feat(frontend): show the session's own listeners on the home page"
```

---

### Task 4: End-to-end verification

**Files:** none (verification only).

**Interfaces:** none — this task exercises the full stack built by Tasks 1-3.

- [ ] **Step 1: Rebuild and bring up the stack**

Run: `docker compose up -d --build`
Expected: both containers report `Up`.

- [ ] **Step 2: Create two listeners in one "browser" (one cookie jar)**

```bash
rm -f /tmp/webhook-cookiejar-home.txt
curl -s -c /tmp/webhook-cookiejar-home.txt -b /tmp/webhook-cookiejar-home.txt -X POST http://localhost:8080/api/listeners
curl -s -c /tmp/webhook-cookiejar-home.txt -b /tmp/webhook-cookiejar-home.txt -X POST http://localhost:8080/api/listeners
```
Expected: two distinct listener ids returned.

- [ ] **Step 3: Confirm the list endpoint shows both, newest first**

```bash
curl -s -b /tmp/webhook-cookiejar-home.txt http://localhost:8080/api/listeners | python3 -m json.tool
```
Expected: a JSON array with exactly the two listeners just created, second
one first (newest first).

- [ ] **Step 4: Confirm a fresh session sees none of them**

```bash
curl -s http://localhost:8080/api/listeners
```
Expected: `[]` (no cookie jar — a fresh browser/incognito window).

- [ ] **Step 5: Confirm the home page itself renders the list**

Open `http://localhost:8080/` in a browser (the same one used to create
the listeners above, so its cookie is set).
Expected (manual): both listeners appear as clickable entries above the
"Create new webhook listener" button, each navigating to its
`/listener/:id` page when clicked.

```bash
rm -f /tmp/webhook-cookiejar-home.txt
```

No commit needed for this task — it's verification only. If any step
fails, fix the underlying task's code, re-run that task's automated tests,
then re-run this task's steps from Step 1.
