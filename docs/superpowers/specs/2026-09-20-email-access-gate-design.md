# Email access gate — design

Date: 2026-09-20

## Why

`webhook-listener` is no longer a local-only, single-user tool — it's
deployed to Cloudflare Workers at `webhook.fde.nice-agentic.com`
(`docs/superpowers/specs/2026-09-17-cloudflare-workers-migration-design.md`),
publicly reachable on the internet. The existing access model
(`docs/superpowers/specs/2026-09-17-session-scoped-ownership-design.md`)
assumes "no real auth is needed, an anonymous per-browser session is
enough" — that assumption no longer holds once the app is reachable by
anyone, not just its one local user.

This feature adds a magic-link email gate restricted to allow-listed
domains (`nice.com`, `cognigy.com` by default) in front of the entire
app UI, and — because the user wants a magic link to return them to
their own listeners from *any* browser or device — upgrades listener
ownership from "the browser session that created it" to "the verified
email that created it." This supersedes the identity portion of the
session-scoped-ownership spec (session cookies no longer determine
ownership) while leaving that spec's *mechanics* section (cookie
plumbing pattern, "one query, one code path for not-found-or-not-
yours") as the template this feature follows for its own gating logic.

## Access model (supersedes the three-tier model for identity purposes)

There are now four tiers, one of which is new and sits in front of the
other three:

0. **Verified identity** (new) — a signed `wl_email_session` cookie
   proving this browser completed a magic-link challenge for an
   allow-listed email address. Required to reach **any** UI route:
   home (`/`), owner view (`/listener/:id`), and read-only share view
   (`/shared/:token`) all require it. Without a valid cookie, the
   frontend shows an email-entry gate screen instead of the requested
   route — this applies uniformly, including to share links opened by
   someone outside the allow-listed domains. That is intentional, not
   an accepted side effect: restricting the whole app to the
   allow-listed domains is the explicit point of this feature, so a
   share link is not a bypass.
1. **Owner access** (changed) — no longer keyed by browser session.
   A listener's owner is the verified email that created it
   (`listeners.owner_email`). The same person can view/manage the same
   listeners from a different browser or device once they've verified
   there too. `wl_session_id` (the old anonymous session cookie) is no
   longer used for ownership and can be removed once this ships — the
   new email session cookie is the only identity mechanism going
   forward.
2. **Read-only share access** (unchanged in mechanism, changed in
   reachability) — `/shared/:token` remains a pure bearer token, not
   tied to the viewer's specific email. Any verified (allow-listed
   domain) session can use any share token it has, exactly as today.
   The only change is tier 0 gating who can reach it at all.
3. **Webhook capture** (unchanged) — `ALL /hook/:id` remains fully
   open: no session cookie, no email verification, no domain check.
   Webhook senders are not browsers and must be able to post
   regardless of who's currently logged in where. This route is
   explicitly exempt from every check this feature adds.

## Existing listeners

Listeners created under the old `owner_session` model become
permanently inaccessible once this ships — same precedent as the
session-scoped-ownership spec's own treatment of pre-migration rows.
No claiming mechanism, no migration. This is an explicit, accepted
decision: the tool has no meaningful production data volume yet and a
claiming flow is not worth the complexity it would add.

## Data model changes

```sql
-- New migration, e.g. 0004_owner_email.sql
ALTER TABLE listeners ADD COLUMN owner_email TEXT;
-- owner_session is no longer read by any code path after this ships;
-- dropped in the same migration since D1's SQLite version supports
-- DROP COLUMN and there's no reason to carry a dead column.
ALTER TABLE listeners DROP COLUMN owner_session;
```

```sql
-- New migration, e.g. 0005_magic_links.sql
CREATE TABLE magic_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,  -- SHA-256 of the raw token; raw token is never stored
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,         -- ISO 8601, created_at + 15 minutes
  used_at TEXT,                     -- NULL until consumed; set exactly once
  created_at TEXT NOT NULL
);

CREATE INDEX idx_magic_links_email ON magic_links(email);
```

`getListenerForOwner(db, id, email)` and `getListenersForOwner(db,
email)` (the plural function added for the home-page listener list)
are updated to match on `owner_email` instead of `owner_session`. Same
one-query, one-code-path shape as before — a wrong email and a
nonexistent listener id both resolve to nothing, so the identical 404
response stays a structural guarantee, not something each route has to
remember.

## Session mechanism

- `wl_email_session` cookie: `httpOnly`, `Secure`, `SameSite=Lax`,
  `Domain=fde.nice-agentic.com`, `maxAge` 30 days.
