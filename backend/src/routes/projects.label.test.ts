import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('project label management', () => {
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

  it('sets a label', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ label: '  UAT batch  ' }),
      },
      env
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as { label: string }).toEqual({ label: 'UAT batch' })
  })

  it('clears a label with an empty string', async () => {
    await app.request(
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Something' }),
      },
      env
    )
    const response = await app.request(
      `/api/projects/${projectId}/label`,
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
      `/api/projects/${projectId}/label`,
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
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: { ...(await authCookieHeader(env, otherEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'nope' }),
      },
      env
    )
    expect(response.status).toBe(404)
  })

  it('the label appears on GET /api/projects', async () => {
    await app.request(
      `/api/projects/${projectId}/label`,
      {
        method: 'PATCH',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'UAT batch' }),
      },
      env
    )
    const list = await app.request('/api/projects', { headers: await authCookieHeader(env, ownerEmail) }, env)
    const body = (await list.json()) as { id: string; label: string | null }[]
    expect(body.find((p) => p.id === projectId)?.label).toBe('UAT batch')
  })
})
