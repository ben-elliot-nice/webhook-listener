-- listeners.owner_email and listeners.project_id had no usable index, so
-- GET /api/listeners and the project/shared-project listener lookups did a
-- full table scan (D1 bills rows scanned, not rows returned).
CREATE INDEX idx_listeners_owner_email
  ON listeners(owner_email, created_at DESC, id DESC);

CREATE INDEX idx_listeners_project_id
  ON listeners(project_id, created_at DESC, id DESC);

CREATE INDEX idx_projects_owner_email
  ON projects(owner_email);
