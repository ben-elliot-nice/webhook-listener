const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

export interface Listener {
  id: string
  createdAt: string
  hookUrl: string
  shareUrl: string | null
}

export interface RequestDetail {
  id: number
  method: string
  headers: Record<string, string>
  queryParams: Record<string, string | string[]>
  body: string | null
  contentType: string | null
  sourceIp: string | null
  receivedAt: string
}

export interface CapturedRequest extends RequestDetail {
  listenerId: string
}

export interface ShareLink {
  shareToken: string
  shareUrl: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number) {
    super(`request failed with status ${status}`)
    this.status = status
  }
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiError(response.status)
  }
  return response.json() as Promise<T>
}

export function createListener(): Promise<Listener> {
  return fetch(`${API_BASE_URL}/api/listeners`, { method: 'POST', credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Listener>(r)
  )
}

export function getListener(id: string): Promise<Listener> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Listener>(r)
  )
}

export function listListeners(): Promise<Listener[]> {
  return fetch(`${API_BASE_URL}/api/listeners`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Listener[]>(r)
  )
}

export function getRequests(id: string): Promise<CapturedRequest[]> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/requests`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<CapturedRequest[]>(r)
  )
}

export async function deleteListener(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/listeners/${id}`, { method: 'DELETE', credentials: 'include' })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function getOrCreateShareLink(id: string): Promise<ShareLink> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/share`, { method: 'POST', credentials: 'include' }).then((r) =>
    parseJsonOrThrow<ShareLink>(r)
  )
}

export async function revokeShareLink(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/listeners/${id}/share`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function getSharedRequests(token: string): Promise<RequestDetail[]> {
  return fetch(`${API_BASE_URL}/api/shared/${token}/requests`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<RequestDetail[]>(r)
  )
}
