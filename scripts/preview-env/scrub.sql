-- Scrubs a copy of production data before it's exposed in a PR preview
-- environment. Every sensitive column in the schema is listed here
-- explicitly — there is no schema introspection. Whenever a migration
-- adds a table or column holding a token, email, IP address, or captured
-- payload content, THIS FILE MUST BE UPDATED in the same PR.
--
-- Mirrored (duplicated, not imported) in backend/src/preview-scrub.test.ts
-- because backend tests run inside a workerd sandbox with no confirmed
-- filesystem access — keep both in sync by hand.
--
-- Deliberately NOT scrubbed: listeners.owner_email / projects.owner_email.
-- The email access gate already requires proving ownership of a real
-- inbox via a magic link before anyone can sign in as that email, so
-- preserving the ownership link doesn't reopen an impersonation path —
-- it lets whoever reviews a PR sign in as themselves and see their own
-- existing (hook-content-scrubbed) listeners/projects, instead of an
-- empty account. See CLAUDE.md's "PR preview environments" section.

UPDATE requests SET
  headers = '{}',
  query_params = '{}',
  body = NULL,
  source_ip = NULL;

UPDATE listeners SET
  share_token = CASE WHEN share_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
  webhook_token = CASE WHEN webhook_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
  owner_session = NULL;

UPDATE projects SET
  share_token = CASE WHEN share_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
  owner_session = NULL;

DELETE FROM magic_links;

UPDATE shared_with_me SET
  viewer_email = 'scrubbed-' || id || '@example.invalid',
  token = hex(randomblob(16));
