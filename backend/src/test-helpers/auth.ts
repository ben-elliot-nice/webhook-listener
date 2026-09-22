import { signEmailSession } from '../auth/session'
import type { Env } from '../env'

export async function authCookieHeader(env: Env, email: string): Promise<Record<string, string>> {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const cookieValue = await signEmailSession(env.WL_SESSION_SECRET, email, expiresAt)
  return { cookie: `wl_email_session=${cookieValue}` }
}
