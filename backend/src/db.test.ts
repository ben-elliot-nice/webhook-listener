import { describe, it, expect } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db'

describe('createDb', () => {
  it('creates listeners and requests tables', () => {
    const db = createDb(':memory:')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual(['listeners', 'requests'])
  })

  it('adds a share_token column to the listeners table', () => {
    const db = createDb(':memory:')
    const columns = db.pragma('table_info(listeners)') as { name: string }[]
    expect(columns.map((c) => c.name)).toContain('share_token')
  })

  it('adds an owner_session column to the listeners table', () => {
    const db = createDb(':memory:')
    const columns = db.pragma('table_info(listeners)') as { name: string }[]
    expect(columns.map((c) => c.name)).toContain('owner_session')
  })

  it('is safe to run the migration twice against the same database file', () => {
    const path = join(tmpdir(), `webhook-listener-migration-test-${Date.now()}.db`)
    try {
      createDb(path)
      expect(() => createDb(path)).not.toThrow()
    } finally {
      rmSync(path, { force: true })
      rmSync(`${path}-wal`, { force: true })
      rmSync(`${path}-shm`, { force: true })
    }
  })
})
