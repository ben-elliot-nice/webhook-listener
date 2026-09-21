# Projects Frontend UI — Design Spec

Date: 2026-09-21

## Purpose

Follow-up to `2026-09-20-projects-create-and-send-design.md`, which shipped
the backend-only round: a `projects` table, `POST`/`GET /api/projects`, and
`ALL /hook/:projectId/:identifier` (create-on-first-call, reuse thereafter).
That spec explicitly deferred all UI work. This spec covers the frontend:
creating projects, viewing a project's create-and-send URL template, and
watching listeners appear under it as a UAT script runs.

This round touches the backend in three small, additive ways beyond what
shipped — none change existing behavior, each is required to make the UI
work. Everything else is frontend-only.

## 1. Backend additions (small, additive)

### 1.1 Expose `projectId` on listener serialization

`backend/src/routes/listeners.ts` — `serializeListener` gains
`projectId: listener.projectId` in its returned object. `GET
/api/listeners` behavior is otherwise unchanged: still interleaved, still
scoped to `owner_session`, still ordered by whatever `?sort=` is active.
This is the only field the frontend needs to tell project-scoped listeners
apart from standalone ones and to group them by project.

### 1.2 Expose `hookUrlTemplate` and `sortPosition` on project serialization

`backend/src/routes/projects.ts` — `serializeProject` gains:

- `hookUrlTemplate: `${env.HOOK_BASE_URL}/hook/${project.id}/<identifier>`` —
  computed server-side from the env var, mirroring how `hookUrlFor` already
  computes a listener's `hookUrl`. This is the URL a UAT script's author
  copies and fills in `<identifier>` for each test case.
- `sortPosition: project.sortPosition` — see §1.3.

Returned from both `POST /api/projects` and `GET /api/projects`.

### 1.3 Projects gain a `sort_position` column and participate in reorder

New migration `backend/migrations/0006_projects_sort_position.sql`:

```sql
ALTER TABLE projects ADD COLUMN sort_position INTEGER;
```

- `GET /api/projects` orders by
  `(sort_position IS NULL), sort_position ASC, created_at DESC` — same
  fallback pattern already used for listeners' `custom` sort.
