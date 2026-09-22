import { useEffect, useState } from 'react'
import { getMe, requestMagicLink, ApiError } from '../api'
import { Logo } from './Logo'

type GateState = 'checking' | 'authenticated' | 'unauthenticated'

// Captured once via useState's lazy initializer, not recomputed on every
// render. authError previously re-read window.location.search on every
// render, so once the cleanup effect below stripped it from the URL, any
// later render (e.g. when getMe() resolves and swaps state to
// 'unauthenticated' — the render that actually shows the error) would
// recompute authError as null, and the message would never appear.
function useAuthError(): string | null {
  const [authError] = useState(() => new URLSearchParams(window.location.search).get('authError'))
  useEffect(() => {
    if (authError) {
      const params = new URLSearchParams(window.location.search)
      params.delete('authError')
      const next = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${next ? `?${next}` : ''}`)
    }
  }, [authError])
  return authError
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('checking')
  const authError = useAuthError()
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [returnTo] = useState(() => window.location.pathname + window.location.search)

  useEffect(() => {
    getMe()
      .then(() => setState('authenticated'))
      .catch(() => setState('unauthenticated'))
  }, [])

  if (state === 'checking') {
    return null
  }

  if (state === 'authenticated') {
    return <>{children}</>
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await requestMagicLink(email, returnTo)
      setSubmitted(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError('That email domain is not allowed to sign in here.')
      } else if (err instanceof ApiError && err.status === 429) {
        setError('A link was already sent to this address — check your email.')
      } else {
        setError('Something went wrong. Try again.')
      }
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-4 p-6">
        <div className="flex flex-col items-center space-y-3 text-center">
          <Logo className="h-8" />
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Sign in to webhook-listener</h1>
        </div>
        {authError && (
          <p className="text-sm text-red-600">That link is invalid or expired. Request a new one below.</p>
        )}
        {submitted ? (
          <p className="text-center text-sm text-slate-600 dark:text-slate-300">Check your email for a sign-in link.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <label htmlFor="email" className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              Sign in with your email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
            >
              Send sign-in link
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
