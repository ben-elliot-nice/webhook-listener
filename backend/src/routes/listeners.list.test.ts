import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('GET /api/listeners', () => {
  it('returns an empty array for an owner with no listeners', async () => {
    const response = await app.request('/api/listeners', { headers: await authCookieHeader(env, 'nobody@nice.com') }, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it("returns only the calling owner's own listeners, newest first", async () => {
    const ownerEmail = 'owner@nice.com'
    const otherEmail = 'other@nice.com'

    const first = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const firstBody = (await first.json()) as { id: string }

    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const secondBody = (await second.json()) as { id: string }

    const otherCreate = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, otherEmail) },
      env
    )
    const otherBody = (await otherCreate.json()) as { id: string }

    const response = await app.request('/api/listeners', { headers: await authCookieHeader(env, ownerEmail) }, env)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { id: string }[]
    expect(body.map((l) => l.id)).toEqual([secondBody.id, firstBody.id])

    const otherResponse = await app.request(
      '/api/listeners',
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    const otherListed = (await otherResponse.json()) as { id: string }[]
    expect(otherListed.map((l) => l.id)).toEqual([otherBody.id])
  })

  it('builds hookUrl from HOOK_BASE_URL, not APP_BASE_URL', async () => {
    const response = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, 'owner@nice.com') },
      env
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as { id: string; hookUrl: string }
    expect(body.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${body.id}`)
  })

  it('includes hookUrl and shareUrl on each item, matching the single-listener shape', async () => {
    const ownerEmail = 'owner@nice.com'
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const createdBody = (await created.json()) as { hookUrl: string }

    const response = await app.request('/api/listeners', { headers: await authCookieHeader(env, ownerEmail) }, env)
    const [listed] = (await response.json()) as { hookUrl: string; shareUrl: string | null }[]
    expect(listed.hookUrl).toBe(createdBody.hookUrl)
    expect(listed.shareUrl).toBeNull()
  })

  it('falls back to date sort for an unrecognized ?sort= value', async () => {
    const ownerEmail = 'owner@nice.com'
    const first = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const firstBody = (await first.json()) as { id: string }
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const secondBody = (await second.json()) as { id: string }

    const response = await app.request(
      '/api/listeners?sort=nonsense',
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const body = (await response.json()) as { id: string }[]
    expect(body.map((l) => l.id)).toEqual([secondBody.id, firstBody.id])
  })
})
