# Requests pagination and body-size hardening — design

Status: approved, ready for implementation plan.
Date: 2026-09-29

## Why

Cloudflare reported memory-limit warnings on the backend Worker (alongside
CPU warnings from an unrelated, already-resolved release issue around
2026-09-22). Investigation found two distinct causes, both in the request
capture/serving path:

1. **Unbounded list responses.** Three route handlers —
   `GET /api/listeners/:id/requests` (`backend/src/routes/listeners.ts`),
   `GET /api/shared/:token/requests`, and
   `GET /api/shared/projects/:token/listeners/:listenerId/requests`
   (both `backend/src/routes/shared.ts`) — all call `getRequests()`
   (`backend/src/requests.repo.ts`), which fetches up to `RETENTION_LIMIT`
   (200) rows per listener **including each row's full stored `body`**, then
   JSON-serializes the entire array in one response. A listener that has
   accumulated even a handful of large payloads spikes Worker memory the
   moment anyone opens that listener's view — worst case, 200 rows near the
   10MB capture cap in a single response.
2. **The capture-time size cap is only enforced via `Content-Length`.** In
   `backend/src/routes/hook.ts`, `MAX_BODY_BYTES` (10MB) is checked against
   the `Content-Length` header before reading the body
   (`hook.ts:45-48`, `:82-85`). A sender using chunked transfer-encoding
   sends no `Content-Length`, so the check is silently skipped and
   `c.req.raw.clone().text()` buffers the entire body into memory
   regardless of size.

This design fixes both. It also folds in a frontend UX change the user
requested independently of the memory problem: loading the most recent ~20
requests with infinite scroll, rather than all 200 at once, because in
practice "I care about what just happened, not history."

## Access model — unchanged

The three-tier access model (owner session, share-token read-only,
fully-open webhook capture) is not affected. Every new/changed endpoint in
this design keeps the same auth check its existing sibling endpoint already
uses for that tier.

## Architecture

Two new pieces in the repo layer, shared across all three list-serving
route handlers so the fix isn't duplicated three times:

- **`getRequestsPage(db, listenerId, { limit, before })`** in
  `requests.repo.ts` — cursor-paginated replacement for `getRequests()` at
  these three call sites. Returns `{ requests, nextCursor }`.
- **`toListItem(row)`** — a serialization helper (co-located with the repo
  layer or in a small shared module under `routes/`) that applies the
  256KB body-truncation rule uniformly.

Each of the three existing route handlers keeps its own auth check (owner
session vs. share token vs. project share token — these genuinely differ
per tier and stay separate) but delegates the "fetch a page and serialize
it" work to the two helpers above.

`getRequests()` (the current full-fetch function) is removed once nothing
calls it — nothing else in the codebase uses it today.

## Data flow / API contract

### List endpoints (paginated)

`GET /api/listeners/:id/requests`, `GET /api/shared/:token/requests`,
`GET /api/shared/projects/:token/listeners/:listenerId/requests` all gain
two query params:

- `limit` — page size, default 20, clamped server-side to a max of 100.
  Invalid (non-numeric, negative, zero) values fall back to the default
  rather than erroring, since these endpoints have no non-UI consumers.
- `before` — cursor: the `id` of the oldest row already loaded by the
  client. Omitted on the first page. An invalid/unrecognized `before` is
  treated as "no cursor" (first page) rather than erroring.

Query becomes:

```sql
SELECT ... FROM requests
WHERE listener_id = ?
  AND (? IS NULL OR id < ?)
ORDER BY received_at DESC, id DESC
LIMIT ?
```

Response shape changes from a bare array to:

```json
{
  "requests": [ ... ],
  "nextCursor": 1234
}
```

`nextCursor` is the `id` of the last (oldest) row in this page if the page
came back full (`requests.length === limit`) — meaning more rows may
exist. It is `null` if fewer rows came back than `limit`, meaning the
listener's stored history (bounded by `RETENTION_LIMIT` = 200, unchanged)
has been fully paged through.

This is a breaking response-shape change. The frontend is the only
consumer of these three endpoints, so no external/back-compat concern
applies.

### Per-row body truncation

In `toListItem(row)`: if `body` exceeds 256KB, the response carries the
first 256KB of `body`, plus `bodyTruncated: true` and `bodySize: <original
byte length>`. Otherwise `body` ships whole and `bodyTruncated: false`
(`bodySize` still included, equal to the full body's length, for a
consistent shape).

### New detail endpoints (full body on demand)

