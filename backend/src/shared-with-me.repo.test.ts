import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { recordSharedVisit, listSharedWithMe, removeSharedWithMe } from './shared-with-me.repo'

describe('shared-with-me.repo', () => {
  it('recordSharedVisit creates a row that listSharedWithMe returns', async () => {
    const now = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer1@nice.com', 'listener', 'token-a', now)

    const rows = await listSharedWithMe(env.DB, 'viewer1@nice.com')
    expect(rows).toEqual([{ kind: 'listener', token: 'token-a', firstVisitedAt: now }])
  })

  it('recordSharedVisit twice for the same token updates in place, not duplicates', async () => {
    const first = new Date(Date.now() - 60_000).toISOString()
    const second = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer2@nice.com', 'project', 'token-b', first)
    await recordSharedVisit(env.DB, 'viewer2@nice.com', 'project', 'token-b', second)

    const { results } = await env.DB
      .prepare('SELECT COUNT(*) AS count FROM shared_with_me WHERE viewer_email = ? AND kind = ? AND token = ?')
      .bind('viewer2@nice.com', 'project', 'token-b')
      .all<{ count: number }>()
    expect(results[0].count).toBe(1)

    const rows = await listSharedWithMe(env.DB, 'viewer2@nice.com')
    expect(rows).toEqual([{ kind: 'project', token: 'token-b', firstVisitedAt: first }])
  })

  it('removeSharedWithMe hides the entry from listSharedWithMe', async () => {
    const now = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer3@nice.com', 'listener', 'token-c', now)
    await removeSharedWithMe(env.DB, 'viewer3@nice.com', 'listener', 'token-c', new Date().toISOString())

    const rows = await listSharedWithMe(env.DB, 'viewer3@nice.com')
    expect(rows).toEqual([])
  })

  it('recording a visit after personal removal clears removed_at and it reappears', async () => {
    const first = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer4@nice.com', 'listener', 'token-d', first)
    await removeSharedWithMe(env.DB, 'viewer4@nice.com', 'listener', 'token-d', new Date().toISOString())
    expect(await listSharedWithMe(env.DB, 'viewer4@nice.com')).toEqual([])

    const revisit = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer4@nice.com', 'listener', 'token-d', revisit)
    const rows = await listSharedWithMe(env.DB, 'viewer4@nice.com')
    expect(rows).toEqual([{ kind: 'listener', token: 'token-d', firstVisitedAt: first }])
  })

  it('two different viewer emails visiting the same token get independent rows', async () => {
    const now = new Date().toISOString()
    await recordSharedVisit(env.DB, 'viewer5a@nice.com', 'project', 'token-e', now)
    await recordSharedVisit(env.DB, 'viewer5b@nice.com', 'project', 'token-e', now)

    await removeSharedWithMe(env.DB, 'viewer5a@nice.com', 'project', 'token-e', new Date().toISOString())

    expect(await listSharedWithMe(env.DB, 'viewer5a@nice.com')).toEqual([])
    expect(await listSharedWithMe(env.DB, 'viewer5b@nice.com')).toEqual([
      { kind: 'project', token: 'token-e', firstVisitedAt: now },
    ])
  })
})
