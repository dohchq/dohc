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

  it('topLevelProjects returns empty when no threads have project scopes', () => {
    expect(
      topLevelProjects(
        [],
        [],
        [
          {
            threadId: 't1',
            projectPath: null,
            title: 'Workspace chat',
            updatedAt: 1,
            pinnedAt: null,
          },
        ],
      ),
    ).toEqual([])
  })

  it('topLevelProjects deduplicates when multiple threads share the same project path', () => {
    const threads = [
      { threadId: 't1', projectPath: 'research', title: 'Chat 1', updatedAt: 1, pinnedAt: null },
      { threadId: 't2', projectPath: 'research', title: 'Chat 2', updatedAt: 2, pinnedAt: null },
      { threadId: 't3', projectPath: 'clients', title: 'Chat 3', updatedAt: 3, pinnedAt: null },
    ]
    expect(topLevelProjects([], [], threads)).toEqual(['clients', 'research'])
  })

  it('topLevelProjects filters out threads with dot-starting path segments', () => {
    const threads = [
      { threadId: 't1', projectPath: '.context', title: 'Context', updatedAt: 1, pinnedAt: null },
      { threadId: 't2', projectPath: '.runs', title: 'Runs', updatedAt: 2, pinnedAt: null },
      { threadId: 't3', projectPath: 'a/.hidden/b', title: 'Hidden segment', updatedAt: 3, pinnedAt: null },
      { threadId: 't4', projectPath: 'public/project', title: 'Public', updatedAt: 4, pinnedAt: null },
    ]
    expect(topLevelProjects([], [], threads)).toEqual(['public/project'])
  })

  it('topLevelProjects returns projects sorted alphabetically', () => {
    const threads = [
      { threadId: 't3', projectPath: 'zebra', title: 'Z', updatedAt: 3, pinnedAt: null },
      { threadId: 't1', projectPath: 'alpha', title: 'A', updatedAt: 1, pinnedAt: null },
      { threadId: 't2', projectPath: 'middle', title: 'M', updatedAt: 2, pinnedAt: null },
    ]
    expect(topLevelProjects([], [], threads)).toEqual(['alpha', 'middle', 'zebra'])
  })

  it('topLevelProjects handles empty threads array', () => {
    expect(topLevelProjects([], [], [])).toEqual([])
  })

  it('availableProjectFolders returns empty when all inputs are empty', () => {
    expect(availableProjectFolders([], [])).toEqual([])
  })

  it('availableProjectFolders returns empty for root-level files (no folder component)', () => {
    expect(
      availableProjectFolders([], [{ path: 'scratch.md' }, { path: 'notes.txt' }]),
    ).toEqual([])
  })

  it('availableProjectFolders strips leading and trailing slashes from paths', () => {
    expect(
      availableProjectFolders([], [{ path: '/projects/acme.md' }]),
    ).toEqual(['projects'])
  })

  it('availableProjectFolders deduplicates folder entries from folders and files combined', () => {
    const result = availableProjectFolders(
      [{ path: 'clients' }, { path: 'clients' }],
      [{ path: 'clients/acme.md' }, { path: 'clients/beta.md' }],
    )
    expect(result).toEqual(['clients'])
  })

  it('availableProjectFolders extracts all parent folder segments from nested paths', () => {
    expect(
      availableProjectFolders([], [{ path: 'a/b/c/file.md' }]),
    ).toEqual(['a', 'a/b', 'a/b/c'])
  })

  it('availableProjectFolders excludes paths containing dot-prefixed segments', () => {
    expect(
      availableProjectFolders(
        [{ path: '.context' }],
        [{ path: '.runs/setup.md' }, { path: 'real/work.md' }],
      ),
    ).toEqual(['real'])
  })
})
