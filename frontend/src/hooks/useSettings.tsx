import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
  type Theme,
  type Width,
} from '../lib/settings'

interface SettingsContextValue extends Settings {
  setTheme: (theme: Theme) => void
  setWidth: (width: Width) => void
  setHighlightTheme: (name: string) => void
  setIndentWidth: (n: 2 | 4) => void
  setCompact: (compact: boolean) => void
  setLineNumbers: (lineNumbers: boolean) => void
  setRender: (render: boolean) => void
  setWrap: (wrap: boolean) => void
  setStripedRows: (stripedRows: boolean) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings())

  useEffect(() => {
    saveSettings(settings)
    document.documentElement.classList.toggle('dark', settings.theme === 'dark')
  }, [settings])

  const value: SettingsContextValue = {
    ...settings,
    setTheme: (theme) => setSettings((s) => ({ ...s, theme })),
    setWidth: (width) => setSettings((s) => ({ ...s, width })),
    setHighlightTheme: (highlightTheme) => setSettings((s) => ({ ...s, highlightTheme })),
    setIndentWidth: (indentWidth) => setSettings((s) => ({ ...s, indentWidth })),
    setCompact: (compact) => setSettings((s) => ({ ...s, compact })),
    setLineNumbers: (lineNumbers) => setSettings((s) => ({ ...s, lineNumbers })),
    setRender: (render) => setSettings((s) => ({ ...s, render })),
    setWrap: (wrap) => setSettings((s) => ({ ...s, wrap })),
    setStripedRows: (stripedRows) => setSettings((s) => ({ ...s, stripedRows })),
  }

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider')
  return ctx
}

export { DEFAULT_SETTINGS }
