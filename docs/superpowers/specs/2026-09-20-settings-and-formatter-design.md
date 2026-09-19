# Settings (theme/width/formatter) & Formatter/Viewer Improvements — Design Spec

Date: 2026-09-20

## Purpose

Two backlog items from the 2026-09-19 brainstorming session, combined into one
spec because both are frontend-only and both touch the same UI surface (a
shared Settings modal, `RequestRow.tsx`'s detail/diff rendering):

1. **Settings (theme/width) & diff-only mode** — a previously-approved design
   (`2026-09-17-settings-and-diff-only-mode-design.md`) that was never
   implemented. No code from that spec exists in the repo (`frontend/src/lib/
   settings.ts`, `hooks/useSettings.tsx`, `components/AppLayout.tsx`,
   `components/SettingsModal.tsx` are all absent). This spec supersedes it —
   read this document only; the old one is historical context, not a
   second source of truth.
2. **Formatter/viewer improvements** — line numbers in the JSON formatter; a
   highlight-theme/indent/compact selector; and a fix for the diff view,
   which currently renders as a plain colored `<pre>` instead of reusing the
   syntax highlighter.

Both remain purely visual/frontend — no backend or API changes.

## 1. Settings (theme, width, formatter)

### Storage

`frontend/src/lib/settings.ts`:

```ts
type Theme = 'light' | 'dark'
type Width = 'narrow' | 'wide' | 'full'

interface Settings {
  theme: Theme
  width: Width
  highlightTheme: string   // key into HIGHLIGHT_THEME_NAMES, see §3
  indentWidth: 2 | 4
  compact: boolean
  lineNumbers: boolean
}
```

- `WIDTH_CLASSES: Record<Width, string>` — `narrow: 'max-w-3xl'`, `wide: 'max-w-5xl'`, `full: 'max-w-none'`.
- `DEFAULT_SETTINGS = { theme: 'light', width: 'narrow', highlightTheme: 'oneDark', indentWidth: 2, compact: false, lineNumbers: false }` — matches today's hardcoded look exactly (2-space indent, oneDark highlighter, no line numbers), so existing users see no change until they open Settings.
- `loadSettings()` / `saveSettings()` — read/write a single JSON blob under localStorage key `wl_settings`. Malformed/missing data, or a value missing one of the newer fields (e.g. an old blob saved before this spec), falls back to `DEFAULT_SETTINGS` for any missing key — no migration needed, nothing has ever shipped under this key.

### Context

`frontend/src/hooks/useSettings.tsx`:
- `SettingsProvider` — holds the full `Settings` object, seeded from `loadSettings()`. A `useEffect` persists to localStorage on every change and toggles the `dark` class on `document.documentElement` whenever `theme` changes.
- `useSettings()` — returns `{ ...settings, setTheme, setWidth, setHighlightTheme, setIndentWidth, setCompact, setLineNumbers }`.
- `main.tsx` wraps `<App />` in `<SettingsProvider>`.

### Flash-of-wrong-theme avoidance

A small synchronous inline `<script>` in `index.html`'s `<head>` (before `#root`/`main.tsx` load) reads `localStorage.wl_settings` and sets `document.documentElement.classList` accordingly — the same technique `webrtc-dtmf/public/index.html` already uses. Only `theme` needs this treatment (it's the only setting that affects paint before React mounts); `highlightTheme`/`indentWidth`/`compact`/`lineNumbers` only affect content inside `<RequestRow>`, which never renders before React mounts.

### Layout & modal

