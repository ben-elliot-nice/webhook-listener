import { useEffect, useState } from 'react'
import { loadHighlightTheme } from '../lib/highlightThemes'

export function useHighlightTheme(name: string): Record<string, any> | undefined {
  const [theme, setTheme] = useState<Record<string, any> | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    loadHighlightTheme(name).then((loaded) => {
      if (!cancelled) setTheme(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [name])

  return theme
}
