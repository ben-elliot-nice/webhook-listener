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

async function importTheme(name: string): Promise<{ default: Record<string, any> }> {
  switch (name) {
    case 'a11y-dark':
      return import('react-syntax-highlighter/dist/esm/styles/prism/a11y-dark.js' as any)
    case 'a11y-one-light':
      return import('react-syntax-highlighter/dist/esm/styles/prism/a11y-one-light.js' as any)
    case 'atom-dark':
      return import('react-syntax-highlighter/dist/esm/styles/prism/atom-dark.js' as any)
    case 'base16-ateliersulphurpool.light':
      return import(
        'react-syntax-highlighter/dist/esm/styles/prism/base16-ateliersulphurpool.light.js' as any
      )
    case 'cb':
      return import('react-syntax-highlighter/dist/esm/styles/prism/cb.js' as any)
    case 'coldark-cold':
      return import('react-syntax-highlighter/dist/esm/styles/prism/coldark-cold.js' as any)
    case 'coldark-dark':
      return import('react-syntax-highlighter/dist/esm/styles/prism/coldark-dark.js' as any)
    case 'coy-without-shadows':
      return import('react-syntax-highlighter/dist/esm/styles/prism/coy-without-shadows.js' as any)
    case 'coy':
      return import('react-syntax-highlighter/dist/esm/styles/prism/coy.js' as any)
    case 'darcula':
      return import('react-syntax-highlighter/dist/esm/styles/prism/darcula.js' as any)
    case 'dark':
      return import('react-syntax-highlighter/dist/esm/styles/prism/dark.js' as any)
    case 'dracula':
      return import('react-syntax-highlighter/dist/esm/styles/prism/dracula.js' as any)
    case 'duotone-dark':
      return import('react-syntax-highlighter/dist/esm/styles/prism/duotone-dark.js' as any)
    case 'duotone-earth':
      return import('react-syntax-highlighter/dist/esm/styles/prism/duotone-earth.js' as any)
    case 'duotone-forest':
      return import('react-syntax-highlighter/dist/esm/styles/prism/duotone-forest.js' as any)
    case 'duotone-light':
      return import('react-syntax-highlighter/dist/esm/styles/prism/duotone-light.js' as any)
    case 'duotone-sea':
      return import('react-syntax-highlighter/dist/esm/styles/prism/duotone-sea.js' as any)
    case 'duotone-space':
      return import('react-syntax-highlighter/dist/esm/styles/prism/duotone-space.js' as any)
    case 'funky':
      return import('react-syntax-highlighter/dist/esm/styles/prism/funky.js' as any)
    case 'ghcolors':
      return import('react-syntax-highlighter/dist/esm/styles/prism/ghcolors.js' as any)
    case 'gruvbox-dark':
      return import('react-syntax-highlighter/dist/esm/styles/prism/gruvbox-dark.js' as any)
    case 'gruvbox-light':
      return import('react-syntax-highlighter/dist/esm/styles/prism/gruvbox-light.js' as any)
    case 'holi-theme':
      return import('react-syntax-highlighter/dist/esm/styles/prism/holi-theme.js' as any)
    case 'hopscotch':
      return import('react-syntax-highlighter/dist/esm/styles/prism/hopscotch.js' as any)
    case 'lucario':
      return import('react-syntax-highlighter/dist/esm/styles/prism/lucario.js' as any)
    case 'material-dark':
      return import('react-syntax-highlighter/dist/esm/styles/prism/material-dark.js' as any)
    case 'material-light':
      return import('react-syntax-highlighter/dist/esm/styles/prism/material-light.js' as any)
    case 'material-oceanic':
      return import('react-syntax-highlighter/dist/esm/styles/prism/material-oceanic.js' as any)
    case 'night-owl':
      return import('react-syntax-highlighter/dist/esm/styles/prism/night-owl.js' as any)
    case 'nord':
      return import('react-syntax-highlighter/dist/esm/styles/prism/nord.js' as any)
    case 'okaidia':
      return import('react-syntax-highlighter/dist/esm/styles/prism/okaidia.js' as any)
    case 'one-dark':
      return import('react-syntax-highlighter/dist/esm/styles/prism/one-dark.js' as any)
    case 'one-light':
      return import('react-syntax-highlighter/dist/esm/styles/prism/one-light.js' as any)
    case 'pojoaque':
      return import('react-syntax-highlighter/dist/esm/styles/prism/pojoaque.js' as any)
    case 'prism':
      return import('react-syntax-highlighter/dist/esm/styles/prism/prism.js' as any)
    case 'shades-of-purple':
      return import('react-syntax-highlighter/dist/esm/styles/prism/shades-of-purple.js' as any)
    case 'solarized-dark-atom':
      return import('react-syntax-highlighter/dist/esm/styles/prism/solarized-dark-atom.js' as any)
    case 'solarizedlight':
      return import('react-syntax-highlighter/dist/esm/styles/prism/solarizedlight.js' as any)
    case 'synthwave84':
      return import('react-syntax-highlighter/dist/esm/styles/prism/synthwave84.js' as any)
    case 'tomorrow':
      return import('react-syntax-highlighter/dist/esm/styles/prism/tomorrow.js' as any)
    case 'twilight':
      return import('react-syntax-highlighter/dist/esm/styles/prism/twilight.js' as any)
    case 'vs-dark':
      return import('react-syntax-highlighter/dist/esm/styles/prism/vs-dark.js' as any)
    case 'vs':
      return import('react-syntax-highlighter/dist/esm/styles/prism/vs.js' as any)
    case 'vsc-dark-plus':
      return import('react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus.js' as any)
    case 'xonokai':
      return import('react-syntax-highlighter/dist/esm/styles/prism/xonokai.js' as any)
    case 'z-touch':
      return import('react-syntax-highlighter/dist/esm/styles/prism/z-touch.js' as any)
    default:
      throw new Error(`Unknown highlight theme: ${name}`)
  }
}

export async function loadHighlightTheme(name: string): Promise<Record<string, any>> {
  const cached = cache.get(name)
  if (cached) return cached
  const mod = await importTheme(name)
  const theme = mod.default
  cache.set(name, theme)
  return theme
}

export function getThemeBackground(theme: Record<string, any>): string {
  const codeStyle = theme['pre[class*="language-"]'] ?? theme['code[class*="language-"]']
  return codeStyle?.background ?? codeStyle?.backgroundColor ?? 'transparent'
}
