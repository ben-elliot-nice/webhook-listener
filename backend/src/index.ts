// Placeholder Workers entrypoint. The Fastify server previously here cannot run in the
// Workers runtime (no default export, no `fetch` handler, relies on Node's http.Server).
// Task 4 of the Cloudflare Workers migration plan replaces this file with the real Hono
// app export (`export { app } from './app'`). Until then, this minimal fetch handler lets
// `wrangler dev` / vitest-pool-workers boot the worker runtime so the D1 migration test
// harness (this task's deliverable) can run.
export default {
  async fetch(): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  },
}
