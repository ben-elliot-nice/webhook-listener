import { Hono } from 'hono'
import type { Env } from '../env'
import type { Variables } from '../app'
import { createProject, getProjectsForOwner } from '../projects.repo'

function serializeProject(project: { id: string; createdAt: string }) {
  return { id: project.id, createdAt: project.createdAt }
}

export const projectRoutes = new Hono<{ Bindings: Env; Variables: Variables }>()

projectRoutes.post('/api/projects', async (c) => {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const project = await createProject(c.env.DB, id, createdAt, c.get('sessionId'))
  return c.json(serializeProject(project), 201)
})

projectRoutes.get('/api/projects', async (c) => {
  const projects = await getProjectsForOwner(c.env.DB, c.get('sessionId'))
  return c.json(projects.map(serializeProject))
})
