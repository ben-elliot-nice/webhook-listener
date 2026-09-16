import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from './db'
import { createListener, getListener, deleteListener } from './listeners.repo'

describe('listeners repo', () => {
  let db: Db

  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('creates and fetches a listener', () => {
    createListener(db, 'listener-1', '2024-01-01T00:00:00.000Z')
    const found = getListener(db, 'listener-1')
    expect(found).toEqual({ id: 'listener-1', createdAt: '2024-01-01T00:00:00.000Z' })
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
