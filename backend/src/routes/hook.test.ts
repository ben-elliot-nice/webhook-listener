import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../app'
import { createListener } from '../listeners.repo'
import { getRequests } from '../requests.repo'

describe('hook capture route', () => {
  const listenerId = 'hook-test-listener'

  beforeEach(async () => {
    await createListener(env.DB, listenerId, '2024-01-01T00:00:00.000Z', 'session-a')
  })

  it('captures a POST payload and returns 200', async () => {
    const response = await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      },
      env
    )
    expect(response.status).toBe(200)

    const [captured] = await getRequests(env.DB, listenerId)
    expect(captured.method).toBe('POST')
    expect(captured.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect(captured.contentType).toBe('application/json')
  })

  it('captures query params and headers', async () => {
    await app.request(
      `/hook/${listenerId}?foo=bar`,
      { method: 'GET', headers: { 'x-custom-header': 'value' } },
      env
    )

    const [captured] = await getRequests(env.DB, listenerId)
    expect(JSON.parse(captured.queryParams)).toEqual({ foo: 'bar' })
    expect(JSON.parse(captured.headers)['x-custom-header']).toBe('value')
  })

  it('returns 404 for an unknown listener', async () => {
    const response = await app.request('/hook/does-not-exist', { method: 'POST' }, env)
    expect(response.status).toBe(404)
  })

  it('redacts the cookie header from captured requests', async () => {
    await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'session_id=some-secret-value' },
        body: JSON.stringify({ foo: 'bar' }),
      },
      env
    )

    const [captured] = await getRequests(env.DB, listenerId)
    const headers = JSON.parse(captured.headers)
    expect(headers.cookie).toBeUndefined()
    expect(captured.headers).not.toContain('some-secret-value')
  })

  it('rejects a payload over the 10MB cap with 413', async () => {
    const response = await app.request(
      `/hook/${listenerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(11 * 1024 * 1024) },
      },
      env
    )
    expect(response.status).toBe(413)
  })
})
