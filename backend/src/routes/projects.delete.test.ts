import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('project delete', () => {
  let projectId: string
  const ownerEmail = 'owner@nice.com'

  beforeEach(async () => {
    const created = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const createdBody = (await created.json()) as { id: string }
    projectId = createdBody.id
  })

  it('deletes a project with no listeners', async () => {
    const response = await app.request(
      `/api/projects/${projectId}`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(204)

    const list = await app.request('/api/projects', { headers: await authCookieHeader(env, ownerEmail) }, env)
    const body = (await list.json()) as { id: string }[]
    expect(body.find((p) => p.id === projectId)).toBeUndefined()
  })

  it('cascades to child listeners and their requests', async () => {
    const hookResponse = await app.request(
      `/hook/${projectId}/uat-case-1`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env
    )
    expect(hookResponse.status).toBe(201)

    const listenersBefore = await env.DB.prepare('SELECT id FROM listeners WHERE project_id = ?').bind(projectId).all()
    expect(listenersBefore.results.length).toBe(1)
    const listenerId = (listenersBefore.results[0] as { id: string }).id
    const requestsBefore = await env.DB.prepare('SELECT id FROM requests WHERE listener_id = ?').bind(listenerId).all()
    expect(requestsBefore.results.length).toBe(1)

    const response = await app.request(
      `/api/projects/${projectId}`,
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(204)

    const listenersAfter = await env.DB.prepare('SELECT id FROM listeners WHERE project_id = ?').bind(projectId).all()
    expect(listenersAfter.results).toEqual([])
    const requestsAfter = await env.DB.prepare('SELECT id FROM requests WHERE listener_id = ?').bind(listenerId).all()
    expect(requestsAfter.results).toEqual([])
  })

  it('returns 404 for an unknown project', async () => {
    const response = await app.request(
      '/api/projects/does-not-exist',
      { method: 'DELETE', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 for a different owner, and leaves the project intact', async () => {
    const otherEmail = 'other@nice.com'
    const response = await app.request(
      `/api/projects/${projectId}`,
      { method: 'DELETE', headers: await authCookieHeader(env, otherEmail) },
      env
    )
    expect(response.status).toBe(404)

    const stillThere = await app.request(
      `/api/projects`,
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const body = (await stillThere.json()) as { id: string }[]
    expect(body.find((p) => p.id === projectId)).toBeDefined()
  })
})
