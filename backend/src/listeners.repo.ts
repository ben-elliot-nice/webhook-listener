import type { Env } from './env'

export interface ListenerRecord {
  id: string
  createdAt: string
  shareToken: string | null
  ownerSession: string | null
}

const SELECT_COLUMNS = 'id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession'

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
  return { id, createdAt, shareToken: null, ownerSession }
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
