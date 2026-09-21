ALTER TABLE listeners ADD COLUMN owner_email TEXT;

-- projects.owner_session is currently NOT NULL (0005_projects.sql). Merged
-- rows need it set to NULL, so the constraint must be relaxed. SQLite/D1
-- has no ALTER COLUMN for constraints, so this uses the standard rebuild
-- recipe instead of a plain ALTER TABLE.
ALTER TABLE projects RENAME TO projects_old;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  owner_session TEXT,
  owner_email TEXT,
  sort_position INTEGER,
  label TEXT,
  share_token TEXT
);

INSERT INTO projects (id, created_at, owner_session, owner_email, sort_position, label, share_token)
  SELECT id, created_at, owner_session, NULL, sort_position, label, share_token FROM projects_old;

DROP TABLE projects_old;

CREATE UNIQUE INDEX idx_projects_share_token
  ON projects(share_token)
  WHERE share_token IS NOT NULL;
