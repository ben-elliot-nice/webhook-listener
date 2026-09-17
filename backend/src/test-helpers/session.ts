export function cookieHeader(cookies?: Record<string, string>): Record<string, string> {
  if (!cookies) return {}
  return {
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; '),
  }
}

export function extractSessionId(response: Response): string {
  const setCookies = response.headers.getSetCookie()
  const match = setCookies.find((c) => c.startsWith('wl_session_id='))
  if (!match) {
    throw new Error('no wl_session_id cookie found in response')
  }
  return match.split(';')[0].split('=')[1]
}
