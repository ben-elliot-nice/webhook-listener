import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('project share management', () => {
  let projectId: string
  let sessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/projects', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    projectId = createdBody.id
    sessionId = extractSessionId(created)
  })

  it('has no share link by default', async () => {
    const response = await app.request(
      '/api/projects',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const body = (await response.json()) as { id: string; shareUrl: string | null }[]
    expect(body.find((p) => p.id === projectId)?.shareUrl).toBeNull()
  })

  it('creates a share link at /shared/projects/:token', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { shareToken: string; shareUrl: string }
    expect(body.shareToken).toBeTypeOf('string')
    expect(body.shareUrl).toBe(`${env.APP_BASE_URL}/shared/projects/${body.shareToken}`)
  })

  it('is idempotent — repeat calls return the same token', async () => {
    const first = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const second = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await second.json() as { shareToken: string }).shareToken).toBe(
      (await first.json() as { shareToken: string }).shareToken
    )
  })

  it('revokes a share link', async () => {
    await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const revokeResponse = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(revokeResponse.status).toBe(204)

    const list = await app.request(
      '/api/projects',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const body = (await list.json()) as { id: string; shareUrl: string | null }[]
    expect(body.find((p) => p.id === projectId)?.shareUrl).toBeNull()
  })

  it('returns 404 for an unknown project on both endpoints', async () => {
    const shareResponse = await app.request(
      '/api/projects/does-not-exist/share',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(shareResponse.status).toBe(404)

    const revokeResponse = await app.request(
      '/api/projects/does-not-exist/share',
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(revokeResponse.status).toBe(404)
  })

  it('returns 404 for a different session', async () => {
    const other = await app.request('/api/projects', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(other)
    const response = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })
})
