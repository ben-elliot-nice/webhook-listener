# Requests Pagination and Body-Size Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Cloudflare Worker memory spikes caused by (1) three route handlers serializing up to 200 full request bodies into one response, and (2) `hook.ts`'s body-size cap being bypassable via chunked transfer-encoding — while switching the frontend to infinite-scroll pagination (most-recent-first, ~20 rows/page) instead of loading full listener history at once.

**Architecture:** Two new repo functions (`getRequestsPage`, `getRequestById`) in `backend/src/requests.repo.ts` replace `getRequests()` at all three list-serving call sites (owner listener view, share-token listener view, share-token project-listener view) — `getRequests()` itself is left untouched since it's still used as a test-verification helper. A new shared module, `backend/src/routes/requestListSerializer.ts`, applies a 256KB body-truncation rule uniformly across all three tiers so the logic isn't duplicated three times. Each tier gains a new sibling "full body on demand" detail endpoint. `hook.ts`'s two capture routes switch from `Content-Length`-gated `clone().text()` to a streaming byte-counted read that enforces `MAX_BODY_BYTES` regardless of transfer encoding. On the frontend, a new `usePaginatedRequests` hook centralizes page-accumulation/merge logic, reused by `Listener.tsx`, `SharedListener.tsx`, and `SharedProjectListener.tsx`; `RequestRow.tsx` gains a "view full payload" affordance for truncated rows.

**Tech Stack:** Hono (routing), D1 (SQLite-compatible), Vitest + `@cloudflare/vitest-pool-workers` for backend tests. Frontend: React/Vite/TypeScript, no test runner configured — frontend tasks are verified via `npm run build` (`tsc -b && vite build`) plus a code read-through, per this repo's existing practice (no browser automation available).

**Spec:** `docs/superpowers/specs/2026-09-29-requests-pagination-memory-design.md`

## Global Constraints

- List responses change shape from a bare array to `{ requests: [...], nextCursor: number | null }` (spec "Data flow / API contract"). The frontend is the only consumer of these three endpoints — no back-compat shim needed.
- Body-truncation threshold is 256KB; capture-time `MAX_BODY_BYTES` stays at 10MB, unchanged (spec, explicit user decision).
- Default page size is 20, clamped server-side to a max of 100; invalid/missing `limit` falls back to 20, invalid/missing `before` is treated as "first page" (spec "Error handling").
- `getRequests()` in `requests.repo.ts` is NOT removed or modified — it's still imported by `backend/src/requests.repo.test.ts` and `backend/src/routes/hook.test.ts` as a test-verification helper. Only its three production call sites (in `listeners.ts`/`shared.ts`) are replaced.
- Diff-view boundary behavior needs no new code: `previousByRequestId` (in `Listener.tsx`/`SharedListener.tsx`/`SharedProjectListener.tsx`) already returns `undefined` for the last-indexed row in the currently-loaded array, and `RequestRow` already renders no diff button when `previousRequest` is `undefined`. Appending older pages at the end of the accumulated, id-descending-sorted array is sufficient — do not add special-case boundary logic (spec confirms this is the desired behavior; discovered during planning that the existing code already satisfies it).
- Known, accepted limitation (document in Task 13, do not attempt to fix): JSON/HAR export (`frontend/src/lib/exportRequests.ts`) now exports whatever's currently loaded client-side, which may be (a) less than full history (only loaded pages) and (b) a truncated body preview for any row over 256KB. This is a behavior change from today's "always full history, always full body" export; it is accepted as a consequence of this fix, not remediated in this plan.
- **Post-brainstorm sync note:** between writing the spec and writing this plan, `main` was synced with `origin/main`, which had a fully-shipped **email access gate** feature not present when the spec was written. This changed two things everywhere in this plan, already accounted for below: (1) owner identity is now `c.get('email')` (a verified email address from a signed `wl_email_session` cookie), not the old anonymous `c.get('sessionId')` — `getListenerForOwner`/`getListenersForOwner`/etc. all take the caller's email now; (2) **every** non-`/hook/*`, non-`/auth/*` route — including all three `/api/shared/...` tiers — now requires a valid `wl_email_session` cookie (an app-level `401` gate in `backend/src/app.ts`), so "read-only share access, no session check" from `CLAUDE.md`'s three-tier model is now "no *ownership* check, but does require being logged in as *some* authenticated email." Backend tests authenticate via `authCookieHeader(env, email)` from `backend/src/test-helpers/auth.ts` (not the older `cookieHeader`/`extractSessionId` from `backend/src/test-helpers/session.ts`, which is a different, legacy helper still used by unrelated tests). `requests.repo.ts` and `hook.ts` themselves are untouched by the email-gate feature — Tasks 1 and 2 need no changes.

---

## File Structure

- **Modify:** `backend/src/requests.repo.ts` — add `getRequestsPage`, `getRequestById`.
- **Create:** `backend/src/routes/requestListSerializer.ts` — `serializeRequestListItem`, `parsePageParams`, `BODY_PREVIEW_BYTES`.
- **Create:** `backend/src/routes/requestListSerializer.test.ts` — unit tests for truncation boundary and page-param parsing.
- **Modify:** `backend/src/routes/hook.ts` — streaming byte-counted body read, replacing `Content-Length`-gated `clone().text()`.
- **Modify:** `backend/src/routes/listeners.ts` — paginate `/api/listeners/:id/requests`; add `/api/listeners/:id/requests/:requestId/body`.
- **Modify:** `backend/src/routes/shared.ts` — paginate both list endpoints; add both detail endpoints.
- **Modify:** `backend/src/requests.repo.test.ts` — add tests for the two new repo functions (existing `getRequests` tests untouched).
- **Modify:** `backend/src/routes/hook.test.ts` — add the chunked-encoding oversized-body test.
- **Create:** `backend/src/routes/listeners.requests.test.ts` — new coverage for `/api/listeners/:id/requests`'s response shape/pagination/truncation and its new `/body` detail endpoint (no existing test currently asserts on this endpoint's response shape — `listeners.ownership.test.ts` only checks 404 isolation).
- **Modify:** `backend/src/routes/shared.test.ts` — update the existing bare-array response assertions to the new `{ requests, nextCursor }` shape, update the "exposes exactly the expected fields" test for the two new fields, add pagination cases, add the new detail-endpoint tests.
- **Modify:** `backend/src/routes/shared.projects.test.ts` — same, for the project-listener share tier.
- **Modify:** `frontend/src/api.ts` — paginated request/response types, new detail-fetch functions.
- **Create:** `frontend/src/hooks/usePaginatedRequests.ts` — shared pagination/merge hook.
- **Modify:** `frontend/src/components/RequestRow.tsx` — "view full payload" affordance.
- **Modify:** `frontend/src/pages/Listener.tsx` — wire pagination hook, infinite scroll, full-body fetch.
- **Modify:** `frontend/src/pages/SharedListener.tsx` — same.
- **Modify:** `frontend/src/pages/SharedProjectListener.tsx` — same.
- **Modify:** `STATUS.md`, `BACKLOG.md` — mark shipped, document the export limitation.

---

### Task 1: `getRequestsPage` and `getRequestById` in `requests.repo.ts`

**Files:**
- Modify: `backend/src/requests.repo.ts`
- Test: `backend/src/requests.repo.test.ts`

**Interfaces:**
- Consumes: existing `RequestRecord` interface, existing `insertRequest`/`createListener` test helpers.
- Produces: `interface RequestsPage { requests: RequestRecord[]; nextCursor: number | null }`; `getRequestsPage(db: Env['DB'], listenerId: string, options: { limit: number; before?: number }): Promise<RequestsPage>`; `getRequestById(db: Env['DB'], listenerId: string, requestId: number): Promise<RequestRecord | undefined>`. Tasks 3, 4, 5 call these by these exact names.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/requests.repo.test.ts — add to the existing describe block, after the existing three tests
import { getRequestsPage, getRequestById } from './requests.repo'

