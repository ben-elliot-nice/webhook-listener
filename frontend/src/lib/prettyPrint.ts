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
