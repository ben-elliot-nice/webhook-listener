import type { Env } from './env'
import {
  SELECT_COLUMNS,
  type ListenerRecord,
  type SortMode,
} from './listeners.repo'

export const PAGE_DEFAULT_LIMIT = 50
export const PAGE_MAX_LIMIT = 100
export const UNPAGED_CAP = 500

export type ListScope =
  { kind: 'project'; projectId: string } | { kind: 'standalone'; email: string }

export interface ListenersPage {
  listeners: ListenerRecord[]
  nextCursor: string | null
  truncated: boolean
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor')
  }
}

export type Cursor =
  | { s: 'date'; c: string; id: string }
  | { s: 'activity'; a: string; c: string; id: string }

// Must match the index expression in migration 0013 exactly.
const ACTIVITY_KEY = "COALESCE(last_request_at, '')"

const UNPAGED_ORDER = {
  name: '(COALESCE(label, slug) IS NULL), COALESCE(label, slug) COLLATE NOCASE ASC, created_at DESC, id DESC',
  custom:
    '(sort_position IS NULL), sort_position ASC, created_at DESC, id DESC',
} as const

export function parsePageLimit(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return PAGE_DEFAULT_LIMIT
  return Math.min(parsed, PAGE_MAX_LIMIT)
}

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): string {
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (text.length % 4)) % 4)
  return atob(padded)
}

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify(cursor))
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function decodeCursor(raw: string, sort: 'date' | 'activity'): Cursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(raw))
  } catch {
    throw new InvalidCursorError()
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidCursorError()
  }
  const value = parsed as Record<string, unknown>
  if (value.s !== sort) throw new InvalidCursorError()
  if (!isString(value.c) || !isString(value.id)) throw new InvalidCursorError()
  if (sort === 'date') return { s: 'date', c: value.c, id: value.id }
  if (!isString(value.a)) throw new InvalidCursorError()
  return { s: 'activity', a: value.a, c: value.c, id: value.id }
}

function scopeClause(scope: ListScope): { sql: string; binds: unknown[] } {
  return scope.kind === 'project'
    ? { sql: 'project_id = ?', binds: [scope.projectId] }
    : {
        sql: 'owner_email = ? AND project_id IS NULL',
        binds: [scope.email],
      }
}

function keysetClause(cursor: Cursor): { sql: string; binds: unknown[] } {
  if (cursor.s === 'date') {
    return {
      sql: ' AND (created_at < ? OR (created_at = ? AND id < ?))',
      binds: [cursor.c, cursor.c, cursor.id],
    }
  }
  return {
    sql:
      ` AND (${ACTIVITY_KEY} < ? OR (${ACTIVITY_KEY} = ? AND ` +
      '(created_at < ? OR (created_at = ? AND id < ?))))',
    binds: [cursor.a, cursor.a, cursor.c, cursor.c, cursor.id],
  }
}

export function buildListenersPageQuery(
  scope: ListScope,
  sort: SortMode,
  cursor: string | undefined,
  limit: number,
): { sql: string; binds: unknown[]; fetchSize: number } {
  const where = scopeClause(scope)

  if (sort === 'name' || sort === 'custom') {
    // Not paginated: a cursor, if sent, is ignored.
    return {
      sql: `SELECT ${SELECT_COLUMNS} FROM listeners WHERE ${where.sql} ORDER BY ${UNPAGED_ORDER[sort]} LIMIT ?`,
      binds: [...where.binds, UNPAGED_CAP + 1],
      fetchSize: UNPAGED_CAP + 1,
    }
  }

  const keyset =
    cursor === undefined
      ? { sql: '', binds: [] as unknown[] }
      : keysetClause(decodeCursor(cursor, sort))
  const order =
    sort === 'date'
      ? 'created_at DESC, id DESC'
      : `${ACTIVITY_KEY} DESC, created_at DESC, id DESC`
  return {
    sql: `SELECT ${SELECT_COLUMNS} FROM listeners WHERE ${where.sql}${keyset.sql} ORDER BY ${order} LIMIT ?`,
    binds: [...where.binds, ...keyset.binds, limit + 1],
    fetchSize: limit + 1,
  }
}

function cursorFor(sort: 'date' | 'activity', row: ListenerRecord): string {
  return encodeCursor(
    sort === 'date'
      ? { s: 'date', c: row.createdAt, id: row.id }
      : {
          s: 'activity',
          a: row.lastRequestAt ?? '',
          c: row.createdAt,
          id: row.id,
        },
  )
}

export async function getListenersPage(
  db: Env['DB'],
  scope: ListScope,
  sort: SortMode,
  options: { cursor?: string; limit: number },
): Promise<ListenersPage> {
  const { sql, binds } = buildListenersPageQuery(
    scope,
    sort,
    options.cursor,
    options.limit,
  )
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ListenerRecord>()

  if (sort === 'name' || sort === 'custom') {
    return {
      listeners: results.slice(0, UNPAGED_CAP),
      nextCursor: null,
      truncated: results.length > UNPAGED_CAP,
    }
  }

  const more = results.length > options.limit
  const listeners = results.slice(0, options.limit)
  const last = listeners[listeners.length - 1]
  return {
    listeners,
    nextCursor: more && last ? cursorFor(sort, last) : null,
    truncated: false,
  }
}
