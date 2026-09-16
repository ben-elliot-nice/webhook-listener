export interface Listener {
  id: string
  createdAt: string
  hookUrl: string
}

export interface CapturedRequest {
  id: number
  listenerId: string
  method: string
  headers: Record<string, string>
  queryParams: Record<string, string | string[]>
  body: string | null
  contentType: string | null
  sourceIp: string | null
  receivedAt: string
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
