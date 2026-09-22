import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('shared project view', () => {
  let projectId: string
  let shareToken: string
  let listenerId: string
  const ownerEmail = 'owner@nice.com'
  const viewerEmail = 'viewer@nice.com'

  beforeEach(async () => {
    const created = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const createdBody = (await created.json()) as { id: string }
    projectId = createdBody.id

    await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'checkout-uat' }),
      },
      env
    )
    const listResponse = await app.request(
      '/api/listeners',
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listeners = (await listResponse.json()) as { id: string; slug: string | null }[]
    listenerId = listeners.find((l) => l.slug === 'checkout-uat')!.id

    await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ foo: 'bar' }) },
      env
    )

    const shareResponse = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    shareToken = (await shareResponse.json() as { shareToken: string }).shareToken
  })

  it('lists child listeners for a valid share token', async () => {
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      label: string | null
      listeners: { id: string; label: string | null; slug: string | null; createdAt: string }[]
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
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Checkout UAT' }),
      },
      env
    )
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    const body = (await response.json()) as { label: string | null }
    expect(body.label).toBe('Checkout UAT')
  })

  it('never includes the project id or hookUrlTemplate anywhere in the response', async () => {
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    const text = await response.text()
    expect(text).not.toContain(projectId)
    expect(text).not.toContain('hookUrlTemplate')
  })

  it('a listener entry never includes hookUrl', async () => {
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    const body = (await response.json()) as { listeners: Record<string, unknown>[] }
    expect(Object.keys(body.listeners[0]).sort()).toEqual(['createdAt', 'id', 'label', 'slug'].sort())
  })

  it('returns 404 for an unknown token', async () => {
    const response = await app.request(
      '/api/shared/projects/does-not-exist',
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns captured requests for a child listener', async () => {
    const response = await app.request(
      `/api/shared/projects/${shareToken}/listeners/${listenerId}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(200)
    const [captured] = (await response.json()) as { body: string; method: string }[]
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.method).toBe('POST')
  })

  it('returns 404 for a listener that does not belong to the project resolved by the token', async () => {
    const otherProject = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const otherProjectId = ((await otherProject.json()) as { id: string }).id
    await app.request(
      `/api/projects/${otherProjectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'other-case' }),
      },
      env
    )
    const otherListenersResponse = await app.request(
      '/api/listeners',
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const otherListeners = (await otherListenersResponse.json()) as { id: string; slug: string | null }[]
    const otherListenerId = otherListeners.find((l) => l.slug === 'other-case')!.id

    const response = await app.request(
      `/api/shared/projects/${shareToken}/listeners/${otherListenerId}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for an unknown token on the requests route', async () => {
    const response = await app.request(
      `/api/shared/projects/does-not-exist/listeners/${listenerId}/requests`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 after the share token has been revoked', async () => {
    await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const response = await app.request(
      `/api/shared/projects/${shareToken}`,
      { headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })
})
