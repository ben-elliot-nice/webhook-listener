# Shareable Read-Only View — Design Spec

Date: 2026-09-16

## Purpose

Let a listener's owner share its captured request history with someone else (a
teammate debugging the same integration) via a link that grants view-only
access — no delete capability, no ability to see or use the actual webhook
hook URL.

## Access model

This introduces a second tier to the existing "UUID is the access control"
model (see `docs/superpowers/specs/2026-09-16-webhook-listener-design.md`):

- **Owner access** (existing): the listener's UUID, via `/listener/:id`. Full
  control — view history, delete the listener, manage the share link.
- **Read-only access** (new): a separate `share_token`, via `/shared/:token`.
  View history only. Every app-generated field in the read-only view's API
  responses (listener metadata, request id/method/contentType/sourceIp/
  receivedAt) never exposes the listener's real UUID, so a read-only link
  can never itself be used to derive owner access. This guarantee does not
  extend to sender-supplied content: if a webhook sender includes its own
  target URL (and therefore the listener's UUID) inside a captured header,
  query parameter, or body, that value is captured and shown verbatim to
  read-only viewers, same as it is to the owner. Sharing a listener means
  trusting the read-only viewer with whatever senders actually transmitted
  to it — this is an accepted trust boundary of the feature, not a gap to
  close by filtering captured payload content (which would be brittle and
  would corrupt legitimate captured data).

The share token is generated on demand (not automatically at listener
creation) and is revocable — revoking clears the token, so previously shared
links stop working immediately. Generating a new link after a revoke
produces a new, different token.

## Data model changes

```sql
ALTER TABLE listeners ADD COLUMN share_token TEXT UNIQUE;
```

Since the existing schema is applied via `CREATE TABLE IF NOT EXISTS` (a
no-op against an already-existing database file), `db.ts` needs a small
migration step at startup: check `PRAGMA table_info(listeners)` for a
`share_token` column, and run the `ALTER TABLE` above only if it's missing.
SQLite permits multiple `NULL` values under a `UNIQUE` constraint, so
listeners that have never been shared are unaffected.

`share_token` is a UUID v4, generated the same way listener ids are — the
existing "UUID as capability" security model (unguessable, high-entropy)
extends naturally to it.

## API changes

| Method | Path | Description |
|---|---|---|
| POST | `/api/listeners/:id/share` | Get-or-create the share token for this listener (idempotent — repeat calls return the existing token if one is already set). Returns `{ shareToken, shareUrl }` where `shareUrl` is `BASE_URL + /shared/:shareToken`. 404 if the listener doesn't exist. |
| DELETE | `/api/listeners/:id/share` | Revoke the share token (sets `share_token` back to `NULL`). 204. 404 if the listener doesn't exist. |
| GET | `/api/listeners/:id` | (existing, modified) response gains one field: `shareUrl: string \| null` — built from the listener's current `share_token` if set, else `null`. |
| GET | `/api/shared/:token/requests` | The read-only view's only data endpoint. Looks up the listener by `share_token`; 404 if the token is invalid or has been revoked. Returns the same request-history array shape as `GET /api/listeners/:id/requests`. The response never includes the listener's real UUID. |

No delete or mutation capability exists under `/api/shared/*` — there is no
route to gate, not a permission check to bypass.

## Frontend changes

- New route `/shared/:token` → new page `SharedListener.tsx`. Reuses the
  existing `RequestRow`, `RequestFilters`, and export (`toJsonExport`/
  `toHarExport`) functions/components as-is (all already pure/presentational
  and take data as props). Polls `GET /api/shared/:token/requests` on the
  same 3s interval and repeated-404-stops-polling logic already used by the
  owner page (a revoked token behaves identically to a deleted listener from
  the viewer's point of view). No delete button, no hook URL shown, no share
  management controls.
- Existing `Listener.tsx` (owner page) gains a small "Share" section: if
  `listener.shareUrl` is set, shows it with a copy button and a "Revoke share
  link" button; otherwise shows a single "Get share link" button. Both call
  new `api.ts` functions and then re-`refresh()` so the displayed state stays
  in sync.
- `api.ts` additions: `Listener` interface gains `shareUrl: string | null`;
  new functions `getOrCreateShareLink(id): Promise<{ shareToken: string;
  shareUrl: string }>`, `revokeShareLink(id): Promise<void>`,
  `getSharedRequests(token): Promise<CapturedRequest[]>`.

## Error handling

Consistent with the existing app: `404` responses render the same "not
found/unreachable" inline error pattern already used by the owner page. The
shared view's polling stops after 2 consecutive 404s, exactly like the owner
page's existing logic for a deleted listener.

## Testing

- **Backend unit tests** (Vitest): share-token get-or-create idempotency,
  revoke, 404 on an invalid/revoked token, and a test confirming
  `GET /api/shared/:token/requests`'s response never contains the listener's
  real UUID anywhere in the payload.
- **Frontend**: no automated tests (established project scope) — manual
  verification of both the owner-side share controls and the read-only page.

## Out of scope

- Expiring share links automatically (they last as long as the listener does,
  or until manually revoked).
- Multiple share links per listener (one active token at a time; revoking and
  re-generating replaces it).
- Any write/mutate capability on the shared view (already covered above, but
  explicit: this is strictly read-only, by construction, not by a permission
  check that could be bypassed).
- Scrubbing or filtering sender-supplied header/query/body content for
  UUID-shaped substrings before showing it to read-only viewers (see "Access
  model" above — this is an accepted trust boundary, not a gap).
