import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'
import { createProjectListener } from '../listeners.repo'

interface DetailBody {
  project: { id: string; label: string | null }
  listeners: { id: string; slug: string | null; projectId: string | null }[]
  hasMore: boolean
}

describe('GET /api/projects/:id', () => {
  const ownerEmail = 'owner@nice.com'
  const otherEmail = 'other@nice.com'
  let projectId: string

  async function createProjectFor(email: string): Promise<string> {
    const created = await app.request(
      '/api/projects',
      { method: 'POST', headers: await authCookieHeader(env, email) },
      env,
    )
    return ((await created.json()) as { id: string }).id
  }

  async function seedListeners(
    forProjectId: string,
    count: number,
    prefix = 'l',
  ) {
    for (let i = 0; i < count; i++) {
      await createProjectListener(
        env.DB,
        `${prefix}-${forProjectId}-${i}`,
        `2024-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(
          i % 60,
        ).padStart(2, '0')}.000Z`,
        null,
        ownerEmail,
        forProjectId,
        `${prefix}${String(i).padStart(3, '0')}`,
      )
    }
  }

  async function getDetail(id: string, query = '', email = ownerEmail) {
    return app.request(
      `/api/projects/${id}${query}`,
      { headers: await authCookieHeader(env, email) },
      env,
    )
  }

  beforeEach(async () => {
    projectId = await createProjectFor(ownerEmail)
  })

  it('returns the project, its listeners and hasMore=false for a small project', async () => {
    await seedListeners(projectId, 3)
    const response = await getDetail(projectId)
    expect(response.status).toBe(200)
    const body = (await response.json()) as DetailBody
    expect(body.project.id).toBe(projectId)
    expect(body.listeners).toHaveLength(3)
    expect(body.hasMore).toBe(false)
  })

  it('returns 404 for an unknown project id', async () => {
    const response = await getDetail('does-not-exist')
    expect(response.status).toBe(404)
  })

  it("returns 404 for another owner's project", async () => {
    const response = await getDetail(projectId, '', otherEmail)
    expect(response.status).toBe(404)
  })

  it('caps at 100 listeners and reports hasMore when 101 exist (newest first by default)', async () => {
    await seedListeners(projectId, 101)
    const body = (await (await getDetail(projectId)).json()) as DetailBody
    expect(body.listeners).toHaveLength(100)
    expect(body.hasMore).toBe(true)
    expect(body.listeners[0].slug).toBe('l100')
    expect(body.listeners.map((l) => l.slug)).not.toContain('l000')
  })

  it('reports hasMore=false at exactly 100 listeners', async () => {
    await seedListeners(projectId, 100)
    const body = (await (await getDetail(projectId)).json()) as DetailBody
    expect(body.listeners).toHaveLength(100)
    expect(body.hasMore).toBe(false)
  })

  it('applies the requested sort (name = alphabetical)', async () => {
    for (const slug of ['charlie', 'alpha', 'bravo']) {
      await createProjectListener(
        env.DB,
        `name-${slug}`,
        '2024-01-01T00:00:00.000Z',
        null,
        ownerEmail,
        projectId,
        slug,
      )
    }
    const body = (await (
      await getDetail(projectId, '?sort=name')
    ).json()) as DetailBody
    expect(body.listeners.map((l) => l.slug)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ])
  })

  it('falls back to the date sort for an unknown sort value', async () => {
    await seedListeners(projectId, 2)
    const response = await getDetail(projectId, '?sort=bogus')
    expect(response.status).toBe(200)
    const body = (await response.json()) as DetailBody
    expect(body.listeners.map((l) => l.slug)).toEqual(['l001', 'l000'])
  })

  it("never includes another project's listeners", async () => {
    const otherProjectId = await createProjectFor(ownerEmail)
    await seedListeners(projectId, 2, 'mine')
    await seedListeners(otherProjectId, 2, 'theirs')
    const body = (await (await getDetail(projectId)).json()) as DetailBody
    expect(body.listeners.every((l) => l.projectId === projectId)).toBe(true)
    expect(body.listeners).toHaveLength(2)
  })
})
