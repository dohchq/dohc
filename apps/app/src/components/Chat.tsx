import { useState, useRef, useEffect, useMemo } from 'react'
import { useAction, useQuery } from 'convex/react'
import { useUIMessages, type UIMessage } from '@convex-dev/agent/react'
import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  FolderX,
  Plus,
  Search,
  Send,
  Sparkles,
  SquareTerminal,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { Markdown } from './Markdown'
import { DohcMark } from './DohcLogo'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { useSetChatBusy } from '../lib/chat-busy'

// Track-3 P3 — slash-command detection. EXACT design-pinned
// grammar (skills-commands-v1 §3.3 line 317):
//   SKILL_COMMAND_RE = /^\/skill\s+([\w./-]+)(?:\s+(.*))?$/
// `/skill <path>` fires the skill; `/skill` alone, `/Skill ...`,
// or any other `/<token>` form is REGULAR CHAT (the model
// receives the prompt verbatim). The strict literal keyword
// `skill` removes the UX surprise where typing `/help` would
// silently fire a skill named "help" — indep P3+P4 review F3.
//
// Discovery still happens via the ⌘K palette (shows labels +
// paths); fire happens via the explicit `/skill <path>` typed
// or via palette click (palette uses the dedicated onFireSkill
// channel, not detectSkillFire — see CommandPalette.tsx).
const SKILL_COMMAND_RE = /^\/skill\s+([\w./-]+)(?:\s+([\s\S]+))?$/
const COMMAND_FIRE_RE = /^\/([\w./-]+)(?:\s+([\s\S]+))?$/

type RunnableRef = { path: string; label: string }
type EnvironmentOption = { value: string | null; label: string }

