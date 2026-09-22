ALTER TABLE listeners ADD COLUMN owner_email TEXT;

-- projects.owner_session is currently NOT NULL (0005_projects.sql). Merged
-- rows need it set to NULL, so the constraint must be relaxed. SQLite/D1
-- has no ALTER COLUMN for constraints, so this uses the standard rebuild
-- recipe instead of a plain ALTER TABLE. The new table is built under a
-- temporary name and the OLD "projects" table is DROPPED (never RENAMED)
-- so that listeners.project_id's `REFERENCES projects(id)` text is never
-- auto-rewritten by SQLite's rename-fixup (which would otherwise leave it
-- permanently dangling at "projects_old" once that table is dropped).
CREATE TABLE projects_new (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  owner_session TEXT,
  owner_email TEXT,
  sort_position INTEGER,
  label TEXT,
  share_token TEXT
);

INSERT INTO projects_new (id, created_at, owner_session, owner_email, sort_position, label, share_token)
  SELECT id, created_at, owner_session, NULL, sort_position, label, share_token FROM projects;

DROP TABLE projects;

ALTER TABLE projects_new RENAME TO projects;

CREATE UNIQUE INDEX idx_projects_share_token
  ON projects(share_token)
  WHERE share_token IS NOT NULL;
