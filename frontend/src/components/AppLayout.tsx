import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Logo } from './Logo'
import { SettingsModal } from './SettingsModal'
import { getMe, logout } from '../api'

export function AppLayout() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    getMe()
      .then((me) => setEmail(me.email))
      .catch(() => setEmail(null))
  }, [])

  async function handleSignOut() {
    try {
      await logout()
    } finally {
      window.location.reload()
    }
  }

  return (
    <div className="min-h-screen">
      <div className="flex items-center justify-between px-4 py-2">
        <Logo className="h-6" />
        <div className="flex items-center gap-3">
          {email && (
            <>
              <span className="text-sm text-slate-500 dark:text-slate-400">signed in as {email}</span>
              <button
                onClick={handleSignOut}
                className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                Sign out
              </button>
            </>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            ⚙
          </button>
        </div>
      </div>
      <Outlet />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
