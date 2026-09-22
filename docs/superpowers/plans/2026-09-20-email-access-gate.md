# Email Access Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the entire `webhook-listener` app behind a domain-restricted magic-link email login, switch listener/project ownership from anonymous browser session to verified email, and — since real production data already exists under the old session model for both tables — automatically merge each browser's pre-gate anonymous data into its owner's verified email the first time that browser completes login.

**Architecture:** Two new D1 migrations add `owner_email` (and, for `projects`, a relaxed-to-nullable `owner_session`) alongside a new `magic_links` table. New backend modules (`auth/tokens.ts`, `auth/session.ts`, `magic-links.repo.ts`, `email.ts`, `ownership-merge.ts`, `routes/auth.ts`) implement the request-link/verify/me/logout flow and the merge step. `listeners.repo.ts` and `projects.repo.ts` switch their owner-scoped queries from `owner_session` to `owner_email`, and a new tier-0 Hono middleware in `app.ts` requires a valid `wl_email_session` cookie on every route except `/auth/*` and `/hook/*`. Because this gate sits in front of routes that ~180 existing test assertions already exercise without any email cookie, the largest single task in this plan is mechanically adding a valid auth cookie to every one of those existing calls. Frontend gets a router-wrapping gate component, an email-entry/check-your-email screen, and a "signed in as `<email>`" + sign-out control in `AppLayout`.

**Tech Stack:** Hono (routing), D1/SQLite (via `wrangler d1 migrations`), Web Crypto API (`crypto.subtle`, HMAC-SHA256 + SHA-256, native in the Workers runtime — no new dependency), Resend HTTP API (`fetch`, no SDK), Vitest + `@cloudflare/vitest-pool-workers` for backend tests, React/Vite/Tailwind for frontend (no new dependency).

**Spec:** `docs/superpowers/specs/2026-09-20-email-access-gate-design.md`

## Global Constraints

- `ALLOWED_EMAIL_DOMAINS` default `nice.com,cognigy.com`, comma-separated Wrangler var on `webhook-api` (spec §Configuration).
- `WL_SESSION_SECRET` — Wrangler secret, HMAC key for the `wl_email_session` cookie (spec §Session mechanism).
- `RESEND_API_KEY` — Wrangler secret (spec §Configuration).
- Sending address `noreply@fde.nice-agentic.com` is hardcoded, not an env var (spec §Configuration).
- `wl_email_session` cookie: `httpOnly`, `Secure`, `SameSite=Lax`, `Domain=fde.nice-agentic.com` (reuse the existing `SESSION_COOKIE_DOMAIN` binding), `maxAge` 30 days (spec §Session mechanism).
- Magic link tokens: `crypto.randomUUID()`, only `SHA-256(token)` ever persisted, 15-minute expiry, single-use (spec §Magic-link flow).
- Rate limit: `429` on `/auth/request-link` if an unexpired, unused link already exists for that email (spec §Magic-link flow).
- `owner_session` is **kept** (nullable) on both `listeners` and `projects`, not dropped — it is the one-time merge key (spec §Existing listeners and projects).
- Migration numbering: `projects` already claimed `0005`–`0007`; this plan uses `0008` and `0009` (spec §Data model changes).
- `ALL /hook/:id` and `ALL /hook/:projectId/:identifier` are exempt from every check this plan adds (spec §Access model, tier 3).
- No admin UI for the domain allowlist, no OAuth/SSO, no per-device revocation beyond rotating `WL_SESSION_SECRET`, no cross-device claiming fallback beyond the single-browser merge (spec §Out of scope).

---

## File Structure

**Backend — new:**
- `backend/migrations/0008_owner_email.sql` — adds `listeners.owner_email`; rebuilds `projects` with nullable `owner_session` + new `owner_email`.
- `backend/migrations/0009_magic_links.sql` — new `magic_links` table.
- `backend/src/auth/tokens.ts` — `hashToken(raw): Promise<string>` (SHA-256 hex).
- `backend/src/auth/tokens.test.ts`
- `backend/src/auth/session.ts` — `signEmailSession`/`verifyEmailSession` (HMAC-signed cookie payload).
- `backend/src/auth/session.test.ts`
- `backend/src/magic-links.repo.ts` — `hasPendingMagicLink`, `createMagicLink`, `consumeMagicLink`.
- `backend/src/magic-links.repo.test.ts`
- `backend/src/ownership-merge.ts` — `mergeSessionIntoEmail`.
- `backend/src/ownership-merge.test.ts`
- `backend/src/email.ts` — `sendMagicLinkEmail` (Resend `fetch` call).
- `backend/src/email.test.ts`
- `backend/src/routes/auth.ts` — `authRoutes`: `POST /auth/request-link`, `GET /auth/verify`, `GET /auth/me`, `POST /auth/logout`.
- `backend/src/routes/auth.test.ts`
- `backend/src/test-helpers/auth.ts` — `authCookieHeader(env, email)` test helper (mirrors `test-helpers/session.ts`).

**Backend — modified:**
- `backend/src/env.ts` — add `ALLOWED_EMAIL_DOMAINS`, `WL_SESSION_SECRET`, `RESEND_API_KEY`.
- `backend/wrangler.toml` — add `ALLOWED_EMAIL_DOMAINS` var and dev-default `WL_SESSION_SECRET`/`RESEND_API_KEY` vars (real deploys override the latter two via `wrangler secret put`).
- `backend/src/listeners.repo.ts` — `ListenerRecord.ownerEmail`; `createListener`/`createProjectListener` take an email instead of/alongside a session; `getListenerForOwner`/`getListenersForOwner`/`reorderItems` match on `owner_email`.
- `backend/src/listeners.repo.test.ts` — update to the new signatures.
- `backend/src/projects.repo.ts` — `ProjectRecord.ownerEmail`; `createProject`/`getProjectForOwner`/`getProjectsForOwner` switch to `owner_email`.
- `backend/src/projects.repo.test.ts` — update to the new signatures.
- `backend/src/app.ts` — new tier-0 middleware (`Variables.email`); mount `authRoutes`.
- `backend/src/routes/listeners.ts` — every handler reads `c.get('email')` instead of `c.get('sessionId')`.
- `backend/src/routes/projects.ts` — same, plus the create-and-send-adjacent `POST /api/projects/:projectId/listeners` passes `project.ownerEmail` to `createProjectListener`.
- `backend/src/routes/hook.ts` — `ALL /hook/:projectId/:identifier` passes through **both** `project.ownerSession` and `project.ownerEmail` unchanged to `createProjectListener` (tier-3, no auth context available).
- Sixteen existing test files (enumerated in Task 14) — every `app.request(...)` call against a now-gated route needs a valid `wl_email_session` cookie.

**Frontend — new:**
- `frontend/src/components/AuthGate.tsx` — wraps the router; shows email-entry/check-your-email UI when unauthenticated.

**Frontend — modified:**
- `frontend/src/api.ts` — `requestMagicLink`, `getMe`, `logout`.
- `frontend/src/App.tsx` — wrap `<Routes>` in `<AuthGate>`.
- `frontend/src/components/AppLayout.tsx` — "signed in as `<email>`" + sign-out button.

**Docs — modified:**
- `STATUS.md`, `BACKLOG.md` — mark the feature shipped, remove the top-priority security-gap callout.

---

## Phase A — New auth infrastructure (additive, no ripple)

### Task 1: Migration 0008 — `owner_email` on both tables, nullable `owner_session` on `projects`

**Files:**
- Create: `backend/migrations/0008_owner_email.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `listeners.owner_email TEXT` (nullable); `projects` rebuilt with `owner_session TEXT` (now nullable) and `owner_email TEXT` (new). Every later task assumes these columns exist.

- [ ] **Step 1: Write the migration file**

```sql
-- backend/migrations/0008_owner_email.sql
ALTER TABLE listeners ADD COLUMN owner_email TEXT;

-- projects.owner_session is currently NOT NULL (0005_projects.sql). Merged
-- rows need it set to NULL, so the constraint must be relaxed. SQLite/D1
-- has no ALTER COLUMN for constraints, so this uses the standard rebuild
-- recipe instead of a plain ALTER TABLE.
ALTER TABLE projects RENAME TO projects_old;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  owner_session TEXT,
  owner_email TEXT,
  sort_position INTEGER,
  label TEXT,
  share_token TEXT
);

INSERT INTO projects (id, created_at, owner_session, owner_email, sort_position, label, share_token)
  SELECT id, created_at, owner_session, NULL, sort_position, label, share_token FROM projects_old;

DROP TABLE projects_old;

CREATE UNIQUE INDEX idx_projects_share_token
  ON projects(share_token)
  WHERE share_token IS NOT NULL;
