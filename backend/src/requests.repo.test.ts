import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from './db'
import { createListener } from './listeners.repo'
import { insertRequest, getRequests } from './requests.repo'

describe('requests repo', () => {
  let db: Db
  const listenerId = 'listener-1'

  beforeEach(() => {
    db = createDb(':memory:')
    createListener(db, listenerId, '2024-01-01T00:00:00.000Z')
  })

  it('stores and retrieves requests newest first', () => {
    insertRequest(db, {
      listenerId,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'first',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:01.000Z',
    })
    insertRequest(db, {
      listenerId,
      method: 'POST',
      headers: '{}',
      queryParams: '{}',
      body: 'second',
      contentType: 'text/plain',
      sourceIp: '127.0.0.1',
      receivedAt: '2024-01-01T00:00:02.000Z',
    })

    const requests = getRequests(db, listenerId)
    expect(requests.map((r) => r.body)).toEqual(['second', 'first'])
  })

  it('prunes older requests beyond the 200-row retention cap', () => {
    for (let i = 0; i < 205; i++) {
      insertRequest(db, {
        listenerId,
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

    const requests = getRequests(db, listenerId)
    expect(requests).toHaveLength(200)
    expect(requests[0].body).toBe('request-204')
    expect(requests[requests.length - 1].body).toBe('request-5')
  })
})
