import { describe, expect, it } from 'vitest'
import {
  availableProjectFolders,
  topLevelProjects,
} from '../components/AgentChatSidebar'

describe('AgentChatSidebar project model', () => {
  it('only treats explicit project chat scopes as projects', () => {
    expect(
      topLevelProjects(
        [{ path: 'dohc' }, { path: 'opnft-fun/research' }],
        [{ path: 'writing/draft.md' }, { path: 'scratch.md' }],
        [
          {
            threadId: 't1',
            projectPath: 'archived/idea',
            title: 'Archived project chat',
            updatedAt: 1,
            pinnedAt: null,
          },
          {
            threadId: 't-internal',
            projectPath: '.context',
            title: '.context chat',
            updatedAt: 3,
            pinnedAt: null,
          },
          {
            threadId: 't2',
            projectPath: null,
            title: 'Workspace chat',
            updatedAt: 2,
            pinnedAt: null,
          },
        ],
      ),
    ).toEqual(['archived/idea'])
  })

  it('keeps folders available for explicit promotion without auto-projecting them', () => {
    expect(
      availableProjectFolders(
        [
          { path: '.context' },
          { path: 'dohc' },
          { path: 'opnft-fun/research' },
        ],
        [
          { path: '.runs/setup.md' },
          { path: 'writing/draft.md' },
          { path: 'scratch.md' },
        ],
      ),
    ).toEqual(['dohc', 'opnft-fun', 'opnft-fun/research', 'writing'])
  })
})

describe('topLevelProjects — additional edge cases', () => {
  it('returns an empty array when there are no threads', () => {
    expect(topLevelProjects([], [], [])).toEqual([])
  })

  it('returns an empty array when all threads are workspace-scoped (null projectPath)', () => {
    expect(
      topLevelProjects(
        [],
        [],
        [
          { threadId: 't1', projectPath: null, title: 'Chat', updatedAt: 1, pinnedAt: null },
          { threadId: 't2', projectPath: null, title: 'Chat 2', updatedAt: 2, pinnedAt: null },
        ],
      ),
    ).toEqual([])
  })

  it('deduplicates when multiple threads share the same project path', () => {
    const result = topLevelProjects(
      [],
      [],
      [
        { threadId: 't1', projectPath: 'research', title: 'Chat 1', updatedAt: 1, pinnedAt: null },
        { threadId: 't2', projectPath: 'research', title: 'Chat 2', updatedAt: 2, pinnedAt: null },
        { threadId: 't3', projectPath: 'design', title: 'Chat 3', updatedAt: 3, pinnedAt: null },
      ],
    )
    // 'research' appears only once
    expect(result.filter((p) => p === 'research')).toHaveLength(1)
    expect(result).toContain('design')
  })

  it('sorts project paths alphabetically', () => {
    const result = topLevelProjects(
      [],
      [],
      [
        { threadId: 't3', projectPath: 'zzz', title: 'Z', updatedAt: 3, pinnedAt: null },
        { threadId: 't1', projectPath: 'aaa', title: 'A', updatedAt: 1, pinnedAt: null },
        { threadId: 't2', projectPath: 'mmm', title: 'M', updatedAt: 2, pinnedAt: null },
      ],
    )
    expect(result).toEqual(['aaa', 'mmm', 'zzz'])
  })

  it('normalizes leading/trailing slashes in thread projectPath', () => {
    const result = topLevelProjects(
      [],
      [],
      [
        { threadId: 't1', projectPath: '/myproject/', title: 'Chat', updatedAt: 1, pinnedAt: null },
      ],
    )
    expect(result).toEqual(['myproject'])
  })

  it('excludes threads with deep dot-segment project paths (e.g. dohc/.hidden)', () => {
    const result = topLevelProjects(
      [],
      [],
      [
        { threadId: 't1', projectPath: 'dohc/.hidden', title: 'Chat', updatedAt: 1, pinnedAt: null },
        { threadId: 't2', projectPath: 'dohc', title: 'Chat 2', updatedAt: 2, pinnedAt: null },
      ],
    )
    expect(result).toEqual(['dohc'])
  })
})

describe('availableProjectFolders — additional edge cases', () => {
  it('returns an empty array for empty inputs', () => {
    expect(availableProjectFolders([], [])).toEqual([])
  })

  it('returns an empty array when all paths are internal (dot-prefixed)', () => {
    expect(
      availableProjectFolders(
        [{ path: '.context' }],
        [{ path: '.runs/setup.md' }, { path: '.skills/weekly.md' }],
      ),
    ).toEqual([])
  })

  it('exposes all intermediate ancestors of deeply nested paths', () => {
    const result = availableProjectFolders(
      [],
      [{ path: 'clients/acme/projects/q4.md' }],
    )
    expect(result).toContain('clients')
    expect(result).toContain('clients/acme')
    expect(result).toContain('clients/acme/projects')
  })

  it('deduplicates folder paths derived from multiple files in the same directory', () => {
    const result = availableProjectFolders(
      [],
      [
        { path: 'dohc/notes.md' },
        { path: 'dohc/plan.md' },
        { path: 'dohc/report.md' },
      ],
    )
    expect(result.filter((p) => p === 'dohc')).toHaveLength(1)
  })

  it('handles root-level files gracefully (they have no parent folder)', () => {
    const result = availableProjectFolders([], [{ path: 'scratch.md' }])
    // scratch.md is a file at root — no folder segment to add
    expect(result).toEqual([])
  })

  it('does not expose the folder itself if it is a direct dot folder', () => {
    const result = availableProjectFolders(
      [{ path: '.context/intent.md' }],
      [],
    )
    // .context is internal — should be excluded
    expect(result).not.toContain('.context')
  })
})
