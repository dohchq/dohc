import { describe, expect, it } from 'vitest'
import {
  agentRailChangeSummary,
  agentRailScopedFiles,
  isWithinProject,
} from '../components/AgentRunRail'

describe('AgentRunRail scope', () => {
  it('filters rail files to the active project when a project chat is selected', () => {
    const files = [
      { path: 'dohc/home.html', type: 'html' as const },
      { path: 'dohc/notes.md' },
      { path: 'dohcness/notes.md' },
      { path: 'opnft-fun/plan.md' },
      { path: '.runs/setup.md' },
    ]

    expect(agentRailScopedFiles(files, 'dohc').map((file) => file.path)).toEqual([
      'dohc/home.html',
      'dohc/notes.md',
    ])
  })

  it('keeps the rail workspace-wide when the chat has no project', () => {
    const files = [{ path: 'dohc/notes.md' }, { path: 'scratch.md' }]

    expect(agentRailScopedFiles(files, null)).toEqual(files)
  })

  it('does not treat similarly prefixed folders as the active project', () => {
    expect(isWithinProject('dohc/notes.md', 'dohc')).toBe(true)
    expect(isWithinProject('dohcness/notes.md', 'dohc')).toBe(false)
  })

  it('counts only files changed in the active scope since the latest turn started', () => {
    const files = [
      { path: 'dohc/new.md', updatedAt: 150, source: 'agent' },
      { path: 'dohc/manual.md', updatedAt: 170, source: 'user' },
      { path: 'dohc/old.md', updatedAt: 90, source: 'agent' },
      { path: 'opnft-fun/plan.md', updatedAt: 180, source: 'agent' },
    ]

    expect(agentRailChangeSummary(files, 'dohc', 100)).toEqual({
      changedCount: 2,
      agentCount: 1,
      userCount: 1,
      changedPaths: ['dohc/new.md', 'dohc/manual.md'],
    })
  })

  it('does not report changes when there is no saved active thread', () => {
    expect(
      agentRailChangeSummary(
        [{ path: 'dohc/new.md', updatedAt: 150, source: 'agent' }],
        'dohc',
        null,
      ),
    ).toEqual({
      changedCount: 0,
      agentCount: 0,
      userCount: 0,
      changedPaths: [],
    })
  })

  it('isWithinProject returns true for null projectPath (workspace-wide)', () => {
    expect(isWithinProject('any/path/file.md', null)).toBe(true)
    expect(isWithinProject('scratch.md', null)).toBe(true)
  })

  it('isWithinProject matches an exact path (file directly at project root)', () => {
    expect(isWithinProject('dohc', 'dohc')).toBe(true)
  })

  it('isWithinProject normalizes leading and trailing slashes in project path', () => {
    expect(isWithinProject('dohc/notes.md', '/dohc/')).toBe(true)
    expect(isWithinProject('dohcness/notes.md', '/dohc/')).toBe(false)
  })

  it('agentRailScopedFiles returns all files when projectPath is empty string', () => {
    const files = [{ path: 'a/b.md' }, { path: 'c.md' }]
    expect(agentRailScopedFiles(files, '')).toEqual(files)
  })

  it('agentRailScopedFiles returns empty array when no files exist', () => {
    expect(agentRailScopedFiles([], 'project')).toEqual([])
  })

  it('agentRailChangeSummary counts all files when since=0 (epoch)', () => {
    const files = [
      { path: 'dohc/a.md', updatedAt: 1, source: 'agent' },
      { path: 'dohc/b.md', updatedAt: 2, source: 'user' },
    ]
    const result = agentRailChangeSummary(files, 'dohc', 0)
    expect(result.changedCount).toBe(2)
    expect(result.agentCount).toBe(1)
    expect(result.userCount).toBe(1)
  })

  it('agentRailChangeSummary counts workspace-wide when project is null', () => {
    const files = [
      { path: 'dohc/a.md', updatedAt: 200, source: 'agent' },
      { path: 'opnft/b.md', updatedAt: 300, source: 'user' },
      { path: 'scratch.md', updatedAt: 50, source: 'agent' },
    ]
    const result = agentRailChangeSummary(files, null, 100)
    expect(result.changedCount).toBe(2)
    expect(result.changedPaths).toEqual(['dohc/a.md', 'opnft/b.md'])
  })

  it('agentRailChangeSummary returns zeros when no files fall within scope', () => {
    const files = [
      { path: 'other/a.md', updatedAt: 200, source: 'agent' },
    ]
    expect(agentRailChangeSummary(files, 'dohc', 100)).toEqual({
      changedCount: 0,
      agentCount: 0,
      userCount: 0,
      changedPaths: [],
    })
  })

  it('agentRailChangeSummary treats files without source as agent-authored', () => {
    const files = [
      { path: 'dohc/a.md', updatedAt: 200 },
    ]
    const result = agentRailChangeSummary(files, 'dohc', 100)
    expect(result.agentCount).toBe(1)
    expect(result.userCount).toBe(0)
  })
})
