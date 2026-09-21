import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('manual listener creation inside a project', () => {
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

  it('creates a listener with the given identifier', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'checkout-uat' }),
      },
      env
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as { slug: string; projectId: string; hookUrl: string }
    expect(body.slug).toBe('checkout-uat')
    expect(body.projectId).toBe(projectId)
    expect(body.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${projectId}/checkout-uat`)
  })

  it('the created listener has no webhook token (project id is the only gate)', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'checkout-uat-2' }),
      },
      env
    )
    const body = (await response.json()) as { id: string }
    const listResponse = await app.request(
      '/api/listeners',
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listeners = (await listResponse.json()) as { id: string; slug: string | null }[]
    expect(listeners.find((l) => l.id === body.id)?.slug).toBe('checkout-uat-2')

    const hookResponse = await app.request(
      `/hook/${projectId}/checkout-uat-2`,
      { method: 'POST' },
      env
    )
    expect(hookResponse.status).toBe(200)

    const row = await env.DB.prepare('SELECT webhook_token FROM listeners WHERE id = ?')
      .bind(body.id)
      .first<{ webhook_token: string | null }>()
    expect(row?.webhook_token).toBeNull()
  })

  it('a forced race between two near-simultaneous creates resolves to exactly one listener and a 409 for the loser', async () => {
    const slug = 'race-condition-create'
    const requestHeaders = { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' }
    const fire = () =>
      app.request(
        `/api/projects/${projectId}/listeners`,
        {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify({ slug }),
        },
        env
      )

    const [first, second] = await Promise.all([fire(), fire()])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([201, 409])

    const rows = await env.DB.prepare(
      'SELECT id FROM listeners WHERE project_id = ? AND slug = ?'
    )
      .bind(projectId, slug)
      .all()
    expect(rows.results.length).toBe(1)
  })

  it('appears via a subsequent create-and-send hit, unchanged from auto-create behavior', async () => {
    await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'checkout-uat-3' }),
      },
      env
    )
    const hookResponse = await app.request(
      `/hook/${projectId}/checkout-uat-3`,
      { method: 'POST' },
      env
    )
    expect(hookResponse.status).toBe(200)
  })

  it('returns 409 for an identifier that already exists in the project', async () => {
    await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'dup-case' }),
      },
      env
    )
    const response = await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'dup-case' }),
      },
      env
    )
    expect(response.status).toBe(409)
  })

  it('returns 400 for an invalid slug', async () => {
    const response = await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'ab' }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 for a project owned by a different owner', async () => {
    const otherEmail = 'other@nice.com'
    const response = await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, otherEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'checkout-uat-4' }),
      },
      env
    )
    expect(response.status).toBe(404)
  })

  it('the same identifier is still creatable in a different project', async () => {
    await app.request(
      `/api/projects/${projectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'shared-name' }),
      },
      env
    )
    const secondProject = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const secondProjectId = ((await secondProject.json()) as { id: string }).id
    const response = await app.request(
      `/api/projects/${secondProjectId}/listeners`,
      {
        method: 'POST',
        headers: { ...(await authCookieHeader(env, ownerEmail)), 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'shared-name' }),
      },
      env
    )
    expect(response.status).toBe(201)
  })
})
