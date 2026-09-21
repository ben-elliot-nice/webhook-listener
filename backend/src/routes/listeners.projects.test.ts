import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'

describe('project-scoped listener serialization', () => {
  it('a project-scoped listener\'s hookUrl uses the /hook/:projectId/:slug form', async () => {
    const ownerEmail = 'owner@nice.com'
    const projectResponse = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const projectId = ((await projectResponse.json()) as { id: string }).id

    await app.request(`/hook/${projectId}/checkout-uat`, { method: 'POST' }, env)

    const listResponse = await app.request(
      '/api/listeners',
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listeners = (await listResponse.json()) as { hookUrl: string; slug: string | null }[]
    const projectListener = listeners.find((l) => l.slug === 'checkout-uat')
    expect(projectListener?.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${projectId}/checkout-uat`)
  })

  it('a non-project listener\'s hookUrl is unchanged', async () => {
    const created = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, 'owner@nice.com') },
      env
    )
    const listener = (await created.json()) as { id: string; hookUrl: string }
    expect(listener.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${listener.id}`)
  })

  it('serialized listener includes projectId (null for standalone, set for project-scoped)', async () => {
    const ownerEmail = 'owner@nice.com'
    const standalone = await app.request(
      '/api/listeners',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const standaloneBody = (await standalone.json()) as { projectId: string | null }
    expect(standaloneBody.projectId).toBeNull()

    const projectResponse = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const projectId = ((await projectResponse.json()) as { id: string }).id

    await app.request(`/hook/${projectId}/checkout-uat-2`, { method: 'POST' }, env)

    const listResponse = await app.request(
      '/api/listeners',
      { headers: await authCookieHeader(env, ownerEmail) },
      env
    )
    const listeners = (await listResponse.json()) as { slug: string | null; projectId: string | null }[]
    const projectListener = listeners.find((l) => l.slug === 'checkout-uat-2')
    expect(projectListener?.projectId).toBe(projectId)
  })
})
