import { useSettings } from '../hooks/useSettings'
import { HIGHLIGHT_THEME_NAMES } from '../lib/highlightThemes'
import type { Width } from '../lib/settings'

interface SettingsModalProps {
  onClose: () => void
}

const WIDTH_OPTIONS: { value: Width; label: string }[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full' },
]

export function SettingsModal({ onClose }: SettingsModalProps) {
  const {
    theme,
    width,
    highlightTheme,
    indentWidth,
    compact,
    lineNumbers,
    render,
    wrap,
    stripedRows,
    setTheme,
    setWidth,
    setHighlightTheme,
    setIndentWidth,
    setCompact,
    setLineNumbers,
    setRender,
    setWrap,
    setStripedRows,
  } = useSettings()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-lg dark:bg-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            ✕
          </button>
        </div>

        <section className="mb-4">
          <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">Theme</p>
          <div className="flex gap-2">
            {(['light', 'dark'] as const).map((option) => (
              <button
                key={option}
                onClick={() => setTheme(option)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  theme === option
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300'
                }`}
              >
                {option === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </section>

        <section className="mb-4">
          <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">Width</p>
          <div className="flex gap-2">
            {WIDTH_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setWidth(option.value)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  width === option.value
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">Formatter</p>

          <label className="mb-2 block text-sm text-slate-700 dark:text-slate-300">
            Highlight theme
            <select
              value={highlightTheme}
              onChange={(e) => setHighlightTheme(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            >
              {[...HIGHLIGHT_THEME_NAMES].sort().map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-slate-700 dark:text-slate-300">Indent</span>
            <div className="flex gap-2">
              {([2, 4] as const).map((n) => (
                <button
                  key={n}
                  onClick={() => setIndentWidth(n)}
                  className={`rounded-md px-3 py-1 text-sm font-medium transition ${
                    indentWidth === n
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <label className="mb-2 flex items-center justify-between text-sm text-slate-700 dark:text-slate-300">
            Compact
            <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
          </label>

          <label className="mb-2 flex items-center justify-between text-sm text-slate-700 dark:text-slate-300">
            Line numbers
            <input type="checkbox" checked={lineNumbers} onChange={(e) => setLineNumbers(e.target.checked)} />
          </label>

          <label className="mb-2 flex items-center justify-between text-sm text-slate-700 dark:text-slate-300">
            Render escaped whitespace
            <input type="checkbox" checked={render} onChange={(e) => setRender(e.target.checked)} />
          </label>

          <label className="mb-2 flex items-center justify-between text-sm text-slate-700 dark:text-slate-300">
            Wrap long lines
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          </label>

          <label className="flex items-center justify-between text-sm text-slate-700 dark:text-slate-300">
            Alternate row striping
            <input type="checkbox" checked={stripedRows} onChange={(e) => setStripedRows(e.target.checked)} />
          </label>
        </section>
      </div>
    </div>
  )
}
