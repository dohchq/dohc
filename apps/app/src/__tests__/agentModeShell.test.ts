import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (path: string) =>
  readFileSync(resolve(__dirname, '../../src', path), 'utf8')

const APP = read('routes/_app.tsx')
const ACTIVITY = read('components/ActivityBar.tsx')
const CHAT = read('components/Chat.tsx')
const AGENT_CHAT_SIDEBAR = read('components/AgentChatSidebar.tsx')
const AGENT_RUN_RAIL = read('components/AgentRunRail.tsx')

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

  it('lets Chat render as either the primary run surface or a side dock', () => {
    expect(CHAT).toMatch(/mode\?: 'side' \| 'primary'/)
    expect(CHAT).toContain("mode = 'side'")
    expect(CHAT).toContain("mode === 'primary'")
    expect(CHAT).toContain('What should we build in dohc?')
  })

  it('adds Codex-style project chat history beside the Agent workspace', () => {
    expect(AGENT_CHAT_SIDEBAR).toContain('Projects')
    expect(AGENT_CHAT_SIDEBAR).toContain('Chats')
    expect(AGENT_CHAT_SIDEBAR).toContain('New chat')
    expect(AGENT_CHAT_SIDEBAR).toContain('projectPath')
    expect(AGENT_CHAT_SIDEBAR).toContain('topLevelProjects')
    expect(APP).toContain('api.agent.listThreads')
    expect(APP).toContain('api.agent.createThread')
  })

  it('keeps new chats as drafts until the first message chooses an environment', () => {
    expect(APP).toContain('startAgentDraft')
    expect(APP).toContain('ensureAgentThreadForSend')
    expect(APP).toContain('projectOptions={agentProjectOptions}')
    expect(APP).toContain('folderOptions={projectFolderOptions}')
    expect(CHAT).toContain('onEnsureThread')
    expect(CHAT).toContain('Environment')
    expect(CHAT).toContain('Search projects')
    expect(CHAT).toContain('Add new project')
    expect(CHAT).toContain("Don't work in a project")
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

  it('removes the environment selector once a chat thread exists', () => {
    expect(CHAT).toContain('primary && !threadId')
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
    expect(APP).toContain("activeAgentThread?.title?.trim() || (threadId ? 'Workspace chat' : 'New chat')")
    expect(APP).toContain("if (view === 'agent') return { docTitle: agentDocTitle, docEmoji: null }")
    expect(APP).not.toContain("if (view === 'agent') return { docTitle: 'Agent', docEmoji: null }")
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

  it('uses T3-style composer triggers for commands and skills', () => {
    expect(CHAT).toContain('detectComposerTrigger')
    expect(CHAT).toContain('replaceTextRange')
    expect(CHAT).toContain('SKILL_TOKEN_RE')
    expect(CHAT).toContain('Ask anything, $use skills, or / for commands')
    expect(CHAT).toContain("label=\"/ commands\"")
    expect(CHAT).toContain("label=\"$ skills\"")
    expect(CHAT).toContain("composerTrigger.kind === 'command' ? 'Commands' : 'Skills'")
    expect(CHAT).not.toContain('Commands & Skills')
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
