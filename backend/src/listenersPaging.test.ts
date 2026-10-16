import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createListener, createProjectListener } from './listeners.repo'
import { createProject } from './projects.repo'
import {
  UNPAGED_CAP,
  InvalidCursorError,
  buildListenersPageQuery,
  encodeCursor,
  getListenersPage,
  parsePageLimit,
  type ListScope,
} from './listenersPaging'
import type { SortMode } from './listeners.repo'

const OWNER = 'owner@nice.com'
const OTHER = 'other@nice.com'
const BASE = '2024-01-01T00:00:00.000Z'

async function seedProject(id = 'proj-1'): Promise<string> {
  await createProject(env.DB, id, BASE, OWNER)
  return id
}

async function seedChild(
  projectId: string,
  id: string,
  createdAt: string,
  extra: { label?: string; lastRequestAt?: string } = {},
) {
  await createProjectListener(
    env.DB,
    id,
    createdAt,
    null,
    OWNER,
    projectId,
    `slug-${id}`,
  )
  if (extra.label !== undefined || extra.lastRequestAt !== undefined) {
    await env.DB.prepare(
      'UPDATE listeners SET label = ?, last_request_at = ? WHERE id = ?',
    )
      .bind(extra.label ?? null, extra.lastRequestAt ?? null, id)
      .run()
  }
}

function at(minute: number): string {
  return `2024-02-01T00:${String(minute).padStart(2, '0')}:00.000Z`
}

async function walk(
  scope: ListScope,
  sort: SortMode,
  limit: number,
): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  for (let i = 0; i < 60; i++) {
    const page = await getListenersPage(env.DB, scope, sort, { cursor, limit })
    ids.push(...page.listeners.map((l) => l.id))
    if (!page.nextCursor) return ids
    cursor = page.nextCursor
  }
  throw new Error('pagination did not terminate')
}

async function seedMany(projectId: string, count: number) {
  const statements = []
  for (let i = 0; i < count; i++) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO listeners (id, created_at, owner_email, project_id, slug) VALUES (?, ?, ?, ?, ?)',
      ).bind(`bulk-${i}`, BASE, OWNER, projectId, `bulk-${i}`),
    )
  }
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100))
  }
}

describe('parsePageLimit', () => {
  it('defaults to 50, clamps to 100, rejects junk', () => {
    expect(parsePageLimit(undefined)).toBe(50)
    expect(parsePageLimit('20')).toBe(20)
    expect(parsePageLimit('500')).toBe(100)
    expect(parsePageLimit('0')).toBe(50)
    expect(parsePageLimit('abc')).toBe(50)
  })
})

describe('getListenersPage — date sort', () => {
  it('walks all rows newest first with no duplicates or gaps', async () => {
    const projectId = await seedProject()
    for (let i = 1; i <= 5; i++) await seedChild(projectId, `c${i}`, at(i))
    const scope: ListScope = { kind: 'project', projectId }
    const expected = ['c5', 'c4', 'c3', 'c2', 'c1']
    expect(await walk(scope, 'date', 2)).toEqual(expected)
    expect(await walk(scope, 'date', 5)).toEqual(expected)
    expect(await walk(scope, 'date', 100)).toEqual(expected)
  })

  it('reports nextCursor only when more rows exist (exact boundary)', async () => {
    const projectId = await seedProject()
    for (let i = 1; i <= 5; i++) await seedChild(projectId, `c${i}`, at(i))
    const scope: ListScope = { kind: 'project', projectId }
    const full = await getListenersPage(env.DB, scope, 'date', { limit: 5 })
    expect(full.listeners).toHaveLength(5)
    expect(full.nextCursor).toBeNull()
    const partial = await getListenersPage(env.DB, scope, 'date', { limit: 4 })
    expect(partial.listeners).toHaveLength(4)
    expect(partial.nextCursor).not.toBeNull()
  })

  it('breaks ties on created_at by id (no row repeated or skipped across pages)', async () => {
    const projectId = await seedProject()
    for (const id of ['a', 'b', 'c']) await seedChild(projectId, id, at(7))
    const scope: ListScope = { kind: 'project', projectId }
    expect(await walk(scope, 'date', 1)).toEqual(['c', 'b', 'a'])
  })
})

