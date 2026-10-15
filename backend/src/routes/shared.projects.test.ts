import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'
import { createProjectListener } from '../listeners.repo'
import { clearSharedProjectListenersCache } from '../sharedProjectListeners'

describe('shared project view', () => {
  let projectId: string
  let shareToken: string
  let listenerId: string
  const ownerEmail = 'owner@nice.com'
  const viewerEmail = 'viewer@nice.com'

  beforeEach(async () => {
    clearSharedProjectListenersCache()
    const created = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    const createdBody = (await created.json()) as { id: string }
    projectId = createdBody.id

    await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: {
          ...(await authCookieHeader(env, ownerEmail)),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ slug: 'checkout-uat' }),
      },
      env,
    )
    const listResponse = await app.request(
      '/api/listeners',
      { headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    const listeners = (await listResponse.json()) as {
      id: string
      slug: string | null
    }[]
    listenerId = listeners.find((l) => l.slug === 'checkout-uat')!.id

    await app.request(
      `/hook/${projectId}/checkout-uat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      },
      env,
    )

    const shareResponse = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    shareToken = ((await shareResponse.json()) as { shareToken: string })
      .shareToken
  })

  it('includes hasMore=false for a small project', async () => {
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const body = (await response.json()) as { hasMore: boolean }
    expect(body.hasMore).toBe(false)
  })

  it('caps the list at 100 listeners and reports hasMore when more exist', async () => {
    for (let i = 0; i < 100; i++) {
      await createProjectListener(
        env.DB,
        `cap-${projectId}-${i}`,
        `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        null,
        ownerEmail,
        projectId,
        `cap${String(i).padStart(3, '0')}`,
      )
    }
    // 100 seeded + the 1 from beforeEach = 101
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const body = (await response.json()) as {
      listeners: unknown[]
      hasMore: boolean
    }
    expect(body.listeners).toHaveLength(100)
    expect(body.hasMore).toBe(true)
  })

  it('serves the child list from cache for repeat requests, until the cache is cleared', async () => {
    const fetchList = async () =>
      (await (
        await app.request(
          `/api/shared/projects/${shareToken}`,
          { headers: await authCookieHeader(env, viewerEmail) },
          env,
        )
      ).json()) as { listeners: { slug: string | null }[] }

    const first = await fetchList()
    expect(first.listeners).toHaveLength(1)

    await createProjectListener(
      env.DB,
      `late-${projectId}`,
      '2024-02-01T00:00:00.000Z',
      null,
      ownerEmail,
      projectId,
      'late-arrival',
    )

    const second = await fetchList()
    expect(second.listeners).toHaveLength(1) // still cached

    clearSharedProjectListenersCache()
    const third = await fetchList()
    expect(third.listeners).toHaveLength(2)
  })

  it('returns 404 immediately after the share link is revoked, even while the list is cached', async () => {
    const url = `/api/shared/projects/${shareToken}`
    const warm = await app.request(
      url,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(warm.status).toBe(200)

    await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )

    const after = await app.request(
      url,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(after.status).toBe(404)
  })

  it('lists child listeners for a valid share token', async () => {
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      label: string | null
      listeners: {
        id: string
        label: string | null
        slug: string | null
        createdAt: string
      }[]
    }
    expect(body.listeners).toHaveLength(1)
    expect(body.listeners[0].id).toBe(listenerId)
    expect(body.listeners[0].slug).toBe('checkout-uat')
  })

  it('includes the project label set by the owner', async () => {
    await app.request(
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: {
          ...(await authCookieHeader(env, ownerEmail)),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ label: 'Checkout UAT' }),
      },
      env,
    )
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const body = (await response.json()) as { label: string | null }
    expect(body.label).toBe('Checkout UAT')
  })

  it('never includes the project id or hookUrlTemplate anywhere in the response', async () => {
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const text = await response.text()
    expect(text).not.toContain(projectId)
    expect(text).not.toContain('hookUrlTemplate')
  })

  it('a listener entry never includes hookUrl', async () => {
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    const body = (await response.json()) as {
      listeners: Record<string, unknown>[]
    }
    expect(Object.keys(body.listeners[0]).sort()).toEqual(
      ['createdAt', 'id', 'label', 'slug'].sort(),
    )
  })

  it('returns 404 for an unknown token', async () => {
    const response = await app.request(
      '/api/shared/projects/does-not-exist',
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(response.status).toBe(404)
  })

  it('returns captured requests for a child listener', async () => {
    const response = await app.request(
      `/api/shared/projects/${shareToken}/listeners/${listenerId}/requests`,
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

  it('returns 404 for a listener that does not belong to the project resolved by the token', async () => {
    const otherProject = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    const otherProjectId = ((await otherProject.json()) as { id: string }).id
    await app.request(
      `/api/projects/${otherProjectId}/listeners`,
      {
        method: 'POST',
        headers: {
          ...(await authCookieHeader(env, ownerEmail)),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ slug: 'other-case' }),
      },
      env,
    )
    const otherListenersResponse = await app.request(
      '/api/listeners',
      { headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    const otherListeners = (await otherListenersResponse.json()) as {
      id: string
      slug: string | null
    }[]
    const otherListenerId = otherListeners.find(
      (l) => l.slug === 'other-case',
    )!.id

    const response = await app.request(
      `/api/shared/projects/${shareToken}/listeners/${otherListenerId}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for an unknown token on the requests route', async () => {
    const response = await app.request(
      `/api/shared/projects/does-not-exist/listeners/${listenerId}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 after the share token has been revoked', async () => {
    await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env,
    )
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env,
    )
    expect(response.status).toBe(404)
  })

  describe('GET /api/shared/projects/:token/listeners/:listenerId/requests pagination', () => {
    it('paginates and includes truncation fields, no listenerId key', async () => {
      // beforeEach already sent one hook request; send 24 more for 25 total.
      for (let i = 0; i < 24; i++) {
        await app.request(
          `/hook/${projectId}/checkout-uat`,
          { method: 'POST', body: `payload-${i}` },
          env,
        )
      }

      const first = await app.request(
        `/api/shared/projects/${shareToken}/listeners/${listenerId}/requests`,
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
        `/api/shared/projects/${shareToken}/listeners/${listenerId}/requests?before=${firstBody.nextCursor}`,
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

  describe('GET /api/shared/projects/:token/listeners/:listenerId/requests/:requestId/body', () => {
    it('returns the full body for a known request', async () => {
      const list = await app.request(
        `/api/shared/projects/${shareToken}/listeners/${listenerId}/requests`,
        { headers: await authCookieHeader(env, viewerEmail) },
        env,
      )
      const listBody = (await list.json()) as { requests: { id: number }[] }
      const requestId = listBody.requests[0].id

      const detail = await app.request(
        `/api/shared/projects/${shareToken}/listeners/${listenerId}/requests/${requestId}/body`,
        { headers: await authCookieHeader(env, viewerEmail) },
        env,
      )
      expect(detail.status).toBe(200)
      expect(await detail.json()).toEqual({
        body: JSON.stringify({ foo: 'bar' }),
      })
    })

    it('returns 404 for an unknown share token', async () => {
      const response = await app.request(
        `/api/shared/projects/does-not-exist/listeners/${listenerId}/requests/1/body`,
        { headers: await authCookieHeader(env, viewerEmail) },
        env,
      )
      expect(response.status).toBe(404)
    })
  })
})
