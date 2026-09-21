import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createProject, getProjectsForOwner, getProject } from './projects.repo'

describe('projects.repo', () => {
  it('createProject inserts a row and returns it', async () => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const result = await createProject(env.DB, id, createdAt, 'session-a')
    expect(result).toEqual({ id, createdAt, ownerSession: 'session-a' })
  })

  it('getProject returns undefined for an unknown id', async () => {
    const result = await getProject(env.DB, crypto.randomUUID())
    expect(result).toBeUndefined()
  })

  it('getProject returns the row for a known id', async () => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    await createProject(env.DB, id, createdAt, 'session-b')
    const result = await getProject(env.DB, id)
    expect(result).toEqual({ id, createdAt, ownerSession: 'session-b' })
  })

  it('getProjectsForOwner returns only the caller session, newest first', async () => {
    const sessionId = crypto.randomUUID()
    const first = await createProject(env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', sessionId)
    const second = await createProject(env.DB, crypto.randomUUID(), '2026-01-02T00:00:00.000Z', sessionId)
    await createProject(env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', 'other-session')

    const results = await getProjectsForOwner(env.DB, sessionId)
    expect(results.map((p) => p.id)).toEqual([second.id, first.id])
  })

  it('getProjectsForOwner returns an empty list for a session with no projects', async () => {
    const results = await getProjectsForOwner(env.DB, crypto.randomUUID())
    expect(results).toEqual([])
  })
})
