import { describe, it, expect } from 'vitest'
import { createTtlCache } from './ttlCache'

describe('createTtlCache', () => {
  it('returns a stored value until the TTL elapses', () => {
    let now = 1000
    const cache = createTtlCache<string>({
      ttlMs: 10,
      maxEntries: 5,
      now: () => now,
    })
    cache.set('a', 'one')
    expect(cache.get('a')).toBe('one')
    now = 1009
    expect(cache.get('a')).toBe('one')
    now = 1010
    expect(cache.get('a')).toBeUndefined()
  })

  it('evicts the oldest entry when over maxEntries', () => {
    const cache = createTtlCache<number>({
      ttlMs: 1000,
      maxEntries: 2,
      now: () => 0,
    })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('refreshes TTL and recency when a key is set again', () => {
    let now = 0
    const cache = createTtlCache<number>({
      ttlMs: 10,
      maxEntries: 2,
      now: () => now,
    })
    cache.set('a', 1)
    cache.set('b', 2)
    now = 5
    cache.set('a', 11)
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(11)
  })

  it('clear removes everything', () => {
    const cache = createTtlCache<number>({ ttlMs: 10, maxEntries: 2 })
    cache.set('a', 1)
    cache.clear()
    expect(cache.get('a')).toBeUndefined()
  })
})
