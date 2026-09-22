import { useEffect, useState } from 'react'
import { getMe, requestMagicLink, ApiError } from '../api'

type GateState = 'checking' | 'authenticated' | 'unauthenticated'

function useAuthError(): string | null {
  const params = new URLSearchParams(window.location.search)
  const authError = params.get('authError')
  useEffect(() => {
    if (authError) {
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
      await requestMagicLink(email)
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
        {authError && (
          <p className="text-sm text-red-600">That link is invalid or expired. Request a new one below.</p>
        )}
        {submitted ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">Check your email for a sign-in link.</p>
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