```

- [ ] **Step 2: Apply the migration to the local D1 database**

Run (from `backend/`): `npm run db:migrate:local`
Expected: `0008_owner_email.sql` reported as applied, no errors.

- [ ] **Step 3: Confirm the schema locally**

Run: `npx wrangler d1 execute webhook-listener --local --command ".schema listeners"` and `.schema projects` (same command form).
Expected: `listeners` has `owner_email`; `projects` has both `owner_session` (nullable — no `NOT NULL` in the `.schema` output) and `owner_email`; `idx_projects_share_token` still exists.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/0008_owner_email.sql
git commit -m "feat(backend): add owner_email, relax projects.owner_session to nullable"
```

---

### Task 2: Migration 0009 — `magic_links` table

**Files:**
- Create: `backend/migrations/0009_magic_links.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `magic_links(id, token_hash, email, expires_at, used_at, created_at)`. Task 6 (`magic-links.repo.ts`) is the only consumer.

- [ ] **Step 1: Write the migration file**

```sql
-- backend/migrations/0009_magic_links.sql
CREATE TABLE magic_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_magic_links_email ON magic_links(email);
```

- [ ] **Step 2: Apply and confirm**

Run: `npm run db:migrate:local`, then `npx wrangler d1 execute webhook-listener --local --command ".schema magic_links"`.
Expected: migration applied; table has all five columns plus the unique index on `token_hash` and the plain index on `email`.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/0009_magic_links.sql
git commit -m "feat(backend): add magic_links table"
```

---

### Task 3: `Env` bindings and Wrangler config

**Files:**
- Modify: `backend/src/env.ts`
- Modify: `backend/wrangler.toml`

**Interfaces:**
- Consumes: nothing.
- Produces: `Env.ALLOWED_EMAIL_DOMAINS: string`, `Env.WL_SESSION_SECRET: string`, `Env.RESEND_API_KEY: string`. Every task from here on that touches `Env` assumes these three exist alongside the existing `DB`, `HOOK_BASE_URL`, `APP_BASE_URL`, `SESSION_COOKIE_DOMAIN`.

- [ ] **Step 1: Add the bindings to `Env`**

```typescript
// backend/src/env.ts
export interface Env {
  DB: D1Database
  HOOK_BASE_URL: string
  APP_BASE_URL: string
  SESSION_COOKIE_DOMAIN?: string
  /** Comma-separated list of email domains allowed to request/use a magic link. */
  ALLOWED_EMAIL_DOMAINS: string
  /** HMAC key for signing the wl_email_session cookie. Wrangler secret in production. */
  WL_SESSION_SECRET: string
  /** Resend API key used to send magic-link emails. Wrangler secret in production. */
  RESEND_API_KEY: string
}
```

- [ ] **Step 2: Add dev-default vars to `wrangler.toml`**

```toml
# backend/wrangler.toml — inside the existing [vars] block
ALLOWED_EMAIL_DOMAINS = "nice.com,cognigy.com"
WL_SESSION_SECRET = "dev-only-not-a-real-secret"
RESEND_API_KEY = "dev-only-not-a-real-key"
```

