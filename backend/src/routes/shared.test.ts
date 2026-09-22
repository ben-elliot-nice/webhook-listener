import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('shared read-only route', () => {
  let listenerId: string
  let shareToken: string
  const ownerEmail = 'owner@nice.com'
  const viewerEmail = 'viewer@nice.com'

  beforeEach(async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id

    const shareResponse = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
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
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(200)
    const [captured] = (await response.json()) as { body: string; method: string }[]
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.method).toBe('POST')
  })

  it('never includes the real listener id anywhere in the response', async () => {
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    const text = await response.text()
    expect(text).not.toContain(listenerId)
  })

  it('never includes the owner session id anywhere in the response', async () => {
    const probeSessionId = 'probe-session-uuid-0000-0000-000000000000'
    await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `wl_session_id=${probeSessionId}` },
        body: JSON.stringify({ probe: true }),
      },
      env
    )
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    const text = await response.text()
    expect(text).not.toContain(probeSessionId)
  })

  it('is reachable by an owner that is not the listener owner', async () => {
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(200)
  })

  it('returns 404 for an unknown share token', async () => {
    const response = await app.request(
      '/api/shared/does-not-exist/requests',
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 after the share token has been revoked', async () => {
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('exposes exactly the expected fields, nothing more', async () => {
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    const [captured] = (await response.json()) as Record<string, unknown>[]
    expect(Object.keys(captured).sort()).toEqual(
      ['body', 'contentType', 'headers', 'id', 'method', 'queryParams', 'receivedAt', 'sourceIp'].sort()
    )
  })
})