describe('requests repo pagination', () => {
  const listenerId = 'listener-page'

  it('returns the newest `limit` rows and a nextCursor when more remain', async () => {
    await createListener(env.DB, listenerId, '2024-01-01T00:00:00.000Z', 'session-a')
    for (let i = 0; i < 5; i++) {
      await insertRequest(env.DB, {
        listenerId,
        method: 'POST',
        headers: '{}',
        queryParams: '{}',
        body: `request-${i}`,
        contentType: 'text/plain',
        sourceIp: '127.0.0.1',
        receivedAt: `2024-01-01T00:00:0${i}.000Z`,
      })
    }

    const page = await getRequestsPage(env.DB, listenerId, { limit: 3 })
    expect(page.requests.map((r) => r.body)).toEqual(['request-4', 'request-3', 'request-2'])
    expect(page.nextCursor).toBe(page.requests[2].id)
  })

  it('returns the next page using `before`, and nextCursor null once exhausted', async () => {
    const pagedListenerId = 'listener-page-2'
    await createListener(env.DB, pagedListenerId, '2024-01-01T00:00:00.000Z', 'session-a')
    for (let i = 0; i < 5; i++) {
      await insertRequest(env.DB, {
        listenerId: pagedListenerId,
        method: 'POST',
        headers: '{}',
        queryParams: '{}',
        body: `request-${i}`,
        contentType: 'text/plain',
        sourceIp: '127.0.0.1',
        receivedAt: `2024-01-01T00:00:0${i}.000Z`,
      })
    }

    const firstPage = await getRequestsPage(env.DB, pagedListenerId, { limit: 3 })
    const secondPage = await getRequestsPage(env.DB, pagedListenerId, {
      limit: 3,
      before: firstPage.nextCursor ?? undefined,
    })
    expect(secondPage.requests.map((r) => r.body)).toEqual(['request-1', 'request-0'])
    expect(secondPage.nextCursor).toBeNull()
  })

  it('returns an empty page with nextCursor null for a listener with no requests', async () => {
    await createListener(env.DB, 'listener-empty-page', '2024-01-01T00:00:00.000Z', 'session-a')
    const page = await getRequestsPage(env.DB, 'listener-empty-page', { limit: 20 })
    expect(page.requests).toEqual([])
    expect(page.nextCursor).toBeNull()
  })
})

describe('getRequestById', () => {
  it('returns the row for a known id scoped to its listener', async () => {
    const listenerId = 'listener-detail'
    await createListener(env.DB, listenerId, '2024-01-01T00:00:00.000Z', 'session-a')
    await insertRequest(env.DB, {
      listenerId,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'the-body',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:00.000Z',
    })
    const [row] = (await getRequestsPage(env.DB, listenerId, { limit: 1 })).requests
    const found = await getRequestById(env.DB, listenerId, row.id)
    expect(found?.body).toBe('the-body')
  })

  it('returns undefined for an id that belongs to a different listener', async () => {
    const listenerA = 'listener-detail-a'
    const listenerB = 'listener-detail-b'
    await createListener(env.DB, listenerA, '2024-01-01T00:00:00.000Z', 'session-a')
    await createListener(env.DB, listenerB, '2024-01-01T00:00:00.000Z', 'session-a')
    await insertRequest(env.DB, {
      listenerId: listenerA,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'a-body',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:00.000Z',
    })
    const [row] = (await getRequestsPage(env.DB, listenerA, { limit: 1 })).requests
    const found = await getRequestById(env.DB, listenerB, row.id)
    expect(found).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npm test -- requests.repo.test.ts`
Expected: FAIL — `getRequestsPage`/`getRequestById` not exported yet.

- [ ] **Step 3: Write the implementation**

Add to `backend/src/requests.repo.ts`, after the existing `getRequests`:

```typescript
export interface RequestsPage {
  requests: RequestRecord[]
  nextCursor: number | null
}

const SELECT_COLUMNS = `
  id,
  listener_id AS listenerId,
  method,
  headers,
  query_params AS queryParams,
  body,
  content_type AS contentType,
  source_ip AS sourceIp,
  received_at AS receivedAt
`

export async function getRequestsPage(
  db: Env['DB'],
  listenerId: string,
  options: { limit: number; before?: number }
): Promise<RequestsPage> {
  const before = options.before ?? null
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
      FROM requests
      WHERE listener_id = ?
        AND (?2 IS NULL OR id < ?2)
      ORDER BY received_at DESC, id DESC
      LIMIT ?3`
    )
    .bind(listenerId, before, options.limit)
    .all<RequestRecord>()

  const nextCursor = results.length === options.limit ? results[results.length - 1].id : null
  return { requests: results, nextCursor }
}

export async function getRequestById(
  db: Env['DB'],
  listenerId: string,
  requestId: number
): Promise<RequestRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM requests WHERE listener_id = ? AND id = ?`)
    .bind(listenerId, requestId)
    .first<RequestRecord>()
  return row ?? undefined
}
```

Note the positional-parameter syntax (`?2`, `?3`) in `getRequestsPage`'s query — D1 (like SQLite) supports reusing a bound parameter by its ordinal position, which is required here since `?` (the `before` value) is referenced twice in the same `WHERE` clause and `.bind()` only supplies it once positionally otherwise.

Also extract `getRequests`'s existing inline column list into the new `SELECT_COLUMNS` constant, so both functions share it (this doesn't change `getRequests`'s behavior — pure de-duplication, since `getRequests` used the identical hand-written list before this change).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- requests.repo.test.ts`
Expected: PASS, all tests green (existing 3 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add backend/src/requests.repo.ts backend/src/requests.repo.test.ts
git commit -m "feat(backend): add cursor-paginated request fetch and single-request lookup"
```

---

### Task 2: Streaming body-size enforcement in `hook.ts`

**Files:**
- Modify: `backend/src/routes/hook.ts`
- Test: `backend/src/routes/hook.test.ts`

**Interfaces:**
- Consumes: existing `MAX_BODY_BYTES` constant (unchanged value, 10MB).
- Produces: a private `readBodyWithLimit(request: Request, maxBytes: number): Promise<string | null>` helper and a private `BodyTooLargeError` class, both used by both existing route handlers in this file. Nothing outside `hook.ts` consumes these.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/routes/hook.test.ts`:

```typescript
// backend/src/routes/hook.test.ts — add to the existing describe block
it('rejects an oversized body sent without a Content-Length header (chunked transfer)', async () => {
  const chunkBytes = 1024 * 1024 // 1MB
  const chunkCount = 11 // 11MB total, over the 10MB MAX_BODY_BYTES cap
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < chunkCount; i++) {
        controller.enqueue(new Uint8Array(chunkBytes))
      }
      controller.close()
    },
  })

  const request = new Request(`http://hook-test/hook/${listenerId}`, {
    method: 'POST',
    body: stream,
  })
  expect(request.headers.get('content-length')).toBeNull()

  const response = await app.request(request, {}, env)
  expect(response.status).toBe(413)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- routes/hook.test.ts`
Expected: FAIL — currently no `Content-Length` header means the existing check is skipped entirely, so the request is accepted (status 200), not rejected with 413.

If instead the test fails with a *different* error (e.g. a TypeScript error about `body`/streaming `Request` construction, or a runtime error about duplex mode), that's an environment quirk to resolve before continuing — try adding `duplex: 'half'` to the `Request` init as a cast (`{ method: 'POST', body: stream, duplex: 'half' } as RequestInit & { duplex: string }`) if the workerd runtime used by `@cloudflare/vitest-pool-workers` requires it for streaming bodies. Confirm which error you get before working around it — don't add `duplex` speculatively if the test already fails with the expected 200-instead-of-413 result.

- [ ] **Step 3: Write the implementation**

In `backend/src/routes/hook.ts`, add after the existing helper functions (after `parseQuery`, before `export const hookRoute`):

```typescript
class BodyTooLargeError extends Error {}

async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return null

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new BodyTooLargeError()
    }
    chunks.push(value)
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}
```

Then, in **both** route handlers (`/hook/:id` and `/hook/:projectId/:identifier`), replace:

```typescript
  const body = c.req.raw.body ? await c.req.raw.clone().text() : null
```

with:

```typescript
  let body: string | null
  try {
    body = await readBodyWithLimit(c.req.raw, MAX_BODY_BYTES)
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return c.json({ error: 'payload too large' }, 413)
    }
    throw err
  }
```

The existing `Content-Length`-based early check above this line (`if (contentLength && Number(contentLength) > MAX_BODY_BYTES) { ... }`) stays as-is — it's now a fast-path that rejects obviously-oversized requests before reading anything, no longer the only enforcement.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- routes/hook.test.ts`
Expected: PASS, all tests green, including the new one.

- [ ] **Step 5: Run the full backend test suite to check for regressions**