describe('getListenersPage — activity sort', () => {
  it('orders by last activity, never-active last by created_at, and pages consistently', async () => {
    const projectId = await seedProject()
    await seedChild(projectId, 'x', at(1), { lastRequestAt: at(50) })
    await seedChild(projectId, 'y', at(2), { lastRequestAt: at(40) })
    await seedChild(projectId, 'z', at(9)) // never active, newer
    await seedChild(projectId, 'w', at(3)) // never active, older
    await seedChild(projectId, 'p', at(5), { lastRequestAt: at(30) })
    await seedChild(projectId, 'q', at(5), { lastRequestAt: at(30) }) // exact tie with p
    const scope: ListScope = { kind: 'project', projectId }
    const expected = ['x', 'y', 'q', 'p', 'z', 'w']
    expect(await walk(scope, 'activity', 100)).toEqual(expected)
    expect(await walk(scope, 'activity', 1)).toEqual(expected)
    expect(await walk(scope, 'activity', 2)).toEqual(expected)
  })
})

describe('cursor validation', () => {
  it('rejects garbage, wrong-sort and structurally invalid cursors', async () => {
    const projectId = await seedProject()
    for (let i = 1; i <= 3; i++) await seedChild(projectId, `c${i}`, at(i))
    const scope: ListScope = { kind: 'project', projectId }

    await expect(
      getListenersPage(env.DB, scope, 'date', {
        cursor: 'not-a-cursor',
        limit: 2,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError)

    const activityPage = await getListenersPage(env.DB, scope, 'activity', {
      limit: 1,
    })
    await expect(
      getListenersPage(env.DB, scope, 'date', {
        cursor: activityPage.nextCursor!,
        limit: 2,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError)

    const missingField = btoa(JSON.stringify({ s: 'date', c: 'x' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    await expect(
      getListenersPage(env.DB, scope, 'date', {
        cursor: missingField,
        limit: 2,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError)
  })
})

describe('getListenersPage — name and custom (unpaged, capped)', () => {
  it('sorts name case-insensitively with unlabeled (slug) after', async () => {
    const projectId = await seedProject()
    await seedChild(projectId, 'b', at(1), { label: 'bravo' })
    await seedChild(projectId, 'a', at(2), { label: 'Alpha' })
    await seedChild(projectId, 'z', at(3)) // no label -> slug-z
    const page = await getListenersPage(
      env.DB,
      { kind: 'project', projectId },
      'name',
      { limit: 50 },
    )
    expect(page.listeners.map((l) => l.id)).toEqual(['a', 'b', 'z'])
    expect(page.nextCursor).toBeNull()
    expect(page.truncated).toBe(false)
  })

  it('caps at 500 and flags truncated only when more than 500 exist', async () => {
    const projectId = await seedProject()
    await seedMany(projectId, UNPAGED_CAP + 1)
    const scope: ListScope = { kind: 'project', projectId }
    const over = await getListenersPage(env.DB, scope, 'name', { limit: 50 })
    expect(over.listeners).toHaveLength(UNPAGED_CAP)
    expect(over.truncated).toBe(true)
    expect(over.nextCursor).toBeNull()

    await env.DB.prepare('DELETE FROM listeners WHERE id = ?')
      .bind('bulk-0')
      .run()
    const exact = await getListenersPage(env.DB, scope, 'custom', { limit: 50 })
    expect(exact.listeners).toHaveLength(UNPAGED_CAP)
    expect(exact.truncated).toBe(false)
  })
})

describe('getListenersPage — standalone scope', () => {
  it("returns only the owner's project-less listeners", async () => {
    const projectId = await seedProject()
    await seedChild(projectId, 'child', at(1))
    await createListener(env.DB, 's1', at(2), OWNER)
    await createListener(env.DB, 's2', at(3), OWNER)
    await createListener(env.DB, 'other-s', at(4), OTHER)
    const ids = await walk({ kind: 'standalone', email: OWNER }, 'date', 1)
    expect(ids).toEqual(['s2', 's1'])
  })
})

describe('query plans use the new indexes (no table scans)', () => {
  async function planFor(
    scope: ListScope,
    sort: SortMode,
    cursor?: string,
  ): Promise<string> {
    const { sql, binds } = buildListenersPageQuery(scope, sort, cursor, 50)
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...binds)
      .all<{ detail: string }>()
    return results.map((r) => r.detail).join(' | ')
  }

  it('standalone date keyset seeks idx_listeners_owner_standalone', async () => {
    const plan = await planFor(
      { kind: 'standalone', email: OWNER },
      'date',
      encodeCursor({ s: 'date', c: BASE, id: 'x' }),
    )
    expect(plan).toContain('idx_listeners_owner_standalone')
    expect(plan).toContain('created_at<')
    expect(plan).not.toContain('SCAN')
  })

  it('project date keyset seeks idx_listeners_project_id', async () => {
    const plan = await planFor(
      { kind: 'project', projectId: 'p' },
      'date',
      encodeCursor({ s: 'date', c: BASE, id: 'x' }),
    )
    expect(plan).toContain('idx_listeners_project_id')
    expect(plan).toContain('created_at<')
    expect(plan).not.toContain('SCAN')
  })

  it('project activity first page and keyset seek idx_listeners_project_activity', async () => {
    const first = await planFor({ kind: 'project', projectId: 'p' }, 'activity')
    expect(first).toContain('idx_listeners_project_activity')
    expect(first).not.toContain('SCAN')
    const next = await planFor(
      { kind: 'project', projectId: 'p' },
      'activity',
      encodeCursor({ s: 'activity', a: BASE, c: BASE, id: 'x' }),
    )
    expect(next).toContain('idx_listeners_project_activity')
    expect(next).toContain('<expr><')
    expect(next).not.toContain('SCAN')
  })
})

describe('deep keyset pages read about one page of rows, not the whole prefix', () => {
  async function seedDistinct(projectId: string, count: number) {
    const statements = []
    for (let i = 0; i < count; i++) {
      const ts = tsOf(i)
      statements.push(
        env.DB.prepare(
          'INSERT INTO listeners (id, created_at, owner_email, project_id, slug, last_request_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(
          `d-${String(i).padStart(4, '0')}`,
          ts,
          OWNER,
          projectId,
          `d-${i}`,
          i % 2 === 1 ? ts : null,
        ),
      )
    }
    for (let i = 0; i < statements.length; i += 100) {
      await env.DB.batch(statements.slice(i, i + 100))
    }
  }
  const tsOf = (i: number) =>
    new Date(Date.UTC(2024, 1, 1, 0, 0, i)).toISOString()

  async function rowsRead(scope: ListScope, sort: SortMode, cursor: string) {
    const { sql, binds } = buildListenersPageQuery(scope, sort, cursor, 50)
    const result = await env.DB.prepare(sql)
      .bind(...binds)
      .all()
    return (result.meta as { rows_read: number }).rows_read
  }

  it('date: a deep page reads <= 60 rows (naive OR filter reads ~250)', async () => {
    const projectId = await seedProject()
    await seedDistinct(projectId, 300)
    const cursor = encodeCursor({ s: 'date', c: tsOf(100), id: 'd-0100' })
    expect(
      await rowsRead({ kind: 'project', projectId }, 'date', cursor),
    ).toBeLessThanOrEqual(60)
  })

  it('activity: a deep page reads <= 60 rows', async () => {
    const projectId = await seedProject()
    await seedDistinct(projectId, 300)
    const cursor = encodeCursor({
      s: 'activity',
      a: tsOf(101),
      c: tsOf(101),
      id: 'd-0101',
    })
    expect(
      await rowsRead({ kind: 'project', projectId }, 'activity', cursor),
    ).toBeLessThanOrEqual(60)
  })

  it('standalone date: a deep page reads <= 60 rows', async () => {
    const statements = []
    for (let i = 0; i < 300; i++) {
      statements.push(
        env.DB.prepare(
          'INSERT INTO listeners (id, created_at, owner_email) VALUES (?, ?, ?)',
        ).bind(`s-${String(i).padStart(4, '0')}`, tsOf(i), OWNER),
      )
    }
    for (let i = 0; i < statements.length; i += 100) {
      await env.DB.batch(statements.slice(i, i + 100))
    }
    const cursor = encodeCursor({ s: 'date', c: tsOf(100), id: 's-0100' })
    expect(
      await rowsRead({ kind: 'standalone', email: OWNER }, 'date', cursor),
    ).toBeLessThanOrEqual(60)
  })
})
