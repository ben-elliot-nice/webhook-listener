import { describe, it, expect } from 'vitest'
import { signEmailSession, verifyEmailSession } from './session'

const SECRET = 'test-secret'

describe('signEmailSession / verifyEmailSession', () => {
  it('round-trips a valid, unexpired session', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const cookieValue = await signEmailSession(SECRET, 'person@nice.com', expiresAt)
    const result = await verifyEmailSession(SECRET, cookieValue)
    expect(result).toBe('person@nice.com')
  })

  it('rejects a tampered payload (flipped byte)', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const cookieValue = await signEmailSession(SECRET, 'person@nice.com', expiresAt)
    const [payload, signature] = cookieValue.split('.')
    const tamperedPayload = payload.slice(0, -1) + (payload.at(-1) === 'A' ? 'B' : 'A')
    const result = await verifyEmailSession(SECRET, `${tamperedPayload}.${signature}`)
    expect(result).toBeNull()
  })

  it('rejects a signature produced with a different secret', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const cookieValue = await signEmailSession('other-secret', 'person@nice.com', expiresAt)
    const result = await verifyEmailSession(SECRET, cookieValue)
    expect(result).toBeNull()
  })

  it('rejects an expired session', async () => {
    const expiresAt = new Date(Date.now() - 1000).toISOString()
    const cookieValue = await signEmailSession(SECRET, 'person@nice.com', expiresAt)
    const result = await verifyEmailSession(SECRET, cookieValue)
    expect(result).toBeNull()
  })

  it('rejects a malformed cookie value', async () => {
    const result = await verifyEmailSession(SECRET, 'not-a-valid-cookie-value')
    expect(result).toBeNull()
  })

  it('returns null (does not throw) when the signature segment contains invalid base64url characters', async () => {
    const result = await verifyEmailSession(SECRET, 'somepayload.!!!invalid-base64-chars!!!')
    expect(result).toBeNull()
  })
})
