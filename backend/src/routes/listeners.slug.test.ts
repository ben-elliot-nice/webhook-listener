import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('listener slug management', () => {
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

  it('sets a slug and returns the normalized value with a token', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'Stripe_Prod' }),
      },
      env
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { slug: string; webhookToken: string; hookUrl: string }
    expect(body.slug).toBe('stripe-prod')
    expect(body.webhookToken).toBeTypeOf('string')
    expect(body.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/stripe-prod`)
  })

  it('the listener GET response reflects the slug and the slug-based hookUrl, with no webhookToken field', async () => {
    await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'my-slug' }),
      },
      env
    )
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const body = (await response.json()) as Record<string, unknown>
    expect(body.slug).toBe('my-slug')
    expect(body.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/my-slug`)
    expect(body.webhookToken).toBeUndefined()
  })

  it('returns 409 when the slug is already taken', async () => {
    const other = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, otherEmail) },
      env
    )
    await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'taken' }),
      },
      env
    )
    const otherBody = (await other.json()) as { id: string }
    const response = await app.request(
      `/api/listeners/${otherBody.id}/slug`,
      {
        method: 'PUT',
        headers: { ...(await authCookieHeader(env, otherEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'taken' }),
      },
      env
    )
    expect(response.status).toBe(409)
  })

  it('returns 400 for a slug that normalizes too short', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'ab' }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 for a different owner', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...(await authCookieHeader(env, otherEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'stolen' }),
      },
      env
    )
    expect(response.status).toBe(404)
  })

  it('rotates the token, invalidating the old one', async () => {
    const setResponse = await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'rotate-target' }),
      },
      env
    )
    const { webhookToken: originalToken } = (await setResponse.json()) as { webhookToken: string }

    const rotateResponse = await app.request(
      `/api/listeners/${listenerId}/slug/rotate-token`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(rotateResponse.status).toBe(200)
    const { webhookToken: newToken } = (await rotateResponse.json()) as { webhookToken: string }
    expect(newToken).not.toBe(originalToken)

    const oldTokenRequest = await app.request(
      '/hook/rotate-target',
      { method: 'POST', headers: { 'x-webhook-token': originalToken } },
      env
    )
    expect(oldTokenRequest.status).toBe(404)
  })

  it('returns 400 rotating a token on a listener with no slug', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/slug/rotate-token`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(400)
  })

  it('removes the slug, reactivating the UUID hook URL', async () => {
    await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'remove-target' }),
      },
      env
    )
    const removeResponse = await app.request(
      `/api/listeners/${listenerId}/slug`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(removeResponse.status).toBe(204)

    const uuidHookResponse = await app.request(`/hook/${listenerId}`, { method: 'POST' }, env)
    expect(uuidHookResponse.status).toBe(200)
  })

  it('rejects setting a slug to another listener\'s UUID, and leaves that listener\'s hook URL working', async () => {
    // listenerId/ownerEmail is listener A, with no slug set (so its hook URL is its bare UUID).
    const listenerA = listenerId

    const other = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, otherEmail) },
      env
    )
    const listenerB = ((await other.json()) as { id: string }).id

    // Listener B's owner attempts to set B's slug to A's raw UUID.
    const response = await app.request(
      `/api/listeners/${listenerB}/slug`,
      {
        method: 'PUT',
        headers: { ...(await authCookieHeader(env, otherEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: listenerA }),
      },
      env
    )
    expect(response.status).toBe(409)

    // Listener A's UUID hook URL must still resolve to listener A (no token needed).
    const hookResponse = await app.request(`/hook/${listenerA}`, { method: 'POST' }, env)
    expect(hookResponse.status).toBe(200)
  })
})
