# Shared-with-me — design

Date: 2026-09-22

## Why

Read-only share links (`docs/superpowers/specs/2026-09-16-shareable-readonly-view-design.md`)
work as pure bearer tokens: whoever has the URL can view it, with no
record kept of who opened it or where to find it again. Since the
email access gate (`docs/superpowers/specs/2026-09-20-email-access-gate-design.md`)
shipped, every viewer of a share link is a known, verified identity —
but the app still does nothing with that fact. A viewer who opens a
share link today has no way back to it except re-finding the original
message/link; there's no record of it on their own home page.

This adds a "shared with me" section to Home: opening a share link
(listener or project) remembers it against the viewer's verified
email, and it stays visible and navigable from Home until the owner
revokes or deletes it, or the viewer removes it themselves.

## Data model

```sql
-- 0011_shared_with_me.sql
CREATE TABLE shared_with_me (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  viewer_email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('listener', 'project')),
  token TEXT NOT NULL,
  first_visited_at TEXT NOT NULL,
  last_visited_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE(viewer_email, kind, token)
);

CREATE INDEX idx_shared_with_me_viewer ON shared_with_me(viewer_email);
```

One row per (viewer, share). `removed_at` implements a personal
"remove from my list" action, independent of the owner revoking the
underlying share — set on removal, cleared again if the viewer
revisits the same share link later.

This table is never joined for label/owner data — those are always
read live from `listeners`/`projects` by `token` at list time (see
"Listing" below), so a label change or a revoke is reflected
immediately with no separate sync step. Rows left behind by a
superseded token (owner revoked and re-shared, producing a new token)
are not actively cleaned up — they become permanently unresolvable
(excluded by the join-miss filter at list time) and are cheap enough
to leave in place. Accepted trade-off, not a gap to close.

## Recording a visit

Two new endpoints, each called once by the frontend when the
corresponding shared page mounts — not on the existing 3-second
polling endpoints, which stay unchanged:

| Method | Path | Records |
|---|---|---|
| POST | `/api/shared/:token/visit` | `kind: 'listener'` |
| POST | `/api/shared/projects/:token/visit` | `kind: 'project'` |

The nested `/shared/projects/:token/:listenerId` view (a specific
listener inside a shared project) calls the *project* visit endpoint
with the same token — opening a listener inside a shared project still
means "I was shared this project," not a new shareable unit of its
own; there is no separate `visit` endpoint for it.

Each call upserts `(viewer_email, kind, token)`:
- No existing row → insert, `first_visited_at = last_visited_at = now`,
  `removed_at = NULL`.
- Existing row → `last_visited_at = now`, `removed_at = NULL`
  (revisiting a link the viewer had personally removed re-adds it).

`viewer_email` comes from `c.get('email')`, already populated by the
existing tier-0 auth middleware for every non-`/hook/*`, non-`/auth/*`
route — no new auth path.

If the token doesn't resolve to a real, non-revoked listener/project,
respond `404` and write nothing — recording a visit to something that
doesn't exist has no value.

## Listing and removing

| Method | Path | Description |
|---|---|---|
| GET | `/api/shared-with-me` | List the signed-in viewer's shared-with-me entries. |
| DELETE | `/api/shared-with-me/:kind/:token` | Personally remove one entry (sets `removed_at`). |

`GET /api/shared-with-me`:
1. Read all rows for `viewer_email` where `removed_at IS NULL`.
2. For each, resolve by `token` against `listeners` (kind `listener`)
   or `projects` (kind `project`). Drop any row that no longer
   resolves — this is the mechanism by which a revoked or deleted
   share disappears from the viewer's list automatically, with no
   explicit cleanup step tied to revoke/delete.
3. Drop any row whose resolved owner's `owner_email` equals the
   viewer's own email — a viewer who follows their own share link
   already sees that listener/project as an owned item; showing it
   again here would be a confusing duplicate.
4. Return the survivors as
   `{ kind, token, label, createdAt, url }[]`, where `label` falls
   back to `slug` for listeners exactly as the rest of the app already
   does (`COALESCE(label, slug)`), and `url` is `/shared/:token` or
   `/shared/projects/:token`.

`DELETE /api/shared-with-me/:kind/:token`: sets `removed_at = now` for
that `(viewer_email, kind, token)`. Returns `204` whether or not a
matching row existed — same "don't distinguish not-yours from
doesn't-exist" principle the rest of the app already follows for
owner-scoped routes.

## Frontend changes

- `SharedListener.tsx`, `SharedProject.tsx`, `SharedProjectListener.tsx`:
  each fires `POST .../visit` once on mount (fire-and-forget; a failed
  recording call must not block or degrade the read-only view itself).
- New `api.ts` functions: `recordSharedListenerVisit(token)`,
  `recordSharedProjectVisit(token)`, `listSharedWithMe()`,
  `removeSharedWithMe(kind, token)`.
- `Home.tsx`: new "Shared with me" section, fetched independently of
  the existing `listListeners`/`listProjects` call. Rendered as its
  own block, separate from the existing sortable owned-items grid (not
  merged into it, and not subject to the existing sort modes — it's a
  distinct concept: things visited, not things owned). Each row is
  clickable through to its `/shared/...` URL and has a small remove
  (×) control that calls the DELETE endpoint and drops the row from
  local state optimistically. The section renders only when the list
  is non-empty, matching the existing `items.length > 0` guard pattern
  already used for the sort controls.

## Error handling

- `POST .../visit` on an invalid/revoked/nonexistent token → `404`,
  no write; frontend ignores the failure silently.
- `DELETE /api/shared-with-me/:kind/:token` → always `204`.
- `GET /api/shared-with-me` → `200` with `[]` when nothing is recorded
  or everything has been revoked/removed; the frontend section simply
  doesn't render.
- No new auth path: everything here sits behind the tier-0 `email`
  context var already required for every route it touches.

## Testing

- **Backend** (`@cloudflare/vitest-pool-workers`): a first visit
  creates a row; a second visit to the same token updates
  `last_visited_at` rather than duplicating; visiting a
  nonexistent/revoked token returns `404` and writes nothing;
  `GET /api/shared-with-me` excludes an entry once its token is
  revoked after being recorded; excludes an entry whose resolved
  owner's email matches the viewer's own; `DELETE` sets `removed_at`
  and the entry drops out of the next `GET`; revisiting the same token
  after a personal removal clears `removed_at` and the entry
  reappears; two different viewer emails visiting the same token each
  get their own independent row (isolation — one viewer's removal
  doesn't affect the other's).
- **Frontend**: no automated tests (established project scope).
  Manual: sign in as one email, open a listener share link and a
  project share link, confirm both appear in Home's new section;
  sign in as a different email and confirm neither appears; as the
  owner, revoke the listener's share, then reload Home as the viewer
  and confirm it's gone; remove the project entry via the × control,
  confirm it disappears, then revisit the same link and confirm it
  reappears in the list.

## Out of scope

- Any per-item unread/new-activity indicator on shared-with-me
  entries — this tracks which shares have been opened, not a
  notification or activity feed.
- Active cleanup of orphaned `shared_with_me` rows left behind by a
  superseded (revoked-and-re-shared) token — covered under "Data
  model" above.
- Any change to who can *open* a share link, or the bearer-token
  semantics of sharing itself — this feature only affects what's
  remembered about a visit after the fact.