Run: `npm test`
Expected: all tests pass (this change touches both hook routes but preserves existing behavior for every request under the size cap — no other test should be affected).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/hook.ts backend/src/routes/hook.test.ts
git commit -m "fix(backend): enforce body-size cap on capture regardless of Content-Length"
```

---

### Task 3: `requestListSerializer.ts` — shared truncation + page-param parsing

**Files:**
- Create: `backend/src/routes/requestListSerializer.ts`
- Create: `backend/src/routes/requestListSerializer.test.ts`

**Interfaces:**
- Consumes: `RequestRecord` from `../requests.repo` (Task 1, unchanged shape).
- Produces: `const BODY_PREVIEW_BYTES = 256 * 1024`; `interface RequestListItem { id: number; method: string; headers: Record<string, string>; queryParams: Record<string, string | string[]>; body: string | null; bodyTruncated: boolean; bodySize: number; contentType: string | null; sourceIp: string | null; receivedAt: string }`; `serializeRequestListItem(row: RequestRecord): RequestListItem`; `parsePageParams(rawLimit: string | undefined, rawBefore: string | undefined): { limit: number; before?: number }`. Tasks 4 and 5 import all four names.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/routes/requestListSerializer.test.ts
import { describe, it, expect } from 'vitest'
import { serializeRequestListItem, parsePageParams, BODY_PREVIEW_BYTES } from './requestListSerializer'
import type { RequestRecord } from '../requests.repo'

function makeRow(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 1,
    listenerId: 'listener-1',
    method: 'POST',
    headers: '{"x-test":"1"}',
    queryParams: '{"a":"b"}',
    body: 'hello',
    contentType: 'text/plain',
    sourceIp: '127.0.0.1',
    receivedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('serializeRequestListItem', () => {
  it('parses headers/queryParams and passes a small body through untruncated', () => {
    const item = serializeRequestListItem(makeRow())
    expect(item.headers).toEqual({ 'x-test': '1' })
    expect(item.queryParams).toEqual({ a: 'b' })
    expect(item.body).toBe('hello')
    expect(item.bodyTruncated).toBe(false)
    expect(item.bodySize).toBe(5)
  })

  it('passes a body of exactly BODY_PREVIEW_BYTES through untruncated', () => {
    const body = 'a'.repeat(BODY_PREVIEW_BYTES)
    const item = serializeRequestListItem(makeRow({ body }))
    expect(item.bodyTruncated).toBe(false)
    expect(item.body).toBe(body)
    expect(item.bodySize).toBe(BODY_PREVIEW_BYTES)
  })

  it('truncates a body one byte over BODY_PREVIEW_BYTES', () => {
    const body = 'a'.repeat(BODY_PREVIEW_BYTES + 1)
    const item = serializeRequestListItem(makeRow({ body }))
    expect(item.bodyTruncated).toBe(true)
    expect(item.body).toHaveLength(BODY_PREVIEW_BYTES)
    expect(item.bodySize).toBe(BODY_PREVIEW_BYTES + 1)
  })

  it('handles a null body without truncating', () => {
    const item = serializeRequestListItem(makeRow({ body: null }))
    expect(item.body).toBeNull()
    expect(item.bodyTruncated).toBe(false)
    expect(item.bodySize).toBe(0)
  })
})

describe('parsePageParams', () => {
  it('defaults to limit 20 with no before when both are undefined', () => {
    expect(parsePageParams(undefined, undefined)).toEqual({ limit: 20 })
  })

  it('parses valid limit and before', () => {
    expect(parsePageParams('5', '42')).toEqual({ limit: 5, before: 42 })
  })

  it('clamps a limit above 100 down to 100', () => {
    expect(parsePageParams('500', undefined)).toEqual({ limit: 100 })
  })

  it('falls back to the default limit for invalid input', () => {
    expect(parsePageParams('not-a-number', undefined)).toEqual({ limit: 20 })
    expect(parsePageParams('-5', undefined)).toEqual({ limit: 20 })
    expect(parsePageParams('0', undefined)).toEqual({ limit: 20 })
  })

  it('ignores an invalid before value (treated as first page)', () => {
    expect(parsePageParams('20', 'not-a-number')).toEqual({ limit: 20 })
    expect(parsePageParams('20', '-1')).toEqual({ limit: 20 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- routes/requestListSerializer.test.ts`
Expected: FAIL — `Cannot find module './requestListSerializer'`.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/routes/requestListSerializer.ts
import type { RequestRecord } from '../requests.repo'

export const BODY_PREVIEW_BYTES = 256 * 1024
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export interface RequestListItem {
  id: number
  method: string
  headers: Record<string, string>
  queryParams: Record<string, string | string[]>
  body: string | null
  bodyTruncated: boolean
  bodySize: number
  contentType: string | null
  sourceIp: string | null
  receivedAt: string
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function truncateToBytes(value: string, maxBytes: number): string {
  // Slicing at a byte boundary can cut a multi-byte UTF-8 character —
  // acceptable here since this is a truncated preview, not meant to
  // round-trip as valid text/JSON.
  const bytes = new TextEncoder().encode(value)
  return new TextDecoder().decode(bytes.slice(0, maxBytes))
}

export function serializeRequestListItem(row: RequestRecord): RequestListItem {
  const bodySize = row.body === null ? 0 : byteLength(row.body)
  const truncated = row.body !== null && bodySize > BODY_PREVIEW_BYTES

  return {
    id: row.id,
    method: row.method,
    headers: JSON.parse(row.headers),
    queryParams: JSON.parse(row.queryParams),
    body: truncated ? truncateToBytes(row.body as string, BODY_PREVIEW_BYTES) : row.body,
    bodyTruncated: truncated,
    bodySize,
    contentType: row.contentType,
    sourceIp: row.sourceIp,
    receivedAt: row.receivedAt,
  }
}

export function parsePageParams(
  rawLimit: string | undefined,
  rawBefore: string | undefined
): { limit: number; before?: number } {
  const parsedLimit = Number(rawLimit)
  const limit =
    Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, MAX_LIMIT) : DEFAULT_LIMIT

  const parsedBefore = Number(rawBefore)
  const before = Number.isInteger(parsedBefore) && parsedBefore > 0 ? parsedBefore : undefined

  return before === undefined ? { limit } : { limit, before }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- routes/requestListSerializer.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/requestListSerializer.ts backend/src/routes/requestListSerializer.test.ts
git commit -m "feat(backend): add shared request-list serialization with body truncation"
```

---

### Task 4: Paginate `/api/listeners/:id/requests`, add its body-detail endpoint

**Files:**
- Modify: `backend/src/routes/listeners.ts`
- Create: `backend/src/routes/listeners.requests.test.ts` (no existing test currently asserts on this endpoint's response shape — `listeners.ownership.test.ts` only checks 404-for-wrong-owner isolation, confirmed by reading it during planning)

**Interfaces:**
- Consumes: `getRequestsPage`, `getRequestById` from `../requests.repo` (Task 1); `serializeRequestListItem`, `parsePageParams` from `./requestListSerializer` (Task 3); `authCookieHeader` from `../test-helpers/auth` (existing, used by every other route test in this repo post-email-gate).
- Produces: `GET /api/listeners/:id/requests` now returns `{ requests: [...], nextCursor }` where each item is `{ ...RequestListItem, listenerId: string }`; new `GET /api/listeners/:id/requests/:requestId/body` returns `{ body: string | null }` or 404. Task 7 (frontend `api.ts`) consumes both shapes.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/routes/listeners.requests.test.ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('GET /api/listeners/:id/requests pagination', () => {
  const ownerEmail = 'owner@nice.com'

  async function createListenerWithRequests(count: number) {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listener = (await created.json()) as { id: string }

    for (let i = 0; i < count; i++) {
      await app.request(
        `/hook/${listener.id}`,
        { method: 'POST', body: `payload-${i}`, headers: { 'content-type': 'text/plain' } },
        env
      )
    }
    return listener.id
  }

  it('defaults to the 20 most recent requests with a nextCursor when more exist', async () => {
    const listenerId = await createListenerWithRequests(25)
    const response = await app.request(
      `/api/listeners/${listenerId}/requests`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { requests: { id: number }[]; nextCursor: number | null }
    expect(body.requests).toHaveLength(20)
    expect(body.nextCursor).not.toBeNull()
  })

  it('pages through with `before` and reaches nextCursor null', async () => {
    const listenerId = await createListenerWithRequests(25)
    const headers = await authCookieHeader(env, ownerEmail)
    const first = await app.request(`/api/listeners/${listenerId}/requests?limit=20`, { headers }, env)
    const firstBody = (await first.json()) as { requests: { id: number }[]; nextCursor: number | null }

    const second = await app.request(
      `/api/listeners/${listenerId}/requests?limit=20&before=${firstBody.nextCursor}`,
      { headers },
      env
    )
    const secondBody = (await second.json()) as { requests: { id: number }[]; nextCursor: number | null }
    expect(secondBody.requests).toHaveLength(5)
    expect(secondBody.nextCursor).toBeNull()
  })

  it('each item includes listenerId and truncation fields', async () => {
    const listenerId = await createListenerWithRequests(1)
    const response = await app.request(
      `/api/listeners/${listenerId}/requests`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const body = (await response.json()) as {
      requests: { listenerId: string; bodyTruncated: boolean; bodySize: number }[]
    }
    expect(body.requests[0].listenerId).toBe(listenerId)
    expect(body.requests[0].bodyTruncated).toBe(false)
    expect(body.requests[0].bodySize).toBeGreaterThan(0)
  })
})

describe('GET /api/listeners/:id/requests/:requestId/body', () => {
  const ownerEmail = 'owner@nice.com'
  const otherEmail = 'other@nice.com'

  it('returns the full body for a known request', async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listener = (await created.json()) as { id: string }
    await app.request(`/hook/${listener.id}`, { method: 'POST', body: 'the-full-body' }, env)

    const headers = await authCookieHeader(env, ownerEmail)
    const list = await app.request(`/api/listeners/${listener.id}/requests`, { headers }, env)
    const listBody = (await list.json()) as { requests: { id: number }[] }
    const requestId = listBody.requests[0].id

    const detail = await app.request(
      `/api/listeners/${listener.id}/requests/${requestId}/body`,
      { headers },
      env
    )
    expect(detail.status).toBe(200)
    expect(await detail.json()).toEqual({ body: 'the-full-body' })
  })

  it('returns 404 for an unknown listener', async () => {
    const response = await app.request(
      `/api/listeners/${crypto.randomUUID()}/requests/1/body`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for a requestId that does not belong to the listener', async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listener = (await created.json()) as { id: string }
    const response = await app.request(
      `/api/listeners/${listener.id}/requests/999999/body`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for a different owner (ownership isolation, matching the list endpoint)', async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listener = (await created.json()) as { id: string }
    await app.request(`/hook/${listener.id}`, { method: 'POST', body: 'secret' }, env)
    const list = await app.request(
      `/api/listeners/${listener.id}/requests`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const requestId = ((await list.json()) as { requests: { id: number }[] }).requests[0].id

    const response = await app.request(
      `/api/listeners/${listener.id}/requests/${requestId}/body`,
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- routes/listeners.requests.test.ts`
Expected: FAIL — `Cannot find module` is not the failure here (this is a new file, but it exercises existing-shaped routes); instead expect assertion failures: current response is a bare array, not `{ requests, nextCursor }`; the body-detail route doesn't exist (404 from Hono's router for every case, including the ones asserting 200).

