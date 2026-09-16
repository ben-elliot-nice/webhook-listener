import { useState } from 'react'
import type { CapturedRequest } from '../api'

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

export function RequestRow({ request }: { request: CapturedRequest }) {
  const [expanded, setExpanded] = useState(false)
  const methodStyle = METHOD_STYLES[request.method] ?? DEFAULT_METHOD_STYLE

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
        <pre className="overflow-x-auto rounded-b-lg border-t border-slate-200 bg-slate-900 p-4 text-xs text-slate-100">
          {JSON.stringify(
            {
              headers: request.headers,
              queryParams: request.queryParams,
              sourceIp: request.sourceIp,
              body: safeParse(request.body),
            },
            null,
            2
          )}
        </pre>
      )}
    </li>
  )
}
