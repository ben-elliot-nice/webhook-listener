import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import {
  createListener,
  getListener,
  getListenerForOwner,
  getListenersForOwner,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
  getListenerByShareToken,
} from './listeners.repo'

describe('listeners repo', () => {
  it('creates and fetches a listener', async () => {
    await createListener(env.DB, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    const found = await getListener(env.DB, 'listener-1')
    expect(found).toEqual({
      id: 'listener-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      shareToken: null,
      ownerSession: 'session-a',
    })
  })

  it('returns undefined for an unknown listener', async () => {
    expect(await getListener(env.DB, 'does-not-exist')).toBeUndefined()
  })

  it('deletes a listener and reports success', async () => {
    await createListener(env.DB, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    expect(await deleteListener(env.DB, 'listener-1')).toBe(true)
    expect(await getListener(env.DB, 'listener-1')).toBeUndefined()
  })

  it('reports failure when deleting an unknown listener', async () => {
    expect(await deleteListener(env.DB, 'does-not-exist')).toBe(false)
  })
})

describe('getListenerForOwner', () => {
  it('returns the listener when the session matches its owner', async () => {
    await createListener(env.DB, 'listener-2', '2024-01-01T00:00:00.000Z', 'session-a')
    const found = await getListenerForOwner(env.DB, 'listener-2', 'session-a')
    expect(found?.id).toBe('listener-2')
  })

  it('returns undefined when the session does not match', async () => {
    await createListener(env.DB, 'listener-3', '2024-01-01T00:00:00.000Z', 'session-a')
    expect(await getListenerForOwner(env.DB, 'listener-3', 'session-b')).toBeUndefined()
  })

  it('returns undefined for an unknown listener id', async () => {
    expect(await getListenerForOwner(env.DB, 'does-not-exist', 'session-a')).toBeUndefined()
  })

  it('returns undefined for a listener with no owner_session recorded (legacy row)', async () => {
    await env.DB.prepare("INSERT INTO listeners (id, created_at) VALUES ('legacy-listener', '2024-01-01T00:00:00.000Z')").run()
    expect(await getListenerForOwner(env.DB, 'legacy-listener', 'session-a')).toBeUndefined()
  })
})

describe('share tokens', () => {
  it('creates a share token on first call and reuses it on subsequent calls', async () => {
    await createListener(env.DB, 'listener-4', '2024-01-01T00:00:00.000Z', 'session-a')
    const first = await getOrCreateShareToken(env.DB, 'listener-4')
    const second = await getOrCreateShareToken(env.DB, 'listener-4')
    expect(first).toBeTypeOf('string')
    expect(second).toBe(first)
  })

  it('returns undefined for an unknown listener', async () => {
    expect(await getOrCreateShareToken(env.DB, 'does-not-exist')).toBeUndefined()
  })

  it('looks up a listener by its share token', async () => {
    await createListener(env.DB, 'listener-5', '2024-01-01T00:00:00.000Z', 'session-a')
    const token = (await getOrCreateShareToken(env.DB, 'listener-5')) as string
    const found = await getListenerByShareToken(env.DB, token)
    expect(found?.id).toBe('listener-5')
  })

  it('returns undefined for an unknown share token', async () => {
    expect(await getListenerByShareToken(env.DB, 'does-not-exist')).toBeUndefined()
  })

  it('revokes a share token', async () => {
    await createListener(env.DB, 'listener-6', '2024-01-01T00:00:00.000Z', 'session-a')
    const token = (await getOrCreateShareToken(env.DB, 'listener-6')) as string
    expect(await revokeShareToken(env.DB, 'listener-6')).toBe(true)
    expect(await getListenerByShareToken(env.DB, token)).toBeUndefined()
  })

  it('reports failure when revoking an unknown listener', async () => {
    expect(await revokeShareToken(env.DB, 'does-not-exist')).toBe(false)
  })
})

describe('getListenersForOwner', () => {
  it("returns only the calling session's listeners, newest first", async () => {
    await createListener(env.DB, 'listener-7', '2024-01-01T00:00:00.000Z', 'session-x')
    await createListener(env.DB, 'listener-8', '2024-01-02T00:00:00.000Z', 'session-x')
    await createListener(env.DB, 'listener-9', '2024-01-03T00:00:00.000Z', 'session-y')

    const result = await getListenersForOwner(env.DB, 'session-x', 100)
    expect(result.map((l) => l.id)).toEqual(['listener-8', 'listener-7'])
  })

  it('returns an empty array for a session with no listeners', async () => {
    expect(await getListenersForOwner(env.DB, 'session-with-nothing', 100)).toEqual([])
  })

  it('respects the limit', async () => {
    await createListener(env.DB, 'listener-10', '2024-01-01T00:00:00.000Z', 'session-z')
    await createListener(env.DB, 'listener-11', '2024-01-02T00:00:00.000Z', 'session-z')
    await createListener(env.DB, 'listener-12', '2024-01-03T00:00:00.000Z', 'session-z')

    const result = await getListenersForOwner(env.DB, 'session-z', 2)
    expect(result).toHaveLength(2)
    expect(result.map((l) => l.id)).toEqual(['listener-12', 'listener-11'])
  })
})