- **Stateless, HMAC-signed.** Payload is `email` + `expiresAt`,
  serialized and signed with HMAC-SHA256 using a server secret
  (`WL_SESSION_SECRET`, a Wrangler secret — never checked into the
  repo). Verifying a request means recomputing the signature over the
  claimed payload and checking it matches, then checking `expiresAt`
  hasn't passed. No session table, no per-device revocation — the only
  way to invalidate all sessions at once is rotating
  `WL_SESSION_SECRET`, which logs every device out simultaneously.
  Accepted trade-off, consistent with this project's pattern of
  choosing simplicity over defense-in-depth at this tool's stakes
  (same reasoning the original unsigned `wl_session_id` cookie used,
  just resolved differently now that real identity is at stake instead
  of an anonymous capability token).
- A device verifying a fresh magic link always gets a brand new 30-day
  cookie — there's no cross-device session table to look up, so
  "signed in on 3 devices" is simply "3 independent cookies, each
  proving the same email, each expiring independently."

## Magic-link flow

**Requesting a link** — `POST /auth/request-link { email }` on
`webhook-api`:
1. Validate `email`'s domain against `ALLOWED_EMAIL_DOMAINS` (see
   Configuration below). Reject with `400` if not allow-listed — no
   attempt to hide this from the requester; the domain restriction is
   the whole point of the feature, not something to obscure.
2. Rate limit: if `magic_links` already has an unexpired, unused
   (`used_at IS NULL AND expires_at > now`) row for this email, reject
   with `429` rather than issuing another token. Cheap insurance
   against accidental spam-clicking; not a security control.
3. Generate a random token (`crypto.randomUUID()`, matching this
   repo's existing token-generation convention for listener ids and
   share tokens). Store `SHA-256(token)` in `magic_links` — the raw
   token is never persisted, only ever transmitted once inside the
   emailed link — with `expires_at` = now + 15 minutes.
4. Send the email via Resend's HTTP API (`fetch` from the Worker, no
   SMTP): from `noreply@fde.nice-agentic.com`, containing
   `https://webhook-api.fde.nice-agentic.com/auth/verify?token=<raw token>`.
5. Respond `200` with a generic "check your email" body regardless of
   whether the address exists in any prior state — there's no prior
   "account" to leak the existence of, since email *is* the identity
   and nothing is provisioned ahead of a successful verify.

**Completing verification** — `GET /auth/verify?token=` on
`webhook-api`:
1. Hash the incoming token, look up `magic_links` where
   `token_hash` matches, `used_at IS NULL`, `expires_at > now`.
2. Not found / expired / already used → `302` redirect to
   `https://webhook.fde.nice-agentic.com/?authError=invalid_link`, and
   the frontend shows an inline message prompting the user to request
   a new one.
