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
  expiresAt: string,
  returnTo: string | null = null
): Promise<void> {
  await db
    .prepare('INSERT INTO magic_links (token_hash, email, expires_at, created_at, return_to) VALUES (?, ?, ?, ?, ?)')
    .bind(tokenHash, email, expiresAt, createdAt, returnTo)
    .run()
}

// Read-only lookup for the GET landing page — deliberately does not consume
// the token. Email security scanners (Safe Links, Proofpoint, Mimecast, etc.)
// commonly pre-fetch links in incoming mail via a plain GET before the human
// ever clicks; if that GET consumed the token, the real click would always
// find it already used. Consumption only happens on the confirmation page's
// POST, which no scanner submits.
export async function peekMagicLink(
  db: Env['DB'],
  tokenHash: string
): Promise<{ email: string } | undefined> {
  const row = await db
    .prepare('SELECT email FROM magic_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(tokenHash, new Date().toISOString())
    .first<{ email: string }>()
  return row ?? undefined
}

export async function consumeMagicLink(
  db: Env['DB'],
  tokenHash: string
): Promise<{ email: string; returnTo: string | null } | undefined> {
  const now = new Date().toISOString()
  const row = await db
    .prepare('SELECT id, email, return_to FROM magic_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(tokenHash, now)
    .first<{ id: number; email: string; return_to: string | null }>()
  if (!row) return undefined

  // Guard the UPDATE with used_at IS NULL so a raced double-click can only
  // ever have one caller actually consume the link.
  const result = await db
    .prepare('UPDATE magic_links SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .bind(now, row.id)
    .run()
  if ((result.meta.changes ?? 0) === 0) return undefined

  return { email: row.email, returnTo: row.return_to }
}
