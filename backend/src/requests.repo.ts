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

export async function insertRequest(db: Env['DB'], req: NewRequest): Promise<void> {
  const insert = db
    .prepare(
      `INSERT INTO requests
        (listener_id, method, headers, query_params, body, content_type, source_ip, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      req.listenerId,
      req.method,
      req.headers,
      req.queryParams,
      req.body,
      req.contentType,
      req.sourceIp,
      req.receivedAt
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
         )`
    )
    .bind(req.listenerId, req.listenerId, RETENTION_LIMIT)

  // D1's batch() runs both statements as one atomic unit — the replacement
  // for better-sqlite3's synchronous db.transaction() closure.
  await db.batch([insert, prune])
}

export async function getRequests(db: Env['DB'], listenerId: string): Promise<RequestRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT
        id,
        listener_id AS listenerId,
        method,
        headers,
        query_params AS queryParams,
        body,
        content_type AS contentType,
        source_ip AS sourceIp,
        received_at AS receivedAt
      FROM requests
      WHERE listener_id = ?
      ORDER BY received_at DESC, id DESC
      LIMIT ?`
    )
    .bind(listenerId, RETENTION_LIMIT)
    .all<RequestRecord>()
  return results
}
