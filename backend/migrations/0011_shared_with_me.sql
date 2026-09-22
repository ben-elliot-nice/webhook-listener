CREATE TABLE shared_with_me (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  viewer_email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('listener', 'project')),
  token TEXT NOT NULL,
  first_visited_at TEXT NOT NULL,
  last_visited_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE(viewer_email, kind, token)
);

CREATE INDEX idx_shared_with_me_viewer ON shared_with_me(viewer_email);
