import Database from 'better-sqlite3'

export type Db = Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listeners (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listener_id TEXT NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  headers TEXT NOT NULL,
  query_params TEXT NOT NULL,
  body TEXT,
  content_type TEXT,
  source_ip TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_listener_received
  ON requests(listener_id, received_at DESC);
`

function ensureShareTokenColumn(db: Db): void {
  const columns = db.pragma('table_info(listeners)') as { name: string }[]
  const hasShareToken = columns.some((c) => c.name === 'share_token')
  if (!hasShareToken) {
    db.exec('ALTER TABLE listeners ADD COLUMN share_token TEXT')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_share_token ON listeners(share_token) WHERE share_token IS NOT NULL')
  }
}

export function createDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  ensureShareTokenColumn(db)
  return db
}
