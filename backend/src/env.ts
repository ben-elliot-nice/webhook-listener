export interface Env {
  DB: D1Database
  HOOK_BASE_URL: string
  APP_BASE_URL: string
  /**
   * Domain attribute for the wl_session_id cookie. Set to
   * "fde.nice-agentic.com" in production so the cookie is shared between
   * the webhook-api and webhook Workers. Must be omitted (or empty) for
   * local dev (wrangler dev on localhost) — a Domain attribute that
   * doesn't match the request's actual host causes browsers to silently
   * discard the Set-Cookie header, breaking sessions entirely.
   */
  SESSION_COOKIE_DOMAIN?: string
}
