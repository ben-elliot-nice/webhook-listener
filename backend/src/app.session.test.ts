import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from './app'
import { cookieHeader, extractSessionId } from './test-helpers/session'

describe('session cookie', () => {
  it('sets a wl_session_id cookie when the request has none', async () => {
    const response = await app.request('/does-not-exist', {}, env)
    const setCookies = response.headers.getSetCookie()
    expect(setCookies.some((c) => c.startsWith('wl_session_id='))).toBe(true)
  })

  it('reuses an existing wl_session_id cookie instead of issuing a new one', async () => {
    const first = await app.request('/does-not-exist', {}, env)
    const sessionId = extractSessionId(first)

    const second = await app.request('/does-not-exist', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    const setCookies = second.headers.getSetCookie()
    expect(setCookies.some((c) => c.startsWith('wl_session_id='))).toBe(false)
  })

  it('issues different session ids to requests with no cookie', async () => {
    const first = await app.request('/does-not-exist', {}, env)
    const second = await app.request('/does-not-exist', {}, env)
    expect(extractSessionId(first)).not.toBe(extractSessionId(second))
  })

  it('replaces a malformed wl_session_id cookie value with a fresh one', async () => {
    const response = await app.request(
      '/does-not-exist',
      { headers: cookieHeader({ wl_session_id: 'not-a-uuid' }) },
      env
    )
    const sessionId = extractSessionId(response)
    expect(sessionId).not.toBe('not-a-uuid')
  })

  it('sets HttpOnly, Secure, SameSite=Lax, a ~1yr Max-Age, and the configured Domain', async () => {
    const response = await app.request('/does-not-exist', {}, env)
    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith('wl_session_id='))
    expect(setCookie).toBeDefined()
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    expect(setCookie).toMatch(/Max-Age=31536000/i)
    expect(setCookie).toMatch(new RegExp(`Domain=${env.SESSION_COOKIE_DOMAIN}`, 'i'))
  })
})
