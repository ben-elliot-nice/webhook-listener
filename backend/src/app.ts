import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie } from 'hono/cookie'
import type { Env } from './env'
import { hookRoute } from './routes/hook'
import { listenerRoutes } from './routes/listeners'
import { sharedRoutes } from './routes/shared'
import { projectRoutes } from './routes/projects'

export type Variables = { sessionId: string }

const SESSION_COOKIE_NAME = 'wl_session_id'
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.use(
  '/api/*',
  cors({
    origin: (_origin, c) => c.env.APP_BASE_URL,
    credentials: true,
  })
)

app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/hook/')) {
    await next()
    return
  }

  const existing = getCookie(c, SESSION_COOKIE_NAME)
  if (existing && UUID_PATTERN.test(existing)) {
    c.set('sessionId', existing)
    await next()
    return
  }

  const sessionId = crypto.randomUUID()
  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    ...(c.env.SESSION_COOKIE_DOMAIN ? { domain: c.env.SESSION_COOKIE_DOMAIN } : {}),
  })
  c.set('sessionId', sessionId)
  await next()
})

app.route('/', hookRoute)
app.route('/', listenerRoutes)
app.route('/', sharedRoutes)
app.route('/', projectRoutes)

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: 'internal server error' }, 500)
})
