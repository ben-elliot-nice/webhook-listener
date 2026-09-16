# Home Page Listener List — Design Spec

Date: 2026-09-17

## Purpose

Visiting the home page (`/`) currently shows only a "Create new webhook
listener" button — there's no way to get back to a listener you already
created without having saved its URL somewhere. Now that listener ownership
is scoped to an anonymous session
(`docs/superpowers/specs/2026-09-17-session-scoped-ownership-design.md`),
the backend already knows which listeners belong to the current browser.
This feature surfaces that: the home page lists the current session's own
listeners, most recently created first, each linking to its `/listener/:id`
page.

This is the deferred item explicitly called out as out-of-scope in the
session-ownership spec: *"Persisting 'my listeners' across a session for a
future home-page listing feature — this session concept enables that
later, but building it is not part of this change."* This spec is that
follow-on.

## Dependency

This feature requires the session-scoped ownership feature to be fully
implemented first (`owner_session` column, session cookie hook,
`getListenerForOwner`) — there is no way to answer "which listeners are
mine" without it. Do not start this feature's implementation before that
one has landed and its full test suite is green.

## API changes

| Method | Path | Description |
|---|---|---|
| GET | `/api/listeners` | New route. Returns the current session's own listeners, newest first, each with the same shape as `GET /api/listeners/:id` (`id`, `createdAt`, `hookUrl`, `shareUrl`). Capped at 100 most recent — a defensive bound, not a spec'd business requirement; this is a personal debugging tool, not expected to be hit in practice. |

No new repository function is strictly required beyond a new
`getListenersForOwner(db, sessionId, limit)` (plural — distinct from the
existing singular `getListenerForOwner`), which queries
`SELECT ... FROM listeners WHERE owner_session = ? ORDER BY created_at DESC LIMIT ?`.
This is intentionally a separate function from the existing
`getListenerForOwner` (singular, matches by id+session) rather than a
parameter overload — the two have different shapes (one row vs. many) and
different call sites, so keeping them separate functions is clearer than a
single function with a conditional return type.

`GET /api/listeners` requires no route parameter and is never confused with
`GET /api/listeners/:id` at the routing layer since Fastify matches the
literal `/api/listeners` path before the `:id` wildcard segment.

## Frontend changes

- `frontend/src/api.ts`: new function `listListeners(): Promise<Listener[]>`
  calling `GET /api/listeners`.
- `frontend/src/pages/Home.tsx`: on mount, fetches the list and renders it
  above the existing "Create new webhook listener" button. Each item shows
  the listener's creation timestamp and links to `/listener/:id`. An empty
  list renders nothing extra — just the create button, matching today's
  behavior exactly (no "you have no listeners yet" message needed; the
  create button already communicates that).
- No polling — the list only needs to be fresh when the page loads (you
  only leave the home page by creating a listener or navigating to one you
  already had, at which point this list is stale by definition anyway).
- No pagination UI — the 100-row cap is a defensive backend bound, not
  something the frontend needs to expose controls for at this scale.

## Error handling

If `GET /api/listeners` fails (network error, unexpected status), the home
page shows the existing "Create new webhook listener" button regardless —
the list is a nice-to-have addition to an already-functional page, so a
failed list fetch must never block the core create-a-listener flow. Log
nothing user-visible beyond an unobtrusive inline note reusing the existing
error-banner pattern already used elsewhere in the app (`Home.tsx` already
has an `error` state for the create-listener flow — reuse the same visual
pattern for a list-fetch failure, but keep the create button usable either
way).

## Testing

- **Backend unit tests** (Vitest): `getListenersForOwner` returns only the
  calling session's listeners, newest first, and respects the limit;
  `GET /api/listeners` route test confirms the same via `app.inject()`
  with distinct session cookies, and confirms a session with zero listeners
  gets an empty array (not an error).
- **Frontend**: no automated tests (established project scope) — manual
  verification: create two listeners in one browser, confirm both appear
  on the home page in newest-first order; open a fresh incognito window,
  confirm its home page shows an empty list (just the create button).

## Out of scope

- Deleting a listener directly from the home page list (still requires
  visiting `/listener/:id` and using the existing delete button there).
- Any sorting/filtering/search on the home page list.
- Pagination beyond the 100-row defensive cap.