- [ ] **Step 3: Write the implementation**

In `backend/src/routes/listeners.ts`, update the import block:

```typescript
import { getRequestsPage, getRequestById } from '../requests.repo'
import { serializeRequestListItem, parsePageParams } from './requestListSerializer'
```

(remove the old `import { getRequests } from '../requests.repo'`)

Replace the existing `/api/listeners/:id/requests` handler:

```typescript
listenerRoutes.get('/api/listeners/:id/requests', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  const { limit, before } = parsePageParams(c.req.query('limit'), c.req.query('before'))
  const { requests, nextCursor } = await getRequestsPage(c.env.DB, listener.id, { limit, before })
  return c.json({
    requests: requests.map((r) => ({ ...serializeRequestListItem(r), listenerId: listener.id })),
    nextCursor,
  })
})

listenerRoutes.get('/api/listeners/:id/requests/:requestId/body', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('email'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  const requestId = Number(c.req.param('requestId'))
  const record = Number.isInteger(requestId)
    ? await getRequestById(c.env.DB, listener.id, requestId)
    : undefined
  if (!record) {
    return c.json({ error: 'request not found' }, 404)
  }
  return c.json({ body: record.body })
})
```

Note: `getListenerForOwner`'s second parameter is the caller's authenticated email (`c.get('email')`), set by the app-level auth middleware in `backend/src/app.ts` from the signed `wl_email_session` cookie — this repo already shipped an email-based access-gate feature; owner identity is no longer the older anonymous `sessionId`. Every other handler in this file already uses `c.get('email')` the same way — match the existing pattern, don't reintroduce `sessionId`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- routes/listeners.requests.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full backend test suite to check for regressions**