export function detectSkillFire(
  prompt: string,
  skills: ReadonlyArray<RunnableRef>,
):
  | { matched: { path: string; label: string }; extras: string | null }
  | { ambiguous: ReadonlyArray<{ path: string; label: string }> }
  | null {
  const trimmed = prompt.trim()
  const m = trimmed.match(SKILL_COMMAND_RE)
  if (!m) return null
  const token = m[1]
  const extras = m[2]?.trim() || null // P3+P4 indep fold F4
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

type Props = {
  threadId: string | null
  projectPath?: string | null
  projectOptions?: EnvironmentOption[]
  folderOptions?: string[]
  onProjectPathChange?: (projectPath: string | null) => void
  onCreateProject?: (mode: 'scratch' | 'existing') => void
  onEnsureThread?: (projectPath: string | null) => Promise<string>
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
  projectPath = null,
  projectOptions = [],
  folderOptions = [],
  onProjectPathChange,
  onCreateProject,
  onEnsureThread,
  mode = 'side',
  pendingPrompt,
  onPendingHandled,
  pendingSkillFire,
  onPendingSkillFireHandled,
  pendingCommandFire,
  onPendingCommandFireHandled,
}: Props) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [slashCursor, setSlashCursor] = useState(0)
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const [environmentQuery, setEnvironmentQuery] = useState('')
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const sendMessage = useAction(api.agent.sendMessage)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Track-3 P3 — subscribe to the user's saved skills for slash-
  // command resolution. The query is cheap (one workspace-keyed
  // collect; filtered to type:skill under .skills/).
  // org-plan §5: active workspace threaded through skills + the
  // (org-plan §5 non-defaultable) listMessages thread surface. The
  // agent.sendMessage action remains personal-default for now (an
  // action cannot validate active membership; the thread itself
  // binds to a workspace via threadRefs, which is the long-term fix).
  const activeWorkspaceId = useActiveWorkspaceId()
  const skills = useQuery(api.skills.list, { activeWorkspaceId }) ?? []
  const savedCommands =
    useQuery(api.skills.listCommands, { activeWorkspaceId }) ?? []

  const messagesQuery = useUIMessages(
    api.agent.listMessages,
    threadId ? { threadId, activeWorkspaceId, projectPath } : 'skip',
    { initialNumItems: 50, stream: true },
  )

  const uiMessages: UIMessage[] = useMemo(() => {
    if (!messagesQuery || messagesQuery.status === 'LoadingFirstPage') return []
    return messagesQuery.results ?? []
  }, [messagesQuery])

  const busy = useMemo(
    () =>
      uiMessages.some(
        (m) =>
          m.role === 'assistant' &&
          (m as { status?: string }).status === 'streaming',
      ),
    [uiMessages],
  )

  // F1 (multiplayer-and-h-followups §7) — publish busy state up to
  // ChatBusyContext so the WorkspaceSwitcher can disable itself while
  // a stream is mid-flight. Without this, switching workspace mid-send
  // navigates (R1 commit 3) → chat rebinds to new workspace's thread
  // → in-flight assistant tokens are orphaned. v1 fix: block the
  // switcher. v2 (deferred): confirm dialog + AbortController via the
  // agent action.
  const setChatBusy = useSetChatBusy()
  useEffect(() => {
    setChatBusy(busy)
    return () => setChatBusy(false)
  }, [busy, setChatBusy])

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [uiMessages])

  async function submit(promptOverride?: string) {
    const prompt = (promptOverride ?? input).trim()
    if (!prompt || sending || busy) return
    // Track-3 P3 — slash-command routing. A leading `/<token>`
    // that resolves to a saved skill flips this turn into
    // skill-fire mode (the prepareStep BRACE restricts step 0's
    // tools to {run_skill} + toolChoice forces the call).
    // Ambiguous label collisions surface as a chat hint without
    // firing; unmatched slash-prefixes pass through as a normal
    // prompt (the model sees the literal "/" prefix and replies).
    const match = detectSkillFire(prompt, skills)
    const commandMatch = match ? null : detectCommandFire(prompt, savedCommands)
    setSending(true)
    try {
      if (match && 'ambiguous' in match) {
        // Surface the collision as a local UI nudge — do NOT fire
        // sendMessage (the user must disambiguate). Append to the
        // input so they can pick.
        const list = match.ambiguous.map((s) => s.path).join('\n  ')
        setInput(
          `${prompt}\n\n[multiple skills match this label — pick one of:]\n  ${list}`,
        )
        setSending(false)
        return
      }
      const activeThreadId =
        threadId ?? (onEnsureThread ? await onEnsureThread(projectPath) : null)
      if (!activeThreadId) return
      if (!promptOverride) setInput('')
      if (match && 'matched' in match) {
        // P3+P4 indep fold F4: preserve user extras as
        // context the model sees AFTER run_skill returns the
        // body. Format: `<path>\n\n<extras>`. At step 0 the
        // model is forced to call run_skill({path}); at step
        // 1 it sees both the skill body (tool_result) AND
        // the user's brief (in the original prompt) and can
        // act on the user's specific intent within the
        // skill's instructions.
        const promptText = match.extras
          ? `${match.matched.path}\n\n${match.extras}`
          : match.matched.path
        await sendMessage({
          threadId: activeThreadId,
          prompt: promptText,
          entry: 'skill-fire',
          activeWorkspaceId,
          projectPath,
        })
        return
      }
      if (commandMatch && 'ambiguous' in commandMatch) {
        const list = commandMatch.ambiguous.map((c) => c.path).join('\n  ')
        setInput(
          `${prompt}\n\n[multiple commands match this label — pick one of:]\n  ${list}`,
        )
        setSending(false)
        return
      }
      if (commandMatch && 'matched' in commandMatch) {
        const promptText = commandMatch.extras
          ? `${commandMatch.matched.path}\n\n${commandMatch.extras}`
          : commandMatch.matched.path
        await sendMessage({
          threadId: activeThreadId,
          prompt: promptText,
          entry: 'command-fire',
          activeWorkspaceId,
          projectPath,
        })
        return
      }
      await sendMessage({
        threadId: activeThreadId,
        prompt,
        activeWorkspaceId,
        projectPath,
      })
    } catch (e) {
      console.error(e)
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    if (!pendingPrompt || (!threadId && !onEnsureThread) || sending || busy) return
    submit(pendingPrompt)
    onPendingHandled?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt, threadId])

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
    setSending(true)
    void (async () => {
      try {
        const activeThreadId =
          threadId ?? (onEnsureThread ? await onEnsureThread(projectPath) : null)
        if (!activeThreadId) return
        await sendMessage({
          threadId: activeThreadId,
          prompt: path,
          entry: 'skill-fire',
          activeWorkspaceId,
          projectPath,
        })
      } catch (e) {
        console.error(e)
      } finally {
        setSending(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSkillFire, threadId, sending, busy, onEnsureThread, projectPath])

  useEffect(() => {
    if (!pendingCommandFire || (!threadId && !onEnsureThread) || sending || busy) return
    const path = pendingCommandFire
    onPendingCommandFireHandled?.()
    setSending(true)
    void (async () => {
      try {
        const activeThreadId =
          threadId ?? (onEnsureThread ? await onEnsureThread(projectPath) : null)
        if (!activeThreadId) return
        await sendMessage({
          threadId: activeThreadId,
          prompt: path,
          entry: 'command-fire',
          activeWorkspaceId,
          projectPath,
        })
      } catch (e) {
        console.error(e)
      } finally {
        setSending(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCommandFire, threadId, sending, busy, onEnsureThread, projectPath])

  const slashQuery = useMemo(() => {
    const m = input.match(/^\s*\/([^\s]*)$/)
    return m ? m[1].toLowerCase() : null
  }, [input])

  const slashItems = useMemo(() => {
    if (slashQuery === null) return []
    const rows = [
      ...savedCommands.map((c) => ({ ...c, kind: 'command' as const })),
      ...skills.map((s) => ({ ...s, kind: 'skill' as const })),
    ]
    if (!slashQuery) return rows
    return rows.filter(
      (r) =>
        r.label.toLowerCase().includes(slashQuery) ||
        r.path.toLowerCase().includes(slashQuery),
    )
  }, [savedCommands, skills, slashQuery])

  useEffect(() => {
    setSlashCursor((c) => Math.min(c, Math.max(0, slashItems.length - 1)))
  }, [slashItems.length])

  function fireSlashItem(item: (typeof slashItems)[number]) {
    if ((!threadId && !onEnsureThread) || sending || busy) return
    if (item.kind === 'command') {
      void submit(`/${item.path}`)
    } else {
      void submit(`/skill ${item.path}`)
    }
    setInput('')
  }

  const primary = mode === 'primary'
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

  return (
    <aside
      className={`flex h-screen flex-col ${
        primary
          ? 'bg-page'
          : 'bg-panel border-l border-rule'
      }`}
    >
      <header
        className={`flex items-center justify-between border-b border-rule ${
          primary ? 'h-14 px-6' : 'h-11 px-4'
        }`}
      >
        <div className="flex items-center gap-2 text-ink-dim">
          <DohcMark size={14} />
          <span className="text-[12.5px] text-ink-strong font-semibold tracking-tight">
            {primary ? 'Agent' : 'dohc'}
          </span>
        </div>
        {busy && (
          <span className="flex items-center gap-1.5 text-[10.5px] text-ink-faint">
            <span className="size-1.5 rounded-full bg-ink-dim animate-pulse" />
            thinking…
          </span>
        )}
      </header>

      <div
        ref={scrollRef}
        className={`flex-1 overflow-y-auto flex flex-col gap-4 ${
          primary
            ? 'mx-auto w-full max-w-[780px] px-7 py-7'
            : 'px-4 py-4'
        }`}
      >
        {uiMessages.length === 0 && (
          <div
            className={`flex flex-col items-start gap-2 ${
              primary ? 'pt-[18vh]' : ''
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-ink-dim" />
              <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold">
                dohc
              </span>
            </div>
            <p
              className={`text-ink-strong leading-snug tracking-tight font-semibold ${
                primary ? 'text-[30px]' : 'text-[18px]'
              }`}
            >
              {primary
                ? 'What should we build in dohc?'
                : 'What can I help you with?'}
            </p>
            <p className="text-[12.5px] text-ink-dim leading-relaxed mt-1">
              {primary
                ? 'Tell dohc what should move forward. It will read sources, change files, and leave the work inspectable.'
                : "Ask me to find something, draft a document, or organize your pages. I'll show my sources and what I changed, so you can always check the work."}
            </p>
          </div>
        )}
        {uiMessages.map((m) => (
          <MessageView key={m.key} message={m} />
        ))}
      </div>

      <div className={primary ? 'mx-auto w-full max-w-[780px] px-7 pb-6 pt-1' : 'px-3 pb-3 pt-1'}>
        <div
          className={`relative border border-rule bg-elevated focus-within:border-rule-strong transition-colors shadow-xs ${
            primary ? 'rounded-2xl shadow-md' : 'rounded-xl'
          }`}
        >
          {primary && !threadId && (
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
                  className="fixed inset-0 z-20"
                  onClick={() => {
                    setEnvironmentOpen(false)
                    setCreateProjectOpen(false)
                  }}
                />
                <div className="absolute bottom-[calc(100%+8px)] left-3 z-30 w-[392px] max-w-[calc(100vw-24px)] rounded-xl border border-rule bg-elevated p-2 shadow-modal">
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
                      <div className="absolute left-[calc(100%+8px)] top-2 z-40 w-64 rounded-xl border border-rule bg-elevated p-1.5 shadow-modal">
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
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (slashItems.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSlashCursor((c) => Math.min(slashItems.length - 1, c + 1))
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSlashCursor((c) => Math.max(0, c - 1))
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setInput('')
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  const item = slashItems[slashCursor] ?? slashItems[0]
                  if (item) fireSlashItem(item)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={canSend ? 'Ask dohc to find, draft, or organize something…' : 'Starting up…'}
            disabled={!canSend}
            rows={primary ? 4 : 3}
            className={`w-full resize-none bg-transparent text-ink placeholder:text-ink-faint outline-none disabled:text-ink-faint ${
              primary
                ? 'px-4 pb-10 pt-4 text-[14px] leading-relaxed'
                : 'px-3 pt-3 pb-9 text-[13px] leading-relaxed'
            }`}
          />
          {slashQuery !== null && slashItems.length > 0 && (
            <div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 overflow-hidden rounded-xl border border-rule-strong bg-elevated shadow-modal">
              <div className="border-b border-rule px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Commands & Skills
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {slashItems.map((item, i) => {
                  const active = i === slashCursor
                  const Icon = item.kind === 'command' ? SquareTerminal : Sparkles
                  return (
                    <button
                      key={`${item.kind}.${item.path}`}
                      type="button"
                      onMouseEnter={() => setSlashCursor(i)}
                      onClick={() => fireSlashItem(item)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                        active ? 'bg-hover text-ink-strong' : 'text-ink-dim hover:bg-hover hover:text-ink'
                      }`}
                    >
                      <Icon
                        className={`size-3.5 shrink-0 ${
                          item.kind === 'command' ? 'text-accent' : 'text-violet-500'
                        }`}
                        strokeWidth={2}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                        {item.label}
                      </span>
                      <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">
                        {item.kind} · {item.path}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="absolute bottom-2 left-3 right-2 flex items-center justify-between">
            <span className="text-[10px] text-ink-faint">
              / commands · ⏎ send · ⇧⏎ newline
            </span>
            <button
              onClick={() => submit()}
              disabled={!canSend || sending || busy || !input.trim()}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-strong px-2.5 text-[11.5px] font-medium text-surface hover:bg-ink disabled:bg-ink-ghost disabled:cursor-not-allowed transition-colors"
            >
              <Send className="size-3" strokeWidth={2.2} />
              send
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

function MessageView({ message }: { message: UIMessage }) {
  if (message.role === 'system') return null
  const isUser = message.role === 'user'

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex items-center gap-1.5">
        <span
          className={`size-1.5 rounded-full ${
            isUser ? 'bg-ink-faint' : 'bg-ink-dim'
          }`}
        />
        <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold">
          {isUser ? 'you' : 'dohc'}
        </span>
      </div>
      <div className="max-w-full break-words">
        {(() => {
          const text = message.parts
            .filter((p) => p.type === 'text')
            .map((p) => (p as { text?: string }).text ?? '')
            .join('')
          if (!text.trim()) return null
          // dohc writes markdown — render it as a document, not raw
          // text. The user's own turns stay plain.
          return isUser ? (
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
              {text}
            </div>
          ) : (
            <Markdown>{text}</Markdown>
          )
        })()}
        <div className="mt-1 flex flex-wrap gap-1">
          {message.parts.map((part, i) => {
            if (part.type === 'reasoning' || part.type === 'text') return null
            if (!part.type?.startsWith('tool-')) return null
            const p = part as unknown as {
              type: string
              toolName?: string
              state?: string
              input?: unknown
            }
            const toolName = p.toolName ?? p.type.replace(/^tool-/, '')
            const input = p.input as Record<string, unknown> | undefined
            const summary = summarizeInput(toolName, input)
            return (
              <div
                key={i}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-panel px-2 py-1 font-mono text-[11px] text-ink-dim"
              >
                <span className="size-1 rounded-full bg-success" />
                <span className="text-ink">{toolName}</span>
                {summary && <span className="text-ink-faint">{summary}</span>}
                {p.state && p.state !== 'output-available' && (
                  <em className="text-ink-faint not-italic">({p.state})</em>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function summarizeInput(
  tool: string,
  input?: Record<string, unknown>,
): string | null {
  if (!input) return null
  if (typeof input.path === 'string') return input.path
  if (typeof input.type === 'string' && typeof input.slug === 'string') {
    return `${input.type}/${input.slug}`
  }
  if (Array.isArray(input.items)) return `(${input.items.length} items)`
  if (typeof input.src === 'string') return input.src.slice(0, 60)
  if (typeof input.type === 'string') return String(input.type)
  return null
}
