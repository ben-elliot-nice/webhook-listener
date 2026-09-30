import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

// Mirrors scripts/preview-env/scrub.sql exactly. Duplicated (not read from
// disk) because backend tests run inside a workerd sandbox with no
// confirmed filesystem access — if you change one, change the other.
const SCRUB_STATEMENTS = [
  `UPDATE requests SET
    headers = '{}',
    query_params = '{}',
    body = NULL,
    source_ip = NULL`,
  `UPDATE listeners SET
    share_token = CASE WHEN share_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
    webhook_token = CASE WHEN webhook_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
    owner_session = NULL,
    owner_email = CASE WHEN owner_email IS NOT NULL THEN 'scrubbed-' || id || '@example.invalid' ELSE NULL END`,
  `UPDATE projects SET
    share_token = CASE WHEN share_token IS NOT NULL THEN hex(randomblob(16)) ELSE NULL END,
    owner_session = NULL,
    owner_email = CASE WHEN owner_email IS NOT NULL THEN 'scrubbed-' || id || '@example.invalid' ELSE NULL END`,
  `DELETE FROM magic_links`,
  `UPDATE shared_with_me SET
    viewer_email = 'scrubbed-' || id || '@example.invalid',
    token = hex(randomblob(16))`,
]

async function runScrub() {
  for (const statement of SCRUB_STATEMENTS) {
    await env.DB.prepare(statement).run()
  }
}

describe('preview environment scrub script', () => {
  it('nulls request payload content but preserves row shape', async () => {
    await env.DB.prepare(
      `INSERT INTO listeners (id, created_at) VALUES (?1, ?2)`,
    )
      .bind('listener-1', '2024-01-01T00:00:00.000Z')
      .run()

    await env.DB.prepare(
      `INSERT INTO requests (listener_id, method, headers, query_params, body, content_type, source_ip, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        'listener-1',
        'POST',
        '{"authorization":"secret"}',
        '{"token":"abc"}',
        'raw webhook body content',
        'application/json',
        '203.0.113.5',
        '2024-01-01T00:00:01.000Z',
      )
      .run()

    await runScrub()

    const row = (await env.DB.prepare(
      'SELECT * FROM requests WHERE listener_id = ?1',
    )
      .bind('listener-1')
      .first())!
    expect(row.headers).toBe('{}')
    expect(row.query_params).toBe('{}')
    expect(row.body).toBeNull()
    expect(row.source_ip).toBeNull()
    expect(row.method).toBe('POST')
    expect(row.content_type).toBe('application/json')
  })

  it('regenerates listener tokens and scrubs owner fields when set', async () => {
    await env.DB.prepare(
      `INSERT INTO listeners (id, created_at, share_token, webhook_token, owner_session, owner_email)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        'listener-2',
        '2024-01-01T00:00:00.000Z',
        'real-share-token',
        'real-webhook-token',
        'real-owner-session',
        'real-owner@example.com',
      )
      .run()

    await runScrub()

    const row = (await env.DB.prepare('SELECT * FROM listeners WHERE id = ?1')
      .bind('listener-2')
      .first())!
    expect(row.share_token).not.toBe('real-share-token')
    expect(row.share_token).toMatch(/^[0-9A-Fa-f]{32}$/)
    expect(row.webhook_token).not.toBe('real-webhook-token')
    expect(row.webhook_token).toMatch(/^[0-9A-Fa-f]{32}$/)
    expect(row.owner_session).toBeNull()
    expect(row.owner_email).toBe('scrubbed-listener-2@example.invalid')
  })

  it('leaves listener tokens NULL when they were already NULL', async () => {
    await env.DB.prepare(
      `INSERT INTO listeners (id, created_at) VALUES (?1, ?2)`,
    )
      .bind('listener-3', '2024-01-01T00:00:00.000Z')
      .run()

    await runScrub()

    const row = (await env.DB.prepare('SELECT * FROM listeners WHERE id = ?1')
      .bind('listener-3')
      .first())!
    expect(row.share_token).toBeNull()
    expect(row.webhook_token).toBeNull()
    expect(row.owner_email).toBeNull()
  })

  it('regenerates project share_token and scrubs owner fields when set', async () => {
    await env.DB.prepare(
      `INSERT INTO projects (id, created_at, owner_session, owner_email, share_token)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(
        'project-1',
        '2024-01-01T00:00:00.000Z',
        'real-owner-session',
        'real-owner@example.com',
        'real-project-share-token',
      )
      .run()

    await runScrub()

    const row = (await env.DB.prepare('SELECT * FROM projects WHERE id = ?1')
      .bind('project-1')
      .first())!
    expect(row.share_token).not.toBe('real-project-share-token')
    expect(row.share_token).toMatch(/^[0-9A-Fa-f]{32}$/)
    expect(row.owner_session).toBeNull()
    expect(row.owner_email).toBe('scrubbed-project-1@example.invalid')
  })

  it('deletes all magic_links rows', async () => {
    await env.DB.prepare(
      `INSERT INTO magic_links (token_hash, email, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(
        'hash-1',
        'real@example.com',
        '2024-01-01T01:00:00.000Z',
        '2024-01-01T00:00:00.000Z',
      )
      .run()

    await runScrub()

    const row = (await env.DB.prepare(
      'SELECT COUNT(*) as count FROM magic_links',
    ).first())!
    expect(row.count).toBe(0)
  })

  it('scrubs shared_with_me viewer_email and token', async () => {
    await env.DB.prepare(
      `INSERT INTO shared_with_me (viewer_email, kind, token, first_visited_at, last_visited_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(
        'real-viewer@example.com',
        'listener',
        'real-share-token',
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z',
      )
      .run()

    await runScrub()

    const row = (await env.DB.prepare('SELECT * FROM shared_with_me').first())!
    expect(row.viewer_email).toMatch(/^scrubbed-\d+@example\.invalid$/)
    expect(row.token).not.toBe('real-share-token')
    expect(row.token).toMatch(/^[0-9A-Fa-f]{32}$/)
  })
})
