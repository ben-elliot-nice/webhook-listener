import type { Env } from './env'

export interface ProjectRecord {
  id: string
  createdAt: string
  ownerSession: string
  sortPosition: number | null
}

const SELECT_COLUMNS = 'id, created_at AS createdAt, owner_session AS ownerSession, sort_position AS sortPosition'

export async function createProject(
  db: Env['DB'],
  id: string,
  createdAt: string,
  ownerSession: string
): Promise<ProjectRecord> {
  await db
    .prepare('INSERT INTO projects (id, created_at, owner_session) VALUES (?, ?, ?)')
    .bind(id, createdAt, ownerSession)
    .run()
  return { id, createdAt, ownerSession, sortPosition: null }
}

export async function getProject(db: Env['DB'], id: string): Promise<ProjectRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`)
    .bind(id)
    .first<ProjectRecord>()
  return row ?? undefined
}

export async function getProjectsForOwner(db: Env['DB'], sessionId: string): Promise<ProjectRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM projects WHERE owner_session = ? ` +
        'ORDER BY (sort_position IS NULL), sort_position ASC, created_at DESC, id DESC'
    )
    .bind(sessionId)
    .all<ProjectRecord>()
  return results
}
