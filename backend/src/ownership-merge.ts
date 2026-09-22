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
