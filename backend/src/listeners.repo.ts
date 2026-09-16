import type { Db } from './db'

export interface ListenerRecord {
  id: string
  createdAt: string
}

export function createListener(db: Db, id: string, createdAt: string): ListenerRecord {
  db.prepare('INSERT INTO listeners (id, created_at) VALUES (?, ?)').run(id, createdAt)
  return { id, createdAt }
}

export function getListener(db: Db, id: string): ListenerRecord | undefined {
  return db
    .prepare('SELECT id, created_at AS createdAt FROM listeners WHERE id = ?')
    .get(id) as ListenerRecord | undefined
}

export function deleteListener(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM listeners WHERE id = ?').run(id)
  return result.changes > 0
}