Note for the deploy step (not part of this plan's tasks, but flag it in the commit body): production must override the latter two with real values via `wrangler secret put WL_SESSION_SECRET` and `wrangler secret put RESEND_API_KEY` — Workers secrets take precedence over same-named `[vars]` entries, so the dev defaults above are safe to commit and never reach production.

- [ ] **Step 3: Verify the backend still builds/tests**

Run (from `backend/`): `npm test`
Expected: all existing tests still pass (this task only adds fields/vars, nothing reads them yet).

- [ ] **Step 4: Commit**

```bash
git add backend/src/env.ts backend/wrangler.toml
git commit -m "feat(backend): add auth-related Env bindings and dev-default vars"
```

---

### Task 4: `auth/tokens.ts` — token hashing

**Files:**
- Create: `backend/src/auth/tokens.ts`
- Test: `backend/src/auth/tokens.test.ts`

**Interfaces:**
- Consumes: nothing (uses the Workers-native `crypto.subtle`).
- Produces: `hashToken(raw: string): Promise<string>` — hex-encoded SHA-256. Task 6 (`magic-links.repo.ts`) and Task 9 (`routes/auth.ts`) both call this by this exact name.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/auth/tokens.test.ts
import { describe, it, expect } from 'vitest'
import { hashToken } from './tokens'

describe('hashToken', () => {
  it('returns a 64-character hex string', async () => {
    const result = await hashToken('some-raw-token')
    expect(result).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', async () => {
    const a = await hashToken('same-input')
    const b = await hashToken('same-input')
    expect(a).toBe(b)
  })

  it('produces different hashes for different inputs', async () => {
    const a = await hashToken('input-a')
    const b = await hashToken('input-b')
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- auth/tokens.test.ts`
Expected: FAIL — `Cannot find module './tokens'`.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/auth/tokens.ts
export async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- auth/tokens.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/tokens.ts backend/src/auth/tokens.test.ts
git commit -m "feat(backend): add SHA-256 token hashing helper"
```

---

### Task 5: `auth/session.ts` — sign/verify the email session cookie

**Files:**
- Create: `backend/src/auth/session.ts`
- Test: `backend/src/auth/session.test.ts`

**Interfaces:**
- Consumes: nothing (uses `crypto.subtle` HMAC-SHA256).
- Produces: `signEmailSession(secret: string, email: string, expiresAt: string): Promise<string>`; `verifyEmailSession(secret: string, cookieValue: string): Promise<string | null>` (returns the email on success, `null` on any failure — bad signature, malformed payload, or expired). Task 9 (`routes/auth.ts`) and Task 12 (`app.ts` middleware) both call these by these exact names.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/auth/session.test.ts
import { describe, it, expect } from 'vitest'
import { signEmailSession, verifyEmailSession } from './session'

const SECRET = 'test-secret'

describe('signEmailSession / verifyEmailSession', () => {
  it('round-trips a valid, unexpired session', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const cookieValue = await signEmailSession(SECRET, 'person@nice.com', expiresAt)
    const result = await verifyEmailSession(SECRET, cookieValue)
    expect(result).toBe('person@nice.com')
  })

  it('rejects a tampered payload (flipped byte)', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const cookieValue = await signEmailSession(SECRET, 'person@nice.com', expiresAt)
    const [payload, signature] = cookieValue.split('.')
    const tamperedPayload = payload.slice(0, -1) + (payload.at(-1) === 'A' ? 'B' : 'A')
    const result = await verifyEmailSession(SECRET, `${tamperedPayload}.${signature}`)
    expect(result).toBeNull()
  })

  it('rejects a signature produced with a different secret', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const cookieValue = await signEmailSession('other-secret', 'person@nice.com', expiresAt)
    const result = await verifyEmailSession(SECRET, cookieValue)
    expect(result).toBeNull()
  })

  it('rejects an expired session', async () => {
    const expiresAt = new Date(Date.now() - 1000).toISOString()
    const cookieValue = await signEmailSession(SECRET, 'person@nice.com', expiresAt)
    const result = await verifyEmailSession(SECRET, cookieValue)
    expect(result).toBeNull()
  })

  it('rejects a malformed cookie value', async () => {
    const result = await verifyEmailSession(SECRET, 'not-a-valid-cookie-value')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- auth/session.test.ts`
Expected: FAIL — `Cannot find module './session'`.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/auth/session.ts
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return new Uint8Array(signature)
}

interface EmailSessionPayload {
  email: string
  expiresAt: string
}

export async function signEmailSession(secret: string, email: string, expiresAt: string): Promise<string> {
  const payload: EmailSessionPayload = { email, expiresAt }
  const payloadEncoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const signatureEncoded = base64UrlEncode(await hmacSha256(secret, payloadEncoded))
  return `${payloadEncoded}.${signatureEncoded}`
}

export async function verifyEmailSession(secret: string, cookieValue: string): Promise<string | null> {
  const parts = cookieValue.split('.')
  if (parts.length !== 2) return null
  const [payloadEncoded, signatureEncoded] = parts

  const expectedSignature = base64UrlEncode(await hmacSha256(secret, payloadEncoded))
  if (expectedSignature !== signatureEncoded) return null

  let payload: EmailSessionPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadEncoded)))
  } catch {
    return null
  }

  if (typeof payload.email !== 'string' || typeof payload.expiresAt !== 'string') return null
  if (new Date(payload.expiresAt).getTime() < Date.now()) return null

  return payload.email
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- auth/session.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/session.ts backend/src/auth/session.test.ts
git commit -m "feat(backend): add HMAC-signed email session cookie sign/verify"
```

---

### Task 6: `magic-links.repo.ts` — pending check, create, single-use consume

**Files:**
- Create: `backend/src/magic-links.repo.ts`
- Test: `backend/src/magic-links.repo.test.ts`

**Interfaces:**
- Consumes: `Env['DB']`; `hashToken` from `./auth/tokens` (Task 4, used only by the test file to compute a matching hash — the repo itself takes an already-hashed token).
- Produces: `hasPendingMagicLink(db, email): Promise<boolean>`; `createMagicLink(db, email, tokenHash, createdAt, expiresAt): Promise<void>`; `consumeMagicLink(db, tokenHash): Promise<{ email: string } | undefined>` (marks `used_at`, returns `undefined` if not found/expired/already used/lost a race). Task 9 (`routes/auth.ts`) calls all three by these exact names.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/magic-links.repo.test.ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { hasPendingMagicLink, createMagicLink, consumeMagicLink } from './magic-links.repo'
import { hashToken } from './auth/tokens'

describe('magic-links.repo', () => {
  it('hasPendingMagicLink is false when none exist for the email', async () => {
    const result = await hasPendingMagicLink(env.DB, 'nobody@nice.com')
    expect(result).toBe(false)
  })

  it('hasPendingMagicLink is true for an unexpired, unused link', async () => {
    const email = 'pending@nice.com'
    const tokenHash = await hashToken('raw-token-1')
    const now = new Date()
    await createMagicLink(env.DB, email, tokenHash, now.toISOString(), new Date(now.getTime() + 60_000).toISOString())
    expect(await hasPendingMagicLink(env.DB, email)).toBe(true)
  })

  it('hasPendingMagicLink is false once the link is expired', async () => {
    const email = 'expired@nice.com'
    const tokenHash = await hashToken('raw-token-2')
    const now = new Date()
    await createMagicLink(env.DB, email, tokenHash, now.toISOString(), new Date(now.getTime() - 1000).toISOString())
    expect(await hasPendingMagicLink(env.DB, email)).toBe(false)
  })

  it('consumeMagicLink returns the email and marks the link used', async () => {
    const email = 'consume@nice.com'
    const tokenHash = await hashToken('raw-token-3')
    const now = new Date()
    await createMagicLink(env.DB, email, tokenHash, now.toISOString(), new Date(now.getTime() + 60_000).toISOString())

    const result = await consumeMagicLink(env.DB, tokenHash)
    expect(result).toEqual({ email })
  })

  it('consumeMagicLink is single-use — a second call for the same token fails', async () => {
    const email = 'single-use@nice.com'
    const tokenHash = await hashToken('raw-token-4')
    const now = new Date()
    await createMagicLink(env.DB, email, tokenHash, now.toISOString(), new Date(now.getTime() + 60_000).toISOString())

    await consumeMagicLink(env.DB, tokenHash)
    const second = await consumeMagicLink(env.DB, tokenHash)
    expect(second).toBeUndefined()
  })

  it('consumeMagicLink returns undefined for an expired token', async () => {
    const tokenHash = await hashToken('raw-token-5')
    const now = new Date()
    await createMagicLink(env.DB, 'expired2@nice.com', tokenHash, now.toISOString(), new Date(now.getTime() - 1000).toISOString())

    const result = await consumeMagicLink(env.DB, tokenHash)
    expect(result).toBeUndefined()
  })

  it('consumeMagicLink returns undefined for an unknown token', async () => {
    const result = await consumeMagicLink(env.DB, await hashToken('never-created'))
    expect(result).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- magic-links.repo.test.ts`
Expected: FAIL — `Cannot find module './magic-links.repo'`.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/magic-links.repo.ts
import type { Env } from './env'

export async function hasPendingMagicLink(db: Env['DB'], email: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM magic_links WHERE email = ? AND used_at IS NULL AND expires_at > ? LIMIT 1')
    .bind(email, new Date().toISOString())
    .first()
  return row !== null
}

export async function createMagicLink(
  db: Env['DB'],
  email: string,
  tokenHash: string,
  createdAt: string,
  expiresAt: string
): Promise<void> {
  await db
    .prepare('INSERT INTO magic_links (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, email, expiresAt, createdAt)
    .run()
}

export async function consumeMagicLink(db: Env['DB'], tokenHash: string): Promise<{ email: string } | undefined> {
  const now = new Date().toISOString()
  const row = await db
    .prepare('SELECT id, email FROM magic_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(tokenHash, now)
    .first<{ id: number; email: string }>()
  if (!row) return undefined

  // Guard the UPDATE with used_at IS NULL so a raced double-click can only
  // ever have one caller actually consume the link.
  const result = await db
    .prepare('UPDATE magic_links SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .bind(now, row.id)
    .run()
  if ((result.meta.changes ?? 0) === 0) return undefined

  return { email: row.email }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- magic-links.repo.test.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/magic-links.repo.ts backend/src/magic-links.repo.test.ts
git commit -m "feat(backend): add magic_links repo — pending check, create, single-use consume"
```

---

### Task 7: `ownership-merge.ts` — merge an anonymous session into a verified email

**Files:**
- Create: `backend/src/ownership-merge.ts`
- Test: `backend/src/ownership-merge.test.ts`

**Interfaces:**
- Consumes: `Env['DB']`.
- Produces: `mergeSessionIntoEmail(db: Env['DB'], sessionId: string, email: string): Promise<void>`. Task 9 (`routes/auth.ts`) calls this by this exact name during `GET /auth/verify`.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/ownership-merge.test.ts
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { mergeSessionIntoEmail } from './ownership-merge'
import { createListener, getListener } from './listeners.repo'
import { createProject, getProject } from './projects.repo'

describe('mergeSessionIntoEmail', () => {
  it('reassigns a matching listener to the email and clears its owner_session', async () => {
    const sessionId = crypto.randomUUID()
    const listener = await createListener(env.DB, crypto.randomUUID(), new Date().toISOString(), sessionId)

    await mergeSessionIntoEmail(env.DB, sessionId, 'claimed@nice.com')

    const updated = await getListener(env.DB, listener.id)
    expect(updated?.ownerEmail).toBe('claimed@nice.com')
    expect(updated?.ownerSession).toBeNull()
  })

  it('reassigns a matching project to the email and clears its owner_session', async () => {
    const sessionId = crypto.randomUUID()
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), sessionId)

    await mergeSessionIntoEmail(env.DB, sessionId, 'claimed@nice.com')

    const updated = await getProject(env.DB, project.id)
    expect(updated?.ownerEmail).toBe('claimed@nice.com')
    expect(updated?.ownerSession).toBeNull()
  })

  it('does not touch rows belonging to a different session', async () => {
    const sessionId = crypto.randomUUID()
    const otherSessionId = crypto.randomUUID()
    const listener = await createListener(env.DB, crypto.randomUUID(), new Date().toISOString(), otherSessionId)

    await mergeSessionIntoEmail(env.DB, sessionId, 'claimed@nice.com')

    const untouched = await getListener(env.DB, listener.id)
    expect(untouched?.ownerEmail).toBeNull()
    expect(untouched?.ownerSession).toBe(otherSessionId)
  })

  it('is a no-op the second time it is called for the same session (already claimed)', async () => {
    const sessionId = crypto.randomUUID()
    const listener = await createListener(env.DB, crypto.randomUUID(), new Date().toISOString(), sessionId)

    await mergeSessionIntoEmail(env.DB, sessionId, 'first@nice.com')
    await mergeSessionIntoEmail(env.DB, sessionId, 'second@nice.com')

    const updated = await getListener(env.DB, listener.id)
    expect(updated?.ownerEmail).toBe('first@nice.com')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- ownership-merge.test.ts`
Expected: FAIL — `Cannot find module './ownership-merge'`.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/ownership-merge.ts
import type { Env } from './env'

export async function mergeSessionIntoEmail(db: Env['DB'], sessionId: string, email: string): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE listeners SET owner_email = ?, owner_session = NULL WHERE owner_session = ? AND owner_email IS NULL')
      .bind(email, sessionId),
    db
      .prepare('UPDATE projects SET owner_email = ?, owner_session = NULL WHERE owner_session = ? AND owner_email IS NULL')
      .bind(email, sessionId),
  ])
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- ownership-merge.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ownership-merge.ts backend/src/ownership-merge.test.ts
git commit -m "feat(backend): add one-time session-to-email ownership merge"
```

---

### Task 8: `email.ts` — send the magic-link email via Resend

**Files:**
- Create: `backend/src/email.ts`
- Test: `backend/src/email.test.ts`

**Interfaces:**
- Consumes: `Env['RESEND_API_KEY']`.
- Produces: `sendMagicLinkEmail(env: Env, email: string, verifyUrl: string): Promise<void>` — throws if Resend responds with a non-2xx status. Task 9 (`routes/auth.ts`) calls this by this exact name.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/email.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { sendMagicLinkEmail } from './email'

describe('sendMagicLinkEmail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs to the Resend API with the expected shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await sendMagicLinkEmail(env, 'person@nice.com', 'https://webhook-api.fde.nice-agentic.com/auth/verify?token=abc')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${env.RESEND_API_KEY}` }),
      })
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.to).toBe('person@nice.com')
    expect(body.from).toBe('noreply@fde.nice-agentic.com')
    expect(body.html).toContain('https://webhook-api.fde.nice-agentic.com/auth/verify?token=abc')
  })

  it('throws when Resend responds with a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))

    await expect(sendMagicLinkEmail(env, 'person@nice.com', 'https://example.com/verify')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- email.test.ts`
Expected: FAIL — `Cannot find module './email'`.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/email.ts
import type { Env } from './env'

export async function sendMagicLinkEmail(env: Env, email: string, verifyUrl: string): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: 'noreply@fde.nice-agentic.com',
      to: email,
      subject: 'Sign in to webhook-listener',
      html: `<p>Click the link below to sign in. This link expires in 15 minutes.</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
    }),
  })

  if (!response.ok) {
    throw new Error(`Resend request failed with status ${response.status}`)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- email.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/email.ts backend/src/email.test.ts
git commit -m "feat(backend): send magic-link emails via Resend"
```

---

### Task 9: `routes/auth.ts` — request-link, verify (+ merge), me, logout

**Files:**
- Create: `backend/src/routes/auth.ts`
- Test: `backend/src/routes/auth.test.ts`
- Modify: `backend/src/app.ts` — mount `authRoutes` (this task only mounts it; the tier-0 gate itself is Task 12)

**Interfaces:**
- Consumes: `hashToken` (Task 4); `signEmailSession`/`verifyEmailSession` (Task 5); `hasPendingMagicLink`/`createMagicLink`/`consumeMagicLink` (Task 6); `mergeSessionIntoEmail` (Task 7); `sendMagicLinkEmail` (Task 8).
- Produces: `export const authRoutes: Hono<{ Bindings: Env }>` mounted at `app.route('/', authRoutes)`. Task 12's tier-0 middleware excludes any path starting with `/auth/`.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/routes/auth.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { verifyEmailSession } from '../auth/session'

function stubResendOk() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
}

describe('auth routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POST /auth/request-link rejects a non-allow-listed domain with 400', async () => {
    const response = await app.request(
      '/auth/request-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'person@evil.com' }) },
      env
    )
    expect(response.status).toBe(400)
  })

  it('POST /auth/request-link accepts an allow-listed domain and sends an email', async () => {
    stubResendOk()
    const response = await app.request(
      '/auth/request-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'person@nice.com' }) },
      env
    )
    expect(response.status).toBe(200)
  })

  it('POST /auth/request-link rate-limits a second request while a token is outstanding', async () => {
    stubResendOk()
    await app.request(
      '/auth/request-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ratelimited@nice.com' }) },
      env
    )
    const second = await app.request(
      '/auth/request-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ratelimited@nice.com' }) },
      env
    )
    expect(second.status).toBe(429)
  })

  async function requestAndExtractVerifyUrl(email: string): Promise<string> {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await app.request(
      '/auth/request-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) },
      env
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const match = body.html.match(/href="([^"]+)"/)
    return match[1]
  }

  it('GET /auth/verify with a valid token issues a working wl_email_session cookie', async () => {
    const verifyUrl = await requestAndExtractVerifyUrl('verifyme@nice.com')
    const token = new URL(verifyUrl).searchParams.get('token')!

    const response = await app.request(`/auth/verify?token=${token}`, {}, env)
    expect(response.status).toBe(302)
    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith('wl_email_session='))
    expect(setCookie).toBeDefined()
    const cookieValue = setCookie!.split(';')[0].split('=')[1]
    expect(await verifyEmailSession(env.WL_SESSION_SECRET, cookieValue)).toBe('verifyme@nice.com')
  })

  it('GET /auth/verify redirects with authError for an invalid token', async () => {
    const response = await app.request('/auth/verify?token=not-a-real-token', {}, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('authError=invalid_link')
  })

  it('GET /auth/verify redirects with authError on a second use of the same token', async () => {
    const verifyUrl = await requestAndExtractVerifyUrl('reused@nice.com')
    const token = new URL(verifyUrl).searchParams.get('token')!

    await app.request(`/auth/verify?token=${token}`, {}, env)
    const second = await app.request(`/auth/verify?token=${token}`, {}, env)
    expect(second.headers.get('location')).toContain('authError=invalid_link')
  })

  it('GET /auth/me returns the email for a valid session cookie', async () => {
    const verifyUrl = await requestAndExtractVerifyUrl('me@nice.com')
    const token = new URL(verifyUrl).searchParams.get('token')!
    const verifyResponse = await app.request(`/auth/verify?token=${token}`, {}, env)
    const cookieValue = verifyResponse.headers
      .getSetCookie()
      .find((c) => c.startsWith('wl_email_session='))!
      .split(';')[0]

    const meResponse = await app.request('/auth/me', { headers: { cookie: cookieValue } }, env)
    expect(meResponse.status).toBe(200)
    expect(await meResponse.json()).toEqual({ email: 'me@nice.com' })
  })

  it('GET /auth/me returns 401 with no cookie', async () => {
    const response = await app.request('/auth/me', {}, env)
    expect(response.status).toBe(401)
  })

  it('POST /auth/logout clears the cookie', async () => {
    const response = await app.request('/auth/logout', { method: 'POST' }, env)
    expect(response.status).toBe(204)
    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith('wl_email_session='))
    expect(setCookie).toMatch(/Max-Age=0/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- routes/auth.test.ts`
Expected: FAIL — 404s, `/auth/*` isn't routed yet.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/routes/auth.ts
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Env } from '../env'
import { hashToken } from '../auth/tokens'
import { signEmailSession, verifyEmailSession } from '../auth/session'
import { hasPendingMagicLink, createMagicLink, consumeMagicLink } from '../magic-links.repo'
import { mergeSessionIntoEmail } from '../ownership-merge'
import { sendMagicLinkEmail } from '../email'

const TOKEN_TTL_MS = 15 * 60 * 1000
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const EMAIL_SESSION_COOKIE_NAME = 'wl_email_session'

function allowedDomains(env: Env): string[] {
  return env.ALLOWED_EMAIL_DOMAINS.split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
}

function domainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? ''
}

function cookieOptions(env: Env) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
    path: '/',
    ...(env.SESSION_COOKIE_DOMAIN ? { domain: env.SESSION_COOKIE_DOMAIN } : {}),
  }
}

export const authRoutes = new Hono<{ Bindings: Env }>()

authRoutes.post('/auth/request-link', async (c) => {
  const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown })
  if (typeof body.email !== 'string' || !body.email.includes('@')) {
    return c.json({ error: 'a valid email is required' }, 400)
  }

  const email = body.email.trim().toLowerCase()
  const domains = allowedDomains(c.env)
  if (!domains.includes(domainOf(email))) {
    return c.json({ error: `email domain must be one of: ${domains.join(', ')}` }, 400)
  }

  if (await hasPendingMagicLink(c.env.DB, email)) {
    return c.json({ error: 'a link was already sent to this address — check your email' }, 429)
  }

  const rawToken = crypto.randomUUID()
  const tokenHash = await hashToken(rawToken)
  const now = new Date()
  await createMagicLink(c.env.DB, email, tokenHash, now.toISOString(), new Date(now.getTime() + TOKEN_TTL_MS).toISOString())

  const verifyUrl = `${c.env.HOOK_BASE_URL}/auth/verify?token=${rawToken}`
  await sendMagicLinkEmail(c.env, email, verifyUrl)

  return c.json({ message: 'check your email for a sign-in link' })
})

authRoutes.get('/auth/verify', async (c) => {
  const token = c.req.query('token')
  const invalidRedirect = () => c.redirect(`${c.env.APP_BASE_URL}/?authError=invalid_link`, 302)
  if (!token) return invalidRedirect()

  const tokenHash = await hashToken(token)
  const consumed = await consumeMagicLink(c.env.DB, tokenHash)
  if (!consumed) return invalidRedirect()

  const sessionId = getCookie(c, 'wl_session_id')
  if (sessionId) {
    await mergeSessionIntoEmail(c.env.DB, sessionId, consumed.email)
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()
  const cookieValue = await signEmailSession(c.env.WL_SESSION_SECRET, consumed.email, expiresAt)
  setCookie(c, EMAIL_SESSION_COOKIE_NAME, cookieValue, {
    ...cookieOptions(c.env),
    maxAge: SESSION_TTL_SECONDS,
  })

  return c.redirect(`${c.env.APP_BASE_URL}/`, 302)
})

authRoutes.get('/auth/me', async (c) => {
  const cookieValue = getCookie(c, EMAIL_SESSION_COOKIE_NAME)
  const email = cookieValue ? await verifyEmailSession(c.env.WL_SESSION_SECRET, cookieValue) : null
  if (!email) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ email })
})

