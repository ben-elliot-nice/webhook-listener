import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('listener ownership isolation', () => {
  let listenerId: string
  const ownerEmail = 'owner@nice.com'
  const otherEmail = 'other@nice.com'

  beforeEach(async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
  })

  it('is invisible to a different owner on GET /api/listeners/:id', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('is invisible to a different owner on GET /api/listeners/:id/requests', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/requests`,
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('cannot be deleted by a different owner', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { method: 'DELETE', headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)

    const stillThere = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(stillThere.status).toBe(200)
  })

  it('can be deleted by the owning email, and then 404s', async () => {
    const deleteResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(deleteResponse.status).toBe(204)

    const getResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(getResponse.status).toBe(404)
  })

  it('cannot have a share link created by a different owner', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('cannot have its share link revoked by a different owner', async () => {
    await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const response = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'DELETE', headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('is unauthorized for a request with no auth cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}`, {}, env)
    expect(response.status).toBe(401)
  })

  it('cannot be deleted by a request with no auth cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}`, { method: 'DELETE' }, env)
    expect(response.status).toBe(401)
  })

  it('cannot have a share link created by a request with no auth cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}/share`, { method: 'POST' }, env)
    expect(response.status).toBe(401)
  })

  it('cannot have its share link revoked by a request with no auth cookie at all', async () => {
    const response = await app.request(`/api/listeners/${listenerId}/share`, { method: 'DELETE' }, env)
    expect(response.status).toBe(401)
  })

  it('returns the exact same 404 body as a nonexistent listener', async () => {
    const wrongOwnerResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    const nonexistentResponse = await app.request(
      '/api/listeners/does-not-exist',
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(await wrongOwnerResponse.json()).toEqual(await nonexistentResponse.json())
    expect(wrongOwnerResponse.status).toBe(nonexistentResponse.status)
  })

  it('a legacy listener with no owner_email is inaccessible via the route layer', async () => {
    await env.DB.prepare("INSERT INTO listeners (id, created_at) VALUES ('legacy-listener', '2024-01-01T00:00:00.000Z')").run()

    const response = await app.request(
      '/api/listeners/legacy-listener',
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('remains visible to the owning email throughout', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(200)
  })

  it('the hook route remains reachable regardless of auth', async () => {
    const response = await app.request(
      `/hook/${listenerId}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) },
      env
    )
    expect(response.status).toBe(200)
  })
})
