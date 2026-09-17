import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from './app'

describe('app', () => {
  it('responds (even with a 404) to prove the Hono app boots', async () => {
    const response = await app.request('/does-not-exist', {}, env)
    expect(response.status).toBe(404)
  })
})
