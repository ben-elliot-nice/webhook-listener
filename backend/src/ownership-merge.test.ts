import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { mergeSessionIntoEmail } from './ownership-merge'

describe('mergeSessionIntoEmail', () => {
  it('reassigns a matching listener to the email and clears its owner_session', async () => {
    const sessionId = crypto.randomUUID()
    const listenerId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO listeners (id, created_at, owner_session) VALUES (?, ?, ?)')
      .bind(listenerId, new Date().toISOString(), sessionId)
      .run()
    const listener = { id: listenerId }

    await mergeSessionIntoEmail(env.DB, sessionId, 'claimed@nice.com')

    const updated = await env.DB.prepare('SELECT owner_email, owner_session FROM listeners WHERE id = ?')
      .bind(listener.id)
      .first<{ owner_email: string | null; owner_session: string | null }>()
    expect(updated?.owner_email).toBe('claimed@nice.com')
    expect(updated?.owner_session).toBeNull()
  })

  it('reassigns a matching project to the email and clears its owner_session', async () => {
    const sessionId = crypto.randomUUID()
    const projectId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO projects (id, created_at, owner_session) VALUES (?, ?, ?)')
      .bind(projectId, new Date().toISOString(), sessionId)
      .run()

    await mergeSessionIntoEmail(env.DB, sessionId, 'claimed@nice.com')

    const updated = await env.DB.prepare('SELECT owner_email, owner_session FROM projects WHERE id = ?')
      .bind(projectId)
      .first<{ owner_email: string | null; owner_session: string | null }>()
    expect(updated?.owner_email).toBe('claimed@nice.com')
    expect(updated?.owner_session).toBeNull()
  })

  it('does not touch rows belonging to a different session', async () => {
    const sessionId = crypto.randomUUID()
    const otherSessionId = crypto.randomUUID()
    const listenerId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO listeners (id, created_at, owner_session) VALUES (?, ?, ?)')
      .bind(listenerId, new Date().toISOString(), otherSessionId)
      .run()
    const listener = { id: listenerId }

    await mergeSessionIntoEmail(env.DB, sessionId, 'claimed@nice.com')

    const untouched = await env.DB.prepare('SELECT owner_email, owner_session FROM listeners WHERE id = ?')
      .bind(listener.id)
      .first<{ owner_email: string | null; owner_session: string | null }>()
    expect(untouched?.owner_email).toBeNull()
    expect(untouched?.owner_session).toBe(otherSessionId)
  })

  it('is a no-op the second time it is called for the same session (already claimed)', async () => {
    const sessionId = crypto.randomUUID()
    const listenerId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO listeners (id, created_at, owner_session) VALUES (?, ?, ?)')
      .bind(listenerId, new Date().toISOString(), sessionId)
      .run()
    const listener = { id: listenerId }

    await mergeSessionIntoEmail(env.DB, sessionId, 'first@nice.com')
    await mergeSessionIntoEmail(env.DB, sessionId, 'second@nice.com')

    const updated = await env.DB.prepare('SELECT owner_email, owner_session FROM listeners WHERE id = ?')
      .bind(listener.id)
      .first<{ owner_email: string | null; owner_session: string | null }>()
    expect(updated?.owner_email).toBe('first@nice.com')
  })
})
