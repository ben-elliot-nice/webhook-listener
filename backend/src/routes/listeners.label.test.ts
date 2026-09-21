import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('listener label management', () => {
  let listenerId: string
  const ownerEmail = 'owner@nice.com'

  beforeEach(async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const createdBody = (await created.json()) as { id: string }
    listenerId = createdBody.id
  })

  it('sets a label', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/label`,
      {
        method: 'PATCH',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ label: '  Stripe prod  ' }),
      },
      env
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as { label: string }).toEqual({ label: 'Stripe prod' })

    const getResponse = await app.request(
      `/api/listeners/${listenerId}`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect((await getResponse.json() as { label: string }).label).toBe('Stripe prod')
  })

  it('clears a label with an empty string', async () => {
    await app.request(
      `/api/listeners/${listenerId}/label`,
      {
        method: 'PATCH',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Something' }),
      },
      env
    )
    const response = await app.request(
      `/api/listeners/${listenerId}/label`,
      {
        method: 'PATCH',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ label: '' }),
      },
      env
    )
    expect((await response.json()) as { label: string | null }).toEqual({ label: null })
  })

  it('returns 400 for a label over 100 characters', async () => {
    const response = await app.request(
      `/api/listeners/${listenerId}/label`,
      {
        method: 'PATCH',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'x'.repeat(101) }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 for a different owner', async () => {
    const otherEmail = 'other@nice.com'
    const response = await app.request(
      `/api/listeners/${listenerId}/label`,
      {
        method: 'PATCH',
        headers: { ...(await authCookieHeader(env, otherEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'nope' }),
      },
      env
    )
    expect(response.status).toBe(404)
  })
})
