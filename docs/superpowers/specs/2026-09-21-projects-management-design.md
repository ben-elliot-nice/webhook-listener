# Projects Management — Design Spec

Date: 2026-09-21

## Purpose

Follow-up to `2026-09-20-projects-create-and-send-design.md` (backend) and
`2026-09-21-projects-frontend-design.md` (frontend UI), both shipped. Those
rounds explicitly deferred renaming, deleting, and sharing a project, and the
frontend round kept the project detail page's child-listener list fixed and
unsorted. A first manual click-through of the shipped feature surfaced these
as real gaps rather than acceptable omissions:

- No way to label/rename a project — it's only ever shown by its raw UUID.
- No way to share a project's captured traffic with someone read-only.
- No way to sort a project's child listeners.
- No way to delete a project once created.
- No way to manually create a listener inside a project ahead of time — the
  only creation path is the first real request hitting
  `/hook/:projectId/:identifier`, which doesn't fit a UAT workflow where the
  test-case identifier is known before the test runs.

This round adds all five, closing the gap between "projects exist" and
"projects are actually manageable."

## 1. Data model

New migration `backend/migrations/0007_projects_label_share.sql`:

```sql
ALTER TABLE projects ADD COLUMN label TEXT;
ALTER TABLE projects ADD COLUMN share_token TEXT;

CREATE UNIQUE INDEX idx_projects_share_token
  ON projects(share_token)
  WHERE share_token IS NOT NULL;
```

Mirrors the existing listener columns exactly — nullable, no backfill
needed for projects that already exist.

**Delete ordering matters.** Confirmed against the local D1 binding that
`PRAGMA foreign_keys` is `1` (enforcement is genuinely on), so
`requests.listener_id`'s existing `ON DELETE CASCADE` really fires when a
listener is deleted. `listeners.project_id`, however, has no cascade
declared — with FK enforcement on, deleting a project while listeners still
reference it would be *rejected* by SQLite, not silently leave them
orphaned. `deleteProject` therefore issues two statements in one D1
`batch()`, in this order: delete every listener with that `project_id`
first (their requests cascade automatically via the already-working FK),
then delete the project row itself. No new FK/cascade DDL needed — the
existing declared cascade on `requests` does the real work once listeners
are removed in the right order.

## 2. Backend — Projects API additions (`backend/src/routes/projects.ts`)

- `PATCH /api/projects/:id/label` — identical pattern to
  `setListenerLabel`/its route: trim, empty string clears, reuses
  `LabelValidationError` → 400. Returns `{ label }`. Requires a new
  `getProjectForOwner(db, id, sessionId)` in `projects.repo.ts` (mirroring
  `getListenerForOwner`) — today's `getProject` has no session check, fine
  for the read-heavy create-and-send hook route but not for this write
  endpoint.
- `POST /api/projects/:id/share` / `DELETE /api/projects/:id/share` —
  mirrors `getOrCreateShareToken`/`revokeShareToken`. Returns
  `{ shareToken, shareUrl }` where
  `shareUrl = ${APP_BASE_URL}/shared/projects/${token}`.
- `DELETE /api/projects/:id` — owner-checked via `getProjectForOwner`, then
  the cascading delete from §1. Returns `204`.
- `POST /api/projects/:projectId/listeners`, body `{ slug: string }` —
  manual create. Owner-checked via `getProjectForOwner` (404 if not
  found/not yours). Reuses existing pieces end-to-end:
  `normalizeSlug`/`assertValidSlug` for validation (400, same
  `SlugValidationError` shape as today), `getListenerByProjectAndSlug` to
  check for an existing identifier — if found, **409** (a deliberate
  "create" action fails clearly on a name collision, unlike the auto-create
  path's idempotent reuse). `createProjectListener` creates it exactly as
  the hook route does (`webhook_token: NULL` — project id is the only gate,
  matching the existing no-per-listener-token trust model). A race between
  two concurrent manual-creates for the same slug is caught via
  `isUniqueConstraintError` and also resolved as **409**, not a silent
  reuse — consistent with treating this as a deliberate, non-idempotent
  action. This composes for free with the existing create-and-send route:
  if a script later hits `/hook/:projectId/<that-identifier>`,
  `getListenerByProjectAndSlug` finds the manually-created listener and
  reuses it, unchanged from today's behavior.

## 3. Backend — Shared project view (`backend/src/routes/shared.ts`)

New, unauthenticated, token-gated routes mirroring the existing
single-listener shared pattern:

- `GET /api/shared/projects/:token` — resolves the project by
  `share_token` (404 if unknown), returns its child listeners as
  `{ id, label, slug, createdAt }` **only**. Never returns the project's own
  `id`, `hookUrlTemplate`, or a listener's `hookUrl` (which itself embeds
  the project id via `hookUrlFor`) — this is the mechanism that satisfies
  the trust-model requirement below.
- `GET /api/shared/projects/:token/listeners/:listenerId/requests` —
  validates `listenerId` actually belongs to the project resolved by that
  token (404 otherwise), then returns its requests in the same shape as the
  existing `GET /api/shared/:token/requests`.

