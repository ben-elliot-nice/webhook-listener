# Settings (theme/width/formatter) & Formatter/Viewer Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Settings modal (theme, width, and a new Formatter section: highlight theme, indent width, compact mode, line numbers) and fix the diff view to reuse the syntax highlighter instead of a plain colored `<pre>`.

**Architecture:** A single `Settings` object persisted to localStorage (`wl_settings`) via a React context (`SettingsProvider`/`useSettings`), surfaced through a cog-icon modal shared across all three routes via a new `AppLayout` wrapper. `RequestRow.tsx`'s JSON detail view and diff view both read from this context and render through `react-syntax-highlighter`, with highlight themes lazy-loaded per selection and diff coloring implemented as per-line background classes on top of one continuous highlighted blob.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind CSS, `react-syntax-highlighter` v16 (PrismLight), `diff` (already a dependency).

**Spec:** `docs/superpowers/specs/2026-09-20-settings-and-formatter-design.md`

## Global Constraints

- **Model constraint (this workflow only):** every implementation subagent must be dispatched with `model: sonnet` (use `haiku` only for the most mechanical, low-risk steps if the executor judges it safe). Never dispatch with `opus` or `fable` for planning or implementation work on this plan, per explicit user instruction.
- **No automated test framework.** This frontend has no test suite (documented, established project scope — see `HANDOFF.md`). Every task's verification is `cd frontend && npm run build` (TypeScript check, must show 0 errors) plus a manual browser check described in that task's steps. Do not add Vitest/Jest/etc. as part of this plan.
- **Defaults must not change today's look.** `DEFAULT_SETTINGS` must reproduce exactly what's on screen today (light theme, `max-w-3xl` width, `one-dark` highlight theme, 2-space indent, not compact, no line numbers) so existing users see zero visual change until they open Settings.
- **Export is unaffected.** `exportRequests.ts` must keep using `JSON.stringify(x, null, 2)` regardless of any formatter setting — never wire `compact`/`indentWidth` into export code.
- **One diff renderer.** Both the per-row "Diff vs previous" button and diff-only mode (Task 10) must call the same `buildDiffBlob` helper (Task 8) — no duplicated diff-rendering logic.
- **Follow existing patterns.** Match the codebase's existing Tailwind class style (utility classes inline, no CSS modules), existing component/hook file layout, and existing error-handling style (silent catch with a `setError` message, as seen throughout `Listener.tsx`/`SharedListener.tsx`).

---

### Task 1: Settings storage module

**Files:**
- Create: `frontend/src/lib/settings.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (used by Task 2 onward):
  - `type Theme = 'light' | 'dark'`
  - `type Width = 'narrow' | 'wide' | 'full'`
  - `interface Settings { theme: Theme; width: Width; highlightTheme: string; indentWidth: 2 | 4; compact: boolean; lineNumbers: boolean }`
  - `WIDTH_CLASSES: Record<Width, string>`
  - `DEFAULT_SETTINGS: Settings`
  - `loadSettings(): Settings`
  - `saveSettings(settings: Settings): void`

- [ ] **Step 1: Write `frontend/src/lib/settings.ts`**

```ts
export type Theme = 'light' | 'dark'
export type Width = 'narrow' | 'wide' | 'full'

