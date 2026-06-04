import {
  memo,
  useCallback,
  useState,
  useRef,
  useEffect,
  useMemo,
  useId,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useAction, useQuery } from 'convex/react'
import { useUIMessages, type UIMessage } from '@convex-dev/agent/react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  FileText,
  Folder,
  FolderPlus,
  FolderX,
  Hand,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Send,
  Shield,
  ShieldCheck,
  Sparkles,
  SquarePen,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { Markdown } from './Markdown'
import { DohcMark } from '@dohc/brand'
import {
  AgentModelPicker,
  agentSelectionToConvexArgs,
  type AgentModelPickerSelection,
  type AgentProviderSnapshot,
} from './AgentModelPicker'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import {
  AGENT_ACCESS_MODE_OPTIONS,
  DEFAULT_AGENT_ACCESS_MODE,
  normalizeAgentAccessMode,
  type AgentAccessMode,
} from '../lib/agentAccess'
import { useSetChatBusy } from '../lib/chat-busy'
import { ChatMessagesSkeleton } from './Skeleton'
import {
  agentWorkTraceSummary,
  formatToolPayload,
  formatWorkedDuration,
  isToolActivityPart,
  toolCallPresentation,
  type ToolActivityKind,
  type ToolActivityPart,
} from '../lib/chatActivity'
import {
  latestUserMessageTimestamp,
  optimisticTurnHasServerEcho,
  pendingTurnEchoCountBefore,
  uiMessageDisplayText,
  uiMessageText,
  type OptimisticChatTurn,
} from '../lib/chat-optimistic'
import type { Id } from '../../convex/_generated/dataModel'
import {
  AttachmentTray,
  AttachmentDropOverlay,
  AttachmentUploadButton,
  MessageFileParts,
  useAttachmentUploads,
} from './AttachmentComposer'

// Composer grammar:
//   /command  => saved slash command, only at the start of the line
//   $skill    => saved skill, inline in the prompt
// Selecting from the composer menu inserts the token; it does not
// immediately submit. Sending resolves $skill or /command tokens into
// the agent entrypoint while preserving the user's full prompt as brief.
const SKILL_TOKEN_RE = /(?:^|\s)\$([\w./:-]+)(?=\s|$)/
const COMMAND_FIRE_RE = /^\/([\w./-]+)(?:\s+([\s\S]+))?$/
const STREAM_STICKY_BOTTOM_PX = 80
const SCROLL_TO_BOTTOM_BUTTON_PX = 180
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000
const AUTO_COMPACT_TARGET_RATIO = 0.85
const SYSTEM_AND_TOOL_CONTEXT_ESTIMATE_TOKENS = 3_000
const MESSAGE_CONTEXT_OVERHEAD_TOKENS = 12
const APPROX_CHARS_PER_TOKEN = 4
const EMPTY_CONTEXT_USAGE: ContextWindowUsage = {
  estimatedTokens: 0,
  contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
  compactAtTokens: Math.round(
    DEFAULT_CONTEXT_WINDOW_TOKENS * AUTO_COMPACT_TARGET_RATIO,
  ),
  percent: 0,
  isEstimate: true,
}

type ChatTimestampFormatters = {
  day: Intl.DateTimeFormat
  time: Intl.DateTimeFormat
  dateTime: Intl.DateTimeFormat
}

const chatTimestampFormatterCache = new Map<string, ChatTimestampFormatters>()

