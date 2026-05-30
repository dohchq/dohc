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

describe('Agent / Files shell mode', () => {
  it('adds Agent as a first-class primary activity alongside Files and Graph', () => {
    expect(ACTIVITY).toMatch(/ActivityView\s*=\s*'agent'\s*\|\s*'atom'\s*\|\s*'graph'/)
    expect(ACTIVITY).toContain("label: 'Agent'")
    expect(ACTIVITY).toContain("label: 'Files'")
    expect(ACTIVITY).toContain("label: 'Graph'")
  })

  it('renders a dedicated Agent workspace instead of treating chat as only a dock', () => {
    expect(APP).toContain("type View = 'agent' | 'atom' | 'graph'")
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
})
