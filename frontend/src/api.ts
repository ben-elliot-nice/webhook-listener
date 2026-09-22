const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

export interface Listener {
  id: string
  createdAt: string
  hookUrl: string
  shareUrl: string | null
  slug: string | null
  label: string | null
  projectId: string | null
  sortPosition: number | null
}

export interface Project {
  id: string
  createdAt: string
  hookUrlTemplate: string
  sortPosition: number | null
  label: string | null
  shareUrl: string | null
}

export interface SharedProjectListener {
  id: string
  label: string | null
  slug: string | null
  createdAt: string
}

export interface ReorderItem {
  type: 'listener' | 'project'
  id: string
}

export type SortMode = 'date' | 'name' | 'activity' | 'custom'

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

export function requestMagicLink(email: string, returnTo?: string): Promise<{ message: string }> {
  return fetch(`${API_BASE_URL}/auth/request-link`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, returnTo }),
  }).then((r) => parseJsonOrThrow<{ message: string }>(r))
}

export function getMe(): Promise<{ email: string }> {
  return fetch(`${API_BASE_URL}/auth/me`, { credentials: 'include' }).then((r) => parseJsonOrThrow<{ email: string }>(r))
}

export async function logout(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
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

export function listListeners(sort: SortMode = 'date'): Promise<Listener[]> {
  return fetch(`${API_BASE_URL}/api/listeners?sort=${sort}`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Listener[]>(r)
  )
}

export function createProject(): Promise<Project> {
  return fetch(`${API_BASE_URL}/api/projects`, { method: 'POST', credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Project>(r)
  )
}

export function listProjects(): Promise<Project[]> {
  return fetch(`${API_BASE_URL}/api/projects`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<Project[]>(r)
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

export interface SlugResult {
  slug: string
  webhookToken: string
  hookUrl: string
}

export function setSlug(id: string, slug: string): Promise<SlugResult> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/slug`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug }),
  }).then((r) => parseJsonOrThrow<SlugResult>(r))
}

export function rotateWebhookToken(id: string): Promise<{ webhookToken: string }> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/slug/rotate-token`, {
    method: 'POST',
    credentials: 'include',
  }).then((r) => parseJsonOrThrow<{ webhookToken: string }>(r))
}

export async function removeSlug(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/listeners/${id}/slug`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function setLabel(id: string, label: string): Promise<{ label: string | null }> {
  return fetch(`${API_BASE_URL}/api/listeners/${id}/label`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  }).then((r) => parseJsonOrThrow<{ label: string | null }>(r))
}

export async function reorderItems(orderedItems: ReorderItem[]): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/listeners/reorder`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderedItems }),
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function setProjectLabel(id: string, label: string): Promise<{ label: string | null }> {
  return fetch(`${API_BASE_URL}/api/projects/${id}/label`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  }).then((r) => parseJsonOrThrow<{ label: string | null }>(r))
}

export function getOrCreateProjectShareLink(id: string): Promise<ShareLink> {
  return fetch(`${API_BASE_URL}/api/projects/${id}/share`, { method: 'POST', credentials: 'include' }).then((r) =>
    parseJsonOrThrow<ShareLink>(r)
  )
}

export async function revokeProjectShareLink(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${id}/share`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${id}`, { method: 'DELETE', credentials: 'include' })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status)
  }
}

export function createProjectListener(projectId: string, slug: string): Promise<Listener> {
  return fetch(`${API_BASE_URL}/api/projects/${projectId}/listeners`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug }),
  }).then((r) => parseJsonOrThrow<Listener>(r))
}

export function getSharedProject(token: string): Promise<SharedProjectListener[]> {
  return fetch(`${API_BASE_URL}/api/shared/projects/${token}`, { credentials: 'include' }).then((r) =>
    parseJsonOrThrow<SharedProjectListener[]>(r)
  )
}

export function getSharedProjectListenerRequests(token: string, listenerId: string): Promise<RequestDetail[]> {
  return fetch(`${API_BASE_URL}/api/shared/projects/${token}/listeners/${listenerId}/requests`, {
    credentials: 'include',
  }).then((r) => parseJsonOrThrow<RequestDetail[]>(r))
}
