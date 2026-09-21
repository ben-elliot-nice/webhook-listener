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

  it('reorders listeners and is reflected in ?sort=custom', async () => {
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({
          orderedItems: [
            { type: 'listener', id: secondId },
            { type: 'listener', id: firstId },
          ],
        }),
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

  it('reorders a mix of listeners and projects together', async () => {
    const projectResponse = await app.request(
      '/api/projects',
      { method: 'POST', headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const projectId = ((await projectResponse.json()) as { id: string }).id

    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({
          orderedItems: [
            { type: 'project', id: projectId },
            { type: 'listener', id: firstId },
            { type: 'listener', id: secondId },
          ],
        }),
      },
      env
    )
    expect(response.status).toBe(204)

    const listResponse = await app.request(
      '/api/listeners?sort=custom',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const listBody = (await listResponse.json()) as { id: string }[]
    expect(listBody.map((l) => l.id)).toEqual([firstId, secondId])

    const projectsResponse = await app.request(
      '/api/projects',
      { headers: cookieHeader({ wl_session_id: sessionId }) },
      env
    )
    const projectsBody = (await projectsResponse.json()) as { id: string; sortPosition: number }[]
    expect(projectsBody[0]).toMatchObject({ id: projectId, sortPosition: 0 })
  })

  it('returns 400 for a listener id belonging to another session', async () => {
    const other = await app.request('/api/listeners', { method: 'POST' }, env)
    const otherId = ((await other.json()) as { id: string }).id
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({
          orderedItems: [
            { type: 'listener', id: firstId },
            { type: 'listener', id: otherId },
          ],
        }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 for a project id belonging to another session', async () => {
    const otherProject = await app.request('/api/projects', { method: 'POST' }, env)
    const otherProjectId = ((await otherProject.json()) as { id: string }).id
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({
          orderedItems: [
            { type: 'listener', id: firstId },
            { type: 'project', id: otherProjectId },
          ],
        }),
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
        body: JSON.stringify({ orderedItems: 'not-an-array' }),
      },
      env
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 for an item missing a valid type', async () => {
    const response = await app.request(
      '/api/listeners/reorder',
      {
        method: 'POST',
        headers: { ...cookieHeader({ wl_session_id: sessionId }), 'content-type': 'application/json' },
        body: JSON.stringify({ orderedItems: [{ type: 'bogus', id: firstId }] }),
      },
      env
    )
    expect(response.status).toBe(400)
  })
})
