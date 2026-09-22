import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { hasPendingMagicLink, createMagicLink, consumeMagicLink } from './magic-links.repo'
import { hashToken } from './auth/tokens'

describe('magic-links.repo', () => {
  it('hasPendingMagicLink is false when none exist for the email', async () => {
    const result = await hasPendingMagicLink(env.DB, 'nobody@nice.com')
    expect(result).toBe(false)
  })

  it('hasPendingMagicLink is true for an unexpired, unused link', async () => {
    const email = 'pending@nice.com'
    const tokenHash = await hashToken('raw-token-1')
    const now = new Date()
    await createMagicLink(env.DB, email, tokenHash, now.toISOString(), new Date(now.getTime() + 60_000).toISOString())
    expect(await hasPendingMagicLink(env.DB, email)).toBe(true)
  })

  it('hasPendingMagicLink is false once the link is expired', async () => {
    const email = 'expired@nice.com'
    const tokenHash = await hashToken('raw-token-2')
    const now = new Date()
    await createMagicLink(env.DB, email, tokenHash, now.toISOString(), new Date(now.getTime() - 1000).toISOString())
    expect(await hasPendingMagicLink(env.DB, email)).toBe(false)
  })

  it('consumeMagicLink returns the email and marks the link used', async () => {
    const email = 'consume@nice.com'
    const tokenHash = await hashToken('raw-token-3')
    const now = new Date()
    await createMagicLink(env.DB, email, tokenHash, now.toISOString(), new Date(now.getTime() + 60_000).toISOString())

    const result = await consumeMagicLink(env.DB, tokenHash)
    expect(result).toEqual({ email })
  })

  it('consumeMagicLink is single-use — a second call for the same token fails', async () => {
    const email = 'single-use@nice.com'
    const tokenHash = await hashToken('raw-token-4')
    const now = new Date()
    await createMagicLink(env.DB, email, tokenHash, now.toISOString(), new Date(now.getTime() + 60_000).toISOString())

    await consumeMagicLink(env.DB, tokenHash)
    const second = await consumeMagicLink(env.DB, tokenHash)
    expect(second).toBeUndefined()
  })

  it('consumeMagicLink returns undefined for an expired token', async () => {
    const tokenHash = await hashToken('raw-token-5')
    const now = new Date()
    await createMagicLink(env.DB, 'expired2@nice.com', tokenHash, now.toISOString(), new Date(now.getTime() - 1000).toISOString())

    const result = await consumeMagicLink(env.DB, tokenHash)
    expect(result).toBeUndefined()
  })

  it('consumeMagicLink returns undefined for an unknown token', async () => {
    const result = await consumeMagicLink(env.DB, await hashToken('never-created'))
    expect(result).toBeUndefined()
  })
})
