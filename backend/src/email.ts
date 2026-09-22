import type { Env } from './env'

export async function sendMagicLinkEmail(env: Env, email: string, verifyUrl: string): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: 'noreply@nice-agentic.com',
      to: email,
      subject: 'Sign in to webhook-listener',
      html: `<p>Click the link below to sign in. This link expires in 15 minutes.</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
    }),
  })

  if (!response.ok) {
    throw new Error(`Resend request failed with status ${response.status}`)
  }
}