3. Found and valid → set `used_at = now` (single-use, enforced at
   consumption time so a raced double-click can't verify twice), issue
   the `wl_email_session` cookie for that email, `302` redirect to
   `https://webhook.fde.nice-agentic.com/`.

**Checking / clearing the session:**
- `GET /auth/me` → `{ email }` if the cookie is present and valid,
  `401` otherwise. The frontend's gate component calls this on load to
  decide whether to show the app or the email-entry screen.
- `POST /auth/logout` → clears the cookie. No server-side state to
  clean up (stateless session), so this is purely "expire the cookie
  client-side."

## Configuration

- `ALLOWED_EMAIL_DOMAINS` — comma-separated list (default
  `nice.com,cognigy.com`), a Wrangler var on the `webhook-api` Worker.
  Changing it requires a redeploy; no admin UI, no DB-backed allowlist.
  This applies identically to who can *request* a magic link and (via
  the tier-0 gate) who can *use* the app once verified — there's no
  separate "who can be emailed" vs. "who can log in" distinction to
  configure.
- `WL_SESSION_SECRET` — Wrangler secret, HMAC key for session cookies.
- `RESEND_API_KEY` — Wrangler secret.
- Sending address `noreply@fde.nice-agentic.com` is hardcoded in the
  Resend call (not worth an env var — changing the "from" address is
  rare enough, and tied to Resend domain verification, that a code
  change is fine).

**Prerequisite (manual, outside this plan's scope):** a Resend account
must exist with `fde.nice-agentic.com` (or `nice-agentic.com`)
verified as a sending domain, and an API key generated, before
implementation can be end-to-end tested. Same pattern as the Cloudflare
account/zone setup the Workers migration spec treated as a precondition
rather than an implementation step.

## API changes summary

| Route | Change |
|---|---|
| `POST /auth/request-link` | New. Ungated (that's the entry point). |
| `GET /auth/verify` | New. Ungated (that's the entry point). |
| `GET /auth/me` | New. Reads the session cookie; no gate to fail. |
| `POST /auth/logout` | New. Reads/clears the session cookie. |
| `POST /api/listeners` | Gated by tier-0 (valid session required). Records the verified email as `owner_email`. |
| `GET /api/listeners` | Gated by tier-0. Filters by `owner_email` instead of `owner_session`. |
| `GET /api/listeners/:id` | Gated by tier-0 **and** owner match (`owner_email`). |
| `GET /api/listeners/:id/requests` | Gated by tier-0 **and** owner match. |
| `DELETE /api/listeners/:id` | Gated by tier-0 **and** owner match. |
| `POST /api/listeners/:id/share` | Gated by tier-0 **and** owner match. |
| `DELETE /api/listeners/:id/share` | Gated by tier-0 **and** owner match. |
| `GET /api/shared/:token/requests` | Gated by tier-0 only (any valid verified session, not owner-matched — bearer token semantics unchanged). |
| `ALL /hook/:id` | **Unchanged, exempt from every check added here.** |

The tier-0 check is implemented once, as Hono middleware applied to
every route group above except `/auth/*` and `/hook/:id` — not
repeated per-handler — following the same "one code path" principle
`getListenerForOwner` already established.

## Frontend changes

- A gate component wraps the router (above `AppLayout`, so it applies
  to all three routes uniformly): calls `GET /auth/me` on mount. While
  pending, show nothing/a spinner. If unauthenticated, render an
  email-entry form (`POST /auth/request-link`) and, after submission, a
  "check your email" state — no route content renders underneath.
- Landing from a verify redirect: read `?authError=invalid_link` (or
  absence of it, on success) to show an inline error/success message
  on first paint, then clear the query param.
- `AppLayout`'s header gains "signed in as `<email>`" plus a sign-out
  button (`POST /auth/logout` then reload), next to the existing
  settings cog. This is new user-facing surface not explicitly
  requested, included because "how do I know who I'm signed in as, or
  sign out" is an unavoidable question once real identity exists —
  flagged here in case it should be trimmed.
- No changes to `RequestRow.tsx`, `prettyPrint.ts`, or any of the
  settings/formatter work — this feature is orthogonal to that in-
  progress plan.

## Error handling

- Missing/invalid/expired `wl_email_session` on a gated route →
  backend returns `401 {"error":"unauthorized"}`; frontend's gate
  component treats any `401` from any API call the same way it treats
  `GET /auth/me` returning `401` — drop back to the email-entry screen.
- Wrong-owner-email on an owner route → same `404` as a nonexistent
  listener, exactly as the session-scoped-ownership spec established
  (no distinction between "not yours" and "doesn't exist").
- Non-allow-listed domain on `/auth/request-link` → `400` with an
  explicit message naming the allowed domains — not obscured, since
  the restriction itself is not a secret.
- Expired/used/invalid token on `/auth/verify` → redirect with
  `?authError=invalid_link` rather than a raw error page, so the user
  lands somewhere actionable (re-enter email) instead of a dead end.

## Testing

- **Backend** (`@cloudflare/vitest-pool-workers`, matching the
  Workers-migration spec's test setup): domain allow-list rejection on
  `/auth/request-link`; rate-limit rejection on a second request while
  a token is outstanding; token consumption is single-use (second use
  of the same token fails); expired tokens are rejected; a valid
  verify sets a cookie whose signature/expiry check passes on a
  subsequent request; a tampered cookie (flipped byte) fails
  verification; `owner_email`-based ownership — listener created under
  email A is invisible (404) under email B's session, and visible again
  under a *new* session independently re-verified for email A (proving
  cross-device access is genuinely email-keyed, not accidentally still
  session-keyed); `/hook/:id` remains fully reachable with zero
  cookies of any kind present; `/shared/:token` requires *a* valid
  verified session but not a matching owner.
- **Frontend**: no automated tests (established project scope).
  Manual verification: request a link for an allow-listed address,
  click it, confirm landing on the home page signed in; request one
  for a non-allow-listed address, confirm the `400` message; open the
  app in a second browser profile, verify the same email, confirm the
  same listeners appear; sign out, confirm the gate reappears; open a
  share link with no session cookie, confirm the gate appears instead
  of the shared view; open a share link after verifying, confirm it
  works regardless of whose listener it is.

## Out of scope

- Any admin UI for managing the domain allowlist — it's a Wrangler var,
  changed by editing config and redeploying.
- OAuth/SSO — magic link only.
- Per-device/per-session revocation — the stateless signing trade-off
  means "log out everywhere" only exists in the form of rotating
  `WL_SESSION_SECRET`.
- Any migration/claiming path for listeners owned under the old
  `owner_session` model.
- Any change to `/hook/:id`'s behavior, contract, or auth status.
- Any interaction with the in-progress settings/formatter plan
  (`docs/superpowers/plans/2026-09-20-settings-and-formatter.md`) —
  fully orthogonal, no shared files.