- `POST /api/listeners/reorder`'s request body changes from
  `{ orderedIds: string[] }` to
  `{ orderedItems: { type: 'listener' | 'project'; id: string }[] }`.
  `reorderListeners` (repo) is renamed/generalized to validate ownership of
  listener-type ids against `listeners` and project-type ids against
  `projects` (per the caller's session), then batch-updates `sort_position`
  on the matching table using each item's index in the combined array —
  same index-as-position scheme as today, just split across two tables.
  Rejects (400, same as today) if any id isn't owned by the caller,
  regardless of type.

This is the only sort mode that needs real backend-persisted project
positions — see §2 for why `date`/`name`/`activity` don't.

## 2. Frontend — API client (`frontend/src/api.ts`)

- New `Project` type: `{ id: string; createdAt: string; hookUrlTemplate:
  string; sortPosition: number | null }`.
- `Listener` gains `projectId: string | null`.
- `createProject(): Promise<Project>` — `POST /api/projects`.
- `listProjects(): Promise<Project[]>` — `GET /api/projects`.
- `reorderItems(items: { type: 'listener' | 'project'; id: string }[]):
  Promise<void>` replaces `reorderListeners(orderedIds)`, `POST
  /api/listeners/reorder` with the new body shape.

## 3. Frontend — Home page (`frontend/src/pages/Home.tsx`)

### 3.1 Data and grouping

Home fetches `listListeners(sort)` and `listProjects()` in parallel (as it
already fetches listeners today). From the results:

- **Standalone listeners** — `projectId === null` — rendered exactly as
  today, in the order the backend returned them.
- **Project-scoped listeners** — `projectId !== null` — never rendered as
  their own row on Home. They're visible only inside their project's
  detail page (§4). This keeps Home from filling up with individual
  UAT test-case rows as a project accumulates them.
- **Projects** — rendered as folder-icon cards, visually larger than
  listener rows (favicon-style icon), positioned per §3.2.

### 3.2 Sort modes

`date` / `name` / `activity` need no new backend data. `GET
/api/listeners?sort=X` already returns every listener — including
project-scoped ones — correctly ordered by that mode via SQL. Home walks
that already-sorted array once and, for each project-scoped listener,
resolves it to its project; the **first occurrence** of any of a project's
listeners in the sorted array is that project's position (i.e., a
project's rank is its best-ranked child under the active criterion). A
project with no children yet falls back to its own `createdAt` — the same
fallback listeners already use under `activity` when they've never
received a request. Standalone listeners keep their own position
unchanged. The result is a single merged, interleaved list.

`custom` uses real data instead: Home merges its already-fetched
standalone-listener array (`sort=custom`) with the projects array
(ordered by `sortPosition`, §1.3) by `sortPosition` (`createdAt` as
tiebreak/fallback for `null`), producing one flat draggable list. Dragging
any row — listener or project — calls `reorderItems` with the full mixed
order, exactly as today's drag-to-reorder calls `reorderListeners`.

### 3.3 Creation

A "Create project" button sits alongside the existing "Create new webhook
listener" button. `createProject()` → navigate to `/projects/:id`.

## 4. Frontend — Project detail page (new: `frontend/src/pages/ProjectDetail.tsx`)

New route `/projects/:projectId`, registered in `App.tsx` alongside the
existing routes.

- **Polling**, same `POLL_INTERVAL_MS = 3000` pattern as `Listener.tsx`:
  calls `listProjects()` and `listListeners()` in parallel each tick, finds
  this project by id in the projects result, filters the listeners result
  to `projectId === this id` for the child rows. Polling matters here
  specifically because the page's purpose is watching new test-case
  identifiers appear live as a UAT script runs against
  `/hook/:projectId/:identifier`.
- **Not-found handling**: mirrors `Listener.tsx`'s
  `MAX_CONSECUTIVE_NOT_FOUND` pattern — if the project id isn't in the
  (session-scoped) `listProjects()` result for two consecutive polls,
  show a not-found state with a link back to Home. This also naturally
  enforces ownership, since `listProjects()` only ever returns the
  caller's own projects.
- **Header**: project id (monospace, truncated), created date, and a
  copyable `hookUrlTemplate` (same copy-button pattern as the listener
  page's "Copy webhook URL").
- **Child listeners**: rendered below using the same row treatment as
  Home's listener rows (label/slug as primary text, createdAt, favicon
  icon), each linking to `/listener/:id`. Empty state: "No requests yet —
  point your test script at `<hookUrlTemplate>` to get started," with its
  own copy button.
- **No rename/delete controls** — matches the backend spec's declared
  out-of-scope for this round (no update/delete endpoints exist).

## 5. Error handling

- Project not found or not owned → not-found state on the detail page
  (§4), same shape as the existing listener-not-found state.
- `reorderItems` failure → revert the optimistic reorder + inline error,
  mirroring `Home.tsx`'s existing `reorderListeners` failure handling.
- `createProject()` failure → inline error message, same pattern as
  `handleCreate`'s existing listener-creation error handling.
- List-fetch failures on Home (`listListeners`/`listProjects`) stay
  silent, consistent with the existing accepted behavior for
  `listListeners` (`BACKLOG.md` → "Deferred polish").

## 6. Testing

Backend (vitest, extending existing suites):

- `listeners.repo.test.ts` / `listeners.test.ts`: `serializeListener`
  response includes `projectId` (null for standalone, set for
  project-scoped).
- `projects.repo.test.ts` / `projects.test.ts`: `serializeProject`
  includes `hookUrlTemplate` (correct `<identifier>` placeholder shape)
  and `sortPosition`; `GET /api/projects` respects the
  sort_position/created_at fallback ordering.
- Reorder: mixed `orderedItems` (listeners + projects) persists the
  correct `sort_position` on each respective table; rejects the request
  (400) if any item — of either type — isn't owned by the caller;
  existing listener-only reorder behavior stays covered as a regression
  case.

Frontend: no test framework exists (`frontend/package.json` has no test
script — just `tsc -b && vite build`). Verification is a clean
`npm run build` plus a manual click-through if browser access is
available this session (this repo has never had one done by an agent —
already flagged in `STATUS.md`/`BACKLOG.md`). At minimum, click-through
should cover: create a project, copy its URL template, `curl` it with a
made-up identifier, confirm the listener appears under the project and
does *not* leak onto Home, and confirm Custom-mode drag works for both
a listener and a project card.

## Out of scope

- Renaming, deleting, or transferring ownership of a project (unchanged
  from the backend spec).
- Moving a listener between projects, or between project-scoped and
  standalone.
- Any additional auth/rate-limiting beyond what the backend spec already
  established.
- A dedicated `GET /api/projects/:id` single-project endpoint — the
  detail page reuses the existing list endpoint and finds-by-id
  client-side, since it already gets ownership scoping for free.
