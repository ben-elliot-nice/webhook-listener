# Listener Slug, Label & Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let listener owners set a custom URL slug (token-gated) in place of the UUID hook URL, label their listeners, and sort/reorder the Home-page listener list.

**Architecture:** Additive columns on the existing `listeners` D1 table (`slug`, `webhook_token`, `label`, `last_request_at`, `sort_position`), new repo functions in `backend/src/listeners.repo.ts`, a modified hook-lookup path in `backend/src/routes/hook.ts` that checks slug + token before falling back to UUID, five new owner-only routes in `backend/src/routes/listeners.ts`, and frontend additions to `Listener.tsx` (slug/label management UI) and `Home.tsx` (sort control + drag-to-reorder).

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), `@cloudflare/vitest-pool-workers` + vitest (backend tests), React + Vite + Tailwind (frontend, no automated test suite — manual verification only, per established project precedent).

**Spec:** `docs/superpowers/specs/2026-09-19-listener-slug-label-ordering-design.md`

## Global Constraints

- Slug: normalized to lowercase kebab-case (spaces/underscores → hyphens, invalid chars stripped, repeated hyphens collapsed, leading/trailing hyphens trimmed), 3–63 characters after normalization, globally unique across all owners.
- Label: free text, optional, ≤100 characters, fully independent of slug (applies to UUID-only and slugged listeners alike).
- Setting a slug on a listener disables `/hook/:uuid` for that listener; removing the slug reactivates it. Only one active slug per listener at a time.
- `webhook_token` is generated exactly once per slug "lifetime" (first time a slug is set on a listener) and only changes via an explicit rotate action — changing the slug's text value does not rotate the token.
- A request to `/hook/:slug` with a missing or wrong `X-Webhook-Token` header returns the exact same `404 { error: 'listener not found' }` as a nonexistent listener — no signal leak either way.
- No new frontend dependencies — drag-to-reorder uses the native HTML5 Drag and Drop API.
- Sort-mode selection is persisted in `localStorage` only; there is no backend setting for it.
- All new owner-only routes must use the existing `getListenerForOwner` ownership check before mutating anything (same pattern as delete/share).

---

## Task 1: Migration + repo layer — slug, label, token

**Files:**
- Create: `backend/migrations/0004_slug_label_ordering.sql`
- Modify: `backend/src/listeners.repo.ts`
- Modify: `backend/src/listeners.repo.test.ts`

**Interfaces:**
- Produces: `ListenerRecord` gains `slug: string | null`, `webhookToken: string | null`, `label: string | null`, `lastRequestAt: string | null`, `sortPosition: number | null`.
- Produces: `normalizeSlug(raw: string): string`
- Produces: `class SlugValidationError extends Error {}`
- Produces: `class SlugConflictError extends Error {}`
- Produces: `class LabelValidationError extends Error {}`
- Produces: `setListenerSlug(db: Env['DB'], id: string, rawSlug: string): Promise<{ slug: string; webhookToken: string }>` — throws `SlugValidationError` on bad input, `SlugConflictError` on collision. Caller must have already verified the listener exists/is owned (mirrors how `deleteListener`/`revokeShareToken` are called after an ownership check).
- Produces: `getListenerBySlug(db: Env['DB'], slug: string): Promise<ListenerRecord | undefined>`
- Produces: `rotateWebhookToken(db: Env['DB'], id: string): Promise<string | undefined>` — `undefined` if the listener has no slug set.
- Produces: `removeListenerSlug(db: Env['DB'], id: string): Promise<boolean>`
- Produces: `setListenerLabel(db: Env['DB'], id: string, label: string): Promise<string | null>` — throws `LabelValidationError` if over 100 chars; returns `null` when the label is cleared (empty string).
- Produces: `resolveListenerForHook(db: Env['DB'], pathParam: string, providedToken: string | undefined): Promise<ListenerRecord | undefined>` — the single source of truth for the hook route's lookup rule (Task 2 consumes this directly, no lookup logic duplicated in the route).

- [ ] **Step 1: Write the migration**

Create `backend/migrations/0004_slug_label_ordering.sql`:

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

This is picked up automatically by `backend/vitest.config.ts`'s `readD1Migrations` — no other wiring needed for tests. For the deployed database, this task does not run `db:migrate:remote` (that happens at deploy time, out of scope for this plan — flag it to the user before deploying).

- [ ] **Step 2: Write failing repo tests for slug normalization, creation, and lookup**

Add to `backend/src/listeners.repo.test.ts` (new imports alongside the existing ones at the top: `normalizeSlug, setListenerSlug, getListenerBySlug, SlugValidationError, SlugConflictError`):

```ts
describe('normalizeSlug', () => {
  it('lowercases and hyphenates spaces/underscores', () => {
    expect(normalizeSlug('Stripe_Prod')).toBe('stripe-prod')
    expect(normalizeSlug('My Webhook 2')).toBe('my-webhook-2')
  })

  it('strips invalid characters and collapses/trims hyphens', () => {
    expect(normalizeSlug('--My!!Webhook--')).toBe('mywebhook')
    expect(normalizeSlug('a__b   c')).toBe('a-b-c')
  })
})

describe('setListenerSlug', () => {
  it('sets a normalized slug and generates a webhook token', async () => {
    await createListener(env.DB, 'listener-slug-1', '2024-01-01T00:00:00.000Z', 'session-a')
    const result = await setListenerSlug(env.DB, 'listener-slug-1', 'Stripe_Prod')
    expect(result.slug).toBe('stripe-prod')
    expect(result.webhookToken).toBeTypeOf('string')

    const found = await getListenerBySlug(env.DB, 'stripe-prod')
    expect(found?.id).toBe('listener-slug-1')
    expect(found?.webhookToken).toBe(result.webhookToken)
  })

  it('reuses the existing token when the slug value is changed', async () => {
    await createListener(env.DB, 'listener-slug-2', '2024-01-01T00:00:00.000Z', 'session-a')
    const first = await setListenerSlug(env.DB, 'listener-slug-2', 'first-slug')
    const second = await setListenerSlug(env.DB, 'listener-slug-2', 'second-slug')
    expect(second.webhookToken).toBe(first.webhookToken)
  })

  it('rejects a slug that normalizes below the minimum length', async () => {
    await createListener(env.DB, 'listener-slug-3', '2024-01-01T00:00:00.000Z', 'session-a')
    await expect(setListenerSlug(env.DB, 'listener-slug-3', 'ab')).rejects.toThrow(SlugValidationError)
  })

  it('rejects an empty-after-normalization slug', async () => {
    await createListener(env.DB, 'listener-slug-4', '2024-01-01T00:00:00.000Z', 'session-a')
    await expect(setListenerSlug(env.DB, 'listener-slug-4', '!!!')).rejects.toThrow(SlugValidationError)
  })

  it('rejects a slug already used by another listener', async () => {
    await createListener(env.DB, 'listener-slug-5', '2024-01-01T00:00:00.000Z', 'session-a')
    await createListener(env.DB, 'listener-slug-6', '2024-01-01T00:00:00.000Z', 'session-b')
    await setListenerSlug(env.DB, 'listener-slug-5', 'taken-slug')
    await expect(setListenerSlug(env.DB, 'listener-slug-6', 'taken-slug')).rejects.toThrow(SlugConflictError)
  })
})

describe('getListenerBySlug', () => {
  it('returns undefined for an unknown slug', async () => {
    expect(await getListenerBySlug(env.DB, 'no-such-slug')).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && npm test -- listeners.repo.test.ts`
