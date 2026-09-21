import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { createListener, setListenerSlug } from '../listeners.repo'
import { getRequests } from '../requests.repo'
import { authCookieHeader } from '../test-helpers/auth'

describe('hook capture route', () => {
  const listenerId = 'hook-test-listener'

  beforeEach(async () => {
    await createListener(env.DB, listenerId, '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
  })

  it('captures a POST payload and returns 200', async () => {
    const response = await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      },
      env
    )
    expect(response.status).toBe(200)

    const [captured] = await getRequests(env.DB, listenerId)
    expect(captured.method).toBe('POST')
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.contentType).toBe('application/json')
  })

  it('captures query params and headers', async () => {
    await app.request(
      `/hook/${listenerId}?foo=bar`,
      { method: 'GET', headers: { 'x-custom-header': 'value' } },
      env
    )

    const [captured] = await getRequests(env.DB, listenerId)
    expect(JSON.parse(captured.queryParams)).toEqual({ foo: 'bar' })
    expect(JSON.parse(captured.headers)['x-custom-header']).toBe('value')
  })

  it('returns 404 for an unknown listener', async () => {
    const response = await app.request('/hook/does-not-exist', { method: 'POST' }, env)
    expect(response.status).toBe(404)
  })

  it('redacts the cookie header from captured requests', async () => {
    await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'session_id=some-secret-value' },
        body: JSON.stringify({ foo: 'bar' }),
      },
      env
    )

    const [captured] = await getRequests(env.DB, listenerId)
    const headers = JSON.parse(captured.headers)
    expect(headers.cookie).toBeUndefined()
    expect(captured.headers).not.toContain('some-secret-value')
  })

  it('rejects a payload over the 10MB cap with 413', async () => {
    const response = await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(11 * 1024 * 1024) },
      },
      env
    )
    expect(response.status).toBe(413)
  })

  it('a project-scoped listener whose slug collides with another listener\'s UUID does not shadow that listener\'s /hook/:id capture', async () => {
    const victimId = crypto.randomUUID()
    await createListener(env.DB, victimId, '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')

    const projectResponse = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, 'owner-a@nice.com') },
      env
    )
    const projectId = ((await projectResponse.json()) as { id: string }).id

    // Attacker creates a project-scoped listener whose identifier equals the victim's UUID.
    await app.request(`/hook/${projectId}/${victimId}`, { method: 'POST' }, env)

    // The victim's bare-id hook URL must still resolve and capture — not 404.
    const response = await app.request(`/hook/${victimId}`, { method: 'POST', body: 'still-alive' }, env)
    expect(response.status).toBe(200)

    const [captured] = await getRequests(env.DB, victimId)
    expect(captured.body).toBe('still-alive')
  })
})

describe('hook capture route — slug + token', () => {
  it('captures via the slug URL when the correct token is provided', async () => {
    await createListener(env.DB, 'hook-slug-listener-1', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const { slug, webhookToken } = await setListenerSlug(env.DB, 'hook-slug-listener-1', 'slug-hook-1')

    const response = await app.request(
      `/hook/${slug}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-token': webhookToken },
        body: JSON.stringify({ ok: true }),
      },
      env
    )
    expect(response.status).toBe(200)

    const [captured] = await getRequests(env.DB, 'hook-slug-listener-1')
    expect(captured.body).toBe(JSON.stringify({ ok: true }))
  })

  it('returns 404 for the slug URL with a missing token', async () => {
    await createListener(env.DB, 'hook-slug-listener-2', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const { slug } = await setListenerSlug(env.DB, 'hook-slug-listener-2', 'slug-hook-2')

    const response = await app.request(`/hook/${slug}`, { method: 'POST' }, env)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'listener not found' })
  })

  it('returns 404 for the slug URL with a wrong token', async () => {
    await createListener(env.DB, 'hook-slug-listener-3', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const { slug } = await setListenerSlug(env.DB, 'hook-slug-listener-3', 'slug-hook-3')

    const response = await app.request(
      `/hook/${slug}`,
      { method: 'POST', headers: { 'x-webhook-token': 'wrong-token' } },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for the UUID hook URL once a slug has been set', async () => {
    await createListener(env.DB, 'hook-slug-listener-4', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    await setListenerSlug(env.DB, 'hook-slug-listener-4', 'slug-hook-4')

    const response = await app.request(`/hook/hook-slug-listener-4`, { method: 'POST' }, env)
    expect(response.status).toBe(404)
  })
})
