#!/usr/bin/env node
const MARKER_PREFIX = '<!-- preview-env:'

export function buildCommentBody({
  prNumber,
  databaseId,
  status,
  backendUrl,
  frontendUrl,
  runUrl,
}) {
  const marker = `${MARKER_PREFIX}${prNumber} db-id:${databaseId ?? 'none'} -->`
  const lines = [marker, '### 🔗 Preview environment', '']

  if (status === 'provisioned') {
    lines.push(`- Backend: ${backendUrl}`)
    lines.push(`- Frontend: ${frontendUrl}`)
    lines.push('')
    lines.push(`Status: provisioned ✅ · [workflow run](${runUrl})`)
  } else if (status === 'failed') {
    lines.push(`Status: provisioning failed ❌ · [workflow run](${runUrl})`)
  } else if (status === 'torn-down') {
    lines.push(`Status: torn down 🧹 · [workflow run](${runUrl})`)
  } else {
    throw new Error(`Unknown status: ${status}`)
  }

  return lines.join('\n')
}

export function findExistingComment(comments, prNumber) {
  const prefix = `${MARKER_PREFIX}${prNumber} `
  return comments.find((comment) => comment.body.startsWith(prefix)) ?? null
}

// Exported for documentation/debugging value — nothing in this plan calls
// it. See the plan's Global Constraints for why the comment-marker-based
// database id lookup was dropped in favor of provision.mjs always calling
// findD1DatabaseIdByName directly.
export function extractDatabaseId(commentBody) {
  const match = commentBody.match(/db-id:([^\s]+) -->/)
  if (!match || match[1] === 'none') {
    return null
  }
  return match[1]
}

async function githubFetch(path, options = {}) {
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (!token || !repo) {
    throw new Error(
      'GITHUB_TOKEN and GITHUB_REPOSITORY environment variables are required',
    )
  }
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (!response.ok) {
    throw new Error(
      `GitHub API ${path} failed: ${response.status} ${await response.text()}`,
    )
  }
  return response.status === 204 ? null : response.json()
}

async function upsertComment({
  prNumber,
  databaseId,
  status,
  backendUrl,
  frontendUrl,
  runUrl,
}) {
  const comments = await githubFetch(`/issues/${prNumber}/comments`)
  const existing = findExistingComment(comments, prNumber)
  const body = buildCommentBody({
    prNumber,
    databaseId,
    status,
    backendUrl,
    frontendUrl,
    runUrl,
  })

  if (existing) {
    await githubFetch(`/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    })
  } else {
    await githubFetch(`/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  if (command === 'upsert') {
    const [prNumber, status, backendUrl, frontendUrl, databaseId, runUrl] = args
    await upsertComment({
      prNumber,
      status,
      backendUrl,
      frontendUrl,
      databaseId: databaseId || null,
      runUrl,
    })
    return
  }

  console.error(
    'Usage: upsert-comment.mjs upsert <pr> <status> <backendUrl> <frontendUrl> <databaseId> <runUrl>',
  )
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
