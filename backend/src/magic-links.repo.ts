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