**Trust model.** A project's id is itself the create-and-send trust token
(per the backend spec: "knowing the id is sufficient"). A naive "share this
project" feature would hand a read-only viewer that same id, and with it,
write access to spawn new listeners under the project — not just read
access to view captured traffic. These two routes avoid that by never
returning the project's id or `hookUrlTemplate` anywhere in the shared
response shape. Exposing a project-scoped listener's bare `id` is safe by
contrast: confirmed via `resolveListenerForHook` that a listener with a
slug set (true for every project-scoped listener) is explicitly rejected on
the plain `/hook/:id` path, so knowing that id grants no injection
capability — only the project id does.

## 4. Backend — Sort in the project detail page (no new backend work)

Project-scoped listeners are already excluded from Home's own Custom-mode
merge (per the frontend spec, they're filtered out before
`mergeHomeItemsByCustom` ever runs), so Home never reads or writes their
`sortPosition`. Reusing the same `sortPosition` column and the same
generalized `POST /api/listeners/reorder` endpoint for "position within
this project" is therefore already safe and non-colliding with Home's
ordering — this is a frontend-only addition (§5).

## 5. Frontend

- **`frontend/src/api.ts`**: `setProjectLabel`, `getOrCreateProjectShareLink`,
  `revokeProjectShareLink`, `deleteProject`, `createProjectListener`
  (manual create), `getSharedProject`, `getSharedProjectListenerRequests` —
  same call/error shape conventions as their listener equivalents already
  in this file.
- **Home (`Home.tsx`)**: project cards now show `project.label || project.id`
  as primary text — the same `label || fallback` pattern listener rows
  already use for `label || slug`. No new actions added to Home itself;
  label/share/delete/manual-create all live on the detail page, matching
  how listener actions work today (Home is view/navigate-only — this
  mirrors, rather than fixes, the separately-tracked "list view actions on
  home page" backlog gap).
- **`ProjectDetail.tsx` gains**: inline label edit (mirrors `Listener.tsx`'s
  label-edit form), a Share section (get-or-create link + copy + revoke,
  mirrors `Listener.tsx`'s share section), a Delete button with a confirm
  dialog (mirrors the existing listener delete confirm), an inline "Create
  listener" form (identifier input + submit, same interaction shape as the
  existing custom-slug form on the listener page — success navigates to
  `/listener/:id`, a 409 shows "that identifier's already in use in this
  project" inline), and the same four sort-mode buttons + Custom-mode
  drag-reorder as Home, scoped to just this project's children (submitting
  `reorderItems` with only this project's listener ids as `{ type:
  'listener', id }`).
- **New page `SharedProject.tsx`** at route `/shared/projects/:token` —
  lists child listeners (label/slug/createdAt; no project id or template
  anywhere in the UI). Clicking one navigates to a new nested route
  `/shared/projects/:token/:listenerId`, reusing `SharedListener.tsx`'s
  existing request-list rendering, pointed at
  `getSharedProjectListenerRequests` instead of the single-listener
  equivalent.

## 6. Error handling

- 404 `{ error: 'project not found' }` — unowned/missing project (label,
  share, delete, manual-create) or unknown share token (both shared routes).
- 400 — `SlugValidationError`/`LabelValidationError` messages, unchanged
  shapes from today.
- 409 — slug conflict on manual-create (deliberate action, existing or
  race-created identifier), same status code the existing
  `PUT /api/listeners/:id/slug` conflict path already uses.
- No new error shapes invented anywhere in this round.

## 7. Testing

Backend (vitest, extending existing suites):

- Label: set/clear via `PATCH`, validation error on over-length input,
  404 for another session's project.
- Share: create/get/revoke; the two new shared-project routes' 404-on-bad-
  token; a positive assertion that the shared-project response never
  contains the project's `id` or `hookUrlTemplate`, and that a listener
  entry in it never contains `hookUrl`.
- Delete: cascades to listeners *and* their requests — verified via a
  direct D1 row-count query pre/post delete, not just the `204` response;
  404 for another session's project; a project with zero listeners deletes
  cleanly (no-op batch).
- Manual create: happy path (slug validated, listener created with
  `webhookToken: null`, appears via `GET /api/listeners`); 409 on an
  existing identifier in the same project; 400 on an invalid slug; the same
  identifier is still creatable in a *different* project (no cross-project
  collision, consistent with the original create-and-send design); a
  forced race (two near-simultaneous creates) still resolves to exactly one
  listener and a 409 for the loser, not two listeners.
- `getProjectForOwner`: 404s for another session's project, matching
  `getListenerForOwner`'s existing coverage pattern.

Frontend: no test framework exists (unchanged from prior rounds).
Verification is a clean `npm run build` plus a manual click-through
covering every new affordance: label edit, share/copy/revoke, delete-with-
confirm, manual-create happy path + 409, sort-mode switching, drag-reorder
within a project, and the shared-project view opened in an incognito
window (confirming the project id is genuinely never visible there).

## Out of scope

- Moving an existing listener between projects, or between project-scoped
  and standalone (unchanged from both prior specs).
- Transferring project ownership between sessions.
- Any additional auth/rate-limiting on the create-and-send route beyond
  what already exists (unchanged from the backend spec).
- Fixing the separately-tracked "list view actions on home page" backlog
  item (delete/share affordances directly on Home's listener rows) — this
  round mirrors that same page-vs-detail split for projects, it doesn't
  resolve the pre-existing gap for listeners.
- A per-listener `webhook_token` for project-scoped listeners, including
  manually-created ones — the project id remains the only gate, per the
  original backend spec's design.
