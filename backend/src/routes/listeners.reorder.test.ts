import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { cookieHeader, extractSessionId } from '../test-helpers/session'

describe('POST /api/listeners/reorder', () => {
  let sessionId: string
  let firstId: string
  let secondId: string

  beforeEach(async () => {
    const first = await app.request('/api/listeners', { method: 'POST' }, env)
    sessionId = extractSessionId(first)
    firstId = ((await first.json()) as { id: string }).id
    const second = await app.request(
      '/api/listeners',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    secondId = ((await second.json()) as { id: string }).id
  })

  it('reorders and is reflected in ?sort=custom', async () => {
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ orderedIds: [secondId, firstId] }),
      },
      env
    )
    expect(response.status).toBe(204)

    const listResponse = await app.request(
      '/api/listeners?sort=custom',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const body = (await listResponse.json()) as { id: string }[]
    expect(body.map((l) => l.id)).toEqual([secondId, firstId])
  })

  it('returns 400 for an id belonging to another session', async () => {
    const other = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherId = ((await other.json()) as { id: string }).id
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ orderedIds: [firstId, otherId] }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 for a malformed body', async () => {
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ orderedIds: 'not-an-array' }),
      },
      env
    )
    expect(response.status).toBe(400)
  })
})
