import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// F1 (multiplayer-and-h-followups §7) — disable the workspace switcher
// while the chat panel has a streaming assistant turn in flight. Without
// this, switching workspace mid-send navigates (R1 commit 3 made
// setActiveWorkspaceId navigate), the chat rebinds to the new
// workspace's thread, and in-flight assistant tokens are orphaned.
//
// STRUCTURAL tests (matches this codebase's no-jsdom convention).

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) =>
  readFileSync(resolve(__dirname, '../../src/', rel), 'utf8')

const CTX = read('lib/chat-busy.tsx')
const CHAT = read('components/Chat.tsx')
const SWITCHER = read('components/WorkspaceSwitcher.tsx')
const APP = read('routes/_app.tsx')

describe('chat-busy context (F1 wiring)', () => {
  it('exports ChatBusyProvider + useChatBusy + useSetChatBusy', () => {
    expect(CTX).toMatch(/export function ChatBusyProvider\b/)
    expect(CTX).toMatch(/export function useChatBusy\b/)
    expect(CTX).toMatch(/export function useSetChatBusy\b/)
  })

  it('useChatBusy is DEFENSIVE — defaults to false when provider missing', () => {
    // The hook should not throw outside the provider (advisory signal,
    // not security-critical). Switcher disabling without a provider is
    // a no-op rather than a crash.
    expect(CTX).toMatch(/ctx\?\.busy\s*\?\?\s*false/)
  })

  it('useSetChatBusy returns a no-op when provider missing', () => {
    // Same defensive pattern.
    expect(CTX).toMatch(/ctx\?\.setBusy\s*\?\?\s*\(\(\)\s*=>\s*\{\}\)/)
  })
})

describe('Chat.tsx publishes busy', () => {
  it('imports useSetChatBusy', () => {
    expect(CHAT).toMatch(
      /useSetChatBusy[\s\S]{0,200}from\s+['"](?:@\/lib|\.\.\/lib)\/chat-busy['"]/,
    )
  })

  it('writes sending or busy to the context + cleans up on unmount', () => {
    // The send-state publish + cleanup setBusy(false) pattern. Without the
    // cleanup, closing the chat panel mid-stream would leave the
    // switcher disabled permanently.
    expect(CHAT).toMatch(/setChatBusy\(sending\s*\|\|\s*busy\)/)
    expect(CHAT).toMatch(/return\s*\(\)\s*=>\s*setChatBusy\(false\)/)
  })

  it('treats pending assistant turns as busy before text starts streaming', () => {
    expect(CHAT).toMatch(/\['pending',\s*'streaming'\]\.includes/)
    expect(CHAT).toMatch(/\(m as \{ status\?: string \}\)\.status \?\? ''/)
  })

  it('renders empty pending assistant turns as visible activity', () => {
    expect(CHAT).toContain("status === 'pending'")
    expect(CHAT).toContain('dohc is starting')
    expect(CHAT).toMatch(/!pending[\s\S]{0,120}!failed/)
  })

  it('renders failed assistant turns instead of hiding silent failures', () => {
    expect(CHAT).toContain("status === 'failed'")
    expect(CHAT).toContain('Agent run failed')
    expect(CHAT).toContain('errorText')
  })

  it('lets onboarding-started busy threads stop even without a composer send target', () => {
    expect(CHAT).toContain('const fallbackStopTarget')
    expect(CHAT).toMatch(/threadId && busy[\s\S]{0,160}threadId/)
    expect(CHAT).toMatch(/disabled=\{stopping \|\| !canStopActiveChat\}/)
  })

  it('keeps next-message model and permission controls editable while busy', () => {
    const statusStripStart = CHAT.indexOf('function ComposerStatusStrip')
    expect(statusStripStart).toBeGreaterThan(0)
    const statusStripEnd = CHAT.indexOf('const ACCESS_POPOVER_WIDTH', statusStripStart)
    const statusStrip = CHAT.slice(statusStripStart, statusStripEnd)

    expect(statusStrip).toMatch(
      /<AgentModelPicker[\s\S]{0,260}disabled=\{!onSelectionChange\}/,
    )
    expect(statusStrip).toMatch(
      /<AgentAccessPicker[\s\S]{0,220}disabled=\{false\}/,
    )
    expect(statusStrip).not.toMatch(
      /<AgentModelPicker[\s\S]{0,260}sending \|\| busy/,
    )
    expect(statusStrip).not.toMatch(
      /<AgentAccessPicker[\s\S]{0,220}sending \|\| busy/,
    )
  })
})

describe('WorkspaceSwitcher.tsx reads busy + disables', () => {
  it('imports useChatBusy', () => {
    expect(SWITCHER).toMatch(
      /useChatBusy[\s\S]{0,200}from\s+['"](?:@\/lib|\.\.\/lib)\/chat-busy['"]/,
    )
  })

  it('main switcher button disables when chatBusy is true', () => {
    expect(SWITCHER).toMatch(/disabled=\{chatBusy\}/)
    expect(SWITCHER).toMatch(/aria-disabled=\{chatBusy\}/)
  })

  it('shows an explanatory tooltip when disabled (not a silent disable)', () => {
    expect(SWITCHER).toMatch(
      /chatBusy[\s\S]{0,200}dohc is sending a message/,
    )
  })
})

describe('_app.tsx wires ChatBusyProvider', () => {
  it('imports ChatBusyProvider', () => {
    expect(APP).toMatch(
      /import\s+\{[\s\S]*?ChatBusyProvider[\s\S]*?\}\s+from\s+['"]@\/lib\/chat-busy['"]/,
    )
  })

  it('wraps the app subtree in <ChatBusyProvider>', () => {
    expect(APP).toMatch(
      /<ChatBusyProvider>[\s\S]+<\/ChatBusyProvider>/,
    )
  })

  it('ChatBusyProvider sits INSIDE ActiveWorkspaceProvider so the switcher (in FileTree) sees both', () => {
    // The nesting matters: switcher needs both contexts. Order of
    // providers matters less semantically but the test ensures both
    // wrap the layout.
    expect(APP).toMatch(
      /<ActiveWorkspaceProvider>[\s\S]*?<ChatBusyProvider>/,
    )
  })
})
