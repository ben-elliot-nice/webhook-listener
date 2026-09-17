import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('GET /api/listeners', () => {
  it('returns an empty array for a session with no listeners', async () => {
    const response = await app.request('/api/listeners', {}, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it("returns only the calling session's own listeners, newest first", async () => {
    const first = await app.request('/api/listeners', { method: 'POST' }, env)
    const sessionId = extractSessionId(first)
    const firstBody = (await first.json()) as { id: string }

    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await app.request(
      '/api/listeners',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const secondBody = (await second.json()) as { id: string }

    const otherCreate = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(otherCreate)
    const otherBody = (await otherCreate.json()) as { id: string }

    const response = await app.request('/api/listeners', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { id: string }[]
    expect(body.map((l) => l.id)).toEqual([secondBody.id, firstBody.id])

    const otherResponse = await app.request(
      '/api/listeners',
      { headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    const otherListed = (await otherResponse.json()) as { id: string }[]
    expect(otherListed.map((l) => l.id)).toEqual([otherBody.id])
  })

  it('builds hookUrl from HOOK_BASE_URL, not APP_BASE_URL', async () => {
    const response = await app.request('/api/listeners', { method: 'POST' }, env)
    expect(response.status).toBe(201)
    const body = (await response.json()) as { id: string; hookUrl: string }
    expect(body.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${body.id}`)
  })

  it('includes hookUrl and shareUrl on each item, matching the single-listener shape', async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const sessionId = extractSessionId(created)
    const createdBody = (await created.json()) as { hookUrl: string }

    const response = await app.request('/api/listeners', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    const [listed] = (await response.json()) as { hookUrl: string; shareUrl: string | null }[]
    expect(listed.hookUrl).toBe(createdBody.hookUrl)
    expect(listed.shareUrl).toBeNull()
  })
})
