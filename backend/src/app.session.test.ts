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
})