One per existing tier, mirroring that tier's auth check exactly:

- `GET /api/listeners/:id/requests/:requestId/body` (owner session)
- `GET /api/shared/:token/requests/:requestId/body` (share token)
- `GET /api/shared/projects/:token/listeners/:listenerId/requests/:requestId/body`
  (project share token)

Each resolves the listener/project the same way its list-endpoint sibling
does, then looks up the single row by `requestId` (404 if it doesn't exist
or doesn't belong to the resolved listener), and returns
`{ body: <full, untruncated string> }`. The frontend calls this only when
a user explicitly opens a truncated row's "view full payload" affordance.

### Capture-time fix (`hook.ts`)

`MAX_BODY_BYTES` stays at 10MB (explicit user decision — the 256KB display
threshold above is what actually bounds response memory; 10MB remains
purely an outer "reject something absurd" ceiling at ingestion).

Replace `c.req.raw.clone().text()` with a streaming read: consume the
body's `ReadableStream` chunk by chunk, accumulate a running byte count,
and abort with a `413` the moment the running total exceeds
`MAX_BODY_BYTES` — regardless of whether `Content-Length` was present or
accurate. The existing early `Content-Length`-based rejection can stay as
a fast-path (reject obviously-oversized requests before reading anything),
but must no longer be the only enforcement.

## Frontend changes

- The API client functions for these three endpoints take
  `{ limit?, before? }` and return `{ requests, nextCursor }` instead of a
  bare array.
- `Listener.tsx`, `SharedListener.tsx`, `SharedProjectListener.tsx` each
  hold an accumulating `requests` array plus `nextCursor` in state. The
  initial load fetches the first page; scrolling near the bottom of the list
  fetches the next page with `before: nextCursor` and appends to the
  accumulated array. Reaching `nextCursor === null` stops further fetches.
- `filterRequests` (`frontend/src/lib/filterRequests.ts`) requires no
  code change — it already filters whatever array it's handed. Its
  behavior naturally becomes "search across what's been scrolled into
  view so far," which is the explicitly requested behavior.
- Diff view (`previousByRequestId` map in `Listener.tsx`): the oldest
  currently-loaded row does not attempt a diff (or shows a lightweight
  "scroll for more to see the diff" hint) if its chronological
  predecessor isn't in the loaded set yet. No extra fetch is made to
  backfill it — per explicit user decision, this resolves itself
  naturally once the user scrolls further and the next page loads.
- Any row with `bodyTruncated: true` renders a "payload too large to
  preview — view full" affordance. Clicking it calls the matching detail
  endpoint for that page/view's tier and swaps the truncated body for the
  fetched full body in client state (not re-fetching the whole page).

## Error handling

- Detail endpoints: 404 if the listener/project/token doesn't resolve, or
  if the row exists but doesn't belong to the resolved listener — same
  shape as the 404s already used elsewhere in these files.
- List endpoints: out-of-range `limit`/unrecognized `before` are clamped/
  ignored as described above rather than returning 400 — these are
  UI-only, best-effort parameters.
- `hook.ts`: unenforced-cap bypass becomes a normal `413`, now reachable
  regardless of transfer-encoding.

## Testing

Backend (vitest, `@cloudflare/vitest-pool-workers`):

- Cursor pagination: first page, a middle page, the last (partial) page,
  and an empty listener.
- Truncation correctness at, just under, and just over the 256KB
  boundary, including `bodySize` accuracy in both branches.
- Detail-endpoint auth parity: each detail endpoint enforces the same
  access rule as its list-endpoint sibling (owner session / share token /
  project share token), including the 404 cases.
- `hook.ts`: a request sent via chunked transfer-encoding (no
  `Content-Length`) whose body exceeds `MAX_BODY_BYTES` is rejected with
  413, proving the streaming byte-count enforcement works independent of
  the header.

Frontend:

- Infinite scroll triggers a next-page fetch and appends results.
- Diff is suppressed (or shows the hint) at the current loaded boundary,
  and appears once the predecessor loads via further scrolling.
- "View full payload" round-trip: clicking it on a truncated row fetches
  and swaps in the full body without disturbing the rest of the loaded
  list.

## Out of scope

- Server-side full-history search (explicitly rejected by the user in
  favor of "search what's loaded").
- Changing `RETENTION_LIMIT` (200) or D1 storage/retention behavior —
  this design only changes how that stored history is paged out over the
  API, not how much of it is kept.
- Lowering the 10MB capture-time cap (explicit user decision to leave it
  unchanged).
