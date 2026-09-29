import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('GET /api/listeners/:id/requests pagination', () => {
  const ownerEmail = 'owner@nice.com'

  async function createListenerWithRequests(count: number) {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listener = (await created.json()) as { id: string }

    for (let i = 0; i < count; i++) {
      await app.request(
        `/hook/${listener.id}`,
        { method: 'POST', body: `payload-${i}`, headers: { 'content-type': 'text/plain' } },
        env
      )
    }
    return listener.id
  }

  it('defaults to the 20 most recent requests with a nextCursor when more exist', async () => {
    const listenerId = await createListenerWithRequests(25)
    const response = await app.request(
      `/api/listeners/${listenerId}/requests`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { requests: { id: number }[]; nextCursor: number | null }
    expect(body.requests).toHaveLength(20)
    expect(body.nextCursor).not.toBeNull()
  })

  it('pages through with `before` and reaches nextCursor null', async () => {
    const listenerId = await createListenerWithRequests(25)
    const headers = await authCookieHeader(env, ownerEmail)
    const first = await app.request(`/api/listeners/${listenerId}/requests?limit=20`, { headers }, env)
    const firstBody = (await first.json()) as { requests: { id: number }[]; nextCursor: number | null }

    const second = await app.request(
      `/api/listeners/${listenerId}/requests?limit=20&before=${firstBody.nextCursor}`,
      { headers },
      env
    )
    const secondBody = (await second.json()) as { requests: { id: number }[]; nextCursor: number | null }
    expect(secondBody.requests).toHaveLength(5)
    expect(secondBody.nextCursor).toBeNull()
  })

  it('each item includes listenerId and truncation fields', async () => {
    const listenerId = await createListenerWithRequests(1)
    const response = await app.request(
      `/api/listeners/${listenerId}/requests`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const body = (await response.json()) as {
      requests: { listenerId: string; bodyTruncated: boolean; bodySize: number }[]
    }
    expect(body.requests[0].listenerId).toBe(listenerId)
    expect(body.requests[0].bodyTruncated).toBe(false)
    expect(body.requests[0].bodySize).toBeGreaterThan(0)
  })
})

describe('GET /api/listeners/:id/requests/:requestId/body', () => {
  const ownerEmail = 'owner@nice.com'
  const otherEmail = 'other@nice.com'

  it('returns the full body for a known request', async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listener = (await created.json()) as { id: string }
    await app.request(`/hook/${listener.id}`, { method: 'POST', body: 'the-full-body' }, env)

    const headers = await authCookieHeader(env, ownerEmail)
    const list = await app.request(`/api/listeners/${listener.id}/requests`, { headers }, env)
    const listBody = (await list.json()) as { requests: { id: number }[] }
    const requestId = listBody.requests[0].id

    const detail = await app.request(
      `/api/listeners/${listener.id}/requests/${requestId}/body`,
      { headers },
      env
    )
    expect(detail.status).toBe(200)
    expect(await detail.json()).toEqual({ body: 'the-full-body' })
  })

  it('returns 404 for an unknown listener', async () => {
    const response = await app.request(
      `/api/listeners/${crypto.randomUUID()}/requests/1/body`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for a requestId that does not belong to the listener', async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listener = (await created.json()) as { id: string }
    const response = await app.request(
      `/api/listeners/${listener.id}/requests/999999/body`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for a different owner (ownership isolation, matching the list endpoint)', async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listener = (await created.json()) as { id: string }
    await app.request(`/hook/${listener.id}`, { method: 'POST', body: 'secret' }, env)
    const list = await app.request(
      `/api/listeners/${listener.id}/requests`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const requestId = ((await list.json()) as { requests: { id: number }[] }).requests[0].id

    const response = await app.request(
      `/api/listeners/${listener.id}/requests/${requestId}/body`,
      { headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)
  })
})
