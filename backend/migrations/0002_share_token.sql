ALTER TABLE listeners ADD COLUMN share_token TEXT;

CREATE UNIQUE INDEX idx_share_token
  ON listeners(share_token)
  WHERE share_token IS NOT NULL;
