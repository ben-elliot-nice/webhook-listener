import { describe, it, expect, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { verifyEmailSession } from '../auth/session'

function stubResendOk() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
}

async function postVerify(token: string) {
  return app.request(
    '/auth/verify',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    },
    env
  )
}

describe('auth routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POST /auth/request-link rejects a non-allow-listed domain with 400', async () => {
    const response = await app.request(
      '/auth/request-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'person@evil.com' }) },
      env
    )
    expect(response.status).toBe(400)
  })

  it('POST /auth/request-link accepts an allow-listed domain and sends an email', async () => {
    stubResendOk()
    const response = await app.request(
      '/auth/request-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'person@nice.com' }) },
      env
    )
    expect(response.status).toBe(200)
  })

  it('POST /auth/request-link rate-limits a second request while a token is outstanding', async () => {
    stubResendOk()
    await app.request(
      '/auth/request-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ratelimited@nice.com' }) },
      env
    )
    const second = await app.request(
      '/auth/request-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ratelimited@nice.com' }) },
      env
    )
    expect(second.status).toBe(429)
  })

  async function requestAndExtractVerifyUrl(email: string, returnTo?: string): Promise<string> {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await app.request(
      '/auth/request-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, returnTo }) },
      env
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const match = body.html.match(/href="([^"]+)"/)
    return match[1]
  }

  it('GET /auth/verify renders a confirmation page without consuming the token', async () => {
    const verifyUrl = await requestAndExtractVerifyUrl('scanner@nice.com')
    const token = new URL(verifyUrl).searchParams.get('token')!

    const getResponse = await app.request(`/auth/verify?token=${token}`, {}, env)
    expect(getResponse.status).toBe(200)
    expect(getResponse.headers.get('content-type')).toContain('text/html')
    const html = await getResponse.text()
    expect(html).toContain('scanner@nice.com')
    expect(html).toContain(token)
    expect(html).toContain('action="/auth/verify"')

    // A plain GET (the kind an email-security link scanner performs) must
    // never consume the token — the real click (a POST) should still work.
    const postResponse = await postVerify(token)
    expect(postResponse.status).toBe(302)
  })

  it('GET /auth/verify redirects with authError for an invalid token', async () => {
    const response = await app.request('/auth/verify?token=not-a-real-token', {}, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('authError=invalid_link')
  })

  it('POST /auth/verify with a valid token issues a working wl_email_session cookie', async () => {
    const verifyUrl = await requestAndExtractVerifyUrl('verifyme@nice.com')
    const token = new URL(verifyUrl).searchParams.get('token')!

    const response = await postVerify(token)
    expect(response.status).toBe(302)
    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith('wl_email_session='))
    expect(setCookie).toBeDefined()
    const cookieValue = setCookie!.split(';')[0].split('=')[1]
    expect(await verifyEmailSession(env.WL_SESSION_SECRET, cookieValue)).toBe('verifyme@nice.com')
  })

  it('POST /auth/verify redirects to the requested returnTo path after verifying', async () => {
    const verifyUrl = await requestAndExtractVerifyUrl('returnto@nice.com', '/shared/abc123')
    const token = new URL(verifyUrl).searchParams.get('token')!

    const response = await postVerify(token)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${env.APP_BASE_URL}/shared/abc123`)
  })

  it('POST /auth/verify falls back to "/" when no returnTo was supplied', async () => {
    const verifyUrl = await requestAndExtractVerifyUrl('noreturnto@nice.com')
    const token = new URL(verifyUrl).searchParams.get('token')!

    const response = await postVerify(token)
    expect(response.headers.get('location')).toBe(`${env.APP_BASE_URL}/`)
  })

  it('POST /auth/verify falls back to "/" when returnTo is not a safe relative path', async () => {
    const verifyUrl = await requestAndExtractVerifyUrl('badreturnto@nice.com', '//evil.com')
    const token = new URL(verifyUrl).searchParams.get('token')!

    const response = await postVerify(token)
    expect(response.headers.get('location')).toBe(`${env.APP_BASE_URL}/`)
  })

  it('POST /auth/verify redirects with authError for an unknown token', async () => {
    const response = await postVerify('not-a-real-token')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('authError=invalid_link')
  })

  it('POST /auth/verify redirects with authError on a second use of the same token', async () => {
    const verifyUrl = await requestAndExtractVerifyUrl('reused@nice.com')
    const token = new URL(verifyUrl).searchParams.get('token')!

    await postVerify(token)
    const second = await postVerify(token)
    expect(second.headers.get('location')).toContain('authError=invalid_link')
  })

  it('GET /auth/me returns the email for a valid session cookie', async () => {
    const verifyUrl = await requestAndExtractVerifyUrl('me@nice.com')
    const token = new URL(verifyUrl).searchParams.get('token')!
    const verifyResponse = await postVerify(token)
    const cookieValue = verifyResponse.headers
      .getSetCookie()
      .find((c) => c.startsWith('wl_email_session='))!
      .split(';')[0]

    const meResponse = await app.request('/auth/me', { headers: { cookie: cookieValue } }, env)
    expect(meResponse.status).toBe(200)
    expect(await meResponse.json()).toEqual({ email: 'me@nice.com' })
  })

  it('GET /auth/me returns 401 with no cookie', async () => {
    const response = await app.request('/auth/me', {}, env)
    expect(response.status).toBe(401)
  })

  it('POST /auth/logout clears the cookie', async () => {
    const response = await app.request('/auth/logout', { method: 'POST' }, env)
    expect(response.status).toBe(204)
    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith('wl_email_session='))
    expect(setCookie).toMatch(/Max-Age=0/i)
  })
})
