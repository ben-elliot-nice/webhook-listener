import { useState } from 'react'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import type { RequestDetail } from '../api'
import { prettyPrintBody } from '../lib/prettyPrint'
import { useSettings } from '../hooks/useSettings'
import { useHighlightTheme } from '../hooks/useHighlightTheme'
import { getThemeBackground } from '../lib/highlightThemes'
import { buildDiffBlob, diffLineClassName } from '../lib/diffHighlight'

SyntaxHighlighter.registerLanguage('json', json)

const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  POST: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  PUT: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  PATCH: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  DELETE: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
}

const DEFAULT_METHOD_STYLE = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'

function safeParse(body: string | null): unknown {
  if (!body) return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

interface RequestRowProps {
  request: RequestDetail
  previousRequest?: RequestDetail
  diffOnly?: boolean
}

export function RequestRow({ request, previousRequest, diffOnly = false }: RequestRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [copied, setCopied] = useState(false)
  const methodStyle = METHOD_STYLES[request.method] ?? DEFAULT_METHOD_STYLE
  const { highlightTheme, indentWidth, compact, lineNumbers } = useSettings()
  const loadedTheme = useHighlightTheme(highlightTheme)
  const panelBackground = loadedTheme ? getThemeBackground(loadedTheme) : 'transparent'

  const detailObject = {
    headers: request.headers,
    queryParams: request.queryParams,
    sourceIp: request.sourceIp,
    body: safeParse(request.body),
  }
  const detailJson = compact
    ? JSON.stringify(detailObject)
    : JSON.stringify(detailObject, null, indentWidth)

  const diffBlob = previousRequest
    ? buildDiffBlob(
        prettyPrintBody(previousRequest.body, { indentWidth, compact }),
        prettyPrintBody(request.body, { indentWidth, compact })
      )
    : null

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(detailJson)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard write failed silently — no error state plumbed through for this per-row action
    }
  }

  return (
    <li className="rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
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
    </li>
  )
}
