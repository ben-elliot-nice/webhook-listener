import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Env } from '../env'
import { hashToken } from '../auth/tokens'
import { signEmailSession, verifyEmailSession } from '../auth/session'
import { hasPendingMagicLink, createMagicLink, consumeMagicLink } from '../magic-links.repo'
import { mergeSessionIntoEmail } from '../ownership-merge'
import { sendMagicLinkEmail } from '../email'

const TOKEN_TTL_MS = 15 * 60 * 1000
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const EMAIL_SESSION_COOKIE_NAME = 'wl_email_session'

function allowedDomains(env: Env): string[] {
  return env.ALLOWED_EMAIL_DOMAINS.split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
}

function domainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? ''
}

// Only a same-origin relative path is allowed as a post-verify redirect
// target — must start with exactly one "/" (not "//", which browsers treat
// as protocol-relative) and contain no scheme before the first "/". Anything
// else is treated as absent rather than rejecting the request outright.
function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null
  return value
}

function cookieOptions(env: Env) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
    path: '/',
    ...(env.SESSION_COOKIE_DOMAIN ? { domain: env.SESSION_COOKIE_DOMAIN } : {}),
  }
}

export const authRoutes = new Hono<{ Bindings: Env }>()

authRoutes.post('/auth/request-link', async (c) => {
  const body = await c.req.json<{ email?: unknown; returnTo?: unknown }>().catch(() => ({}) as { email?: unknown; returnTo?: unknown })
  if (typeof body.email !== 'string' || !body.email.includes('@')) {
    return c.json({ error: 'a valid email is required' }, 400)
  }

  const email = body.email.trim().toLowerCase()
  const domains = allowedDomains(c.env)
  if (!domains.includes(domainOf(email))) {
    return c.json({ error: `email domain must be one of: ${domains.join(', ')}` }, 400)
  }

  if (await hasPendingMagicLink(c.env.DB, email)) {
    return c.json({ error: 'a link was already sent to this address — check your email' }, 429)
  }

  const rawToken = crypto.randomUUID()
  const tokenHash = await hashToken(rawToken)
  const now = new Date()
  await createMagicLink(
    c.env.DB,
    email,
    tokenHash,
    now.toISOString(),
    new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
    safeReturnTo(body.returnTo)
  )

  const verifyUrl = `${c.env.HOOK_BASE_URL}/auth/verify?token=${rawToken}`
  await sendMagicLinkEmail(c.env, email, verifyUrl)

  return c.json({ message: 'check your email for a sign-in link' })
})

authRoutes.get('/auth/verify', async (c) => {
  const token = c.req.query('token')
  const invalidRedirect = () => c.redirect(`${c.env.APP_BASE_URL}/?authError=invalid_link`, 302)
  if (!token) return invalidRedirect()

  const tokenHash = await hashToken(token)
  const consumed = await consumeMagicLink(c.env.DB, tokenHash)
  if (!consumed) return invalidRedirect()

  const sessionId = getCookie(c, 'wl_session_id')
  if (sessionId) {
    await mergeSessionIntoEmail(c.env.DB, sessionId, consumed.email)
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()
  const cookieValue = await signEmailSession(c.env.WL_SESSION_SECRET, consumed.email, expiresAt)
  setCookie(c, EMAIL_SESSION_COOKIE_NAME, cookieValue, {
    ...cookieOptions(c.env),
    maxAge: SESSION_TTL_SECONDS,
  })

  return c.redirect(`${c.env.APP_BASE_URL}${consumed.returnTo ?? '/'}`, 302)
})

authRoutes.get('/auth/me', async (c) => {
  const cookieValue = getCookie(c, EMAIL_SESSION_COOKIE_NAME)
  const email = cookieValue ? await verifyEmailSession(c.env.WL_SESSION_SECRET, cookieValue) : null
  if (!email) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ email })
})

authRoutes.post('/auth/logout', async (c) => {
  deleteCookie(c, EMAIL_SESSION_COOKIE_NAME, cookieOptions(c.env))
  return c.body(null, 204)
})
