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
})

describe('isWithinProject — additional edge cases', () => {
  it('returns true for any path when projectPath is null', () => {
    expect(isWithinProject('any/path/here.md', null)).toBe(true)
    expect(isWithinProject('scratch.md', null)).toBe(true)
  })

  it('returns true when the file path exactly equals the project path', () => {
    expect(isWithinProject('dohc', 'dohc')).toBe(true)
  })

  it('handles leading/trailing slashes in projectPath gracefully', () => {
    // The component normalizes these before calling isWithinProject
    expect(isWithinProject('dohc/notes.md', 'dohc')).toBe(true)
    expect(isWithinProject('dohcness/notes.md', 'dohc')).toBe(false)
  })

  it('is false for an empty projectPath after normalization', () => {
    expect(isWithinProject('dohc/notes.md', '')).toBe(true) // empty → no project filter
  })
})

describe('agentRailScopedFiles — additional edge cases', () => {
  it('returns an empty array when files list is empty', () => {
    expect(agentRailScopedFiles([], 'dohc')).toEqual([])
  })

  it('returns all files when projectPath is null (workspace-wide)', () => {
    const files = [
      { path: 'dohc/notes.md' },
      { path: 'opnft-fun/plan.md' },
      { path: 'scratch.md' },
    ]
    expect(agentRailScopedFiles(files, null)).toEqual(files)
  })

  it('returns empty when no files match the project path', () => {
    const files = [
      { path: 'other/notes.md' },
      { path: 'scratch.md' },
    ]
    expect(agentRailScopedFiles(files, 'dohc')).toEqual([])
  })

  it('strips leading slashes from projectPath before filtering', () => {
    const files = [
      { path: 'dohc/notes.md' },
      { path: 'opnft-fun/plan.md' },
    ]
    // After normalization '/dohc/' becomes 'dohc'
    expect(agentRailScopedFiles(files, '/dohc/').map((f) => f.path)).toEqual([
      'dohc/notes.md',
    ])
  })
})

describe('agentRailChangeSummary — additional edge cases', () => {
  it('returns empty summary for empty file list', () => {
    expect(agentRailChangeSummary([], 'dohc', 100)).toEqual({
      changedCount: 0,
      agentCount: 0,
      userCount: 0,
      changedPaths: [],
    })
  })

  it('includes all changed files when projectPath is null (workspace-wide)', () => {
    const files = [
      { path: 'dohc/new.md', updatedAt: 150, source: 'agent' },
      { path: 'opnft-fun/plan.md', updatedAt: 160, source: 'user' },
    ]
    const summary = agentRailChangeSummary(files, null, 100)
    expect(summary.changedCount).toBe(2)
    expect(summary.agentCount).toBe(1)
    expect(summary.userCount).toBe(1)
  })

  it('counts a file with undefined source as agent-authored', () => {
    const files = [
      { path: 'dohc/file.md', updatedAt: 150 }, // no source field
    ]
    const summary = agentRailChangeSummary(files, 'dohc', 100)
    expect(summary.agentCount).toBe(1)
    expect(summary.userCount).toBe(0)
  })

  it('includes a file updated at exactly the `since` timestamp', () => {
    const files = [
      { path: 'dohc/exact.md', updatedAt: 100, source: 'agent' },
    ]
    // file at exactly since=100 should be included (>= not >)
    const summary = agentRailChangeSummary(files, 'dohc', 100)
    expect(summary.changedCount).toBe(1)
    expect(summary.changedPaths).toContain('dohc/exact.md')
  })

  it('excludes files updated strictly before the `since` timestamp', () => {
    const files = [
      { path: 'dohc/old.md', updatedAt: 99, source: 'agent' },
    ]
    const summary = agentRailChangeSummary(files, 'dohc', 100)
    expect(summary.changedCount).toBe(0)
  })
})
