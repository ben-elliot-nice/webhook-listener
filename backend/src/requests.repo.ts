import type { Db } from './db'

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

export function insertRequest(db: Db, req: NewRequest): void {
  const insert = db.prepare(`
    INSERT INTO requests
      (listener_id, method, headers, query_params, body, content_type, source_ip, received_at)
    VALUES (@listenerId, @method, @headers, @queryParams, @body, @contentType, @sourceIp, @receivedAt)
  `)
  const prune = db.prepare(`
    DELETE FROM requests
    WHERE listener_id = ?
      AND id NOT IN (
        SELECT id FROM requests
        WHERE listener_id = ?
        ORDER BY received_at DESC, id DESC
        LIMIT ?
      )
  `)
  const tx = db.transaction((r: NewRequest) => {
    insert.run(r)
    prune.run(r.listenerId, r.listenerId, RETENTION_LIMIT)
  })
  tx(req)
}

export function getRequests(db: Db, listenerId: string): RequestRecord[] {
  return db
    .prepare(
      `
      SELECT
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
      LIMIT ?
    `
    )
    .all(listenerId, RETENTION_LIMIT) as RequestRecord[]
}
