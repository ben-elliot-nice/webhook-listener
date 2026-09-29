import type { Env } from './env'

export interface RequestRecord {
  id: number
  listenerId: string
  method: string
  headers: string
  queryParams: string
  body: string | null
  contentType: string | null
  sourceIp: string | null
  receivedAt: string
}

export type NewRequest = Omit<RequestRecord, 'id'>

const RETENTION_LIMIT = 200

export async function insertRequest(
  db: Env['DB'],
  req: NewRequest,
): Promise<void> {
  const insert = db
    .prepare(
      `INSERT INTO requests
        (listener_id, method, headers, query_params, body, content_type, source_ip, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      req.listenerId,
      req.method,
      req.headers,
      req.queryParams,
      req.body,
      req.contentType,
      req.sourceIp,
      req.receivedAt,
    )

  const prune = db
    .prepare(
      `DELETE FROM requests
       WHERE listener_id = ?
         AND id NOT IN (
           SELECT id FROM requests
           WHERE listener_id = ?
           ORDER BY received_at DESC, id DESC
           LIMIT ?
         )`,
    )
    .bind(req.listenerId, req.listenerId, RETENTION_LIMIT)

  const touchListener = db
    .prepare('UPDATE listeners SET last_request_at = ? WHERE id = ?')
    .bind(req.receivedAt, req.listenerId)

  // D1's batch() runs both statements as one atomic unit — the replacement
  // for better-sqlite3's synchronous db.transaction() closure.
  await db.batch([insert, prune, touchListener])
}

export interface RequestsPage {
  requests: RequestRecord[]
  nextCursor: number | null
}

const SELECT_COLUMNS = `
  id,
  listener_id AS listenerId,
  method,
  headers,
  query_params AS queryParams,
  body,
  content_type AS contentType,
  source_ip AS sourceIp,
  received_at AS receivedAt
`

export async function getRequests(
  db: Env['DB'],
  listenerId: string,
): Promise<RequestRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
      FROM requests
      WHERE listener_id = ?
      ORDER BY received_at DESC, id DESC
      LIMIT ?`,
    )
    .bind(listenerId, RETENTION_LIMIT)
    .all<RequestRecord>()
  return results
}

export async function getRequestsPage(
  db: Env['DB'],
  listenerId: string,
  options: { limit: number; before?: number },
): Promise<RequestsPage> {
  const before = options.before ?? null
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
      FROM requests
      WHERE listener_id = ?
        AND (?2 IS NULL OR id < ?2)
      ORDER BY received_at DESC, id DESC
      LIMIT ?3`,
    )
    .bind(listenerId, before, options.limit)
    .all<RequestRecord>()

  const nextCursor =
    results.length === options.limit ? results[results.length - 1].id : null
  return { requests: results, nextCursor }
}

export async function getRequestById(
  db: Env['DB'],
  listenerId: string,
  requestId: number,
): Promise<RequestRecord | undefined> {
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM requests WHERE listener_id = ? AND id = ?`,
    )
    .bind(listenerId, requestId)
    .first<RequestRecord>()
  return row ?? undefined
}
