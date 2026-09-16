import { randomUUID } from 'node:crypto'
import type { Db } from './db'

export interface ListenerRecord {
  id: string
  createdAt: string
  shareToken: string | null
}

export function createListener(db: Db, id: string, createdAt: string): ListenerRecord {
  db.prepare('INSERT INTO listeners (id, created_at) VALUES (?, ?)').run(id, createdAt)
  return { id, createdAt, shareToken: null }
}

export function getListener(db: Db, id: string): ListenerRecord | undefined {
  return db
    .prepare('SELECT id, created_at AS createdAt, share_token AS shareToken FROM listeners WHERE id = ?')
    .get(id) as ListenerRecord | undefined
}

export function deleteListener(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM listeners WHERE id = ?').run(id)
  return result.changes > 0
}

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
    .prepare('SELECT id, created_at AS createdAt, share_token AS shareToken FROM listeners WHERE share_token = ?')
    .get(token) as ListenerRecord | undefined
}
