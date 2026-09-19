import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('listener slug management', () => {
  let listenerId: string
  let sessionId: string

  beforeEach(async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
    sessionId = extractSessionId(created)
  })

  it('sets a slug and returns the normalized value with a token', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
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
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'my-slug' }),
      },
      env
    )
    const response = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const body = (await response.json()) as Record<string, unknown>
    expect(body.slug).toBe('my-slug')
    expect(body.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/my-slug`)
    expect(body.webhookToken).toBeUndefined()
  })

  it('returns 409 when the slug is already taken', async () => {
    const other = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(other)
    await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'taken' }),
      },
      env
    )
    const otherBody = (await other.json()) as { id: string }
    const response = await app.request(
      `/api/listeners/${otherBody.id}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: otherSessionId }), 'content-type': 'application/json' },
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
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'ab' }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 for a different session', async () => {
    const other = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherSessionId = extractSessionId(other)
    const response = await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: otherSessionId }), 'content-type': 'application/json' },
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
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'rotate-target' }),
      },
      env
    )
    const { webhookToken: originalToken } = (await setResponse.json()) as { webhookToken: string }

    const rotateResponse = await app.request(
      `/api/listeners/${listenerId}/slug/rotate-token`,
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
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
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(response.status).toBe(400)
  })

  it('removes the slug, reactivating the UUID hook URL', async () => {
    await app.request(
      `/api/listeners/${listenerId}/slug`,
      {
        method: 'PUT',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'remove-target' }),
      },
      env
    )
    const removeResponse = await app.request(
      `/api/listeners/${listenerId}/slug`,
      { method: 'DELETE', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    expect(removeResponse.status).toBe(204)

    const uuidHookResponse = await app.request(`/hook/${listenerId}`, { method: 'POST' }, env)
    expect(uuidHookResponse.status).toBe(200)
  })
})
