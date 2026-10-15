import { describe, expect, it } from 'vitest'
import type { Project } from '../api'
import {
  appendPage,
  isPagedSort,
  mergeFirstPage,
  moveItem,
  sortProjects,
} from './listPaging'

const item = (id: string) => ({ id })

describe('isPagedSort', () => {
  it('pages date and activity only', () => {
    expect(isPagedSort('date')).toBe(true)
    expect(isPagedSort('activity')).toBe(true)
    expect(isPagedSort('name')).toBe(false)
    expect(isPagedSort('custom')).toBe(false)
  })
})

describe('mergeFirstPage', () => {
  it('puts the fresh first page first and keeps later-page rows after it, without duplicates', () => {
    const current = [item('a'), item('b'), item('c'), item('d')]
    const firstPage = [item('c'), item('a')] // c gained activity and jumped up
    expect(mergeFirstPage(current, firstPage).map((i) => i.id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ])
  })

  it('adds brand new rows at the front', () => {
    expect(
      mergeFirstPage([item('a')], [item('n'), item('a')]).map((i) => i.id),
    ).toEqual(['n', 'a'])
  })

  it('replaces in-place data with the fresh copy', () => {
    const fresh = { id: 'a', label: 'new' }
    const merged = mergeFirstPage([{ id: 'a', label: 'old' }], [fresh])
    expect(merged[0]).toBe(fresh)
  })
})

describe('appendPage', () => {
  it('appends only unseen rows', () => {
    expect(
      appendPage([item('a'), item('b')], [item('b'), item('c')]).map(
        (i) => i.id,
      ),
    ).toEqual(['a', 'b', 'c'])
  })
})

describe('moveItem', () => {
  const list = [item('a'), item('b'), item('c'), item('d')]

  it('moves before the target', () => {
    expect(moveItem(list, 'd', 'b', true)?.map((i) => i.id)).toEqual([
      'a',
      'd',
      'b',
      'c',
    ])
  })

  it('moves after the target, recomputing the index after removal', () => {
    expect(moveItem(list, 'a', 'c', false)?.map((i) => i.id)).toEqual([
      'b',
      'c',
      'a',
      'd',
    ])
  })

  it('returns null for unknown ids and does not mutate the input', () => {
    expect(moveItem(list, 'x', 'b', true)).toBeNull()
    expect(moveItem(list, 'a', 'x', true)).toBeNull()
    expect(list.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('sortProjects', () => {
  const p = (id: string, over: Partial<Project> = {}): Project => ({
    id,
    createdAt: '2024-01-01T00:00:00.000Z',
    hookUrlTemplate: '',
    sortPosition: null,
    label: null,
    shareUrl: null,
    ...over,
  })

  it('date and activity: newest created first', () => {
    const projects = [
      p('old', { createdAt: '2024-01-01T00:00:00.000Z' }),
      p('new', { createdAt: '2024-03-01T00:00:00.000Z' }),
    ]
    expect(sortProjects('date', projects).map((x) => x.id)).toEqual([
      'new',
      'old',
    ])
    expect(sortProjects('activity', projects).map((x) => x.id)).toEqual([
      'new',
      'old',
    ])
  })

  it('name: case-insensitive label, unlabeled last', () => {
    const projects = [
      p('none'),
      p('b', { label: 'bravo' }),
      p('a', { label: 'Alpha' }),
    ]
    expect(sortProjects('name', projects).map((x) => x.id)).toEqual([
      'a',
      'b',
      'none',
    ])
  })

  it('custom: by sortPosition, unpositioned last by created date', () => {
    const projects = [
      p('np-old', { createdAt: '2024-01-01T00:00:00.000Z' }),
      p('two', { sortPosition: 2 }),
      p('np-new', { createdAt: '2024-05-01T00:00:00.000Z' }),
      p('zero', { sortPosition: 0 }),
    ]
    expect(sortProjects('custom', projects).map((x) => x.id)).toEqual([
      'zero',
      'two',
      'np-new',
      'np-old',
    ])
  })

  it('does not mutate its input', () => {
    const projects = [
      p('a', { createdAt: '2024-01-01T00:00:00.000Z' }),
      p('b', { createdAt: '2024-02-01T00:00:00.000Z' }),
    ]
    sortProjects('date', projects)
    expect(projects.map((x) => x.id)).toEqual(['a', 'b'])
  })
})
