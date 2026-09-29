import type { RequestRecord } from '../requests.repo'

export const BODY_PREVIEW_BYTES = 256 * 1024
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export interface RequestListItem {
  id: number
  method: string
  headers: Record<string, string>
  queryParams: Record<string, string | string[]>
  body: string | null
  bodyTruncated: boolean
  bodySize: number
  contentType: string | null
  sourceIp: string | null
  receivedAt: string
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function truncateToBytes(value: string, maxBytes: number): string {
  // Slicing at a byte boundary can cut a multi-byte UTF-8 character —
  // acceptable here since this is a truncated preview, not meant to
  // round-trip as valid text/JSON.
  const bytes = new TextEncoder().encode(value)
  return new TextDecoder().decode(bytes.slice(0, maxBytes))
}

export function serializeRequestListItem(row: RequestRecord): RequestListItem {
  const bodySize = row.body === null ? 0 : byteLength(row.body)
  const truncated = row.body !== null && bodySize > BODY_PREVIEW_BYTES

  return {
    id: row.id,
    method: row.method,
    headers: JSON.parse(row.headers),
    queryParams: JSON.parse(row.queryParams),
    body: truncated
      ? truncateToBytes(row.body as string, BODY_PREVIEW_BYTES)
      : row.body,
    bodyTruncated: truncated,
    bodySize,
    contentType: row.contentType,
    sourceIp: row.sourceIp,
    receivedAt: row.receivedAt,
  }
}

export function parsePageParams(
  rawLimit: string | undefined,
  rawBefore: string | undefined,
): { limit: number; before?: number } {
  const parsedLimit = Number(rawLimit)
  const limit =
    Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT

  const parsedBefore = Number(rawBefore)
  const before =
    Number.isInteger(parsedBefore) && parsedBefore > 0
      ? parsedBefore
      : undefined

  return before === undefined ? { limit } : { limit, before }
}
