import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('listener ownership isolation', () => {
  let listenerId: string
  let ownerSessionId: string
  let otherSessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
    ownerSessionId = extractSessionId(created)

    const otherVisit = await app.request('/api/listeners/does-not-exist', {}, env)
    otherSessionId = extractSessionId(otherVisit)
  })

  it('is invisible to a different session on GET /api/listeners/:id', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('is invisible to a different session on GET /api/listeners/:id/requests', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/requests`,
      { headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('cannot be deleted by a different session', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)

    const stillThere = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: ownerSessionId }) },
      env
    )
    expect(stillThere.status).toBe(200)
  })

  it('cannot have a share link created by a different session', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('cannot have its share link revoked by a different session', async () => {
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: ownerSessionId }) },
      env
    )
    const response = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('is invisible to a request with no session cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}`, {}, env)
    expect(response.status).toBe(404)
  })

  it('cannot be deleted by a request with no session cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}`, { method: 'DELETE' }, env)
    expect(response.status).toBe(404)
  })

  it('cannot have a share link created by a request with no session cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}/share`, { method: 'POST' }, env)
    expect(response.status).toBe(404)
  })

  it('cannot have its share link revoked by a request with no session cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}/share`, { method: 'DELETE' }, env)
    expect(response.status).toBe(404)
  })

  it('returns the exact same 404 body as a nonexistent listener', async () => {
    const wrongSessionResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    const nonexistentResponse = await app.request(
      '/api/listeners/does-not-exist',
      { headers: cookieHeader({ wl_session_id: otherSessionId }) },
      env
    )
    expect(await wrongSessionResponse.json()).toEqual(await nonexistentResponse.json())
    expect(wrongSessionResponse.status).toBe(nonexistentResponse.status)
  })

  it('a legacy listener with no owner_session is inaccessible via the route layer', async () => {
    await env.DB.prepare("INSERT INTO listeners (id, created_at) VALUES ('legacy-listener', '2024-01-01T00:00:00.000Z')").run()

    const response = await app.request(
      '/api/listeners/legacy-listener',
      { headers: cookieHeader({ wl_session_id: ownerSessionId }) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('remains visible to the owning session throughout', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: ownerSessionId }) },
      env
    )
    expect(response.status).toBe(200)
  })

  it('the hook route remains reachable regardless of session', async () => {
    const response = await app.request(
      `/hook/${listenerId}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) },
      env
    )
    expect(response.status).toBe(200)
  })
})
