# Reduce D1 rows-read — design

Status: design approved in conversation; written spec awaiting review.
Date: 2026-10-15

## Why

Cloudflare's D1 free tier allows 5M rows read per day. On 2026-10-14 the
account exceeded it, and D1 rejected all queries (error code 7500) until
midnight UTC, including prod capture.

Two queries accounted for ~5.7M reads/day: `getListenersForOwner`
(`GET /api/listeners`, ~3.6M) and `getListenersByProject` (~2.0M). Root cause
was a missing index on `listeners.owner_email` / `listeners.project_id`, which
made each call a full table scan. That was fixed in PR #14 (migration
`0012_owner_project_indexes.sql`, applied to prod 2026-10-15 00:18 UTC).

Post-fix measurement (01:00–02:35 UTC, D1 analytics `d1QueriesAdaptiveGroups`)
showed the remaining ~1.4k reads/min (~2M/day extrapolated) is:

| Query                                                               | Share of reads |
| ------------------------------------------------------------------- | -------------- |
| `GET /api/listeners` (owner list, LIMIT 100)                        | ~62%           |
| prune `DELETE FROM requests ... NOT IN (...)`, run on every capture | ~18%           |
| `projects WHERE owner_email`                                        | ~6%            |
| request page fetch                                                  | ~4%            |
| other                                                               | ~10%           |

A steady 10k reads / 5 min with zero writes matched exactly one tab polling
`/api/listeners` every 3s at 100 rows (20 × 100 = 2k/min): the dominant
residual cost is polling frequency × rows per poll, not any single query.

Data shape that drives this: 958 listeners, 6 projects, 7 owners; two owners
hold 952 listeners, nearly all inside projects. `ProjectDetail` fetches the
owner's top-100 listeners across all projects every 3s and filters by
`projectId` client-side — which also silently truncates any project whose
children fall outside that top 100.

## Goals

- Cut steady-state reads by roughly half or more (target ~1.0–1.3M/day at
  current load) without changing what users see while actively watching.
- Remove the silent truncation of project children.
- Bound worst-case per-call cost on the shared project list.

## Non-goals

- Durable Object / WebSocket push architecture (considered; deferred).
- `after=<id>` cursor change detection for the request feed (feed polling is
  ~1% of reads; also needs a new `requests(listener_id, id)` index).
- Counter-column prune (exact cap) — rejected in favour of the probabilistic
  guard below.
- Changes to `Home`, which loads once and does not poll.

## Design

### 1. Shared polling hook (frontend)

New `frontend/src/hooks/usePolling.ts`: `usePolling(tick, { intervalMs, idleMs })`
where `tick` returns `Promise<boolean>` ("keep polling?"), matching the
existing `refresh()` contract. Replaces the five hand-rolled loops in
`ProjectDetail`, `SharedProject`, `Listener`, `SharedListener`,
`SharedProjectListener`.

- `intervalMs = 5000` while visible (was 3000).
- **Hidden tab:** timer cleared. On `visibilitychange` → visible, run one
  immediate tick and resume.
- **Idle:** pointer/key/scroll/touch events update a last-activity timestamp
  (throttled). After `idleMs = 600000` (10 min) with no activity, polling
  stops and a small "live updates paused" note is shown. The next interaction
  runs one immediate tick and resumes.
- No overlapping in-flight ticks (skip a tick if the previous is pending).
- `tick` returning `false` stops polling permanently (existing not-found
  behaviour).

### 2. Project-scoped listing (backend + frontend)

New `GET /api/projects/:id?sort=<mode>` in `backend/src/routes/projects.ts`,
returning `{ project, listeners, hasMore }`.

- Owner-scoped via the existing `getProjectForOwner`; 404 for other owners or
  unknown ids.
- New repo function `getListenersByProjectSorted(db, projectId, sort, limit)`
  in `listeners.repo.ts`, reusing `SORT_CLAUSES` (extracted/exported so the
  owner list and project list share one definition). Fetches `limit + 1` (101)
  rows, returns 100 and `hasMore = rows.length > 100`. No `COUNT(*)` (it would
  read every child per poll).
