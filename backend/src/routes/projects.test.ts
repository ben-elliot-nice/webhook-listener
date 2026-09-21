import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('projects routes', () => {
  it('POST /api/projects creates a project owned by the caller session', async () => {
    const response = await app.request('/api/projects', { method: 'POST' }, env)
    expect(response.status).toBe(201)
    const body = (await response.json()) as { id: string; createdAt: string }
    expect(body.id).toBeTypeOf('string')
    expect(body.createdAt).toBeTypeOf('string')
  })

  it('GET /api/projects lists only the caller session projects, newest first', async () => {
    const first = await app.request('/api/projects', { method: 'POST' }, env)
    const sessionId = extractSessionId(first)
    const firstBody = (await first.json()) as { id: string }

    const second = await app.request(
      '/api/projects',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const secondBody = (await second.json()) as { id: string }

    // A different session's project must not appear in the list above.
    await app.request('/api/projects', { method: 'POST' }, env)

    const list = await app.request('/api/projects', { headers: cookieHeader({ wl_session_id: sessionId }) }, env)
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { id: string }[]
    expect(listBody.map((p) => p.id)).toEqual([secondBody.id, firstBody.id])
  })

  it('GET /api/projects returns an empty list for a session with no projects', async () => {
    const response = await app.request('/api/projects', {}, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })
})