Expected: FAIL — `normalizeSlug`, `setListenerSlug`, `getListenerBySlug`, `SlugValidationError`, `SlugConflictError` are not exported yet.

- [ ] **Step 4: Implement slug normalization, storage, and lookup in the repo**

In `backend/src/listeners.repo.ts`:

1. Extend `ListenerRecord` and `SELECT_COLUMNS`:

```ts
export interface ListenerRecord {
  id: string
  createdAt: string
  shareToken: string | null
  ownerSession: string | null
  slug: string | null
  webhookToken: string | null
  label: string | null
  lastRequestAt: string | null
  sortPosition: number | null
}

const SELECT_COLUMNS =
  'id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession, ' +
  'slug, webhook_token AS webhookToken, label, last_request_at AS lastRequestAt, sort_position AS sortPosition'
```

2. Update `createListener`'s return value to include the new fields as `null`:

```ts
return { id, createdAt, shareToken: null, ownerSession, slug: null, webhookToken: null, label: null, lastRequestAt: null, sortPosition: null }
```

3. Add slug normalization, validation, and errors:

```ts
const MIN_SLUG_LENGTH = 3
const MAX_SLUG_LENGTH = 63

export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export class SlugValidationError extends Error {}
export class SlugConflictError extends Error {}

function assertValidSlug(slug: string): void {
  if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH) {
    throw new SlugValidationError(
      `slug must be between ${MIN_SLUG_LENGTH} and ${MAX_SLUG_LENGTH} characters after normalization`
    )
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed')
}
```

4. Add `setListenerSlug`, `getListenerBySlug`:

```ts
export async function setListenerSlug(
  db: Env['DB'],
  id: string,
  rawSlug: string
): Promise<{ slug: string; webhookToken: string }> {
  const slug = normalizeSlug(rawSlug)
  assertValidSlug(slug)

  const listener = await getListener(db, id)
  const webhookToken = listener?.webhookToken ?? crypto.randomUUID()

  try {
    await db.prepare('UPDATE listeners SET slug = ?, webhook_token = ? WHERE id = ?').bind(slug, webhookToken, id).run()
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new SlugConflictError(`slug "${slug}" is already in use`)
    }
    throw err
  }

  return { slug, webhookToken }
}

export async function getListenerBySlug(db: Env['DB'], slug: string): Promise<ListenerRecord | undefined> {
  const row = await db.prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE slug = ?`).bind(slug).first<ListenerRecord>()
  return row ?? undefined
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npm test -- listeners.repo.test.ts`
Expected: PASS (all `setListenerSlug`/`getListenerBySlug`/`normalizeSlug` tests green, plus every pre-existing test in the file still passing).

- [ ] **Step 6: Write failing tests for token rotation, slug removal, label, and hook resolution**

Add to `backend/src/listeners.repo.test.ts` (add `rotateWebhookToken, removeListenerSlug, setListenerLabel, LabelValidationError, resolveListenerForHook` to the import list):

```ts
describe('rotateWebhookToken', () => {
  it('generates a new token, replacing the old one', async () => {
    await createListener(env.DB, 'listener-rotate-1', '2024-01-01T00:00:00.000Z', 'session-a')
    const { webhookToken: original } = await setListenerSlug(env.DB, 'listener-rotate-1', 'rotate-me')
    const rotated = await rotateWebhookToken(env.DB, 'listener-rotate-1')
    expect(rotated).toBeTypeOf('string')
    expect(rotated).not.toBe(original)
  })

  it('returns undefined when the listener has no slug set', async () => {
    await createListener(env.DB, 'listener-rotate-2', '2024-01-01T00:00:00.000Z', 'session-a')
    expect(await rotateWebhookToken(env.DB, 'listener-rotate-2')).toBeUndefined()
  })
})

describe('removeListenerSlug', () => {
  it('clears slug and token, reporting success', async () => {
    await createListener(env.DB, 'listener-remove-1', '2024-01-01T00:00:00.000Z', 'session-a')
    await setListenerSlug(env.DB, 'listener-remove-1', 'remove-me')
    expect(await removeListenerSlug(env.DB, 'listener-remove-1')).toBe(true)
    const found = await getListener(env.DB, 'listener-remove-1')
    expect(found?.slug).toBeNull()
    expect(found?.webhookToken).toBeNull()
  })

  it('reports failure for an unknown listener', async () => {
    expect(await removeListenerSlug(env.DB, 'does-not-exist')).toBe(false)
  })
})

describe('setListenerLabel', () => {
  it('sets a trimmed label', async () => {
    await createListener(env.DB, 'listener-label-1', '2024-01-01T00:00:00.000Z', 'session-a')
    expect(await setListenerLabel(env.DB, 'listener-label-1', '  Stripe prod  ')).toBe('Stripe prod')
  })

  it('clears the label when given an empty string', async () => {
    await createListener(env.DB, 'listener-label-2', '2024-01-01T00:00:00.000Z', 'session-a')
    await setListenerLabel(env.DB, 'listener-label-2', 'Something')
    expect(await setListenerLabel(env.DB, 'listener-label-2', '')).toBeNull()
  })

  it('rejects a label over 100 characters', async () => {
    await createListener(env.DB, 'listener-label-3', '2024-01-01T00:00:00.000Z', 'session-a')
    await expect(setListenerLabel(env.DB, 'listener-label-3', 'x'.repeat(101))).rejects.toThrow(LabelValidationError)
  })
})

describe('resolveListenerForHook', () => {
  it('resolves by UUID when no slug is set, no token required', async () => {
    await createListener(env.DB, 'listener-hook-1', '2024-01-01T00:00:00.000Z', 'session-a')
    const found = await resolveListenerForHook(env.DB, 'listener-hook-1', undefined)
    expect(found?.id).toBe('listener-hook-1')
  })

  it('resolves by slug when the correct token is provided', async () => {
    await createListener(env.DB, 'listener-hook-2', '2024-01-01T00:00:00.000Z', 'session-a')
    const { slug, webhookToken } = await setListenerSlug(env.DB, 'listener-hook-2', 'hook-slug')
    const found = await resolveListenerForHook(env.DB, slug, webhookToken)
    expect(found?.id).toBe('listener-hook-2')
  })

  it('rejects a slug lookup with a missing token', async () => {
    await createListener(env.DB, 'listener-hook-3', '2024-01-01T00:00:00.000Z', 'session-a')
    const { slug } = await setListenerSlug(env.DB, 'listener-hook-3', 'hook-slug-2')
    expect(await resolveListenerForHook(env.DB, slug, undefined)).toBeUndefined()
  })

  it('rejects a slug lookup with a wrong token', async () => {
    await createListener(env.DB, 'listener-hook-4', '2024-01-01T00:00:00.000Z', 'session-a')
    const { slug } = await setListenerSlug(env.DB, 'listener-hook-4', 'hook-slug-3')
    expect(await resolveListenerForHook(env.DB, slug, 'wrong-token')).toBeUndefined()
  })

  it('rejects UUID lookup once a slug has been set on that listener', async () => {
    await createListener(env.DB, 'listener-hook-5', '2024-01-01T00:00:00.000Z', 'session-a')
    await setListenerSlug(env.DB, 'listener-hook-5', 'hook-slug-4')
    expect(await resolveListenerForHook(env.DB, 'listener-hook-5', undefined)).toBeUndefined()
  })

  it('returns undefined for a path param matching neither slug nor id', async () => {
    expect(await resolveListenerForHook(env.DB, 'nothing-matches', undefined)).toBeUndefined()
  })
})
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd backend && npm test -- listeners.repo.test.ts`
Expected: FAIL — `rotateWebhookToken`, `removeListenerSlug`, `setListenerLabel`, `LabelValidationError`, `resolveListenerForHook` not exported yet.

- [ ] **Step 8: Implement token rotation, slug removal, label, and hook resolution**

Add to `backend/src/listeners.repo.ts`:

```ts
export async function rotateWebhookToken(db: Env['DB'], id: string): Promise<string | undefined> {
  const listener = await getListener(db, id)
  if (!listener?.slug) return undefined
  const token = crypto.randomUUID()
  await db.prepare('UPDATE listeners SET webhook_token = ? WHERE id = ?').bind(token, id).run()
  return token
}

