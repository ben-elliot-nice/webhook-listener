import type { Env } from './env'

export type SharedWithMeKind = 'listener' | 'project'

export interface SharedWithMeRow {
  kind: SharedWithMeKind
  token: string
  firstVisitedAt: string
}

export async function recordSharedVisit(
  db: Env['DB'],
  viewerEmail: string,
  kind: SharedWithMeKind,
  token: string,
  now: string
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO shared_with_me (viewer_email, kind, token, first_visited_at, last_visited_at, removed_at) ' +
        'VALUES (?, ?, ?, ?, ?, NULL) ' +
        'ON CONFLICT(viewer_email, kind, token) DO UPDATE SET last_visited_at = excluded.last_visited_at, removed_at = NULL'
    )
    .bind(viewerEmail, kind, token, now, now)
    .run()
}

export async function listSharedWithMe(db: Env['DB'], viewerEmail: string): Promise<SharedWithMeRow[]> {
  const { results } = await db
    .prepare(
      'SELECT kind, token, first_visited_at AS firstVisitedAt FROM shared_with_me ' +
        'WHERE viewer_email = ? AND removed_at IS NULL ORDER BY first_visited_at DESC'
    )
    .bind(viewerEmail)
    .all<SharedWithMeRow>()
  return results
}

export async function removeSharedWithMe(
  db: Env['DB'],
  viewerEmail: string,
  kind: SharedWithMeKind,
  token: string,
  now: string
): Promise<void> {
  await db
    .prepare('UPDATE shared_with_me SET removed_at = ? WHERE viewer_email = ? AND kind = ? AND token = ?')
    .bind(now, viewerEmail, kind, token)
    .run()
}
