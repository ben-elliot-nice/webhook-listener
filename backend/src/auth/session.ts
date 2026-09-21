function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return new Uint8Array(signature)
}

interface EmailSessionPayload {
  email: string
  expiresAt: string
}

export async function signEmailSession(secret: string, email: string, expiresAt: string): Promise<string> {
  const payload: EmailSessionPayload = { email, expiresAt }
  const payloadEncoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const signatureEncoded = base64UrlEncode(await hmacSha256(secret, payloadEncoded))
  return `${payloadEncoded}.${signatureEncoded}`
}

export async function verifyEmailSession(secret: string, cookieValue: string): Promise<string | null> {
  const parts = cookieValue.split('.')
  if (parts.length !== 2) return null
  const [payloadEncoded, signatureEncoded] = parts

  const expectedSignature = base64UrlEncode(await hmacSha256(secret, payloadEncoded))
  if (expectedSignature !== signatureEncoded) return null

  let payload: EmailSessionPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadEncoded)))
  } catch {
    return null
  }

  if (typeof payload.email !== 'string' || typeof payload.expiresAt !== 'string') return null
  if (new Date(payload.expiresAt).getTime() < Date.now()) return null

  return payload.email
}
