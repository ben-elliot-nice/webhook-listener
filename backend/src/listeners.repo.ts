import type { Env } from './env'

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

export async function createListener(
  db: Env['DB'],
  id: string,
  createdAt: string,
  ownerSession: string
): Promise<ListenerRecord> {
  await db
    .prepare('INSERT INTO listeners (id, created_at, owner_session) VALUES (?, ?, ?)')
    .bind(id, createdAt, ownerSession)
    .run()
  return { id, createdAt, shareToken: null, ownerSession, slug: null, webhookToken: null, label: null, lastRequestAt: null, sortPosition: null }
}

export async function getListener(db: Env['DB'], id: string): Promise<ListenerRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE id = ?`)
    .bind(id)
    .first<ListenerRecord>()
  return row ?? undefined
}

export async function getListenerForOwner(
  db: Env['DB'],
  id: string,
  sessionId: string
): Promise<ListenerRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE id = ? AND owner_session = ?`)
    .bind(id, sessionId)
    .first<ListenerRecord>()
  return row ?? undefined
}

export async function getListenersForOwner(
  db: Env['DB'],
  sessionId: string,
  limit: number
): Promise<ListenerRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM listeners WHERE owner_session = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(sessionId, limit)
    .all<ListenerRecord>()
  return results
}

export async function deleteListener(db: Env['DB'], id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM listeners WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

// Read-then-write, now across two awaited D1 calls instead of one synchronous
// better-sqlite3 call — two concurrent callers could both read "no token" and
// both write, with the last write winning. Accepted at this app's personal
// scale, same trade-off the original synchronous-only comment flagged, now
// under D1's async model instead of better-sqlite3's single-threaded one.
export async function getOrCreateShareToken(db: Env['DB'], id: string): Promise<string | undefined> {
  const listener = await getListener(db, id)
  if (!listener) return undefined
  if (listener.shareToken) return listener.shareToken

  const token = crypto.randomUUID()
  await db.prepare('UPDATE listeners SET share_token = ? WHERE id = ?').bind(token, id).run()
  return token
}

export async function revokeShareToken(db: Env['DB'], id: string): Promise<boolean> {
  const result = await db.prepare('UPDATE listeners SET share_token = NULL WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

export async function getListenerByShareToken(db: Env['DB'], token: string): Promise<ListenerRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listeners WHERE share_token = ?`)
    .bind(token)
    .first<ListenerRecord>()
  return row ?? undefined
}

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
