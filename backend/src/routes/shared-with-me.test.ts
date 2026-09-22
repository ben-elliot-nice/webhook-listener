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

  describe('GET /api/shared-with-me and DELETE /api/shared-with-me/:kind/:token', () => {
    it('lists a recorded listener visit with its live label', async () => {
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, viewerEmail) }, env)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { kind: string; token: string; url: string }[]
      expect(body).toEqual([
        expect.objectContaining({ kind: 'listener', token: listenerShareToken, url: `/shared/${listenerShareToken}` }),
      ])
    })

    it('lists a recorded project visit with its live label', async () => {
      await app.request(
        `/api/shared/projects/${projectShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, viewerEmail) }, env)
      const body = (await response.json()) as { kind: string; token: string; url: string }[]
      expect(body).toEqual([
        expect.objectContaining({
          kind: 'project',
          token: projectShareToken,
          url: `/shared/projects/${projectShareToken}`,
        }),
      ])
    })

    it('excludes an entry once its token is revoked', async () => {
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      await app.request(
        `/api/listeners/${listenerId}/share`,
        { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
        env
      )

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, viewerEmail) }, env)
      expect(await response.json()).toEqual([])
    })

    it('excludes an entry whose resolved owner is the viewer themselves', async () => {
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
        env
      )

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, ownerEmail) }, env)
      expect(await response.json()).toEqual([])
    })

    it('DELETE removes an entry, and it drops out of the next GET', async () => {
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )

      const deleteResponse = await app.request(
        `/api/shared-with-me/listener/${listenerShareToken}`,
        { method: 'DELETE', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      expect(deleteResponse.status).toBe(204)

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, viewerEmail) }, env)
      expect(await response.json()).toEqual([])
    })

    it('DELETE returns 204 even for a token the viewer never visited', async () => {
      const response = await app.request(
        '/api/shared-with-me/listener/never-visited-token',
        { method: 'DELETE', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      expect(response.status).toBe(204)
    })

    it('revisiting after removal clears removed_at and it reappears in GET', async () => {
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      await app.request(
        `/api/shared-with-me/listener/${listenerShareToken}`,
        { method: 'DELETE', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )

      const response = await app.request('/api/shared-with-me', { headers: await authCookieHeader(env, viewerEmail) }, env)
      const body = (await response.json()) as { token: string }[]
      expect(body.map((r) => r.token)).toContain(listenerShareToken)
    })

    it('one viewer removing an entry does not affect another viewer who also visited it', async () => {
      const otherViewerEmail = 'other-viewer@nice.com'
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, viewerEmail) },
        env
      )
      await app.request(
        `/api/shared/${listenerShareToken}/visit`,
        { method: 'POST', headers: await authCookieHeader(env, otherViewerEmail) },
        env
      )
      await app.request(
        `/api/shared-with-me/listener/${listenerShareToken}`,
        { method: 'DELETE', headers: await authCookieHeader(env, viewerEmail) },
        env
      )

      const otherResponse = await app.request(
        '/api/shared-with-me',
        { headers: await authCookieHeader(env, otherViewerEmail) },
        env
      )
      const otherBody = (await otherResponse.json()) as { token: string }[]
      expect(otherBody.map((r) => r.token)).toContain(listenerShareToken)
    })
  })
})
