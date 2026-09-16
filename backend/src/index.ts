import { createDb } from './db'
import { buildServer } from './server'

const port = Number(process.env.PORT ?? 3000)
const dbPath = process.env.DB_PATH ?? './webhook-listener.db'
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`

const db = createDb(dbPath)
const app = buildServer({ db, baseUrl })

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
