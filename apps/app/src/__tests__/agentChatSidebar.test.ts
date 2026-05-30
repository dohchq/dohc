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
