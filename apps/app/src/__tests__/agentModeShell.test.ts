// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentSelectionToConvexArgs } from '../components/AgentModelPicker'
import {
  AgentChatSidebar,
  type AgentThreadSummary,
} from '../components/AgentChatSidebar'

vi.mock('../components/WorkspaceSwitcher', () => ({
  WorkspaceSwitcher: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (path: string) =>
  readFileSync(resolve(__dirname, '../../src', path), 'utf8')

const APP = read('routes/_app.tsx')
const ACTIVITY = read('components/ActivityBar.tsx')
const CHAT = read('components/Chat.tsx')
const AGENT_CHAT_SIDEBAR = read('components/AgentChatSidebar.tsx')
const AGENT_RUN_RAIL = read('components/AgentRunRail.tsx')
const AGENT_MODEL_PICKER = read('components/AgentModelPicker.tsx')
const AGENT_ACCESS = read('lib/agentAccess.ts')

const pinnedThread: AgentThreadSummary = {
  threadId: 'thread_1',
  projectPath: null,
  title: 'Pinned plan',
  createdAt: Date.now() - 120_000,
  updatedAt: Date.now() - 60_000,
  pinnedAt: Date.now() - 30_000,
}

function renderAgentSidebar(
  overrides: Partial<React.ComponentProps<typeof AgentChatSidebar>> = {},
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const props: React.ComponentProps<typeof AgentChatSidebar> = {
    files: [],
    folders: [],
    threads: [pinnedThread],
    activeThreadId: pinnedThread.threadId,
    activeProjectPath: null,
    onSelectThread: vi.fn(),
    onNewThread: vi.fn(),
    onCreateProject: vi.fn(),
    onTogglePinned: vi.fn(),
    onDeleteThread: vi.fn(),
    onRenameThread: vi.fn(),
    onRenameProject: vi.fn(),
    onOpenSearch: vi.fn(),
    user: { email: 'ice@example.com', firstName: 'Ice' },
    ...overrides,
  }
  act(() => {
    root.render(React.createElement(AgentChatSidebar, props))
  })
  return { container, props, root }
}

function cleanupRendered(container: HTMLElement, root: Root) {
  act(() => {
    root.unmount()
  })
  container.remove()
}

describe('Agent / Files shell mode', () => {
  it('adds Agent as a first-class primary activity alongside Files and Graph', () => {
    expect(ACTIVITY).toContain("import type { AppView } from '../lib/appViews'")
    expect(ACTIVITY).toContain("ActivityView = Extract<AppView, 'agent' | 'atom' | 'views' | 'graph'>")
    expect(ACTIVITY).toContain("label: 'Agent'")
    expect(ACTIVITY).toContain("label: 'Files'")
    expect(ACTIVITY).toContain("label: 'Views'")
    expect(ACTIVITY).toContain("label: 'Graph'")
  })

  it('renders a dedicated Agent workspace instead of treating chat as only a dock', () => {
    expect(APP).toContain('type AppView as View')
    expect(APP).toContain('<AgentChatSidebar')
    expect(APP).toContain('<AgentWorkspace')
    expect(APP).toContain('<AgentRunRail')
    expect(APP).toContain('mode="primary"')
  })

  it('keeps optional side chat available in Files mode', () => {
    expect(APP).toContain('mode="side"')
    expect(APP).toContain('dohc-chat-open')
    expect(APP).toMatch(/view !== 'agent'[\s\S]{0,240}chatOpen/)
  })

  it('makes the left and right shell sidebars resizable', () => {
    expect(APP).toContain('dohc-left-sidebar-width')
    expect(APP).toContain('dohc-right-sidebar-width')
    expect(APP).toContain('shellGridTemplateColumns')
    expect(APP).toContain('style={{ gridTemplateColumns: shellGridTemplateColumns }}')
    expect(APP).toContain('ShellResizeHandle')
    expect(APP).toContain('role="separator"')
    expect(APP).toContain('startSidebarResize')
    expect(APP).toContain("startSidebarResize('left', event)")
    expect(APP).toContain("startSidebarResize('right', event)")
    expect(APP).toContain('resetLeftSidebar')
    expect(APP).toContain('resetRightSidebar')
    expect(APP).toContain('onDoubleClick')
    expect(APP).toContain('LEFT_SIDEBAR_DEFAULT_WIDTH')
    expect(APP).toContain('RIGHT_SIDEBAR_DEFAULT_WIDTH')
    expect(APP).toContain('const RIGHT_SIDEBAR_DEFAULT_WIDTH = 500')
    expect(APP).toContain('RIGHT_SIDEBAR_LEGACY_DEFAULT_WIDTH')
    expect(APP).toContain('RIGHT_SIDEBAR_PREVIOUS_DEFAULT_WIDTH')
    expect(APP).toContain('storedWidth === RIGHT_SIDEBAR_LEGACY_DEFAULT_WIDTH')
    expect(APP).toContain('storedWidth === RIGHT_SIDEBAR_PREVIOUS_DEFAULT_WIDTH')
    expect(APP).toContain('floatingPanelButtonRight')
    expect(APP).toContain('style={{ right: floatingPanelButtonRight }}')
    expect(AGENT_RUN_RAIL).not.toContain('w-[340px]')
  })

  it('integrates the side chat with agent thread selection without navigating away', () => {
    expect(APP).toContain('selectAgentThreadInPanel')
    expect(APP).toContain('startAgentDraftInPanel')
    expect(APP).toContain('ensureAgentThreadForPanelSend')
    expect(APP).toContain('threads={chatThreads}')
    expect(APP).toContain('onSelectThread={selectAgentThreadInPanel}')
    expect(APP).toContain('onNewThread={startAgentDraftInPanel}')
    expect(APP).toContain('onEnsureThread={ensureAgentThreadForPanelSend}')
    expect(CHAT).toContain('threads?: ChatThreadOption[]')
    expect(CHAT).toContain('SideChatThreadSelector')
    expect(CHAT).toContain('aria-label="Select chat"')
    expect(CHAT).toContain('aria-label="New chat"')
    expect(CHAT).toContain('relative z-[60] flex items-center justify-between')
    expect(CHAT).toContain('absolute left-0 right-0 top-[calc(100%+7px)] z-[90]')
  })

  it('lets Chat render as either the primary run surface or a side dock', () => {
    expect(CHAT).toMatch(/mode\?: 'side' \| 'primary'/)
    expect(CHAT).toContain("mode = 'side'")
    expect(CHAT).toContain("mode === 'primary'")
    expect(CHAT).toContain('What should we build in dohc?')
  })

  it('lets starter prompt descriptions wrap instead of clipping them', () => {
    expect(CHAT).toContain('flex-1 whitespace-normal break-words')
    expect(CHAT).not.toContain('line-clamp-2 block text-[11.5px]')
  })

  it('lets users stop an active chat turn and shows message timestamps', () => {
    expect(CHAT).toContain('api.agent.stopChat')
    expect(CHAT).toContain('data-stop-square')
    expect(CHAT).not.toContain('CircleStop')
    expect(CHAT).toMatch(/aria-label=\{stopping \? 'Stopping chat' : 'Stop chat'\}/)
    expect(CHAT).toContain('<time')
    expect(CHAT).toContain('formatChatTimestamp')
  })

  it('adds dohc-style project chat history beside the Agent workspace', () => {
    const projectThread: AgentThreadSummary = {
      ...pinnedThread,
      threadId: 'thread_project',
      projectPath: 'dohc/research',
      title: 'Research chat',
      pinnedAt: null,
    }
    const onNewThread = vi.fn()
    const { container, root } = renderAgentSidebar({
      threads: [projectThread, pinnedThread],
      activeThreadId: projectThread.threadId,
      activeProjectPath: 'dohc/research',
      onNewThread,
    })
    try {
      expect(container.textContent).toContain('Projects')
      expect(container.textContent).toContain('Chats')
      expect(container.textContent).toContain('dohc/research')
      expect(container.textContent).toContain('Research chat')
      expect(
        container.querySelector('button[aria-label="new chat in dohc/research"]'),
      ).not.toBeNull()
      expect(
        container.querySelector('button[aria-label="new workspace chat"]'),
      ).not.toBeNull()
    } finally {
      cleanupRendered(container, root)
    }
    expect(APP).toContain('api.agent.listThreads')
    expect(APP).toContain('api.agent.createThread')
  })

  it('does not show a duplicate pinned icon when row actions are visible', () => {
    const { container, root } = renderAgentSidebar()
    try {
      expect(container.textContent).toContain('Pinned plan')
      expect(container.querySelectorAll('button[title="Unpin chat"]')).toHaveLength(1)
    } finally {
      cleanupRendered(container, root)
    }
  })

  it('dismisses row actions after pinning so the resulting pin state is visible', () => {
    const feedbackThread: AgentThreadSummary = {
      ...pinnedThread,
      threadId: 'thread_feedback',
      title: 'Workspace chat',
      pinnedAt: null,
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)

    function Harness() {
      const [thread, setThread] = React.useState(feedbackThread)
      return React.createElement(AgentChatSidebar, {
        files: [],
        folders: [],
        threads: [thread],
        activeThreadId: thread.threadId,
        activeProjectPath: null,
        onSelectThread: vi.fn(),
        onNewThread: vi.fn(),
        onCreateProject: vi.fn(),
        onTogglePinned: () => {
          setThread((current) => ({
            ...current,
            pinnedAt: current.pinnedAt === null ? Date.now() : null,
          }))
        },
        onDeleteThread: vi.fn(),
        onRenameThread: vi.fn(),
        onRenameProject: vi.fn(),
        onOpenSearch: vi.fn(),
        user: { email: 'ice@example.com', firstName: 'Ice' },
      })
    }

    act(() => {
      root.render(React.createElement(Harness))
    })

    try {
      const pinButton = container.querySelector<HTMLButtonElement>(
        'button[title="Pin chat"]',
      )
      expect(pinButton).not.toBeNull()
      act(() => {
        pinButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const actions = container.querySelector<HTMLElement>(
        '[data-thread-actions="thread_feedback"]',
      )
      const indicator = container.querySelector<SVGElement>(
        '[data-thread-pin-indicator="thread_feedback"]',
      )
      expect(actions?.dataset.dismissed).toBe('true')
      expect(actions?.className).not.toContain('group-hover/thread:flex')
      expect(indicator).not.toBeNull()
      expect(indicator?.getAttribute('class')).not.toContain(
        'group-hover/thread:hidden',
      )
      expect(document.activeElement).toBe(
        container.querySelector('button[aria-label="Open chat Workspace chat"]'),
      )
    } finally {
      cleanupRendered(container, root)
    }
  })

  it('makes the full chat row clickable, not only the chat title text', () => {
    const onSelectThread = vi.fn()
    const { container, root } = renderAgentSidebar({ onSelectThread })
    try {
      const openButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open chat Pinned plan"]',
      )
      expect(openButton).not.toBeNull()
      act(() => {
        openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSelectThread).toHaveBeenCalledWith(pinnedThread)
    } finally {
      cleanupRendered(container, root)
    }
  })

  it('keeps new chats as drafts until the first message chooses an environment', () => {
    expect(APP).toContain('startAgentDraft')
    expect(APP).toContain('ensureAgentThreadForSend')
    expect(APP).toContain('projectOptions={agentProjectOptions}')
    expect(APP).toContain('folderOptions={projectFolderOptions}')
    expect(CHAT).toContain('onEnsureThread')
    expect(CHAT).toContain('{!threadId && (')
    expect(CHAT).not.toContain('{primary && !threadId && (')
    expect(CHAT).toContain('Environment')
    expect(CHAT).toContain('Search projects')
    expect(CHAT).toContain('Add new project')
    expect(CHAT).toContain("Don't work in a project")
    expect(CHAT).toContain('absolute bottom-[calc(100%+8px)] left-3 z-[90]')
    expect(CHAT).not.toContain('<select')
    expect(APP).not.toContain(
      'ensureThread({ activeWorkspaceId, projectPath: agentProjectPath })',
    )
  })

  it('uses file-tree-like Agent sidebar affordances instead of alert-driven project UX', () => {
    expect(AGENT_CHAT_SIDEBAR).toContain('WorkspaceSwitcher')
    expect(AGENT_CHAT_SIDEBAR).toContain('collapsedProjects')
    expect(AGENT_CHAT_SIDEBAR).toContain('<FolderOpen')
    expect(AGENT_CHAT_SIDEBAR).toContain('<Folder')
    expect(AGENT_CHAT_SIDEBAR).toContain('Rename chat')
    expect(AGENT_CHAT_SIDEBAR).toContain('Rename project')
    expect(AGENT_CHAT_SIDEBAR).toContain('fixed inset-0')
    expect(APP).toContain('AgentProjectDialog')
    expect(APP).toContain('renameAgentChat')
    expect(APP).toContain('renameAgentProject')
    expect(APP).not.toContain('Project folder name:')
    expect(APP).not.toContain('Use existing folder as project:')
  })

  it('shows the environment selector for draft chats only', () => {
    expect(CHAT).toContain('{!threadId && (')
    expect(CHAT).not.toContain('{primary && !threadId && (')
  })

  it('uses the active chat title and thread menu in the primary chat header', () => {
    expect(APP).toContain('activeAgentThread')
    expect(APP).toContain('threadTitle={activeThread?.title ?? null}')
    expect(APP).toContain('onRenameThreadForHeader')
    expect(APP).toContain('onDeleteThreadForHeader')
    expect(CHAT).toContain('threadTitle?: string | null')
    expect(CHAT).toContain('HeaderThreadMenu')
    expect(CHAT).toContain("threadTitle?.trim() || (threadId ? 'Workspace chat' : 'New chat')")
    expect(CHAT).not.toContain("{primary ? 'Agent' : 'dohc'}")
  })

  it('uses the active chat title as the Agent document metadata title', () => {
    expect(APP).toContain('agentDocTitle')
    expect(APP).toMatch(
      /activeAgentThread\?\.title\?\.trim\(\)\s*\|\|\s*\(threadId \? 'Workspace chat' : 'New chat'\)/,
    )
    expect(APP).toContain("if (view === 'agent') return { docTitle: agentDocTitle, docEmoji: null }")
    expect(APP).not.toContain("if (view === 'agent') return { docTitle: 'Agent', docEmoji: null }")
  })

  it('keeps chat switching from flashing through the new-chat draft state', () => {
    expect(APP).toContain('selectedAgentThreadSnapshot')
    expect(APP).toContain('agentThreads === undefined')
    expect(APP).toContain('setSelectedAgentThreadSnapshot(thread)')
    expect(APP).toContain('queryActiveAgentThread ??')
    expect(APP).toContain('selectedAgentThreadSnapshot?.threadId === threadId')
    expect(APP).toContain('if (threadId && selectedAgentThreadSnapshot?.threadId === threadId)')
    expect(CHAT).toContain('messagesLoadingFirstPage')
    expect(CHAT).toContain('messagesLoadingFirstPage ? (')
    expect(CHAT).toContain('<ChatMessagesSkeleton primary={primary} />')
    expect(CHAT).toContain(': uiMessages.length === 0 ? (')
    expect(CHAT).not.toContain('ChatLoadingState')
  })

  it('polishes the primary Agent chat window into a focused work surface', () => {
    expect(CHAT).toContain('EmptyChatState')
    expect(CHAT).toContain('ScrollToBottomButton')
    expect(CHAT).toContain('MessageActions')
    expect(CHAT).toContain('AgentContextPill')
    expect(CHAT).toContain('ComposerBannerStack')
    expect(CHAT).toContain('ComposerStatusStrip')
    expect(CHAT).toContain('ContextWindowMeter')
    expect(CHAT).toContain('composerError')
    expect(CHAT).toContain('onSelectPrompt')
    expect(CHAT).toContain('Copy message')
    expect(CHAT).toContain('Choose a first move')
    expect(CHAT).toContain('AgentWorkTrace')
    expect(CHAT).toContain('Worked for')
    expect(CHAT).toContain('toolCallPresentation')
    expect(CHAT).toContain('formatWorkedDuration')
    expect(CHAT).toContain('ToolActivityIcon')
    expect(CHAT).toContain('toolCalls')
    expect(CHAT).not.toContain('ToolCallStrip')
  })

  it('uses slash and dollar composer triggers for commands and skills', () => {
    expect(CHAT).toContain('detectComposerTrigger')
    expect(CHAT).toContain('replaceTextRange')
    expect(CHAT).toContain('SKILL_TOKEN_RE')
    expect(CHAT).toContain('Ask anything, $use skills, or / for commands')
    expect(CHAT).toContain("composerTrigger.kind === 'command' ? 'Commands' : 'Skills'")
    expect(CHAT).toContain('BUILTIN_COMPOSER_COMMANDS')
    expect(CHAT).toContain('buildComposerMenuItems')
    expect(CHAT).toContain('No saved skills yet')
    expect(CHAT).toContain('{composerTrigger && (')
    expect(CHAT).not.toContain('composerTrigger && composerMenuItems.length > 0')
    expect(CHAT).not.toContain('label="/ commands"')
    expect(CHAT).not.toContain('label="$ skills"')
    expect(CHAT).not.toContain('label="Enter"')
    expect(CHAT).toContain('Context window')
    expect(CHAT).toContain('aria-expanded={detailsOpen}')
    expect(CHAT).not.toContain('Commands & Skills')
  })

  it('maps multi-provider picker selections to Convex args without undefined fields', () => {
    expect(
      agentSelectionToConvexArgs({
        providerId: 'openai',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
      }),
    ).toEqual({
      agentProviderId: 'openai',
      agentModel: 'gpt-5.5',
      agentReasoningEffort: 'high',
    })

    expect(
      agentSelectionToConvexArgs({
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
    ).toEqual({
      agentProviderId: 'anthropic',
      agentModel: 'claude-haiku-4-5',
    })
  })

  it('adds a compact multi-provider model picker to the composer', () => {
    expect(APP).toContain('api.agent.listAgentProviders')
    expect(APP).toContain('setAgentWorkspaceDefault')
    expect(APP).toContain('agentProviderId')
    expect(APP).toContain('agentSelectionFromThread')
    expect(CHAT).toContain('AgentModelPicker')
    expect(CHAT).toContain('agentSelectionToConvexArgs(agentSelection)')
    expect(CHAT).toContain('...agentSelectionPayload')
    expect(CHAT).toContain('onEnsureThread(projectPath, agentSelection, accessMode)')
    expect(AGENT_CHAT_SIDEBAR).toContain('agentProviderId?: string | null')
    expect(AGENT_MODEL_PICKER).toContain('Provider')
    expect(AGENT_MODEL_PICKER).toContain('Reasoning')
    expect(AGENT_MODEL_PICKER).toContain('Search models')
    expect(AGENT_MODEL_PICKER).toContain('Default')
    expect(AGENT_MODEL_PICKER).toContain('Recommended')
    expect(AGENT_MODEL_PICKER).toContain('Set key')
    expect(AGENT_MODEL_PICKER).toContain('fixed z-[90] grid')
    expect(CHAT).toContain('fixed z-[90] w-[264px]')
    expect(AGENT_MODEL_PICKER).not.toContain('<select')
    expect(AGENT_MODEL_PICKER).not.toContain('>Rec<')
  })

  it('adds dohc-first access permissions to the agent composer', () => {
    expect(CHAT).toContain('AgentAccessPicker')
    expect(CHAT).toContain('agentAccessMode: accessMode')
    expect(CHAT).toContain('AGENT_ACCESS_MODE_OPTIONS')
    expect(AGENT_ACCESS).toContain('Default permissions')
    expect(AGENT_ACCESS).toContain('Auto-review')
    expect(AGENT_ACCESS).toContain('Full access')
    expect(CHAT).toContain('onEnsureThread(projectPath, agentSelection, accessMode)')
    expect(APP).toContain('agentAccessMode')
    expect(APP).toContain('threadAccessMode={activeAgentThread?.agentAccessMode ?? null}')
    expect(AGENT_CHAT_SIDEBAR).toContain('agentAccessMode?: AgentAccessMode | null')
  })

  it('keeps the Agent stream pinned only while the user is already at the bottom', () => {
    expect(CHAT).toContain('stickToBottomRef')
    expect(CHAT).toContain('ResizeObserver')
    expect(CHAT).toContain('scrollContentRef')
    expect(CHAT).toContain('isNearScrollBottom')
    expect(CHAT).toContain('stickToBottomRef.current')
    expect(CHAT).not.toContain('}, [uiMessages.length])')
  })

  it('keeps the Agent right rail focused on real run trust signals', () => {
    expect(APP).toContain('activeThread={activeAgentThread}')
    expect(APP).toContain('projectPath={agentProjectPath}')
    expect(AGENT_RUN_RAIL).toContain('activeThread')
    expect(AGENT_RUN_RAIL).toContain('projectPath')
    expect(AGENT_RUN_RAIL).toContain('isWithinProject')
    expect(AGENT_RUN_RAIL).toContain('agentRailChangeSummary')
    expect(AGENT_RUN_RAIL).toContain('Changes')
    expect(AGENT_RUN_RAIL).toContain('No active run')
    expect(AGENT_RUN_RAIL).not.toContain('Current workspace')
    expect(AGENT_RUN_RAIL).not.toContain('Working files')
    expect(AGENT_RUN_RAIL).not.toContain('Review queue')
    expect(AGENT_RUN_RAIL).not.toContain('Session')
    expect(AGENT_RUN_RAIL).not.toContain('title="Sources"')
    expect(AGENT_RUN_RAIL).not.toContain('title="Collaboration"')
  })
})
