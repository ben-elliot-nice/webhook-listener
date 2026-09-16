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
  return fetch('/api/listeners', { method: 'POST' }).then((r) => parseJsonOrThrow<Listener>(r))
}

export function getListener(id: string): Promise<Listener> {
  return fetch(`/api/listeners/${id}`).then((r) => parseJsonOrThrow<Listener>(r))
}

export function getRequests(id: string): Promise<CapturedRequest[]> {
  return fetch(`/api/listeners/${id}/requests`).then((r) => parseJsonOrThrow<CapturedRequest[]>(r))
}

export async function deleteListener(id: string): Promise<void> {
  const response = await fetch(`/api/listeners/${id}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function getOrCreateShareLink(id: string): Promise<ShareLink> {
  return fetch(`/api/listeners/${id}/share`, { method: 'POST' }).then((r) => parseJsonOrThrow<ShareLink>(r))
}

export async function revokeShareLink(id: string): Promise<void> {
  const response = await fetch(`/api/listeners/${id}/share`, { method: 'DELETE' })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function getSharedRequests(token: string): Promise<RequestDetail[]> {
  return fetch(`/api/shared/${token}/requests`).then((r) => parseJsonOrThrow<RequestDetail[]>(r))
}
