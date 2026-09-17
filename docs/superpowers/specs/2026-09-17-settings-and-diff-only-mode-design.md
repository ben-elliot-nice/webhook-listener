# Settings (theme/width) & Diff-only Mode — Design Spec

Date: 2026-09-17

## Purpose

Two independent, frontend-only additions requested together:

1. A persistent **Settings** modal (a "cog" icon in a shared header, matching
   the pattern already used in the `webrtc-dtmf` project) exposing two
   personal display preferences: **dark/light theme** and **content width**.
2. A new **diff-only** viewing mode for a listener's request list: instead of
   each row independently toggling between full JSON and a diff, the whole
   list can be switched into a mode where every request (after the first)
   renders as a diff against the immediately preceding request.

Both are purely visual/frontend — no backend or API changes.

## 1. Settings (theme + width)

### Storage

`frontend/src/lib/settings.ts`:
- `type Theme = 'light' | 'dark'`
- `type Width = 'narrow' | 'wide' | 'full'`
- `WIDTH_CLASSES: Record<Width, string>` — `narrow: 'max-w-3xl'`, `wide: 'max-w-5xl'`, `full: 'max-w-none'`
- `DEFAULT_SETTINGS = { theme: 'light', width: 'narrow' }` — matches today's
  hardcoded look exactly, so existing users see no change until they open
  Settings.
- `loadSettings()` / `saveSettings()` — read/write a single JSON blob under
  localStorage key `wl_settings`. Malformed/missing data falls back to
  defaults (no migration needed, nothing has ever been stored under this key).

### Context

`frontend/src/hooks/useSettings.tsx`:
- `SettingsProvider` — holds `{ theme, width }` state seeded from
  `loadSettings()`. A `useEffect` persists to localStorage and toggles the
  `dark` class on `document.documentElement` whenever `theme` changes.
- `useSettings()` — returns `{ theme, width, setTheme, setWidth }`.
- `main.tsx` wraps `<App />` in `<SettingsProvider>`.

### Flash-of-wrong-theme avoidance

A small synchronous inline `<script>` added to `index.html`'s `<head>`
(before `#root`/`main.tsx` load) reads `localStorage.wl_settings` and sets
`document.documentElement.classList` accordingly — the same technique
`webrtc-dtmf/public/index.html` already uses. This runs before React mounts
and before first paint, so there's no flash regardless of how long the JS
bundle takes to evaluate.

### Layout & modal

- `frontend/src/components/AppLayout.tsx` — new layout route: a slim top bar
  (app name left, a settings cog `<button>` right) plus `<Outlet />`, and
  renders `<SettingsModal>` when open (local `useState` in the layout).
- `frontend/src/components/SettingsModal.tsx` — fixed-overlay centered card
  (`fixed inset-0 ... bg-black/50`, styled after `webrtc-dtmf`'s modal),
  containing:
  - **Theme** section: Light / Dark buttons, active one visually marked,
    calls `setTheme`.
  - **Width** section: Narrow / Wide / Full buttons, calls `setWidth`.
  - A close button.
- `App.tsx`: wrap the three existing routes in a parent `<Route element={<AppLayout />}>` so the cog/modal appear identically on `/`, `/listener/:id`, and `/shared/:token`.

### Dark mode retrofit

- `tailwind.config.js`: add `darkMode: 'class'`.
- `index.css`: body rule gets a `dark:bg-slate-900 dark:text-slate-100` pair.
- Every existing component with hardcoded light-only Tailwind classes
  (`Home.tsx`, `Listener.tsx`, `SharedListener.tsx`, `RequestRow.tsx`,
  `RequestFilters.tsx`, `AppLayout.tsx`, `SettingsModal.tsx`) gets `dark:`
  variants using Tailwind's built-in slate scale — dark surfaces
  `slate-800`/`slate-900`, light text `slate-100`/`slate-300`, borders
  `slate-700`. No new custom colors/theme tokens; status-color accents
  (emerald/blue/amber/rose badges, error banners) keep their existing hues
  but get darker background/lighter text `dark:` pairs so they stay legible
  on dark surfaces.
- The JSON syntax highlighter already renders on a dark panel
  (`bg-slate-900`) in both themes today (`oneDark` style) — left as-is, no
  change needed there.

### Width application scope

`WIDTH_CLASSES[width]` replaces the hardcoded `max-w-3xl` on the `<main>`
container in `Listener.tsx` and `SharedListener.tsx` only — these are the
pages where large JSON payloads are actually viewed, which is the stated
purpose of the setting. `Home.tsx`'s centered `max-w-md` create-listener
card is a distinct, intentionally small element and is not affected by this
setting.

## 2. Diff-only mode

### Scope & persistence

A per-page, non-persisted view toggle — resets to off on every page load.
Lives next to the existing Export JSON/HAR buttons in `Listener.tsx` and
`SharedListener.tsx` as a "Diff only" toggle button (pressed/active state
styled like an active filter).

### Data flow

Both pages already compute `previousByRequestId` (a `Map` from request id to
its chronological predecessor). This is unchanged. A new local
`diffOnly: boolean` state is added and passed down as a prop to every
`<RequestRow>` alongside the existing `previousRequest` prop.

### `RequestRow.tsx` changes

New `diffOnly?: boolean` prop. When `true`:
- The row ignores its local `expanded` state and always renders its content
  section (no click-to-expand/collapse — the header row's method/content
  type/timestamp is still shown for context, but the `+`/`−` toggle affordance
  is removed since there's nothing left to toggle).
- The "Diff vs previous" / "Copy" button row is hidden entirely — the whole
  list is already in diff view, so there's nothing to switch per-row.
- Content:
  - If `previousRequest` exists (all rows except the first/oldest): render
    the existing body-only `diffLines(prettyPrintBody(previousRequest.body), prettyPrintBody(request.body))`
    diff view (same rendering already implemented for the current per-row
    "Diff vs previous" button — reused, not duplicated).
  - If there is no `previousRequest` (the first/oldest request in the list):
    render today's existing full pretty-printed detail JSON view (headers +
    query params + source IP + body) — there's nothing to diff against yet.

When `diffOnly` is `false` (default), `RequestRow` behaves exactly as it
does today — no behavior change for the existing per-row expand/diff/copy
flow.

## Testing

No backend changes. This frontend has no automated test suite (established
project scope — see `2026-09-17-home-listener-list-design.md`). Verification
is `cd frontend && npm run build` (TypeScript check, 0 errors) plus manual
browser confirmation:
- Toggle Settings cog on `/`, `/listener/:id`, and `/shared/:token` — modal
  opens/closes identically on all three.
- Switch theme Light → Dark → Light: no flash on reload in either state,
  every page/component legible in both themes.
- Switch width Narrow → Wide → Full on a listener with several requests:
  container resizes, Home page's create-listener card is unaffected.
- On a listener with 3+ requests, toggle "Diff only": first request shows
  full JSON, subsequent requests show body diffs, per-row buttons are
  hidden; toggle off returns to normal per-row expand/collapse behavior
  unchanged.

## Out of scope

- Persisting diff-only mode across reloads or between pages.
- Any width/theme setting affecting Home.tsx's create-listener card.
- A "system theme" (`prefers-color-scheme`) auto-detect option — default is
  always light, matching the equivalent explicit choice already made in
  `webrtc-dtmf`.
- Diffing headers/query params/source IP in diff-only mode (body-only, same
  as the existing per-row diff).
