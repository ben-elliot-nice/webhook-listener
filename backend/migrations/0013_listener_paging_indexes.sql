-- Keyset pagination for listener lists (design: 2026-10-15-paginate-listener-lists).
-- Standalone listeners for Home: seek on (owner_email, project_id IS NULL) instead
-- of scanning every one of an owner's rows.
CREATE INDEX idx_listeners_owner_standalone
  ON listeners(owner_email, project_id, created_at DESC, id DESC);

-- Recent-activity pages for a project; the expression must match the query text
-- exactly. '' sorts below every ISO timestamp, so never-active rows come last.
CREATE INDEX idx_listeners_project_activity
  ON listeners(project_id, COALESCE(last_request_at, '') DESC, created_at DESC, id DESC);
