import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { createListener, getListener } from './listeners.repo'
import { insertRequest, getRequests, getRequestsPage, getRequestById } from './requests.repo'

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

describe('requests repo pagination', () => {
  const listenerId = 'listener-page'

  it('returns the newest `limit` rows and a nextCursor when more remain', async () => {
    await createListener(env.DB, listenerId, '2024-01-01T00:00:00.000Z', 'session-a')
    for (let i = 0; i < 5; i++) {
      await insertRequest(env.DB, {
        listenerId,
        method: 'POST',
        headers: '{}',
        queryParams: '{}',
        body: `request-${i}`,
        contentType: 'text/plain',
        sourceIp: '127.0.0.1',
        receivedAt: `2024-01-01T00:00:0${i}.000Z`,
      })
    }

    const page = await getRequestsPage(env.DB, listenerId, { limit: 3 })
    expect(page.requests.map((r) => r.body)).toEqual(['request-4', 'request-3', 'request-2'])
    expect(page.nextCursor).toBe(page.requests[2].id)
  })

  it('returns the next page using `before`, and nextCursor null once exhausted', async () => {
    const pagedListenerId = 'listener-page-2'
    await createListener(env.DB, pagedListenerId, '2024-01-01T00:00:00.000Z', 'session-a')
    for (let i = 0; i < 5; i++) {
      await insertRequest(env.DB, {
        listenerId: pagedListenerId,
        method: 'POST',
        headers: '{}',
        queryParams: '{}',
        body: `request-${i}`,
        contentType: 'text/plain',
        sourceIp: '127.0.0.1',
        receivedAt: `2024-01-01T00:00:0${i}.000Z`,
      })
    }

    const firstPage = await getRequestsPage(env.DB, pagedListenerId, { limit: 3 })
    const secondPage = await getRequestsPage(env.DB, pagedListenerId, {
      limit: 3,
      before: firstPage.nextCursor ?? undefined,
    })
    expect(secondPage.requests.map((r) => r.body)).toEqual(['request-1', 'request-0'])
    expect(secondPage.nextCursor).toBeNull()
  })

  it('returns an empty page with nextCursor null for a listener with no requests', async () => {
    await createListener(env.DB, 'listener-empty-page', '2024-01-01T00:00:00.000Z', 'session-a')
    const page = await getRequestsPage(env.DB, 'listener-empty-page', { limit: 20 })
    expect(page.requests).toEqual([])
    expect(page.nextCursor).toBeNull()
  })
})

describe('getRequestById', () => {
  it('returns the row for a known id scoped to its listener', async () => {
    const listenerId = 'listener-detail'
    await createListener(env.DB, listenerId, '2024-01-01T00:00:00.000Z', 'session-a')
    await insertRequest(env.DB, {
      listenerId,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'the-body',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:00.000Z',
    })
    const [row] = (await getRequestsPage(env.DB, listenerId, { limit: 1 })).requests
    const found = await getRequestById(env.DB, listenerId, row.id)
    expect(found?.body).toBe('the-body')
  })

  it('returns undefined for an id that belongs to a different listener', async () => {
    const listenerA = 'listener-detail-a'
    const listenerB = 'listener-detail-b'
    await createListener(env.DB, listenerA, '2024-01-01T00:00:00.000Z', 'session-a')
    await createListener(env.DB, listenerB, '2024-01-01T00:00:00.000Z', 'session-a')
    await insertRequest(env.DB, {
      listenerId: listenerA,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'a-body',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:00.000Z',
    })
    const [row] = (await getRequestsPage(env.DB, listenerA, { limit: 1 })).requests
    const found = await getRequestById(env.DB, listenerB, row.id)
    expect(found).toBeUndefined()
  })
})
