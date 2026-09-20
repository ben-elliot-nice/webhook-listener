import type { RequestDetail } from '../api'
import { prettyPrintBody } from './prettyPrint'

function safeParse(body: string | null): unknown {
  if (!body) return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function toJsonExport(requests: RequestDetail[]): string {
  return JSON.stringify(
    requests.map((req) => ({
      method: req.method,
      headers: req.headers,
      queryParams: req.queryParams,
      contentType: req.contentType,
      sourceIp: req.sourceIp,
      receivedAt: req.receivedAt,
      body: safeParse(req.body),
    })),
    null,
    2
  )
}

function toHeaderEntries(headers: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}

function toQueryEntries(queryParams: Record<string, string | string[]>): { name: string; value: string }[] {
  return Object.entries(queryParams).flatMap(([name, value]) =>
    Array.isArray(value) ? value.map((v) => ({ name, value: v })) : [{ name, value }]
  )
}

export function toHarExport(requests: RequestDetail[], hookUrl: string = 'http://webhook-listener.invalid/hook/redacted'): string {
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'webhook-listener', version: '1.0' },
      entries: requests.map((req) => ({
        startedDateTime: req.receivedAt,
        time: 0,
        request: {
          method: req.method,
          url: hookUrl,
          httpVersion: 'HTTP/1.1',
          headers: toHeaderEntries(req.headers),
          queryString: toQueryEntries(req.queryParams),
          postData: req.body
            ? { mimeType: req.contentType ?? 'application/octet-stream', text: prettyPrintBody(req.body, { indentWidth: 2, compact: false }) }
            : undefined,
          headersSize: -1,
          bodySize: req.body?.length ?? 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [],
          content: { size: 0, mimeType: 'text/plain', text: '' },
          headersSize: -1,
          bodySize: 0,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      })),
    },
  }
  return JSON.stringify(har, null, 2)
}

export function downloadFile(filename: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
