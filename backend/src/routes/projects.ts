import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import {
  createProject,
  getProjectsForOwner,
  getProjectForOwner,
  setProjectLabel,
  getOrCreateProjectShareToken,
  revokeProjectShareToken,
  deleteProject,
  type ProjectRecord,
} from '../projects.repo'
import { LabelValidationError } from '../listeners.repo'

function projectShareUrlFor(appBaseUrl: string, shareToken: string | null): string | null {
  return shareToken ? `${appBaseUrl}/shared/projects/${shareToken}` : null
}

function serializeProject(env: Env, project: ProjectRecord) {
  return {
    id: project.id,
    createdAt: project.createdAt,
    hookUrlTemplate: `${env.HOOK_BASE_URL}/hook/${project.id}/<identifier>`,
    sortPosition: project.sortPosition,
    label: project.label,
    shareUrl: projectShareUrlFor(env.APP_BASE_URL, project.shareToken),
  }
}

export const projectRoutes = new Hono<{ Bindings: Env; Variables: Variables }>()

projectRoutes.post('/api/projects', async (c) => {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const project = await createProject(c.env.DB, id, createdAt, c.get('sessionId'))
  return c.json(serializeProject(c.env, project), 201)
})

projectRoutes.get('/api/projects', async (c) => {
  const projects = await getProjectsForOwner(c.env.DB, c.get('sessionId'))
  return c.json(projects.map((project) => serializeProject(c.env, project)))
})

projectRoutes.patch('/api/projects/:id/label', async (c) => {
  const project = await getProjectForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }

  const body = await c.req.json<{ label?: unknown }>().catch(() => ({}) as { label?: unknown })
  if (typeof body.label !== 'string') {
    return c.json({ error: 'label is required (use an empty string to clear it)' }, 400)
  }

  try {
    const label = await setProjectLabel(c.env.DB, project.id, body.label)
    return c.json({ label })
  } catch (err) {
    if (err instanceof LabelValidationError) {
      return c.json({ error: err.message }, 400)
    }
    throw err
  }
})

projectRoutes.post('/api/projects/:id/share', async (c) => {
  const project = await getProjectForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }
  const token = (await getOrCreateProjectShareToken(c.env.DB, project.id)) as string
  return c.json({ shareToken: token, shareUrl: projectShareUrlFor(c.env.APP_BASE_URL, token) })
})

projectRoutes.delete('/api/projects/:id/share', async (c) => {
  const project = await getProjectForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }
  await revokeProjectShareToken(c.env.DB, project.id)
  return c.body(null, 204)
})

projectRoutes.delete('/api/projects/:id', async (c) => {
  const project = await getProjectForOwner(c.env.DB, c.req.param('id'), c.get('sessionId'))
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }
  await deleteProject(c.env.DB, project.id)
  return c.body(null, 204)
})
