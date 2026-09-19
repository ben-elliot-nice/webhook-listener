# Projects & Create-and-Send Hook — Design Spec

Date: 2026-09-20

## Purpose

Support UAT test runs where a per-test-case identifier is only known at
runtime, but is known to be unique for that run. A test script should be
able to `POST` straight to a URL built from that identifier and have the
system create the listener and record the payload in one call, instead of
requiring the existing two-step flow (`POST /api/listeners`, then
`PUT /api/listeners/:id/slug`) before any payload can land.

Introduces **projects**: a session-owned grouping that a user creates
ahead of time in the UI (or via the API, this round), whose id is the
value a UAT script embeds in its webhook URL. Listeners created via the
create-and-send call are scoped to a project; the project's id — not a
per-listener secret — is what gates the call.

This round is **backend-only** (data model + API). Frontend UI for
creating/viewing projects is deferred to a follow-up spec.

## 1. Data model

New migration `backend/migrations/0005_projects.sql`:

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  owner_session TEXT NOT NULL
);

ALTER TABLE listeners ADD COLUMN project_id TEXT REFERENCES projects(id);

DROP INDEX idx_listeners_slug;

CREATE UNIQUE INDEX idx_listeners_slug_global
  ON listeners(slug)
  WHERE slug IS NOT NULL AND project_id IS NULL;

CREATE UNIQUE INDEX idx_listeners_slug_project
  ON listeners(project_id, slug)
  WHERE slug IS NOT NULL AND project_id IS NOT NULL;
```

- `projects.id` — a UUID, generated server-side on creation. Doubles as
  the project's "key" — the value embedded in create-and-send URLs. No
  separate key column, matching the existing pattern where a listener's
  `id` already serves as its default hook path segment.
- `projects.owner_session` — required (`NOT NULL`), unlike
  `listeners.owner_session` which predates session ownership and stayed
  nullable for backward compatibility. Every project is created through
  an authenticated (session-cookie) path, so there's no legacy-row case
  to accommodate.
- `listeners.project_id` — nullable. `NULL` for every listener that
  exists today and for any listener created the existing way (`POST
  /api/listeners`, optionally followed by `PUT .../slug`). Set only for
  listeners created via the new create-and-send hook route.
- Slug uniqueness splits into two partial indexes instead of one:
  project-less listeners keep today's global-uniqueness behavior
  unchanged; project-scoped listeners are unique only within their own
  project, so `checkout-uat` can be a valid identifier in two different
  projects at once without colliding.

## 2. Backend — Projects API (`backend/src/routes/projects.ts`, new)

Mirrors the existing listener routes' ownership pattern:

- `POST /api/projects` — creates a project with `owner_session =
  c.get('sessionId')`. No request body. Returns `{ id, createdAt }`.
- `GET /api/projects` — lists projects owned by the caller's session,
  newest first. Returns `[{ id, createdAt }]`. Exists so a project's id
  isn't visible only once, at creation time — without it there'd be no
  way to retrieve a project's id after the initial response.

No update/delete endpoints this round (out of scope — see below).

## 3. Backend — Create-and-send hook route

New route, added alongside (not replacing) the existing catch-all in
`backend/src/routes/hook.ts`:

`ALL /hook/:projectId/:identifier`

1. Look up the project by `projectId`. Not found → `404 { error: 'project
   not found' }`. No ownership check — same trust model as today's plain
   `/hook/:id`, where knowing the id is sufficient.
2. Normalize `identifier` with the existing `normalizeSlug` /
   `assertValidSlug` rules (lowercase, hyphenated, 3–63 chars after
   normalization). Invalid → `400`, same `SlugValidationError` message
   shape as `PUT /api/listeners/:id/slug` today.
3. Look up a listener by `(project_id, slug) = (projectId, identifier)`.
   - Not found: create one — `id = crypto.randomUUID()`, `project_id =
     projectId`, `slug = identifier`, `owner_session` copied from the
     project's `owner_session`, `webhook_token = NULL` (no per-listener
     token: the project id in the URL is the only gate, matching the
     no-token trust model of today's UUID-only `/hook/:id`, not the
     token-gated custom-slug path). Respond `201` after recording the
     request (step 4).
   - Found: reuse it. Respond `200` after recording the request.
