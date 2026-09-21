import { useSettings } from '../hooks/useSettings'
import { HIGHLIGHT_THEME_NAMES } from '../lib/highlightThemes'
import type { StripeIntensity, Width } from '../lib/settings'

interface SettingsModalProps {
  onClose: () => void
}

const WIDTH_OPTIONS: { value: Width; label: string }[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full' },
]

const STRIPE_INTENSITY_OPTIONS: { value: StripeIntensity; label: string }[] = [
  { value: 'subtle', label: 'Subtle' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'Strong' },
]

function SectionHeading({ children, first = false }: { children: string; first?: boolean }) {
  return (
    <p
      className={`mb-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 ${
        first ? '' : 'border-t border-slate-100 pt-4 dark:border-slate-700'
      }`}
    >
      {children}
    </p>
  )
}

function ButtonGroup<T extends string | number>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div className="flex gap-2">
      {options.map((option) => (
        <button
          key={option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
            value === option.value
              ? 'bg-indigo-600 text-white'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between text-sm text-slate-700 dark:text-slate-300">
      {label}
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-indigo-600"
      />
    </label>
  )
}

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
    stripeIntensity,
    setTheme,
    setWidth,
    setHighlightTheme,
    setIndentWidth,
    setCompact,
    setLineNumbers,
    setRender,
    setWrap,
    setStripedRows,
    setStripeIntensity,
  } = useSettings()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-lg dark:bg-slate-800"
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
          <SectionHeading first>Appearance</SectionHeading>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-700 dark:text-slate-300">Theme</span>
              <ButtonGroup
                options={[
                  { value: 'light' as const, label: 'Light' },
                  { value: 'dark' as const, label: 'Dark' },
                ]}
                value={theme}
                onChange={setTheme}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-700 dark:text-slate-300">Width</span>
              <ButtonGroup options={WIDTH_OPTIONS} value={width} onChange={setWidth} />
            </div>
          </div>
        </section>

        <section className="mb-4">
          <SectionHeading>Syntax Theme</SectionHeading>
          <label className="block text-sm text-slate-700 dark:text-slate-300">
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
        </section>

        <section className="mb-4">
          <SectionHeading>Code Formatting</SectionHeading>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-700 dark:text-slate-300">Indent</span>
              <ButtonGroup options={[{ value: 2 as const, label: '2' }, { value: 4 as const, label: '4' }]} value={indentWidth} onChange={setIndentWidth} />
            </div>
            <ToggleRow label="Compact" checked={compact} onChange={setCompact} />
            <ToggleRow label="Wrap long lines" checked={wrap} onChange={setWrap} />
            <ToggleRow label="Render escaped whitespace" checked={render} onChange={setRender} />
          </div>
        </section>

        <section>
          <SectionHeading>Line Display</SectionHeading>
          <div className="space-y-2">
            <ToggleRow label="Line numbers" checked={lineNumbers} onChange={setLineNumbers} />
            <ToggleRow label="Alternate row striping" checked={stripedRows} onChange={setStripedRows} />
            <div className="ml-3 flex items-center justify-between border-l border-slate-200 pl-3 dark:border-slate-700">
              <span className="text-sm text-slate-500 dark:text-slate-400">Stripe intensity</span>
              <ButtonGroup
                options={STRIPE_INTENSITY_OPTIONS}
                value={stripeIntensity}
                onChange={setStripeIntensity}
                disabled={!stripedRows}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