- `frontend/src/components/AppLayout.tsx` — a slim top bar (app name left, a settings cog `<button>` right) plus `<Outlet />`, rendering `<SettingsModal>` when open (local `useState` in the layout).
- `frontend/src/components/SettingsModal.tsx` — fixed-overlay centered card (`fixed inset-0 ... bg-black/50`, styled after `webrtc-dtmf`'s modal), containing four sections:
  - **Theme** — Light / Dark buttons, active one visually marked, calls `setTheme`.
  - **Width** — Narrow / Wide / Full buttons, calls `setWidth`.
  - **Formatter** (new) — a `<select>` of all 46 highlight themes (see §3), grouped alphabetically; Indent 2 / 4 buttons; a Compact checkbox/toggle; a Line numbers checkbox/toggle.
  - A close button.
- `App.tsx`: wrap the three existing routes in a parent `<Route element={<AppLayout />}>` so the cog/modal appear identically on `/`, `/listener/:id`, and `/shared/:token`.

### Dark mode retrofit

- `tailwind.config.js`: add `darkMode: 'class'`.
- `index.css`: body rule gets a `dark:bg-slate-900 dark:text-slate-100` pair.
- Every existing component with hardcoded light-only Tailwind classes (`Home.tsx`, `Listener.tsx`, `SharedListener.tsx`, `RequestRow.tsx`, `RequestFilters.tsx`, `AppLayout.tsx`, `SettingsModal.tsx`) gets `dark:` variants using Tailwind's built-in slate scale — dark surfaces `slate-800`/`slate-900`, light text `slate-100`/`slate-300`, borders `slate-700`. No new custom colors/theme tokens; status-color accents (emerald/blue/amber/rose badges, error banners) keep their existing hues but get darker background/lighter text `dark:` pairs so they stay legible on dark surfaces.
- The JSON/diff panel's background is no longer hardcoded (`bg-slate-900`) — see §3, it now derives from the selected highlight theme, independent of the app-wide light/dark toggle.

### Width application scope

`WIDTH_CLASSES[width]` replaces the hardcoded `max-w-3xl` on the `<main>` container in `Listener.tsx` and `SharedListener.tsx` only. `Home.tsx`'s centered `max-w-md` create-listener card is unaffected.

## 2. `prettyPrint.ts` — indent width & compact mode

```ts
function prettyPrintBody(
  body: string | null,
  opts: { indentWidth: number; compact: boolean }
): string
```

- Compact: `JSON.stringify(parsed)` — no whitespace at all.
- Pretty (default): `JSON.stringify(parsed, null, opts.indentWidth)`.
- Parse failure (non-JSON body): returns the raw string unchanged either way — `compact`/`indentWidth` have no meaning for non-JSON content.

Call sites (`RequestRow.tsx`'s detail-view JSON and the diff computation in §4) read `indentWidth`/`compact` from `useSettings()`. This is a breaking signature change to an existing function; it has exactly two call sites, both inside this spec's scope, updated together.

**Not affected:** `exportRequests.ts` (JSON/HAR export) keeps `JSON.stringify(x, null, 2)` regardless of display settings — exported files are for external tooling, not on-screen reading. Deliberate scope boundary.

## 3. Highlight theme registry & panel background

New `frontend/src/lib/highlightThemes.ts`:

- `HIGHLIGHT_THEME_NAMES: string[]` — the 46 style keys shipped under `react-syntax-highlighter/dist/esm/styles/prism/` (excluding `index`), committed as a plain literal array (the package exposes no manifest to derive this from at runtime or build time).
- `loadHighlightTheme(name: string): Promise<Record<string, any>>` — a lookup mapping each name to its own `import('react-syntax-highlighter/dist/esm/styles/prism/<name>')` call, so each theme is its own Vite chunk (46 tiny lazy chunks, not one bundled blob). Loaded objects are cached in a module-level `Map` after first fetch, so re-selecting a previously-used theme is instant.
- `getThemeBackground(theme: Record<string, any>): string` — reads the loaded theme's own background (from its `'pre[class*="language-"]'` or `'code[class*="language-"]'` entry).

**Fixing the "hardcoded background" bug:** today, `RequestRow.tsx` wraps `<SyntaxHighlighter>` in a `bg-slate-900` container while the `oneDark` theme object *also* carries its own inline `background: rgb(40, 44, 52)` on the code element — two competing sources of truth for the same visual property, one of which (`customStyle={{ background: 'transparent' }}`) only patches the outer `<pre>`, not the inner `<code>`. Going forward there is exactly one source of truth: the wrapper's background is set to `getThemeBackground(theme)` (i.e. whatever the *selected* theme intends), and `customStyle` on `<SyntaxHighlighter>` explicitly zeroes background on both `pre` and `code` via its style object override, so the theme's own background never renders directly — only the wrapper's does, driven by the same value.

`RequestRow.tsx` gets a small `useHighlightTheme(name: string)` hook wrapping `loadHighlightTheme` — returns `undefined` while a not-yet-cached theme is loading, in which case the previously-loaded theme (or the `oneDark` default on first paint) is shown until it resolves. No loading spinner — theme switches are a rare, deliberate user action on a personal tool, and the swap is near-instant after the very first load of a given theme.

## 4. Diff view — reusing the highlighter

### Problem

The current diff view (`RequestRow.tsx`'s "Diff vs previous" button, and the not-yet-built diff-only mode from §5) renders `diffLines()` output as a plain `<pre>` of colored `<span>` blocks — no syntax highlighting, no line numbers, and no respect for indent/compact/highlight-theme settings.

### Approach

One continuous `<SyntaxHighlighter>` instance renders the whole diff, with per-line background coloring layered on top of normal token-level syntax coloring, via `react-syntax-highlighter`'s `wrapLines` + `lineProps` API:

1. Run `diffLines(prettyPrintBody(previousRequest.body, opts), prettyPrintBody(request.body, opts))` as today.
2. Walk the returned parts in order, building two things: (a) one concatenated text blob of all lines (added, removed, and unchanged, in the exact sequence `diffLines` already returns them), and (b) a parallel array tagging each line index as `'added' | 'removed' | 'unchanged'`.
3. Render that blob through the same `<SyntaxHighlighter>` component and theme used for the non-diff detail view, with `wrapLines` enabled and `lineProps={(lineNumber) => ({ className: tagFor(lineNumber) })}`, where `tagFor` maps to `bg-emerald-900/40` (added), `bg-rose-900/40` (removed), or no class (unchanged).
4. `showLineNumbers` is passed straight through from the `lineNumbers` setting — because the whole diff is one highlighter instance, numbering is continuous across the full diff rather than restarting per chunk.

This is the only renderer for diff content going forward — both the existing per-row "Diff vs previous" button and the diff-only whole-list mode (§5) call it, so there's one implementation, not two.

**Alternative considered and rejected:** wrapping each `diffLines()` part in its own `<SyntaxHighlighter>` instance (one highlighter per chunk) is simpler to implement, but line numbers restart at 1 in every chunk when `lineNumbers` is on, which is actively misleading, and very short chunks (e.g. a single changed line) render as visually choppy separate panels. Rejected in favor of the single-instance approach above.

## 5. Diff-only mode

Unchanged from the original spec's design:

### Scope & persistence

A per-page, non-persisted view toggle — resets to off on every page load. Lives next to the existing Export JSON/HAR buttons in `Listener.tsx` and `SharedListener.tsx` as a "Diff only" toggle button (pressed/active state styled like an active filter).

### Data flow

Both pages already compute `previousByRequestId` (a `Map` from request id to its chronological predecessor). A new local `diffOnly: boolean` state is passed down as a prop to every `<RequestRow>` alongside the existing `previousRequest` prop.

### `RequestRow.tsx` changes

New `diffOnly?: boolean` prop. When `true`:
- The row ignores its local `expanded` state and always renders its content section (no click-to-expand/collapse — the header row's method/content-type/timestamp is still shown for context, but the `+`/`−` toggle affordance is removed since there's nothing left to toggle).
- The "Diff vs previous" / "Copy" button row is hidden entirely.
- Content:
  - If `previousRequest` exists: render the combined-highlighter diff view from §4.
  - If there is no `previousRequest` (the first/oldest request in the list): render the normal full pretty-printed detail JSON view (headers + query params + source IP + body) via the same highlighter/settings as the non-diff view.

When `diffOnly` is `false` (default), `RequestRow` behaves exactly as it does with today's expand/diff/copy flow, now using the §3/§4 renderers instead of the old hardcoded ones.

## Testing

No backend changes. This frontend has no automated test suite (established project scope). Verification is `cd frontend && npm run build` (TypeScript check, 0 errors) plus manual browser confirmation:

- Toggle Settings cog on `/`, `/listener/:id`, and `/shared/:token` — modal opens/closes identically on all three.
- Switch theme Light → Dark → Light: no flash on reload in either state, every page/component legible in both themes.
- Switch width Narrow → Wide → Full on a listener with several requests: container resizes, Home page's create-listener card is unaffected.
- Switch highlight theme via the Formatter select: panel background updates to match, no double-background flash, syntax coloring updates.
- Toggle Compact: body JSON renders as a single line; toggle back to pretty with Indent 4: body re-indents at 4 spaces.
- Toggle Line numbers: numbers appear on the detail view; open a diff (single-row or diff-only) and confirm numbering is continuous across the whole diff, not reset per chunk.
- On a listener with 3+ requests, toggle "Diff only": first request shows full detail JSON, subsequent requests show highlighted body diffs with per-row buttons hidden; toggle off returns to normal per-row expand/collapse behavior.
- Export JSON/HAR from a listener with Compact + Indent 4 set: exported file is still 2-space pretty JSON, unaffected by display settings.

## Out of scope

- Persisting diff-only mode across reloads or between pages.
- Any width/theme/formatter setting affecting Home.tsx's create-listener card.
- A "system theme" (`prefers-color-scheme`) auto-detect option.
- Diffing headers/query params/source IP in diff-only mode (body-only, same as the existing per-row diff).
- Per-request or per-page override of the global formatter settings — one set of preferences for the whole app.
- Virtualizing/windowing the highlighter for very large bodies — not requested, not needed at current scale.
