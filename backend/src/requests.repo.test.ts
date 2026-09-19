import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createListener, getListener } from './listeners.repo'
import { insertRequest, getRequests } from './requests.repo'

describe('requests repo', () => {
  const listenerId = 'listener-1'

  it('stores and retrieves requests newest first', async () => {
    await createListener(env.DB, listenerId, '2024-01-01T00:00:00.000Z', 'session-a')
    await insertRequest(env.DB, {
      listenerId,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'first',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:01.000Z',
    })
    await insertRequest(env.DB, {
      listenerId,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'second',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:02.000Z',
    })

    const requests = await getRequests(env.DB, listenerId)
    expect(requests.map((r) => r.body)).toEqual(['second', 'first'])
  })

  it('prunes older requests beyond the 200-row retention cap', async () => {
    const pruneListenerId = 'listener-prune'
    await createListener(env.DB, pruneListenerId, '2024-01-01T00:00:00.000Z', 'session-a')

    for (let i = 0; i < 205; i++) {
      await insertRequest(env.DB, {
        listenerId: pruneListenerId,
        method: 'POST',
        headers: '{}',
        queryParams: '{}',
        body: `request-${i}`,
        contentType: 'text/plain',
        sourceIp: '127.0.0.1',
        receivedAt: `2024-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(
          i % 60
        ).padStart(2, '0')}.000Z`,
      })
    }

    const requests = await getRequests(env.DB, pruneListenerId)
    expect(requests).toHaveLength(200)
    expect(requests[0].body).toBe('request-204')
    expect(requests[requests.length - 1].body).toBe('request-5')
  })

  it('updates the listener\'s last_request_at on insert', async () => {
    await createListener(env.DB, 'activity-listener', '2024-01-01T00:00:00.000Z', 'session-a')
    await insertRequest(env.DB, {
      listenerId: 'activity-listener',
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: null,
      contentType: null,
      sourceIp: null,
      receivedAt: '2024-06-01T00:00:00.000Z',
    })
    const listener = await getListener(env.DB, 'activity-listener')
    expect(listener?.lastRequestAt).toBe('2024-06-01T00:00:00.000Z')
  })
})