export async function removeListenerSlug(db: Env['DB'], id: string): Promise<boolean> {
  const result = await db.prepare('UPDATE listeners SET slug = NULL, webhook_token = NULL WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

const MAX_LABEL_LENGTH = 100

export class LabelValidationError extends Error {}

export async function setListenerLabel(db: Env['DB'], id: string, rawLabel: string): Promise<string | null> {
  const trimmed = rawLabel.trim()
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new LabelValidationError(`label must be ${MAX_LABEL_LENGTH} characters or fewer`)
  }
  const value = trimmed.length > 0 ? trimmed : null
  await db.prepare('UPDATE listeners SET label = ? WHERE id = ?').bind(value, id).run()
  return value
}

export async function resolveListenerForHook(
  db: Env['DB'],
  pathParam: string,
  providedToken: string | undefined
): Promise<ListenerRecord | undefined> {
  const bySlug = await getListenerBySlug(db, pathParam)
  if (bySlug) {
    if (!bySlug.webhookToken || providedToken !== bySlug.webhookToken) return undefined
    return bySlug
  }

  const byId = await getListener(db, pathParam)
  if (byId && !byId.slug) return byId

  return undefined
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd backend && npm test -- listeners.repo.test.ts`
Expected: PASS — every test in the file green.

- [ ] **Step 10: Commit**

```bash
git add backend/migrations/0004_slug_label_ordering.sql backend/src/listeners.repo.ts backend/src/listeners.repo.test.ts
git commit -m "feat(backend): add slug, label, and token columns + repo functions"
```

---

## Task 2: Hook route — slug + token authentication

**Files:**
- Modify: `backend/src/routes/hook.ts`
- Modify: `backend/src/routes/hook.test.ts`

**Interfaces:**
- Consumes: `resolveListenerForHook(db, pathParam, providedToken)` from Task 1.
- Produces: no new exports — this task only changes `hookRoute`'s internal lookup call.

- [ ] **Step 1: Write failing tests for slug-gated hook capture**

Add to `backend/src/routes/hook.test.ts` (add `setListenerSlug` to the import from `'../listeners.repo'`):

```ts
describe('hook capture route — slug + token', () => {
  it('captures via the slug URL when the correct token is provided', async () => {
    await createListener(env.DB, 'hook-slug-listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    const { slug, webhookToken } = await setListenerSlug(env.DB, 'hook-slug-listener-1', 'slug-hook-1')

    const response = await app.request(
      `/hook/${slug}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-token': webhookToken },
        body: JSON.stringify({ ok: true }),
      },
      env
    )
    expect(response.status).toBe(200)

    const [captured] = await getRequests(env.DB, 'hook-slug-listener-1')
    expect(captured.body).toBe(JSON.stringify({ ok: true }))
  })

  it('returns 404 for the slug URL with a missing token', async () => {
    await createListener(env.DB, 'hook-slug-listener-2', '2024-01-01T00:00:00.000Z', 'session-a')
    const { slug } = await setListenerSlug(env.DB, 'hook-slug-listener-2', 'slug-hook-2')

    const response = await app.request(`/hook/${slug}`, { method: 'POST' }, env)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'listener not found' })
  })

  it('returns 404 for the slug URL with a wrong token', async () => {
    await createListener(env.DB, 'hook-slug-listener-3', '2024-01-01T00:00:00.000Z', 'session-a')
    const { slug } = await setListenerSlug(env.DB, 'hook-slug-listener-3', 'slug-hook-3')

    const response = await app.request(
      `/hook/${slug}`,
      { method: 'POST', headers: { 'x-webhook-token': 'wrong-token' } },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for the UUID hook URL once a slug has been set', async () => {
    await createListener(env.DB, 'hook-slug-listener-4', '2024-01-01T00:00:00.000Z', 'session-a')
    await setListenerSlug(env.DB, 'hook-slug-listener-4', 'slug-hook-4')

    const response = await app.request(`/hook/hook-slug-listener-4`, { method: 'POST' }, env)
    expect(response.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- hook.test.ts`
Expected: FAIL — the current route only looks up by UUID, so slug-based requests 404 unconditionally and the "UUID disabled after slug set" case currently succeeds (200) instead of 404.

- [ ] **Step 3: Implement the new lookup in the hook route**

In `backend/src/routes/hook.ts`, replace the import and lookup call:

```ts
import { resolveListenerForHook } from '../listeners.repo'
```

(remove the now-unused `import { getListener } from '../listeners.repo'`)

Replace:

```ts
const listener = await getListener(c.env.DB, c.req.param('id'))
if (!listener) {
  return c.json({ error: 'listener not found' }, 404)
}
```

with:

```ts
const listener = await resolveListenerForHook(c.env.DB, c.req.param('id'), c.req.header('x-webhook-token'))
if (!listener) {
  return c.json({ error: 'listener not found' }, 404)
}
```

No other changes to the handler body — `listener.id` (the canonical UUID) is still what's passed to `insertRequest`, so captured requests are recorded against the same listener regardless of which URL form was used to reach it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npm test -- hook.test.ts`
Expected: PASS — all pre-existing hook tests plus the four new slug/token tests green.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS — no regressions elsewhere (this confirms `app.session.test.ts`'s "hook route remains reachable regardless of session" case, which uses a plain UUID with no slug, is unaffected).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/hook.ts backend/src/routes/hook.test.ts
git commit -m "feat(backend): gate slug-based hook capture behind X-Webhook-Token"
```

---

## Task 3: Owner routes — slug, token rotation, label

**Files:**
- Modify: `backend/src/routes/listeners.ts`
- Create: `backend/src/routes/listeners.slug.test.ts`
- Create: `backend/src/routes/listeners.label.test.ts`

**Interfaces:**
- Consumes: `setListenerSlug`, `getListenerBySlug`, `rotateWebhookToken`, `removeListenerSlug`, `setListenerLabel`, `SlugValidationError`, `SlugConflictError`, `LabelValidationError` from Task 1.
- Produces: `PUT /api/listeners/:id/slug`, `POST /api/listeners/:id/slug/rotate-token`, `DELETE /api/listeners/:id/slug`, `PATCH /api/listeners/:id/label`. Every existing/new `GET`/`POST /api/listeners*` response gains `slug: string | null` and `label: string | null` fields (via a new internal `serializeListener` helper — Task 4 also uses this helper, so its shape must stay `{ id, createdAt, hookUrl, shareUrl, slug, label }`, no `webhookToken` field, since that's a secret only ever returned by the slug-set/rotate endpoints themselves).

- [ ] **Step 1: Write failing route tests for slug management**

Create `backend/src/routes/listeners.slug.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('listener slug management', () => {
  let listenerId: string
  let sessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
    sessionId = extractSessionId(created)
  })

  it('sets a slug and returns the normalized value with a token', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'Stripe_Prod' }),
      },
      env
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { slug: string; webhookToken: string; hookUrl: string }
    expect(body.slug).toBe('stripe-prod')
    expect(body.webhookToken).toBeTypeOf('string')
    expect(body.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/stripe-prod`)
  })

  it('the listener GET response reflects the slug and the slug-based hookUrl, with no webhookToken field', async () => {
    await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'my-slug' }),
      },
      env
    )
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const body = (await response.json()) as Record<string, unknown>
    expect(body.slug).toBe('my-slug')
    expect(body.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/my-slug`)
    expect(body.webhookToken).toBeUndefined()
  })

  it('returns 409 when the slug is already taken', async () => {
    const other = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(other)
    await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'taken' }),
      },
      env
    )
    const otherBody = (await other.json()) as { id: string }
    const response = await app.request(
      `/api/listeners/${otherBody.id}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: otherSessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'taken' }),
      },
      env
    )
    expect(response.status).toBe(409)
  })

  it('returns 400 for a slug that normalizes too short', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'ab' }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 for a different session', async () => {
    const other = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(other)
    const response = await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: otherSessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'stolen' }),
      },
      env
    )
    expect(response.status).toBe(404)
  })

  it('rotates the token, invalidating the old one', async () => {
    const setResponse = await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'rotate-target' }),
      },
      env
    )
    const { webhookToken: originalToken } = (await setResponse.json()) as { webhookToken: string }

    const rotateResponse = await app.request(
      `/api/listeners/${listenerId}/slug/rotate-token`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(rotateResponse.status).toBe(200)
    const { webhookToken: newToken } = (await rotateResponse.json()) as { webhookToken: string }
    expect(newToken).not.toBe(originalToken)

    const oldTokenRequest = await app.request(
      '/hook/rotate-target',
      { method: 'POST', headers: { 'x-webhook-token': originalToken } },
      env
    )
    expect(oldTokenRequest.status).toBe(404)
  })

  it('returns 400 rotating a token on a listener with no slug', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/slug/rotate-token`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(response.status).toBe(400)
  })

  it('removes the slug, reactivating the UUID hook URL', async () => {
    await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'remove-target' }),
      },
      env
    )
    const removeResponse = await app.request(
      `/api/listeners/${listenerId}/slug`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(removeResponse.status).toBe(204)

    const uuidHookResponse = await app.request(`/hook/${listenerId}`, { method: 'POST' }, env)
    expect(uuidHookResponse.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npm test -- listeners.slug.test.ts`
Expected: FAIL — routes don't exist yet (404s on `PUT`/`POST /rotate-token`/`DELETE`).

- [ ] **Step 3: Implement the slug routes**

In `backend/src/routes/listeners.ts`, the file currently starts with:

```ts
import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import {
  createListener,
  getListenerForOwner,
  getListenersForOwner,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
} from '../listeners.repo'
import { getRequests } from '../requests.repo'
```

Leave the first three lines (`Hono`, `Env`, `Variables`) untouched. Replace only the `from '../listeners.repo'` import with:

```ts
import {
  createListener,
  getListenerForOwner,
  getListenersForOwner,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
  setListenerSlug,
  rotateWebhookToken,
  removeListenerSlug,
  setListenerLabel,
  SlugValidationError,
  SlugConflictError,
  LabelValidationError,
  type ListenerRecord,
} from '../listeners.repo'
```

Replace the standalone `shareUrlFor` helper and every inline response-object literal (in the `GET /api/listeners`, `POST /api/listeners`, and `GET /api/listeners/:id` handlers) with one shared serializer:

```ts
function shareUrlFor(appBaseUrl: string, shareToken: string | null): string | null {
  return shareToken ? `${appBaseUrl}/shared/${shareToken}` : null
}

function serializeListener(env: Env, listener: ListenerRecord) {
  return {
    id: listener.id,
    createdAt: listener.createdAt,
    hookUrl: `${env.HOOK_BASE_URL}/hook/${listener.slug ?? listener.id}`,
    shareUrl: shareUrlFor(env.APP_BASE_URL, listener.shareToken),
    slug: listener.slug,
    label: listener.label,
  }
}
```

Update the three existing handlers to use it, e.g.:

```ts
listenerRoutes.get('/api/listeners', async (c) => {
  const listeners = await getListenersForOwner(c.env.DB, c.get('sessionId'), LIST_LIMIT)
  return c.json(listeners.map((listener) => serializeListener(c.env, listener)))
})

listenerRoutes.post('/api/listeners', async (c) => {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const listener = await createListener(c.env.DB, id, createdAt, c.get('sessionId'))
  return c.json(serializeListener(c.env, listener), 201)
})

listenerRoutes.get('/api/listeners/:id', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }
  return c.json(serializeListener(c.env, listener))
})
```

Add the new routes (place after the existing share routes, before the closing of the file):

```ts
listenerRoutes.put('/api/listeners/:id/slug', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }

  const body = await c.req.json<{ slug?: unknown }>().catch(() => ({}))
  if (typeof body.slug !== 'string') {
    return c.json({ error: 'slug is required' }, 400)
  }

  try {
    const { slug, webhookToken } = await setListenerSlug(c.env.DB, listener.id, body.slug)
    return c.json({ slug, webhookToken, hookUrl: `${c.env.HOOK_BASE_URL}/hook/${slug}` })
  } catch (err) {
    if (err instanceof SlugValidationError) {
      return c.json({ error: err.message }, 400)
    }
    if (err instanceof SlugConflictError) {
      return c.json({ error: err.message }, 409)
    }
    throw err
  }
})