export interface Settings {
  theme: Theme
  width: Width
  highlightTheme: string
  indentWidth: 2 | 4
  compact: boolean
  lineNumbers: boolean
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
```

- [ ] **Step 2: Verify it builds**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors. (This module isn't imported anywhere yet, so `tsc` only checks it's syntactically/type valid in isolation — full integration is verified once `useSettings` consumes it in Task 2.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/settings.ts
git commit -m "feat(frontend): add settings storage module"
```

---

### Task 2: Settings context, provider, and app wiring

**Files:**
- Create: `frontend/src/hooks/useSettings.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/index.html`
- Modify: `frontend/tailwind.config.js`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `Settings`, `DEFAULT_SETTINGS`, `loadSettings`, `saveSettings` from `../lib/settings` (Task 1).
- Produces (used by Task 3 onward):
  - `SettingsProvider` — React component, wraps `children: React.ReactNode`.
  - `useSettings(): Settings & { setTheme(t: Theme): void; setWidth(w: Width): void; setHighlightTheme(name: string): void; setIndentWidth(n: 2 | 4): void; setCompact(b: boolean): void; setLineNumbers(b: boolean): void }`

- [ ] **Step 1: Write `frontend/src/hooks/useSettings.tsx`**

```tsx
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
  }

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider')
  return ctx
}

export { DEFAULT_SETTINGS }
```

- [ ] **Step 2: Wrap `App` in `SettingsProvider` in `frontend/src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { SettingsProvider } from './hooks/useSettings'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </StrictMode>
)
```

- [ ] **Step 3: Add the flash-of-wrong-theme-avoidance script to `frontend/index.html`**

Add this `<script>` in `<head>`, before the `#root` div and before `main.tsx` loads:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Webhook Listener</title>
    <script>
      try {
        var raw = localStorage.getItem('wl_settings')
        var parsed = raw ? JSON.parse(raw) : null
        if (parsed && parsed.theme === 'dark') {
          document.documentElement.classList.add('dark')
        }
      } catch (e) {}
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Enable class-based dark mode in `frontend/tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {},
  },
  plugins: [],
}
```

- [ ] **Step 5: Add dark body styling to `frontend/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  @apply bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100;
}
```

- [ ] **Step 6: Verify build**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 7: Manual verification**

Run `cd frontend && npm run dev`, open the app in a browser:
- In devtools console, run `localStorage.setItem('wl_settings', JSON.stringify({theme:'dark',width:'narrow',highlightTheme:'one-dark',indentWidth:2,compact:false,lineNumbers:false}))`, then hard-refresh. Confirm `<html>` has class `dark` and the page background is dark **before** any visible flash of the light background.
- Run `localStorage.removeItem('wl_settings')` and refresh — confirm it goes back to light with no console errors (missing key falls back to `DEFAULT_SETTINGS`).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/hooks/useSettings.tsx frontend/src/main.tsx frontend/index.html frontend/tailwind.config.js frontend/src/index.css
git commit -m "feat(frontend): add settings context, provider, and dark-mode plumbing"
```

---

### Task 3: Settings modal (Theme + Width) and AppLayout

**Files:**
- Create: `frontend/src/components/AppLayout.tsx`
- Create: `frontend/src/components/SettingsModal.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useSettings()` (Task 2) for `theme`, `width`, `setTheme`, `setWidth`.
- Produces (used by Task 9): `SettingsModal` component, extended in Task 9 with a Formatter section. `AppLayout` is not consumed elsewhere but is the route wrapper going forward.

- [ ] **Step 1: Write `frontend/src/components/SettingsModal.tsx`**

```tsx
import { useSettings } from '../hooks/useSettings'
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
  const { theme, width, setTheme, setWidth } = useSettings()

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
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Write `frontend/src/components/AppLayout.tsx`**

```tsx
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
```

- [ ] **Step 3: Wrap routes in `AppLayout` in `frontend/src/App.tsx`**

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'
import { SharedListener } from './pages/SharedListener'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/listener/:id" element={<Listener />} />
          <Route path="/shared/:token" element={<SharedListener />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
```

- [ ] **Step 4: Verify build**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 5: Manual verification**

`npm run dev`, open `/`, `/listener/:id` (create a listener first), and `/shared/:token` (generate a share link first). On each: click the cog, confirm the modal opens; click Light/Dark and Narrow/Wide/Full, confirm the buttons highlight the active choice; click outside the modal or the ✕, confirm it closes.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/AppLayout.tsx frontend/src/components/SettingsModal.tsx frontend/src/App.tsx
git commit -m "feat(frontend): add Settings modal with theme and width controls"
```

---

### Task 4: Dark-mode retrofit and width application

**Files:**
- Modify: `frontend/src/pages/Home.tsx`
- Modify: `frontend/src/pages/Listener.tsx`
- Modify: `frontend/src/pages/SharedListener.tsx`
- Modify: `frontend/src/components/RequestFilters.tsx`
- Modify: `frontend/src/components/RequestRow.tsx` (header row + expand button only — the detail/diff panel is reworked in Tasks 7-8)

**Interfaces:**
- Consumes: `useSettings()` for `width` (Listener.tsx, SharedListener.tsx only), `WIDTH_CLASSES` from `../lib/settings`.
- Produces: no new exports — visual-only changes to existing components.

- [ ] **Step 1: Apply `WIDTH_CLASSES` in `Listener.tsx`**

In `frontend/src/pages/Listener.tsx`, add the import and replace the hardcoded width class:

```tsx
import { useSettings } from '../hooks/useSettings'
import { WIDTH_CLASSES } from '../lib/settings'
```

Inside `export function Listener()`, add:

```tsx
const { width } = useSettings()
```

Change the root element from:

```tsx
<main className="mx-auto max-w-3xl px-6 py-10">
```

to:

```tsx
<main className={`mx-auto px-6 py-10 ${WIDTH_CLASSES[width]}`}>
```

- [ ] **Step 2: Apply `WIDTH_CLASSES` in `SharedListener.tsx`**

Same change as Step 1, applied to `frontend/src/pages/SharedListener.tsx`'s `<main>` element.

- [ ] **Step 3: Add `dark:` variants to `Home.tsx`, `Listener.tsx`, `SharedListener.tsx`, `RequestFilters.tsx`**

Add a `dark:` pair next to every existing light-only Tailwind color utility in these four files, following this mapping (apply consistently everywhere the corresponding light class appears):

| Light class | Add dark variant |
|---|---|
| `bg-white` | `dark:bg-slate-800` |
| `bg-slate-50` / `bg-slate-100` (surfaces, not badges) | `dark:bg-slate-800` |
| `text-slate-900` | `dark:text-slate-100` |
| `text-slate-700` / `text-slate-600` | `dark:text-slate-300` |
| `text-slate-500` / `text-slate-400` | `dark:text-slate-400` |
| `border-slate-200` / `border-slate-300` | `dark:border-slate-700` |
| `bg-rose-50` (error banner) | `dark:bg-rose-950` |
| `text-rose-700` (error banner) | `dark:text-rose-300` |
| `hover:bg-slate-50` / `hover:bg-slate-200` | `dark:hover:bg-slate-700` |

Example, in `Home.tsx`'s create-listener card:

```tsx
<div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm dark:bg-slate-800">
```

Apply the same pattern-matching substitution to every element in the four files carrying one of the light classes in the table above. Do not change layout, spacing, or non-color classes.

- [ ] **Step 4: Add `dark:` variants to `RequestRow.tsx`'s header row (collapsed state) only**

In `frontend/src/components/RequestRow.tsx`, update only the outer `<li>` and the header `<button>` (lines 75-88 in the current file) — leave the expanded detail/diff panel untouched here since Tasks 7-8 rewrite it:

```tsx
<li className="rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
  <button
    onClick={() => setExpanded((v) => !v)}
    className="flex w-full items-center gap-3 px-4 py-3 text-left"
  >
    <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${methodStyle}`}>
      {request.method}
    </span>
    <span className="flex-1 truncate text-sm text-slate-600 dark:text-slate-300">
      {request.contentType ?? 'no content-type'}
    </span>
    <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{formatTimestamp(request.receivedAt)}</span>
    <span className="shrink-0 text-slate-400 dark:text-slate-500">{expanded ? '−' : '+'}</span>
  </button>
```

- [ ] **Step 5: Verify build**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 6: Manual verification**

`npm run dev`. On a listener with several requests: switch Width Narrow → Wide → Full, confirm the container resizes and Home's create-listener card is unaffected (Home.tsx's card is intentionally not wrapped in `WIDTH_CLASSES`). Switch Theme to Dark and click through `/`, `/listener/:id`, `/shared/:token`: confirm every surface, text, border, and the error banner are legible with no unstyled white flashes. Switch back to Light and confirm it looks identical to before this task.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Home.tsx frontend/src/pages/Listener.tsx frontend/src/pages/SharedListener.tsx frontend/src/components/RequestFilters.tsx frontend/src/components/RequestRow.tsx
git commit -m "feat(frontend): retrofit dark mode and apply width setting"
```

---

### Task 5: `prettyPrint.ts` indent width and compact mode

**Files:**
- Modify: `frontend/src/lib/prettyPrint.ts`
- Modify: `frontend/src/components/RequestRow.tsx` (its two existing `prettyPrintBody`/`JSON.stringify` call sites only)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 7, Task 8): `prettyPrintBody(body: string | null, opts: { indentWidth: number; compact: boolean }): string`

