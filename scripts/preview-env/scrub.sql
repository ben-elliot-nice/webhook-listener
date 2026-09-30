-- Scrubs a copy of production data before it's exposed in a PR preview
-- environment. Every sensitive column in the schema is listed here
-- explicitly — there is no schema introspection. Whenever a migration
-- adds a table or column holding a token, email, IP address, or captured
-- payload content, THIS FILE MUST BE UPDATED in the same PR.
--
-- Mirrored (duplicated, not imported) in backend/src/preview-scrub.test.ts
-- because backend tests run inside a workerd sandbox with no confirmed
-- filesystem access — keep both in sync by hand.

UPDATE requests SET
  headers = '{}',
  query_params = '{}',
  body = NULL,
  source_ip = NULL;

UPDATE listeners SET
  share_token = CASE WHEN share_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
  webhook_token = CASE WHEN webhook_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
  owner_session = NULL,
  owner_email = CASE WHEN owner_email IS NOT NULL THEN 'scrubbed-' || id || '@example.invalid' ELSE NULL END;

UPDATE projects SET
  share_token = CASE WHEN share_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
  owner_session = NULL,
  owner_email = CASE WHEN owner_email IS NOT NULL THEN 'scrubbed-' || id || '@example.invalid' ELSE NULL END;

DELETE FROM magic_links;

UPDATE shared_with_me SET
  viewer_email = 'scrubbed-' || id || '@example.invalid',
  token = hex(randomblob(16));
