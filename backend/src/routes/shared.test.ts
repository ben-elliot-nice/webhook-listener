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
      env,
    )
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id

    const shareResponse = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    shareToken = ((await shareResponse.json()) as { shareToken: string })
      .shareToken

    await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      },
      env,
    )
  })

  it('returns captured requests for a valid share token', async () => {
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(response.status).toBe(200)
    const {
      requests: [captured],
    } = (await response.json()) as {
      requests: { body: string; method: string }[]
    }
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.method).toBe('POST')
  })

  it('never includes the real listener id anywhere in the response', async () => {
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
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
        headers: {
          'content-type': 'application/json',
          cookie: `wl_session_id=${probeSessionId}`,
        },
        body: JSON.stringify({ probe: true }),
      },
      env,
    )
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const text = await response.text()
    expect(text).not.toContain(probeSessionId)
  })

  it('is reachable by an owner that is not the listener owner', async () => {
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(response.status).toBe(200)
  })

  it('returns 404 for an unknown share token', async () => {
    const response = await app.request(
      '/api/shared/does-not-exist/requests',
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 after the share token has been revoked', async () => {
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(response.status).toBe(404)
  })

  it('exposes exactly the expected fields, nothing more', async () => {
    const response = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const {
      requests: [captured],
    } = (await response.json()) as { requests: Record<string, unknown>[] }
    expect(Object.keys(captured).sort()).toEqual(
      [
        'body',
        'bodySize',
        'bodyTruncated',
        'contentType',
        'headers',
        'id',
        'method',
        'queryParams',
        'receivedAt',
        'sourceIp',
      ].sort(),
    )
  })
})

describe('GET /api/shared/:token/requests pagination', () => {
  it('paginates and includes truncation fields, no listenerId key', async () => {
    const ownerEmail = 'owner@nice.com'
    const viewerEmail = 'viewer@nice.com'
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    const listener = (await created.json()) as { id: string }
    for (let i = 0; i < 25; i++) {
      await app.request(
        `/hook/${listener.id}`,
        { method: 'POST', body: `payload-${i}` },
        env,
      )
    }
    const shareResponse = await app.request(
      `/api/listeners/${listener.id}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    const { shareToken } = (await shareResponse.json()) as {
      shareToken: string
    }

    const first = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const firstBody = (await first.json()) as {
      requests: (Record<string, unknown> & { bodyTruncated: boolean })[]
      nextCursor: number | null
    }
    expect(firstBody.requests).toHaveLength(20)
    expect(firstBody.nextCursor).not.toBeNull()
    expect(firstBody.requests[0]).not.toHaveProperty('listenerId')
    expect(firstBody.requests[0].bodyTruncated).toBe(false)

    const second = await app.request(
      `/api/shared/${shareToken}/requests?before=${firstBody.nextCursor}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const secondBody = (await second.json()) as {
      requests: unknown[]
      nextCursor: number | null
    }
    expect(secondBody.requests).toHaveLength(5)
    expect(secondBody.nextCursor).toBeNull()
  })
})

describe('GET /api/shared/:token/requests/:requestId/body', () => {
  it('returns the full body for a known request', async () => {
    const ownerEmail = 'owner@nice.com'
    const viewerEmail = 'viewer@nice.com'
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    const listener = (await created.json()) as { id: string }
    await app.request(
      `/hook/${listener.id}`,
      { method: 'POST', body: 'shared-full-body' },
      env,
    )
    const shareResponse = await app.request(
      `/api/listeners/${listener.id}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    const { shareToken } = (await shareResponse.json()) as {
      shareToken: string
    }

    const list = await app.request(
      `/api/shared/${shareToken}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const listBody = (await list.json()) as { requests: { id: number }[] }
    const requestId = listBody.requests[0].id

    const detail = await app.request(
      `/api/shared/${shareToken}/requests/${requestId}/body`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(detail.status).toBe(200)
    expect(await detail.json()).toEqual({ body: 'shared-full-body' })
  })

  it('returns 404 for an unknown share token', async () => {
    const response = await app.request(
      '/api/shared/does-not-exist/requests/1/body',
      { headers: await authCookieHeader(env, 'viewer@nice.com') },
      env,
    )
    expect(response.status).toBe(404)
  })
})
