import type { JsonTreeColors } from '../lib/jsonTreeColors'

type PathSegment = string | number

interface JsonTreeProps {
  value: unknown
  colors: JsonTreeColors
  collapsedPaths: Set<string>
  onToggle: (pathKey: string) => void
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

interface NodeProps {
  path: PathSegment[]
  keyLabel?: string
  value: unknown
  colors: JsonTreeColors
  collapsedPaths: Set<string>
  onToggle: (pathKey: string) => void
  isLast: boolean
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

function JsonNode({ path, keyLabel, value, colors, collapsedPaths, onToggle, isLast }: NodeProps) {
  const key = pathKeyOf(path)

  if (!isContainer(value)) {
    return (
      <div>
        <KeyPrefix keyLabel={keyLabel} colors={colors} />
        <Primitive value={value} colors={colors} />
        {!isLast && <span style={{ color: colors.punctuation }}>,</span>}
      </div>
    )
  }

  const entries = entriesOf(value)
  const openBracket = Array.isArray(value) ? '[' : '{'
  const closeBracket = Array.isArray(value) ? ']' : '}'

  if (entries.length === 0) {
    return (
      <div>
        <KeyPrefix keyLabel={keyLabel} colors={colors} />
        <span style={{ color: colors.punctuation }}>
          {openBracket}
          {closeBracket}
        </span>
        {!isLast && <span style={{ color: colors.punctuation }}>,</span>}
      </div>
    )
  }

  const collapsed = collapsedPaths.has(key)

  return (
    <div>
      <div>
        <button
          type="button"
          onClick={() => onToggle(key)}
          className="mr-1 select-none text-slate-400 hover:text-slate-200"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <KeyPrefix keyLabel={keyLabel} colors={colors} />
        <span style={{ color: colors.punctuation }}>{openBracket}</span>
        {collapsed && (
          <>
            <span className="text-slate-400"> {containerSummary(value)} </span>
            <span style={{ color: colors.punctuation }}>{closeBracket}</span>
            {!isLast && <span style={{ color: colors.punctuation }}>,</span>}
          </>
        )}
      </div>
      {!collapsed && (
        <>
          <div className="pl-4">
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
              />
            ))}
          </div>
          <div>
            <span style={{ color: colors.punctuation }}>{closeBracket}</span>
            {!isLast && <span style={{ color: colors.punctuation }}>,</span>}
          </div>
        </>
      )}
    </div>
  )
}

export function JsonTree({ value, colors, collapsedPaths, onToggle }: JsonTreeProps) {
  return (
    <div className="font-mono text-sm">
      <JsonNode
        path={[]}
        value={value}
        colors={colors}
        collapsedPaths={collapsedPaths}
        onToggle={onToggle}
        isLast
      />
    </div>
  )
}
