import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from './app'

describe('app', () => {
  it('responds (even with a 404) to prove the Hono app boots', async () => {
    const response = await app.request('/does-not-exist', {}, env)
    expect(response.status).toBe(404)
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