authRoutes.post('/auth/logout', async (c) => {
  deleteCookie(c, EMAIL_SESSION_COOKIE_NAME, cookieOptions(c.env))
  return c.body(null, 204)
})
```

Mount it in `app.ts`:

```typescript
// backend/src/app.ts — alongside the other route imports
import { authRoutes } from './routes/auth'
```

```typescript
// backend/src/app.ts — alongside app.route('/', hookRoute) etc.
app.route('/', authRoutes)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- routes/auth.test.ts`
Expected: PASS, all 11 tests green.

- [ ] **Step 5: Run the full backend test suite to check for regressions**

Run: `npm test`
Expected: everything still passes — the tier-0 gate doesn't exist yet (that's Task 12), so no existing route is affected.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/auth.ts backend/src/routes/auth.test.ts backend/src/app.ts
git commit -m "feat(backend): add magic-link auth routes (request-link, verify, me, logout)"
```

---

## Phase B — Cutover: email-based ownership + tier-0 gating

### Task 10: `listeners.repo.ts` — switch ownership to `owner_email`

**Files:**
- Modify: `backend/src/listeners.repo.ts`
- Modify: `backend/src/listeners.repo.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ListenerRecord.ownerEmail: string | null` (alongside the now-legacy `ownerSession: string | null`, which stays for the merge invariant but is never read by ownership checks again); `createListener(db, id, createdAt, ownerEmail): Promise<ListenerRecord>` (signature changed — third param is now an email, `ownerSession` is always inserted as `NULL`); `createProjectListener(db, id, createdAt, ownerSession, ownerEmail, projectId, slug): Promise<ListenerRecord>` (signature changed — takes **both**, since the tier-3 hook route in Task 13 needs to pass through whichever the owning project currently has); `getListenerForOwner(db, id, email)`/`getListenersForOwner(db, email, limit, sort)` now match on `owner_email`; `reorderItems(db, email, items)` now matches on `owner_email` for both tables. Task 13 (routes) and Task 14 (test migration) both depend on these exact names/signatures.

