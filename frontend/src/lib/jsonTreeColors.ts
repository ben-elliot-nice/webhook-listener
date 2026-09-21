export interface JsonTreeColors {
  key: string
  string: string
  number: string
  boolean: string
  null: string
  punctuation: string
  text: string
}

const FALLBACK: JsonTreeColors = {
  key: '#9cdcfe',
  string: '#ce9178',
  number: '#b5cea8',
  boolean: '#569cd6',
  null: '#569cd6',
  punctuation: '#d4d4d4',
  text: '#d4d4d4',
}

/**
 * Prism JSON grammar tags tokens as property/string/number/boolean/keyword
 * (null is aliased to "keyword") — these keys are stable across the Prism
 * theme set, so we can pull matching colors out of whichever theme the
 * highlighter is currently using to keep the tree view visually consistent.
 */
export function extractJsonTreeColors(theme: Record<string, any> | undefined): JsonTreeColors {
  if (!theme) return FALLBACK
  const colorOf = (name: string): string | undefined => theme[name]?.color
  const base =
    colorOf('code[class*="language-"]') ?? colorOf('pre[class*="language-"]') ?? undefined

  return {
    key: colorOf('property') ?? base ?? FALLBACK.key,
    string: colorOf('string') ?? base ?? FALLBACK.string,
    number: colorOf('number') ?? base ?? FALLBACK.number,
    boolean: colorOf('boolean') ?? base ?? FALLBACK.boolean,
    null: colorOf('keyword') ?? colorOf('null') ?? base ?? FALLBACK.null,
    punctuation: colorOf('punctuation') ?? base ?? FALLBACK.punctuation,
    text: base ?? FALLBACK.text,
  }
}
