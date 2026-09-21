CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  owner_session TEXT NOT NULL
);

ALTER TABLE listeners ADD COLUMN project_id TEXT REFERENCES projects(id);

DROP INDEX idx_listeners_slug;

CREATE UNIQUE INDEX idx_listeners_slug_global
  ON listeners(slug)
  WHERE slug IS NOT NULL AND project_id IS NULL;

CREATE UNIQUE INDEX idx_listeners_slug_project
  ON listeners(project_id, slug)
  WHERE slug IS NOT NULL AND project_id IS NOT NULL;
