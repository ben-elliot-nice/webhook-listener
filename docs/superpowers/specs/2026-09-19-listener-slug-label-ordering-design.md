# Custom Slug, Label & Listener Ordering — Design Spec

Date: 2026-09-19

## Purpose

Three related additions to listener identity and organization, requested
together because they touch the same `listeners` table and the same
Home-page list view:

1. A **custom slug** an owner can set in place of the UUID for a listener's
   hook (capture) URL, guarded by a generated auth token since a
   user-chosen slug is far more guessable than a random UUID.
2. A **label** field so owners can name their listeners for organization,
   shown on both the listener page and the Home-page list.
3. Making the Home-page listener list **orderable** by date, name, recent
   activity, or a manually dragged custom order.

## Security context (why the slug needs a token)

Today, `/hook/:id` has no auth check — the random UUID `id` itself is the
capability token; anyone who knows it can POST to it (see `HANDOFF.md`'s
"Access model" section). A user-chosen slug is low-entropy compared to a
UUID and may be guessed, observed in a URL bar, or otherwise discovered.
To avoid weakening the hook endpoint's security when a slug is used, a
slug-based hook URL additionally requires a secret `X-Webhook-Token`
header that the URL itself never reveals. The UUID hook URL keeps its
current no-auth behavior unchanged — this feature is fully additive to
listeners that never set a slug.

**Decision: setting a slug disables the UUID hook URL for that listener**
(not both-active). Once a slug is set, `/hook/:uuid` 404s for that
listener; only `/hook/:slug` (with the correct token) delivers. This is a
deliberate breaking change for that listener's existing senders — the
owner must reconfigure them when they add a slug. Removing the slug later
reactivates the UUID URL.

## 1. Data model

New migration `backend/migrations/0004_slug_label_ordering.sql`:

```sql
ALTER TABLE listeners ADD COLUMN slug TEXT;
ALTER TABLE listeners ADD COLUMN webhook_token TEXT;
ALTER TABLE listeners ADD COLUMN label TEXT;
ALTER TABLE listeners ADD COLUMN last_request_at TEXT;
ALTER TABLE listeners ADD COLUMN sort_position INTEGER;

CREATE UNIQUE INDEX idx_listeners_slug
  ON listeners(slug)
  WHERE slug IS NOT NULL;
```

- `slug` — nullable, normalized kebab-case, globally unique when set (a
  shared namespace across all owners — required by construction, since
  `/hook/:slug` must resolve unambiguously to one listener).
- `webhook_token` — nullable, a UUIDv4, present only when `slug` is set.
  Generated the first time a slug is set on a listener; persists across
  slug value changes; only changes via explicit rotation.
- `label` — nullable, free text, capped at 100 chars. Fully independent of
  slug — applies equally to UUID-only and slugged listeners.
- `last_request_at` — nullable, denormalized. Updated by `insertRequest`
  in the same batch that already prunes old rows for retention, so
  sorting by activity doesn't require a join/aggregate over `requests` at
  read time.
- `sort_position` — nullable until first manually dragged; assigned
  lazily (append-to-end, `MAX(sort_position)+1` scoped per owner) rather
  than backfilled for existing rows.

## 2. Backend

### Hook lookup (`backend/src/routes/hook.ts`)

Replaces the current single `getListener(id)` call with:

1. Look up by `slug`. If found: require `X-Webhook-Token` header to equal
   `webhook_token` exactly. Mismatch or missing header → `404 { error:
   'listener not found' }` (same response as true not-found — no signal
   leak either way, per design decision). Match → capture as today.
2. Else look up by `id` (UUID). Found **and `slug IS NULL`** → capture, no
   auth, unchanged from today. Found **but `slug` is set** → `404` (UUID
   access disabled once a slug exists).
3. Else `404`.

### New owner-only routes (`backend/src/routes/listeners.ts`)

All require the existing `getListenerForOwner` ownership check (same
pattern as delete/share):

- `PUT /api/listeners/:id/slug` `{ slug }` — normalizes input server-side:
  lowercase, spaces/underscores → hyphens, strip any other invalid
  character, collapse repeated hyphens, trim leading/trailing hyphens,
  enforce 3–63 chars after normalization. `400` if empty after
  normalization or out of length bounds. `409` on collision with another
  listener's slug (global uniqueness). Generates `webhook_token` only if
  this listener doesn't already have one (changing an existing slug's
  value does not rotate the token). Returns `{ slug, webhookToken,
  hookUrl }`.