- Served by `idx_listeners_project_id` for the date sort; other sorts sort
  within a single project in memory.
- `ProjectDetail` replaces its `listProjects()` + `listListeners(sort)` pair
  with this one call and shows "Showing first 100 — more exist" when
  `hasMore`. Sort modes and custom drag-reorder keep working on the shown
  items.
- Existing endpoints unchanged (additive), so an old frontend keeps working
  during deploy.

### 3. Shared project list: cap and cache

- `getListenersByProject` gains a limit param (default 101); the shared
  endpoint `GET /api/shared/projects/:token` returns `hasMore` and at most 100
  listeners. `SharedProject` shows the same "more exist" note.
- In-isolate cache: module-scope `Map` keyed by **project id**, 10s TTL, small
  bounded size (evict oldest), storing only the listener rows (not a
  `Response`, and not the project/token). The token → project lookup
  (`getProjectByShareToken`, a single unique-index read) still runs on every
  request, so revoking or rotating a share link takes effect immediately; only
  the expensive child-listener query is cached. The
  edge Cache API is deliberately not used: the app sets `wl_session_id`
  cookies and per-request CORS headers, and caching a `Response` risks leaking
  a `Set-Cookie` (this repo has already had one session-leak bug of that
  class — see CLAUDE.md "Known, deliberate design decisions").
- Staleness: a listener added to a shared project may take up to 10s to
  appear. Per-isolate, so hit rate is lower than a global cache; accepted.
- Revocation: because the cache is keyed by project id and the token lookup is
  never cached, a revoked or unknown token returns 404 immediately regardless
  of cache state.

### 4. Prune guard

`insertRequest` in `requests.repo.ts` adds `AND last_insert_rowid() % 10 = 0`
to the prune `DELETE`, so it runs on ~1 in 10 captures (~90% fewer prune
reads). Request ids are global across listeners, so a given listener's prune
is probabilistic rather than exactly every 10th capture; a listener can
briefly hold somewhat more than 200 rows (typically ≤ ~209, occasionally
more). Read paths (`getRequests`) still cap at `RETENTION_LIMIT`. To be
verified in tests: `last_insert_rowid()` inside `db.batch()` refers to the
insert just executed.

## Testing

- Backend (vitest + `@cloudflare/vitest-pool-workers`):
  - `GET /api/projects/:id`: owner scoping, 404 for foreign/unknown project,
    cap at 100 with `hasMore`, each sort mode, no cross-project leakage.
  - Shared project list: cap/`hasMore`, cache TTL and hit/miss, bounded size,
    revoked/unknown token returns 404 even while the project's listeners are
    cached.
  - Prune: `last_insert_rowid()` behaviour inside `db.batch()`; volume test
    showing a listener's row count converges back to ≤ ~210 over many
    captures, never drops newest rows, and read caps still hold.
- Frontend: `usePolling` with fake timers — visible cadence (5s), hidden
  pause/resume with immediate tick, idle pause after 10 min and resume on
  interaction, no overlapping ticks, `false` stops polling.
- Manual/preview: open a project page and a shared project in the PR preview
  environment; confirm pause on hidden tab and the "more exist" note.

## Rollout

No migration. Frontend depends on the new `GET /api/projects/:id`; both
Workers deploy from `release.yml` and the change is additive, so deploy order
is not critical. After release, re-check rows-read via D1 analytics against the
numbers above (expect the `/api/listeners` share to fall sharply and the prune
`DELETE` to drop ~90%).

## Risks

- 5s poll (vs 3s) makes the request feed feel slightly less live; chosen
  deliberately by the user.
- Probabilistic prune lets a listener exceed 200 rows slightly.
- Isolate cache can serve a stale shared list for ≤ 10s and has a per-isolate
  hit rate.