listenerRoutes.post('/api/listeners/:id/slug/rotate-token', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }

  const token = await rotateWebhookToken(c.env.DB, listener.id)
  if (!token) {
    return c.json({ error: 'listener has no slug set' }, 400)
  }
  return c.json({ webhookToken: token })
})

listenerRoutes.delete('/api/listeners/:id/slug', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }

  await removeListenerSlug(c.env.DB, listener.id)
  return c.body(null, 204)
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npm test -- listeners.slug.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS — the `serializeListener` refactor must not change any existing response shape (`listeners.list.test.ts` and `listeners.share.test.ts` assert exact `hookUrl`/`shareUrl` values already; they should still pass unchanged).

- [ ] **Step 6: Write failing route tests for the label endpoint**

Create `backend/src/routes/listeners.label.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('listener label management', () => {
  let listenerId: string
  let sessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
    sessionId = extractSessionId(created)
  })

  it('sets a label', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: '  Stripe prod  ' }),
      },
      env
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as { label: string }).toEqual({ label: 'Stripe prod' })

    const getResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await getResponse.json() as { label: string }).label).toBe('Stripe prod')
  })

  it('clears a label with an empty string', async () => {
    await app.request(
      `/api/listeners/${listenerId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Something' }),
      },
      env
    )
    const response = await app.request(
      `/api/listeners/${listenerId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: '' }),
      },
      env
    )
    expect((await response.json()) as { label: string | null }).toEqual({ label: null })
  })

  it('returns 400 for a label over 100 characters', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'x'.repeat(101) }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 for a different session', async () => {
    const other = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(other)
    const response = await app.request(
      `/api/listeners/${listenerId}/label`,
      {
        method: 'PATCH',
        headers: { ...cookieHeader({ wl_session_id: otherSessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'nope' }),
      },
      env
    )
    expect(response.status).toBe(404)
  })
})
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd backend && npm test -- listeners.label.test.ts`
Expected: FAIL — route doesn't exist yet.

- [ ] **Step 8: Implement the label route**

Add to `backend/src/routes/listeners.ts`:

```ts
listenerRoutes.patch('/api/listeners/:id/label', async (c) => {
  const listener = await getListenerForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!listener) {
    return c.json({ error: 'listener not found' }, 404)
  }

  const body = await c.req.json<{ label?: unknown }>().catch(() => ({}))
  if (typeof body.label !== 'string') {
    return c.json({ error: 'label is required (use an empty string to clear it)' }, 400)
  }

  try {
    const label = await setListenerLabel(c.env.DB, listener.id, body.label)
    return c.json({ label })
  } catch (err) {
    if (err instanceof LabelValidationError) {
      return c.json({ error: err.message }, 400)
    }
    throw err
  }
})
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd backend && npm test -- listeners.label.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the full backend suite and commit**

Run: `cd backend && npm test`
Expected: PASS, all files.

```bash
git add backend/src/routes/listeners.ts backend/src/routes/listeners.slug.test.ts backend/src/routes/listeners.label.test.ts
git commit -m "feat(backend): add slug set/rotate/remove and label routes"
```

---

## Task 4: Activity tracking, custom ordering, and list sorting

**Files:**
- Modify: `backend/src/requests.repo.ts`
- Modify: `backend/src/requests.repo.test.ts`
- Modify: `backend/src/listeners.repo.ts`
- Modify: `backend/src/listeners.repo.test.ts`
- Modify: `backend/src/routes/listeners.ts`
- Create: `backend/src/routes/listeners.reorder.test.ts`
- Modify: `backend/src/routes/listeners.list.test.ts`

**Interfaces:**
- Consumes: `serializeListener` (Task 3), `ListenerRecord` (Task 1).
- Produces: `export type SortMode = 'date' | 'name' | 'activity' | 'custom'`
- Produces: `getListenersForOwner(db, sessionId, limit, sort?: SortMode): Promise<ListenerRecord[]>` — 4th param is new, defaults to `'date'` (backward compatible with Task 3's/existing call sites that don't pass it).
- Produces: `reorderListeners(db: Env['DB'], sessionId: string, orderedIds: string[]): Promise<boolean>` — `false` if `orderedIds` is empty or contains any id not owned by `sessionId`.
- Produces: `POST /api/listeners/reorder` route.
- Produces: `GET /api/listeners?sort=date|name|activity|custom` query param support.

- [ ] **Step 1: Write a failing test for `last_request_at` tracking**

Add to `backend/src/requests.repo.test.ts`. The file already imports `createListener` from `./listeners.repo` — change that import line to also bring in `getListener`:

```ts
import { createListener, getListener } from './listeners.repo'
```

```ts
it('updates the listener\'s last_request_at on insert', async () => {
  await createListener(env.DB, 'activity-listener', '2024-01-01T00:00:00.000Z', 'session-a')
  await insertRequest(env.DB, {
    listenerId: 'activity-listener',
    method: 'POST',
    headers: '{}',
    queryParams: '{}',
    body: null,
    contentType: null,
    sourceIp: null,
    receivedAt: '2024-06-01T00:00:00.000Z',
  })
  const listener = await getListener(env.DB, 'activity-listener')
  expect(listener?.lastRequestAt).toBe('2024-06-01T00:00:00.000Z')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- requests.repo.test.ts`
Expected: FAIL — `lastRequestAt` stays `null` (never updated).

- [ ] **Step 3: Update `insertRequest` to touch `last_request_at`**

In `backend/src/requests.repo.ts`, add a third statement to the existing batch:

```ts
const touchListener = db
  .prepare('UPDATE listeners SET last_request_at = ? WHERE id = ?')
  .bind(req.receivedAt, req.listenerId)

await db.batch([insert, prune, touchListener])
```

(Replaces the current `await db.batch([insert, prune])` line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- requests.repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing tests for sort modes and reordering in the repo**

Add to `backend/src/listeners.repo.test.ts` (add `type SortMode, reorderListeners` to the import from `'./listeners.repo'`):

```ts
describe('getListenersForOwner sort modes', () => {
  it('sorts by name, falling back to created_at for listeners with neither label nor slug', async () => {
    await createListener(env.DB, 'sort-name-1', '2024-01-01T00:00:00.000Z', 'session-sort')
    await createListener(env.DB, 'sort-name-2', '2024-01-02T00:00:00.000Z', 'session-sort')
    await createListener(env.DB, 'sort-name-3', '2024-01-03T00:00:00.000Z', 'session-sort')
    await setListenerLabel(env.DB, 'sort-name-2', 'Alpha')
    await setListenerLabel(env.DB, 'sort-name-1', 'Beta')

    const result = await getListenersForOwner(env.DB, 'session-sort', 100, 'name')
    expect(result.map((l) => l.id)).toEqual(['sort-name-2', 'sort-name-1', 'sort-name-3'])
  })

  it('sorts by activity, most recent request first, nulls last', async () => {
    await createListener(env.DB, 'sort-activity-1', '2024-01-01T00:00:00.000Z', 'session-activity')
    await createListener(env.DB, 'sort-activity-2', '2024-01-02T00:00:00.000Z', 'session-activity')
    await insertRequest(env.DB, {
      listenerId: 'sort-activity-1',
      method: 'GET',
      headers: '{}',
      queryParams: '{}',
      body: null,
      contentType: null,
      sourceIp: null,
      receivedAt: '2024-06-01T00:00:00.000Z',
    })

    const result = await getListenersForOwner(env.DB, 'session-activity', 100, 'activity')
    expect(result.map((l) => l.id)).toEqual(['sort-activity-1', 'sort-activity-2'])
  })

  it('sorts by custom position, unpositioned listeners last', async () => {
    await createListener(env.DB, 'sort-custom-1', '2024-01-01T00:00:00.000Z', 'session-custom')
    await createListener(env.DB, 'sort-custom-2', '2024-01-02T00:00:00.000Z', 'session-custom')
    await reorderListeners(env.DB, 'session-custom', ['sort-custom-2', 'sort-custom-1'])

    const result = await getListenersForOwner(env.DB, 'session-custom', 100, 'custom')
    expect(result.map((l) => l.id)).toEqual(['sort-custom-2', 'sort-custom-1'])
  })

  it('defaults to date sort when no sort mode is given', async () => {
    await createListener(env.DB, 'sort-default-1', '2024-01-01T00:00:00.000Z', 'session-default')
    await createListener(env.DB, 'sort-default-2', '2024-01-02T00:00:00.000Z', 'session-default')
    const result = await getListenersForOwner(env.DB, 'session-default', 100)
    expect(result.map((l) => l.id)).toEqual(['sort-default-2', 'sort-default-1'])
  })
})

describe('reorderListeners', () => {
  it('assigns sort positions in the given order', async () => {
    await createListener(env.DB, 'reorder-1', '2024-01-01T00:00:00.000Z', 'session-reorder')
    await createListener(env.DB, 'reorder-2', '2024-01-02T00:00:00.000Z', 'session-reorder')
    const ok = await reorderListeners(env.DB, 'session-reorder', ['reorder-2', 'reorder-1'])
    expect(ok).toBe(true)
    const result = await getListenersForOwner(env.DB, 'session-reorder', 100, 'custom')
    expect(result.map((l) => l.id)).toEqual(['reorder-2', 'reorder-1'])
  })

  it('rejects an id that does not belong to the session, changing nothing', async () => {
    await createListener(env.DB, 'reorder-3', '2024-01-01T00:00:00.000Z', 'session-owns')
    await createListener(env.DB, 'reorder-4', '2024-01-01T00:00:00.000Z', 'session-other')
    const ok = await reorderListeners(env.DB, 'session-owns', ['reorder-3', 'reorder-4'])
    expect(ok).toBe(false)
  })

  it('rejects an empty list', async () => {
    expect(await reorderListeners(env.DB, 'session-empty', [])).toBe(false)
  })
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd backend && npm test -- listeners.repo.test.ts`
Expected: FAIL — `reorderListeners` not exported, and `getListenersForOwner` doesn't accept a 4th argument yet (name/activity/custom sorts behave like `date`).

- [ ] **Step 7: Implement sort modes and reordering**

In `backend/src/listeners.repo.ts`, replace `getListenersForOwner` and add `reorderListeners`:

```ts
export type SortMode = 'date' | 'name' | 'activity' | 'custom'

const SORT_CLAUSES: Record<SortMode, string> = {
  date: 'created_at DESC, id DESC',
  name: '(COALESCE(label, slug) IS NULL), COALESCE(label, slug) COLLATE NOCASE ASC, created_at DESC',
  activity: '(last_request_at IS NULL), last_request_at DESC, created_at DESC',
  custom: '(sort_position IS NULL), sort_position ASC, created_at DESC',
}

export async function getListenersForOwner(
  db: Env['DB'],
  sessionId: string,
  limit: number,
  sort: SortMode = 'date'
): Promise<ListenerRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE owner_session = ? ORDER BY ${SORT_CLAUSES[sort]} LIMIT ?`)
    .bind(sessionId, limit)
    .all<ListenerRecord>()
  return results
}

export async function reorderListeners(db: Env['DB'], sessionId: string, orderedIds: string[]): Promise<boolean> {
  if (orderedIds.length === 0) return false

  const { results } = await db
    .prepare('SELECT id FROM listeners WHERE owner_session = ?')
    .bind(sessionId)
    .all<{ id: string }>()
  const ownedIds = new Set(results.map((r) => r.id))
  if (!orderedIds.every((id) => ownedIds.has(id))) return false

  const statements = orderedIds.map((id, index) =>
    db.prepare('UPDATE listeners SET sort_position = ? WHERE id = ?').bind(index, id)
  )
  await db.batch(statements)
  return true
}
```

`SORT_CLAUSES` uses `(expr IS NULL)` as a leading sort key (evaluates to `0`/`1` in SQLite) instead of the `NULLS LAST` syntax, so it doesn't depend on the SQLite version D1 runs.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd backend && npm test -- listeners.repo.test.ts`
Expected: PASS.

- [ ] **Step 9: Write failing tests for the reorder route and `?sort=` query param**

Create `backend/src/routes/listeners.reorder.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('POST /api/listeners/reorder', () => {
  let sessionId: string
  let firstId: string
  let secondId: string

  beforeEach(async () => {
    const first = await app.request('/api/listeners', { method: 'POST' }, env)
    sessionId = extractSessionId(first)
    firstId = ((await first.json()) as { id: string }).id
    const second = await app.request(
      '/api/listeners',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    secondId = ((await second.json()) as { id: string }).id
  })

  it('reorders and is reflected in ?sort=custom', async () => {
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ orderedIds: [secondId, firstId] }),
      },
      env
    )
    expect(response.status).toBe(204)

    const listResponse = await app.request(
      '/api/listeners?sort=custom',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const body = (await listResponse.json()) as { id: string }[]
    expect(body.map((l) => l.id)).toEqual([secondId, firstId])
  })

  it('returns 400 for an id belonging to another session', async () => {
    const other = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherId = ((await other.json()) as { id: string }).id
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ orderedIds: [firstId, otherId] }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 for a malformed body', async () => {
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ orderedIds: 'not-an-array' }),
      },
      env
    )
    expect(response.status).toBe(400)
  })
})
```

Add to `backend/src/routes/listeners.list.test.ts`:

```ts
it('falls back to date sort for an unrecognized ?sort= value', async () => {
  const first = await app.request('/api/listeners', { method: 'POST' }, env)
  const sessionId = extractSessionId(first)
  const firstBody = (await first.json()) as { id: string }
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await app.request(
    '/api/listeners',
    { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
    env
  )
  const secondBody = (await second.json()) as { id: string }

  const response = await app.request(
    '/api/listeners?sort=nonsense',
    { headers: cookieHeader({ wl_session_id: sessionId }) },
    env
  )
  const body = (await response.json()) as { id: string }[]
  expect(body.map((l) => l.id)).toEqual([secondBody.id, firstBody.id])
})
```

- [ ] **Step 10: Run tests to verify they fail**

Run: `cd backend && npm test -- listeners.reorder.test.ts listeners.list.test.ts`
Expected: FAIL — `/api/listeners/reorder` doesn't exist (404), `?sort=` is ignored.

- [ ] **Step 11: Implement the reorder route and `?sort=` handling**

In `backend/src/routes/listeners.ts`:

1. Add `reorderListeners` and `type SortMode` to the import from `'../listeners.repo'`.
2. Add near the top of the file, after `LIST_LIMIT`:

```ts
const VALID_SORTS: SortMode[] = ['date', 'name', 'activity', 'custom']

function parseSortMode(raw: string | undefined): SortMode {
  return (VALID_SORTS as string[]).includes(raw ?? '') ? (raw as SortMode) : 'date'
}
```

3. Update the `GET /api/listeners` handler:

```ts
listenerRoutes.get('/api/listeners', async (c) => {
  const sort = parseSortMode(c.req.query('sort'))
  const listeners = await getListenersForOwner(c.env.DB, c.get('sessionId'), LIST_LIMIT, sort)
  return c.json(listeners.map((listener) => serializeListener(c.env, listener)))
})
```

4. Add the reorder route (order in the file doesn't matter functionally, but place it near the other bulk-ish routes for readability):

```ts
listenerRoutes.post('/api/listeners/reorder', async (c) => {
  const body = await c.req.json<{ orderedIds?: unknown }>().catch(() => ({}))
  if (!Array.isArray(body.orderedIds) || body.orderedIds.some((id) => typeof id !== 'string')) {
    return c.json({ error: 'orderedIds must be an array of strings' }, 400)
  }

  const ok = await reorderListeners(c.env.DB, c.get('sessionId'), body.orderedIds)
  if (!ok) {
    return c.json({ error: 'orderedIds must only contain your own listeners' }, 400)
  }
  return c.body(null, 204)
})
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `cd backend && npm test -- listeners.reorder.test.ts listeners.list.test.ts`
Expected: PASS.

- [ ] **Step 13: Run the full backend suite and commit**

Run: `cd backend && npm test`
Expected: PASS, all files (should be noticeably more than the 65 tests from before this plan started).

```bash
git add backend/src/requests.repo.ts backend/src/requests.repo.test.ts backend/src/listeners.repo.ts backend/src/listeners.repo.test.ts backend/src/routes/listeners.ts backend/src/routes/listeners.reorder.test.ts backend/src/routes/listeners.list.test.ts
git commit -m "feat(backend): track last-request activity, add custom ordering and list sort modes"
```

---

## Task 5: Frontend API client additions

**Files:**
- Modify: `frontend/src/api.ts`

**Interfaces:**
- Consumes: the response shapes from Tasks 3 and 4 (`{ id, createdAt, hookUrl, shareUrl, slug, label }` for listeners; `{ slug, webhookToken, hookUrl }` from slug-set; `{ webhookToken }` from rotate; `{ label }` from label-set).
- Produces: `Listener` gains `slug: string | null`, `label: string | null`. New: `SortMode`, `SlugResult`, `setSlug`, `rotateWebhookToken`, `removeSlug`, `setLabel`, `reorderListeners`. `listListeners` gains an optional `sort` parameter.

- [ ] **Step 1: Update the `Listener` interface and `listListeners`**

In `frontend/src/api.ts`, update:

```ts
export interface Listener {
  id: string
  createdAt: string
  hookUrl: string
  shareUrl: string | null
  slug: string | null
  label: string | null
}

export type SortMode = 'date' | 'name' | 'activity' | 'custom'
```

Replace the existing `listListeners`:

```ts
export function listListeners(sort: SortMode = 'date'): Promise<Listener[]> {
  return fetch(`${API_BASE_URL}/api/listeners?sort=${sort}`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Listener[]>(r)
  )
}
```

- [ ] **Step 2: Add slug, label, and reorder functions**

Append to `frontend/src/api.ts`:

```ts
export interface SlugResult {
  slug: string
  webhookToken: string
  hookUrl: string
}

export function setSlug(id: string, slug: string): Promise<SlugResult> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/slug`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug }),
  }).then((r) => parseJsonOrThrow<SlugResult>(r))
}

export function rotateWebhookToken(id: string): Promise<{ webhookToken: string }> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/slug/rotate-token`, {
    method: 'POST',
    credentials: 'include',
  }).then((r) => parseJsonOrThrow<{ webhookToken: string }>(r))
}

export async function removeSlug(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/listeners/${id}/slug`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function setLabel(id: string, label: string): Promise<{ label: string | null }> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/label`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  }).then((r) => parseJsonOrThrow<{ label: string | null }>(r))
}

export async function reorderListeners(orderedIds: string[]): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/listeners/reorder`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors. (No behavior to test yet — `Home.tsx`/`Listener.tsx` don't call the new functions until Tasks 6–7. This step only proves the new exports compile and existing callers of `listListeners()` — called with zero args in `Home.tsx` — still type-check against the new optional-parameter signature.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(frontend): add API client functions for slug, label, and reorder"
```

---

## Task 6: Frontend — Listener page (label edit + slug management)

**Files:**
- Modify: `frontend/src/pages/Listener.tsx`

**Interfaces:**
- Consumes: `setSlug`, `rotateWebhookToken`, `removeSlug`, `setLabel` from Task 5; `listener.slug`, `listener.label` from Task 5's `Listener` type.

- [ ] **Step 1: Add label editing to the page header**

In `frontend/src/pages/Listener.tsx`, add `type FormEvent` to the existing `import { useCallback, useEffect, useMemo, useRef, useState } from 'react'` line:

```ts
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
```

And update the `../api` import to add the new functions:

```ts
import {
  ApiError,
  type CapturedRequest,
  type Listener as ListenerModel,
  deleteListener,
  getListener,
  getOrCreateShareLink,
  getRequests,
  removeSlug,
  revokeShareLink,
  rotateWebhookToken,
  setLabel,
  setSlug,
} from '../api'
```

Add new state near the existing `useState` calls:

```ts
const [labelDraft, setLabelDraft] = useState('')
const [editingLabel, setEditingLabel] = useState(false)
const [slugDraft, setSlugDraft] = useState('')
const [webhookToken, setWebhookToken] = useState<string | null>(null)
const [headerCopied, setHeaderCopied] = useState(false)
```

Add handlers near the other `handle*` functions:

```ts
async function handleSaveLabel() {
  if (!id) return
  try {
    await setLabel(id, labelDraft)
    setEditingLabel(false)
    await refresh()
  } catch {
    setError('Failed to save label.')
  }
}

async function handleSetSlug(e: FormEvent) {
  e.preventDefault()
  if (!id) return
  try {
    const result = await setSlug(id, slugDraft)
    setWebhookToken(result.webhookToken)
    setSlugDraft('')
    await refresh()
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      setError('That slug is already in use.')
    } else if (err instanceof ApiError && err.status === 400) {
      setError('Slug must be 3-63 characters after removing invalid characters.')
    } else {
      setError('Failed to set slug.')
    }
  }
}

async function handleRotateToken() {
  if (!id) return
  if (!window.confirm('Rotate the webhook token? The old token will stop working immediately.')) return
  try {
    const result = await rotateWebhookToken(id)
    setWebhookToken(result.webhookToken)
  } catch {
    setError('Failed to rotate token.')
  }
}

async function handleRemoveSlug() {
  if (!id) return
  if (!window.confirm('Remove this slug? The listener will revert to its original UUID hook URL.')) return
  try {
    await removeSlug(id)
    setWebhookToken(null)
    await refresh()
  } catch {
    setError('Failed to remove slug.')
  }
}

async function handleCopyHeaderJson() {
  if (!webhookToken) return
  try {
    await navigator.clipboard.writeText(JSON.stringify({ 'X-Webhook-Token': webhookToken }, null, 2))
    setHeaderCopied(true)
    setTimeout(() => setHeaderCopied(false), 1500)
  } catch {
    setError('Failed to copy to clipboard.')
  }
}
```

Replace the header `<div className="flex items-center gap-2">...<h1>...</h1></div>` block with:

```tsx
<div className="flex items-center gap-2">
  <Logo className="h-6 w-6 text-slate-900" />
  {editingLabel ? (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        handleSaveLabel()
      }}
      className="flex items-center gap-2"
    >
      <input
        autoFocus
        value={labelDraft}
        onChange={(e) => setLabelDraft(e.target.value)}
        maxLength={100}
        placeholder="Listener"
        className="rounded-md border border-slate-300 px-2 py-1 text-sm"
      />
      <button type="submit" className="text-xs font-medium text-indigo-600">
        Save
      </button>
      <button type="button" onClick={() => setEditingLabel(false)} className="text-xs text-slate-500">
        Cancel
      </button>
    </form>
  ) : (
    <button
      onClick={() => {
        setLabelDraft(listener?.label ?? '')
        setEditingLabel(true)
      }}
      className="text-xl font-semibold text-slate-900 hover:underline"
      title="Click to rename"
    >
      {listener?.label || 'Listener'}
    </button>
  )}
</div>
```

- [ ] **Step 2: Gate the existing Webhook URL box on "no slug set"**

Change the condition on the existing "Webhook URL" section from `{listener && (` to `{listener && !listener.slug && (`.

- [ ] **Step 3: Add the Custom slug section**

Insert a new block immediately after the (now-conditional) Webhook URL section and before the existing Share section:

```tsx
{listener && (
  <div className="mb-6">
    <p className="mb-1 text-xs font-medium text-slate-500">Custom slug</p>
    {listener.slug ? (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <code className="flex-1 truncate text-sm text-slate-700">{listener.hookUrl}</code>
          <button
            onClick={handleCopy}
            aria-label="Copy webhook URL"
            className="shrink-0 rounded-md bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        {webhookToken ? (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <code className="flex-1 truncate text-xs text-amber-900">{`{ "X-Webhook-Token": "${webhookToken}" }`}</code>
            <button
              onClick={handleCopyHeaderJson}
              className="shrink-0 rounded-md bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-200"
            >
              {headerCopied ? 'Copied!' : 'Copy header JSON'}
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Token hidden — rotate it to get a fresh one to copy.</p>
        )}
        <div className="flex gap-2">
          <button
            onClick={handleRotateToken}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Rotate token
          </button>
          <button
            onClick={handleRemoveSlug}
            className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
          >
            Remove slug
          </button>
        </div>
      </div>
    ) : (
      <form onSubmit={handleSetSlug} className="flex items-center gap-2">
        <input
          value={slugDraft}
          onChange={(e) => setSlugDraft(e.target.value)}
          placeholder="my-stripe-hook"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200"
        >
          Set slug
        </button>
      </form>
    )}
  </div>
)}
```

- [ ] **Step 4: Type-check**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 5: Manual verification**

Run `cd backend && npm run dev` and `cd frontend && npm run dev` (or the project's usual local-dev commands), then in the browser:
- Create a listener, click the label to rename it, save, confirm it persists after reload.
- Set a slug — confirm the Webhook URL box disappears and the Custom slug box shows the slug URL plus the token JSON box.
- Click "Copy header JSON" and paste somewhere to confirm the clipboard contains `{ "X-Webhook-Token": "<uuid>" }`.
- POST to the old UUID hook URL with curl — confirm 404.
- POST to the new slug hook URL with the copied token header — confirm 200 and the request appears in the list.
- Rotate the token — confirm the old token now 404s and the new one works.
- Remove the slug — confirm the UUID hook URL works again and the Webhook URL box reappears.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Listener.tsx
git commit -m "feat(frontend): add label editing and custom slug management to the listener page"
```

---

## Task 7: Frontend — Home page (sort control + drag-to-reorder)

**Files:**
- Modify: `frontend/src/pages/Home.tsx`

**Interfaces:**
- Consumes: `listListeners(sort)`, `reorderListeners(orderedIds)`, `type SortMode` from Task 5; `listener.label`, `listener.slug` from Task 5's `Listener` type.

- [ ] **Step 1: Replace `Home.tsx` with sort control and drag-to-reorder**

Replace the full contents of `frontend/src/pages/Home.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createListener, listListeners, reorderListeners, type Listener, type SortMode } from '../api'
import { Logo } from '../components/Logo'

const SORT_STORAGE_KEY = 'wl_home_sort'
const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'date', label: 'Date' },
  { value: 'name', label: 'Name' },
  { value: 'activity', label: 'Recent activity' },
  { value: 'custom', label: 'Custom' },
]

