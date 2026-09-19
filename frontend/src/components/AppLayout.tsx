import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { SettingsModal } from './SettingsModal'

export function AppLayout() {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className="min-h-screen">
      <div className="flex items-center justify-end px-4 py-2">
        <button
          onClick={() => setSettingsOpen(true)}
          aria-label="Open settings"
          className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          ⚙
        </button>
      </div>
      <Outlet />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
