export type Theme = 'light' | 'dark'
export type Width = 'narrow' | 'wide' | 'full'

export interface Settings {
  theme: Theme
  width: Width
  highlightTheme: string
  indentWidth: 2 | 4
  compact: boolean
  lineNumbers: boolean
  render: boolean
  wrap: boolean
  stripedRows: boolean
}

export const WIDTH_CLASSES: Record<Width, string> = {
  narrow: 'max-w-3xl',
  wide: 'max-w-5xl',
  full: 'max-w-none',
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  width: 'narrow',
  highlightTheme: 'one-dark',
  indentWidth: 2,
  compact: false,
  lineNumbers: false,
  render: false,
  wrap: false,
  stripedRows: false,
}

const STORAGE_KEY = 'wl_settings'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}
