import { describe, it, expect } from 'vitest'
import { hashToken } from './tokens'

describe('hashToken', () => {
  it('returns a 64-character hex string', async () => {
    const result = await hashToken('some-raw-token')
    expect(result).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', async () => {
    const a = await hashToken('same-input')
    const b = await hashToken('same-input')
    expect(a).toBe(b)
  })

  it('produces different hashes for different inputs', async () => {
    const a = await hashToken('input-a')
    const b = await hashToken('input-b')
    expect(a).not.toBe(b)
  })
})
