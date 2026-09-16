# Session-Scoped Listener Ownership — Design Spec

Date: 2026-09-17

## Purpose

Replace "the listener UUID is a bearer credential anyone can use" with
"only the browser that created a listener can view or manage it." Today,
pasting a `/listener/:id` URL into any browser — including a fresh
incognito window that never saw the listener created — grants full owner
access (view + delete). That was the original, deliberate design (see
`docs/superpowers/specs/2026-09-16-webhook-listener-design.md`), but it
means there is no real boundary between "the person who made this" and
"anyone who has the link" for owner-level actions. The shareable read-only
view (`docs/superpowers/specs/2026-09-16-shareable-readonly-view-design.md`)
already established that a *different*, weaker bearer token is appropriate
for delegated read-only access — this spec makes owner access itself
require having actually created the listener, while leaving the share
link's cross-browser bearer-token behavior untouched.

## Access model (supersedes part of the original spec)

- **Owner access** (changed): no longer "anyone with the UUID." A browser
  is the owner of a listener only if it holds the anonymous session cookie
  that was present when the listener was created. Visiting `/listener/:id`
  from any other browser/session — including one that has the raw URL but
  never created it — gets the same response as a nonexistent listener.
- **Read-only access** (unchanged): the separate `share_token` via
  `/shared/:token` continues to work as a pure bearer token, by design,
  regardless of session. This is the intended way to grant access across
  browsers.
- **Webhook capture** (unchanged): `POST/GET/etc. /hook/:id` remains fully
  open — a webhook sender is not a browser and must be able to post
  regardless of who's currently viewing the listener.

## Session mechanics

- New backend dependency: `@fastify/cookie`.
- A global Fastify hook runs before every request: read the `session_id`
  cookie; if absent, generate one via `randomUUID()` (same scheme as
  listener ids and share tokens) and set it (`httpOnly: true`,
  `sameSite: 'lax'`, `path: '/'`, `maxAge` ~1 year, no `Secure` flag since
  this only ever runs over local HTTP per the project's existing
  local-only deployment scope). The resolved session id is attached to
  the request for handlers to read.
- The cookie is unsigned. This is an accepted, explicit trade-off at this
  project's local-only scope, not a closed gap: because cookies are scoped
  by host (not by port), any other local server the same browser talks to
  on `localhost` can also set a cookie for that host, meaning a value could
  in principle be attacker-influenced (session fixation) if another local
  process cooperated. A basic UUID-shape check on the incoming cookie value
  guards against garbage/malformed input but does not close this specific
  risk — closing it fully would require signing the cookie with a server
  secret, judged disproportionate for a personal local dev tool. Documented
  here so a future change to this area starts from an accurate baseline.
- No frontend code changes are needed to transmit the cookie: `fetch()`'s
  default `credentials: 'same-origin'` already includes cookies for
  same-origin requests, and the frontend and API are same-origin behind
  Nginx.

## Data model changes

```sql
ALTER TABLE listeners ADD COLUMN owner_session TEXT;
```

Guarded the same way the `share_token` migration was: check
`PRAGMA table_info(listeners)` for the column before running `ALTER TABLE`.
The column is nullable at the schema level (SQLite `ALTER TABLE` can't add
a `NOT NULL` column without a default to an existing table), but every
*new* listener created after this change always has it set — `NULL` only
ever occurs for a listener created before this migration.

**No migration/back-compat behavior is built for existing listeners.** A
listener with `owner_session = NULL` matches no session and becomes
permanently inaccessible via `/listener/:id` once this ships. This is an
explicit, accepted decision (no production data exists yet) — logged here
as a known limitation/TODO, not a gap to close now: if this ever matters,
a future change would need an explicit claiming mechanism (e.g. "first
visitor after the change becomes owner").

## API changes

| Route | Gating |
|---|---|
| `POST /api/listeners` | Ungated (creates). Records the caller's current `session_id` as the new listener's `owner_session`. |
| `GET /api/listeners/:id` | **Gated** — 404 unless `owner_session` matches the caller's session. |
| `GET /api/listeners/:id/requests` | **Gated**, same rule. |
| `DELETE /api/listeners/:id` | **Gated**, same rule. |
| `POST /api/listeners/:id/share` | **Gated**, same rule. |
| `DELETE /api/listeners/:id/share` | **Gated**, same rule. |
| `ALL /hook/:id` | Ungated — unaffected by this change. |
| `GET /api/shared/:token/requests` | Ungated — unaffected by this change, remains a pure bearer token route. |

All five gated routes resolve the listener via a new repository function,
`getListenerForOwner(db, id, sessionId)`, which matches on **both** `id`
and `owner_session` in a single query. If the id doesn't exist, or exists
but belongs to a different session, the function returns nothing either
way — there is exactly one code path for "not found" and "not yours,"
which is what makes the identical 404 response a structural guarantee
rather than something each route has to remember to enforce consistently.

## Error handling

A non-owner request (wrong session, or no session at all — e.g. a fresh
incognito window) to any gated route gets the exact same
`404 {"error":"listener not found"}` response an actually-nonexistent
listener would. This reuses the frontend's existing "not found/unreachable"
inline error path and repeated-404-stops-polling logic (already built for
the deleted-listener case) with no frontend code changes required.

## Testing

- **Backend unit tests** (Vitest): session cookie is set on a request with
  none, and persists across subsequent requests in the same test via
  `app.inject()`'s cookie jar support. A listener created under session A
  is invisible (404) to session B on every gated route. The hook route and
  the shared route remain accessible with no session cookie at all. A
  listener with `owner_session = NULL` (simulating a pre-migration row) is
  inaccessible to any session, including the one that "created" it via a
  direct repo call bypassing the API.
- **Manual/E2E verification note**: `curl` does not persist cookies across
  separate invocations by default. Verification steps must use
  `-c cookiejar -b cookiejar` (or an equivalent single cookie jar) to
  simulate one continuous browser session — otherwise every `curl` call
  looks like a fresh anonymous visitor and gets locked out immediately
  after "creating" a listener in a prior call.
- **Frontend**: no automated tests (established project scope) — manual
  verification: create a listener in one browser, confirm a different
  browser/incognito window gets "not found" at the same URL, confirm the
  share link still works cross-browser.

## Out of scope

- Any migration/grandfathering for listeners created before this change
  (see Data model section — explicitly deferred, not silently ignored).
- Persisting "my listeners" across a session for a future home-page
  listing feature — this session concept enables that later, but building
  it is not part of this change.
- Any real user accounts, login, or multi-device sync of ownership — the
  session is anonymous and tied to one browser's cookie jar, exactly like
  every other capability token in this app.
