#!/usr/bin/env node
const MARKER_PREFIX = '<!-- preview-env:'

export function buildCommentBody({
  prNumber,
  status,
  backendUrl,
  frontendUrl,
  runUrl,
  supersededBy,
  heldBy,
}) {
  const lines = [
    `${MARKER_PREFIX}${prNumber} -->`,
    '### 🔗 Staging preview',
    '',
  ]

  if (status === 'provisioned') {
    lines.push(`- Backend: ${backendUrl}`)
    lines.push(`- Frontend: ${frontendUrl}`)
    lines.push('')
    lines.push(
      'This is the shared staging environment: its database is wiped when the `preview` label is added (pushes keep your data), and the most recently labelled PR holds it.',
    )
    lines.push('')
    lines.push(`Status: provisioned ✅ · [workflow run](${runUrl})`)
  } else if (status === 'failed') {
    lines.push(`Status: deploy failed ❌ · [workflow run](${runUrl})`)
  } else if (status === 'superseded') {
    lines.push(
      `Status: superseded by #${supersededBy} ⏭️ · [workflow run](${runUrl})`,
    )
  } else if (status === 'inactive') {
    lines.push(`Status: no longer active 🧹 · [workflow run](${runUrl})`)
  } else if (status === 'not-holder') {
    const holder = heldBy
      ? `staging is held by #${heldBy}`
      : 'staging has no recorded holder'
    lines.push(`Status: ${holder} ⏸️ · [workflow run](${runUrl})`)
    lines.push('')
    lines.push(
      'This push was not deployed. To take staging over (this wipes its database), remove and re-add the `preview` label.',
    )
  } else {
    throw new Error(`Unknown status: ${status}`)
  }

  return lines.join('\n')
}

export function findExistingComment(comments, prNumber) {
  const prefix = `${MARKER_PREFIX}${prNumber} `
  return comments.find((comment) => comment.body.startsWith(prefix)) ?? null
}

// Only a provisioned comment means "this PR currently holds staging".
export function isActiveComment(body) {
  return body.includes('Status: provisioned')
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

function listComments(prNumber) {
  return githubFetch(`/issues/${prNumber}/comments?per_page=100`)
}

async function upsertComment(prNumber, fields) {
  const existing = findExistingComment(await listComments(prNumber), prNumber)
  const body = buildCommentBody({ prNumber, ...fields })
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

// Rewrites the comment of every *other* open PR that still claims staging.
async function supersedeOthers(currentPr, runUrl) {
  const issues = await githubFetch(
    '/issues?labels=preview&state=open&per_page=100',
  )
  for (const issue of issues) {
    const prNumber = String(issue.number)
    if (prNumber === currentPr) continue
    const existing = findExistingComment(await listComments(prNumber), prNumber)
    if (!existing || !isActiveComment(existing.body)) continue
    await githubFetch(`/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        body: buildCommentBody({
          prNumber,
          status: 'superseded',
          runUrl,
          supersededBy: currentPr,
        }),
      }),
    })
  }
}

// Label removed or PR closed: staging is left alone, but if this PR was the
// holder its comment must stop advertising live URLs. A comment that was
// already superseded or failed is left as it is.
async function deactivate(prNumber, runUrl) {
  const existing = findExistingComment(await listComments(prNumber), prNumber)
  if (!existing || !isActiveComment(existing.body)) return
  await githubFetch(`/issues/comments/${existing.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      body: buildCommentBody({ prNumber, status: 'inactive', runUrl }),
    }),
  })
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  if (command === 'upsert') {
    const [prNumber, status, backendUrl, frontendUrl, runUrl, otherPr] = args
    await upsertComment(prNumber, {
      status,
      backendUrl,
      frontendUrl,
      runUrl,
      supersededBy: otherPr || undefined,
      heldBy: otherPr || undefined,
    })
    return
  }
  if (command === 'supersede-others') {
    const [currentPr, runUrl] = args
    await supersedeOthers(currentPr, runUrl)
    return
  }
  if (command === 'deactivate') {
    const [prNumber, runUrl] = args
    await deactivate(prNumber, runUrl)
    return
  }

  console.error(
    'Usage: upsert-comment.mjs upsert <pr> <status> <backendUrl> <frontendUrl> <runUrl> [otherPr]\n' +
      '       upsert-comment.mjs supersede-others <currentPr> <runUrl>\n' +
      '       upsert-comment.mjs deactivate <pr> <runUrl>',
  )
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
