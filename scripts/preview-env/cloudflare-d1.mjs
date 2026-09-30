#!/usr/bin/env node

const API_BASE = 'https://api.cloudflare.com/client/v4'

export async function createD1Database({
  accountId,
  name,
  apiToken,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `${API_BASE}/accounts/${accountId}/d1/database`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    },
  )
  if (!response.ok) {
    throw new Error(
      `Failed to create D1 database ${name}: ${response.status} ${await response.text()}`,
    )
  }
  const json = await response.json()
  return json.result.uuid
}

export async function findD1DatabaseIdByName({
  accountId,
  name,
  apiToken,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `${API_BASE}/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`,
    {
      headers: { Authorization: `Bearer ${apiToken}` },
    },
  )
  if (!response.ok) {
    throw new Error(
      `Failed to list D1 databases: ${response.status} ${await response.text()}`,
    )
  }
  const json = await response.json()
  const match = json.result.find((db) => db.name === name)
  return match ? match.uuid : null
}

export async function deleteD1Database({
  accountId,
  databaseId,
  apiToken,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `${API_BASE}/accounts/${accountId}/d1/database/${databaseId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    },
  )
  if (!response.ok) {
    throw new Error(
      `Failed to delete D1 database ${databaseId}: ${response.status} ${await response.text()}`,
    )
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2)
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !apiToken) {
    console.error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required',
    )
    process.exit(1)
  }
  if (command === 'create') {
    console.log(await createD1Database({ accountId, name: arg, apiToken }))
    return
  }
  if (command === 'find') {
    console.log(
      (await findD1DatabaseIdByName({ accountId, name: arg, apiToken })) ?? '',
    )
    return
  }
  if (command === 'delete') {
    await deleteD1Database({ accountId, databaseId: arg, apiToken })
    console.log(`Deleted D1 database ${arg}`)
    return
  }
  console.error(
    'Usage: cloudflare-d1.mjs create <name> | find <name> | delete <database-id>',
  )
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
