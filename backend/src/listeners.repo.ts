import { randomUUID } from 'node:crypto'
import type { Db } from './db'

export interface ListenerRecord {
  id: string
  createdAt: string
  shareToken: string | null
  ownerSession: string | null
}

export function createListener(db: Db, id: string, createdAt: string, ownerSession: string): ListenerRecord {
  db.prepare('INSERT INTO listeners (id, created_at, owner_session) VALUES (?, ?, ?)').run(id, createdAt, ownerSession)
  return { id, createdAt, shareToken: null, ownerSession }
}

export function getListener(db: Db, id: string): ListenerRecord | undefined {
  return db
    .prepare(
      'SELECT id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession FROM listeners WHERE id = ?'
    )
    .get(id) as ListenerRecord | undefined
}

export function getListenerForOwner(db: Db, id: string, sessionId: string): ListenerRecord | undefined {
  return db
    .prepare(
      'SELECT id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession FROM listeners WHERE id = ? AND owner_session = ?'
    )
    .get(id, sessionId) as ListenerRecord | undefined
}

export function deleteListener(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM listeners WHERE id = ?').run(id)
  return result.changes > 0
}

// Safe only because this whole function runs synchronously (better-sqlite3 is a
// synchronous driver) — nothing can interleave between the read and the write.
// Do not introduce an `await` between them without adding a transaction.
export function getOrCreateShareToken(db: Db, id: string): string | undefined {
  const listener = getListener(db, id)
  if (!listener) return undefined
  if (listener.shareToken) return listener.shareToken

  const token = randomUUID()
  db.prepare('UPDATE listeners SET share_token = ? WHERE id = ?').run(token, id)
  return token
}

export function revokeShareToken(db: Db, id: string): boolean {
  const result = db.prepare('UPDATE listeners SET share_token = NULL WHERE id = ?').run(id)
  return result.changes > 0
}

export function getListenerByShareToken(db: Db, token: string): ListenerRecord | undefined {
  return db
    .prepare(
      'SELECT id, created_at AS createdAt, share_token AS shareToken, owner_session AS ownerSession FROM listeners WHERE share_token = ?'
    )
    .get(token) as ListenerRecord | undefined
}
