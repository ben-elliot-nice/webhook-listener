import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from './db'
import {
  createListener,
  getListener,
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
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z')
    const found = getListener(db, 'listener-1')
    expect(found).toEqual({ id: 'listener-1', createdAt: '2024-01-01T00:00:00.000Z', shareToken: null })
  })

  it('returns undefined for an unknown listener', () => {
    expect(getListener(db, 'does-not-exist')).toBeUndefined()
  })

  it('deletes a listener and reports success', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z')
    expect(deleteListener(db, 'listener-1')).toBe(true)
    expect(getListener(db, 'listener-1')).toBeUndefined()
  })

  it('reports failure when deleting an unknown listener', () => {
    expect(deleteListener(db, 'does-not-exist')).toBe(false)
  })
})

describe('share tokens', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z')
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
