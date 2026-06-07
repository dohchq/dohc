import { describe, expect, it } from 'vitest'
import {
  describeQueryView,
  formatQueryViewResult,
  humanizeQuery,
} from './AtomEditor'

describe('live query chrome', () => {
  it('does not label empty query fences as live data', () => {
    expect(humanizeQuery('')).toBeNull()
    expect(humanizeQuery('   \n\t')).toBeNull()
  })

  it('presents entity lists as human live queries, not raw query language', () => {
    expect(humanizeQuery('entities.list("project")')).toBe('Projects')
    expect(
      humanizeQuery('entities.list("project", { status: "active" })'),
    ).toBe('Projects · status: active')

    expect(describeQueryView('entities.list("person")')).toMatchObject({
      badge: 'Live query',
      title: 'People',
      sourceLabel: 'entities.list("person")',
      emptyText: 'No people yet.',
    })
    expect(describeQueryView('entities.find("project")')).toMatchObject({
      title: 'Project',
      loadingText: 'Loading project...',
      emptyText: 'Project not found.',
    })
  })

  it('turns query result states into calm user-facing messages', () => {
    const view = describeQueryView('entities.list("project")')!

    expect(formatQueryViewResult(undefined, view)).toEqual({
      kind: 'loading',
      text: 'Loading projects...',
    })
    expect(formatQueryViewResult({ value: null }, view)).toEqual({
      kind: 'error',
      text: "This live query couldn't update.",
    })
    expect(
      formatQueryViewResult(
        { unavailableText: 'Live queries need a workspace connection.' },
        view,
      ),
    ).toEqual({
      kind: 'unavailable',
      text: 'Live queries need a workspace connection.',
    })
    expect(formatQueryViewResult({ value: '_(nothing)_' }, view)).toEqual({
      kind: 'empty',
      text: 'No projects yet.',
    })
    expect(formatQueryViewResult({ value: '- **Build dohc**' }, view)).toEqual({
      kind: 'result',
      text: '- **Build dohc**',
    })
  })
})
