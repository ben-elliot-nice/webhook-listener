import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'

describe('project-scoped listener serialization', () => {
  it('a project-scoped listener\'s hookUrl uses the /hook/:projectId/:slug form', async () => {
    const projectResponse = await app.request('/api/projects', { method: 'POST' }, env)
    const sessionId = projectResponse.headers.get('set-cookie')?.match(/wl_session_id=([^;]+)/)?.[1]
    const projectId = ((await projectResponse.json()) as { id: string }).id

    await app.request(
      `/hook/${projectId}/checkout-uat`,
      { method: 'POST', headers: { cookie: `wl_session_id=${sessionId}` } },
      env
    )

    const listResponse = await app.request(
      '/api/listeners',
      { headers: { cookie: `wl_session_id=${sessionId}` } },
      env
    )
    const listeners = (await listResponse.json()) as { hookUrl: string; slug: string | null }[]
    const projectListener = listeners.find((l) => l.slug === 'checkout-uat')
    expect(projectListener?.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${projectId}/checkout-uat`)
  })

  it('a non-project listener\'s hookUrl is unchanged', async () => {
    const created = await app.request('/api/listeners', { method: 'POST' }, env)
    const sessionId = created.headers.get('set-cookie')?.match(/wl_session_id=([^;]+)/)?.[1]
    const listener = (await created.json()) as { id: string; hookUrl: string }
    expect(listener.hookUrl).toBe(`${env.HOOK_BASE_URL}/hook/${listener.id}`)
    void sessionId
  })
})
