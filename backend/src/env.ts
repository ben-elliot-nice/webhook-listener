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
  /** Comma-separated list of email domains allowed to request/use a magic link. */
  ALLOWED_EMAIL_DOMAINS: string
  /** HMAC key for signing the wl_email_session cookie. Wrangler secret in production. */
  WL_SESSION_SECRET: string
  /** Resend API key used to send magic-link emails. Wrangler secret in production. */
  RESEND_API_KEY: string
}