- `POST /api/listeners/:id/slug/rotate-token` — `400` if no slug set yet,
  else regenerates `webhook_token` (old one invalid immediately), returns
  the new token.
- `DELETE /api/listeners/:id/slug` — clears `slug` and `webhook_token`;
  `hookUrl` in subsequent responses reverts to the UUID form.
- `PATCH /api/listeners/:id/label` `{ label }` — sets/clears (empty string
  clears) label. `400` if over 100 chars.
- `POST /api/listeners/reorder` `{ orderedIds: string[] }` — bulk-assigns
  `sort_position` `0..n` for the given ids in the given order, scoped to
  the caller's own listeners. `400` if any id doesn't belong to the
  caller's session.

### List sorting

`GET /api/listeners` gains `?sort=date|name|activity|custom`, default
`date` (matches today's unqualified behavior):

- `date` → `created_at DESC, id DESC` (today's existing order)
- `name` → `COALESCE(label, slug) COLLATE NOCASE ASC`, listeners with
  neither label nor slug sort last by `created_at DESC` as a tiebreak
- `activity` → `last_request_at DESC NULLS LAST`
- `custom` → `sort_position ASC NULLS LAST, created_at DESC`

## 3. Frontend — Listener page

- Inline-editable label at the top of `Listener.tsx` (click to edit, same
  interaction pattern as the existing Share section).
- New "Custom slug" section, parallel to the existing Share section:
  - No slug set: text input + "Set slug" button. On success, shows the
    resulting hook URL and the generated token.
  - Slug set: shows the slug-based hook URL (replacing the UUID hook URL
    box, since UUID access is disabled once a slug exists), existing
    "Copy hook URL" button, and a new **"Copy header JSON"** button that
    copies:
    ```json
    { "X-Webhook-Token": "<token>" }
    ```
  - "Rotate token" and "Remove slug" actions, each behind a confirm
    dialog (both are destructive to the live hook configuration).
- `api.ts` additions: `setSlug`, `rotateWebhookToken`, `removeSlug`,
  `setLabel`. `Listener` interface gains `slug: string | null`,
  `webhookToken: string | null`, `label: string | null`.

## 4. Frontend — Home page list

- Each row's primary text: `label ?? slug ?? formatted date`, with the
  creation date always shown as secondary text regardless of which one
  wins.
- A sort-mode control (Date / Name / Recent activity / Custom) driving
  `GET /api/listeners?sort=...`; selection persisted in `localStorage`
  only (no backend setting needed, consistent with the frontend-only
  precedent already established by the parked
  `2026-09-17-settings-and-diff-only-mode-design.md` spec).
- When "Custom" is active: drag handles appear using the native HTML5
  drag-and-drop API (`draggable`, `onDragStart`/`onDragOver`/`onDrop`) —
  no new dependency; this app has no drag library today and list sizes
  (tens of rows, personal tool) don't warrant one. Dropping a row
  reorders local state optimistically and fires `POST
  /api/listeners/reorder` with the full new id order; on failure, revert
  to the last known server order and show an inline error.

## 5. Testing

Backend (vitest, matching existing `*.repo.test.ts` / `app.test.ts`
patterns):

- `listeners.repo.test.ts`: slug normalization edge cases, uniqueness
  collision, token generation/rotation, label set/clear,
  `last_request_at` update on insert, sort-position assignment/reorder.
- Hook route tests: UUID-only hook still works with no header; slug hook
  rejects missing/wrong token with 404; slug hook accepts correct token;
  UUID hook 404s once a listener has a slug.
- Listener route tests: slug set/rotate/remove/label endpoints, ownership
  enforcement (can't touch another session's listener), 409 on slug
  collision, all four `?sort=` variants.

Frontend: no automated test suite (established project precedent) —
manual verification: set a slug, confirm UUID hook URL 404s and slug URL
works only with the correct header, copy-header-JSON button copies valid
JSON, rotate token invalidates the old one, remove slug reverts to UUID
access, label displays/edits/falls back correctly, all four sort modes
reorder the list correctly, drag-and-drop persists across a page reload.

## Out of scope

- Multiple slugs per listener (one active slug at a time).
- Slug history/redirects — changing a slug does not keep the old one
  working.
- Rate-limiting or logging failed token attempts, beyond the existing
  implicit 404.
- Any change to the share-link (`/shared/:token`) flow — untouched by
  this feature.
</content>
