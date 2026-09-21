import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import {
  createListener,
  createProjectListener,
  getListener,
  getListenerForOwner,
  getListenersForOwner,
  getListenerByProjectAndSlug,
  getListenersByProject,
  reorderItems,
  deleteListener,
  getOrCreateShareToken,
  revokeShareToken,
  getListenerByShareToken,
  normalizeSlug,
  setListenerSlug,
  getListenerBySlug,
  SlugValidationError,
  SlugConflictError,
  rotateWebhookToken,
  removeListenerSlug,
  setListenerLabel,
  LabelValidationError,
  resolveListenerForHook,
} from './listeners.repo'
import { insertRequest } from './requests.repo'
import { createProject } from './projects.repo'

describe('listeners repo', () => {
  it('creates and fetches a listener', async () => {
    await createListener(env.DB, 'listener-1', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const found = await getListener(env.DB, 'listener-1')
    expect(found).toEqual({
      id: 'listener-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      shareToken: null,
      ownerSession: null,
      ownerEmail: 'owner-a@nice.com',
      slug: null,
      webhookToken: null,
      label: null,
      lastRequestAt: null,
      sortPosition: null,
      projectId: null,
    })
  })

  it('returns undefined for an unknown listener', async () => {
    expect(await getListener(env.DB, 'does-not-exist')).toBeUndefined()
  })

  it('deletes a listener and reports success', async () => {
    await createListener(env.DB, 'listener-1', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    expect(await deleteListener(env.DB, 'listener-1')).toBe(true)
    expect(await getListener(env.DB, 'listener-1')).toBeUndefined()
  })

  it('reports failure when deleting an unknown listener', async () => {
    expect(await deleteListener(env.DB, 'does-not-exist')).toBe(false)
  })
})

describe('getListenerForOwner', () => {
  it('returns the listener when the session matches its owner', async () => {
    await createListener(env.DB, 'listener-2', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const found = await getListenerForOwner(env.DB, 'listener-2', 'owner-a@nice.com')
    expect(found?.id).toBe('listener-2')
  })

  it('returns undefined when the session does not match', async () => {
    await createListener(env.DB, 'listener-3', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    expect(await getListenerForOwner(env.DB, 'listener-3', 'owner-b@nice.com')).toBeUndefined()
  })

  it('returns undefined for an unknown listener id', async () => {
    expect(await getListenerForOwner(env.DB, 'does-not-exist', 'owner-a@nice.com')).toBeUndefined()
  })

  it('returns undefined for a listener with no owner_session recorded (legacy row)', async () => {
    await env.DB.prepare("INSERT INTO listeners (id, created_at) VALUES ('legacy-listener', '2024-01-01T00:00:00.000Z')").run()
    expect(await getListenerForOwner(env.DB, 'legacy-listener', 'owner-a@nice.com')).toBeUndefined()
  })
})

describe('share tokens', () => {
  it('creates a share token on first call and reuses it on subsequent calls', async () => {
    await createListener(env.DB, 'listener-4', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const first = await getOrCreateShareToken(env.DB, 'listener-4')
    const second = await getOrCreateShareToken(env.DB, 'listener-4')
    expect(first).toBeTypeOf('string')
    expect(second).toBe(first)
  })

  it('returns undefined for an unknown listener', async () => {
    expect(await getOrCreateShareToken(env.DB, 'does-not-exist')).toBeUndefined()
  })

  it('looks up a listener by its share token', async () => {
    await createListener(env.DB, 'listener-5', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const token = (await getOrCreateShareToken(env.DB, 'listener-5')) as string
    const found = await getListenerByShareToken(env.DB, token)
    expect(found?.id).toBe('listener-5')
  })

  it('returns undefined for an unknown share token', async () => {
    expect(await getListenerByShareToken(env.DB, 'does-not-exist')).toBeUndefined()
  })

  it('revokes a share token', async () => {
    await createListener(env.DB, 'listener-6', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const token = (await getOrCreateShareToken(env.DB, 'listener-6')) as string
    expect(await revokeShareToken(env.DB, 'listener-6')).toBe(true)
    expect(await getListenerByShareToken(env.DB, token)).toBeUndefined()
  })

  it('reports failure when revoking an unknown listener', async () => {
    expect(await revokeShareToken(env.DB, 'does-not-exist')).toBe(false)
  })
})

describe('getListenersForOwner', () => {
  it("returns only the calling session's listeners, newest first", async () => {
    await createListener(env.DB, 'listener-7', '2024-01-01T00:00:00.000Z', 'owner-x@nice.com')
    await createListener(env.DB, 'listener-8', '2024-01-02T00:00:00.000Z', 'owner-x@nice.com')
    await createListener(env.DB, 'listener-9', '2024-01-03T00:00:00.000Z', 'owner-y@nice.com')

    const result = await getListenersForOwner(env.DB, 'owner-x@nice.com', 100)
    expect(result.map((l) => l.id)).toEqual(['listener-8', 'listener-7'])
  })

  it('returns an empty array for a session with no listeners', async () => {
    expect(await getListenersForOwner(env.DB, 'owner-with-nothing@nice.com', 100)).toEqual([])
  })

  it('respects the limit', async () => {
    await createListener(env.DB, 'listener-10', '2024-01-01T00:00:00.000Z', 'owner-z@nice.com')
    await createListener(env.DB, 'listener-11', '2024-01-02T00:00:00.000Z', 'owner-z@nice.com')
    await createListener(env.DB, 'listener-12', '2024-01-03T00:00:00.000Z', 'owner-z@nice.com')

    const result = await getListenersForOwner(env.DB, 'owner-z@nice.com', 2)
    expect(result).toHaveLength(2)
    expect(result.map((l) => l.id)).toEqual(['listener-12', 'listener-11'])
  })
})

describe('getListenersForOwner sort modes', () => {
  it('sorts by name, falling back to created_at for listeners with neither label nor slug', async () => {
    await createListener(env.DB, 'sort-name-1', '2024-01-01T00:00:00.000Z', 'owner-sort@nice.com')
    await createListener(env.DB, 'sort-name-2', '2024-01-02T00:00:00.000Z', 'owner-sort@nice.com')
    await createListener(env.DB, 'sort-name-3', '2024-01-03T00:00:00.000Z', 'owner-sort@nice.com')
    await setListenerLabel(env.DB, 'sort-name-2', 'Alpha')
    await setListenerLabel(env.DB, 'sort-name-1', 'Beta')

    const result = await getListenersForOwner(env.DB, 'owner-sort@nice.com', 100, 'name')
    expect(result.map((l) => l.id)).toEqual(['sort-name-2', 'sort-name-1', 'sort-name-3'])
  })

  it('sorts by activity, most recent request first, nulls last', async () => {
    await createListener(env.DB, 'sort-activity-1', '2024-01-01T00:00:00.000Z', 'owner-activity@nice.com')
    await createListener(env.DB, 'sort-activity-2', '2024-01-02T00:00:00.000Z', 'owner-activity@nice.com')
    await insertRequest(env.DB, {
      listenerId: 'sort-activity-1',
      method: 'GET',
      headers: '{}',
      queryParams: '{}',
      body: null,
      contentType: null,
      sourceIp: null,
      receivedAt: '2024-06-01T00:00:00.000Z',
    })

    const result = await getListenersForOwner(env.DB, 'owner-activity@nice.com', 100, 'activity')
    expect(result.map((l) => l.id)).toEqual(['sort-activity-1', 'sort-activity-2'])
  })

  it('sorts by custom position, unpositioned listeners last', async () => {
    await createListener(env.DB, 'sort-custom-1', '2024-01-01T00:00:00.000Z', 'owner-custom@nice.com')
    await createListener(env.DB, 'sort-custom-2', '2024-01-02T00:00:00.000Z', 'owner-custom@nice.com')
    await reorderItems(env.DB, 'owner-custom@nice.com', [
      { type: 'listener', id: 'sort-custom-2' },
      { type: 'listener', id: 'sort-custom-1' },
    ])

    const result = await getListenersForOwner(env.DB, 'owner-custom@nice.com', 100, 'custom')
    expect(result.map((l) => l.id)).toEqual(['sort-custom-2', 'sort-custom-1'])
  })

  it('defaults to date sort when no sort mode is given', async () => {
    await createListener(env.DB, 'sort-default-1', '2024-01-01T00:00:00.000Z', 'owner-default@nice.com')
    await createListener(env.DB, 'sort-default-2', '2024-01-02T00:00:00.000Z', 'owner-default@nice.com')
    const result = await getListenersForOwner(env.DB, 'owner-default@nice.com', 100)
    expect(result.map((l) => l.id)).toEqual(['sort-default-2', 'sort-default-1'])
  })
})

describe('reorderItems', () => {
  it('assigns sort positions in the given order', async () => {
    await createListener(env.DB, 'reorder-1', '2024-01-01T00:00:00.000Z', 'owner-reorder@nice.com')
    await createListener(env.DB, 'reorder-2', '2024-01-02T00:00:00.000Z', 'owner-reorder@nice.com')
    const ok = await reorderItems(env.DB, 'owner-reorder@nice.com', [
      { type: 'listener', id: 'reorder-2' },
      { type: 'listener', id: 'reorder-1' },
    ])
    expect(ok).toBe(true)
    const result = await getListenersForOwner(env.DB, 'owner-reorder@nice.com', 100, 'custom')
    expect(result.map((l) => l.id)).toEqual(['reorder-2', 'reorder-1'])
  })

  it('rejects an id that does not belong to the session, changing nothing', async () => {
    await createListener(env.DB, 'reorder-3', '2024-01-01T00:00:00.000Z', 'owner-owns@nice.com')
    await createListener(env.DB, 'reorder-4', '2024-01-01T00:00:00.000Z', 'owner-other@nice.com')
    const ok = await reorderItems(env.DB, 'owner-owns@nice.com', [
      { type: 'listener', id: 'reorder-3' },
      { type: 'listener', id: 'reorder-4' },
    ])
    expect(ok).toBe(false)
  })

  it('rejects an empty list', async () => {
    expect(await reorderItems(env.DB, 'owner-empty@nice.com', [])).toBe(false)
  })

  it('assigns sort positions across a mix of listeners and projects', async () => {
    await createListener(env.DB, 'reorder-mix-1', '2024-01-01T00:00:00.000Z', 'owner-mix@nice.com')
    await createProject(env.DB, 'reorder-mix-project', '2024-01-01T00:00:00.000Z', 'session-mix')
    // reorderItems now matches projects on owner_email; createProject doesn't take an
    // email param yet (that's a separate task), so set it directly for this test.
    await env.DB.prepare('UPDATE projects SET owner_email = ? WHERE id = ?')
      .bind('owner-mix@nice.com', 'reorder-mix-project')
      .run()
    const ok = await reorderItems(env.DB, 'owner-mix@nice.com', [
      { type: 'project', id: 'reorder-mix-project' },
      { type: 'listener', id: 'reorder-mix-1' },
    ])
    expect(ok).toBe(true)
  })

  it('rejects a project id that does not belong to the session, changing nothing', async () => {
    await createListener(env.DB, 'reorder-mix-2', '2024-01-01T00:00:00.000Z', 'owner-mix-owns@nice.com')
    await createProject(env.DB, 'reorder-mix-other-project', '2024-01-01T00:00:00.000Z', 'session-mix-other')
    const ok = await reorderItems(env.DB, 'owner-mix-owns@nice.com', [
      { type: 'listener', id: 'reorder-mix-2' },
      { type: 'project', id: 'reorder-mix-other-project' },
    ])
    expect(ok).toBe(false)
  })
})

describe('normalizeSlug', () => {
  it('lowercases and hyphenates spaces/underscores', () => {
    expect(normalizeSlug('Stripe_Prod')).toBe('stripe-prod')
    expect(normalizeSlug('My Webhook 2')).toBe('my-webhook-2')
  })

  it('strips invalid characters and collapses/trims hyphens', () => {
    expect(normalizeSlug('--My!!Webhook--')).toBe('mywebhook')
    expect(normalizeSlug('a__b   c')).toBe('a-b-c')
  })
})

describe('setListenerSlug', () => {
  it('sets a normalized slug and generates a webhook token', async () => {
    await createListener(env.DB, 'listener-slug-1', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const result = await setListenerSlug(env.DB, 'listener-slug-1', 'Stripe_Prod')
    expect(result.slug).toBe('stripe-prod')
    expect(result.webhookToken).toBeTypeOf('string')

    const found = await getListenerBySlug(env.DB, 'stripe-prod')
    expect(found?.id).toBe('listener-slug-1')
    expect(found?.webhookToken).toBe(result.webhookToken)
  })

  it('reuses the existing token when the slug value is changed', async () => {
    await createListener(env.DB, 'listener-slug-2', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const first = await setListenerSlug(env.DB, 'listener-slug-2', 'first-slug')
    const second = await setListenerSlug(env.DB, 'listener-slug-2', 'second-slug')
    expect(second.webhookToken).toBe(first.webhookToken)
  })

  it('rejects a slug that normalizes below the minimum length', async () => {
    await createListener(env.DB, 'listener-slug-3', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    await expect(setListenerSlug(env.DB, 'listener-slug-3', 'ab')).rejects.toThrow(SlugValidationError)
  })

  it('rejects an empty-after-normalization slug', async () => {
    await createListener(env.DB, 'listener-slug-4', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    await expect(setListenerSlug(env.DB, 'listener-slug-4', '!!!')).rejects.toThrow(SlugValidationError)
  })

  it('rejects a slug already used by another listener', async () => {
    await createListener(env.DB, 'listener-slug-5', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    await createListener(env.DB, 'listener-slug-6', '2024-01-01T00:00:00.000Z', 'owner-b@nice.com')
    await setListenerSlug(env.DB, 'listener-slug-5', 'taken-slug')
    await expect(setListenerSlug(env.DB, 'listener-slug-6', 'taken-slug')).rejects.toThrow(SlugConflictError)
  })

  it('rejects a slug that collides with another listener\'s id', async () => {
    await createListener(env.DB, 'listener-slug-7', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    await createListener(env.DB, 'listener-slug-8', '2024-01-01T00:00:00.000Z', 'owner-b@nice.com')
    await expect(setListenerSlug(env.DB, 'listener-slug-8', 'listener-slug-7')).rejects.toThrow(SlugConflictError)
  })
})

describe('getListenerBySlug', () => {
  it('returns undefined for an unknown slug', async () => {
    expect(await getListenerBySlug(env.DB, 'no-such-slug')).toBeUndefined()
  })
})

describe('rotateWebhookToken', () => {
  it('generates a new token, replacing the old one', async () => {
    await createListener(env.DB, 'listener-rotate-1', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const { webhookToken: original } = await setListenerSlug(env.DB, 'listener-rotate-1', 'rotate-me')
    const rotated = await rotateWebhookToken(env.DB, 'listener-rotate-1')
    expect(rotated).toBeTypeOf('string')
    expect(rotated).not.toBe(original)
  })

  it('returns undefined when the listener has no slug set', async () => {
    await createListener(env.DB, 'listener-rotate-2', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    expect(await rotateWebhookToken(env.DB, 'listener-rotate-2')).toBeUndefined()
  })
})

describe('removeListenerSlug', () => {
  it('clears slug and token, reporting success', async () => {
    await createListener(env.DB, 'listener-remove-1', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    await setListenerSlug(env.DB, 'listener-remove-1', 'remove-me')
    expect(await removeListenerSlug(env.DB, 'listener-remove-1')).toBe(true)
    const found = await getListener(env.DB, 'listener-remove-1')
    expect(found?.slug).toBeNull()
    expect(found?.webhookToken).toBeNull()
  })

  it('reports failure for an unknown listener', async () => {
    expect(await removeListenerSlug(env.DB, 'does-not-exist')).toBe(false)
  })
})

describe('setListenerLabel', () => {
  it('sets a trimmed label', async () => {
    await createListener(env.DB, 'listener-label-1', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    expect(await setListenerLabel(env.DB, 'listener-label-1', '  Stripe prod  ')).toBe('Stripe prod')
  })

  it('clears the label when given an empty string', async () => {
    await createListener(env.DB, 'listener-label-2', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    await setListenerLabel(env.DB, 'listener-label-2', 'Something')
    expect(await setListenerLabel(env.DB, 'listener-label-2', '')).toBeNull()
  })

  it('rejects a label over 100 characters', async () => {
    await createListener(env.DB, 'listener-label-3', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    await expect(setListenerLabel(env.DB, 'listener-label-3', 'x'.repeat(101))).rejects.toThrow(LabelValidationError)
  })
})

describe('resolveListenerForHook', () => {
  it('resolves by UUID when no slug is set, no token required', async () => {
    await createListener(env.DB, 'listener-hook-1', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const found = await resolveListenerForHook(env.DB, 'listener-hook-1', undefined)
    expect(found?.id).toBe('listener-hook-1')
  })

  it('resolves by slug when the correct token is provided', async () => {
    await createListener(env.DB, 'listener-hook-2', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const { slug, webhookToken } = await setListenerSlug(env.DB, 'listener-hook-2', 'hook-slug')
    const found = await resolveListenerForHook(env.DB, slug, webhookToken)
    expect(found?.id).toBe('listener-hook-2')
  })

  it('rejects a slug lookup with a missing token', async () => {
    await createListener(env.DB, 'listener-hook-3', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const { slug } = await setListenerSlug(env.DB, 'listener-hook-3', 'hook-slug-2')
    expect(await resolveListenerForHook(env.DB, slug, undefined)).toBeUndefined()
  })

  it('rejects a slug lookup with a wrong token', async () => {
    await createListener(env.DB, 'listener-hook-4', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    const { slug } = await setListenerSlug(env.DB, 'listener-hook-4', 'hook-slug-3')
    expect(await resolveListenerForHook(env.DB, slug, 'wrong-token')).toBeUndefined()
  })

  it('rejects UUID lookup once a slug has been set on that listener', async () => {
    await createListener(env.DB, 'listener-hook-5', '2024-01-01T00:00:00.000Z', 'owner-a@nice.com')
    await setListenerSlug(env.DB, 'listener-hook-5', 'hook-slug-4')
    expect(await resolveListenerForHook(env.DB, 'listener-hook-5', undefined)).toBeUndefined()
  })

  it('returns undefined for a path param matching neither slug nor id', async () => {
    expect(await resolveListenerForHook(env.DB, 'nothing-matches', undefined)).toBeUndefined()
  })
})

describe('project-scoped listeners', () => {
  it('createProjectListener sets project_id and slug, with a null webhookToken', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    const id = crypto.randomUUID()
    const listener = await createProjectListener(env.DB, id, new Date().toISOString(), null, 'owner-a@nice.com', project.id, 'checkout-uat')
    expect(listener.projectId).toBe(project.id)
    expect(listener.slug).toBe('checkout-uat')
    expect(listener.webhookToken).toBeNull()
  })

  it('getListenerByProjectAndSlug finds a listener scoped to its project', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    const id = crypto.randomUUID()
    await createProjectListener(env.DB, id, new Date().toISOString(), null, 'owner-a@nice.com', project.id, 'checkout-uat')

    const found = await getListenerByProjectAndSlug(env.DB, project.id, 'checkout-uat')
    expect(found?.id).toBe(id)
  })

  it('the same slug string is allowed under two different projects', async () => {
    const projectA = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    const projectB = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')

    const listenerA = await createProjectListener(
      env.DB, crypto.randomUUID(), new Date().toISOString(), null, 'owner-a@nice.com', projectA.id, 'checkout-uat'
    )
    const listenerB = await createProjectListener(
      env.DB, crypto.randomUUID(), new Date().toISOString(), null, 'owner-a@nice.com', projectB.id, 'checkout-uat'
    )

    expect(listenerA.id).not.toBe(listenerB.id)
    expect(await getListenerByProjectAndSlug(env.DB, projectA.id, 'checkout-uat')).toMatchObject({ id: listenerA.id })
    expect(await getListenerByProjectAndSlug(env.DB, projectB.id, 'checkout-uat')).toMatchObject({ id: listenerB.id })
  })

  it('setListenerSlug on a project-scoped listener only conflicts within its own project', async () => {
    const projectA = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    const projectB = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-a')
    await createProjectListener(env.DB, crypto.randomUUID(), new Date().toISOString(), null, 'owner-a@nice.com', projectA.id, 'taken')

    const listenerInProjectB = await createProjectListener(
      env.DB, crypto.randomUUID(), new Date().toISOString(), null, 'owner-a@nice.com', projectB.id, 'free-slug'
    )
    await expect(setListenerSlug(env.DB, listenerInProjectB.id, 'taken')).resolves.toMatchObject({ slug: 'taken' })
  })

  it('setListenerSlug still conflicts globally for non-project listeners', async () => {
    const first = await createListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'owner-a@nice.com')
    await setListenerSlug(env.DB, first.id, 'global-taken')
    const second = await createListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'owner-a@nice.com')
    await expect(setListenerSlug(env.DB, second.id, 'global-taken')).rejects.toThrow(SlugConflictError)
  })
})

describe('getListenersByProject', () => {
  it('returns only listeners for the given project, newest first', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-k')
    const older = await createProjectListener(
      env.DB, crypto.randomUUID(), '2026-01-01T00:00:00.000Z', null, 'owner-k@nice.com', project.id, 'case-a'
    )
    const newer = await createProjectListener(
      env.DB, crypto.randomUUID(), '2026-01-02T00:00:00.000Z', null, 'owner-k@nice.com', project.id, 'case-b'
    )
    await createListener(env.DB, crypto.randomUUID(), new Date().toISOString(), 'owner-k@nice.com')

    const results = await getListenersByProject(env.DB, project.id)
    expect(results.map((l) => l.id)).toEqual([newer.id, older.id])
  })

  it('returns an empty list for a project with no listeners', async () => {
    const project = await createProject(env.DB, crypto.randomUUID(), new Date().toISOString(), 'session-l')
    const results = await getListenersByProject(env.DB, project.id)
    expect(results).toEqual([])
  })
})