4. Record the payload exactly as today's `/hook/:id` route does: same
   `insertRequest` call, same header redaction, same `MAX_BODY_BYTES`
   (10 MiB) check, same response body (`null`, just the status code
   varies by created-vs-reused).

Every call — first and subsequent — appends a new row via
`insertRequest`; nothing is overwritten. Re-running a UAT test case
against the same identifier produces a full history of every run, same
as the existing hook/requests log for any other listener.

## 4. Backend — Changes to existing code

- **`setListenerSlug`** (`backend/src/listeners.repo.ts`): the
  id-collision and uniqueness checks need to become project-scoped when
  the listener being edited has a `project_id`, otherwise renaming a
  project-scoped listener's slug via the existing `PUT
  /api/listeners/:id/slug` endpoint would incorrectly collide with
  identifiers belonging to unrelated projects. When `project_id IS NULL`,
  behavior is unchanged (global-scope check).
- **`serializeListener`** (`backend/src/routes/listeners.ts`): needs
  `listener.projectId` to build the right `hookUrl` —
  `${HOOK_BASE_URL}/hook/${projectId}/${slug}` for project-scoped
  listeners, vs. today's `${HOOK_BASE_URL}/hook/${slug ?? id}` for
  everything else. Requires adding `project_id AS projectId` to
  `SELECT_COLUMNS` and to the `ListenerRecord` interface.
- **`GET /api/listeners`**: unchanged in behavior — project-scoped
  listeners share `owner_session` with their project's creator, so they
  already appear in the caller's existing list, interleaved with
  non-project listeners, ordered by whatever `?sort=` is in effect today.

## 5. Error handling

- Unknown `projectId` → `404 { error: 'project not found' }`.
- Invalid `identifier` (fails slug normalization/length rules) → `400`,
  reusing `SlugValidationError`'s message format.
- Oversized payload → `413`, unchanged from today's hook route.
- No new error path for "identifier already used by another project" —
  that's not a conflict; it's the entire point of scoping uniqueness per
  project (see §1).

## 6. Testing

Backend (vitest, matching existing `*.repo.test.ts` / route test
patterns):

- `listeners.repo.test.ts`: slug uniqueness is enforced within a project
  but not across projects; `setListenerSlug` conflict check is
  project-scoped for project-owned listeners and global for others.
- New `projects.repo.test.ts` / `projects.test.ts`: create returns a
  unique id; list returns only the caller's own projects, ordered
  newest-first; a session with no projects gets an empty list.
- New `hook.create-and-send.test.ts`:
  - First call to an unseen `(projectId, identifier)` pair creates a
    listener and returns `201`; the request is recorded.
  - Second call to the same pair returns `200`, reuses the same
    listener, and both requests appear in that listener's request log.
  - Unknown `projectId` → `404`.
  - Invalid `identifier` (too short, empty after normalization) → `400`.
  - The same `identifier` string used under two different `projectId`s
    creates two distinct listeners, not a conflict.
  - `GET /api/listeners` (existing endpoint) includes a project-scoped
    listener created this way, with `hookUrl` in the `/hook/:projectId/:slug`
    form.

## Out of scope

- Frontend UI for creating/viewing projects or project-scoped listeners
  (follow-up spec).
- Renaming, deleting, or transferring ownership of a project.
- Moving an existing (non-project) listener into a project, or vice
  versa.
- Any additional auth/rate-limiting on the create-and-send route beyond
  "you need the project id" — same trust model the rest of `/hook/:id`
  already uses.
- A per-listener `webhook_token` for project-scoped listeners — the
  project id itself is the only gate this round.
</content>
