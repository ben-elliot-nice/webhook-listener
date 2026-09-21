import { describe, it, expect, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { sendMagicLinkEmail } from './email'

describe('sendMagicLinkEmail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs to the Resend API with the expected shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await sendMagicLinkEmail(env, 'person@nice.com', 'https://webhook-api.fde.nice-agentic.com/auth/verify?token=abc')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${env.RESEND_API_KEY}` }),
      })
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.to).toBe('person@nice.com')
    expect(body.from).toBe('noreply@fde.nice-agentic.com')
    expect(body.html).toContain('https://webhook-api.fde.nice-agentic.com/auth/verify?token=abc')
  })

  it('throws when Resend responds with a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))

    await expect(sendMagicLinkEmail(env, 'person@nice.com', 'https://example.com/verify')).rejects.toThrow()
  })
})
