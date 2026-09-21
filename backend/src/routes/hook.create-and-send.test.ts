import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'

async function createProjectId(): Promise<string> {
  const response = await app.request('/api/projects', { method: 'POST' }, env)
  const body = (await response.json()) as { id: string }
  return body.id
}

async function createProjectWithSession(): Promise<{ projectId: string; sessionCookie: string }> {
  const response = await app.request('/api/projects', { method: 'POST' }, env)
  const sessionId = response.headers.get('set-cookie')?.match(/wl_session_id=([^;]+)/)?.[1]
  const projectId = ((await response.json()) as { id: string }).id
  return { projectId, sessionCookie: `wl_session_id=${sessionId}` }
}

describe('create-and-send hook route', () => {
  it('first call to an unseen (projectId, identifier) pair creates a listener and returns 201', async () => {
    const projectId = await createProjectId()
    const response = await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) },
      env
    )
    expect(response.status).toBe(201)
  })

  it('second call to the same pair reuses the listener and returns 200, with both requests recorded', async () => {
    const { projectId, sessionCookie } = await createProjectWithSession()
    const first = await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { cookie: sessionCookie }, body: 'first' },
      env
    )
    expect(first.status).toBe(201)

    const second = await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { cookie: sessionCookie }, body: 'second' },
      env
    )
    expect(second.status).toBe(200)

    const third = await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { cookie: sessionCookie }, body: 'third' },
      env
    )
    expect(third.status).toBe(200)

    const list = await app.request('/api/listeners', { headers: { cookie: sessionCookie } }, env)
    const listBody = (await list.json()) as { id: string; slug: string }[]
    const listenerId = listBody.find((l) => l.slug === 'checkout-uat')?.id
    expect(listenerId).toBeDefined()

    const requestsResponse = await app.request(
      `/api/listeners/${listenerId}/requests`,
      { headers: { cookie: sessionCookie } },
      env
    )
    const requests = (await requestsResponse.json()) as unknown[]
    expect(requests).toHaveLength(3)
  })

  it('rejects a payload over the 10MB cap with 413', async () => {
    const projectId = await createProjectId()
    const response = await app.request(
      `/hook/${projectId}/checkout-uat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(11 * 1024 * 1024) },
      },
      env
    )
    expect(response.status).toBe(413)
  })

  it('returns 404 for an unknown projectId', async () => {
    const response = await app.request(`/hook/${crypto.randomUUID()}/checkout-uat`, { method: 'POST' }, env)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'project not found' })
  })

  it('returns 400 for an identifier that normalizes too short', async () => {
    const projectId = await createProjectId()
    const response = await app.request(`/hook/${projectId}/a`, { method: 'POST' }, env)
    expect(response.status).toBe(400)
  })

  it('the same identifier string under two different projects creates two distinct listeners', async () => {
    const projectA = await createProjectId()
    const projectB = await createProjectId()
    const responseA = await app.request(`/hook/${projectA}/checkout-uat`, { method: 'POST' }, env)
    const responseB = await app.request(`/hook/${projectB}/checkout-uat`, { method: 'POST' }, env)
    expect(responseA.status).toBe(201)
    expect(responseB.status).toBe(201)
  })

  it('GET /api/listeners includes a project-scoped listener with a /hook/:projectId/:slug hookUrl', async () => {
    const created = await app.request('/api/projects', { method: 'POST' }, env)
    const sessionId = created.headers.get('set-cookie')?.match(/wl_session_id=([^;]+)/)?.[1]
    const projectId = ((await created.json()) as { id: string }).id

    await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { cookie: `wl_session_id=${sessionId}` } },
      env
    )

    const list = await app.request('/api/listeners', { headers: { cookie: `wl_session_id=${sessionId}` } }, env)
    const listBody = (await list.json()) as { hookUrl: string; slug: string }[]
    const match = listBody.find((l) => l.slug === 'checkout-uat')
    expect(match?.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${projectId}/checkout-uat`)
  })
})
