import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { authCookieHeader } from '../test-helpers/auth'
import { createListener, createProjectListener } from '../listeners.repo'
import { createProject } from '../projects.repo'

interface StandaloneBody {
  listeners: { id: string; projectId: string | null }[]
  nextCursor: string | null
  truncated: boolean
}

const OWNER = 'owner@nice.com'
const OTHER = 'other@nice.com'

async function get(query: string, email = OWNER) {
  return app.request(
    `/api/standalone-listeners${query}`,
    { headers: await authCookieHeader(env, email) },
    env,
  )
}

function at(minute: number): string {
  return `2024-02-01T00:${String(minute).padStart(2, '0')}:00.000Z`
}

describe('GET /api/standalone-listeners', () => {
  it("returns only the caller's project-less listeners, newest first", async () => {
    await createProject(env.DB, 'proj', at(0), OWNER)
    await createProjectListener(
      env.DB,
      'child',
      at(9),
      null,
      OWNER,
      'proj',
      'c',
    )
    await createListener(env.DB, 's1', at(1), OWNER)
    await createListener(env.DB, 's2', at(2), OWNER)
    await createListener(env.DB, 'theirs', at(3), OTHER)

    const body = (await (await get('')).json()) as StandaloneBody
    expect(body.listeners.map((l) => l.id)).toEqual(['s2', 's1'])
    expect(body.listeners.every((l) => l.projectId === null)).toBe(true)
    expect(body.nextCursor).toBeNull()
    expect(body.truncated).toBe(false)
  })

  it('pages with limit and nextCursor without gaps or duplicates', async () => {
    for (let i = 1; i <= 5; i++) {
      await createListener(env.DB, `s${i}`, at(i), OWNER)
    }
    const ids: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 10; i++) {
      const query: string =
        cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`
      const body = (await (await get(query)).json()) as StandaloneBody
      ids.push(...body.listeners.map((l) => l.id))
      cursor = body.nextCursor
      if (cursor === null) break
    }
    expect(ids).toEqual(['s5', 's4', 's3', 's2', 's1'])
  })

  it('returns 400 for a malformed cursor', async () => {
    const response = await get('?cursor=garbage')
    expect(response.status).toBe(400)
  })

  it('an owner with no listeners gets an empty page', async () => {
    const body = (await (
      await get('', 'nobody@nice.com')
    ).json()) as StandaloneBody
    expect(body.listeners).toEqual([])
    expect(body.nextCursor).toBeNull()
  })
})
