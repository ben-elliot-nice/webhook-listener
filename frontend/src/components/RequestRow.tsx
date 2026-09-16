import { useState } from 'react'
import { diffLines } from 'diff'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'
import type { CapturedRequest } from '../api'
import { prettyPrintBody } from '../lib/prettyPrint'

SyntaxHighlighter.registerLanguage('json', json)

const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-emerald-100 text-emerald-700',
  POST: 'bg-blue-100 text-blue-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-amber-100 text-amber-700',
  DELETE: 'bg-rose-100 text-rose-700',
}

const DEFAULT_METHOD_STYLE = 'bg-slate-100 text-slate-700'

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
  request: CapturedRequest
  previousRequest?: CapturedRequest
}

export function RequestRow({ request, previousRequest }: RequestRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const methodStyle = METHOD_STYLES[request.method] ?? DEFAULT_METHOD_STYLE

  const detailJson = JSON.stringify(
    {
      headers: request.headers,
      queryParams: request.queryParams,
      sourceIp: request.sourceIp,
      body: safeParse(request.body),
    },
    null,
    2
  )

  const diffParts = previousRequest
    ? diffLines(prettyPrintBody(previousRequest.body), prettyPrintBody(request.body))
    : null

  return (
    <li className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${methodStyle}`}>
          {request.method}
        </span>
        <span className="flex-1 truncate text-sm text-slate-600">
          {request.contentType ?? 'no content-type'}
        </span>
        <span className="shrink-0 text-xs text-slate-400">{formatTimestamp(request.receivedAt)}</span>
        <span className="shrink-0 text-slate-400">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="rounded-b-lg border-t border-slate-200 bg-slate-900">
          {previousRequest && (
            <div className="flex justify-end px-2 pt-2">
              <button
                onClick={() => setShowDiff((v) => !v)}
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
              >
                {showDiff ? 'Hide diff' : 'Diff vs previous'}
              </button>
            </div>
          )}
          {showDiff && diffParts ? (
            <pre className="overflow-x-auto whitespace-pre-wrap px-4 pb-4 text-xs">
              {diffParts.map((part, i) => (
                <span
                  key={i}
                  className={
                    part.added
                      ? 'block bg-emerald-900/40 text-emerald-300'
                      : part.removed
                        ? 'block bg-rose-900/40 text-rose-300'
                        : 'block text-slate-400'
                  }
                >
                  {part.value}
                </span>
              ))}
            </pre>
          ) : (
            <SyntaxHighlighter
              language="json"
              style={oneDark}
              customStyle={{ background: 'transparent', margin: 0, padding: '1rem' }}
            >
              {detailJson}
            </SyntaxHighlighter>
          )}
        </div>
      )}
    </li>
  )
}
