import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('projects routes', () => {
  it('POST /api/projects creates a project owned by the caller', async () => {
    const response = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, 'owner@nice.com') },
      env
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as { id: string; createdAt: string }
    expect(body.id).toBeTypeOf('string')
    expect(body.createdAt).toBeTypeOf('string')
  })

  it('GET /api/projects lists only the caller owner projects, newest first', async () => {
    const ownerEmail = 'owner@nice.com'
    const otherEmail = 'other@nice.com'

    const first = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const firstBody = (await first.json()) as { id: string }

    const second = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const secondBody = (await second.json()) as { id: string }

    // A different owner's project must not appear in the list above.
    await app.request('/api/projects', { method: 'POST', headers: await authCookieHeader(env, otherEmail) }, env)

    const list = await app.request('/api/projects', { headers: await authCookieHeader(env, ownerEmail) }, env)
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { id: string }[]
    expect(listBody.map((p) => p.id)).toEqual([secondBody.id, firstBody.id])
  })

  it('GET /api/projects returns an empty list for an owner with no projects', async () => {
    const response = await app.request('/api/projects', { headers: await authCookieHeader(env, 'nobody@nice.com') }, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it('serialized project includes hookUrlTemplate and sortPosition', async () => {
    const ownerEmail = 'owner@nice.com'
    const response = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const body = (await response.json()) as { id: string; hookUrlTemplate: string; sortPosition: number | null }
    expect(body.hookUrlTemplate).toBe(`${env.HOOK_BASE_URL}/hook/${body.id}/<identifier>`)
    expect(body.sortPosition).toBeNull()

    const list = await app.request('/api/projects', { headers: await authCookieHeader(env, ownerEmail) }, env)
    const listBody = (await list.json()) as { id: string; hookUrlTemplate: string }[]
    expect(listBody[0].hookUrlTemplate).toBe(`${env.HOOK_BASE_URL}/hook/${listBody[0].id}/<identifier>`)
  })
})
