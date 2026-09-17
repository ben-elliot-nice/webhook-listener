import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('listener share management', () => {
  let listenerId: string
  let sessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
    sessionId = extractSessionId(created)
  })

  it('has no share link by default', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await response.json() as { shareUrl: string | null }).shareUrl).toBeNull()
  })

  it('creates a share link', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { shareToken: string; shareUrl: string }
    expect(body.shareToken).toBeTypeOf('string')
    // NOTE: deviates from the task-6 brief, which hardcoded
    // `https://webhook.fde.nice-agentic.com/shared/...` here. That literal cannot pass in
    // this (or any correctly configured) local/test environment: backend/.dev.vars sets
    // APP_BASE_URL="http://localhost:5173" for local dev/test per Task 1, and
    // @cloudflare/vitest-pool-workers loads .dev.vars automatically. Asserting against the
    // actual configured env.APP_BASE_URL keeps the test's intent (verify shareUrl shape)
    // without hardcoding a production domain that contradicts the established local config.
    expect(body.shareUrl).toBe(`${env.APP_BASE_URL}/shared/${body.shareToken}`)
  })

  it('is idempotent — repeat calls return the same token', async () => {
    const first = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const second = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await second.json() as { shareToken: string }).shareToken).toBe(
      (await first.json() as { shareToken: string }).shareToken
    )
  })

  it('reflects the created share link on the listener', async () => {
    const shareResponse = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const listenerResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await listenerResponse.json() as { shareUrl: string }).shareUrl).toBe(
      (await shareResponse.json() as { shareUrl: string }).shareUrl
    )
  })

  it('revokes a share link', async () => {
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const revokeResponse = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(revokeResponse.status).toBe(204)

    const listenerResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await listenerResponse.json() as { shareUrl: string | null }).shareUrl).toBeNull()
  })

  it('generates a new token after revoke then re-share', async () => {
    const first = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const second = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect((await second.json() as { shareToken: string }).shareToken).not.toBe(
      (await first.json() as { shareToken: string }).shareToken
    )
  })

  it('returns 404 for an unknown listener on both endpoints', async () => {
    const shareResponse = await app.request(
      '/api/listeners/does-not-exist/share',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(shareResponse.status).toBe(404)

    const revokeResponse = await app.request(
      '/api/listeners/does-not-exist/share',
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(revokeResponse.status).toBe(404)
  })
})
