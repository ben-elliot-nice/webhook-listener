import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createProject, getProjectsForOwner, getProject } from './projects.repo'

describe('projects.repo', () => {
  it('createProject inserts a row and returns it', async () => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const result = await createProject(env.DB, id, createdAt, 'session-a')
    expect(result).toEqual({ id, createdAt, ownerSession: 'session-a', sortPosition: null })
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
    expect(result).toEqual({ id, createdAt, ownerSession: 'session-b', sortPosition: null })
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

  it('getProjectsForOwner places a project with a set sort_position before ones without, regardless of created_at', async () => {
    const sessionId = crypto.randomUUID()
    const older = await createProject(env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', sessionId)
    const newer = await createProject(env.DB, crypto.randomUUID(), '2026-01-02T00:00:00.000Z', sessionId)
    // Give the older project an explicit position; the newer one stays unset (null).
    await env.DB.prepare('UPDATE projects SET sort_position = 0 WHERE id = ?').bind(older.id).run()

    const results = await getProjectsForOwner(env.DB, sessionId)
    expect(results.map((p) => p.id)).toEqual([older.id, newer.id])
    expect(results[0].sortPosition).toBe(0)
    expect(results[1].sortPosition).toBeNull()
  })
})
