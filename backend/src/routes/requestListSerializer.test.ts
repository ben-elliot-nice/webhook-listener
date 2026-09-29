import { describe, it, expect } from 'vitest'
import { serializeRequestListItem, parsePageParams, BODY_PREVIEW_BYTES } from './requestListSerializer'
import type { RequestRecord } from '../requests.repo'

function makeRow(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 1,
    listenerId: 'listener-1',
    method: 'POST',
    headers: '{"x-test":"1"}',
    queryParams: '{"a":"b"}',
    body: 'hello',
    contentType: 'text/plain',
    sourceIp: '127.0.0.1',
    receivedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('serializeRequestListItem', () => {
  it('parses headers/queryParams and passes a small body through untruncated', () => {
    const item = serializeRequestListItem(makeRow())
    expect(item.headers).toEqual({ 'x-test': '1' })
    expect(item.queryParams).toEqual({ a: 'b' })
    expect(item.body).toBe('hello')
    expect(item.bodyTruncated).toBe(false)
    expect(item.bodySize).toBe(5)
  })

  it('passes a body of exactly BODY_PREVIEW_BYTES through untruncated', () => {
    const body = 'a'.repeat(BODY_PREVIEW_BYTES)
    const item = serializeRequestListItem(makeRow({ body }))
    expect(item.bodyTruncated).toBe(false)
    expect(item.body).toBe(body)
    expect(item.bodySize).toBe(BODY_PREVIEW_BYTES)
  })

  it('truncates a body one byte over BODY_PREVIEW_BYTES', () => {
    const body = 'a'.repeat(BODY_PREVIEW_BYTES + 1)
    const item = serializeRequestListItem(makeRow({ body }))
    expect(item.bodyTruncated).toBe(true)
    expect(item.body).toHaveLength(BODY_PREVIEW_BYTES)
    expect(item.bodySize).toBe(BODY_PREVIEW_BYTES + 1)
  })

  it('handles a null body without truncating', () => {
    const item = serializeRequestListItem(makeRow({ body: null }))
    expect(item.body).toBeNull()
    expect(item.bodyTruncated).toBe(false)
    expect(item.bodySize).toBe(0)
  })
})

describe('parsePageParams', () => {
  it('defaults to limit 20 with no before when both are undefined', () => {
    expect(parsePageParams(undefined, undefined)).toEqual({ limit: 20 })
  })

  it('parses valid limit and before', () => {
    expect(parsePageParams('5', '42')).toEqual({ limit: 5, before: 42 })
  })

  it('clamps a limit above 100 down to 100', () => {
    expect(parsePageParams('500', undefined)).toEqual({ limit: 100 })
  })

  it('falls back to the default limit for invalid input', () => {
    expect(parsePageParams('not-a-number', undefined)).toEqual({ limit: 20 })
    expect(parsePageParams('-5', undefined)).toEqual({ limit: 20 })
    expect(parsePageParams('0', undefined)).toEqual({ limit: 20 })
  })

  it('ignores an invalid before value (treated as first page)', () => {
    expect(parsePageParams('20', 'not-a-number')).toEqual({ limit: 20 })
    expect(parsePageParams('20', '-1')).toEqual({ limit: 20 })
  })
})
