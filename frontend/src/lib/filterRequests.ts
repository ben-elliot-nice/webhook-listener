import type { CapturedRequest } from '../api'

export interface RequestFilter {
  method: string
  contentType: string
  search: string
}

export const ALL = 'All'

export function filterRequests(requests: CapturedRequest[], filter: RequestFilter): CapturedRequest[] {
  const search = filter.search.trim().toLowerCase()

  return requests.filter((req) => {
    if (filter.method !== ALL && req.method !== filter.method) return false
    if (filter.contentType !== ALL && (req.contentType ?? 'none') !== filter.contentType) return false

    if (search) {
      const haystack = [req.body ?? '', JSON.stringify(req.headers), JSON.stringify(req.queryParams)]
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(search)) return false
    }

    return true
  })
}

export function uniqueMethods(requests: CapturedRequest[]): string[] {
  return [...new Set(requests.map((r) => r.method))].sort()
}

export function uniqueContentTypes(requests: CapturedRequest[]): string[] {
  return [...new Set(requests.map((r) => r.contentType ?? 'none'))].sort()
}
