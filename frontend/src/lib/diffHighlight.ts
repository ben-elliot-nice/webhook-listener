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
