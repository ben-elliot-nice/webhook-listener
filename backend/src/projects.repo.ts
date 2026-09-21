import type { Env } from './env'
import { LabelValidationError } from './listeners.repo'

export interface ProjectRecord {
  id: string
  createdAt: string
  ownerSession: string
  sortPosition: number | null
  label: string | null
  shareToken: string | null
}

const SELECT_COLUMNS =
  'id, created_at AS createdAt, owner_session AS ownerSession, sort_position AS sortPosition, ' +
  'label, share_token AS shareToken'

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
  return { id, createdAt, ownerSession, sortPosition: null, label: null, shareToken: null }
}

export async function getProject(db: Env['DB'], id: string): Promise<ProjectRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`)
    .bind(id)
    .first<ProjectRecord>()
  return row ?? undefined
}

export async function getProjectForOwner(
  db: Env['DB'],
  id: string,
  sessionId: string
): Promise<ProjectRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ? AND owner_session = ?`)
    .bind(id, sessionId)
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

const MAX_LABEL_LENGTH = 100

export async function setProjectLabel(db: Env['DB'], id: string, rawLabel: string): Promise<string | null> {
  const trimmed = rawLabel.trim()
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new LabelValidationError(`label must be ${MAX_LABEL_LENGTH} characters or fewer`)
  }
  const value = trimmed.length > 0 ? trimmed : null
  await db.prepare('UPDATE projects SET label = ? WHERE id = ?').bind(value, id).run()
  return value
}

// Same read-then-write race trade-off as getOrCreateShareToken in
// listeners.repo.ts — accepted at this app's personal scale.
export async function getOrCreateProjectShareToken(db: Env['DB'], id: string): Promise<string | undefined> {
  const project = await getProject(db, id)
  if (!project) return undefined
  if (project.shareToken) return project.shareToken

  const token = crypto.randomUUID()
  await db.prepare('UPDATE projects SET share_token = ? WHERE id = ?').bind(token, id).run()
  return token
}

export async function revokeProjectShareToken(db: Env['DB'], id: string): Promise<boolean> {
  const result = await db.prepare('UPDATE projects SET share_token = NULL WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

export async function getProjectByShareToken(db: Env['DB'], token: string): Promise<ProjectRecord | undefined> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE share_token = ?`)
    .bind(token)
    .first<ProjectRecord>()
  return row ?? undefined
}

// Deletes every listener under this project first (their requests cascade
// via the already-working FK on requests.listener_id), then the project row
// itself — required because listeners.project_id has no declared cascade,
// and FK enforcement is genuinely on (see design spec §1).
export async function deleteProject(db: Env['DB'], id: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare('DELETE FROM listeners WHERE project_id = ?').bind(id),
    db.prepare('DELETE FROM projects WHERE id = ?').bind(id),
  ])
  const projectDeleteResult = results[1]
  return (projectDeleteResult.meta.changes ?? 0) > 0
}