function dateTimeOptions(
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatOptions {
  return timeZone ? { ...options, timeZone } : options
}

function getChatTimestampFormatters(
  locale: string | undefined,
  timeZone: string | undefined,
): ChatTimestampFormatters {
  const key = `${locale ?? ''}\u0000${timeZone ?? ''}`
  const cached = chatTimestampFormatterCache.get(key)
  if (cached) return cached
  const next = {
    day: new Intl.DateTimeFormat(
      locale,
      dateTimeOptions(timeZone, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      }),
    ),
    time: new Intl.DateTimeFormat(
      locale,
      dateTimeOptions(timeZone, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    ),
    dateTime: new Intl.DateTimeFormat(
      locale,
      dateTimeOptions(timeZone, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    ),
  }
  chatTimestampFormatterCache.set(key, next)
  return next
}

type RunnableRef = { path: string; label: string }
type EnvironmentOption = { value: string | null; label: string }
type ChatActionResult = void | Promise<void>
type ChatThreadOption = {
  threadId: string
  projectPath: string | null
  title: string
  createdAt: number
  updatedAt: number
  pinnedAt: number | null
}
type ActiveSendTarget = {
  threadId: string
  projectPath?: string | null
}
type SendEntry = 'skill-fire' | 'command-fire'
type IconComponent = typeof Folder
type ComposerStarterCommand = RunnableRef & {
  kind: 'command'
  source: 'starter'
  command: string
  description: string
  prompt: string
}
type ComposerWorkspaceMenuItem = RunnableRef & {
  kind: 'command' | 'skill'
  source: 'workspace'
  description?: string
}
type ComposerMenuItem = ComposerStarterCommand | ComposerWorkspaceMenuItem
type ComposerTrigger = {
  kind: ComposerMenuItem['kind']
  query: string
  rangeStart: number
  rangeEnd: number
}
type ComposerBannerItem = {
  id: string
  tone: 'danger' | 'info'
  icon: ReactNode
  title: string
  description?: string
  dismissLabel?: string
  onDismiss?: () => void
}

const BUILTIN_COMPOSER_COMMANDS: readonly ComposerStarterCommand[] = [
  {
    kind: 'command',
    source: 'starter',
    command: 'cockpit',
    path: 'builtin:cockpit',
    label: 'Build my project cockpit',
    description: 'Start a source-backed cockpit from the files here.',
    prompt:
      'Build a source-backed project cockpit for this work. Start by asking only for the context you actually need.',
  },
  {
    kind: 'command',
    source: 'starter',
    command: 'review',
    path: 'builtin:review-workspace',
    label: 'Review this workspace',
    description: 'Find what is clear, missing, and worth doing next.',
    prompt:
      'Review this workspace and tell me what is clear, what is missing, and what the next useful action should be.',
  },
  {
    kind: 'command',
    source: 'starter',
    command: 'plan',
    path: 'builtin:plan',
    label: 'Turn notes into a plan',
    description: 'Convert loose notes into decisions and next actions.',
    prompt:
      'Turn my loose notes into a practical plan with decisions, open questions, and next actions.',
  },
  {
    kind: 'command',
    source: 'starter',
    command: 'dashboard',
    path: 'builtin:dashboard',
    label: 'Create a dashboard',
    description: 'Build a source-backed dashboard from available context.',
    prompt:
      'Create a polished dashboard from the available source files. If there is not enough source context, say what to capture first.',
  },
]

export type ContextWindowUsage = {
  estimatedTokens: number
  contextWindowTokens: number
  compactAtTokens: number
  percent: number
  isEstimate: boolean
}

export function runPendingPromptHandoff({
  pendingPrompt,
  threadId,
  canEnsureThread,
  sending,
  busy,
  submit,
  onPendingHandled,
}: {
  pendingPrompt?: string | null
  threadId: string | null
  canEnsureThread: boolean
  sending: boolean
  busy: boolean
  submit: (prompt: string) => void
  onPendingHandled?: () => void
}): boolean {
  if (!pendingPrompt || (!threadId && !canEnsureThread) || sending || busy) {
    return false
  }
  submit(pendingPrompt)
  onPendingHandled?.()
  return true
}

export function detectComposerTrigger(
  text: string,
  cursorInput: number,
): ComposerTrigger | null {
  const cursor = Math.max(0, Math.min(cursorInput, text.length))
  const beforeCursor = text.slice(0, cursor)
  const lineStart = beforeCursor.lastIndexOf('\n') + 1
  const linePrefix = text.slice(lineStart, cursor)
  const commandMatch = /^\/([^\s]*)$/.exec(linePrefix)
  if (commandMatch) {
    return {
      kind: 'command',
      query: commandMatch[1],
      rangeStart: lineStart,
      rangeEnd: cursor,
    }
  }

  const tokenStartMatch = /(?:^|\s)(\S*)$/.exec(beforeCursor)
  const token = tokenStartMatch?.[1] ?? ''
  if (token.startsWith('$')) {
    return {
      kind: 'skill',
      query: token.slice(1),
      rangeStart: cursor - token.length,
      rangeEnd: cursor,
    }
  }

  return null
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(rangeStart, text.length))
  let safeEnd = Math.max(safeStart, Math.min(rangeEnd, text.length))
  if (replacement.endsWith(' ') && text[safeEnd] === ' ') safeEnd += 1
  return {
    text: `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`,
    cursor: safeStart + replacement.length,
  }
}

export function composerTokenForRunnable(
  _kind: ComposerMenuItem['kind'],
  item: RunnableRef,
  rows: ReadonlyArray<RunnableRef>,
): string {
  const sameLabelCount = rows.filter((row) => row.label === item.label).length
  return sameLabelCount > 1 ? item.path : item.label
}

function composerMenuItemMatches(item: ComposerMenuItem, query: string): boolean {
  const values = [
    item.label,
    item.path,
    item.description ?? '',
    item.kind === 'command' && item.source === 'starter' ? item.command : '',
  ]
  return values.some((value) => value.toLowerCase().includes(query))
}

export function buildComposerMenuItems(
  composerTrigger: ComposerTrigger | null,
  savedCommands: ReadonlyArray<RunnableRef>,
  skills: ReadonlyArray<RunnableRef>,
): ComposerMenuItem[] {
  if (!composerTrigger) return []
  const rows: ComposerMenuItem[] =
    composerTrigger.kind === 'command'
      ? [
          ...BUILTIN_COMPOSER_COMMANDS,
          ...savedCommands.map(
            (command): ComposerWorkspaceMenuItem => ({
              ...command,
              kind: 'command',
              source: 'workspace',
              description: command.path,
            }),
          ),
        ]
      : skills.map(
          (skill): ComposerWorkspaceMenuItem => ({
            ...skill,
            kind: 'skill',
            source: 'workspace',
            description: skill.path,
          }),
        )

  const query = composerTrigger.query.trim().toLowerCase()
  if (!query) return rows
  return rows.filter((row) => composerMenuItemMatches(row, query))
}

export function detectSkillFire(
  prompt: string,
  skills: ReadonlyArray<RunnableRef>,
):
  | { matched: { path: string; label: string }; extras: string | null }
  | { ambiguous: ReadonlyArray<{ path: string; label: string }> }
  | null {
  const trimmed = prompt.trim()
  const m = trimmed.match(SKILL_TOKEN_RE)
  if (!m) return null
  const token = m[1]
  const extras = trimmed || null
  // Exact path match wins (unambiguous canonical identifier).
  const byPath = skills.find((s) => s.path === token)
  if (byPath) return { matched: byPath, extras }
  // Otherwise match by label. Collisions surface a list the user
  // can disambiguate (per design §3.1 round-6 closure).
  const byLabel = skills.filter((s) => s.label === token)
  if (byLabel.length === 1) return { matched: byLabel[0], extras }
  if (byLabel.length > 1) return { ambiguous: byLabel }
  return null
}

export function detectCommandFire(
  prompt: string,
  commands: ReadonlyArray<RunnableRef>,
):
  | { matched: RunnableRef; extras: string | null }
  | { ambiguous: ReadonlyArray<RunnableRef> }
  | null {
  const trimmed = prompt.trim()
  const m = trimmed.match(COMMAND_FIRE_RE)
  if (!m) return null
  if (m[1] === 'skill') return null
  const token = m[1]
  const extras = m[2]?.trim() || null
  const byPath = commands.find((c) => c.path === token)
  if (byPath) return { matched: byPath, extras }
  const byLabel = commands.filter((c) => c.label === token)
  if (byLabel.length === 1) return { matched: byLabel[0], extras }
  if (byLabel.length > 1) return { ambiguous: byLabel }
  return null
}

function estimateTextTokens(text: string): number {
  if (!text.trim()) return 0
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

export function estimateContextTokensFromMessages(
  messages: ReadonlyArray<UIMessage>,
): number {
  const threadTokens = messages.reduce((total, message) => {
    const text = uiMessageText(message)
    return total + MESSAGE_CONTEXT_OVERHEAD_TOKENS + estimateTextTokens(text)
  }, 0)
  if (threadTokens === 0) return 0
  return SYSTEM_AND_TOOL_CONTEXT_ESTIMATE_TOKENS + threadTokens
}

function selectedContextWindowTokens(
  providers: ReadonlyArray<AgentProviderSnapshot>,
  selection: AgentModelPickerSelection | null,
): number {
  const provider = providers.find(
    (candidate) => candidate.providerId === selection?.providerId,
  )
  const model = provider?.models.find(
    (candidate) => candidate.id === selection?.model,
  )
  return model?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
}

export function buildEstimatedContextWindowUsage({
  messages,
  providers,
  selection,
}: {
  messages: ReadonlyArray<UIMessage>
  providers: ReadonlyArray<AgentProviderSnapshot>
  selection: AgentModelPickerSelection | null
}): ContextWindowUsage {
  const contextWindowTokens = selectedContextWindowTokens(providers, selection)
  const compactAtTokens = Math.round(
    contextWindowTokens * AUTO_COMPACT_TARGET_RATIO,
  )
  const estimatedTokens = estimateContextTokensFromMessages(messages)
  const percent =
    compactAtTokens > 0
      ? Math.min(100, Math.round((estimatedTokens / compactAtTokens) * 100))
      : 0

  return {
    estimatedTokens,
    contextWindowTokens,
    compactAtTokens,
    percent,
    isEstimate: true,
  }
}

export function formatChatTimestamp(
  timestamp: number | null | undefined,
  options: {
    now?: number
    locale?: string
    timeZone?: string
  } = {},
): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null
  const now = options.now ?? Date.now()
  const locale = options.locale
  const timeZone = options.timeZone
  const value = new Date(timestamp)
  const { day, time, dateTime } = getChatTimestampFormatters(locale, timeZone)
  const isSameDay = day.format(value) === day.format(new Date(now))
  if (isSameDay) return time.format(value)
  return dateTime.format(value)
}

type Props = {
  threadId: string | null
  threadTitle?: string | null
  threadPinned?: boolean
  projectPath?: string | null
  projectOptions?: EnvironmentOption[]
  folderOptions?: string[]
  onProjectPathChange?: (projectPath: string | null) => void
  onCreateProject?: (mode: 'scratch' | 'existing') => void
  threads?: ChatThreadOption[]
  onSelectThread?: (thread: ChatThreadOption) => void
  onNewThread?: (projectPath: string | null) => void
  onEnsureThread?: (
    projectPath: string | null,
    selection?: AgentModelPickerSelection | null,
    accessMode?: AgentAccessMode | null,
  ) => Promise<string>
  onToggleThreadPinned?: () => ChatActionResult
  onRenameThread?: (title: string) => ChatActionResult
  onDeleteThread?: () => ChatActionResult
  agentProviders?: AgentProviderSnapshot[]
  agentSelection?: AgentModelPickerSelection | null
  threadAccessMode?: AgentAccessMode | null
  onAgentSelectionChange?: (selection: AgentModelPickerSelection) => void
  onSetAgentDefault?: (selection: AgentModelPickerSelection) => void | Promise<void>
  mode?: 'side' | 'primary'
  pendingPrompt?: string | null
  onPendingHandled?: () => void
  // P3+P4 Codex fold F2+F3: dedicated channel for programmatic
  // skill-fire (from CommandPalette skill rows). Bypasses
  // detectSkillFire (no slash-parsing on this channel). The state is
  // parent-owned (index.tsx); Chat consumes ONCE then signals
  // onPendingSkillFireHandled.
  pendingSkillFire?: string | null
  onPendingSkillFireHandled?: () => void
  pendingCommandFire?: string | null
  onPendingCommandFireHandled?: () => void
}

export function Chat({
  threadId,
  threadTitle = null,
  threadPinned = false,
  projectPath = null,
  projectOptions = [],
  folderOptions = [],
  onProjectPathChange,
  onCreateProject,
  threads = [],
  onSelectThread,
  onNewThread,
  onEnsureThread,
  onToggleThreadPinned,
  onRenameThread,
  onDeleteThread,
  agentProviders = [],
  agentSelection = null,
  threadAccessMode = null,
  onAgentSelectionChange,
  onSetAgentDefault,
  mode = 'side',
  pendingPrompt,
  onPendingHandled,
  pendingSkillFire,
  onPendingSkillFireHandled,
  pendingCommandFire,
  onPendingCommandFireHandled,
}: Props) {
  const primary = mode === 'primary'
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [composerError, setComposerError] = useState<string | null>(null)
  const [composerCursor, setComposerCursor] = useState(0)
  const [composerMenuCursor, setComposerMenuCursor] = useState(0)
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const [environmentQuery, setEnvironmentQuery] = useState('')
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [accessMode, setAccessMode] = useState<AgentAccessMode>(() =>
    normalizeAgentAccessMode(threadAccessMode),
  )
  const sendMessage = useAction(api.agent.sendMessage)
  const stopChat = useAction(api.agent.stopChat)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const scrollContentRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const scrollRafRef = useRef<number | null>(null)
  const showScrollToBottomRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const activeSendTargetRef = useRef<ActiveSendTarget | null>(null)
  const [activeSendTarget, setActiveSendTargetState] = useState<ActiveSendTarget | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const optimisticTurnSeqRef = useRef(0)
  const [optimisticTurns, setOptimisticTurns] = useState<OptimisticChatTurn[]>([])
  // Track-3 P3 — subscribe to the user's saved skills for slash-
  // command resolution. The query is cheap (one workspace-keyed
  // collect; filtered to type:skill under .skills/).
  // org-plan §5: active workspace threaded through skills + the
  // (org-plan §5 non-defaultable) listMessages thread surface. The
  // agent.sendMessage action remains personal-default for now (an
  // action cannot validate active membership; the thread itself
  // binds to a workspace via threadRefs, which is the long-term fix).
  const activeWorkspaceId = useActiveWorkspaceId()
  const attachmentUploads = useAttachmentUploads({
    activeWorkspaceId,
    purpose: 'chat',
  })
  const skills = useQuery(api.skills.list, { activeWorkspaceId }) ?? []
  const savedCommands =
    useQuery(api.skills.listCommands, { activeWorkspaceId }) ?? []

  const messagesQuery = useUIMessages(
    api.agent.listMessages,
    threadId ? { threadId, activeWorkspaceId, projectPath } : 'skip',
    { initialNumItems: 50, stream: true },
  )
  const messagesLoadingFirstPage = Boolean(
    threadId && (!messagesQuery || messagesQuery.status === 'LoadingFirstPage'),
  )

  const uiMessages: UIMessage[] = useMemo(() => {
    if (!messagesQuery || messagesQuery.status === 'LoadingFirstPage') return []
    return messagesQuery.results ?? []
  }, [messagesQuery])

  const visibleOptimisticTurns = useMemo(
    () =>
      optimisticTurns.filter(
        (turn) => !optimisticTurnHasServerEcho(turn, uiMessages),
      ),
    [optimisticTurns, uiMessages],
  )

  useEffect(() => {
    if (optimisticTurns.length === 0) return
    setOptimisticTurns((turns) => {
      const next = turns.filter(
        (turn) => !optimisticTurnHasServerEcho(turn, uiMessages),
      )
      return next.length === turns.length ? turns : next
    })
  }, [uiMessages, optimisticTurns.length])

  const busy = useMemo(
    () =>
      uiMessages.some(
        (m) =>
          m.role === 'assistant' &&
          ['pending', 'streaming'].includes(
            (m as { status?: string }).status ?? '',
          ),
      ),
    [uiMessages],
  )

  function setActiveSendTarget(target: ActiveSendTarget | null) {
    activeSendTargetRef.current = target
    setActiveSendTargetState(target)
  }

  const appendOptimisticTurn = useCallback(
    ({
      displayText,
      serverText,
    }: {
      displayText: string
      serverText: string
    }) => {
      const id = `local-${Date.now()}-${optimisticTurnSeqRef.current++}`
      const createdAt = Date.now()
      const serverEchoAfter = latestUserMessageTimestamp(uiMessages)
      stickToBottomRef.current = true
      setOptimisticTurns((turns) => {
        const serverEchoCountBefore = pendingTurnEchoCountBefore(
          turns,
          serverText,
          serverEchoAfter,
        )
        return [
          ...turns,
          {
            id,
            displayText,
            serverText,
            createdAt,
            serverEchoAfter,
            serverEchoCountBefore,
          },
        ]
      })
      return id
    },
    [uiMessages],
  )

  const removeOptimisticTurn = useCallback((id: string) => {
    setOptimisticTurns((turns) => turns.filter((turn) => turn.id !== id))
  }, [])

  const contextUsage = useMemo(
    () =>
      primary
        ? buildEstimatedContextWindowUsage({
            messages: uiMessages,
            providers: agentProviders,
            selection: agentSelection,
          })
        : EMPTY_CONTEXT_USAGE,
    [agentProviders, agentSelection, primary, uiMessages],
  )

  const agentSelectionPayload = useMemo(
    () => (agentSelection ? agentSelectionToConvexArgs(agentSelection) : {}),
    [agentSelection],
  )

  useEffect(() => {
    setAccessMode(normalizeAgentAccessMode(threadAccessMode))
  }, [threadAccessMode, threadId])

  async function ensureActiveThread() {
    return (
      threadId ??
      (onEnsureThread
        ? await onEnsureThread(projectPath, agentSelection, accessMode)
        : null)
    )
  }

  async function stopActiveChat() {
    const target = activeSendTargetRef.current
    if (!target || stopping) return
    setStopping(true)
    setComposerError(null)
    try {
      await stopChat({
        activeWorkspaceId,
        threadId: target.threadId,
        projectPath: target.projectPath,
      })
    } catch (e) {
      setComposerError(formatComposerError(e))
      console.error(e)
    } finally {
      setStopping(false)
    }
  }

  // F1 (multiplayer-and-h-followups §7) — publish busy state up to
  // ChatBusyContext so the WorkspaceSwitcher can disable itself while
  // a stream is mid-flight. Without this, switching workspace mid-send
  // navigates (R1 commit 3) → chat rebinds to new workspace's thread
  // → in-flight assistant tokens are orphaned. v1 fix: block the
  // switcher. v2 (deferred): confirm dialog + AbortController via the
  // agent action.
  const setChatBusy = useSetChatBusy()
  useEffect(() => {
    setChatBusy(sending || busy)
    return () => setChatBusy(false)
  }, [busy, sending, setChatBusy])

  useEffect(() => {
    if (!sending && !busy && !stopping && activeSendTargetRef.current) {
      setActiveSendTarget(null)
    }
  }, [busy, sending, stopping])

  const setScrollToBottomVisible = useCallback((visible: boolean) => {
    if (showScrollToBottomRef.current === visible) return
    showScrollToBottomRef.current = visible
    setShowScrollToBottom(visible)
  }, [])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      stickToBottomRef.current = true
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior,
      })
      setScrollToBottomVisible(false)
    },
    [setScrollToBottomVisible],
  )

  const updateScrollAffordance = useCallback(() => {
    if (scrollRafRef.current !== null) return
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null
      const el = scrollRef.current
      if (!el) return
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottomRef.current = isNearScrollBottom(el)
      setScrollToBottomVisible(distanceFromBottom > SCROLL_TO_BOTTOM_BUTTON_PX)
    })
  }, [setScrollToBottomVisible])

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (stickToBottomRef.current) scrollToBottom('smooth')
  }, [threadId, uiMessages.length, visibleOptimisticTurns.length, scrollToBottom])

  useEffect(() => {
    const content = scrollContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom('auto')
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [threadId, scrollToBottom])

  async function sendResolvedPrompt({
    promptText,
    displayText = promptText,
    entry,
    clearComposer = false,
    attachmentIds = attachmentUploads.readyAssetIds,
  }: {
    promptText: string
    displayText?: string
    entry?: SendEntry
    clearComposer?: boolean
    attachmentIds?: Id<'workspaceAssets'>[]
  }) {
    const sendPrompt =
      promptText.trim() || (attachmentIds.length > 0 ? 'Attached files.' : '')
    if (!sendPrompt || sending || busy || attachmentUploads.hasUploading) return
    setComposerError(null)
    setSending(true)
    const optimisticText = displayText.trim() || sendPrompt
    const optimisticId = appendOptimisticTurn({
      displayText: optimisticText,
      serverText: sendPrompt,
    })
    if (clearComposer) setInput('')
    try {
      const activeThreadId = await ensureActiveThread()
      if (!activeThreadId) {
        removeOptimisticTurn(optimisticId)
        return
      }
      setActiveSendTarget({ threadId: activeThreadId, projectPath })
      await sendMessage({
        threadId: activeThreadId,
        prompt: sendPrompt,
        attachmentIds,
        ...(entry ? { entry } : {}),
        activeWorkspaceId,
        projectPath,
        agentAccessMode: accessMode,
        ...agentSelectionPayload,
      })
      if (clearComposer) attachmentUploads.clearReadyAttachmentIds(attachmentIds)
    } catch (e) {
      removeOptimisticTurn(optimisticId)
      if (clearComposer) {
        setInput((current) => (current.trim() ? current : optimisticText))
      }
      setComposerError(formatComposerError(e))
      console.error(e)
    } finally {
      setSending(false)
    }
  }

  async function submit(promptOverride?: string) {
    const prompt = (promptOverride ?? input).trim()
    const attachmentIds = attachmentUploads.readyAssetIds
    if (
      (!prompt && attachmentIds.length === 0) ||
      sending ||
      busy ||
      attachmentUploads.hasUploading
    )
      return
    setComposerError(null)
    // Track-3 P3 — slash-command routing. A leading `/<token>`
    // that resolves to a saved skill flips this turn into
    // skill-fire mode (the prepareStep BRACE restricts step 0's
    // tools to {run_skill} + toolChoice forces the call).
    // Ambiguous label collisions surface as a chat hint without
    // firing; unmatched slash-prefixes pass through as a normal
    // prompt (the model sees the literal "/" prefix and replies).
    const match = detectSkillFire(prompt, skills)
    const commandMatch = match ? null : detectCommandFire(prompt, savedCommands)
    if (match && 'ambiguous' in match) {
      // Surface the collision as a local UI nudge — do NOT fire
      // sendMessage (the user must disambiguate). Append to the
      // input so they can pick.
      const list = match.ambiguous.map((s) => s.path).join('\n  ')
      setInput(
        `${prompt}\n\n[multiple skills match this label — pick one of:]\n  ${list}`,
      )
      setComposerError('Multiple skills match that label. Pick the exact path to run.')
      return
    }
    if (commandMatch && 'ambiguous' in commandMatch) {
      const list = commandMatch.ambiguous.map((c) => c.path).join('\n  ')
      setInput(
        `${prompt}\n\n[multiple commands match this label — pick one of:]\n  ${list}`,
      )
      setComposerError('Multiple commands match that label. Pick the exact path to run.')
      return
    }

    if (match && 'matched' in match) {
      // P3+P4 indep fold F4: preserve user extras as context the model sees
      // after run_skill returns the body.
      const promptText = match.extras
        ? `${match.matched.path}\n\n${match.extras}`
        : match.matched.path
      await sendResolvedPrompt({
        promptText,
        displayText: prompt,
        entry: 'skill-fire',
        clearComposer: !promptOverride,
        attachmentIds,
      })
      return
    }
    if (commandMatch && 'matched' in commandMatch) {
      const promptText = commandMatch.extras
        ? `${commandMatch.matched.path}\n\n${commandMatch.extras}`
        : commandMatch.matched.path
      await sendResolvedPrompt({
        promptText,
        displayText: prompt,
        entry: 'command-fire',
        clearComposer: !promptOverride,
        attachmentIds,
      })
      return
    }
    await sendResolvedPrompt({
      promptText: prompt,
      clearComposer: !promptOverride,
      attachmentIds,
    })
  }

  useEffect(() => {
    runPendingPromptHandoff({
      pendingPrompt,
      threadId,
      canEnsureThread: Boolean(onEnsureThread),
      sending,
      busy,
      submit,
      onPendingHandled,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt, threadId, onEnsureThread, sending, busy, onPendingHandled])

  // P3+P4 Codex fold F2+F3: dedicated channel for programmatic
  // skill-fire (CommandPalette skill rows route here). Bypasses
  // detectSkillFire (no slash-parsing on this channel) — fires
  // sendMessage({entry:'skill-fire'}) DIRECTLY with the canonical
  // path. The signal handler runs ONCE: it claims the dispatch
  // immediately (clears parent state via the handler callback
  // BEFORE the await) so a stale value cannot replay on remount.
  useEffect(() => {
    if (!pendingSkillFire || (!threadId && !onEnsureThread) || sending || busy) return
    const path = pendingSkillFire
    // Claim the dispatch SYNCHRONOUSLY so a re-render or remount
    // sees a cleared pendingSkillFire and does not replay.
    onPendingSkillFireHandled?.()
    void sendResolvedPrompt({
      promptText: path,
      entry: 'skill-fire',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSkillFire, threadId, sending, busy, onEnsureThread, projectPath, accessMode])

  useEffect(() => {
    if (!pendingCommandFire || (!threadId && !onEnsureThread) || sending || busy) return
    const path = pendingCommandFire
    onPendingCommandFireHandled?.()
    void sendResolvedPrompt({
      promptText: path,
      entry: 'command-fire',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCommandFire, threadId, sending, busy, onEnsureThread, projectPath, accessMode])

  const composerTrigger = useMemo(
    () => detectComposerTrigger(input, composerCursor),
    [composerCursor, input],
  )

  const composerMenuItems = useMemo<ComposerMenuItem[]>(() => {
    return buildComposerMenuItems(composerTrigger, savedCommands, skills)
  }, [composerTrigger, savedCommands, skills])

  useEffect(() => {
    setComposerMenuCursor((c) =>
      Math.min(c, Math.max(0, composerMenuItems.length - 1)),
    )
  }, [composerMenuItems.length])

  function updateComposerCursor(target: HTMLTextAreaElement | null) {
    if (!target) return
    setComposerCursor(target.selectionStart ?? target.value.length)
  }

  function selectComposerItem(item: ComposerMenuItem) {
    if (!composerTrigger) return
    if (item.kind === 'command' && item.source === 'starter') {
      const next = replaceTextRange(
        input,
        composerTrigger.rangeStart,
        composerTrigger.rangeEnd,
        item.prompt,
      )
      setInput(next.text)
      setComposerCursor(next.cursor)
      setComposerError(null)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(next.cursor, next.cursor)
      })
      return
    }

    const token = composerTokenForRunnable(
      item.kind,
      item,
      item.kind === 'command' ? savedCommands : skills,
    )
    const replacement =
      item.kind === 'command' ? `/${token} ` : `$${token} `
    const next = replaceTextRange(
      input,
      composerTrigger.rangeStart,
      composerTrigger.rangeEnd,
      replacement,
    )
    setInput(next.text)
    setComposerCursor(next.cursor)
    setComposerError(null)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor)
    })
  }

  const canSend = Boolean(threadId || onEnsureThread)
  const uniqueProjectOptions = useMemo(() => {
    const seen = new Set<string>()
    return projectOptions.filter((option) => {
      if (option.value === null) return false
      const key = option.value ?? ''
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [projectOptions])
  const filteredProjectOptions = useMemo(() => {
    const q = environmentQuery.trim().toLowerCase()
    if (!q) return uniqueProjectOptions
    return uniqueProjectOptions.filter((option) =>
      option.label.toLowerCase().includes(q),
    )
  }, [environmentQuery, uniqueProjectOptions])
  const selectedProjectLabel =
    projectPath ??
    (primary ? "Don't work in a project" : 'Workspace chat')
  const canEditEnvironment = !threadId && !sending && !busy
  const headerTitle =
    threadTitle?.trim() || (threadId ? 'Workspace chat' : 'New chat')
  const showHeaderMenu =
    primary &&
    Boolean(threadId) &&
    Boolean(onToggleThreadPinned || onRenameThread || onDeleteThread)
  const contextLabel = projectPath ?? 'No project'

  function selectStarterPrompt(prompt: string) {
    setInput(prompt)
    setComposerError(null)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const composerBannerItems: ComposerBannerItem[] = composerError
    ? [
        {
          id: 'composer-error',
          tone: 'danger',
          icon: <AlertCircle className="size-4" strokeWidth={2} />,
          title: 'That turn did not send',
          description: composerError,
          dismissLabel: 'Dismiss send error',
          onDismiss: () => setComposerError(null),
        },
      ]
    : []

  return (
    <aside
      className={`flex h-screen flex-col ${
        primary
          ? 'bg-page [background-image:linear-gradient(90deg,var(--dohc-grid)_1px,transparent_1px),linear-gradient(0deg,var(--dohc-grid)_1px,transparent_1px)] [background-size:42px_42px]'
          : 'bg-panel border-l border-rule'
      }`}
    >
      <header
        className={`relative z-[60] flex items-center justify-between border-b border-rule bg-page/92 backdrop-blur ${
          primary ? 'h-14 px-6' : 'h-11 px-4 bg-panel'
        }`}
      >
        {primary ? (
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="min-w-0 truncate text-[14px] font-semibold tracking-tight text-ink-strong"
              title={headerTitle}
            >
              {headerTitle}
            </span>
            {showHeaderMenu && (
              <HeaderThreadMenu
                title={headerTitle}
                pinned={threadPinned}
                onTogglePinned={onToggleThreadPinned}
                onRenameThread={onRenameThread}
                onDeleteThread={onDeleteThread}
              />
            )}
          </div>
        ) : (
          <SideChatThreadSelector
            threads={threads}
            activeThreadId={threadId}
            activeTitle={headerTitle}
            projectPath={projectPath}
            onSelectThread={onSelectThread}
            onNewThread={onNewThread}
          />
        )}
        <div className="ml-3 flex shrink-0 items-center gap-2">
          {primary && (
            <AgentContextPill
              label={contextLabel}
              icon={projectPath ? Folder : FolderX}
            />
          )}
          {(sending || busy) && (
            <span className="flex items-center gap-1.5 rounded-full border border-rule bg-elevated px-2.5 py-1 text-[10.5px] font-medium text-ink-faint shadow-xs">
              <span className="size-1.5 rounded-full bg-success animate-pulse" />
              thinking
            </span>
          )}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={updateScrollAffordance}
          className={`h-full overflow-y-auto ${
            primary
              ? 'px-7 py-8'
              : 'px-4 py-4'
          }`}
        >
          <div
            ref={scrollContentRef}
            className={`mx-auto flex w-full flex-col ${
              primary ? 'max-w-[820px] gap-5' : 'gap-4'
            }`}
          >
            {messagesLoadingFirstPage && visibleOptimisticTurns.length === 0 ? (
              <ChatMessagesSkeleton primary={primary} />
            ) : uiMessages.length === 0 && visibleOptimisticTurns.length === 0 ? (
              <EmptyChatState
                primary={primary}
                onSelectPrompt={selectStarterPrompt}
              />
            ) : null}
            {uiMessages.map((m, index) => (
              <MessageView
                key={m.key}
                message={m}
                previousMessage={uiMessages[index - 1] ?? null}
                primary={primary}
              />
            ))}
            {visibleOptimisticTurns.map((turn) => (
              <OptimisticTurnView
                key={turn.id}
                turn={turn}
                primary={primary}
              />
            ))}
          </div>
        </div>
        {primary && showScrollToBottom && (
          <ScrollToBottomButton onClick={() => scrollToBottom()} />
        )}
      </div>

      <div className={primary ? 'mx-auto w-full max-w-[820px] px-7 pb-6 pt-1' : 'px-3 pb-3 pt-1'}>
        <div
          onDragEnter={attachmentUploads.handleDragEnter}
          onDragOver={attachmentUploads.handleDragOver}
          onDragLeave={attachmentUploads.handleDragLeave}
          onDrop={attachmentUploads.handleDrop}
          className={`relative overflow-visible border bg-elevated/96 focus-within:border-rule-strong transition-[border,box-shadow,background] shadow-xs backdrop-blur ${
            attachmentUploads.isDragActive
              ? 'border-accent bg-accent/5 shadow-modal'
              : 'border-rule'
          } ${
            primary ? 'rounded-[18px] shadow-lg focus-within:shadow-modal' : 'rounded-xl'
          }`}
        >
          {attachmentUploads.isDragActive && (
            <AttachmentDropOverlay compact={!primary} />
          )}
          {!threadId && (
            <div className="relative border-b border-rule bg-panel/60 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!canEditEnvironment) return
                    setEnvironmentOpen((open) => !open)
                    setCreateProjectOpen(false)
                  }}
                  disabled={!canEditEnvironment}
                  className="inline-flex h-8 max-w-[260px] items-center gap-2 rounded-full border border-rule bg-elevated px-3 text-[12.5px] font-medium text-ink shadow-xs hover:bg-hover disabled:cursor-default disabled:text-ink-faint"
                  title={
                    canEditEnvironment
                      ? 'Choose project environment'
                      : 'Environment is fixed for this chat'
                  }
                >
                  <Folder className="size-3.5 shrink-0 text-ink-dim" strokeWidth={1.8} />
                  <span className="min-w-0 truncate">{selectedProjectLabel}</span>
                  <ChevronDown className="size-3.5 shrink-0 text-ink-faint" strokeWidth={1.8} />
                </button>
                <span className="text-[11px] text-ink-faint">Environment</span>
              </div>
              {environmentOpen && canEditEnvironment && (
                <>
                <div
                  className="fixed inset-0 z-[80]"
                  onClick={() => {
                    setEnvironmentOpen(false)
                    setCreateProjectOpen(false)
                  }}
                />
                <div className="absolute bottom-[calc(100%+8px)] left-3 z-[90] w-[392px] max-w-[calc(100vw-24px)] rounded-xl border border-rule bg-elevated p-2 shadow-modal">
                  <label className="flex h-9 items-center gap-2 rounded-lg border border-rule bg-panel px-2.5 text-ink-dim focus-within:border-rule-strong">
                    <Search className="size-3.5 shrink-0" strokeWidth={1.8} />
                    <input
                      value={environmentQuery}
                      onChange={(e) => setEnvironmentQuery(e.target.value)}
                      placeholder="Search projects"
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
                    />
                  </label>
                  <div className="mt-2 max-h-56 overflow-y-auto">
                    {filteredProjectOptions.length === 0 ? (
                      <div className="px-2.5 py-3 text-[12px] text-ink-faint">
                        No project chats yet.
                      </div>
                    ) : (
                      filteredProjectOptions.map((option) => (
                        <button
                          key={option.value ?? '__none__'}
                          type="button"
                          onClick={() => {
                            onProjectPathChange?.(option.value)
                            setEnvironmentOpen(false)
                            setCreateProjectOpen(false)
                            setEnvironmentQuery('')
                          }}
                          className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium text-ink hover:bg-hover"
                        >
                          <Folder className="size-4 shrink-0 text-ink-dim" strokeWidth={1.8} />
                          <span className="min-w-0 flex-1 truncate">{option.label}</span>
                          {projectPath === option.value && (
                            <Check className="size-4 shrink-0 text-accent" strokeWidth={2} />
                          )}
                        </button>
                      ))
                    )}
                  </div>
                  <div className="relative mt-2 border-t border-rule pt-2">
                    <button
                      type="button"
                      onClick={() => setCreateProjectOpen((open) => !open)}
                      className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium text-ink hover:bg-hover"
                    >
                      <FolderPlus className="size-4 shrink-0 text-ink-dim" strokeWidth={1.8} />
                      <span className="min-w-0 flex-1 truncate">Add new project</span>
                      <ChevronDown className="size-3.5 shrink-0 -rotate-90 text-ink-faint" strokeWidth={1.8} />
                    </button>
                    {createProjectOpen && (
                      <div className="absolute left-[calc(100%+8px)] top-2 z-[100] w-64 rounded-xl border border-rule bg-elevated p-1.5 shadow-modal">
                        <button
                          type="button"
                          onClick={() => {
                            setEnvironmentOpen(false)
                            setCreateProjectOpen(false)
                            setEnvironmentQuery('')
                            onCreateProject?.('scratch')
                          }}
                          className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium text-ink hover:bg-hover"
                        >
                          <Plus className="size-4 shrink-0 text-ink-dim" strokeWidth={1.8} />
                          <span className="truncate">Start from scratch</span>
                        </button>
                        <button
                          type="button"
                          disabled={folderOptions.length === 0}
                          onClick={() => {
                            setEnvironmentOpen(false)
                            setCreateProjectOpen(false)
                            setEnvironmentQuery('')
                            onCreateProject?.('existing')
                          }}
                          className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium text-ink hover:bg-hover disabled:text-ink-faint disabled:hover:bg-transparent"
                        >
                          <Folder className="size-4 shrink-0 text-ink-dim" strokeWidth={1.8} />
                          <span className="truncate">Use an existing folder</span>
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        onProjectPathChange?.(null)
                        setEnvironmentOpen(false)
                        setCreateProjectOpen(false)
                        setEnvironmentQuery('')
                      }}
                      className="mt-1 flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium text-ink hover:bg-hover"
                    >
                      <FolderX className="size-4 shrink-0 text-ink-dim" strokeWidth={1.8} />
                      <span className="min-w-0 flex-1 truncate">Don't work in a project</span>
                      {projectPath === null && (
                        <Check className="size-4 shrink-0 text-accent" strokeWidth={2} />
                      )}
                    </button>
                  </div>
                </div>
                </>
              )}
            </div>
          )}
          <ComposerBannerStack items={composerBannerItems} />
          <div className={attachmentUploads.attachments.length > 0 ? 'px-3 pt-3' : ''}>
            <AttachmentTray
              attachments={attachmentUploads.attachments}
              onRemove={attachmentUploads.removeAttachment}
              compact={!primary}
            />
          </div>
          <textarea
            ref={textareaRef}
            value={input}
            onPaste={attachmentUploads.handlePaste}
            onChange={(e) => {
              setInput(e.target.value)
              updateComposerCursor(e.currentTarget)
              if (composerError) setComposerError(null)
            }}
            onClick={(e) => updateComposerCursor(e.currentTarget)}
            onKeyUp={(e) => updateComposerCursor(e.currentTarget)}
            onSelect={(e) => updateComposerCursor(e.currentTarget)}
            onKeyDown={(e) => {
              if (composerTrigger) {
                if (e.key === 'ArrowDown') {
                  if (composerMenuItems.length === 0) return
                  e.preventDefault()
                  setComposerMenuCursor((c) =>
                    Math.min(composerMenuItems.length - 1, c + 1),
                  )
                  return
                }
                if (e.key === 'ArrowUp') {
                  if (composerMenuItems.length === 0) return
                  e.preventDefault()
                  setComposerMenuCursor((c) => Math.max(0, c - 1))
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  const next = replaceTextRange(
                    input,
                    composerTrigger?.rangeStart ?? composerCursor,
                    composerTrigger?.rangeEnd ?? composerCursor,
                    '',
                  )
                  setInput(next.text)
                  setComposerCursor(next.cursor)
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (composerMenuItems.length === 0) return
                  const item =
                    composerMenuItems[composerMenuCursor] ?? composerMenuItems[0]
                  if (item) selectComposerItem(item)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={
              canSend
                ? 'Ask anything, $use skills, or / for commands'
                : 'Starting up…'
            }
            disabled={!canSend}
            rows={primary ? 3 : 3}
            className={`w-full resize-none bg-transparent text-ink placeholder:text-ink-faint outline-none disabled:text-ink-faint ${
              primary
                ? 'min-h-[132px] px-4 pb-12 pt-4 text-[14.5px] leading-relaxed'
                : 'px-3 pt-3 pb-9 text-[13px] leading-relaxed'
            }`}
          />
          {composerTrigger && (
            <div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 overflow-hidden rounded-xl border border-rule-strong bg-elevated shadow-modal">
              <div className="flex items-center justify-between gap-3 border-b border-rule px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  {composerTrigger.kind === 'command' ? 'Commands' : 'Skills'}
                </span>
                <span className="font-mono text-[10.5px] text-ink-faint">
                  {composerTrigger.kind === 'command' ? '/' : '$'}
                  {composerTrigger.query}
                </span>
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {composerMenuItems.length > 0 ? (
                  composerMenuItems.map((item, i) => {
                    const active = i === composerMenuCursor
                    const Icon =
                      item.kind === 'skill' || item.source === 'starter'
                        ? Sparkles
                        : SquareTerminal
                    const hint =
                      item.kind === 'command'
                        ? item.source === 'starter'
                          ? `/${item.command}`
                          : `/${composerTokenForRunnable('command', item, savedCommands)}`
                        : `$${composerTokenForRunnable('skill', item, skills)}`
                    return (
                      <button
                        key={`${item.kind}.${item.path}`}
                        type="button"
                        onMouseEnter={() => setComposerMenuCursor(i)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectComposerItem(item)}
                        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                          active
                            ? 'bg-hover text-ink-strong'
                            : 'text-ink-dim hover:bg-hover hover:text-ink'
                        }`}
                      >
                        <Icon
                          className={`size-4 shrink-0 ${
                            item.kind === 'skill'
                              ? 'text-violet-500'
                              : 'text-accent'
                          }`}
                          strokeWidth={2}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-semibold">
                            {item.label}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
                            {item.description}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">
                          {hint}
                        </span>
                      </button>
                    )
                  })
                ) : (
                  <div className="px-3 py-3">
                    <p className="text-[12px] font-medium text-ink-dim">
                      {composerTrigger.kind === 'skill'
                        ? composerTrigger.query
                          ? 'No matching skills'
                          : 'No saved skills yet'
                        : 'No matching commands'}
                    </p>
                    <p className="mt-1 text-[11px] leading-snug text-ink-faint">
                      {composerTrigger.kind === 'skill'
                        ? 'Saved skills will appear here when this workspace has them.'
                        : 'Try a shorter command name.'}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="absolute bottom-2.5 left-3 right-2.5 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <AttachmentUploadButton
                uploader={attachmentUploads}
                disabled={!canSend || sending || busy}
                compact={!primary}
              />
              <ComposerStatusStrip
                primary={primary}
                busy={busy}
                sending={sending}
                messageCount={uiMessages.length + visibleOptimisticTurns.length}
                contextUsage={contextUsage}
                projectPath={projectPath}
                skillCount={skills.length}
                commandCount={savedCommands.length}
                providers={agentProviders}
                selection={agentSelection}
                accessMode={accessMode}
                onAccessModeChange={setAccessMode}
                onSelectionChange={onAgentSelectionChange}
                onSetDefault={onSetAgentDefault}
              />
            </div>
            {sending || busy ? (
              <button
                type="button"
                onClick={() => void stopActiveChat()}
                disabled={stopping || !activeSendTarget}
                className={`grid shrink-0 place-items-center rounded-full bg-ink-strong text-surface shadow-sm transition-[background,opacity,transform] hover:bg-accent-hover active:scale-95 disabled:bg-ink-ghost disabled:cursor-not-allowed disabled:opacity-60 ${
                  primary ? 'size-9' : 'size-7'
                }`}
                title={stopping ? 'Stopping chat' : 'Stop chat'}
                aria-label={stopping ? 'Stopping chat' : 'Stop chat'}
              >
                <span
                  aria-hidden="true"
                  data-stop-square
                  className={`block bg-current ${primary ? 'size-3.5' : 'size-3'}`}
                />
              </button>
            ) : (
              <button
                onClick={() => submit()}
                disabled={
                  !canSend ||
                  attachmentUploads.hasUploading ||
                  (!input.trim() && attachmentUploads.readyAssetIds.length === 0)
                }
                className={`grid shrink-0 place-items-center rounded-full bg-ink-strong text-surface shadow-sm transition-[background,opacity,transform] hover:bg-accent-hover active:scale-95 disabled:bg-ink-ghost disabled:cursor-not-allowed disabled:opacity-60 ${
                  primary ? 'size-9' : 'size-7'
                }`}
                title="Send message"
                aria-label="Send message"
              >
                <Send className={primary ? 'size-4' : 'size-3.5'} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

function SideChatThreadSelector({
  threads,
  activeThreadId,
  activeTitle,
  projectPath,
  onSelectThread,
  onNewThread,
}: {
  threads: ChatThreadOption[]
  activeThreadId: string | null
  activeTitle: string
  projectPath: string | null
  onSelectThread?: (thread: ChatThreadOption) => void
  onNewThread?: (projectPath: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredThreads = useMemo(() => {
    if (!normalizedQuery) return threads
    return threads.filter((thread) => {
      const project = thread.projectPath ?? 'workspace'
      return `${thread.title} ${project}`.toLowerCase().includes(normalizedQuery)
    })
  }, [normalizedQuery, threads])
  const activeProjectLabel = projectPath ?? 'Workspace'
  const newChatLabel = projectPath ? `New chat in ${projectPath}` : 'New workspace chat'

  function closePicker() {
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="group flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-rule bg-page px-2.5 text-left shadow-xs transition hover:border-rule-strong hover:bg-elevated"
        aria-label="Select chat"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={activeTitle}
      >
        <span className="grid size-5 shrink-0 place-items-center rounded-md border border-rule bg-elevated text-ink-dim transition group-hover:text-ink">
          <DohcMark size={12} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold tracking-tight text-ink-strong">
            {activeTitle}
          </span>
          <span className="block truncate text-[10px] font-medium text-ink-faint">
            {activeProjectLabel}
          </span>
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-ink-faint transition-transform ${
            open ? 'rotate-180' : ''
          }`}
          strokeWidth={1.8}
        />
      </button>
      <button
        type="button"
        onClick={() => {
          closePicker()
          onNewThread?.(projectPath)
        }}
        className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-rule bg-page text-ink-dim shadow-xs transition hover:border-rule-strong hover:bg-elevated hover:text-ink"
        aria-label="New chat"
        title={newChatLabel}
      >
        <SquarePen className="size-4" strokeWidth={1.8} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[80]" onClick={closePicker} />
          <div className="absolute left-0 right-0 top-[calc(100%+7px)] z-[90] overflow-hidden rounded-[14px] border border-rule-strong bg-elevated shadow-modal">
            <div className="flex items-center justify-between gap-3 border-b border-rule bg-panel/60 px-2.5 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Chats
              </span>
              <button
                type="button"
                onClick={() => {
                  closePicker()
                  onNewThread?.(projectPath)
                }}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-rule bg-elevated px-2 text-[11px] font-semibold text-ink-dim transition hover:border-rule-strong hover:bg-hover hover:text-ink"
              >
                <SquarePen className="size-3.5 shrink-0" strokeWidth={1.8} />
                <span>New</span>
              </button>
            </div>
            <div className="p-2">
              <label className="flex h-8 items-center gap-2 rounded-lg border border-rule bg-panel px-2.5 text-ink-dim focus-within:border-rule-strong">
                <Search className="size-3.5 shrink-0" strokeWidth={1.8} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search chats"
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
                />
              </label>
              <div
                role="listbox"
                aria-label="Chats"
                className="mt-2 max-h-[min(320px,calc(100vh-180px))] overflow-y-auto"
              >
                {filteredThreads.length === 0 ? (
                  <div className="px-2.5 py-3 text-[12px] text-ink-faint">
                    No chats found.
                  </div>
                ) : (
                  filteredThreads.map((thread) => {
                    const selected = thread.threadId === activeThreadId
                    const projectLabel = thread.projectPath ?? 'Workspace'
                    return (
                      <button
                        key={thread.threadId}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          onSelectThread?.(thread)
                          closePicker()
                        }}
                        className={`flex min-h-10 w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition ${
                          selected
                            ? 'border-rule bg-panel text-ink-strong'
                            : 'border-transparent text-ink-dim hover:border-rule hover:bg-panel/70 hover:text-ink'
                        }`}
                      >
                        <MessageSquare
                          className="size-3.5 shrink-0 text-ink-faint"
                          strokeWidth={1.8}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-semibold">
                            {thread.title || 'Workspace chat'}
                          </span>
                          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-ink-faint">
                            <span className="truncate">{projectLabel}</span>
                            <span aria-hidden="true">·</span>
                            <time dateTime={new Date(thread.updatedAt).toISOString()}>
                              {formatChatTimestamp(thread.updatedAt)}
                            </time>
                          </span>
                        </span>
                        {thread.pinnedAt !== null && thread.pinnedAt !== undefined && (
                          <Pin className="size-3.5 shrink-0 text-ink-faint" strokeWidth={1.8} />
                        )}
                        {selected && <Check className="size-4 shrink-0 text-accent" strokeWidth={2} />}
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function formatComposerError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'dohc could not complete this turn. Try again in a moment.'
}

function isNearScrollBottom(
  el: HTMLElement,
  threshold = STREAM_STICKY_BOTTOM_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

function ComposerBannerStack({ items }: { items: ComposerBannerItem[] }) {
  if (items.length === 0) return null

  return (
    <div className="space-y-2 border-b border-rule bg-panel/50 px-3 py-2">
      {items.map((item) => {
        const tone =
          item.tone === 'danger'
            ? 'border-danger/30 bg-danger-soft text-danger'
            : 'border-rule bg-panel text-ink-dim'
        return (
          <div
            key={item.id}
            className={`flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 shadow-xs ${tone}`}
          >
            <span className="mt-0.5 shrink-0">{item.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-semibold leading-snug">
                {item.title}
              </span>
              {item.description && (
                <span className="mt-0.5 block text-[11.5px] leading-snug opacity-85">
                  {item.description}
                </span>
              )}
            </span>
            {item.onDismiss && (
              <button
                type="button"
                onClick={item.onDismiss}
                className="grid size-6 shrink-0 place-items-center rounded-md opacity-70 transition hover:bg-elevated/60 hover:opacity-100"
                aria-label={item.dismissLabel ?? 'Dismiss'}
                title={item.dismissLabel ?? 'Dismiss'}
              >
                <X className="size-3.5" strokeWidth={2} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ComposerStatusStrip({
  primary,
  busy,
  sending,
  messageCount,
  contextUsage,
  projectPath,
  skillCount,
  commandCount,
  providers,
  selection,
  accessMode,
  onAccessModeChange,
  onSelectionChange,
  onSetDefault,
}: {
  primary: boolean
  busy: boolean
  sending: boolean
  messageCount: number
  contextUsage: ContextWindowUsage
  projectPath: string | null
  skillCount: number
  commandCount: number
  providers: AgentProviderSnapshot[]
  selection: AgentModelPickerSelection | null
  accessMode: AgentAccessMode
  onAccessModeChange: (mode: AgentAccessMode) => void
  onSelectionChange?: (selection: AgentModelPickerSelection) => void
  onSetDefault?: (selection: AgentModelPickerSelection) => void | Promise<void>
}) {
  return (
    <div className="-m-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <AgentModelPicker
        providers={providers}
        selection={selection}
        disabled={!onSelectionChange || sending || busy}
        onChange={(next) => onSelectionChange?.(next)}
        onSetDefault={onSetDefault}
      />
      <AgentAccessPicker
        accessMode={accessMode}
        disabled={sending || busy}
        onChange={onAccessModeChange}
      />
      {primary && (
        <ContextWindowMeter
          messageCount={messageCount}
          usage={contextUsage}
          projectPath={projectPath}
          skillCount={skillCount}
          commandCount={commandCount}
        />
      )}
      {primary && (
        <ComposerStatusPill
          icon={projectPath ? Folder : FolderX}
          label={projectPath ?? 'No project'}
        />
      )}
      {(sending || busy) && (
        <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-rule bg-panel/70 px-2.5 text-[10.5px] font-medium text-ink-faint">
          <span className="size-1.5 rounded-full bg-success animate-pulse" />
          {sending ? 'sending' : 'thinking'}
        </span>
      )}
    </div>
  )
}

const ACCESS_POPOVER_WIDTH = 264
const ACCESS_POPOVER_EDGE_GAP = 12
const ACCESS_POPOVER_TRIGGER_GAP = 8
const ACCESS_FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'

const AGENT_ACCESS_ICONS: Record<AgentAccessMode, IconComponent> = {
  default: Hand,
  'auto-review': ShieldCheck,
  'full-access': Shield,
}

type AccessPopoverFrame = {
  left: number
  top?: number
  bottom?: number
  placement: 'above' | 'below'
}

function accessPopoverFrameForTrigger(
  rect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): AccessPopoverFrame {
  const width = Math.min(
    ACCESS_POPOVER_WIDTH,
    viewportWidth - ACCESS_POPOVER_EDGE_GAP * 2,
  )
  const maxLeft = Math.max(
    ACCESS_POPOVER_EDGE_GAP,
    viewportWidth - width - ACCESS_POPOVER_EDGE_GAP,
  )
  const left = Math.round(
    Math.min(Math.max(ACCESS_POPOVER_EDGE_GAP, rect.left), maxLeft),
  )

  if (rect.top > viewportHeight / 2) {
    return {
      left,
      bottom: Math.round(
        viewportHeight - rect.top + ACCESS_POPOVER_TRIGGER_GAP,
      ),
      placement: 'above',
    }
  }

  return {
    left,
    top: Math.round(rect.bottom + ACCESS_POPOVER_TRIGGER_GAP),
    placement: 'below',
  }
}

export function AgentAccessPicker({
  accessMode,
  disabled,
  onChange,
}: {
  accessMode: AgentAccessMode
  disabled: boolean
  onChange: (mode: AgentAccessMode) => void
}) {
  const [open, setOpen] = useState(false)
  const [frame, setFrame] = useState<AccessPopoverFrame | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const savedFocusRef = useRef<HTMLElement | null>(null)
  const restoreFocusOnCloseRef = useRef(false)
  const selected =
    AGENT_ACCESS_MODE_OPTIONS.find((option) => option.value === accessMode) ??
    AGENT_ACCESS_MODE_OPTIONS.find(
      (option) => option.value === DEFAULT_AGENT_ACCESS_MODE,
    )!
  const SelectedIcon = AGENT_ACCESS_ICONS[selected.value]

  function updateFrame() {
    if (typeof window === 'undefined') return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setFrame(
      accessPopoverFrameForTrigger(
        rect,
        window.innerWidth,
        window.innerHeight,
      ),
    )
  }

  function toggleOpen() {
    if (disabled) return
    if (open) {
      restoreFocusOnCloseRef.current = true
      setOpen(false)
      return
    }
    updateFrame()
    setOpen(true)
  }

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    updateFrame()
    window.addEventListener('resize', updateFrame)
    window.addEventListener('scroll', updateFrame, true)
    return () => {
      window.removeEventListener('resize', updateFrame)
      window.removeEventListener('scroll', updateFrame, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    savedFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : triggerRef.current

    function focusableElements() {
      return Array.from(
        popoverRef.current?.querySelectorAll<HTMLElement>(
          ACCESS_FOCUSABLE_SELECTOR,
        ) ?? [],
      ).filter((element) => !element.hasAttribute('disabled'))
    }

    const focusFrame = window.requestAnimationFrame(() => {
      focusableElements()[0]?.focus()
    })

    function closeFromOutsidePointer(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      const path =
        typeof event.composedPath === 'function' ? event.composedPath() : []
      const insideTrigger =
        triggerRef.current &&
        (triggerRef.current.contains(target) || path.includes(triggerRef.current))
      const insidePopover =
        popoverRef.current &&
        (popoverRef.current.contains(target) || path.includes(popoverRef.current))

      if (!insideTrigger && !insidePopover) {
        restoreFocusOnCloseRef.current = false
        setOpen(false)
      }
    }

    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        restoreFocusOnCloseRef.current = true
        setOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements()
      if (focusable.length < 1) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('pointerdown', closeFromOutsidePointer, true)
    document.addEventListener('keydown', closeFromKeyboard)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('pointerdown', closeFromOutsidePointer, true)
      document.removeEventListener('keydown', closeFromKeyboard)
      if (restoreFocusOnCloseRef.current) {
        const restoreTarget = triggerRef.current ?? savedFocusRef.current
        restoreTarget?.focus()
      }
      restoreFocusOnCloseRef.current = false
      savedFocusRef.current = null
    }
  }, [open])

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggleOpen}
        disabled={disabled}
        className="inline-flex h-7 max-w-[210px] items-center gap-1.5 rounded-full border border-rule bg-panel/70 px-2.5 text-[10.5px] font-medium text-ink-dim shadow-xs transition hover:border-rule-strong hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
        title={selected.description}
        aria-label="Access permissions"
        aria-expanded={open}
      >
        <SelectedIcon className="size-3 shrink-0 text-ink-faint" strokeWidth={1.9} />
        <span className="min-w-0 truncate">{selected.label}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-faint" strokeWidth={1.9} />
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[80]"
              onClick={() => {
                restoreFocusOnCloseRef.current = false
                setOpen(false)
              }}
            />
            <div
              ref={popoverRef}
              className="fixed z-[90] w-[264px] max-w-[calc(100vw-24px)] rounded-xl border border-rule-strong bg-elevated p-1.5 shadow-modal"
              style={{
                left: frame?.left ?? ACCESS_POPOVER_EDGE_GAP,
                ...(frame?.placement === 'below'
                  ? { top: frame.top ?? 72 }
                  : { bottom: frame?.bottom ?? 72 }),
              }}
            >
              {AGENT_ACCESS_MODE_OPTIONS.map((option) => {
                const active = option.value === accessMode
                const OptionIcon = AGENT_ACCESS_ICONS[option.value]
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChange(option.value)
                      restoreFocusOnCloseRef.current = true
                      setOpen(false)
                    }}
                    className={`flex min-h-11 w-full items-center gap-2 whitespace-normal rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ink-faint ${
                      active
                        ? 'bg-hover text-ink-strong'
                        : 'text-ink-dim hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <OptionIcon
                      className="size-4 shrink-0 text-ink-faint"
                      strokeWidth={1.8}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">
                        {option.label}
                      </span>
                      <span
                        data-access-description
                        className="mt-0.5 block whitespace-normal break-words text-[10.5px] leading-snug text-ink-faint"
                      >
                        {option.description}
                      </span>
                    </span>
                    {active && (
                      <Check className="size-4 shrink-0 text-accent" strokeWidth={2} />
                    )}
                  </button>
                )
              })}
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}

function ComposerStatusPill({
  icon: Icon,
  label,
}: {
  icon: IconComponent
  label: string
}) {
  return (
    <span
      className="inline-flex h-7 max-w-[190px] shrink-0 items-center gap-1.5 rounded-full border border-rule bg-panel/70 px-2.5 text-[10.5px] font-medium text-ink-faint"
      title={label}
    >
      <Icon className="size-3 shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}

const CONTEXT_TOOLTIP_WIDTH = 240
const CONTEXT_TOOLTIP_EDGE_GAP = 12
const CONTEXT_TOOLTIP_TRIGGER_GAP = 10

type ContextTooltipFrame = {
  left: number
  top?: number
  bottom?: number
}

function contextTooltipFrameForTrigger(
  rect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): ContextTooltipFrame {
  const width = Math.min(
    CONTEXT_TOOLTIP_WIDTH,
    viewportWidth - CONTEXT_TOOLTIP_EDGE_GAP * 2,
  )
  const maxLeft = Math.max(
    CONTEXT_TOOLTIP_EDGE_GAP,
    viewportWidth - width - CONTEXT_TOOLTIP_EDGE_GAP,
  )
  const left = Math.round(
    Math.min(
      Math.max(CONTEXT_TOOLTIP_EDGE_GAP, rect.left + rect.width / 2 - width / 2),
      maxLeft,
    ),
  )

  if (rect.top > viewportHeight / 2) {
    return {
      left,
      bottom: Math.round(
        viewportHeight - rect.top + CONTEXT_TOOLTIP_TRIGGER_GAP,
      ),
    }
  }

  return {
    left,
    top: Math.round(rect.bottom + CONTEXT_TOOLTIP_TRIGGER_GAP),
  }
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}m`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

export function ContextWindowMeter({
  messageCount,
  usage,
  projectPath,
  skillCount,
  commandCount,
}: {
  messageCount: number
  usage: ContextWindowUsage
  projectPath: string | null
  skillCount: number
  commandCount: number
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [tooltipFrame, setTooltipFrame] = useState<ContextTooltipFrame | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const radius = 8.5
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (usage.percent / 100) * circumference
  const strokeColor =
    usage.percent >= 90
      ? 'var(--color-danger)'
      : usage.percent >= 70
      ? 'var(--color-warning)'
      : 'var(--color-ink-faint)'
  const tooltipId = useId()
  const messageLabel = messageCount === 1 ? 'message' : 'messages'
  const compactPercent = Math.round(AUTO_COMPACT_TARGET_RATIO * 100)
  const estimatedLabel = `~${formatTokenCount(usage.estimatedTokens)}`
  const compactAtLabel = formatTokenCount(usage.compactAtTokens)
  const contextWindowLabel = formatTokenCount(usage.contextWindowTokens)
  const summary = `${estimatedLabel} of ${compactAtLabel} tokens before auto compact`
  const countLabel = `${usage.percent}%`

  function updateTooltipFrame() {
    if (typeof window === 'undefined') return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setTooltipFrame(
      contextTooltipFrameForTrigger(rect, window.innerWidth, window.innerHeight),
    )
  }

  useEffect(() => {
    if (!detailsOpen || typeof window === 'undefined') return
    updateTooltipFrame()
    window.addEventListener('resize', updateTooltipFrame)
    window.addEventListener('scroll', updateTooltipFrame, true)
    return () => {
      window.removeEventListener('resize', updateTooltipFrame)
      window.removeEventListener('scroll', updateTooltipFrame, true)
    }
  }, [detailsOpen])

  useEffect(() => {
    if (!detailsOpen || typeof document === 'undefined') return

    function closeFromOutsidePointer(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      const path =
        typeof event.composedPath === 'function' ? event.composedPath() : []
      const insideTrigger =
        triggerRef.current &&
        (triggerRef.current.contains(target) || path.includes(triggerRef.current))

      if (!insideTrigger) setDetailsOpen(false)
    }

    document.addEventListener('pointerdown', closeFromOutsidePointer, true)
    return () => {
      document.removeEventListener('pointerdown', closeFromOutsidePointer, true)
    }
  }, [detailsOpen])

  const detailsPanel =
    detailsOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            className={`pointer-events-none fixed z-50 w-60 rounded-lg border border-rule-strong bg-elevated p-2.5 text-left shadow-md transition-[opacity,transform] duration-150 ${
              detailsOpen ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
            }`}
            style={{
              left: tooltipFrame?.left ?? CONTEXT_TOOLTIP_EDGE_GAP,
              ...(tooltipFrame?.top !== undefined
                ? { top: tooltipFrame.top }
                : { bottom: tooltipFrame?.bottom ?? 72 }),
            }}
          >
            <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Context window
            </span>
            <span className="mt-2 grid gap-1 text-[11.5px] leading-snug">
              <span className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Used</span>
                <span className="font-medium text-ink">
                  {estimatedLabel} / {compactAtLabel} tokens
                </span>
              </span>
              <span className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Auto compact</span>
                <span className="font-medium text-ink">
                  {compactPercent}% of {contextWindowLabel}
                </span>
              </span>
              <span className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Thread</span>
                <span className="font-medium text-ink">
                  {messageCount} {messageLabel} loaded
                </span>
              </span>
              <span className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Project</span>
                <span className="min-w-0 truncate text-right font-medium text-ink">
                  {projectPath ?? 'None'}
                </span>
              </span>
              <span className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Skills</span>
                <span className="font-medium text-ink">{skillCount}</span>
              </span>
              <span className="flex items-center justify-between gap-3">
                <span className="text-ink-faint">Commands</span>
                <span className="font-medium text-ink">{commandCount}</span>
              </span>
              {usage.isEstimate && (
                <span className="mt-1 border-t border-rule pt-1 text-[10.5px] leading-snug text-ink-faint">
                  Estimate from loaded chat text until server token accounting is wired.
                </span>
              )}
            </span>
          </div>,
          document.body,
        )
      : null

  return (
    <span className="relative inline-flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateTooltipFrame()
          setDetailsOpen((open) => !open)
        }}
        className="inline-grid size-7 place-items-center rounded-full border border-rule bg-panel/70 text-[8px] font-semibold text-ink-faint transition-[border,background,color,transform] hover:border-rule-strong hover:bg-hover hover:text-ink focus-visible:border-rule-strong focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none active:scale-95"
        title="Context window"
        aria-label={`Context window: ${summary}`}
        aria-expanded={detailsOpen}
        aria-describedby={detailsOpen ? tooltipId : undefined}
      >
        <span className="relative grid size-6 place-items-center">
          <svg
            viewBox="0 0 24 24"
            className="absolute inset-0 size-6 -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke="var(--color-rule)"
              strokeWidth="2.4"
            />
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke={strokeColor}
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              strokeWidth="2.4"
              className="transition-[stroke-dashoffset,stroke] duration-300"
            />
          </svg>
          <span className="relative text-[7.5px]">{countLabel}</span>
        </span>
      </button>
      {detailsPanel}
    </span>
  )
}

function HeaderThreadMenu({
  title,
  pinned,
  onTogglePinned,
  onRenameThread,
  onDeleteThread,
}: {
  title: string
  pinned: boolean
  onTogglePinned?: () => ChatActionResult
  onRenameThread?: (title: string) => ChatActionResult
  onDeleteThread?: () => ChatActionResult
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'menu' | 'rename' | 'delete'>('menu')
  const [value, setValue] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMode('menu')
    setValue(title)
    setError(null)
  }, [open, title])

  async function runAction(action: () => ChatActionResult) {
    setBusy(true)
    setError(null)
    try {
      await action()
      setOpen(false)
    } catch (e) {
      setError((e as Error).message || 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  async function commitRename() {
    const clean = value.trim()
    if (!clean) {
      setError('Chat name is required.')
      return
    }
    if (!onRenameThread) return
    await runAction(() => onRenameThread(clean))
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="grid size-7 place-items-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink"
        title="Chat actions"
        aria-label="chat actions"
        aria-expanded={open}
      >
        <MoreHorizontal className="size-4" strokeWidth={2} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-8 z-30 w-60 overflow-hidden rounded-lg border border-rule bg-elevated p-1 shadow-modal">
            {mode === 'menu' && (
              <>
                {onTogglePinned && (
                  <HeaderThreadMenuButton
                    icon={Pin}
                    label={pinned ? 'Unpin chat' : 'Pin chat'}
                    disabled={busy}
                    onClick={() => void runAction(onTogglePinned)}
                  />
                )}
                {onRenameThread && (
                  <HeaderThreadMenuButton
                    icon={Pencil}
                    label="Rename chat"
                    disabled={busy}
                    onClick={() => setMode('rename')}
                  />
                )}
                {onDeleteThread && (
                  <HeaderThreadMenuButton
                    icon={Trash2}
                    label="Delete chat"
                    danger
                    disabled={busy}
                    onClick={() => setMode('delete')}
                  />
                )}
              </>
            )}

            {mode === 'rename' && (
              <div className="p-2">
                <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  Chat name
                </label>
                <input
                  autoFocus
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value)
                    setError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') setMode('menu')
                  }}
                  className="mt-2 h-8 w-full rounded-md border border-rule bg-page px-2 text-[12.5px] text-ink outline-none focus:border-rule-strong"
                />
                <div className="mt-2 flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setMode('menu')}
                    disabled={busy}
                    className="h-7 rounded-md px-2.5 text-[12px] font-medium text-ink-dim hover:bg-hover hover:text-ink disabled:text-ink-faint"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void commitRename()}
                    disabled={busy}
                    className="h-7 rounded-md bg-ink-strong px-2.5 text-[12px] font-medium text-surface hover:bg-ink disabled:bg-ink-ghost"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}

            {mode === 'delete' && onDeleteThread && (
              <div className="p-2">
                <p className="text-[12.5px] font-medium text-ink-strong">
                  Delete this chat?
                </p>
                <p className="mt-1 text-[11.5px] leading-snug text-ink-dim">
                  This removes it from your history.
                </p>
                <div className="mt-3 flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setMode('menu')}
                    disabled={busy}
                    className="h-7 rounded-md px-2.5 text-[12px] font-medium text-ink-dim hover:bg-hover hover:text-ink disabled:text-ink-faint"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void runAction(onDeleteThread)}
                    disabled={busy}
                    className="h-7 rounded-md bg-danger px-2.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}

            {error && (
              <p
                role="alert"
                className="m-1 mt-0 rounded-md border border-danger/30 bg-danger-soft px-2 py-1.5 text-[11.5px] leading-snug text-danger"
              >
                {error}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function HeaderThreadMenuButton({
  icon: Icon,
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  icon: IconComponent
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12.5px] font-medium hover:bg-hover disabled:text-ink-faint disabled:hover:bg-transparent ${
        danger ? 'text-danger' : 'text-ink'
      }`}
    >
      <Icon className="size-3.5 shrink-0 text-ink-dim" strokeWidth={1.8} />
      <span className="truncate">{label}</span>
    </button>
  )
}

function AgentContextPill({
  icon: Icon,
  label,
}: {
  icon: IconComponent
  label: string
}) {
  return (
    <span className="hidden max-w-[240px] items-center gap-1.5 rounded-full border border-rule bg-elevated px-2.5 py-1 text-[10.5px] font-medium text-ink-faint shadow-xs md:inline-flex">
      <Icon className="size-3.5 shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}

function ScrollToBottomButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-4 left-1/2 z-10 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-rule bg-elevated px-3 text-[11.5px] font-medium text-ink-dim shadow-md backdrop-blur transition hover:border-rule-strong hover:bg-hover hover:text-ink"
    >
      <ChevronDown className="size-3.5" strokeWidth={2} />
      latest
    </button>
  )
}

function EmptyChatState({
  primary,
  onSelectPrompt,
}: {
  primary: boolean
  onSelectPrompt: (prompt: string) => void
}) {
  if (!primary) {
    return (
      <div className="flex flex-col items-start gap-2 pt-1">
        <div className="flex items-center gap-1.5">
          <DohcMark size={14} />
          <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold">
            dohc
          </span>
        </div>
        <p className="text-[18px] font-semibold leading-snug tracking-tight text-ink-strong">
          What can I help you with?
        </p>
      </div>
    )
  }

  const starters = [
    {
      title: 'Build my project cockpit',
      prompt:
        'Build a source-backed project cockpit for this work. Start by asking only for the context you actually need.',
    },
    {
      title: 'Review this workspace',
      prompt:
        'Review this workspace and tell me what is clear, what is missing, and what the next useful action should be.',
    },
    {
      title: 'Turn notes into a plan',
      prompt:
        'Turn my loose notes into a practical plan with decisions, open questions, and next actions.',
    },
    {
      title: 'Create a dashboard',
      prompt:
        'Create a polished dashboard from the available source files. If there is not enough source context, say what to capture first.',
    },
  ]

  return (
    <div className="flex min-h-[44vh] flex-col justify-center">
      <div className="max-w-[640px]">
        <div className="inline-flex items-center gap-2 rounded-full border border-rule bg-elevated px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint shadow-xs">
          <DohcMark size={14} />
          agent workspace
        </div>
        <h2 className="mt-5 text-[34px] font-semibold leading-[1.05] tracking-tight text-ink-strong">
          What should we build in dohc?
        </h2>
        <div className="mt-7">
          <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Choose a first move
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {starters.map((starter) => (
              <button
                key={starter.title}
                type="button"
                onClick={() => onSelectPrompt(starter.prompt)}
                className="group flex min-h-[104px] items-start gap-3 rounded-lg border border-rule bg-elevated/82 p-3.5 text-left shadow-xs transition-[border,background,transform,box-shadow] hover:-translate-y-0.5 hover:border-rule-strong hover:bg-surface hover:shadow-md"
              >
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-rule bg-panel text-ink-dim transition-colors group-hover:text-ink">
                  <Sparkles className="size-3.5" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1 whitespace-normal break-words">
                  <span className="block text-[13px] font-semibold leading-snug text-ink-strong">
                    {starter.title}
                  </span>
                  <span className="mt-1.5 block text-[11.5px] leading-relaxed text-ink-faint">
                    {starter.prompt}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const OptimisticTurnView = memo(function OptimisticTurnView({
  turn,
  primary,
}: {
  turn: OptimisticChatTurn
  primary: boolean
}) {
  const timestampLabel = formatChatTimestamp(turn.createdAt)
  return (
    <>
      <div className="group/message flex w-full justify-end">
        <div className={`min-w-0 ${primary ? 'max-w-[76%]' : 'max-w-[88%]'}`}>
          <div className="mb-1.5 flex items-center justify-end gap-1.5 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              you
            </span>
            {timestampLabel && (
              <time
                dateTime={new Date(turn.createdAt).toISOString()}
                className="text-[10px] font-medium text-ink-faint"
                title={new Date(turn.createdAt).toLocaleString()}
              >
                {timestampLabel}
              </time>
            )}
          </div>
          <div className="rounded-lg border border-rule bg-elevated px-3.5 py-2.5 shadow-xs">
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
              {turn.displayText}
            </div>
          </div>
        </div>
      </div>
      <div className="flex w-full justify-start" aria-live="polite">
        <div className="min-w-0 max-w-full flex-1">
          <div className="mb-1.5 flex items-center gap-1.5 px-1">
            <DohcMark size={13} />
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              dohc
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-faint">
              <span className="size-1 rounded-full bg-success animate-pulse" />
              thinking
            </span>
          </div>
          <div
            className={
              primary
                ? 'rounded-lg border border-rule bg-surface/72 px-4 py-3 shadow-xs'
                : 'rounded-lg border border-rule bg-elevated/50 px-3 py-2.5'
            }
          >
            <span className="inline-flex items-center gap-2 text-[12.5px] font-medium text-ink-faint">
              <span className="size-1.5 rounded-full bg-success animate-pulse" />
              thinking
            </span>
          </div>
        </div>
      </div>
    </>
  )
})

const MessageView = memo(function MessageView({
  message,
  previousMessage = null,
  primary = false,
}: {
  message: UIMessage
  previousMessage?: UIMessage | null
  primary?: boolean
}) {
  const streaming = (message as { status?: string }).status === 'streaming'
  const now = useNow(streaming)
  if (message.role === 'system') return null
  const isUser = message.role === 'user'
  const text = uiMessageDisplayText(message)
  const timestamp = (message as { _creationTime?: number })._creationTime
  const timestampLabel = formatChatTimestamp(timestamp)
  const toolCalls = message.parts.filter(
    (part) =>
      part.type !== 'reasoning' &&
      part.type !== 'text' &&
      isToolActivityPart(part),
  ) as ToolActivityPart[]
  const hasFileParts = message.parts.some((part) => part.type === 'file')
  const workedDurationMs = !isUser
    ? workedDurationForMessage(message, previousMessage, now)
    : null

  if (!text.trim() && toolCalls.length === 0 && !hasFileParts) return null

  return (
    <div
      className={`group/message flex w-full ${
        isUser ? 'justify-end' : 'justify-start'
      }`}
    >
      <div
        className={`min-w-0 ${
          isUser
            ? primary
              ? 'max-w-[76%]'
              : 'max-w-[88%]'
            : 'max-w-full flex-1'
        }`}
      >
        <div
          className={`mb-1.5 flex items-center gap-1.5 px-1 ${
            isUser ? 'justify-end' : 'justify-start'
          }`}
        >
          {!isUser && <DohcMark size={13} />}
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            {isUser ? 'you' : 'dohc'}
          </span>
          {timestampLabel && (
            <time
              dateTime={new Date(timestamp!).toISOString()}
              className="text-[10px] font-medium text-ink-faint"
              title={new Date(timestamp!).toLocaleString()}
            >
              {timestampLabel}
            </time>
          )}
          {streaming && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-faint">
              <span className="size-1 rounded-full bg-success animate-pulse" />
              writing
            </span>
          )}
        </div>

        <div
          className={
            isUser
              ? 'rounded-lg border border-rule bg-elevated px-3.5 py-2.5 shadow-xs'
              : primary
                ? 'rounded-lg border border-rule bg-surface/72 px-4 py-3 shadow-xs'
                : 'rounded-lg border border-rule bg-elevated/50 px-3 py-2.5'
          }
        >
          {!isUser && toolCalls.length > 0 && (
            <AgentWorkTrace
              toolCalls={toolCalls}
              durationMs={workedDurationMs}
              streaming={streaming}
              compact={!primary}
              hasText={Boolean(text.trim())}
            />
          )}
          {text.trim() && (
            isUser ? (
              <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
                {text}
              </div>
            ) : (
              <Markdown>{text}</Markdown>
            )
          )}
          <MessageFileParts parts={message.parts} />
        </div>

        {text.trim() && (
          <MessageActions text={text} align={isUser ? 'right' : 'left'} />
        )}
      </div>
    </div>
  )
})

function AgentWorkTrace({
  toolCalls,
  durationMs,
  streaming,
  compact,
  hasText,
}: {
  toolCalls: ToolActivityPart[]
  durationMs: number | null
  streaming: boolean
  compact: boolean
  hasText: boolean
}) {
  const [open, setOpen] = useState(false)
  const summary = agentWorkTraceSummary(toolCalls)
  const duration = formatWorkedDuration(durationMs)
  const label = streaming ? `Working for ${duration}` : `Worked for ${duration}`

  return (
    <div
      className={`${
        hasText ? 'mb-4 border-b border-rule pb-3' : ''
      } ${compact ? 'text-[11px]' : 'text-[12px]'}`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group/trace inline-flex max-w-full items-center gap-2 rounded-md px-1 py-1 text-left text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        aria-expanded={open}
      >
        <span className="truncate font-medium">{label}</span>
        <ChevronDown
          className={`size-3 shrink-0 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
          strokeWidth={1.8}
        />
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 text-ink-faint">
            <span className="h-px min-w-4 flex-1 bg-rule" />
            <span className="truncate font-medium">{summary.label}</span>
            <span className="h-px min-w-4 flex-1 bg-rule" />
          </div>
          <div className="space-y-1.5">
            {toolCalls.map((part, index) => (
              <ToolTraceDetails key={toolTraceKey(part, index)} part={part} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ToolTraceDetails({ part }: { part: ToolActivityPart }) {
  const presentation = toolCallPresentation(part)
  const inputPayload = formatToolPayload(presentation.input)
  const outputPayload =
    presentation.errorText ?? formatToolPayload(presentation.output)

  return (
    <details className="group/tool rounded-md border border-transparent open:border-rule open:bg-panel/55">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-ink-dim transition-colors hover:bg-hover hover:text-ink [&::-webkit-details-marker]:hidden">
        <ToolActivityIcon kind={presentation.kind} />
        <span className="shrink-0 font-medium text-ink">
          {presentation.label}
        </span>
        {presentation.detail && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
            {presentation.detail}
          </span>
        )}
        {presentation.state && presentation.state !== 'output-available' && (
          <span className="shrink-0 rounded-full border border-rule bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">
            {presentation.state}
          </span>
        )}
        <ChevronDown
          className="size-3 shrink-0 text-ink-faint transition-transform group-open/tool:rotate-180"
          strokeWidth={1.8}
        />
      </summary>
      <div className="space-y-2 px-2 pb-2 pt-1">
        <ToolPayloadBlock label="Tool" value={presentation.toolName} />
        {inputPayload && <ToolPayloadBlock label="Input" value={inputPayload} />}
        {outputPayload && (
          <ToolPayloadBlock
            label={presentation.errorText ? 'Error' : 'Output'}
            value={outputPayload}
          />
        )}
      </div>
    </details>
  )
}

function ToolPayloadBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-rule bg-page/70">
      <div className="border-b border-rule px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2 py-2 font-mono text-[11px] leading-relaxed text-ink-dim">
        {value}
      </pre>
    </div>
  )
}

function workedDurationForMessage(
  message: UIMessage,
  previousMessage: UIMessage | null,
  now: number,
): number | null {
  const previousTime =
    previousMessage?.role === 'user'
      ? (previousMessage as { _creationTime?: number })._creationTime
      : null
  const assistantTime = (message as { _creationTime?: number })._creationTime
  if (typeof previousTime !== 'number') return null
  const status = (message as { status?: string }).status
  const end = status === 'streaming' ? now : assistantTime
  if (typeof end !== 'number') return null
  return Math.max(0, end - previousTime)
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [enabled])
  return now
}

function toolTraceKey(part: ToolActivityPart, index: number): string {
  const callId =
    typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
      ? (part as { toolCallId: string }).toolCallId
      : null
  return callId ?? `${part.type ?? 'tool'}-${index}`
}

function ToolActivityIcon({ kind }: { kind: ToolActivityKind }) {
  const Icon =
    kind === 'command'
      ? SquareTerminal
      : kind === 'search'
        ? Search
        : kind === 'file_change'
          ? Pencil
          : kind === 'read'
            ? FileText
            : Sparkles
  return <Icon className="size-3 shrink-0 text-ink-faint" strokeWidth={1.8} />
}

function MessageActions({
  text,
  align,
}: {
  text: string
  align: 'left' | 'right'
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1300)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      className={`mt-1 flex opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 ${
        align === 'right' ? 'justify-end' : 'justify-start'
      }`}
    >
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        title="Copy message"
        aria-label="Copy message"
      >
        {copied ? (
          <CheckCircle2 className="size-3 text-success" strokeWidth={2} />
        ) : (
          <Clipboard className="size-3" strokeWidth={1.8} />
        )}
        <span>{copied ? 'copied' : 'copy'}</span>
      </button>
    </div>
  )
}
