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
const PRUNE_PROBABILITY = 1 / 10

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

  // Prune on ~1 in 10 captures, chosen at random per capture in JS (not in
  // SQL). The other ~90% of captures skip the DELETE entirely, so they scan no
  // index rows (a SQL-side guard such as `last_insert_rowid() % N` still scans
  // the listener's index entries, and request ids are global across listeners,
  // so id % N is deterministic per listener and can starve one of ever
  // pruning). Random selection makes retention converge for every listener
  // regardless of id patterns. A listener can briefly exceed RETENTION_LIMIT
  // (expected overshoot ~9 rows; unbounded in theory but geometrically
  // unlikely). Read paths (getRequests) still cap at RETENTION_LIMIT, but
  // getRequestsPage does not cap, so the overshoot is visible there. This
  // replaced a per-capture prune that was ~18% of D1 rows read.
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

  // D1's batch() runs the statements as one atomic unit — the replacement
  // for better-sqlite3's synchronous db.transaction() closure.
  await db.batch(
    Math.random() < PRUNE_PROBABILITY
      ? [insert, prune, touchListener]
      : [insert, touchListener],
  )
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
