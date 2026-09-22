import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import {
  createProject,
  getProjectsForOwner,
  getProject,
  getProjectForOwner,
  setProjectLabel,
  getOrCreateProjectShareToken,
  revokeProjectShareToken,
  getProjectByShareToken,
  deleteProject,
} from './projects.repo'
import { LabelValidationError } from './listeners.repo'
import { createProjectListener } from './listeners.repo'

describe('projects.repo', () => {
  it('createProject inserts a row and returns it', async () => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const result = await createProject(env.DB, id, createdAt, 'a@nice.com')
    expect(result).toEqual({
      id,
      createdAt,
      ownerSession: null,
      ownerEmail: 'a@nice.com',
      sortPosition: null,
      label: null,
      shareToken: null,
    })
  })

  it('getProject returns undefined for an unknown id', async () => {
    const result = await getProject(env.DB, crypto.randomUUID())
    expect(result).toBeUndefined()
  })

  it('getProject returns the row for a known id', async () => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    await createProject(env.DB, id, createdAt, 'b@nice.com')
    const result = await getProject(env.DB, id)
    expect(result).toEqual({
      id,
      createdAt,
      ownerSession: null,
      ownerEmail: 'b@nice.com',
      sortPosition: null,
      label: null,
      shareToken: null,
    })
  })

  it('getProjectsForOwner returns only the caller session, newest first', async () => {
    const email = `${crypto.randomUUID()}@nice.com`
    const first = await createProject(env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', email)
    const second = await createProject(env.DB, crypto.randomUUID(), '2026-01-02T00:00:00.000Z', email)
    await createProject(env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', 'other@nice.com')

    const results = await getProjectsForOwner(env.DB, email)
    expect(results.map((p) => p.id)).toEqual([second.id, first.id])
  })

  it('getProjectsForOwner returns an empty list for a session with no projects', async () => {
    const results = await getProjectsForOwner(env.DB, `${crypto.randomUUID()}@nice.com`)
    expect(results).toEqual([])
  })

  it('getProjectsForOwner places a project with a set sort_position before ones without, regardless of created_at', async () => {
    const email = `${crypto.randomUUID()}@nice.com`
    const older = await createProject(env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', email)
    const newer = await createProject(env.DB, crypto.randomUUID(), '2026-01-02T00:00:00.000Z', email)
    // Give the older project an explicit position; the newer one stays unset (null).
    await env.DB.prepare('UPDATE projects SET sort_position = 0 WHERE id = ?').bind(older.id).run()

    const results = await getProjectsForOwner(env.DB, email)
    expect(results.map((p) => p.id)).toEqual([older.id, newer.id])
    expect(results[0].sortPosition).toBe(0)
    expect(results[1].sortPosition).toBeNull()
  })

  it('createProject returns a record with label and shareToken null', async () => {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const result = await createProject(env.DB, id, createdAt, 'label@nice.com')
    expect(result).toEqual({
      id,
      createdAt,
      ownerSession: null,
      ownerEmail: 'label@nice.com',
      sortPosition: null,
      label: null,
      shareToken: null,
    })
  })

  it('getProjectForOwner returns the project for the owning session', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'owner@nice.com')
    const result = await getProjectForOwner(env.DB, project.id, 'owner@nice.com')
    expect(result?.id).toBe(project.id)
  })

  it('getProjectForOwner returns undefined for a different session', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'owner2@nice.com')
    const result = await getProjectForOwner(env.DB, project.id, 'other@nice.com')
    expect(result).toBeUndefined()
  })

  it('getProjectForOwner returns undefined for an unknown id', async () => {
    const result = await getProjectForOwner(env.DB, crypto.randomUUID(), 'owner3@nice.com')
    expect(result).toBeUndefined()
  })

  it('setProjectLabel trims and sets a label', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-c@nice.com')
    const label = await setProjectLabel(env.DB, project.id, '  UAT batch  ')
    expect(label).toBe('UAT batch')
    const reloaded = await getProject(env.DB, project.id)
    expect(reloaded?.label).toBe('UAT batch')
  })

  it('setProjectLabel clears the label with an empty string', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-d@nice.com')
    await setProjectLabel(env.DB, project.id, 'Something')
    const label = await setProjectLabel(env.DB, project.id, '')
    expect(label).toBeNull()
  })

  it('setProjectLabel throws LabelValidationError over 100 characters', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-e@nice.com')
    await expect(setProjectLabel(env.DB, project.id, 'x'.repeat(101))).rejects.toThrow(LabelValidationError)
  })

  it('getOrCreateProjectShareToken creates then returns the same token on repeat calls', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-f@nice.com')
    const first = await getOrCreateProjectShareToken(env.DB, project.id)
    const second = await getOrCreateProjectShareToken(env.DB, project.id)
    expect(first).toBeTypeOf('string')
    expect(second).toBe(first)
  })

  it('getOrCreateProjectShareToken returns undefined for an unknown project', async () => {
    const result = await getOrCreateProjectShareToken(env.DB, crypto.randomUUID())
    expect(result).toBeUndefined()
  })

  it('getProjectByShareToken resolves a project by its token', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-g@nice.com')
    const token = await getOrCreateProjectShareToken(env.DB, project.id)
    const resolved = await getProjectByShareToken(env.DB, token as string)
    expect(resolved?.id).toBe(project.id)
  })

  it('getProjectByShareToken returns undefined for an unknown token', async () => {
    const resolved = await getProjectByShareToken(env.DB, 'does-not-exist')
    expect(resolved).toBeUndefined()
  })

  it('revokeProjectShareToken clears the token', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-h@nice.com')
    const token = await getOrCreateProjectShareToken(env.DB, project.id)
    const revoked = await revokeProjectShareToken(env.DB, project.id)
    expect(revoked).toBe(true)
    const resolved = await getProjectByShareToken(env.DB, token as string)
    expect(resolved).toBeUndefined()
  })

  it('deleteProject removes the project and its child listeners', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-i@nice.com')
    await createProjectListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-i', null, project.id, 'case-one')
    await createProjectListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-i', null, project.id, 'case-two')

    const deleted = await deleteProject(env.DB, project.id)
    expect(deleted).toBe(true)

    const reloadedProject = await getProject(env.DB, project.id)
    expect(reloadedProject).toBeUndefined()

    const { results: remainingListeners } = await env.DB
      .prepare('SELECT id FROM listeners WHERE project_id = ?')
      .bind(project.id)
      .all()
    expect(remainingListeners).toEqual([])
  })

  it('deleteProject on a project with zero listeners is a clean no-op batch', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-j@nice.com')
    const deleted = await deleteProject(env.DB, project.id)
    expect(deleted).toBe(true)
  })

  it('deleteProject returns false for an unknown project', async () => {
    const deleted = await deleteProject(env.DB, crypto.randomUUID())
    expect(deleted).toBe(false)
  })
})
