export interface TtlCache<V> {
  get(key: string): V | undefined
  set(key: string, value: V): void
  clear(): void
}

export function createTtlCache<V>(options: {
  ttlMs: number
  maxEntries: number
  now?: () => number
}): TtlCache<V> {
  const now = options.now ?? Date.now
  const entries = new Map<string, { value: V; expiresAt: number }>()

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= now()) {
        entries.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key, value) {
      // delete-then-set moves the key to the end, so insertion order is
      // recency order and the first key is always the oldest.
      entries.delete(key)
      entries.set(key, { value, expiresAt: now() + options.ttlMs })
      while (entries.size > options.maxEntries) {
        const oldest = entries.keys().next().value as string
        entries.delete(oldest)
      }
    },
    clear() {
      entries.clear()
    },
  }
}
