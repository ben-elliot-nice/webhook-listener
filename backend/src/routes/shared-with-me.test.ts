import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('shared-with-me visit recording', () => {
  let listenerId: string
  let listenerShareToken: string
  let projectId: string
  let projectShareToken: string
  const ownerEmail = 'visit-owner@nice.com'
  const viewerEmail = 'visit-viewer@nice.com'

  beforeEach(async () => {
    const listenerResponse = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    listenerId = ((await listenerResponse.json()) as { id: string }).id
    const listenerShareResponse = await app.request(
      `/api/listeners/${listenerId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    listenerShareToken = ((await listenerShareResponse.json()) as { shareToken: string }).shareToken

    const projectResponse = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    projectId = ((await projectResponse.json()) as { id: string }).id
    const projectShareResponse = await app.request(
      `/api/projects/${projectId}/share`,
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    projectShareToken = ((await projectShareResponse.json()) as { shareToken: string }).shareToken
  })

  it('POST /api/shared/:token/visit returns 204 for a valid listener share token', async () => {
    const response = await app.request(
      `/api/shared/${listenerShareToken}/visit`,
      { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(204)
  })

  it('POST /api/shared/:token/visit returns 404 for an unknown token and writes nothing', async () => {
    const response = await app.request(
      '/api/shared/does-not-exist/visit',
      { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(404)
    const { results } = await env.DB
      .prepare('SELECT COUNT(*) AS count FROM shared_with_me WHERE token = ?')
      .bind('does-not-exist')
      .all<{ count: number }>()
    expect(results[0].count).toBe(0)
  })

  it('POST /api/shared/projects/:token/visit returns 204 for a valid project share token', async () => {
    const response = await app.request(
      `/api/shared/projects/${projectShareToken}/visit`,
      { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(204)
  })

  it('POST /api/shared/projects/:token/visit returns 404 for an unknown token', async () => {
    const response = await app.request(
      '/api/shared/projects/does-not-exist/visit',
      { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('recording a visit requires a valid session (401 with no cookie)', async () => {
    const response = await app.request(`/api/shared/${listenerShareToken}/visit`, { method: 'POST' }, env)
    expect(response.status).toBe(401)
  })
})
