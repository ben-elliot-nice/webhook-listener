import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('shared read-only route', () => {
  let listenerId: string
  let sessionId: string
  let shareToken: string

  beforeEach(async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
    sessionId = extractSessionId(created)

    const shareResponse = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    shareToken = (await shareResponse.json() as { shareToken: string }).shareToken

    await app.request(
      `/hook/${listenerId}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ foo: 'bar' }) },
      env
    )
  })

  it('returns captured requests for a valid share token', async () => {
    const response = await app.request(`/api/shared/${shareToken}/requests`, {}, env)
    expect(response.status).toBe(200)
    const [captured] = (await response.json()) as { body: string; method: string }[]
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.method).toBe('POST')
  })

  it('never includes the real listener id anywhere in the response', async () => {
    const response = await app.request(`/api/shared/${shareToken}/requests`, {}, env)
    const text = await response.text()
    expect(text).not.toContain(listenerId)
  })

  it('never includes the owner session id anywhere in the response', async () => {
    await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `wl_session_id=${sessionId}` },
        body: JSON.stringify({ probe: true }),
      },
      env
    )
    const response = await app.request(`/api/shared/${shareToken}/requests`, {}, env)
    const text = await response.text()
    expect(text).not.toContain(sessionId)
  })

  it('is reachable by a session that is not the owner', async () => {
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: cookieHeader({ wl_session_id: 'some-other-session-uuid-0000-0000-000000000000' }) },
      env
    )
    expect(response.status).toBe(200)
  })

  it('returns 404 for an unknown share token', async () => {
    const response = await app.request('/api/shared/does-not-exist/requests', {}, env)
    expect(response.status).toBe(404)
  })

  it('returns 404 after the share token has been revoked', async () => {
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const response = await app.request(`/api/shared/${shareToken}/requests`, {}, env)
    expect(response.status).toBe(404)
  })

  it('exposes exactly the expected fields, nothing more', async () => {
    const response = await app.request(`/api/shared/${shareToken}/requests`, {}, env)
    const [captured] = (await response.json()) as Record<string, unknown>[]
    expect(Object.keys(captured).sort()).toEqual(
      ['body', 'contentType', 'headers', 'id', 'method', 'queryParams', 'receivedAt', 'sourceIp'].sort()
    )
  })
})
