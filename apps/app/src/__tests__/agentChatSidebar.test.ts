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
            createdAt: 1,
            updatedAt: 1,
            pinnedAt: null,
          },
          {
            threadId: 't-internal',
            projectPath: '.context',
            title: '.context chat',
            createdAt: 3,
            updatedAt: 3,
            pinnedAt: null,
          },
          {
            threadId: 't2',
            projectPath: null,
            title: 'Workspace chat',
            createdAt: 2,
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
