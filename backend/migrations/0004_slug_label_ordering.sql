ALTER TABLE listeners ADD COLUMN slug TEXT;
ALTER TABLE listeners ADD COLUMN webhook_token TEXT;
ALTER TABLE listeners ADD COLUMN label TEXT;
ALTER TABLE listeners ADD COLUMN last_request_at TEXT;
ALTER TABLE listeners ADD COLUMN sort_position INTEGER;

CREATE UNIQUE INDEX idx_listeners_slug
  ON listeners(slug)
  WHERE slug IS NOT NULL;
