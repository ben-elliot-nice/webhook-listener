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

export function createDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
