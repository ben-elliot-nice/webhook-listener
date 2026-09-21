import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from './app'
import { authCookieHeader } from './test-helpers/auth'

// Registered at module load time, before any `app.request(...)` call builds
// Hono's router matcher (adding routes afterwards throws).
app.get('/api/__boom', () => {
  throw new Error('boom')
})

describe('app', () => {
  it('responds (even with a 404) to prove the Hono app boots', async () => {
    const response = await app.request(
      '/does-not-exist',
      { headers: await authCookieHeader(env, 'owner@nice.com') },
      env
    )
    expect(response.status).toBe(404)
  })
})

describe('error handling preserves CORS headers', () => {
  it('returns 500 with CORS headers intact when a route handler throws', async () => {
    const response = await app.request(
      '/api/__boom',
      { headers: { Origin: env.APP_BASE_URL, ...(await authCookieHeader(env, 'owner@nice.com')) } },
      env
    )

    expect(response.status).toBe(500)
    expect(response.headers.get('access-control-allow-origin')).toBe(env.APP_BASE_URL)
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(await response.json()).toEqual({ error: 'internal server error' })
  })
})

describe('CORS on /api/*', () => {
  it('allows the configured APP_BASE_URL with credentials', async () => {
    const response = await app.request(
      '/api/listeners',
      { headers: { Origin: env.APP_BASE_URL } },
      env
    )
    expect(response.headers.get('access-control-allow-origin')).toBe(env.APP_BASE_URL)
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('does not reflect back a foreign Origin', async () => {
    const response = await app.request(
      '/api/listeners',
      { headers: { Origin: 'https://evil.example.com' } },
      env
    )
    expect(response.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com')
    expect(response.headers.get('access-control-allow-origin')).toBe(env.APP_BASE_URL)
  })
})
