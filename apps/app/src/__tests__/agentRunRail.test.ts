import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AgentRunRail,
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

  it('counts only files changed in the active scope since the chat started', () => {
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

  it('renders chat-start scoped change signals for the active project', () => {
    const html = renderToStaticMarkup(
      createElement(AgentRunRail, {
        projectPath: 'dohc',
        activeThread: {
          threadId: 'thread-1',
          title: 'dohc run',
          projectPath: 'dohc',
          createdAt: 100,
          updatedAt: 250_100,
          pinnedAt: null,
        },
        files: [
          { path: 'dohc/new.md', updatedAt: 150, source: 'agent' },
          { path: 'dohc/manual.md', updatedAt: 170, source: 'user' },
          { path: 'dohc/old.md', updatedAt: 90, source: 'agent' },
          { path: 'opnft-fun/plan.md', updatedAt: 180, source: 'agent' },
        ],
      }),
    )

    expect(html).toContain('Changes')
    expect(html).toContain('Files touched since this chat started')
    expect(html).toContain('4m 10s')
    expect(html).toContain('+2')
    expect(html).toContain('files')
    expect(html).toContain('Scope')
    expect(html).toContain('dohc')
    expect(html).not.toContain('opnft-fun')
    expect(html).not.toContain('No active run')
  })
})
