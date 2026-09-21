ALTER TABLE projects ADD COLUMN label TEXT;
ALTER TABLE projects ADD COLUMN share_token TEXT;

CREATE UNIQUE INDEX idx_projects_share_token
  ON projects(share_token)
  WHERE share_token IS NOT NULL;
