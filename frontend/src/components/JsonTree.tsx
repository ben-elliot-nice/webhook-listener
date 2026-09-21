import type { ReactNode } from 'react'
import type { JsonTreeColors } from '../lib/jsonTreeColors'

type PathSegment = string | number

interface JsonTreeProps {
  value: unknown
  colors: JsonTreeColors
  collapsedPaths: Set<string>
  onToggle: (pathKey: string) => void
  indentWidth: number
  showLineNumbers: boolean
}

export function pathKeyOf(path: PathSegment[]): string {
  return JSON.stringify(path)
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null
}

function entriesOf(value: Record<string, unknown> | unknown[]): [PathSegment, unknown][] {
  return Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value)
}

/** Every container path in the tree that has at least one entry — used for "collapse all". */
export function collectContainerPaths(value: unknown, path: PathSegment[] = []): string[] {
  if (!isContainer(value)) return []
  const entries = entriesOf(value)
  if (entries.length === 0) return []
  const paths = [pathKeyOf(path)]
  for (const [key, child] of entries) {
    paths.push(...collectContainerPaths(child, [...path, key]))
  }
  return paths
}

function containerSummary(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  const count = Object.keys(value).length
  return `${count} key${count === 1 ? '' : 's'}`
}

function Primitive({ value, colors }: { value: unknown; colors: JsonTreeColors }) {
  if (typeof value === 'string') return <span style={{ color: colors.string }}>"{value}"</span>
  if (typeof value === 'number') return <span style={{ color: colors.number }}>{value}</span>
  if (typeof value === 'boolean') return <span style={{ color: colors.boolean }}>{String(value)}</span>
  if (value === null) return <span style={{ color: colors.null }}>null</span>
  return <span style={{ color: colors.text }}>{String(value)}</span>
}

function KeyPrefix({ keyLabel, colors }: { keyLabel?: string; colors: JsonTreeColors }) {
  if (keyLabel === undefined) return null
  return (
    <>
      <span style={{ color: colors.key }}>"{keyLabel}"</span>
      <span style={{ color: colors.punctuation }}>: </span>
    </>
  )
}

interface LineProps {
  depth: number
  indentWidth: number
  showLineNumbers: boolean
  nextLine: () => number
  children: ReactNode
}

/**
 * Calls nextLine() from its own render body rather than taking a
 * precomputed number — as a lazily-rendered element, React only invokes
 * this at the point it walks to it in the tree, which keeps numbering in
 * true document order even though the tree is built by recursion.
 */
function Line({ depth, indentWidth, showLineNumbers, nextLine, children }: LineProps) {
  const lineNumber = nextLine()
  return (
    <div className="flex">
      {showLineNumbers && (
        <span className="mr-3 min-w-[2.5em] shrink-0 select-none text-right text-slate-400 dark:text-slate-500">
          {lineNumber}
        </span>
      )}
      <span style={{ paddingLeft: `${depth * indentWidth}ch`, whiteSpace: 'pre' }}>{children}</span>
    </div>
  )
}

interface NodeProps {
  path: PathSegment[]
  keyLabel?: string
  value: unknown
  colors: JsonTreeColors
  collapsedPaths: Set<string>
  onToggle: (pathKey: string) => void
  isLast: boolean
  depth: number
  indentWidth: number
  showLineNumbers: boolean
  nextLine: () => number
}

function JsonNode({
  path,
  keyLabel,
  value,
  colors,
  collapsedPaths,
  onToggle,
  isLast,
  depth,
  indentWidth,
  showLineNumbers,
  nextLine,
}: NodeProps) {
  const key = pathKeyOf(path)
  const lineProps = { depth, indentWidth, showLineNumbers, nextLine }

  if (!isContainer(value)) {
    return (
      <Line {...lineProps}>
        <KeyPrefix keyLabel={keyLabel} colors={colors} />
        <Primitive value={value} colors={colors} />
        {!isLast && <span style={{ color: colors.punctuation }}>,</span>}
      </Line>
    )
  }

  const entries = entriesOf(value)
  const openBracket = Array.isArray(value) ? '[' : '{'
  const closeBracket = Array.isArray(value) ? ']' : '}'

  if (entries.length === 0) {
    return (
      <Line {...lineProps}>
        <KeyPrefix keyLabel={keyLabel} colors={colors} />
        <span style={{ color: colors.punctuation }}>
          {openBracket}
          {closeBracket}
        </span>
        {!isLast && <span style={{ color: colors.punctuation }}>,</span>}
      </Line>
    )
  }

  const collapsed = collapsedPaths.has(key)

  if (collapsed) {
    return (
      <Line {...lineProps}>
        <button
          type="button"
          onClick={() => onToggle(key)}
          className="mr-1 select-none text-slate-400 hover:text-slate-200"
          aria-label="Expand"
        >
          ▸
        </button>
        <KeyPrefix keyLabel={keyLabel} colors={colors} />
        <span style={{ color: colors.punctuation }}>{openBracket}</span>
        <span className="text-slate-400"> {containerSummary(value)} </span>
        <span style={{ color: colors.punctuation }}>{closeBracket}</span>
        {!isLast && <span style={{ color: colors.punctuation }}>,</span>}
      </Line>
    )
  }

  return (
    <>
      <Line {...lineProps}>
        <button
          type="button"
          onClick={() => onToggle(key)}
          className="mr-1 select-none text-slate-400 hover:text-slate-200"
          aria-label="Collapse"
        >
          ▾
        </button>
        <KeyPrefix keyLabel={keyLabel} colors={colors} />
        <span style={{ color: colors.punctuation }}>{openBracket}</span>
      </Line>
      {entries.map(([entryKey, entryValue], i) => (
        <JsonNode
          key={String(entryKey)}
          path={[...path, entryKey]}
          keyLabel={Array.isArray(value) ? undefined : String(entryKey)}
          value={entryValue}
          colors={colors}
          collapsedPaths={collapsedPaths}
          onToggle={onToggle}
          isLast={i === entries.length - 1}
          depth={depth + 1}
          indentWidth={indentWidth}
          showLineNumbers={showLineNumbers}
          nextLine={nextLine}
        />
      ))}
      <Line {...lineProps}>
        <span style={{ color: colors.punctuation }}>{closeBracket}</span>
        {!isLast && <span style={{ color: colors.punctuation }}>,</span>}
      </Line>
    </>
  )
}

export function JsonTree({
  value,
  colors,
  collapsedPaths,
  onToggle,
  indentWidth,
  showLineNumbers,
}: JsonTreeProps) {
  let counter = 0
  const nextLine = () => ++counter

  return (
    <div className="font-mono text-sm">
      <JsonNode
        path={[]}
        value={value}
        colors={colors}
        collapsedPaths={collapsedPaths}
        onToggle={onToggle}
        isLast
        depth={0}
        indentWidth={indentWidth}
        showLineNumbers={showLineNumbers}
        nextLine={nextLine}
      />
    </div>
  )
}
