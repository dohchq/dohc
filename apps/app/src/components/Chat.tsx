import { useState, useRef, useEffect, useMemo } from 'react'
import { useAction, useQuery } from 'convex/react'
import { useUIMessages, type UIMessage } from '@convex-dev/agent/react'
import { Send } from 'lucide-react'
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

export function detectSkillFire(
  prompt: string,
  skills: ReadonlyArray<{ path: string; label: string }>,
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

type Props = {
  threadId: string | null
  pendingPrompt?: string | null
  onPendingHandled?: () => void
  // P3+P4 Codex fold F2+F3: dedicated channel for programmatic
  // skill-fire (from CommandPalette skill rows). Bypasses
  // detectSkillFire (no slash-parsing on this channel) so a
  // plugin command's text cannot accidentally become a skill-
  // fire. The state is parent-owned (index.tsx); Chat consumes
  // ONCE then signals onPendingSkillFireHandled.
  pendingSkillFire?: string | null
  onPendingSkillFireHandled?: () => void
}

export function Chat({
  threadId,
  pendingPrompt,
  onPendingHandled,
  pendingSkillFire,
  onPendingSkillFireHandled,
}: Props) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const sendMessage = useAction(api.agent.sendMessage)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Track-3 P3 — subscribe to the user's saved skills for slash-
  // command resolution. The query is cheap (one workspace-keyed
  // collect; filtered to type:skill or skills/* path).
  // org-plan §5: active workspace threaded through skills + the
  // (org-plan §5 non-defaultable) listMessages thread surface. The
  // agent.sendMessage action remains personal-default for now (an
  // action cannot validate active membership; the thread itself
  // binds to a workspace via threadRefs, which is the long-term fix).
  const activeWorkspaceId = useActiveWorkspaceId()
  const skills = useQuery(api.skills.list, { activeWorkspaceId }) ?? []

  const messagesQuery = useUIMessages(
    api.agent.listMessages,
    threadId ? { threadId, activeWorkspaceId } : 'skip',
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
    if (!prompt || !threadId || sending || busy) return
    // Track-3 P3 — slash-command routing. A leading `/<token>`
    // that resolves to a saved skill flips this turn into
    // skill-fire mode (the prepareStep BRACE restricts step 0's
    // tools to {run_skill} + toolChoice forces the call).
    // Ambiguous label collisions surface as a chat hint without
    // firing; unmatched slash-prefixes pass through as a normal
    // prompt (the model sees the literal "/" prefix and replies).
    const match = detectSkillFire(prompt, skills)
    setSending(true)
    if (!promptOverride) setInput('')
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
          threadId,
          prompt: promptText,
          entry: 'skill-fire',
          activeWorkspaceId,
        })
        return
      }
      await sendMessage({ threadId, prompt, activeWorkspaceId })
    } catch (e) {
      console.error(e)
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    if (!pendingPrompt || !threadId || sending || busy) return
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
    if (!pendingSkillFire || !threadId || sending || busy) return
    const path = pendingSkillFire
    // Claim the dispatch SYNCHRONOUSLY so a re-render or remount
    // sees a cleared pendingSkillFire and does not replay.
    onPendingSkillFireHandled?.()
    setSending(true)
    void (async () => {
      try {
        await sendMessage({
          threadId,
          prompt: path,
          entry: 'skill-fire',
          activeWorkspaceId,
        })
      } catch (e) {
        console.error(e)
      } finally {
        setSending(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSkillFire, threadId])

  return (
    <aside className="flex h-screen flex-col bg-panel border-l border-rule">
      <header className="flex h-11 items-center justify-between px-4 border-b border-rule">
        <div className="flex items-center gap-2 text-ink-dim">
          <DohcMark size={14} />
          <span className="text-[12.5px] text-ink-strong font-semibold tracking-tight">
            dohc
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
        className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4"
      >
        {uiMessages.length === 0 && (
          <div className="flex flex-col items-start gap-2">
            <div className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-ink-dim" />
              <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold">
                dohc
              </span>
            </div>
            <p className="text-[18px] text-ink-strong leading-snug tracking-tight font-semibold">
              What can I help you with?
            </p>
            <p className="text-[12.5px] text-ink-dim leading-relaxed mt-1">
              Ask me to find something, draft a document, or organize
              your pages. I'll show my sources and what I changed, so
              you can always check the work.
            </p>
          </div>
        )}
        {uiMessages.map((m) => (
          <MessageView key={m.key} message={m} />
        ))}
      </div>

      <div className="px-3 pb-3 pt-1">
        <div className="relative rounded-xl border border-rule bg-elevated focus-within:border-rule-strong transition-colors shadow-xs">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={threadId ? 'Ask dohc to find, draft, or organize something…' : 'Starting up…'}
            disabled={!threadId}
            rows={3}
            className="w-full resize-none bg-transparent px-3 pt-3 pb-9 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint outline-none disabled:text-ink-faint"
          />
          <div className="absolute bottom-2 left-3 right-2 flex items-center justify-between">
            <span className="text-[10px] text-ink-faint">
              ⏎ send · ⇧⏎ newline
            </span>
            <button
              onClick={() => submit()}
              disabled={!threadId || sending || busy || !input.trim()}
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