function loadStoredSort(): SortMode {
  const stored = localStorage.getItem(SORT_STORAGE_KEY)
  return SORT_OPTIONS.some((option) => option.value === stored) ? (stored as SortMode) : 'date'
}

export function Home() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [listeners, setListeners] = useState<Listener[]>([])
  const [sort, setSort] = useState<SortMode>(loadStoredSort)
  const [dragId, setDragId] = useState<string | null>(null)

  useEffect(() => {
    listListeners(sort)
      .then(setListeners)
      .catch(() => {
        // Listing is a nice-to-have; a failed fetch must not block the create flow.
      })
  }, [sort])

  function handleSortChange(next: SortMode) {
    setSort(next)
    localStorage.setItem(SORT_STORAGE_KEY, next)
  }

  async function handleCreate() {
    setCreating(true)
    setError(null)
    try {
      const listener = await createListener()
      navigate(`/listener/${listener.id}`)
    } catch {
      setError('Failed to create listener. Is the backend running?')
      setCreating(false)
    }
  }

  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) return
    const previous = listeners
    const current = [...listeners]
    const fromIndex = current.findIndex((l) => l.id === dragId)
    const toIndex = current.findIndex((l) => l.id === targetId)
    if (fromIndex === -1 || toIndex === -1) return
    const [moved] = current.splice(fromIndex, 1)
    current.splice(toIndex, 0, moved)
    setListeners(current)
    setDragId(null)
    reorderListeners(current.map((l) => l.id)).catch(() => {
      setListeners(previous)
      setError('Failed to save the new order.')
    })
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
        <div className="flex items-center justify-center gap-2">
          <Logo className="h-7 w-7 text-slate-900" />
          <h1 className="text-2xl font-semibold text-slate-900">Webhook Listener</h1>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          Create a unique URL, send it webhook payloads, and watch them arrive here.
        </p>
        {listeners.length > 0 && (
          <>
            <div className="mb-2 mt-6 flex items-center justify-center gap-1" role="group" aria-label="Sort listeners">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleSortChange(option.value)}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                    sort === option.value
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <ul className="mb-6 space-y-2 text-left">
              {listeners.map((listener) => {
                const hasNameOrSlug = Boolean(listener.label || listener.slug)
                const primaryText = listener.label || listener.slug || new Date(listener.createdAt).toLocaleString()
                return (
                  <li
                    key={listener.id}
                    draggable={sort === 'custom'}
                    onDragStart={() => setDragId(listener.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleDrop(listener.id)}
                    className="flex items-center gap-2"
                  >
                    {sort === 'custom' && (
                      <span className="cursor-grab text-slate-400" aria-hidden="true">
                        ⠿
                      </span>
                    )}
                    <a
                      href={`/listener/${listener.id}`}
                      className="block flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
                    >
                      <span className="block font-medium">{primaryText}</span>
                      {hasNameOrSlug && (
                        <span className="block text-xs text-slate-400">
                          {new Date(listener.createdAt).toLocaleString()}
                        </span>
                      )}
                    </a>
                  </li>
                )
              })}
            </ul>
          </>
        )}
        <button
          onClick={handleCreate}
          disabled={creating}
          className="mt-6 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {creating ? 'Creating…' : 'Create new webhook listener'}
        </button>
        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}
      </div>
    </main>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 3: Manual verification**

With backend + frontend dev servers running and at least 2-3 listeners created (some with labels/slugs set via Task 6's UI, some without):
- Switch through Date / Name / Recent activity / Custom — confirm the list order changes plausibly for each (name-sorted listeners with a label/slug come first, alphabetically; activity-sorted listeners that have received a request come first, most recent on top; date is unchanged from today's behavior).
- Switch to Custom, drag a row to a new position, confirm it stays there after a page reload (persisted via `sort_position`).
- Confirm a listener with no label and no slug shows its creation date as the sole line (no duplicate date), and one with a label/slug shows both the name and the date underneath.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Home.tsx
git commit -m "feat(frontend): add sort control and drag-to-reorder to the listener list"
```

---

## Post-implementation note (not a task — flag to the user)

This plan adds a new migration (`0004_slug_label_ordering.sql`). Local/test runs pick it up automatically via `readD1Migrations` in `backend/vitest.config.ts`. The **deployed** D1 database does not update itself — before deploying the backend after this plan is merged, run:

```bash
cd backend && npm run db:migrate:remote
```

then `npm run deploy`, in that order. Deploying the Worker before migrating would make every request to the new routes fail with a D1 "no such column" error.
