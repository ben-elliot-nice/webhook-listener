import type { ReactNode } from 'react'
import type { JsonTreeColors } from '../lib/jsonTreeColors'
import type { StripeIntensity } from '../lib/settings'

type PathSegment = string | number

export interface JsonTreeOptions {
  indentWidth: number
  showLineNumbers: boolean
  render: boolean
  wrap: boolean
  stripedRows: boolean
  stripeIntensity: StripeIntensity
}

const STRIPE_CLASSES: Record<StripeIntensity, string> = {
  subtle: 'bg-black/5 dark:bg-white/5',
  medium: 'bg-black/10 dark:bg-white/10',
  strong: 'bg-black/20 dark:bg-white/20',
}

interface JsonTreeProps {
  value: unknown
  colors: JsonTreeColors
  collapsedPaths: Set<string>
  onToggle: (pathKey: string) => void
  options: JsonTreeOptions
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

function Primitive({ value, colors, render }: { value: unknown; colors: JsonTreeColors; render: boolean }) {
  if (typeof value === 'string') {
    // render=false: full JSON escaping (accurate, matches raw wire format).
    // render=true: the raw string as-is, so real \n/\t become actual breaks
    // once the Line's white-space CSS is set to preserve them.
    return <span style={{ color: colors.string }}>{render ? `"${value}"` : JSON.stringify(value)}</span>
  }
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
  options: JsonTreeOptions
  nextLine: () => number
  arrow?: ReactNode
  children: ReactNode
}

/**
 * Calls nextLine() from its own render body rather than taking a
 * precomputed number — as a lazily-rendered element, React only invokes
 * this at the point it walks to it in the tree, which keeps numbering in
 * true document order even though the tree is built by recursion.
 *
 * The collapse arrow gets its own fixed-width column, to the left of the
 * line-number gutter, so it stays left-justified regardless of nesting
 * depth or whether line numbers are on.
 */
function Line({ depth, options, nextLine, arrow, children }: LineProps) {
  const lineNumber = nextLine()
  const striped = options.stripedRows && lineNumber % 2 === 0

  return (
    <div className={`flex items-start${striped ? ` ${STRIPE_CLASSES[options.stripeIntensity]}` : ''}`}>
      <span className="mr-1 inline-block w-4 shrink-0 select-none text-center text-slate-400">{arrow}</span>
      {options.showLineNumbers && (
        <span className="mr-3 min-w-[2.5em] shrink-0 select-none text-right text-slate-400 dark:text-slate-500">
          {lineNumber}
        </span>
      )}
      <span
        className={options.wrap ? 'min-w-0 flex-1 break-words' : ''}
        style={{
          paddingLeft: `${depth * options.indentWidth}ch`,
          whiteSpace: options.wrap ? 'pre-wrap' : 'pre',
        }}
      >
        {children}
      </span>
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
  options: JsonTreeOptions
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
  options,
  nextLine,
}: NodeProps) {
  const key = pathKeyOf(path)
  const lineProps = { depth, options, nextLine }

  if (!isContainer(value)) {
    return (
      <Line {...lineProps}>
        <KeyPrefix keyLabel={keyLabel} colors={colors} />
        <Primitive value={value} colors={colors} render={options.render} />
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

  const toggleButton = (label: string, glyph: string) => (
    <button
      type="button"
      onClick={() => onToggle(key)}
      className="select-none hover:text-slate-200"
      aria-label={label}
    >
      {glyph}
    </button>
  )

  if (collapsed) {
    return (
      <Line {...lineProps} arrow={toggleButton('Expand', '▸')}>
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
      <Line {...lineProps} arrow={toggleButton('Collapse', '▾')}>
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
          options={options}
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

export function JsonTree({ value, colors, collapsedPaths, onToggle, options }: JsonTreeProps) {
  let counter = 0
  const nextLine = () => ++counter

  return (
    <div className="inline-block min-w-full font-mono text-sm">
      <JsonNode
        path={[]}
        value={value}
        colors={colors}
        collapsedPaths={collapsedPaths}
        onToggle={onToggle}
        isLast
        depth={0}
        options={options}
        nextLine={nextLine}
      />
    </div>
  )
}