- [ ] **Step 1: Update `frontend/src/lib/prettyPrint.ts`**

```ts
export interface PrettyPrintOptions {
  indentWidth: number
  compact: boolean
}

export function prettyPrintBody(body: string | null, opts: PrettyPrintOptions): string {
  if (!body) return ''
  try {
    const parsed = JSON.parse(body)
    return opts.compact ? JSON.stringify(parsed) : JSON.stringify(parsed, null, opts.indentWidth)
  } catch {
    return body
  }
}
```

- [ ] **Step 2: Update `RequestRow.tsx`'s two call sites to pass explicit default options**

This step only makes the signature change compile — it does not yet read from `useSettings()` (that happens in Task 7). In `frontend/src/components/RequestRow.tsx`, change:

```ts
const diffParts = previousRequest
  ? diffLines(prettyPrintBody(previousRequest.body), prettyPrintBody(request.body))
  : null
```

to:

```ts
const diffParts = previousRequest
  ? diffLines(
      prettyPrintBody(previousRequest.body, { indentWidth: 2, compact: false }),
      prettyPrintBody(request.body, { indentWidth: 2, compact: false })
    )
  : null
```

- [ ] **Step 3: Verify build**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 4: Manual verification**

`npm run dev`, open a request's "Diff vs previous" view, confirm the diff output is byte-identical to before this task (still 2-space indent, still not compact) — this step is a pure refactor with no visible behavior change yet.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/prettyPrint.ts frontend/src/components/RequestRow.tsx
git commit -m "refactor(frontend): parameterize prettyPrintBody with indent width and compact mode"
```

---

### Task 6: Highlight theme registry

**Files:**
- Create: `frontend/src/lib/highlightThemes.ts`
- Create: `frontend/src/hooks/useHighlightTheme.ts`

**Interfaces:**
- Consumes: nothing new (dynamically imports from `react-syntax-highlighter/dist/esm/styles/prism/*`, an existing dependency).
- Produces (used by Task 7, Task 8, Task 9):
  - `HIGHLIGHT_THEME_NAMES: string[]`
  - `loadHighlightTheme(name: string): Promise<Record<string, any>>`
  - `getThemeBackground(theme: Record<string, any>): string`
  - `useHighlightTheme(name: string): Record<string, any> | undefined`

- [ ] **Step 1: Write `frontend/src/lib/highlightThemes.ts`**

```ts
export const HIGHLIGHT_THEME_NAMES: string[] = [
  'a11y-dark',
  'a11y-one-light',
  'atom-dark',
  'base16-ateliersulphurpool.light',
  'cb',
  'coldark-cold',
  'coldark-dark',
  'coy-without-shadows',
  'coy',
  'darcula',
  'dark',
  'dracula',
  'duotone-dark',
  'duotone-earth',
  'duotone-forest',
  'duotone-light',
  'duotone-sea',
  'duotone-space',
  'funky',
  'ghcolors',
  'gruvbox-dark',
  'gruvbox-light',
  'holi-theme',
  'hopscotch',
  'lucario',
  'material-dark',
  'material-light',
  'material-oceanic',
  'night-owl',
  'nord',
  'okaidia',
  'one-dark',
  'one-light',
  'pojoaque',
  'prism',
  'shades-of-purple',
  'solarized-dark-atom',
  'solarizedlight',
  'synthwave84',
  'tomorrow',
  'twilight',
  'vs-dark',
  'vs',
  'vsc-dark-plus',
  'xonokai',
  'z-touch',
]

const cache = new Map<string, Record<string, any>>()

export async function loadHighlightTheme(name: string): Promise<Record<string, any>> {
  const cached = cache.get(name)
  if (cached) return cached
  const mod = await import(`react-syntax-highlighter/dist/esm/styles/prism/${name}.js`)
  const theme = mod.default
  cache.set(name, theme)
  return theme
}

export function getThemeBackground(theme: Record<string, any>): string {
  const codeStyle = theme['pre[class*="language-"]'] ?? theme['code[class*="language-"]']
  return codeStyle?.background ?? codeStyle?.backgroundColor ?? 'transparent'
}
```

- [ ] **Step 2: Write `frontend/src/hooks/useHighlightTheme.ts`**

```ts
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
```

- [ ] **Step 3: Verify build**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors. Note: Vite's static-analysis of the dynamic `import()` with a template literal restricted to `dist/esm/styles/prism/*.js` is a well-supported pattern (Vite globs the directory at build time) — if `npm run build` reports a "cannot analyze dynamic import" warning, switch the dynamic import to an explicit `switch (name)` statement enumerating all 46 `import('react-syntax-highlighter/dist/esm/styles/prism/<name>')` calls instead, one per case, and re-run the build to confirm the warning is gone.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/highlightThemes.ts frontend/src/hooks/useHighlightTheme.ts
git commit -m "feat(frontend): add lazy-loaded highlight theme registry"
```

---

### Task 7: Wire highlight theme, indent, compact, and line numbers into the detail view

**Files:**
- Modify: `frontend/src/components/RequestRow.tsx`

**Interfaces:**
- Consumes: `useSettings()` (Task 2) for `highlightTheme`, `indentWidth`, `compact`, `lineNumbers`; `useHighlightTheme` and `getThemeBackground` (Task 6); `prettyPrintBody` with the new signature (Task 5).
- Produces: no new exports — internal rendering change to `RequestRow`'s non-diff detail panel only. The diff panel (`showDiff` branch) is reworked in Task 8.

- [ ] **Step 1: Update imports and remove the hardcoded `oneDark` import**

In `frontend/src/components/RequestRow.tsx`, replace:

```ts
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'
import type { RequestDetail } from '../api'
import { prettyPrintBody } from '../lib/prettyPrint'
```

with:

```ts
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import type { RequestDetail } from '../api'
import { prettyPrintBody } from '../lib/prettyPrint'
import { useSettings } from '../hooks/useSettings'
import { useHighlightTheme } from '../hooks/useHighlightTheme'
import { getThemeBackground } from '../lib/highlightThemes'
```

- [ ] **Step 2: Read settings and the loaded theme inside `RequestRow`**

At the top of `export function RequestRow(...)`, after the existing `useState` calls, add:

```ts
const { highlightTheme, indentWidth, compact, lineNumbers } = useSettings()
const loadedTheme = useHighlightTheme(highlightTheme)
const panelBackground = loadedTheme ? getThemeBackground(loadedTheme) : 'transparent'
```

- [ ] **Step 3: Use `indentWidth`/`compact` when building `detailJson`**

Change:

```ts
const detailJson = JSON.stringify(
  {
    headers: request.headers,
    queryParams: request.queryParams,
    sourceIp: request.sourceIp,
    body: safeParse(request.body),
  },
  null,
  2
)
```

to:

```ts
const detailObject = {
  headers: request.headers,
  queryParams: request.queryParams,
  sourceIp: request.sourceIp,
  body: safeParse(request.body),
}
const detailJson = compact
  ? JSON.stringify(detailObject)
  : JSON.stringify(detailObject, null, indentWidth)
```

- [ ] **Step 4: Update the `diffParts` computation to use real settings**

Change the Task 5 placeholder:

```ts
const diffParts = previousRequest
  ? diffLines(
      prettyPrintBody(previousRequest.body, { indentWidth: 2, compact: false }),
      prettyPrintBody(request.body, { indentWidth: 2, compact: false })
    )
  : null
```

to:

```ts
const diffParts = previousRequest
  ? diffLines(
      prettyPrintBody(previousRequest.body, { indentWidth, compact }),
      prettyPrintBody(request.body, { indentWidth, compact })
    )
  : null
```

(This computation is superseded by Task 8's `buildDiffBlob`, but keeping it consistent now avoids a broken intermediate state if these tasks are reviewed independently.)

- [ ] **Step 5: Replace the panel wrapper background and `SyntaxHighlighter` background handling**

Change the outer expanded-panel `<div>` from:

```tsx
<div className="rounded-b-lg border-t border-slate-200 bg-slate-900">
```

to:

```tsx
<div className="rounded-b-lg border-t border-slate-200 dark:border-slate-700" style={{ background: panelBackground }}>
```

Change the non-diff `<SyntaxHighlighter>` render from:

```tsx
<SyntaxHighlighter
  language="json"
  style={oneDark}
  customStyle={{ background: 'transparent', margin: 0, padding: '1rem' }}
>
  {detailJson}
</SyntaxHighlighter>
```

to:

```tsx
{loadedTheme && (
  <SyntaxHighlighter
    language="json"
    style={loadedTheme}
    showLineNumbers={lineNumbers}
    customStyle={{ background: 'transparent', margin: 0, padding: '1rem' }}
    codeTagProps={{ style: { background: 'transparent' } }}
  >
    {detailJson}
  </SyntaxHighlighter>
)}
```

(`loadedTheme &&` guards the brief window before the first theme fetch resolves — the panel background alone is enough visual feedback during that gap; there is no plain-text/unstyled flash of content because the surrounding conditional keeps the panel empty, not incorrectly styled.)

- [ ] **Step 6: Verify build**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 7: Manual verification**

`npm run dev`. Open a request's detail view — should look identical to before (still `one-dark` background/colors, 2-space indent). In devtools console, change the stored settings and refresh to confirm each dimension works even before the Formatter UI exists (Task 9 adds the UI):
- `localStorage.setItem('wl_settings', JSON.stringify({theme:'light',width:'narrow',highlightTheme:'dracula',indentWidth:2,compact:false,lineNumbers:false}))` → refresh → detail view panel background and colors switch to Dracula's palette.
- Same but `"compact":true` → body renders as one line.
- Same but `"indentWidth":4` → body re-indents at 4 spaces.
- Same but `"lineNumbers":true` → line numbers appear down the left edge.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/RequestRow.tsx
git commit -m "feat(frontend): wire highlight theme, indent, compact, and line numbers into detail view"
```

---

### Task 8: Diff view — reuse the highlighter

**Files:**
- Create: `frontend/src/lib/diffHighlight.ts`
- Modify: `frontend/src/components/RequestRow.tsx`

**Interfaces:**
- Consumes: `diffLines` from `diff` (existing dependency); `prettyPrintBody` (Task 5); `useSettings`, `useHighlightTheme`, `getThemeBackground` (Tasks 2, 6).
- Produces (used by Task 10): `buildDiffBlob(oldText: string, newText: string): { text: string; lineTags: DiffLineTag[] }`, `type DiffLineTag = 'added' | 'removed' | 'unchanged'`.

- [ ] **Step 1: Write `frontend/src/lib/diffHighlight.ts`**

```ts
import { diffLines } from 'diff'

export type DiffLineTag = 'added' | 'removed' | 'unchanged'

export interface DiffBlob {
  text: string
  lineTags: DiffLineTag[]
}

export function buildDiffBlob(oldText: string, newText: string): DiffBlob {
  const parts = diffLines(oldText, newText)
  const lines: string[] = []
  const lineTags: DiffLineTag[] = []

  for (const part of parts) {
    const tag: DiffLineTag = part.added ? 'added' : part.removed ? 'removed' : 'unchanged'
    const partLines = part.value.split('\n')
    if (partLines[partLines.length - 1] === '') {
      partLines.pop()
    }
    for (const line of partLines) {
      lines.push(line)
      lineTags.push(tag)
    }
  }

  return { text: lines.join('\n'), lineTags }
}

export function diffLineClassName(tag: DiffLineTag): string {
  switch (tag) {
    case 'added':
      return 'diff-line-added'
    case 'removed':
      return 'diff-line-removed'
    case 'unchanged':
      return ''
  }
}
```

- [ ] **Step 2: Add diff-line background CSS to `frontend/src/index.css`**

`react-syntax-highlighter`'s `lineProps` accepts a `className`, but a per-line translucent background is easiest to guarantee with a plain CSS rule (Tailwind's arbitrary background-opacity utilities on a dynamically-generated className list would require safelisting) — add:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  @apply bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100;
}

.diff-line-added {
  background-color: rgba(16, 185, 129, 0.15);
}

.diff-line-removed {
  background-color: rgba(244, 63, 94, 0.15);
}
```

- [ ] **Step 3: Replace the diff rendering in `RequestRow.tsx`**

Add the import:

```ts
import { buildDiffBlob, diffLineClassName } from '../lib/diffHighlight'
```

Replace the `diffParts` computation from Task 7 (`const diffParts = previousRequest ? diffLines(...) : null`) with:

```ts
const diffBlob = previousRequest
  ? buildDiffBlob(
      prettyPrintBody(previousRequest.body, { indentWidth, compact }),
      prettyPrintBody(request.body, { indentWidth, compact })
    )
  : null
```

Remove the now-unused `diffLines` import (`import { diffLines } from 'diff'`) — `buildDiffBlob` owns that dependency now.

Replace the diff-rendering JSX:

```tsx
{showDiff && diffParts ? (
  <pre className="overflow-x-auto whitespace-pre-wrap px-4 pb-4 text-xs">
    {diffParts.map((part, i) => (
      <span
        key={i}
        className={
          part.added
            ? 'block bg-emerald-900/40 text-emerald-300'
            : part.removed
              ? 'block bg-rose-900/40 text-rose-300'
              : 'block text-slate-400'
        }
      >
        {part.value}
      </span>
    ))}
  </pre>
) : (
```

with:

```tsx
{showDiff && diffBlob && loadedTheme ? (
  <SyntaxHighlighter
    language="json"
    style={loadedTheme}
    showLineNumbers={lineNumbers}
    wrapLines
    lineProps={(lineNumber: number) => ({
      className: diffLineClassName(diffBlob.lineTags[lineNumber - 1] ?? 'unchanged'),
    })}
    customStyle={{ background: 'transparent', margin: 0, padding: '1rem' }}
    codeTagProps={{ style: { background: 'transparent' } }}
  >
    {diffBlob.text}
  </SyntaxHighlighter>
) : (
```

(The closing `)}` and the non-diff branch below it, updated in Task 7, are unchanged.)

Update the "Diff vs previous" toggle button's guard from `previousRequest &&` to `previousRequest && diffBlob &&` is not required — `previousRequest` alone is a sufficient guard, `diffBlob` is always defined whenever `previousRequest` is (same condition). Leave the button as-is.

- [ ] **Step 4: Verify build**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 5: Manual verification**

`npm run dev`. Open a listener with 2+ requests, expand a row, click "Diff vs previous": confirm the diff renders with syntax-highlighted JSON tokens (not plain white text) plus a green/red line-background wash on added/removed lines. Toggle `lineNumbers` on via localStorage (as in Task 7) and refresh: confirm line numbers run continuously from 1 through the whole diff, not restarting at each changed block.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/diffHighlight.ts frontend/src/index.css frontend/src/components/RequestRow.tsx
git commit -m "feat(frontend): render diff view through the syntax highlighter"
```

---

### Task 9: Formatter section in the Settings modal

**Files:**
- Modify: `frontend/src/components/SettingsModal.tsx`

**Interfaces:**
- Consumes: `useSettings()` for `highlightTheme, indentWidth, compact, lineNumbers, setHighlightTheme, setIndentWidth, setCompact, setLineNumbers`; `HIGHLIGHT_THEME_NAMES` (Task 6).

- [ ] **Step 1: Add the Formatter section to `SettingsModal.tsx`**

Update the destructured `useSettings()` call and add the import:

```tsx
import { useSettings } from '../hooks/useSettings'
import { HIGHLIGHT_THEME_NAMES } from '../lib/highlightThemes'
import type { Width } from '../lib/settings'
```

```tsx
const {
  theme,
  width,
  highlightTheme,
  indentWidth,
  compact,
  lineNumbers,
  setTheme,
  setWidth,
  setHighlightTheme,
  setIndentWidth,
  setCompact,
  setLineNumbers,
} = useSettings()
```

Add this section after the existing Width `<section>`, before the modal's closing `</div>`:

```tsx
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

  <label className="flex items-center justify-between text-sm text-slate-700 dark:text-slate-300">
    Line numbers
    <input type="checkbox" checked={lineNumbers} onChange={(e) => setLineNumbers(e.target.checked)} />
  </label>
</section>
```

- [ ] **Step 2: Verify build**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 3: Manual verification**

`npm run dev`, open a listener with a request, open Settings: change the Highlight theme dropdown and confirm the open request row's panel updates live (no refresh needed, since `useHighlightTheme` re-runs its effect on prop change). Toggle Indent 2/4, Compact, and Line numbers, confirming each affects the detail and diff views live.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/SettingsModal.tsx
git commit -m "feat(frontend): add formatter controls to the Settings modal"
```

---

### Task 10: Diff-only mode

**Files:**
- Modify: `frontend/src/pages/Listener.tsx`
- Modify: `frontend/src/pages/SharedListener.tsx`
- Modify: `frontend/src/components/RequestRow.tsx`

**Interfaces:**
- Consumes: `buildDiffBlob` (Task 8), all `RequestRow` machinery from Tasks 7-8.
- Produces: `RequestRow` gains a `diffOnly?: boolean` prop.

- [ ] **Step 1: Add `diffOnly?: boolean` prop and always-expanded diff rendering to `RequestRow.tsx`**

Update the props interface:

```ts
interface RequestRowProps {
  request: RequestDetail
  previousRequest?: RequestDetail
  diffOnly?: boolean
}
```

Update the function signature:

```ts
export function RequestRow({ request, previousRequest, diffOnly = false }: RequestRowProps) {
```

Change the panel visibility condition from `{expanded && (` to `{(diffOnly || expanded) && (`.

In the header `<button>`, hide the expand affordance and disable the click-to-toggle behavior when `diffOnly` is true:

```tsx
<button
  onClick={() => !diffOnly && setExpanded((v) => !v)}
  className="flex w-full items-center gap-3 px-4 py-3 text-left"
>
  <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${methodStyle}`}>
    {request.method}
  </span>
  <span className="flex-1 truncate text-sm text-slate-600 dark:text-slate-300">
    {request.contentType ?? 'no content-type'}
  </span>
  <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{formatTimestamp(request.receivedAt)}</span>
  {!diffOnly && <span className="shrink-0 text-slate-400 dark:text-slate-500">{expanded ? '−' : '+'}</span>}
</button>
```

Hide the "Diff vs previous"/"Copy" button row when `diffOnly` is true, and force `showDiff`-equivalent behavior: when `diffOnly` is true, always render the diff (if `previousRequest` exists) or the full detail view (if not), ignoring the `showDiff` toggle state entirely:

```tsx
{(diffOnly || expanded) && (
  <div className="rounded-b-lg border-t border-slate-200 dark:border-slate-700" style={{ background: panelBackground }}>
    {!diffOnly && (
      <div className="flex justify-end gap-2 px-2 pt-2">
        {previousRequest && (
          <button
            onClick={() => setShowDiff((v) => !v)}
            className="rounded-md px-2 py-1 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
          >
            {showDiff ? 'Hide diff' : 'Diff vs previous'}
          </button>
        )}
        <button
          onClick={handleCopy}
          className="rounded-md px-2 py-1 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    )}
    {(diffOnly ? Boolean(previousRequest) : showDiff) && diffBlob && loadedTheme ? (
      <SyntaxHighlighter
        language="json"
        style={loadedTheme}
        showLineNumbers={lineNumbers}
        wrapLines
        lineProps={(lineNumber: number) => ({
          className: diffLineClassName(diffBlob.lineTags[lineNumber - 1] ?? 'unchanged'),
        })}
        customStyle={{ background: 'transparent', margin: 0, padding: '1rem' }}
        codeTagProps={{ style: { background: 'transparent' } }}
      >
        {diffBlob.text}
      </SyntaxHighlighter>
    ) : (
      loadedTheme && (
        <SyntaxHighlighter
          language="json"
          style={loadedTheme}
          showLineNumbers={lineNumbers}
          customStyle={{ background: 'transparent', margin: 0, padding: '1rem' }}
          codeTagProps={{ style: { background: 'transparent' } }}
        >
          {detailJson}
        </SyntaxHighlighter>
      )
    )}
  </div>
)}
```

- [ ] **Step 2: Add the "Diff only" toggle and prop wiring to `Listener.tsx`**

Add local state near the other `useState` calls in `export function Listener()`:

```ts
const [diffOnly, setDiffOnly] = useState(false)
```

Add the toggle button next to the existing Export buttons:

```tsx
<button
  onClick={() => setDiffOnly((v) => !v)}
  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
    diffOnly
      ? 'border-indigo-600 bg-indigo-600 text-white'
      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300'
  }`}
>
  Diff only
</button>
```

Pass the prop down to `RequestRow`:

```tsx
<RequestRow
  key={req.id}
  request={req}
  previousRequest={previousByRequestId.get(req.id)}
  diffOnly={diffOnly}
/>
```

- [ ] **Step 3: Repeat Step 2's changes in `SharedListener.tsx`**

Same `diffOnly` state, same toggle button next to its Export buttons, same prop passed to `RequestRow`.

- [ ] **Step 4: Verify build**

Run: `cd frontend && npm run build`
Expected: 0 TypeScript errors.

- [ ] **Step 5: Manual verification**

`npm run dev`, open a listener with 3+ requests. Toggle "Diff only": confirm the oldest/first request shows its full detail JSON (no previous request to diff against), every other request shows a highlighted diff against its predecessor, no row shows the expand affordance or the Diff/Copy buttons, and clicking a row's header does nothing. Toggle "Diff only" back off: confirm every row returns to normal collapsed state with working expand/diff/copy. Repeat on `/shared/:token`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Listener.tsx frontend/src/pages/SharedListener.tsx frontend/src/components/RequestRow.tsx
git commit -m "feat(frontend): add diff-only viewing mode"
```

---

### Task 11: Final verification pass against the spec

**Files:** none (verification only; fix forward in the relevant file if something fails)

- [ ] **Step 1: Full settings modal pass**

`cd frontend && npm run build` (0 errors), then `npm run dev`. On each of `/`, `/listener/:id`, `/shared/:token`: open Settings, confirm all four sections (Theme, Width, Formatter's highlight-theme/indent/compact/line-numbers) are present and functional.

- [ ] **Step 2: Theme flash check**

Set Theme to Dark, hard-refresh several times on `/listener/:id`. Confirm there is never a flash of the light background before dark paints.

- [ ] **Step 3: Export unaffected check**

Set Compact on and Indent to 4. Export JSON and export HAR from a listener with at least one request. Open the downloaded files and confirm the JSON inside is still 2-space pretty-printed, not compact — export must be untouched by display settings.

- [ ] **Step 4: Diff-only + line-numbers combined check**

With Line numbers on, toggle Diff only on a listener with 4+ requests. Confirm line numbering is continuous through each row's diff (not restarting per row — each row's diff is numbered 1..N independently per row, which is correct: continuity is required *within* one diff, not *across* different rows' diffs).

- [ ] **Step 5: Regression check against `HANDOFF.md`'s existing manual checklist**

Confirm items from `HANDOFF.md`'s "Outstanding manual check" section still hold: create a listener, confirm it appears on the home page, confirm an incognito window can't see it, generate a share link and open it in another browser/incognito. This plan didn't touch auth/session code, but this is the first change since that checklist was written that touches every page's layout (`AppLayout`), so re-confirming costs little.

- [ ] **Step 6: Fix forward if anything fails**

If any check in Steps 1-5 fails, fix it in the relevant file from the task that introduced the behavior, re-run `npm run build`, and re-check that specific item. Do not proceed to Step 7 until all checks pass.

- [ ] **Step 7: Update `HANDOFF.md`**

Add a new entry under "Features built, in order" documenting this feature (settings/formatter), following the existing entries' style (what was built, what was found/fixed during implementation, any accepted limitations). Remove the corresponding bullet from "Feature backlog" and from "Known parked/deferred items" if superseded.

- [ ] **Step 8: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: record settings and formatter feature in handoff notes"
```