- [ ] **Step 1: Update the existing repo tests to the new signatures**

`backend/src/listeners.repo.test.ts` already exists and calls `createListener`/`createProjectListener`/`getListenerForOwner`/`getListenersForOwner`/`reorderItems` extensively. Read the current file first (`cat backend/src/listeners.repo.test.ts`), then apply this mechanical rule throughout:

- Every `createListener(env.DB, id, createdAt, 'session-a')` → `createListener(env.DB, id, createdAt, 'owner-a@nice.com')` (replace every session-id-shaped string literal used as the fourth arg with an email-shaped one — keep each distinct session string mapped to a distinct, correspondingly-named email string so "same owner" vs. "different owner" test intent is preserved).
- Every `createProjectListener(env.DB, id, createdAt, 'session-a', projectId, slug)` → `createProjectListener(env.DB, id, createdAt, null, 'owner-a@nice.com', projectId, slug)` (the fourth arg becomes `owner_session` — pass `null` since these tests create fresh, already-authenticated data — and a new fifth arg for `owner_email`; `projectId`/`slug` shift right by one position).
- Every `getListenerForOwner(env.DB, id, 'session-a')` → `getListenerForOwner(env.DB, id, 'owner-a@nice.com')`.
- Every `getListenersForOwner(env.DB, 'session-a', ...)` → `getListenersForOwner(env.DB, 'owner-a@nice.com', ...)`.
- Every `reorderItems(env.DB, 'session-a', items)` → `reorderItems(env.DB, 'owner-a@nice.com', items)`.
- Any assertion on `listener.ownerSession` → `listener.ownerEmail` (the returned record's owner field under test is now the email).

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npm test -- listeners.repo.test.ts`
Expected: FAIL — type errors / wrong-owner assertions, since the implementation hasn't changed yet.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/listeners.repo.ts — interface and SELECT_COLUMNS
export interface ListenerRecord {
  id: string
  createdAt: string
  shareToken: string | null
  ownerSession: string | null
  ownerEmail: string | null
  slug: string | null
  webhookToken: string | null
  label: string | null
  lastRequestAt: string | null
  sortPosition: number | null
  projectId: string | null
}

const SELECT_COLUMNS =
  'id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession, ' +
  'owner_email AS ownerEmail, slug, webhook_token AS webhookToken, label, last_request_at AS lastRequestAt, ' +
  'sort_position AS sortPosition, project_id AS projectId'
```

```typescript
// backend/src/listeners.repo.ts — createListener
export async function createListener(
  db: Env['DB'],
  id: string,
  createdAt: string,
  ownerEmail: string
): Promise<ListenerRecord> {
  await db
    .prepare('INSERT INTO listeners (id, created_at, owner_email) VALUES (?, ?, ?)')
    .bind(id, createdAt, ownerEmail)
    .run()
  return {
    id,
    createdAt,
    shareToken: null,
    ownerSession: null,
    ownerEmail,
    slug: null,
    webhookToken: null,
    label: null,
    lastRequestAt: null,
    sortPosition: null,
    projectId: null,
  }
}
```

```typescript
// backend/src/listeners.repo.ts — createProjectListener
export async function createProjectListener(
  db: Env['DB'],
  id: string,
  createdAt: string,
  ownerSession: string | null,
  ownerEmail: string | null,
  projectId: string,
  slug: string
): Promise<ListenerRecord> {
  await db
    .prepare(
      'INSERT INTO listeners (id, created_at, owner_session, owner_email, project_id, slug) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(id, createdAt, ownerSession, ownerEmail, projectId, slug)
    .run()
  return {
    id,
    createdAt,
    shareToken: null,
    ownerSession,
    ownerEmail,
    slug,
    webhookToken: null,
    label: null,
    lastRequestAt: null,
    sortPosition: null,
    projectId,
  }
}
```

```typescript
// backend/src/listeners.repo.ts — getListenerForOwner / getListenersForOwner
export async function getListenerForOwner(
  db: Env['DB'],
  id: string,
  email: string
): Promise<ListenerRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE id = ? AND owner_email = ?`)
    .bind(id, email)
    .first<ListenerRecord>()
  return row ?? undefined
}

export async function getListenersForOwner(
  db: Env['DB'],
  email: string,
  limit: number,
  sort: SortMode = 'date'
): Promise<ListenerRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE owner_email = ? ORDER BY ${SORT_CLAUSES[sort]} LIMIT ?`)
    .bind(email, limit)
    .all<ListenerRecord>()
  return results
}
```

```typescript
// backend/src/listeners.repo.ts — reorderItems
export async function reorderItems(db: Env['DB'], email: string, items: ReorderItem[]): Promise<boolean> {
  if (items.length === 0) return false

  const listenerIds = items.filter((item) => item.type === 'listener').map((item) => item.id)
  const projectIds = items.filter((item) => item.type === 'project').map((item) => item.id)

  const [ownedListeners, ownedProjects] = await Promise.all([
    db.prepare('SELECT id FROM listeners WHERE owner_email = ?').bind(email).all<{ id: string }>(),
    db.prepare('SELECT id FROM projects WHERE owner_email = ?').bind(email).all<{ id: string }>(),
  ])
  const ownedListenerIds = new Set(ownedListeners.results.map((r) => r.id))
  const ownedProjectIds = new Set(ownedProjects.results.map((r) => r.id))

  if (!listenerIds.every((id) => ownedListenerIds.has(id))) return false
  if (!projectIds.every((id) => ownedProjectIds.has(id))) return false

  const statements = items.map((item, index) =>
    item.type === 'listener'
      ? db.prepare('UPDATE listeners SET sort_position = ? WHERE id = ?').bind(index, item.id)
      : db.prepare('UPDATE projects SET sort_position = ? WHERE id = ?').bind(index, item.id)
  )
  await db.batch(statements)
  return true
}
```

Every other function in `listeners.repo.ts` (`getListener`, `getListenerByProjectAndSlug`, `getListenersByProject`, slug/label/share-token functions, `resolveListenerForHook`) is unaffected — they're not owner-scoped and don't change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- listeners.repo.test.ts`
Expected: PASS, same test count as before, all green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/listeners.repo.ts backend/src/listeners.repo.test.ts
git commit -m "feat(backend): switch listener ownership from owner_session to owner_email"
```

---

### Task 11: `projects.repo.ts` — switch ownership to `owner_email`

**Files:**
- Modify: `backend/src/projects.repo.ts`
- Modify: `backend/src/projects.repo.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ProjectRecord.ownerEmail: string | null` (and `ownerSession` becomes `string | null`, was `string`); `createProject(db, id, createdAt, ownerEmail): Promise<ProjectRecord>` (signature changed — third param is now an email, `owner_session` is always inserted as `NULL`); `getProjectForOwner(db, id, email)`/`getProjectsForOwner(db, email)` now match on `owner_email`. Task 13 (routes) and Task 14 (test migration) depend on these exact names/signatures.

