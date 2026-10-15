# Paginate listener lists (infinite scroll) — design

Status: design approved in conversation; written spec awaiting review.
Date: 2026-10-15

## Why

Two list views were silently hiding listeners behind a 100-row cap:

- **Home** loaded the owner's newest 100 listeners across _all_ projects
  (`GET /api/listeners`, `LIST_LIMIT = 100`) and built both the project cards
  and the standalone listener list from that one array
  (`frontend/src/lib/mergeHomeItems.ts`: a project card is positioned at its
  best-ranked child inside that array; projects with no child in the window are
  appended as "empty" ones). One project now holds 1,445 listeners
  (created 12–15 Oct, ~100 per 15 min), so it fills the window: 6 of one
  owner's 7 standalone listeners (oldest created 21 Sep, still receiving
  traffic) are invisible on Home, and older small projects drift to the bottom.
  Nothing is deleted — there is no expiry/cron/inactivity code; listeners are
  only removed by an explicit owner delete.
- **ProjectDetail** (shipped in #15) fetches one project's children capped at
  100 with a "more exist" note, so the other 1,345 children of the big project
  cannot be reached.

The user asked for scroll-to-load-more on the listener lists. D1 bills rows
scanned (the account hit the 5M/day free-tier limit on 2026-10-14; see
`2026-10-15-reduce-d1-reads-design.md`), so any pagination must be index-backed
keyset pagination, not `OFFSET`.

## Decisions (made with the user)

1. **Home layout (Option A):** projects get their own section above the
   standalone listeners. Project cards are few and loaded all at once, ordered
   by their own fields. Standalone listeners sit below with infinite scroll.
   (Interleaving project cards with listeners — Option B — needs per-project
   rank keys incl. a new `projects.last_request_at` written on every capture;
   rejected as too large.)
2. **Which sorts paginate (Option B):** Date and Recent activity paginate with
   keyset cursors. Name and Custom load everything up to a fixed cap of 500 and
   do not paginate.
3. **No polling for Name and Custom:** those sorts re-sort the whole project (or
   the owner's standalone set) in memory per load (e.g. 1,445 rows), so polling
   them every 5 s would re-burn the reads just saved. They load once, refresh
   when the tab becomes visible again and after the user's own edits. Date and
   Recent activity keep polling the first page only.

## Goals

- Every listener is reachable: Home standalone list and ProjectDetail children
  load more on scroll.
- Per-page read cost stays ~page size, independent of how many listeners an
  owner/project has (Date, Activity).
- No change to what a user sees while actively watching, except Home's
  project-section layout and the loss of live updates in Name/Custom.

## Non-goals

- `SharedProject` (the read-only shared project view) stays as shipped: cap of
  100 plus the "more exist" note, 10 s isolate cache. Revisit if asked.
- Interleaving projects and listeners on Home (Option B).
- Pagination for Name/Custom beyond the 500 cap.
- Pushing live updates (Durable Objects) — unchanged from earlier deferral.
- Removing `GET /api/listeners` (kept for compatibility; Home and
  ProjectDetail stop calling it).

## Design

### 1. Keyset cursors (backend)

Sort keys, each with `id` as a final deterministic tiebreak:

- **date:** `created_at DESC, id DESC` (same order as today).
- **activity:** `COALESCE(last_request_at, '') DESC, created_at DESC, id DESC`.
  Same ordering as today's `(last_request_at IS NULL), last_request_at DESC, ...`
  (never-active listeners last, then by `created_at`), but expressed so a single
  expression index can serve it (`''` sorts below every ISO timestamp).
- **name / custom:** keep today's `SORT_CLAUSES` expressions, plus `, id DESC`
  as a tiebreak (today they have none, so equal keys can reorder between loads).

Cursor is an opaque base64url JSON of the last row's key tuple
(date: `{c, id}`; activity: `{a, c, id}` where `a = COALESCE(last_request_at,'')`).
The `WHERE` for the next page is a **redundant sargable leading bound plus the
expanded lexicographic comparison**:
`<k1> <= ? AND (k1 < ? OR (k1 = ? AND (k2 < ? OR (k2 = ? AND id < ?))))`.
The expanded `OR` alone cannot be turned into an index range seek (measured
in the Workers D1 engine with bound parameters: a deep page read 502-952 rows);
the leading `<k1> <= ?` bound can, and the `OR` remains only as an exact
filter on the few rows that tie on the leading key (measured: 52 rows read for
a 51-row deep page, for both date and activity). Row-value comparison
(`(created_at, id) < (?, ?)`) works for date but is not sargable on the
activity expression, so it is not used. Invalid or tampered cursors → 400.
Fetch `limit + 1` rows to compute `nextCursor` (no `COUNT(*)`).

Page size `limit` defaults to 50 and is clamped to 100.

For name/custom there is no cursor: return up to 500 rows (fetch 501) and a
`truncated` boolean.

### 2. Endpoints (additive)

- `GET /api/projects/:id?sort=&cursor=&limit=` — response becomes
  `{ project, listeners, nextCursor, truncated, hasMore }`. `hasMore` is kept as
  `nextCursor !== null || truncated` so the currently deployed frontend keeps
  working during the rollout window. 404 for unknown/foreign project unchanged.
- `GET /api/standalone-listeners?sort=&cursor=&limit=` (new) —
  `{ listeners, nextCursor, truncated }`, owner-scoped (`owner_email = ?` and
  `project_id IS NULL`). A new path (not `?standalone=1` on `GET /api/listeners`)
  so the existing bare-array response shape is untouched.
- `GET /api/projects` is unchanged (uncapped; few rows).

### 3. Indexes (one additive migration)

- `listeners(owner_email, project_id, created_at DESC, id DESC)` — standalone
  date keyset seeks on `(owner_email, project_id IS NULL)`; the other standalone
  sorts sort that small set in memory. Without this a standalone query would
  scan every one of the owner's rows (1,445+).
- `listeners(project_id, COALESCE(last_request_at, '') DESC, created_at DESC, id DESC)`
  — activity pages for a project cost ~page size. The existing
  `idx_listeners_project_id (project_id, created_at DESC, id DESC)` already
  serves project date pages.
- Verified locally (SQLite 3.51 `EXPLAIN QUERY PLAN`, 2026-10-15): standalone
  date keyset → `SEARCH ... (owner_email=? AND project_id=? AND created_at<?)`;
  project activity first page and keyset → `SEARCH ... USING COVERING INDEX
(project_id=? [AND <expr><?])`; name/custom → `SEARCH` on the project/owner
  prefix + `USE TEMP B-TREE FOR ORDER BY` (in-memory sort of one project or one
  owner's standalone set only). A backend test asserts the plan so query-text
  drift (the expression must match the index expression exactly) is caught.
- Write cost: `UPDATE listeners SET last_request_at` on every capture now also
  maintains the activity index (one extra index write per capture), and listener
  inserts maintain both new indexes. Negligible against the write limit.

### 4. Frontend

- New `usePaginatedList` hook, modelled on `usePaginatedRequests`: holds loaded
  rows, `nextCursor`, `loadMore()`, `refreshFirstPage()` that merges by id (a
  listener that gains activity moves up; ids already loaded are updated in
  place, duplicates removed). Cursor staleness under the activity sort (a
  listener jumps to the top mid-scroll) can repeat or briefly miss a row until
  the next first-page refresh; accepted.
- **ProjectDetail:** uses the hook against `GET /api/projects/:id`; an
  `IntersectionObserver` sentinel (as `Listener.tsx` does for requests) loads
  more. Date/Activity poll the first page via `usePolling` (5 s visible, as
  shipped). Name/Custom do not poll: initial load, refresh on tab-visible, and
  refetch after the user's own edits (create listener, label edit, reorder). The
  "Showing the first 100 — more exist" note is removed; a `truncated` note
  ("Showing the first 500 — more exist") replaces it for Name/Custom.
- **Home:** two sections. Projects (all, from `GET /api/projects`, ordered
  client-side by their own fields: date = `createdAt` DESC, name = label,
  custom = `sortPosition`; **activity falls back to `createdAt`** because a
  project has no activity field of its own — a deliberate behaviour change).
  Standalone listeners from `GET /api/standalone-listeners` via the hook with
  infinite scroll. `mergeHomeItems.ts`'s interleave/collapse logic is no longer
  used by Home and is deleted if nothing else imports it. Home still does not
  poll (as today).
- **Custom-sort drag-reorder:** works within a section (projects among
  projects; standalone listeners among standalone listeners — no cross-section
  drag). Drag is only offered in Custom sort (as today), and there it is
  disabled with a hint when the list is `truncated` — a partial reorder would
  write positions `0..n-1` for only the loaded ids and corrupt the rest.
  Existing stored positions that were
  assigned in the old mixed list remain valid as ordering keys within each
  section.

### 5. Testing

- Backend (vitest + `@cloudflare/vitest-pool-workers`): keyset boundaries for
  date and activity (ties on the leading key, NULL/never-active listeners last,
  cursor across equal timestamps, exact page-size boundary, tampered cursor →
  400); name/custom cap of 500 with `truncated`; standalone endpoint excludes
  project listeners and other owners'; ownership 404s unchanged; plan assertions
  via `EXPLAIN QUERY PLAN` for the new indexes; `hasMore` compat field.
- Frontend (vitest, node env): `usePaginatedList` merge-by-id logic extracted as
  a pure function and unit tested (append page, refresh-first-page reordering,
  dedupe); polling gated off for name/custom (pure predicate test).
- Manual/preview: Home shows all standalone listeners incl. the three
  `acn-dev-*` ones created 21 Sep; the 1,445-listener project scrolls beyond 100;
  Name sort loads once without repeated requests.

## Rollout

One additive migration. Apply to prod **before** merging (queries are correct
without the indexes, just slow — applying first avoids a window of expensive
queries); verify with `wrangler d1 execute ... EXPLAIN QUERY PLAN`. Backend then
frontend deploy from `release.yml` as usual; the retained `hasMore` field and the
untouched `GET /api/listeners` keep an old frontend working in the gap. After
release, re-check D1 per-query rows read (expect page queries ~page size).

## Risks

- Activity ordering is live: rows can repeat or be missed across pages until the
  next first-page refresh.
- Name/Custom cost O(project size) per load (no polling, one load per
  visit/edit); a project far beyond ~1,500 rows makes each load expensive and the
  500 cap hides the rest.
- Home's Recent-activity sort no longer ranks project cards by their children's
  activity (falls back to created date).
- Two more indexes add index-write cost to captures and listener creation.
- Existing sort clauses gain an `id` tiebreak, which changes (only) the order of
  rows with exactly equal keys.
