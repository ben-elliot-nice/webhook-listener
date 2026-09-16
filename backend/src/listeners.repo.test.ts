import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from './db'
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
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('creates and fetches a listener', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    const found = getListener(db, 'listener-1')
    expect(found).toEqual({
      id: 'listener-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      shareToken: null,
      ownerSession: 'session-a',
    })
  })

  it('returns undefined for an unknown listener', () => {
    expect(getListener(db, 'does-not-exist')).toBeUndefined()
  })

  it('deletes a listener and reports success', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    expect(deleteListener(db, 'listener-1')).toBe(true)
    expect(getListener(db, 'listener-1')).toBeUndefined()
  })

  it('reports failure when deleting an unknown listener', () => {
    expect(deleteListener(db, 'does-not-exist')).toBe(false)
  })
})

describe('getListenerForOwner', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
  })

  it('returns the listener when the session matches its owner', () => {
    const found = getListenerForOwner(db, 'listener-1', 'session-a')
    expect(found?.id).toBe('listener-1')
  })

  it('returns undefined when the session does not match', () => {
    expect(getListenerForOwner(db, 'listener-1', 'session-b')).toBeUndefined()
  })

  it('returns undefined for an unknown listener id', () => {
    expect(getListenerForOwner(db, 'does-not-exist', 'session-a')).toBeUndefined()
  })

  it('returns undefined for a listener with no owner_session recorded (legacy row)', () => {
    db.prepare("INSERT INTO listeners (id, created_at) VALUES ('legacy-listener', '2024-01-01T00:00:00.000Z')").run()
    expect(getListenerForOwner(db, 'legacy-listener', 'session-a')).toBeUndefined()
  })
})

describe('share tokens', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
  })

  it('creates a share token on first call and reuses it on subsequent calls', () => {
    const first = getOrCreateShareToken(db, 'listener-1')
    const second = getOrCreateShareToken(db, 'listener-1')
    expect(first).toBeTypeOf('string')
    expect(second).toBe(first)
  })

  it('returns undefined for an unknown listener', () => {
    expect(getOrCreateShareToken(db, 'does-not-exist')).toBeUndefined()
  })

  it('looks up a listener by its share token', () => {
    const token = getOrCreateShareToken(db, 'listener-1') as string
    const found = getListenerByShareToken(db, token)
    expect(found?.id).toBe('listener-1')
  })

  it('returns undefined for an unknown share token', () => {
    expect(getListenerByShareToken(db, 'does-not-exist')).toBeUndefined()
  })

  it('revokes a share token', () => {
    const token = getOrCreateShareToken(db, 'listener-1') as string
    expect(revokeShareToken(db, 'listener-1')).toBe(true)
    expect(getListenerByShareToken(db, token)).toBeUndefined()
  })

  it('reports failure when revoking an unknown listener', () => {
    expect(revokeShareToken(db, 'does-not-exist')).toBe(false)
  })
})

describe('getListenersForOwner', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('returns only the calling session\'s listeners, newest first', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    createListener(db, 'listener-2', '2024-01-02T00:00:00.000Z', 'session-a')
    createListener(db, 'listener-3', '2024-01-03T00:00:00.000Z', 'session-b')

    const result = getListenersForOwner(db, 'session-a', 100)
    expect(result.map((l) => l.id)).toEqual(['listener-2', 'listener-1'])
  })

  it('returns an empty array for a session with no listeners', () => {
    expect(getListenersForOwner(db, 'session-with-nothing', 100)).toEqual([])
  })

  it('respects the limit', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z', 'session-a')
    createListener(db, 'listener-2', '2024-01-02T00:00:00.000Z', 'session-a')
    createListener(db, 'listener-3', '2024-01-03T00:00:00.000Z', 'session-a')

    const result = getListenersForOwner(db, 'session-a', 2)
    expect(result).toHaveLength(2)
    expect(result.map((l) => l.id)).toEqual(['listener-3', 'listener-2'])
  })
})