- [ ] **Step 1: Update the existing repo tests to the new signatures**

Read `backend/src/projects.repo.test.ts`, then apply the same mechanical rule as Task 10, Step 1: every session-string third argument to `createProject` becomes an email string; every `getProjectForOwner`/`getProjectsForOwner` session argument becomes the matching email; any assertion on `project.ownerSession` for a freshly-created project becomes `project.ownerEmail`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- projects.repo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/projects.repo.ts — interface and SELECT_COLUMNS
export interface ProjectRecord {
  id: string
  createdAt: string
  ownerSession: string | null
  ownerEmail: string | null
  sortPosition: number | null
  label: string | null
  shareToken: string | null
}

const SELECT_COLUMNS =
  'id, created_at AS createdAt, owner_session AS ownerSession, owner_email AS ownerEmail, ' +
  'sort_position AS sortPosition, label, share_token AS shareToken'
```

```typescript
// backend/src/projects.repo.ts — createProject
export async function createProject(
  db: Env['DB'],
  id: string,
  createdAt: string,
  ownerEmail: string
): Promise<ProjectRecord> {
  await db
    .prepare('INSERT INTO projects (id, created_at, owner_email) VALUES (?, ?, ?)')
    .bind(id, createdAt, ownerEmail)
    .run()
  return { id, createdAt, ownerSession: null, ownerEmail, sortPosition: null, label: null, shareToken: null }
}
```

```typescript
// backend/src/projects.repo.ts — getProjectForOwner / getProjectsForOwner
export async function getProjectForOwner(
  db: Env['DB'],
  id: string,
  email: string
): Promise<ProjectRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ? AND owner_email = ?`)
    .bind(id, email)
    .first<ProjectRecord>()
  return row ?? undefined
}

export async function getProjectsForOwner(db: Env['DB'], email: string): Promise<ProjectRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM projects WHERE owner_email = ? ` +
        'ORDER BY (sort_position IS NULL), sort_position ASC, created_at DESC, id DESC'
    )
    .bind(email)
    .all<ProjectRecord>()
  return results
}
```

`getProject`, `setProjectLabel`, `getOrCreateProjectShareToken`, `revokeProjectShareToken`, `getProjectByShareToken`, `deleteProject` are unaffected.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- projects.repo.test.ts`
Expected: PASS, same test count as before, all green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/projects.repo.ts backend/src/projects.repo.test.ts
git commit -m "feat(backend): switch project ownership from owner_session to owner_email"
```

---

### Task 12: `app.ts` — tier-0 gate middleware

**Files:**
- Modify: `backend/src/app.ts`

**Interfaces:**
- Consumes: `verifyEmailSession` (Task 5).
- Produces: `Variables.email: string` (alongside the existing `Variables.sessionId`); every route mounted after this middleware can call `c.get('email')`. Task 13 depends on this.

- [ ] **Step 1: Write the middleware**

```typescript
// backend/src/app.ts — add the import
import { verifyEmailSession } from './auth/session'
```

```typescript
// backend/src/app.ts — extend Variables
export type Variables = { sessionId: string; email: string }
```

```typescript
// backend/src/app.ts — new middleware, placed after the existing wl_session_id
// middleware and before the app.route(...) calls
const EMAIL_SESSION_COOKIE_NAME = 'wl_email_session'