Run: `npm test`
Expected: all tests pass (baseline is 256/257 — one known, pre-existing, unrelated failure in `app.session.test.ts` about `SESSION_COOKIE_DOMAIN` being empty in local dev; see Task 6).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/listeners.ts backend/src/routes/listeners.requests.test.ts
git commit -m "feat(backend): paginate owner listener requests, add full-body detail endpoint"
```

---

### Task 5: Paginate both `shared.ts` list endpoints, add both body-detail endpoints

**Files:**
- Modify: `backend/src/routes/shared.ts`
- Test: run `ls backend/src/routes/shared.*.test.ts` first to find the existing coverage (likely `shared.test.ts` and/or `shared.projects.test.ts` — confirm before editing).

**Interfaces:**
- Consumes: same four functions as Task 4 (`getRequestsPage`, `getRequestById`, `serializeRequestListItem`, `parsePageParams`).
- Produces: `GET /api/shared/:token/requests` and `GET /api/shared/projects/:token/listeners/:listenerId/requests` both return `{ requests: RequestListItem[], nextCursor }` (no `listenerId` field on items here — matches the existing shared-tier shape, which never included `listenerId`); new `GET /api/shared/:token/requests/:requestId/body` and `GET /api/shared/projects/:token/listeners/:listenerId/requests/:requestId/body`, each 404-ing under the same conditions as their list-endpoint sibling. Task 7 (frontend `api.ts`) consumes all four.

Note before starting: `backend/src/routes/shared.ts` has grown since the spec was written — it now also has `POST /api/shared/:token/visit`, `POST /api/shared/projects/:token/visit`, `GET /api/shared-with-me`, and `DELETE /api/shared-with-me/:kind/:token` (part of the shipped email-access-gate feature), and `GET /api/shared/projects/:token` now returns `{ label, listeners: [...] }` instead of a bare array. **Do not replace the whole file** — only touch the two `/requests` handlers and insert the two new `/requests/:requestId/body` handlers; leave everything else in the file untouched. Also: every route in this file (like every non-`/hook/*`, non-`/auth/*` route in the app) now requires a valid `wl_email_session` cookie via app-level middleware — "read-only share access" no longer means unauthenticated, it means "no ownership check, but still requires being logged in as some email." All test requests below use `authCookieHeader(env, someEmail)`, including ones that used to be anonymous.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/routes/shared.test.ts` (which already covers the token-tier `/api/shared/:token/requests`):

```typescript
// backend/src/routes/shared.test.ts — add these two describe blocks
describe('GET /api/shared/:token/requests pagination', () => {
  it('paginates and includes truncation fields, no listenerId key', async () => {
    const ownerEmail = 'owner@nice.com'
    const viewerEmail = 'viewer@nice.com'
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listener = (await created.json()) as { id: string }
    for (let i = 0; i < 25; i++) {
      await app.request(`/hook/${listener.id}`, { method: 'POST', body: `payload-${i}` }, env)
    }
    const shareResponse = await app.request(
      `/api/listeners/${listener.id}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const { shareToken } = (await shareResponse.json()) as { shareToken: string }

    const first = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    const firstBody = (await first.json()) as {
      requests: (Record<string, unknown> & { bodyTruncated: boolean })[]
      nextCursor: number | null
    }
    expect(firstBody.requests).toHaveLength(20)
    expect(firstBody.nextCursor).not.toBeNull()
    expect(firstBody.requests[0]).not.toHaveProperty('listenerId')
    expect(firstBody.requests[0].bodyTruncated).toBe(false)

    const second = await app.request(
      `/api/shared/${shareToken}/requests?before=${firstBody.nextCursor}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    const secondBody = (await second.json()) as { requests: unknown[]; nextCursor: number | null }
    expect(secondBody.requests).toHaveLength(5)
    expect(secondBody.nextCursor).toBeNull()
  })
})

describe('GET /api/shared/:token/requests/:requestId/body', () => {
  it('returns the full body for a known request', async () => {
    const ownerEmail = 'owner@nice.com'
    const viewerEmail = 'viewer@nice.com'
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listener = (await created.json()) as { id: string }
    await app.request(`/hook/${listener.id}`, { method: 'POST', body: 'shared-full-body' }, env)
    const shareResponse = await app.request(
      `/api/listeners/${listener.id}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const { shareToken } = (await shareResponse.json()) as { shareToken: string }

    const list = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    const listBody = (await list.json()) as { requests: { id: number }[] }
    const requestId = listBody.requests[0].id

    const detail = await app.request(
      `/api/shared/${shareToken}/requests/${requestId}/body`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(detail.status).toBe(200)
    expect(await detail.json()).toEqual({ body: 'shared-full-body' })
  })

  it('returns 404 for an unknown share token', async () => {
    const response = await app.request(
      '/api/shared/does-not-exist/requests/1/body',
      { headers: await authCookieHeader(env, 'viewer@nice.com') },
      env
    )
    expect(response.status).toBe(404)
  })
})
```

Then fix the two existing tests in this same file that assume the old bare-array shape:

In `'returns captured requests for a valid share token'`, change:
```typescript
    const [captured] = (await response.json()) as { body: string; method: string }[]
```
to:
```typescript
    const { requests: [captured] } = (await response.json()) as { requests: { body: string; method: string }[] }
```

In `'exposes exactly the expected fields, nothing more'`, change:
```typescript
    const [captured] = (await response.json()) as Record<string, unknown>[]
    expect(Object.keys(captured).sort()).toEqual(
      ['body', 'contentType', 'headers', 'id', 'method', 'queryParams', 'receivedAt', 'sourceIp'].sort()
    )
```
to:
```typescript
    const { requests: [captured] } = (await response.json()) as { requests: Record<string, unknown>[] }
    expect(Object.keys(captured).sort()).toEqual(
      ['body', 'bodySize', 'bodyTruncated', 'contentType', 'headers', 'id', 'method', 'queryParams', 'receivedAt', 'sourceIp'].sort()
    )
```

Now add the project-listener share tier's tests to `backend/src/routes/shared.projects.test.ts`, mirroring the same two describe blocks against `GET /api/shared/projects/:token/listeners/:listenerId/requests` and its new `/body` sibling — read that file's existing `beforeEach`/setup (it already builds a project, a create-and-send listener, and a project share token via `authCookieHeader`-authenticated requests) and reuse that exact setup rather than re-deriving it. Then fix the one existing test there that assumes the old shape — in `'returns captured requests for a child listener'`, change:
```typescript
    const [captured] = (await response.json()) as { body: string; method: string }[]
```
to:
```typescript
    const { requests: [captured] } = (await response.json()) as { requests: { body: string; method: string }[] }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- routes/shared.test.ts routes/shared.projects.test.ts`
Expected: FAIL — bare-array responses (existing tests break on the shape change), new tests fail because the detail routes don't exist yet (404 from Hono's router).

- [ ] **Step 3: Write the implementation**

In `backend/src/routes/shared.ts`, change the import line:
```typescript
import { getRequests } from '../requests.repo'
```
to:
```typescript
import { getRequestsPage, getRequestById } from '../requests.repo'
```
and add, alongside the other route-local imports:
```typescript
import { serializeRequestListItem, parsePageParams } from './requestListSerializer'
```

Replace the existing `/api/shared/:token/requests` handler body:
```typescript
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
with:
```typescript
sharedRoutes.get('/api/shared/:token/requests', async (c) => {
  const listener = await getListenerByShareToken(c.env.DB, c.req.param('token'))
  if (!listener) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const { limit, before } = parsePageParams(c.req.query('limit'), c.req.query('before'))
  const { requests, nextCursor } = await getRequestsPage(c.env.DB, listener.id, { limit, before })
  return c.json({ requests: requests.map(serializeRequestListItem), nextCursor })
})

sharedRoutes.get('/api/shared/:token/requests/:requestId/body', async (c) => {
  const listener = await getListenerByShareToken(c.env.DB, c.req.param('token'))
  if (!listener) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const requestId = Number(c.req.param('requestId'))
  const record = Number.isInteger(requestId)
    ? await getRequestById(c.env.DB, listener.id, requestId)
    : undefined
  if (!record) {
    return c.json({ error: 'request not found' }, 404)
  }
  return c.json({ body: record.body })
})
```

Leave the `/api/shared/projects/:token` handler (the `{ label, listeners }` one) exactly as it is. Then replace the existing `/api/shared/projects/:token/listeners/:listenerId/requests` handler body:
```typescript
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
with:
```typescript
sharedRoutes.get('/api/shared/projects/:token/listeners/:listenerId/requests', async (c) => {
  const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
  if (!project) {
    return c.json({ error: 'share link not found' }, 404)
  }
  const listener = await getListener(c.env.DB, c.req.param('listenerId'))
  if (!listener || listener.projectId !== project.id) {
    return c.json({ error: 'listener not found' }, 404)
  }
  const { limit, before } = parsePageParams(c.req.query('limit'), c.req.query('before'))
  const { requests, nextCursor } = await getRequestsPage(c.env.DB, listener.id, { limit, before })
  return c.json({ requests: requests.map(serializeRequestListItem), nextCursor })
})

sharedRoutes.get(
  '/api/shared/projects/:token/listeners/:listenerId/requests/:requestId/body',
  async (c) => {
    const project = await getProjectByShareToken(c.env.DB, c.req.param('token'))
    if (!project) {
      return c.json({ error: 'share link not found' }, 404)
    }
    const listener = await getListener(c.env.DB, c.req.param('listenerId'))
    if (!listener || listener.projectId !== project.id) {
      return c.json({ error: 'listener not found' }, 404)
    }
    const requestId = Number(c.req.param('requestId'))
    const record = Number.isInteger(requestId)
      ? await getRequestById(c.env.DB, listener.id, requestId)
      : undefined
    if (!record) {
      return c.json({ error: 'request not found' }, 404)
    }
    return c.json({ body: record.body })
  }
)
```

Leave every other route in the file (`/visit`, `/api/shared-with-me`, `/api/shared-with-me/:kind/:token`) untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- routes/shared.test.ts routes/shared.projects.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full backend test suite to check for regressions**

Run: `npm test`
Expected: all tests pass (same known pre-existing `app.session.test.ts` failure noted in Task 4 — unrelated).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/shared.ts backend/src/routes/shared.test.ts backend/src/routes/shared.projects.test.ts
git commit -m "feat(backend): paginate shared-tier requests, add full-body detail endpoints"
```

---

### Task 6: Backend regression checkpoint

**Files:**
- None (verification-only task).

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: nothing new — confirms the backend half of this plan is solid before frontend work starts.

- [ ] **Step 1: Run the full backend test suite**

Run (from `backend/`): `npm test`
Expected: 256/257 passing — the one known failure is `app.session.test.ts`'s `SESSION_COOKIE_DOMAIN` assertion, pre-existing and unrelated to this plan (it fails because local `.dev.vars` deliberately leaves `SESSION_COOKIE_DOMAIN` empty for browser-based local dev, per `CLAUDE.md`). Note the total test count — it's needed for Task 13's `STATUS.md` update.

- [ ] **Step 2: Confirm no stray references to the old bare-array response shape**

Run: `grep -rn "getRequests(c.env.DB" backend/src/routes/listeners.ts backend/src/routes/shared.ts`
Expected: no output — both files should only call `getRequestsPage`/`getRequestById` now, not `getRequests`.

- [ ] **Step 3: Commit (only if Step 2 required a fix; otherwise skip — nothing to commit)**

---

### Task 7: `frontend/src/api.ts` — paginated types and detail-fetch functions

**Files:**
- Modify: `frontend/src/api.ts`

**Interfaces:**
- Consumes: nothing new from other frontend files.
- Produces: updated `RequestDetail` (adds `bodyTruncated: boolean`, `bodySize: number`); `interface RequestsPage<T> { requests: T[]; nextCursor: number | null }`; `interface PageParams { limit?: number; before?: number }`; `getRequests(id: string, page?: PageParams): Promise<RequestsPage<CapturedRequest>>` (signature change — previously returned a bare array); `getSharedRequests(token: string, page?: PageParams): Promise<RequestsPage<RequestDetail>>` (signature change); `getSharedProjectListenerRequests(token: string, listenerId: string, page?: PageParams): Promise<RequestsPage<RequestDetail>>` (signature change); `getRequestBody(listenerId: string, requestId: number): Promise<{ body: string | null }>`; `getSharedRequestBody(token: string, requestId: number): Promise<{ body: string | null }>`; `getSharedProjectListenerRequestBody(token: string, listenerId: string, requestId: number): Promise<{ body: string | null }>`. Tasks 8-12 consume all of these.

- [ ] **Step 1: Update the `RequestDetail` interface**

In `frontend/src/api.ts`, change:

```typescript
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
```

to:

```typescript
export interface RequestDetail {
  id: number
  method: string
  headers: Record<string, string>
  queryParams: Record<string, string | string[]>
  body: string | null
  bodyTruncated: boolean
  bodySize: number
  contentType: string | null
  sourceIp: string | null
  receivedAt: string
}
```

- [ ] **Step 2: Add pagination types and a shared query-string builder**

Add near the top of `frontend/src/api.ts`, after the existing interfaces:

```typescript
export interface RequestsPage<T> {
  requests: T[]
  nextCursor: number | null
}

export interface PageParams {
  limit?: number
  before?: number
}

function pageQuery({ limit, before }: PageParams): string {
  const params = new URLSearchParams()
  if (limit !== undefined) params.set('limit', String(limit))
  if (before !== undefined) params.set('before', String(before))
  const query = params.toString()
  return query ? `?${query}` : ''
}
```

- [ ] **Step 3: Update `getRequests`, `getSharedRequests`, `getSharedProjectListenerRequests`**

Change:

```typescript
export function getRequests(id: string): Promise<CapturedRequest[]> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/requests`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<CapturedRequest[]>(r)
  )
}
```

to:

```typescript
export function getRequests(id: string, page: PageParams = {}): Promise<RequestsPage<CapturedRequest>> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/requests${pageQuery(page)}`, {
    credentials: 'include',
  }).then((r) => parseJsonOrThrow<RequestsPage<CapturedRequest>>(r))
}
```

Change:

```typescript
export function getSharedRequests(token: string): Promise<RequestDetail[]> {
  return fetch(`${API_BASE_URL}/api/shared/${token}/requests`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<RequestDetail[]>(r)
  )
}
```

to:

```typescript
export function getSharedRequests(token: string, page: PageParams = {}): Promise<RequestsPage<RequestDetail>> {
  return fetch(`${API_BASE_URL}/api/shared/${token}/requests${pageQuery(page)}`, {
    credentials: 'include',
  }).then((r) => parseJsonOrThrow<RequestsPage<RequestDetail>>(r))
}
```

Change:

```typescript
export function getSharedProjectListenerRequests(token: string, listenerId: string): Promise<RequestDetail[]> {
  return fetch(`${API_BASE_URL}/api/shared/projects/${token}/listeners/${listenerId}/requests`, {
    credentials: 'include',
  }).then((r) => parseJsonOrThrow<RequestDetail[]>(r))
}
```

to:

```typescript
export function getSharedProjectListenerRequests(
  token: string,
  listenerId: string,
  page: PageParams = {}
): Promise<RequestsPage<RequestDetail>> {
  return fetch(
    `${API_BASE_URL}/api/shared/projects/${token}/listeners/${listenerId}/requests${pageQuery(page)}`,
    { credentials: 'include' }
  ).then((r) => parseJsonOrThrow<RequestsPage<RequestDetail>>(r))
}
```

- [ ] **Step 4: Add the three body-detail functions**

Add at the end of `frontend/src/api.ts`:

```typescript
export function getRequestBody(listenerId: string, requestId: number): Promise<{ body: string | null }> {
  return fetch(`${API_BASE_URL}/api/listeners/${listenerId}/requests/${requestId}/body`, {
    credentials: 'include',
  }).then((r) => parseJsonOrThrow<{ body: string | null }>(r))
}

export function getSharedRequestBody(token: string, requestId: number): Promise<{ body: string | null }> {
  return fetch(`${API_BASE_URL}/api/shared/${token}/requests/${requestId}/body`, {
    credentials: 'include',
  }).then((r) => parseJsonOrThrow<{ body: string | null }>(r))
}

export function getSharedProjectListenerRequestBody(
  token: string,
  listenerId: string,
  requestId: number
): Promise<{ body: string | null }> {
  return fetch(
    `${API_BASE_URL}/api/shared/projects/${token}/listeners/${listenerId}/requests/${requestId}/body`,
    { credentials: 'include' }
  ).then((r) => parseJsonOrThrow<{ body: string | null }>(r))
}
```

- [ ] **Step 5: Run the frontend build**

Run (from `frontend/`): `npm run build`
Expected: FAILS — `Listener.tsx`, `SharedListener.tsx`, `SharedProjectListener.tsx` still call `getRequests`/`getSharedRequests`/`getSharedProjectListenerRequests` expecting a bare array and assign it directly to `setRequests`, which now receives a `RequestsPage<T>` object instead. This is expected; Tasks 10-12 fix it. Confirm the *only* errors are in those three page files (not `api.ts` itself), then proceed.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(frontend): paginate request-list API functions, add body-detail fetches"
```

---

### Task 8: `usePaginatedRequests` hook

**Files:**
- Create: `frontend/src/hooks/usePaginatedRequests.ts`

**Interfaces:**
- Consumes: nothing from other new files — a generic hook parameterized entirely by the `fetchPage` function passed in by each caller.
- Produces: `interface UsePaginatedRequestsResult<T> { requests: T[]; hasMore: boolean; loadingMore: boolean; loadMore: () => Promise<void>; refreshFirstPage: () => Promise<T[]> }`; `usePaginatedRequests<T extends { id: number }>(fetchPage: (before?: number) => Promise<{ requests: T[]; nextCursor: number | null }>): UsePaginatedRequestsResult<T>`. Tasks 10, 11, 12 all consume this by this exact name and shape.

- [ ] **Step 1: Write the implementation**

```typescript
// frontend/src/hooks/usePaginatedRequests.ts
import { useCallback, useState } from 'react'

interface PageResult<T> {
  requests: T[]
  nextCursor: number | null
}

export interface UsePaginatedRequestsResult<T> {
  requests: T[]
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => Promise<void>
  refreshFirstPage: () => Promise<T[]>
}

function mergeById<T extends { id: number }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) {
    byId.set(item.id, item)
  }
  return [...byId.values()].sort((a, b) => b.id - a.id)
}

export function usePaginatedRequests<T extends { id: number }>(
  fetchPage: (before?: number) => Promise<PageResult<T>>
): UsePaginatedRequestsResult<T> {
  const [requests, setRequests] = useState<T[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [hasLoadedFirstPage, setHasLoadedFirstPage] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const refreshFirstPage = useCallback(async (): Promise<T[]> => {
    const page = await fetchPage(undefined)
    setRequests((current) => mergeById(current, page.requests))
    // A poll's first-page fetch must not clobber a cursor that's already
    // advanced past page 1 via loadMore — only the very first successful
    // load establishes nextCursor from this call.
    setNextCursor((current) => (hasLoadedFirstPage ? current : page.nextCursor))
    setHasLoadedFirstPage(true)
    return page.requests
  }, [fetchPage, hasLoadedFirstPage])

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await fetchPage(nextCursor)
      setRequests((current) => mergeById(current, page.requests))
      setNextCursor(page.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }, [fetchPage, nextCursor, loadingMore])

  return { requests, hasMore: nextCursor !== null, loadingMore, loadMore, refreshFirstPage }
}
```

Note for the callers (Tasks 10-12): `fetchPage` must be wrapped in `useCallback` keyed on whatever identifies the listener/share token (e.g. `id`, `token`), otherwise `refreshFirstPage`/`loadMore` are recreated every render and any `useEffect` depending on them will re-run in a loop.

- [ ] **Step 2: Run the frontend build**

Run (from `frontend/`): `npm run build`
Expected: same pre-existing failures as Task 7 Step 5 (this new file isn't imported by anything yet, so it introduces no new errors). Confirm no *new* errors appear beyond the three page files.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/usePaginatedRequests.ts
git commit -m "feat(frontend): add usePaginatedRequests hook for cursor-based request pagination"
```

---

### Task 9: `RequestRow.tsx` — "view full payload" affordance for truncated bodies

**Files:**
- Modify: `frontend/src/components/RequestRow.tsx`

**Interfaces:**
- Consumes: `RequestDetail.bodyTruncated`/`bodySize` (Task 7).
- Produces: `RequestRowProps` gains an optional `onLoadFullBody?: (requestId: number) => Promise<string | null>`. Tasks 10-12 pass this prop, each bound to their own tier's body-detail API function.

- [ ] **Step 1: Write the implementation**

In `frontend/src/components/RequestRow.tsx`, update the props interface:

```typescript
interface RequestRowProps {
  request: RequestDetail
  previousRequest?: RequestDetail
  diffOnly?: boolean
  onLoadFullBody?: (requestId: number) => Promise<string | null>
}
```

Update the function signature and add local state, right after the existing `useState` calls:

```typescript
export function RequestRow({ request, previousRequest, diffOnly = false, onLoadFullBody }: RequestRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [copied, setCopied] = useState(false)
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set())
  const [fullBody, setFullBody] = useState<string | null>(null)
  const [loadingFullBody, setLoadingFullBody] = useState(false)
  const effectiveBody = fullBody ?? request.body
```

Update `detailObject` to use `effectiveBody` instead of `request.body`:

```typescript
  const detailObject = {
    headers: request.headers,
    queryParams: request.queryParams,
    sourceIp: request.sourceIp,
    body: safeParse(effectiveBody),
  }
```

Add a handler, near `handleCopy`:

```typescript
  async function handleLoadFullBody() {
    if (!onLoadFullBody) return
    setLoadingFullBody(true)
    try {
      const body = await onLoadFullBody(request.id)
      setFullBody(body)
    } catch {
      // silently ignored — no error state plumbed through for this per-row action, matching handleCopy's pattern
    } finally {
      setLoadingFullBody(false)
    }
  }
```

Add the affordance in the render, inside the `{(diffOnly || expanded) && (...)}` block, right after its opening `<div>` (before the collapse/expand/diff/copy button row):

```typescript
          {request.bodyTruncated && !fullBody && (
            <div className="flex items-center gap-2 px-4 pt-2 text-xs text-amber-700 dark:text-amber-400">
              <span>Payload too large to preview in full ({Math.round(request.bodySize / 1024)} KB).</span>
              <button
                onClick={handleLoadFullBody}
                disabled={loadingFullBody}
                className="underline underline-offset-2 disabled:opacity-50"
              >
                {loadingFullBody ? 'Loading…' : 'View full payload'}
              </button>
            </div>
          )}
```

- [ ] **Step 2: Run the frontend build**

Run (from `frontend/`): `npm run build`
Expected: same pre-existing failures as Task 8 Step 2 (this file's own change introduces no new errors, since `onLoadFullBody` is optional and every existing call site still compiles without passing it). Confirm no new errors beyond the three page files.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/RequestRow.tsx
git commit -m "feat(frontend): add view-full-payload affordance for truncated request bodies"
```

---

### Task 10: Wire `Listener.tsx` to pagination, infinite scroll, and full-body fetch

**Files:**
- Modify: `frontend/src/pages/Listener.tsx`

**Interfaces:**
- Consumes: `getRequests`, `getRequestBody` from `../api` (Task 7); `usePaginatedRequests` from `../hooks/usePaginatedRequests` (Task 8); `onLoadFullBody` prop on `RequestRow` (Task 9).
- Produces: nothing new consumed elsewhere — this is a leaf page component.

- [ ] **Step 1: Update imports**

Change:

```typescript
import {
  ApiError,
  type CapturedRequest,
  type Listener as ListenerModel,
  deleteListener,
  getListener,
  getOrCreateShareLink,
  getRequests,
  removeSlug,
  revokeShareLink,
  rotateWebhookToken,
  setLabel,
  setSlug,
} from '../api'
```

to:

```typescript
import {
  ApiError,
  type CapturedRequest,
  type Listener as ListenerModel,
  deleteListener,
  getListener,
  getOrCreateShareLink,
  getRequestBody,
  getRequests,
  removeSlug,
  revokeShareLink,
  rotateWebhookToken,
  setLabel,
  setSlug,
} from '../api'
import { usePaginatedRequests } from '../hooks/usePaginatedRequests'
```

- [ ] **Step 2: Replace the `requests` state with the pagination hook**

Change:

```typescript
  const [listener, setListener] = useState<ListenerModel | null>(null)
  const [requests, setRequests] = useState<CapturedRequest[]>([])
  const [error, setError] = useState<string | null>(null)
```

to:

```typescript
  const [listener, setListener] = useState<ListenerModel | null>(null)
  const [error, setError] = useState<string | null>(null)
```

Add, right after the existing `useSettings()` line (so `id` is already in scope):

```typescript
  const fetchRequestsPage = useCallback(
    (before?: number) => getRequests(id!, { before, limit: 20 }),
    [id]
  )
  const { requests, hasMore, loadingMore, loadMore, refreshFirstPage } =
    usePaginatedRequests<CapturedRequest>(fetchRequestsPage)
```

- [ ] **Step 3: Update `refresh` to use `refreshFirstPage` instead of `setRequests`**

Change:

```typescript
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!id) return false
    try {
      const [listenerData, requestData] = await Promise.all([getListener(id), getRequests(id)])
      setListener(listenerData)
      setRequests(requestData)
      setError(null)
      consecutiveNotFoundRef.current = 0
      return true
    } catch (err) {
```

to:

```typescript
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!id) return false
    try {
      const [listenerData] = await Promise.all([getListener(id), refreshFirstPage()])
      setListener(listenerData)
      setError(null)
      consecutiveNotFoundRef.current = 0
      return true
    } catch (err) {
```

and update this callback's dependency array from `[id]` to `[id, refreshFirstPage]`.

- [ ] **Step 4: Add the infinite-scroll sentinel**

Add a new ref and effect, near the existing `consecutiveNotFoundRef`:

```typescript
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
      { rootMargin: '200px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loadMore])
```

Render the sentinel right after the `<ul>`/`<div>` that renders `filteredRequests` (inside the same `{listener && requests.length > 0 && (...)}` block, after the `{filteredRequests.length === 0 ? (...) : (<ul>...</ul>)}` block):

```typescript
          {hasMore && (
            <div ref={sentinelRef} className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">
              {loadingMore ? 'Loading more…' : ''}
            </div>
          )}
```

- [ ] **Step 5: Pass `onLoadFullBody` to `RequestRow`**

Change:

```typescript
              {filteredRequests.map((req) => (
                <RequestRow key={req.id} request={req} previousRequest={previousByRequestId.get(req.id)} diffOnly={diffOnly} />
              ))}
```

to:

```typescript
              {filteredRequests.map((req) => (
                <RequestRow
                  key={req.id}
                  request={req}
                  previousRequest={previousByRequestId.get(req.id)}
                  diffOnly={diffOnly}
                  onLoadFullBody={id ? (requestId) => getRequestBody(id, requestId).then((r) => r.body) : undefined}
                />
              ))}
```

- [ ] **Step 6: Run the frontend build**

Run (from `frontend/`): `npm run build`
Expected: still FAILS with the same `SharedListener.tsx`/`SharedProjectListener.tsx` errors as before (those two files aren't fixed yet) — confirm `Listener.tsx` itself now compiles with 0 errors (read the tsc output carefully; every remaining error should be in the other two files, not this one).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Listener.tsx
git commit -m "feat(frontend): wire Listener page to paginated requests and infinite scroll"
```

---

### Task 11: Wire `SharedListener.tsx` to pagination, infinite scroll, and full-body fetch

**Files:**
- Modify: `frontend/src/pages/SharedListener.tsx`

**Interfaces:**
- Consumes: `getSharedRequests`, `getSharedRequestBody` from `../api` (Task 7); `usePaginatedRequests` (Task 8); `onLoadFullBody` prop (Task 9).
- Produces: nothing new consumed elsewhere.

- [ ] **Step 1: Update imports**

Change:

```typescript
import { ApiError, type RequestDetail, getSharedRequests, recordSharedListenerVisit } from '../api'
```

to:

```typescript
import { ApiError, type RequestDetail, getSharedRequestBody, getSharedRequests, recordSharedListenerVisit } from '../api'
import { usePaginatedRequests } from '../hooks/usePaginatedRequests'
```

(the visit-recording import/effect is part of the already-shipped email-access-gate feature — keep it exactly as-is, don't remove or reorder it)

- [ ] **Step 2: Replace `requests`/`loaded` state with the pagination hook**

Change:

```typescript
  const [requests, setRequests] = useState<RequestDetail[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
```

to:

```typescript
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
```

Add, right after the existing `useSettings()` line:

```typescript
  const fetchRequestsPage = useCallback(
    (before?: number) => getSharedRequests(token!, { before, limit: 20 }),
    [token]
  )
  const { requests, hasMore, loadingMore, loadMore, refreshFirstPage } =
    usePaginatedRequests<RequestDetail>(fetchRequestsPage)
```

- [ ] **Step 3: Update `refresh`**

Change:

```typescript
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
```

to:

```typescript
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!token) return false
    try {
      await refreshFirstPage()
      setLoaded(true)
      setError(null)
      consecutiveNotFoundRef.current = 0
      return true
    } catch (err) {
```

and update this callback's dependency array from `[token]` to `[token, refreshFirstPage]`.

- [ ] **Step 4: Add the infinite-scroll sentinel**

Same pattern as Task 10 Step 4 — add `sentinelRef` and the `IntersectionObserver` effect, and render the sentinel after the filtered-requests block:

```typescript
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
      { rootMargin: '200px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loadMore])
```

```typescript
          {hasMore && (
            <div ref={sentinelRef} className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">
              {loadingMore ? 'Loading more…' : ''}
            </div>
          )}
```

- [ ] **Step 5: Pass `onLoadFullBody` to `RequestRow`**

Change:

```typescript
              {filteredRequests.map((req) => (
                <RequestRow key={req.id} request={req} previousRequest={previousByRequestId.get(req.id)} diffOnly={diffOnly} />
              ))}
```

to:

```typescript
              {filteredRequests.map((req) => (
                <RequestRow
                  key={req.id}
                  request={req}
                  previousRequest={previousByRequestId.get(req.id)}
                  diffOnly={diffOnly}
                  onLoadFullBody={
                    token ? (requestId) => getSharedRequestBody(token, requestId).then((r) => r.body) : undefined
                  }
                />
              ))}
```

- [ ] **Step 6: Run the frontend build**

Run (from `frontend/`): `npm run build`
Expected: still FAILS with the same `SharedProjectListener.tsx` errors as before — confirm `SharedListener.tsx` now compiles with 0 errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/SharedListener.tsx
git commit -m "feat(frontend): wire SharedListener page to paginated requests and infinite scroll"
```

---

### Task 12: Wire `SharedProjectListener.tsx` to pagination, infinite scroll, and full-body fetch

**Files:**
- Modify: `frontend/src/pages/SharedProjectListener.tsx`

**Interfaces:**
- Consumes: `getSharedProjectListenerRequests`, `getSharedProjectListenerRequestBody` from `../api` (Task 7); `usePaginatedRequests` (Task 8); `onLoadFullBody` prop (Task 9).
- Produces: nothing new consumed elsewhere.

- [ ] **Step 1: Update imports**

Change:

```typescript
import { ApiError, type RequestDetail, getSharedProjectListenerRequests, recordSharedProjectVisit } from '../api'
```

to:

```typescript
import {
  ApiError,
  type RequestDetail,
  getSharedProjectListenerRequestBody,
  getSharedProjectListenerRequests,
  recordSharedProjectVisit,
} from '../api'
import { usePaginatedRequests } from '../hooks/usePaginatedRequests'
```

(the visit-recording import/effect is part of the already-shipped email-access-gate feature — keep it exactly as-is, don't remove or reorder it)

- [ ] **Step 2: Replace `requests`/`loaded` state with the pagination hook**

Change:

```typescript
  const [requests, setRequests] = useState<RequestDetail[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
```

to:

```typescript
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
```

Add, right after the existing `useSettings()` line:

```typescript
  const fetchRequestsPage = useCallback(
    (before?: number) => getSharedProjectListenerRequests(token!, listenerId!, { before, limit: 20 }),
    [token, listenerId]
  )
  const { requests, hasMore, loadingMore, loadMore, refreshFirstPage } =
    usePaginatedRequests<RequestDetail>(fetchRequestsPage)
```

- [ ] **Step 3: Update `refresh`**

Change:

```typescript
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
```

to:

```typescript
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!token || !listenerId) return false
    try {
      await refreshFirstPage()
      setLoaded(true)
      setError(null)
      consecutiveNotFoundRef.current = 0
      return true
    } catch (err) {
```

and update this callback's dependency array from `[token, listenerId]` to `[token, listenerId, refreshFirstPage]`.

- [ ] **Step 4: Add the infinite-scroll sentinel**

Same pattern as Task 10 Step 4 / Task 11 Step 4.

- [ ] **Step 5: Pass `onLoadFullBody` to `RequestRow`**

Change:

```typescript
              {filteredRequests.map((req) => (
                <RequestRow key={req.id} request={req} previousRequest={previousByRequestId.get(req.id)} diffOnly={diffOnly} />
              ))}
```

to:

```typescript
              {filteredRequests.map((req) => (
                <RequestRow
                  key={req.id}
                  request={req}
                  previousRequest={previousByRequestId.get(req.id)}
                  diffOnly={diffOnly}
                  onLoadFullBody={
                    token && listenerId
                      ? (requestId) => getSharedProjectListenerRequestBody(token, listenerId, requestId).then((r) => r.body)
                      : undefined
                  }
                />
              ))}
```

- [ ] **Step 6: Run the frontend build**

Run (from `frontend/`): `npm run build`
Expected: PASS — 0 TypeScript errors. This resolves the expected failures carried since Task 7.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/SharedProjectListener.tsx
git commit -m "feat(frontend): wire SharedProjectListener page to paginated requests and infinite scroll"
```

---

### Task 13: Full regression pass, STATUS/BACKLOG update

**Files:**
- Modify: `STATUS.md`
- Modify: `BACKLOG.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — documentation task only.

- [ ] **Step 1: Run the full backend test suite**

Run (from `backend/`): `npm test`
Expected: same known 1-failure baseline as Task 6 (`app.session.test.ts`, pre-existing, unrelated). Record the new total test count.

- [ ] **Step 2: Run the frontend build**

Run (from `frontend/`): `npm run build`
Expected: PASS — 0 TypeScript errors.

- [ ] **Step 3: Update `STATUS.md`**

Update the backend test count line:

```markdown
- Backend: `cd backend && npm test` → **<new total>/<new total> passing** (<N> test files).
```

Add a new numbered entry in "Features shipped and live":

```markdown
N. **Paginated request history + body-size hardening** — `/api/listeners/:id/requests`
   and both `/api/shared/.../requests` endpoints now return `{ requests, nextCursor }`
   (20 most-recent rows per page, infinite scroll on the frontend) instead of up to
   200 full rows in one response; bodies over 256KB are truncated in list responses
   with a "view full payload" fetch available per request; `hook.ts`'s 10MB capture
   cap is now enforced via a streaming byte count, closing a bypass via chunked
   transfer-encoding. Fixes a Cloudflare Worker memory-limit issue. Known limitation:
   JSON/HAR export now reflects only what's currently loaded client-side (loaded
   pages, and truncated bodies for oversized payloads) rather than always exporting
   full history with full bodies — see
   `docs/superpowers/specs/2026-09-29-requests-pagination-memory-design.md`.
```

- [ ] **Step 4: Update `BACKLOG.md`**

If `BACKLOG.md` has any entry referencing full-history export or unpaginated request loading as a known issue, remove or update it to reflect this change. Otherwise, no change needed — confirm with `grep -n "export\|pagination\|memory" BACKLOG.md` before deciding.

- [ ] **Step 5: Commit**

```bash
git add STATUS.md BACKLOG.md
git commit -m "docs: mark requests pagination and body-size hardening as shipped"
```

---

## Self-Review Notes

- **Spec coverage:** "Architecture" → Tasks 1, 3-5 (repo + serializer + three route tiers). "Data flow / API contract" (list endpoints, truncation, detail endpoints) → Tasks 1, 3, 4, 5. "Capture-time fix" → Task 2. "Frontend changes" (paginated types, infinite scroll, search-over-loaded, diff boundary, truncated-row affordance) → Tasks 7-12; the diff-boundary item specifically required no new code (documented as a Global Constraint, confirmed by reading `Listener.tsx`'s existing `previousByRequestId` logic during planning). "Error handling" → Tasks 3 (param parsing), 4/5 (404s). "Testing" → each backend task's own test file; frontend verified via `npm run build` per this repo's existing no-frontend-test-runner practice. "Out of scope" (server-side search, `RETENTION_LIMIT` changes, lowering the 10MB cap) → correctly not represented by any task.
- **Placeholder scan:** no TBD/TODO markers. All test file targets (`listeners.requests.test.ts` new; `shared.test.ts`/`shared.projects.test.ts` existing) were confirmed by reading the actual current files during planning (post-main-sync), not guessed — Task 4 and Task 5 name exact files and exact before/after snippets rather than asking the implementer to search.
- **Type consistency:** `RequestsPage<T>` (Task 7) matches `{ requests, nextCursor }` as produced by `getRequestsPage` (Task 1) and reshaped by the three route handlers (Tasks 4, 5). `RequestListItem` (Task 3) fields (`bodyTruncated`, `bodySize`) match `RequestDetail`'s additions (Task 7) exactly. `usePaginatedRequests`'s generic constraint (`T extends { id: number }`) is satisfied by both `CapturedRequest` and `RequestDetail` (both have numeric `id`). `onLoadFullBody`'s signature (`(requestId: number) => Promise<string | null>`) matches what `getRequestBody`/`getSharedRequestBody`/`getSharedProjectListenerRequestBody` resolve to via `.then((r) => r.body)` in Tasks 10-12.
- **Known open items flagged for the implementer:** Task 2's chunked-body test includes a documented contingency (the `duplex` option) in case the workerd test runtime needs it, since this exact code path (constructing a streaming-body `Request` inside `@cloudflare/vitest-pool-workers`) wasn't run during planning to confirm. The pre-existing `app.session.test.ts` failure (1 test, `SESSION_COOKIE_DOMAIN` empty in local `.dev.vars`) is unrelated to this plan and expected to remain failing throughout — noted in Tasks 4-6 so it isn't mistaken for a regression.