app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/hook/') || c.req.path.startsWith('/auth/')) {
    await next()
    return
  }

  const cookieValue = getCookie(c, EMAIL_SESSION_COOKIE_NAME)
  const email = cookieValue ? await verifyEmailSession(c.env.WL_SESSION_SECRET, cookieValue) : null
  if (!email) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  c.set('email', email)
  await next()
})
```

Place this middleware registration directly after the existing `wl_session_id` middleware block and before `app.route('/', hookRoute)` etc. — order matters: the session-id middleware must still run first (it needs to see `/hook/*` requests too, for its own unrelated reason), and this new gate must run before any `/api/*` route handler.

- [ ] **Step 2: Run the full backend test suite to see the expected breakage**

Run (from `backend/`): `npm test`
Expected: FAIL — every test that calls a now-gated route without a `wl_email_session` cookie gets `401` instead of its previous expected status. This is expected and is what Task 14 fixes. Do not attempt to fix any test files in this task — just confirm the middleware itself is correctly wired (i.e., failures are `401`s from this new check, not crashes or `500`s).

- [ ] **Step 3: Commit**

```bash
git add backend/src/app.ts
git commit -m "feat(backend): add tier-0 email-session gate middleware"
```

(Committing with a red test suite here is intentional and temporary — Task 13 and Task 14 are the very next tasks and fix it. Do not skip ahead or leave the branch at this commit.)

---

### Task 13: Route handlers — switch from `sessionId` to `email`

**Files:**
- Modify: `backend/src/routes/listeners.ts`
- Modify: `backend/src/routes/projects.ts`
- Modify: `backend/src/routes/hook.ts`

**Interfaces:**
- Consumes: `c.get('email')` (Task 12); `getListenerForOwner`/`getListenersForOwner`/`reorderItems`/`createListener`/`createProjectListener` (Task 10, new signatures); `getProjectForOwner`/`getProjectsForOwner`/`createProject` (Task 11, new signatures).
- Produces: nothing new consumed downstream — this is the last hop before the test migration in Task 14.

- [ ] **Step 1: Update `routes/listeners.ts`**

Every occurrence of `c.get('sessionId')` in this file becomes `c.get('email')` — there are no other changes needed, since Task 10 already made the repo functions accept an email in the same parameter position. Apply this to all nine call sites: `GET /api/listeners`, `POST /api/listeners/reorder`, `POST /api/listeners`, `GET /api/listeners/:id`, `GET /api/listeners/:id/requests`, `DELETE /api/listeners/:id`, `POST /api/listeners/:id/share`, `DELETE /api/listeners/:id/share`, `PUT /api/listeners/:id/slug`, `POST /api/listeners/:id/slug/rotate-token`, `DELETE /api/listeners/:id/slug`, `PATCH /api/listeners/:id/label`.

- [ ] **Step 2: Update `routes/projects.ts`**

Every occurrence of `c.get('sessionId')` becomes `c.get('email')` (same mechanical rule) — `POST /api/projects`, `GET /api/projects`, `PATCH /api/projects/:id/label`, `POST /api/projects/:id/share`, `DELETE /api/projects/:id/share`, `DELETE /api/projects/:id`, `POST /api/projects/:projectId/listeners`.

Additionally, in `POST /api/projects/:projectId/listeners`, `createProjectListener` gains a new argument (Task 10's signature change) — pass `null` for `ownerSession` and `project.ownerEmail` for `ownerEmail`, since by this point ownership was already verified by email:

```typescript
// backend/src/routes/projects.ts — inside POST /api/projects/:projectId/listeners
const listener = await createProjectListener(
  c.env.DB,
  crypto.randomUUID(),
  new Date().toISOString(),
  null,
  project.ownerEmail,
  project.id,
  slug
)
```

- [ ] **Step 3: Update `routes/hook.ts`**

`ALL /hook/:id` doesn't touch ownership at all — no change. `ALL /hook/:projectId/:identifier` calls `createProjectListener` with `project.ownerSession` as the third argument today; it must now pass through **both** owner fields from the project row, unchanged, since this route has no auth context (tier 3, exempt from the gate):

```typescript
// backend/src/routes/hook.ts — inside ALL /hook/:projectId/:identifier
listener = await createProjectListener(
  c.env.DB,
  crypto.randomUUID(),
  new Date().toISOString(),
  project.ownerSession,
  project.ownerEmail,
  project.id,
  identifier
)
```

This preserves the invariant from `ownership-merge.ts`: if the project is already claimed (`ownerEmail` set, `ownerSession` null), the new listener is born already claimed too; if the project is still a pre-gate legacy row (`ownerSession` set, `ownerEmail` null), the new listener stays that way until the project's owner eventually logs in and the merge picks up both rows together.

- [ ] **Step 4: Confirm the TypeScript build catches every remaining call site**

Run (from `backend/`): `npx tsc --noEmit`
Expected: no errors. If there are errors, they name every remaining place still passing the old argument shape — fix each one using the same patterns above.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/listeners.ts backend/src/routes/projects.ts backend/src/routes/hook.ts
git commit -m "feat(backend): switch route ownership checks from session to email"
```

(The test suite is still red after this task — that's expected, Task 14 fixes it.)

---

### Task 14: Migrate the existing test suite to the tier-0 gate

**Files:**
- Create: `backend/src/test-helpers/auth.ts`
- Modify: `backend/src/routes/listeners.ownership.test.ts` (full worked example, written out below)
- Modify (same mechanical pattern as the worked example): `backend/src/app.test.ts`, `backend/src/app.session.test.ts`, `backend/src/routes/hook.test.ts`, `backend/src/routes/hook.create-and-send.test.ts`, `backend/src/routes/listeners.label.test.ts`, `backend/src/routes/listeners.list.test.ts`, `backend/src/routes/listeners.projects.test.ts`, `backend/src/routes/listeners.reorder.test.ts`, `backend/src/routes/listeners.share.test.ts`, `backend/src/routes/listeners.slug.test.ts`, `backend/src/routes/projects.delete.test.ts`, `backend/src/routes/projects.label.test.ts`, `backend/src/routes/projects.listeners.test.ts`, `backend/src/routes/projects.share.test.ts`, `backend/src/routes/projects.test.ts`, `backend/src/routes/shared.projects.test.ts`, `backend/src/routes/shared.test.ts`

**Interfaces:**
- Consumes: `signEmailSession` (Task 5).
- Produces: `authCookieHeader(env: Env, email: string): Promise<Record<string, string>>` — a test-only helper. No other task depends on it; this is the last task in Phase B.

This is the largest single task in the plan by file count, but every file needs the *same* mechanical transformation — there is no per-file design decision here, only application of one pattern. Do not skip the worked example: it's the exact pattern every other file needs.

- [ ] **Step 1: Write the test helper**

```typescript
// backend/src/test-helpers/auth.ts
import { signEmailSession } from '../auth/session'
import type { Env } from '../env'

export async function authCookieHeader(env: Env, email: string): Promise<Record<string, string>> {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const cookieValue = await signEmailSession(env.WL_SESSION_SECRET, email, expiresAt)
  return { cookie: `wl_email_session=${cookieValue}` }
}
```

- [ ] **Step 2: Rewrite `listeners.ownership.test.ts` as the worked example**

This file is the most representative because it covers all three patterns every other file needs: (a) an authenticated owner making a request, (b) an authenticated *different* owner being correctly refused, and (c) a request with no auth at all — which now gets `401` instead of the old `404`, since the tier-0 gate runs before any ownership check.

```typescript
// backend/src/routes/listeners.ownership.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('listener ownership isolation', () => {
  let listenerId: string
  const ownerEmail = 'owner@nice.com'
  const otherEmail = 'other@nice.com'

  beforeEach(async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
  })

  it('is invisible to a different owner on GET /api/listeners/:id', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('is invisible to a different owner on GET /api/listeners/:id/requests', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/requests`,
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('cannot be deleted by a different owner', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { method: 'DELETE', headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)

    const stillThere = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(stillThere.status).toBe(200)
  })

  it('can be deleted by the owning email, and then 404s', async () => {
    const deleteResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(deleteResponse.status).toBe(204)

    const getResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(getResponse.status).toBe(404)
  })

  it('cannot have a share link created by a different owner', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('cannot have its share link revoked by a different owner', async () => {
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const response = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('is unauthorized for a request with no auth cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}`, {}, env)
    expect(response.status).toBe(401)
  })

  it('cannot be deleted by a request with no auth cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}`, { method: 'DELETE' }, env)
    expect(response.status).toBe(401)
  })

  it('cannot have a share link created by a request with no auth cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}/share`, { method: 'POST' }, env)
    expect(response.status).toBe(401)
  })

  it('cannot have its share link revoked by a request with no auth cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}/share`, { method: 'DELETE' }, env)
    expect(response.status).toBe(401)
  })

  it('returns the exact same 404 body as a nonexistent listener', async () => {
    const wrongOwnerResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    const nonexistentResponse = await app.request(
      '/api/listeners/does-not-exist',
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(await wrongOwnerResponse.json()).toEqual(await nonexistentResponse.json())
    expect(wrongOwnerResponse.status).toBe(nonexistentResponse.status)
  })

  it('a legacy listener with no owner_email is inaccessible via the route layer', async () => {
    await env.DB.prepare("INSERT INTO listeners (id, created_at) VALUES ('legacy-listener', '2024-01-01T00:00:00.000Z')").run()

    const response = await app.request(
      '/api/listeners/legacy-listener',
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('remains visible to the owning email throughout', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(200)
  })

  it('the hook route remains reachable regardless of auth', async () => {
    const response = await app.request(
      `/hook/${listenerId}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) },
      env
    )
    expect(response.status).toBe(200)
  })
})
```

- [ ] **Step 3: Run this one file to confirm the pattern works**

Run (from `backend/`): `npm test -- routes/listeners.ownership.test.ts`
Expected: PASS, all 14 tests green.

- [ ] **Step 4: Apply the identical pattern to every remaining listed file**

For each of the fifteen remaining files, read the file first, then apply exactly the transformations demonstrated above:

1. Replace the `cookieHeader`/`extractSessionId` import from `../test-helpers/session` with `authCookieHeader` from `../test-helpers/auth` (or `./test-helpers/auth` for `app.test.ts`/`app.session.test.ts`, which live one directory up from `routes/`).
2. Wherever a test creates a listener/project via `POST /api/listeners` or `POST /api/projects` and then reuses the returned session (via `extractSessionId`) to act as "the owner" on later calls, replace that with a fixed literal email constant for that test/describe block (e.g. `const ownerEmail = 'owner@nice.com'`) and pass `await authCookieHeader(env, ownerEmail)` as the `headers` option on every one of that block's requests — including the initial creation call, which under the old code had no cookie at all (relying on the auto-issued `wl_session_id`) and now must be authenticated.
3. Wherever a test asserts a specific status code for a request made with **no cookie at all**, change the expected status from whatever it was (typically `404`, sometimes an implicit "still works because ownership doesn't apply") to `401` — unless that route is `/hook/*` or `/auth/*`, which stay fully open and unchanged.
4. `app.session.test.ts` tests the `wl_session_id` cookie-issuing middleware itself, which this plan does not change — its existing assertions about `Set-Cookie: wl_session_id=...` stay as-is. It only needs the import path check from Step 4.1 if it happens to reference `cookieHeader`/`extractSessionId` (it does, for its own `wl_session_id` round-trip tests — leave those calls exactly as they are, since they're testing the *anonymous* session cookie, not the new email one).
5. `hook.test.ts` and `hook.create-and-send.test.ts` test `/hook/*`, which is exempt from the gate — the hook requests themselves need no auth cookie. Only the setup calls in these files that go through `/api/projects` or `/api/listeners` (to create a project/listener to hook against) need `await authCookieHeader(env, <some-email>)` added.
6. `shared.test.ts` and `shared.projects.test.ts` test `/api/shared/*`, which **is** gated (tier-0, bearer-token semantics — any valid session, not owner-matched). Every request to `/api/shared/*` in these files needs `await authCookieHeader(env, <any-email>)` added, even though the assertions inside don't care *which* email it is. Their setup calls (creating the listener/project to share) also need it.

- [ ] **Step 5: Run the full backend test suite**

Run: `npm test`
Expected: all tests pass, same total test count as before Task 12 introduced the gate (the gate changed *behavior*, not the number of test cases — every existing test still runs, just with an added auth cookie where needed).

- [ ] **Step 6: Commit**

```bash
git add backend/src/test-helpers/auth.ts backend/src/app.test.ts backend/src/app.session.test.ts backend/src/routes/*.test.ts
git commit -m "test(backend): migrate existing test suite to the tier-0 auth gate"
```

---

## Phase C — Frontend

### Task 15: `api.ts` — auth API functions

**Files:**
- Modify: `frontend/src/api.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `requestMagicLink(email: string): Promise<{ message: string }>`; `getMe(): Promise<{ email: string }>` (throws `ApiError` with `status: 401` when unauthenticated — callers check `err instanceof ApiError && err.status === 401`); `logout(): Promise<void>`. Task 16 (`AuthGate`) and Task 17 (`AppLayout`) both call these by these exact names.

- [ ] **Step 1: Add the three functions**

```typescript
// frontend/src/api.ts — add near the top-level exports, anywhere after ApiError/parseJsonOrThrow
export function requestMagicLink(email: string): Promise<{ message: string }> {
  return fetch(`${API_BASE_URL}/auth/request-link`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  }).then((r) => parseJsonOrThrow<{ message: string }>(r))
}

export function getMe(): Promise<{ email: string }> {
  return fetch(`${API_BASE_URL}/auth/me`, { credentials: 'include' }).then((r) => parseJsonOrThrow<{ email: string }>(r))
}

export async function logout(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}
```

- [ ] **Step 2: Verify the frontend still builds**

Run (from `frontend/`): `npm run build`
Expected: clean, 0 TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(frontend): add requestMagicLink/getMe/logout API functions"
```

---

### Task 16: `AuthGate` component — wraps the router

**Files:**
- Create: `frontend/src/components/AuthGate.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `getMe`, `requestMagicLink` from `../api` (Task 15).
- Produces: `export function AuthGate({ children }: { children: React.ReactNode })`. Renders `children` only once `getMe()` has resolved successfully; otherwise renders the email-entry/check-your-email UI. No later task depends on anything this component exports beyond mounting it around the router.

- [ ] **Step 1: Write the component**

```tsx
// frontend/src/components/AuthGate.tsx
import { useEffect, useState } from 'react'
import { getMe, requestMagicLink, ApiError } from '../api'

type GateState = 'checking' | 'authenticated' | 'unauthenticated'

function useAuthError(): string | null {
  const params = new URLSearchParams(window.location.search)
  const authError = params.get('authError')
  useEffect(() => {
    if (authError) {
      params.delete('authError')
      const next = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${next ? `?${next}` : ''}`)
    }
  }, [authError])
  return authError
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('checking')
  const authError = useAuthError()
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getMe()
      .then(() => setState('authenticated'))
      .catch(() => setState('unauthenticated'))
  }, [])

  if (state === 'checking') {
    return null
  }

  if (state === 'authenticated') {
    return <>{children}</>
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await requestMagicLink(email)
      setSubmitted(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError('That email domain is not allowed to sign in here.')
      } else if (err instanceof ApiError && err.status === 429) {
        setError('A link was already sent to this address — check your email.')
      } else {
        setError('Something went wrong. Try again.')
      }
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-4 p-6">
        {authError && (
          <p className="text-sm text-red-600">That link is invalid or expired. Request a new one below.</p>
        )}
        {submitted ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">Check your email for a sign-in link.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <label htmlFor="email" className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              Sign in with your email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
            >
              Send sign-in link
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wrap the router**

```tsx
// frontend/src/App.tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { AuthGate } from './components/AuthGate'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'
import { ProjectDetail } from './pages/ProjectDetail'
import { SharedListener } from './pages/SharedListener'
import { SharedProject } from './pages/SharedProject'
import { SharedProjectListener } from './pages/SharedProjectListener'

export function App() {
  return (
    <AuthGate>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Home />} />
            <Route path="/listener/:id" element={<Listener />} />
            <Route path="/projects/:projectId" element={<ProjectDetail />} />
            <Route path="/shared/:token" element={<SharedListener />} />
            <Route path="/shared/projects/:token" element={<SharedProject />} />
            <Route path="/shared/projects/:token/:listenerId" element={<SharedProjectListener />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthGate>
  )
}
```

- [ ] **Step 3: Verify the frontend build**

Run (from `frontend/`): `npm run build`
Expected: clean, 0 TypeScript errors.

- [ ] **Step 4: Manual verification**

Run `npm run dev` in both `backend/` and `frontend/`. Visit the frontend dev URL:
- Confirm the email-entry form renders (no route content underneath).
- Submit a non-allow-listed address (anything not `@nice.com`/`@cognigy.com`) — confirm the inline "not allowed" error.
- Submit an allow-listed address — since Resend isn't configured for local dev, expect the request to fail after hitting the real network call; this is expected without a real `RESEND_API_KEY` and is out of scope to fix here (see spec's Resend prerequisite). Confirm at minimum that the "check your email" state does *not* render if the request errors, and that a real error message shows instead.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AuthGate.tsx frontend/src/App.tsx
git commit -m "feat(frontend): add AuthGate wrapping the router"
```

---

### Task 17: `AppLayout` — signed-in-as + sign-out

**Files:**
- Modify: `frontend/src/components/AppLayout.tsx`

**Interfaces:**
- Consumes: `getMe`, `logout` from `../api` (Task 15).
- Produces: nothing consumed downstream — this is the last frontend task.

- [ ] **Step 1: Add the signed-in indicator and sign-out button**

```tsx
// frontend/src/components/AppLayout.tsx
import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Logo } from './Logo'
import { SettingsModal } from './SettingsModal'
import { getMe, logout } from '../api'

export function AppLayout() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    getMe()
      .then((me) => setEmail(me.email))
      .catch(() => setEmail(null))
  }, [])

  async function handleSignOut() {
    await logout()
    window.location.reload()
  }

  return (
    <div className="min-h-screen">
      <div className="flex items-center justify-between px-4 py-2">
        <Logo className="h-6" />
        <div className="flex items-center gap-3">
          {email && (
            <>
              <span className="text-sm text-slate-500 dark:text-slate-400">signed in as {email}</span>
              <button
                onClick={handleSignOut}
                className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                Sign out
              </button>
            </>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            ⚙
          </button>
        </div>
      </div>
      <Outlet />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
```

- [ ] **Step 2: Verify the frontend build**

Run (from `frontend/`): `npm run build`
Expected: clean, 0 TypeScript errors.

- [ ] **Step 3: Manual verification**

With the dev servers running and a way to reach an authenticated state (either a real Resend send in an environment where it's configured, or by manually setting a `wl_email_session` cookie signed with the local dev secret for testing): confirm "signed in as `<email>`" appears next to the settings cog, and clicking "Sign out" reloads into the email-entry gate.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AppLayout.tsx
git commit -m "feat(frontend): show signed-in email and sign-out control in AppLayout"
```

---

## Phase D — Wrap-up

### Task 18: Full regression pass and docs update

**Files:**
- Modify: `STATUS.md`
- Modify: `BACKLOG.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — documentation task only.

- [ ] **Step 1: Run the full backend test suite**

Run (from `backend/`): `npm test`
Expected: all tests pass. Record the new total test count for Step 3.

- [ ] **Step 2: Run the frontend build**

Run (from `frontend/`): `npm run build`
Expected: clean, 0 TypeScript errors.

- [ ] **Step 3: Update `STATUS.md`**

- Remove the "no authentication in front of it" top-priority-security-gap callout in the deployment section — replace it with a note that the email access gate is live, listing the two migrations (`0008_owner_email.sql`, `0009_magic_links.sql`) and the allow-listed domains.
- Update the backend test count and D1 migrations line (`0001_init.sql` → `0009_magic_links.sql`).
- Add a new numbered entry to "Features shipped and live" describing the magic-link gate and the session-to-email merge behavior, linking `docs/superpowers/specs/2026-09-20-email-access-gate-design.md`.

- [ ] **Step 2: Update `BACKLOG.md`**

Remove the "Top priority — security gap from going public" section entirely (the gap it describes is now closed). If any other backlog item referenced it, update that cross-reference.

- [ ] **Step 3: Commit**

```bash
git add STATUS.md BACKLOG.md
git commit -m "docs: mark email access gate feature as shipped"
```

---

## Self-Review Notes

- **Spec coverage:** §Access model → Tasks 9, 12, 13. §Existing listeners and projects (merge) → Task 7, exercised end-to-end in Task 9's verify tests. §Data model changes → Tasks 1, 2, 10, 11. §Session mechanism → Task 5. §Magic-link flow → Tasks 6, 8, 9. §Configuration → Task 3. §API changes summary → Tasks 9, 12, 13 (every route in that table is either newly added in Task 9, gated in Task 12, or has its ownership check switched in Task 13). §Frontend changes → Tasks 16, 17. §Error handling → covered by Task 9's `401`/`400`/`429`/redirect tests and Task 14's `401`-on-no-cookie tests. §Testing → each backend task's own test file; the merge-specific cases from the spec's testing section are Task 7's four tests plus Task 9's verify-flow tests. §Out of scope → no task builds an admin UI, OAuth, per-device revocation, or cross-device claiming; confirmed by omission.
- **Placeholder scan:** no TBD/TODO markers. Task 14's per-file rollout (Step 4) intentionally describes a mechanical transformation rather than repeating near-identical code fifteen times — the transformation itself, and the one full worked example it's based on, are both fully specified with real code.
- **Type consistency:** `ListenerRecord.ownerEmail`/`ownerSession` (Task 10) match their use in `ownership-merge.test.ts` (Task 7, written before Task 10 — both use the same field names, since Task 7's test file was written against the target shape this plan defines throughout, not the pre-existing one). `createProjectListener`'s five-then-seven-argument signature change (Task 10) is applied identically at both call sites that survive it: `routes/projects.ts` (Task 13, passes `null, project.ownerEmail`) and `routes/hook.ts` (Task 13, passes `project.ownerSession, project.ownerEmail`). `authCookieHeader` (Task 14) is defined once and used identically in the worked example and (per the stated rule) every other migrated test file.
- **Known intentional ordering:** Task 12 (add the gate) is committed *before* Task 13 and Task 14 fix the resulting test failures, and Task 13 is committed before Task 14 fixes the same failures for a second reason (signature changes). Each task's commit message and step notes flag this explicitly so an executor doesn't mistake the intermediate red suite for a mistake — do not stop and debug between Tasks 12/13/14; run them as a contiguous sequence.
